import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getTrip, deleteTrip } from '$server/trips';
import {
	listItinerary,
	createItem,
	bulkCreate,
	updateItem,
	deleteItem,
	getItem,
	setLocation,
	ITEM_TYPES,
	type ItemType
} from '$server/itinerary';
import {
	listPackingLists,
	getPackingItemsForTrip,
	createList,
	renameList,
	deleteList,
	assertListInTrip,
	createPackingItem,
	createPackingItemAt,
	bulkCreatePacking,
	updatePackingItem,
	deletePackingItem
} from '$server/packing';
import {
	listTemplates,
	applyTemplate,
	saveListAsTemplate,
	seedStarterTemplate,
	deleteTemplate
} from '$server/templates';
import { duplicateTrip } from '$server/clone';
import { runTreeOp, runReparent, type TreeOp } from '$server/tree-sql';
import { flattenTree } from '$server/tree';
import {
	listReservations,
	createReservation,
	updateReservation,
	deleteReservation,
	moveReservation,
	parseReservationForm
} from '$server/reservations';
import { extractFromText, extractFromDocument } from '$server/reservation-extract';
import {
	listExpenses,
	createExpense,
	updateExpense,
	deleteExpense,
	moveExpense,
	bulkCreateExpenses,
	parseExpenseForm,
	parseAmount,
	type ExpenseInput,
	EXPENSE_CATEGORIES
} from '$server/expenses';
import { extractExpensesFromText, extractExpensesFromDocument } from '$server/expense-extract';
import {
	listDayPlans,
	listStopsForTrip,
	getDayPlan,
	createDayPlan,
	updateDayPlan,
	deleteDayPlan,
	addStop,
	removeStop,
	reorderStops,
	updateStopNotes,
	bulkUpdateDriving,
	bulkUpdateAiNotes,
	optimizeStopOrder,
	setDayPlanAnchor,
	type AnchorInput,
	type StopInput
} from '$server/dayplans';
import { generateTripNotes, AiNotesError } from '$server/ai-notes';
import { placesNearbyCached } from '$server/geocode';
import {
	extractItineraryFromText,
	extractItineraryFromImage,
	extractItineraryFromGoogleMapsUrl,
	extractItineraryFromAppleMapsUrl,
	type ExtractedItineraryItem
} from '$server/itinerary-extract';
import { isGoogleMapsUrl } from '$server/google-maps-url';
import { isAppleMapsUrl } from '$server/apple-maps-url';
import { importItineraryCandidates, type ItineraryImportCandidate } from '$server/itinerary-import';
import {
	listAttachmentsForTrip,
	uploadAttachment,
	createTextDocument,
	deleteAttachment,
	renameAttachment
} from '$server/attachments';
import { MAX_ATTACHMENT_BYTES, detectFileType } from '$lib/filevalidate';
import { haversineKm } from '$lib/geo';
import { weatherFor, type WeatherResult } from '$server/weather';

function parseId(param: string | FormDataEntryValue | null): number {
	const id = Number(param);
	if (!Number.isInteger(id) || id <= 0) throw error(400, 'Invalid id');
	return id;
}

function optId(v: FormDataEntryValue | null): number | null {
	if (v === null || v === '') return null;
	const n = Number(v);
	return Number.isInteger(n) && n > 0 ? n : null;
}

function asType(v: FormDataEntryValue | null): ItemType {
	const s = (v ?? 'place').toString();
	return (ITEM_TYPES as readonly string[]).includes(s) ? (s as ItemType) : 'place';
}

function optType(v: FormDataEntryValue | null): ItemType | undefined {
	if (v === null) return undefined;
	const s = v.toString();
	return (ITEM_TYPES as readonly string[]).includes(s) ? (s as ItemType) : undefined;
}

function cleanText(v: FormDataEntryValue | null): string | null {
	return (v ?? '').toString().trim() || null;
}

function optDate(v: FormDataEntryValue | null): string | null {
	const s = (v ?? '').toString().trim();
	return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function parseStopInputs(raw: string | undefined): StopInput[] {
	if (!raw) return [];
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		throw error(400, 'Invalid day plan stops.');
	}
	if (!Array.isArray(data)) throw error(400, 'Invalid day plan stops.');
	return data
		.map((item) => {
			if (!item || typeof item !== 'object') return null;
			const candidate = item as { itinerary_item_id?: unknown; notes?: unknown };
			const id = Number(candidate.itinerary_item_id);
			if (!Number.isInteger(id) || id <= 0) return null;
			const notes =
				typeof candidate.notes === 'string' && candidate.notes.trim()
					? candidate.notes.trim().slice(0, 2000)
					: null;
			return { itinerary_item_id: id, notes };
		})
		.filter((item): item is StopInput => item !== null);
}

