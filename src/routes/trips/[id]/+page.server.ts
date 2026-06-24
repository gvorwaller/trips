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
import {
	extractExpensesFromText,
	extractExpensesFromDocument
} from '$server/expense-extract';
import {
	extractItineraryFromText,
	type ExtractedItineraryItem
} from '$server/itinerary-extract';
import {
	importItineraryCandidates,
	type ItineraryImportCandidate
} from '$server/itinerary-import';
import {
	listAttachmentsForTrip,
	uploadAttachment,
	createTextDocument,
	deleteAttachment,
	renameAttachment
} from '$server/attachments';
import { MAX_ATTACHMENT_BYTES } from '$lib/filevalidate';

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

function manualItineraryText(itemType: ItemType, title: string, notes: string | null) {
	if (itemType !== 'note' || notes || title.length <= 180) return { title: title.slice(0, 500), notes };

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

	const [itinerary, lists, itemsByList, templates, reservations, attachments, expenses] =
		await Promise.all([
			listItinerary(tripId),
			listPackingLists(tripId),
			getPackingItemsForTrip(tripId),
			listTemplates(ownerId),
			listReservations(tripId),
			listAttachmentsForTrip(tripId),
			listExpenses(tripId)
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
	return { trip, itineraryRows, packing, templates, reservations, attachments, expenses };
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
			trip.start_date || trip.end_date ? `${trip.start_date ?? '?'} to ${trip.end_date ?? '?'}` : '';
		const candidates = await extractItineraryFromText(text, {
			tripName: trip.name,
			tripDates,
			tripNotes: trip.notes,
			existingTitles: existing.map((i) => i.title)
		});
		if (!candidates) {
			return fail(502, {
				error: 'Could not extract itinerary candidates. Try simplifying the text or add places manually.'
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
		const ok = await runReparent(
			'itinerary_items',
			tripId,
			id,
			parentId,
			Number.MAX_SAFE_INTEGER
		);
		return { ok, moved: ok };
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
		if (!candidates) return fail(502, { error: 'Could not extract expenses. Try again or add manually.' });
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
	duplicate: async ({ params, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		const newId = await duplicateTrip(ownerId, tripId);
		if (!newId) throw error(404, 'Trip not found');
		throw redirect(303, `/trips/${newId}`);
	},

	delete: async ({ params, locals }) => {
		const { ownerId, tripId } = ctx(locals, params);
		await deleteTrip(ownerId, tripId);
		throw redirect(303, '/');
	}
};