function parseIdArray(raw: string | undefined): number[] {
	if (!raw) return [];
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		throw error(400, 'Invalid stop order.');
	}
	if (!Array.isArray(data)) throw error(400, 'Invalid stop order.');
	return data.map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

function parseDrivingLegs(raw: string | undefined) {
	if (!raw) return [];
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		throw error(400, 'Invalid driving legs.');
	}
	if (!Array.isArray(data) || data.length > 100) throw error(400, 'Invalid driving legs.');
	return data.map((item) => {
		if (!item || typeof item !== 'object') throw error(400, 'Invalid driving leg.');
		const leg = item as { stopId?: unknown; km?: unknown; min?: unknown };
		const stopId = Number(leg.stopId);
		const km = Number(leg.km);
		const min = Number(leg.min);
		if (
			!Number.isInteger(stopId) ||
			stopId <= 0 ||
			!Number.isFinite(km) ||
			km < 0 ||
			km > 50000 ||
			!Number.isFinite(min) ||
			min < 0 ||
			min > 100000
		) {
			throw error(400, 'Invalid driving leg.');
		}
		return {
			stopId,
			km: Math.round(km * 10) / 10,
			min: Math.max(0, Math.round(min))
		};
	});
}

function parseOrigin(form: FormData): { lat: number; lon: number } | null {
	const rawLat = form.get('origin_lat')?.toString().trim();
	const rawLon = form.get('origin_lon')?.toString().trim();
	if (!rawLat && !rawLon) return null;
	const lat = Number(rawLat);
	const lon = Number(rawLon);
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw error(400, 'Invalid origin.');
	if (lat < -90 || lat > 90 || lon < -180 || lon > 180) throw error(400, 'Invalid origin.');
	return { lat, lon };
}

function parseAnchor(form: FormData): AnchorInput | null {
	const source = (form.get('anchor_source') ?? '').toString().trim().slice(0, 200);
	const title = (form.get('anchor_title') ?? '').toString().trim().slice(0, 300);
	const rawLat = form.get('anchor_lat')?.toString().trim();
	const rawLon = form.get('anchor_lon')?.toString().trim();
	if (!source && !title && !rawLat && !rawLon) return null;
	if (!source || !title || !rawLat || !rawLon) throw error(400, 'Invalid anchor.');
	const lat = Number(rawLat);
	const lon = Number(rawLon);
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw error(400, 'Invalid anchor.');
	if (lat < -90 || lat > 90 || lon < -180 || lon > 180) throw error(400, 'Invalid anchor.');
	return { source, title, lat, lon };
}

function manualItineraryText(itemType: ItemType, title: string, notes: string | null) {
	if (itemType !== 'note' || notes || title.length <= 180)
		return { title: title.slice(0, 500), notes };

	const colon = title.indexOf(':');
	const newline = title.search(/\r?\n/);
	const sentence = title.search(/[.!?]\s+/);
	const candidates = [colon, newline, sentence].filter((n) => n >= 20 && n <= 140);
	const splitAt = candidates.length > 0 ? Math.min(...candidates) : 120;
	const delimiterLength = splitAt === colon || splitAt === sentence ? 1 : 0;
	const head = title.slice(0, splitAt + delimiterLength).trim();
	const body = title.slice(splitAt + delimiterLength).trim();
	return { title: head.slice(0, 500), notes: body || null };
}

function asOp(v: FormDataEntryValue | null): TreeOp {
	const s = (v ?? '').toString();
	if (s === 'move-up' || s === 'move-down' || s === 'indent' || s === 'outdent') return s;
	throw error(400, 'Invalid move');
}

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.ownerId) throw error(500, 'No owner configured');
	const ownerId = locals.ownerId;
	const tripId = parseId(params.id);

	const trip = await getTrip(ownerId, tripId);
	if (!trip) throw error(404, 'Trip not found');

	const [
		itinerary,
		lists,
		itemsByList,
		templates,
		reservations,
		attachments,
		expenses,
		dayPlans,
		dayPlanStops
	] = await Promise.all([
		listItinerary(tripId),
		listPackingLists(tripId),
		getPackingItemsForTrip(tripId),
		listTemplates(ownerId),
		listReservations(tripId),
		listAttachmentsForTrip(tripId),
		listExpenses(tripId),
		listDayPlans(tripId),
		listStopsForTrip(tripId)
	]);

	const itineraryRows = flattenTree(itinerary);
	const packing = lists.map((list) => {
		const items = itemsByList.get(list.id) ?? [];
		// Progress counts actual items (leaves), not category headers — a parent's
		// checkbox is derived from its descendants client-side (td-b60112), so
		// counting parents too would double-count and disagree with that display.
		const parentOf = new Set(items.filter((i) => i.parent_id != null).map((i) => i.parent_id));
		const leaves = items.filter((i) => !parentOf.has(i.id));
		const checked = leaves.filter((i) => i.checked).length;
		return { list, rows: flattenTree(items), total: leaves.length, checked };
	});

	const weatherByPlan: Record<number, WeatherResult> = {};
	const weatherJobs: Array<{ planId: number; lat: number; lng: number }> = [];
	for (const plan of dayPlans) {
		if (plan.anchor_lat != null && plan.anchor_lon != null) {
			weatherJobs.push({ planId: plan.id, lat: plan.anchor_lat, lng: plan.anchor_lon });
			continue;
		}
		const planStops = dayPlanStops.filter((s) => s.day_plan_id === plan.id);
		const first = planStops.find(
			(s) => typeof s.snapshot_lat === 'number' && typeof s.snapshot_lon === 'number'
		);
		if (first && first.snapshot_lat != null && first.snapshot_lon != null) {
			weatherJobs.push({ planId: plan.id, lat: first.snapshot_lat, lng: first.snapshot_lon });
		}
	}
	if (weatherJobs.length > 0) {
		const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 3000));
		const work = Promise.allSettled(weatherJobs.map((j) => weatherFor(j.lat, j.lng)));
		const race = await Promise.race([work, timeout]);
		if (race !== 'timeout') {
			for (let i = 0; i < race.length; i++) {
				const r = race[i];
				if (r.status === 'fulfilled' && r.value) {
					weatherByPlan[weatherJobs[i].planId] = r.value;
				}
			}
		}
	}

	return {
		trip,
		itineraryRows,
		packing,
		templates,
		reservations,
		attachments,
		expenses,
		dayPlans,
		dayPlanStops,
		weatherByPlan
	};
};

/** Resolve trip and assert ownership for an action; returns {ownerId, tripId}. */
function ctx(locals: App.Locals, params: { id: string }) {
	if (!locals.ownerId) throw error(500, 'No owner configured');
	return { ownerId: locals.ownerId, tripId: parseId(params.id) };
}

async function ownTrip(ownerId: number, tripId: number) {
	const trip = await getTrip(ownerId, tripId);
	if (!trip) throw error(404, 'Trip not found');
	return trip;
}

function normalizeTitle(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

function duplicateHint(
	title: string,
	existing: { title: string }[]
): { duplicate: boolean; duplicate_title: string | null } {
	const n = normalizeTitle(title);
	if (!n) return { duplicate: false, duplicate_title: null };
	for (const item of existing) {
		const e = normalizeTitle(item.title);
		if (!e) continue;
		if (e === n || e.includes(n) || n.includes(e)) {
			return { duplicate: true, duplicate_title: item.title };
		}
	}
	return { duplicate: false, duplicate_title: null };
}

function markDuplicates<T extends ExtractedItineraryItem>(
	items: T[],
	existing: { title: string }[]
): Array<T & { duplicate: boolean; duplicate_title: string | null }> {
	return items.map((item) => ({
		...item,
		...duplicateHint(item.title, existing),
		children: markDuplicates(item.children, existing)
	}));
}

export const actions: Actions = {
	// ── Itinerary ──────────────────────────────────────────
	'itin-add': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const title = (form.get('title') ?? '').toString().trim();
		if (!title) return fail(400, { error: 'Title is required.' });
		const itemType = asType(form.get('item_type'));
		const text = manualItineraryText(
			itemType,
			title,
			(form.get('notes') ?? '').toString().trim() || null
		);
		await createItem(tripId, {
			parent_id: optId(form.get('parent_id')),
			item_type: itemType,
			title: text.title,
			notes: text.notes
		});
		return { ok: true };
	},

	'itin-paste': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const lines = (form.get('text') ?? '').toString().split(/\r?\n/);
		const n = await bulkCreate(
			tripId,
			optId(form.get('parent_id')),
			asType(form.get('item_type')),
			lines
		);
		return { ok: true, added: n };
	},

	'itin-extract': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		const trip = await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const text = (form.get('text') ?? '').toString();
		if (!text.trim()) return fail(400, { error: 'Paste itinerary text first.' });
		const existing = await listItinerary(tripId);
		const tripDates =
			trip.start_date || trip.end_date
				? `${trip.start_date ?? '?'} to ${trip.end_date ?? '?'}`
				: '';
		const candidates = await extractItineraryFromText(text, {
			tripName: trip.name,
			tripDates,
			tripNotes: trip.notes,
			existingTitles: existing.map((i) => i.title)
		});
		if (!candidates) {
			return fail(502, {
				error:
					'Could not extract itinerary candidates. Try simplifying the text or add places manually.'
			});
		}
		return { ok: true, candidates: markDuplicates(candidates, existing) };
	},

	'itin-extract-url': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		const trip = await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const url = (form.get('url') ?? '').toString().trim();
		if (!url) return fail(400, { error: 'Paste a Google Maps or Apple Maps link.' });
		const isGoogle = isGoogleMapsUrl(url);
		const isApple = isAppleMapsUrl(url);
		if (!isGoogle && !isApple) {
			return fail(400, { error: 'Not a recognized Google Maps or Apple Maps URL.' });
		}
		const existing = await listItinerary(tripId);
		const tripDates =
			trip.start_date || trip.end_date
				? `${trip.start_date ?? '?'} to ${trip.end_date ?? '?'}`
				: '';
		const extractContext = {
			tripName: trip.name,
			tripDates,
			tripNotes: trip.notes,
			existingTitles: existing.map((i) => i.title)
		};
		const candidates = isApple
			? await extractItineraryFromAppleMapsUrl(url, extractContext)
			: await extractItineraryFromGoogleMapsUrl(url, extractContext);
		if (!candidates) {
			return fail(502, {
				error: 'Could not extract place from that link. Try pasting the full Maps URL.'
			});
		}
		return { ok: true, candidates: markDuplicates(candidates, existing) };
	},

	'itin-extract-image': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		const trip = await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const file = form.get('image');
		if (!(file instanceof File) || file.size === 0) {
			return fail(400, { error: 'Upload a photo.' });
		}
		if (file.size > 20 * 1024 * 1024) {
			return fail(400, { error: 'Image must be under 20 MB.' });
		}
		const bytes = new Uint8Array(await file.arrayBuffer());
		const detected = detectFileType(bytes);
		if (!detected || detected.kind === 'pdf') {
			return fail(400, { error: 'Unsupported image format. Use JPEG, PNG, WebP, or HEIC.' });
		}
		const base64 = Buffer.from(bytes).toString('base64');
		const existing = await listItinerary(tripId);
		const tripDates =
			trip.start_date || trip.end_date
				? `${trip.start_date ?? '?'} to ${trip.end_date ?? '?'}`
				: '';
		const candidates = await extractItineraryFromImage(base64, detected.mime, {
			tripName: trip.name,
			tripDates,
			tripNotes: trip.notes,
			existingTitles: existing.map((i) => i.title)
		});
		if (!candidates) {
			return fail(502, {
				error:
					'Could not identify a place from this photo. Try a clearer image or add the place manually.'
			});
		}
		return { ok: true, candidates: markDuplicates(candidates, existing) };
	},

	'itin-import-candidates': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		const trip = await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const raw = form.get('candidates')?.toString();
		if (!raw) return fail(400, { error: 'No itinerary candidates provided.' });
		let candidates: ItineraryImportCandidate[];
		try {
			candidates = JSON.parse(raw);
		} catch {
			return fail(400, { error: 'Invalid itinerary candidate data.' });
		}
		if (!Array.isArray(candidates) || candidates.length === 0) {
			return fail(400, { error: 'No itinerary candidates selected.' });
		}
		const imported = await importItineraryCandidates(tripId, candidates, {
			parentId: optId(form.get('parent_id')),
			geocode: form.get('geocode') !== 'false',
			tripName: trip.name
		});
		return { ok: true, imported };
	},

	'itin-edit': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const id = parseId(form.get('id'));
		const title = (form.get('title') ?? '').toString().trim();
		if (!title) return fail(400, { error: 'Title is required.' });
		const itemType = optType(form.get('item_type'));
		const text = manualItineraryText(
			itemType ?? 'place',
			title,
			(form.get('notes') ?? '').toString().trim() || null
		);
		await updateItem(tripId, id, {
			title: text.title,
			notes: text.notes,
			external_url: (form.get('external_url') ?? '').toString().trim() || null,
			date: (form.get('date') ?? '').toString().trim() || null,
			item_type: itemType
		});
		return { ok: true };
	},

	'itin-delete': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		await deleteItem(tripId, parseId(form.get('id')));
		return { ok: true };
	},

	'itin-move': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		await runTreeOp('itinerary_items', tripId, parseId(form.get('id')), asOp(form.get('op')));
		return { ok: true };
	},

	'itin-reparent': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const id = parseId(form.get('id'));
		const parentId = optId(form.get('parent_id'));
		const item = await getItem(tripId, id);
		if (!item) throw error(404, 'Item not found');
		if (item.parent_id === parentId) return { ok: true, moved: false };
		const ok = await runReparent('itinerary_items', tripId, id, parentId, Number.MAX_SAFE_INTEGER);
		return { ok, moved: ok };
	},

	// ── Day plans ─────────────────────────────────────────
	'dayplan-create': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const title = (form.get('title') ?? '').toString().trim();
		if (!title) return fail(400, { error: 'Title is required.' });
		const stops = parseStopInputs(form.get('stops')?.toString());
		const planId = await createDayPlan(tripId, {
			title: title.slice(0, 300),
			notes: cleanText(form.get('notes')),
			optional_date: optDate(form.get('optional_date')),
			anchor: parseAnchor(form),
			stops
		});
		return { ok: true, planId };
	},

	'dayplan-set-anchor': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const ok = await setDayPlanAnchor(tripId, parseId(form.get('plan_id')), parseAnchor(form));
		if (!ok) return fail(400, { error: 'Day plan not found.' });
		return { ok: true };
	},

	'dayplan-edit': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const title = (form.get('title') ?? '').toString().trim();
		if (!title) return fail(400, { error: 'Title is required.' });
		const ok = await updateDayPlan(tripId, parseId(form.get('id')), {
			title: title.slice(0, 300),
			notes: cleanText(form.get('notes')),
			optional_date: optDate(form.get('optional_date'))
		});
		if (!ok) throw error(404, 'Day plan not found');
		return { ok: true };
	},

	'dayplan-delete': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		await deleteDayPlan(tripId, parseId(form.get('id')));
		return { ok: true };
	},

	'dayplan-add-stop': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const stopId = await addStop(tripId, parseId(form.get('plan_id')), {
			itinerary_item_id: parseId(form.get('itinerary_item_id')),
			notes: cleanText(form.get('notes'))
		});
		if (stopId === null) throw error(404, 'Day plan or place not found');
		return { ok: true, stopId };
	},

	'dayplan-remove-stop': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		await removeStop(tripId, parseId(form.get('id')));
		return { ok: true };
	},

	'dayplan-reorder': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const ok = await reorderStops(
			tripId,
			parseId(form.get('plan_id')),
			parseIdArray(form.get('ordered_stop_ids')?.toString())
		);
		if (!ok) return fail(400, { error: 'Invalid stop order.' });
		return { ok: true };
	},

	'dayplan-set-driving': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const ok = await bulkUpdateDriving(
			tripId,
			parseId(form.get('plan_id')),
			parseDrivingLegs(form.get('legs')?.toString())
		);
		if (!ok) return fail(400, { error: 'Invalid driving legs.' });
		return { ok: true };
	},

	'dayplan-set-order': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const orderedStopIds = parseIdArray(form.get('ordered_stop_ids')?.toString());
		const ok = await reorderStops(tripId, parseId(form.get('plan_id')), orderedStopIds);
		if (!ok) return fail(400, { error: 'Invalid stop order.' });
		return { ok: true, orderedStopIds };
	},

	'dayplan-optimize-fallback': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const orderedStopIds = await optimizeStopOrder(
			tripId,
			parseId(form.get('plan_id')),
			parseOrigin(form)
		);
		if (!orderedStopIds) return fail(400, { error: 'Could not optimize stop order.' });
		return { ok: true, orderedStopIds };
	},

	'dayplan-stop-notes': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const ok = await updateStopNotes(tripId, parseId(form.get('id')), cleanText(form.get('notes')));
		if (!ok) throw error(404, 'Stop not found');
		return { ok: true };
	},

	'dayplan-ai-notes': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		const trip = await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const planId = parseId(form.get('plan_id'));
		const allStops = await listStopsForTrip(tripId);
		const stops = allStops
			.filter((s) => s.day_plan_id === planId)
			.map((s) => ({ id: s.id, name: s.snapshot_title, notes: s.notes }));
		if (stops.length === 0) return fail(400, { error: 'No stops in this plan.' });
		const plans = await listDayPlans(tripId);
		const plan = plans.find((p) => p.id === planId);
		if (!plan) throw error(404, 'Day plan not found');
		const first = allStops.find(
			(s) =>
				s.day_plan_id === planId &&
				typeof s.snapshot_lat === 'number' &&
				typeof s.snapshot_lon === 'number'
		);
		let weather: import('$server/weather').WeatherResult | null = null;
		if (first?.snapshot_lat != null && first?.snapshot_lon != null) {
			try {
				weather = await weatherFor(first.snapshot_lat, first.snapshot_lon);
			} catch {
				/* weather is optional context */
			}
		}
		try {
			const notes = await generateTripNotes({
				tripName: trip.name,
				stops,
				weather,
				date: plan.optional_date
			});
			await bulkUpdateAiNotes(tripId, planId, notes);
			return { ok: true, notes };
		} catch (err) {
			if (err instanceof AiNotesError) return fail(502, { error: err.message });
			throw err;
		}
	},

	'dayplan-suggest': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const planId = parseId(form.get('plan_id'));
		const plan = await getDayPlan(tripId, planId);
		if (!plan) return fail(404, { error: 'Day plan not found.' });
		const allStops = await listStopsForTrip(tripId);
		const planStops = allStops.filter((s) => s.day_plan_id === planId);
		const planStopItemIds = new Set(planStops.map((s) => s.itinerary_item_id).filter(Boolean));
		const locatedStops = planStops.filter(
			(s) => typeof s.snapshot_lat === 'number' && typeof s.snapshot_lon === 'number'
		);
		const routePoints = [
			...(plan.anchor_lat != null && plan.anchor_lon != null
				? [{ lat: plan.anchor_lat, lon: plan.anchor_lon }]
				: []),
			...locatedStops.map((s) => ({ lat: s.snapshot_lat!, lon: s.snapshot_lon! }))
		];
		if (locatedStops.length === 0 || routePoints.length < 2) {
			return fail(400, { error: 'Need at least two route points with coordinates.' });
		}
		const centroidLat =
			routePoints.reduce((sum, point) => sum + point.lat, 0) / routePoints.length;
		const centroidLon =
			routePoints.reduce((sum, point) => sum + point.lon, 0) / routePoints.length;

		const itinerary = await listItinerary(tripId);
		const internal = itinerary
			.filter((item) => {
				if (item.item_type !== 'place') return false;
				if (planStopItemIds.has(item.id)) return false;
				if (typeof item.lat !== 'number' || typeof item.lon !== 'number') return false;
				const km = haversineKm(centroidLat, centroidLon, item.lat!, item.lon!);
				return km <= 30;
			})
			.map((item) => ({
				source: 'internal' as const,
				name: item.title,
				lat: item.lat!,
				lng: item.lon!,
				distance_km:
					Math.round(haversineKm(centroidLat, centroidLon, item.lat!, item.lon!) * 10) / 10,
				itinerary_item_id: item.id,
				vicinity: item.notes ?? null
			}));

		let external: Array<{
			source: 'external';
			name: string;
			lat: number;
			lng: number;
			distance_km: number;
			place_id: string | null;
			vicinity: string | null;
		}> = [];
		const nearbyResult = await placesNearbyCached(centroidLat, centroidLon);
		if (nearbyResult.status === 'ok') {
			const internalNames = new Set(internal.map((i) => i.name.toLowerCase()));
			const itinNames = new Set(itinerary.map((i) => i.title.toLowerCase()));
			external = nearbyResult.places
				.filter(
					(p) =>
						p.place_id &&
						!internalNames.has(p.name.toLowerCase()) &&
						!itinNames.has(p.name.toLowerCase())
				)
				.map((p) => ({
					source: 'external' as const,
					name: p.name,
					lat: p.lat,
					lng: p.lng,
					distance_km: Math.round(haversineKm(centroidLat, centroidLon, p.lat, p.lng) * 10) / 10,
					place_id: p.place_id,
					vicinity: p.vicinity
				}));
		}

		return { ok: true, internal, external };
	},

	'dayplan-add-suggestion': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const planId = parseId(form.get('plan_id'));
		const name = (form.get('name') ?? '').toString().trim();
		if (!name) return fail(400, { error: 'Name is required.' });
		const lat = Number(form.get('lat'));
		const lng = Number(form.get('lng'));
		const placeId = (form.get('place_id') ?? '').toString().trim() || null;
		const hasCoords =
			Number.isFinite(lat) &&
			Number.isFinite(lng) &&
			lat >= -90 &&
			lat <= 90 &&
			lng >= -180 &&
			lng <= 180;
		const existingId = optId(form.get('itinerary_item_id'));
		if (!existingId && !hasCoords) {
			return fail(400, { error: 'External suggestions require valid coordinates.' });
		}
		if (!existingId && !placeId) {
			return fail(400, { error: 'External suggestions require a Google place ID.' });
		}
		const plans = await listDayPlans(tripId);
		if (!plans.some((p) => p.id === planId)) {
			return fail(400, { error: 'Day plan not found.' });
		}

		let itemId: number;
		if (existingId) {
			itemId = existingId;
		} else {
			itemId = await createItem(tripId, {
				parent_id: null,
				item_type: 'place',
				title: name.slice(0, 500),
				notes: (form.get('vicinity') ?? '').toString().trim() || null
			});
			if (hasCoords) {
				await setLocation(tripId, itemId, lat, lng, placeId);
			}
		}

		const stopId = await addStop(tripId, planId, {
			itinerary_item_id: itemId,
			notes: null
		});
		if (stopId === null) return fail(400, { error: 'Could not add stop.' });
		return { ok: true, itemId, stopId };
	},

	// ── Packing lists ──────────────────────────────────────
	'list-add': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		await createList(tripId, (form.get('name') ?? '').toString().trim());
		return { ok: true };
	},

	'list-rename': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const name = (form.get('name') ?? '').toString().trim();
		if (!name) return fail(400, { error: 'List name is required.' });
		await renameList(tripId, parseId(form.get('list_id')), name);
		return { ok: true };
	},

	'list-delete': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		await deleteList(tripId, parseId(form.get('list_id')));
		return { ok: true };
	},

	// ── Packing items ──────────────────────────────────────
	'pack-add': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const listId = parseId(form.get('list_id'));
		await assertListInTrip(tripId, listId);
		const name = (form.get('name') ?? '').toString().trim();
		if (!name) return fail(400, { error: 'Item name is required.' });
		const qty = Number(form.get('quantity'));
		await createPackingItem(listId, {
			parent_id: optId(form.get('parent_id')),
			name: name.slice(0, 300),
			quantity: Number.isInteger(qty) && qty > 0 ? qty : 1
		});
		return { ok: true };
	},

	'pack-add-at': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const listId = parseId(form.get('list_id'));
		await assertListInTrip(tripId, listId);
		const name = (form.get('name') ?? '').toString().trim();
		if (!name) return fail(400, { error: 'Item name is required.' });
		const pos = form.get('position') === 'above' ? 'above' : 'below';
		const qty = Number(form.get('quantity'));
		await createPackingItemAt(listId, parseId(form.get('ref_id')), pos, {
			name: name.slice(0, 300),
			quantity: Number.isInteger(qty) && qty > 0 ? qty : 1
		});
		return { ok: true };
	},

	'pack-paste': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const listId = parseId(form.get('list_id'));
		await assertListInTrip(tripId, listId);
		const lines = (form.get('text') ?? '').toString().split(/\r?\n/);
		const n = await bulkCreatePacking(listId, optId(form.get('parent_id')), lines);
		return { ok: true, added: n };
	},

	'pack-edit': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const listId = parseId(form.get('list_id'));
		await assertListInTrip(tripId, listId);
		const name = (form.get('name') ?? '').toString().trim();
		if (!name) return fail(400, { error: 'Item name is required.' });
		const qty = Number(form.get('quantity'));
		await updatePackingItem(listId, parseId(form.get('id')), {
			name: name.slice(0, 300),
			quantity: Number.isInteger(qty) && qty > 0 ? qty : 1,
			category: (form.get('category') ?? '').toString().trim() || null,
			notes: (form.get('notes') ?? '').toString().trim() || null
		});
		return { ok: true };
	},

	'pack-delete': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const listId = parseId(form.get('list_id'));
		await assertListInTrip(tripId, listId);
		await deletePackingItem(listId, parseId(form.get('id')));
		return { ok: true };
	},

	'pack-move': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const listId = parseId(form.get('list_id'));
		await assertListInTrip(tripId, listId);
		await runTreeOp('packing_items', listId, parseId(form.get('id')), asOp(form.get('op')));
		return { ok: true };
	},

	// Drag-and-drop reorder/reparent within a packing list (td-4f7d9b). Rejects
	// cross-list, cycles, and unknown parents in runReparent/computeReparent.
	'pack-reparent': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const listId = parseId(form.get('list_id'));
		await assertListInTrip(tripId, listId);
		const rawParent = form.get('parent_id');
		const parentId = rawParent === null || rawParent === '' ? null : parseId(rawParent);
		const index = Number(form.get('index'));
		const ok = await runReparent(
			'packing_items',
			listId,
			parseId(form.get('id')),
			parentId,
			Number.isInteger(index) && index >= 0 ? index : 0
		);
		return { ok };
	},

	// ── Templates ──────────────────────────────────────────
	'tmpl-seed': async ({ params, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		await seedStarterTemplate(ownerId);
		return { ok: true };
	},

	'tmpl-apply': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		await applyTemplate(ownerId, parseId(form.get('template_id')), tripId);
		return { ok: true };
	},

	'tmpl-save': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const name = (form.get('name') ?? '').toString().trim();
		if (!name) return fail(400, { error: 'Template name is required.' });
		await saveListAsTemplate(ownerId, parseId(form.get('list_id')), name);
		return { ok: true };
	},

	'tmpl-delete': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		await deleteTemplate(ownerId, parseId(form.get('template_id')));
		return { ok: true };
	},

	// ── Reservations ───────────────────────────────────────
	// Pre-fill the form from a pasted email or an uploaded document (td-3a0e29).
	// Returns candidate fields only — never creates the reservation.
	'res-extract': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const fields =
			form.get('source') === 'document'
				? await extractFromDocument(ownerId, parseId(form.get('attachment_id')))
				: await (async () => {
						const text = (form.get('text') ?? '').toString();
						if (!text.trim()) return null;
						return extractFromText(text);
					})();
		if (!fields) {
			return fail(502, {
				error: 'Could not extract details. Check the source or fill the form in manually.'
			});
		}
		return { ok: true, fields };
	},

	'res-add': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const { input, error: e } = parseReservationForm(form);
		if (!input) return fail(400, { error: e });
		await createReservation(tripId, input);
		return { ok: true };
	},

	'res-edit': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const { input, error: e } = parseReservationForm(form);
		if (!input) return fail(400, { error: e });
		await updateReservation(tripId, parseId(form.get('id')), input);
		return { ok: true };
	},

	'res-delete': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		await deleteReservation(tripId, parseId(form.get('id')));
		return { ok: true };
	},

	'res-move': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const dir = form.get('direction')?.toString();
		if (dir !== 'up' && dir !== 'down') return fail(400, { error: 'Invalid direction' });
		await moveReservation(tripId, parseId(form.get('id')), dir);
		return { ok: true };
	},

	// ── Expenses ──────────────────────────────────────────
	'exp-add': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const { input, error: e } = parseExpenseForm(form);
		if (!input) return fail(400, { error: e });
		await createExpense(tripId, input);
		return { ok: true };
	},

	'exp-edit': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const { input, error: e } = parseExpenseForm(form);
		if (!input) return fail(400, { error: e });
		await updateExpense(tripId, parseId(form.get('id')), input);
		return { ok: true };
	},

	'exp-delete': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		await deleteExpense(tripId, parseId(form.get('id')));
		return { ok: true };
	},

	'exp-move': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const dir = form.get('direction')?.toString();
		if (dir !== 'up' && dir !== 'down') return fail(400, { error: 'Invalid direction' });
		await moveExpense(tripId, parseId(form.get('id')), dir);
		return { ok: true };
	},

	'exp-extract': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const candidates =
			form.get('source') === 'document'
				? await extractExpensesFromDocument(ownerId, parseId(form.get('attachment_id')))
				: await extractExpensesFromText((form.get('text') ?? '').toString());
		if (!candidates)
			return fail(502, { error: 'Could not extract expenses. Try again or add manually.' });
		return { ok: true, candidates };
	},

	'exp-bulk-add': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const raw = form.get('expenses')?.toString();
		if (!raw) return fail(400, { error: 'No expenses provided.' });
		let items: Array<{
			expense_date?: string | null;
			description?: string;
			amount_cents?: number;
			category?: string;
			attachment_id?: number | null;
			notes?: string | null;
		}>;
		try {
			items = JSON.parse(raw);
		} catch {
			return fail(400, { error: 'Invalid data.' });
		}
		if (!Array.isArray(items) || items.length === 0) return fail(400, { error: 'No expenses.' });
		const inputs: ExpenseInput[] = items
			.filter((i) => i.description && typeof i.amount_cents === 'number')
			.map((i) => ({
				expense_date: i.expense_date?.toString().trim() || null,
				description: (i.description ?? '').toString().slice(0, 500),
				amount_cents: Math.max(0, Math.round(i.amount_cents ?? 0)),
				category: (EXPENSE_CATEGORIES as readonly string[]).includes(i.category ?? '')
					? (i.category as ExpenseInput['category'])
					: 'other',
				attachment_id: i.attachment_id ?? null,
				notes: i.notes?.toString().trim() || null
			}));
		if (inputs.length === 0) return fail(400, { error: 'No valid expenses.' });
		await bulkCreateExpenses(tripId, inputs);
		return { ok: true, added: inputs.length };
	},

	// ── Attachments ────────────────────────────────────────
	'attach-upload': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const file = form.get('file');
		if (!(file instanceof File) || file.size === 0) {
			return fail(400, { error: 'Choose a file to upload.' });
		}
		if (file.size > MAX_ATTACHMENT_BYTES) {
			return fail(400, { error: 'File exceeds the 30 MB limit.' });
		}
		const bytes = new Uint8Array(await file.arrayBuffer());
		const displayName = (form.get('display_name') ?? '').toString().trim() || null;
		const result = await uploadAttachment(tripId, file.name, bytes, {
			reservation_id: optId(form.get('reservation_id')),
			display_name: displayName
		});
		if (!result.ok) return fail(result.status, { error: result.error });
		return { ok: true };
	},

	'doc-text-add': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const text = (form.get('text') ?? '').toString();
		const title = (form.get('title') ?? '').toString();
		const result = await createTextDocument(tripId, title, text, {
			reservation_id: optId(form.get('reservation_id'))
		});
		if (!result.ok) return fail(result.status, { error: result.error });
		return { ok: true };
	},

	'attach-rename': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const name = (form.get('display_name') ?? '').toString().trim();
		await renameAttachment(tripId, parseId(form.get('id')), name);
		return { ok: true };
	},

	'attach-delete': async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await ownTrip(ownerId, tripId);
		const form = await request.formData();
		const ok = await deleteAttachment(tripId, parseId(form.get('id')));
		if (!ok)
			return fail(502, { error: 'Could not delete the file from storage; marked for retry.' });
		return { ok: true };
	},

	// ── Trip-level ─────────────────────────────────────────
	duplicate: async ({ params, request, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		const form = await request.formData();
		const timeZone = (form.get('client_time_zone') ?? '').toString();
		const newId = await duplicateTrip(ownerId, tripId, timeZone);
		if (!newId) throw error(404, 'Trip not found');
		throw redirect(303, `/trips/${newId}`);
	},

	delete: async ({ params, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await deleteTrip(ownerId, tripId);
		throw redirect(303, '/');
	}
};
