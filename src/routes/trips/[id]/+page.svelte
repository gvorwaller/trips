<script lang="ts">
	import { deserialize, enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { browser } from '$app/environment';
	import { env } from '$env/dynamic/public';
	import { flushSync, onMount, tick } from 'svelte';
	import AttachmentDownloadButton from '$components/AttachmentDownloadButton.svelte';
	import PinMap from '$components/PinMap.svelte';
	import SearchableSelect from '$components/SearchableSelect.svelte';
	import {
		googleMapsLink,
		appleMapsLink,
		googleDirectionsLink,
		googleDayDirectionsLink,
		googleLegByLegLinks,
		dayPlanDirectionsLink,
		type MapPlace
	} from '$lib/maplinks';
	import { haversineKm, formatDistance, formatDuration, type DistanceUnit } from '$lib/geo';
	import { MAX_IMPORT_ITEMS } from '$lib/import-limits';
	import {
		computeLegDistances,
		optimizeDrivingRoute,
		straightLineOptimize,
		type DrivingLeg,
		type RouteStop
	} from '$lib/route';
	import { dayPlanRouteLink } from '$lib/dayplan-export';
	import { canShareText, shareText } from '$lib/share';
	import {
		collapsedKeys,
		isCollapsed,
		parseCollapseState,
		serializeCollapseState,
		toggleCollapse,
		type CollapseMap
	} from '$lib/collapse-state';
	import {
		routeSummary as drivingRouteSummary,
		legSummary as drivingLegSummary,
		returnLegSummary as drivingReturnSummary
	} from '$lib/dayplan-driving';
	import {
		anchorOptions as buildAnchorOptions,
		anchorFromValue as resolveAnchor,
		cleanAnchorTitle,
		type AnchorOption,
		type PlanAnchor
	} from '$lib/dayplan-anchor';
	import type { PageData } from './$types';

	type ActionData = {
		ok?: boolean;
		orderedStopIds?: number[];
		error?: string;
		plan_id?: number;
	};

	let { data, form }: { data: PageData; form?: ActionData } = $props();
	const isViewer = $derived(data.user?.role === 'viewer');
	const MAPS_API_KEY = env.PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
	let selectedPin = $state<number | null>(null);
	let localTimeZone = $state('');

	// Inline "insert item above/below this row" (td-4aa8c4). Clicking a row's ＋
	// opens a one-off input positioned exactly where the new item will land, so a
	// mid-list item arrives in place without repeated move-up/down clicks.
	let packInsert = $state<{ refId: number; position: 'above' | 'below' } | null>(null);
	const openInsert = (refId: number, position: 'above' | 'below') =>
		(packInsert = { refId, position });
	const isInserting = (refId: number, position: 'above' | 'below') =>
		packInsert?.refId === refId && packInsert?.position === position;
	// Focus the field as soon as the inline insert form appears.
	function autofocus(node: HTMLInputElement) {
		node.focus();
	}

	// Drag-to-reorder packing items (td-4f7d9b). Desktop polish on top of the
	// insert/move buttons (which remain the primary, touch-friendly path). Dropping
	// a row before/after a target makes it a sibling of that target at that spot;
	// re-nesting deeper still uses the indent/outdent buttons. Server rejects
	// cross-list / cycles. dragListId scopes a drag to its own list.
	let dragId = $state<number | null>(null);
	let dragListId = $state<number | null>(null);
	let dropTarget = $state<{ id: number; pos: 'before' | 'after' } | null>(null);

	function onRowDragOver(e: DragEvent, listId: number, targetId: number) {
		if (dragId === null || dragListId !== listId || dragId === targetId) return;
		e.preventDefault(); // allow drop
		const el = e.currentTarget as HTMLElement;
		const r = el.getBoundingClientRect();
		dropTarget = { id: targetId, pos: e.clientY - r.top < r.height / 2 ? 'before' : 'after' };
	}

	async function onRowDrop(listId: number, rows: TreeRow[]) {
		const drop = dropTarget;
		const dragged = dragId;
		dropTarget = null;
		dragId = null;
		dragListId = null;
		if (drop === null || dragged === null || drop.id === dragged) return;
		const target = rows.find((r) => r.node.id === drop.id);
		if (!target) return;
		const parentId = target.node.parent_id;
		// Sibling order under parentId, excluding the dragged node (matches computeReparent).
		const sibs = rows
			.filter((r) => r.node.parent_id === parentId && r.node.id !== dragged)
			.map((r) => r.node.id);
		let index = sibs.indexOf(drop.id);
		if (drop.pos === 'after') index += 1;
		const fd = new FormData();
		fd.set('list_id', String(listId));
		fd.set('id', String(dragged));
		fd.set('parent_id', parentId === null ? '' : String(parentId));
		fd.set('index', String(index));
		const res = await fetch('?/pack-reparent', { method: 'POST', body: fd });
		if (res.ok) invalidateAll();
	}

	// Add-reservation draft, bound to the form so LLM extraction (td-3a0e29) can
	// pre-fill it for review. Extraction never saves — the human edits then Adds.
	type ResDraft = {
		reservation_type: string;
		title: string;
		confirmation_code: string;
		status: string;
		start_at: string;
		end_at: string;
		notes: string;
	};
	const emptyResDraft = (): ResDraft => ({
		reservation_type: 'other',
		title: '',
		confirmation_code: '',
		status: '',
		start_at: '',
		end_at: '',
		notes: ''
	});
	let resDraft = $state<ResDraft>(emptyResDraft());
	let extractText = $state('');
	let extractDocId = $state('');
	let extracting = $state(false);
	let extractMsg = $state('');
	// Documents usable as an extraction source (text docs + readable file types).
	const extractableDocs = $derived(
		data.attachments.filter(
			(a) =>
				a.kind === 'text' ||
				/^(application\/pdf|image\/(jpeg|png|webp|gif|heic|heif))$/.test(a.mime_type)
		)
	);
	function applyExtract(f: Record<string, unknown>) {
		const s = (v: unknown): string => (typeof v === 'string' ? v : '');
		resDraft = {
			reservation_type: s(f.reservation_type) || 'other',
			title: s(f.title),
			confirmation_code: s(f.confirmation_code),
			status: s(f.status),
			start_at: s(f.start_at),
			end_at: s(f.end_at),
			notes: s(f.notes)
		};
	}

	// ── Expense state ──
	const expenseTotal = $derived(
		data.expenses.reduce((sum: number, e: { amount_cents: number }) => sum + e.amount_cents, 0)
	);
	function fmtAmount(cents: number): string {
		return '$' + (cents / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
	}
	type ExpDraft = {
		expense_date: string;
		description: string;
		amount: string;
		category: string;
		attachment_id: string;
		notes: string;
	};
	const emptyExpDraft = (): ExpDraft => ({
		expense_date: '',
		description: '',
		amount: '',
		category: 'other',
		attachment_id: '',
		notes: ''
	});
	let expDraft = $state<ExpDraft>(emptyExpDraft());
	let expExtractText = $state('');
	let expExtractDocId = $state('');
	let expExtracting = $state(false);
	let expExtractMsg = $state('');
	let expSaveTextAsDoc = $state(false);
	interface ExpCandidate {
		expense_date: string | null;
		description: string;
		amount: number;
		category: string | null;
		notes: string | null;
		selected: boolean;
	}
	let expCandidates = $state<ExpCandidate[]>([]);

	async function addSelectedExpenses() {
		const selected = expCandidates
			.filter((c) => c.selected)
			.map((c) => ({
				expense_date: c.expense_date,
				description: c.description,
				amount_cents: Math.round(c.amount * 100),
				category: c.category ?? 'other',
				attachment_id: null as number | null,
				notes: c.notes
			}));
		if (selected.length === 0) return;
		// Optionally save the pasted text as a text document first
		if (expSaveTextAsDoc && expExtractText.trim()) {
			const docFd = new FormData();
			docFd.set('title', 'Expense statement');
			docFd.set('text', expExtractText);
			await fetch('?/doc-text-add', { method: 'POST', body: docFd });
		}
		const fd = new FormData();
		fd.set('expenses', JSON.stringify(selected));
		await fetch('?/exp-bulk-add', { method: 'POST', body: fd });
		expCandidates = [];
		expExtractMsg = '';
		expExtractText = '';
		expExtractDocId = '';
		expSaveTextAsDoc = false;
		invalidateAll();
	}

	// ── Itinerary import state ──
	interface ItinCandidateRaw {
		item_type: string;
		title: string;
		date: string | null;
		notes: string | null;
		external_url: string | null;
		address: string | null;
		location_query: string | null;
		lat: number | null;
		lon: number | null;
		place_id: string | null;
		apple_maps_place_id: string | null;
		meta?: Record<string, unknown> | null;
		children: ItinCandidateRaw[];
		duplicate?: boolean;
		duplicate_title?: string | null;
	}
	interface ItinCandidate extends Omit<
		ItinCandidateRaw,
		'date' | 'notes' | 'external_url' | 'address' | 'location_query' | 'children'
	> {
		date: string;
		notes: string;
		external_url: string;
		address: string;
		location_query: string;
		children: ItinCandidate[];
		selected: boolean;
	}
	let itinExtractText = $state('');
	let itinExtracting = $state(false);
	let itinImporting = $state(false);
	let itinExtractMsg = $state('');
	let itinCandidates = $state<ItinCandidate[]>([]);
	let itinImportParentId = $state('');
	let itinGeocode = $state(true);
	let itinUrlText = $state('');
	let itinUrlExtracting = $state(false);
	let itinUrlMsg = $state('');
	let itinImageFile = $state<File | null>(null);
	let itinImagePasted = $state(false);
	let itinImageExtracting = $state(false);
	let itinImageMsg = $state('');
	let itinBirdsFetching = $state(false);
	let itinBirdsMsg = $state('');
	let itinBirdsUsername = $state('');
	// Discovery fetch keeps the FULL payload here; the visible candidate list
	// is rebuilt from it per trip filter. Filtering only the display would
	// silently import hidden rows: selectedItin() walks the whole
	// itinCandidates array and withItinSelection pre-selects everything
	// non-duplicate.
	interface BirdsTripOption {
		id: number;
		name: string;
		start_date: string | null;
		end_date: string | null;
		placeCount: number;
	}
	let itinBirdsRaw = $state<ItinCandidateRaw[]>([]);
	let itinBirdsTrips = $state<BirdsTripOption[]>([]);
	let itinBirdsTruncated = $state(false);
	let itinBirdsSelectedTrip = $state('');
	// The scoped trip id travels through the hidden input's DOM .value,
	// written IMPERATIVELY right before requestSubmit — never through a
	// reactive attribute: Svelte batches DOM updates, so a reactive value set
	// in the same tick would still be absent from the synchronously-captured
	// FormData (peer CODEX, round 2). Response handling reads the id from the
	// submitted formData only.
	let birdsTripInputEl = $state<HTMLInputElement | null>(null);
	let birdsFormEl = $state<HTMLFormElement | null>(null);
	// Ownership token for the SHARED candidate review panel: every producer
	// (text / URL / photo / birds, and sync writers like the trip filter,
	// Clear, or a completed import) claims it before writing, and every async
	// completion writes only while still the owner — a slow response from one
	// source must not overwrite a newer source's panel (peer CODEX, round 2).
	let candPanelGen = 0;
	function claimCandidatePanel(): number {
		return ++candPanelGen;
	}
	// Which producer's data the panel currently holds — 'birds' panels are
	// wiped on a Birds-username change, others are left alone (round 5).
	let candPanelSource: 'birds' | 'other' | null = null;
	// Async producers must claim AND clear atomically at submit: claiming
	// alone leaves the previous source's rows visible and importable during
	// the in-flight window — the same wrong-context defect in a different
	// producer (peer CODEX, round 3).
	function claimAndClearCandidatePanel(source: 'birds' | 'other' | null = 'other'): number {
		const gen = claimCandidatePanel();
		itinCandidates = [];
		candPanelSource = source;
		return gen;
	}
	// Monotonic request generation: only the newest request's completion may
	// touch shared state; stale completions are dropped entirely.
	let birdsReqSeq = 0;
	// tripId -> count corrected by a complete scoped refetch; -1 means the
	// scoped fetch itself was truncated (a >5000-place trip).
	let birdsExactCounts = $state<Record<string, number>>({});
	// Manual escape hatch: a truncated discovery can omit ENTIRE trips, so the
	// dropdown alone cannot reach them (its list is derived from the same
	// incomplete payload).
	let birdsManualTripId = $state('');
	// The (trimmed) username the current Birds payload/cache belongs to —
	// captured at discovery submit. Editing the username field wipes all
	// Birds-derived state: a scoped cache hit must never serve user A's
	// payload under user B's context (peer CODEX, round 4).
	let birdsStateUsername = '';
	// Complete scoped payloads, keyed by username + trip id (composite key as
	// defense in depth on top of the wipe-on-username-edit): a scoped fetch
	// that lost panel ownership mid-flight must stay loadable later without a
	// refetch (peer CODEX, round 3).
	let birdsScopedCache = $state<Record<string, ItinCandidateRaw[]>>({});
	// The trip whose content the panel actually SHOWS ('' = all/none). The
	// native select's bind commits a new choice before onchange even fires,
	// so a scoped request that fails or loses panel ownership must revert the
	// dropdown to this value — otherwise the instructed recovery ("select it
	// in the dropdown") is a no-op, because re-selecting the already-selected
	// option fires no change event (peer CODEX, browser QA).
	let birdsCommittedTrip = $state('');
	function birdsCacheKey(tripId: string): string {
		return JSON.stringify([birdsStateUsername, tripId]);
	}

	function resetBirdsFetchState() {
		// Advancing the generation CANCELS any in-flight Birds request: its
		// completion sees a stale reqId and drops itself, so a wiped context
		// can never be repopulated by a late response — whether the wipe came
		// from a username edit or from import-success cache hygiene
		// (peer CODEX, round 5). Callers that start a NEW request must take
		// their reqId AFTER calling this.
		birdsReqSeq++;
		itinBirdsFetching = false;
		itinBirdsRaw = [];
		itinBirdsTrips = [];
		itinBirdsTruncated = false;
		itinBirdsSelectedTrip = '';
		birdsCommittedTrip = '';
		birdsExactCounts = {};
		birdsScopedCache = {};
	}

	function onBirdsUsernameInput() {
		if (itinBirdsUsername.trim() === birdsStateUsername) return;
		// Everything Birds-derived belongs to the previous username. That
		// includes the candidate PANEL when Birds produced it — leaving A's
		// rows importable under B's username is the same wrong-context
		// surface, just via the live panel instead of the cache (peer CODEX,
		// round 5). Panels from other sources are none of Birds' business.
		if (candPanelSource === 'birds') {
			claimAndClearCandidatePanel(null);
			itinBirdsMsg = 'Birds results cleared — fetch again for the new username.';
		}
		resetBirdsFetchState();
	}

	function birdsCountLabel(t: BirdsTripOption): string {
		const exact = birdsExactCounts[String(t.id)];
		if (exact === -1) return '5000+';
		if (exact !== undefined) return String(exact);
		// Discovery counts under truncation are only lower bounds.
		return `${t.placeCount}${itinBirdsTruncated ? '+' : ''}`;
	}

	function birdsSummaryMsg(raw: ItinCandidateRaw[]): string {
		const dupes = raw.filter((c) => c.duplicate).length;
		return `${raw.length} Birds place${raw.length === 1 ? '' : 's'} found${dupes ? `, ${dupes} possible duplicate${dupes === 1 ? '' : 's'}` : ''}.`;
	}

	// Rebuilds itinCandidates from the raw payload for the selected trip.
	// Deliberately DISCARDS per-row edits/selections made before switching
	// trips — acceptable for an import flow, and stated rather than emergent.
	function applyBirdsTripFilter() {
		claimCandidatePanel();
		candPanelSource = 'birds';
		if (itinBirdsTruncated && !itinBirdsSelectedTrip) {
			// A truncated discovery payload can omit whole trips AND cut one
			// trip mid-list — an "All trips" import would be silently partial
			// with no way to detect it. Scoped per-trip refetches are complete.
			itinCandidates = [];
			itinBirdsMsg =
				'Birds has more places than one fetch can carry — pick a trip below to import it completely.';
			// This empty blocked-All view IS the committed display: a later
			// scoped rollback must land on All, not a stale earlier trip.
			birdsCommittedTrip = '';
			return;
		}
		const filtered = itinBirdsSelectedTrip
			? itinBirdsRaw.filter(
					(c) =>
						Number((c.meta as Record<string, unknown> | null | undefined)?.birds_trip_id) ===
						Number(itinBirdsSelectedTrip)
				)
			: itinBirdsRaw;
		itinCandidates = withItinSelection(filtered);
		itinBirdsMsg =
			filtered.length === 0 ? 'No importable Birds places found.' : birdsSummaryMsg(filtered);
		birdsCommittedTrip = itinBirdsSelectedTrip;
	}

	function fetchBirdsTripScoped(tripId: string) {
		if (!birdsTripInputEl || !birdsFormEl) return;
		// The previous trip's rows must not remain importable while the new
		// one loads — clear the panel BEFORE the request starts.
		claimAndClearCandidatePanel('birds');
		itinBirdsMsg = 'Fetching trip from Birds…';
		// Direct DOM write: deterministic for the synchronous submit below,
		// with no dependence on Svelte's render scheduling.
		birdsTripInputEl.value = tripId;
		birdsFormEl.requestSubmit();
		birdsTripInputEl.value = '';
	}

	// Load a complete scoped payload from cache when we have it; otherwise
	// fetch. The cache is what makes a lost-ownership scoped fetch (see the
	// enhance completion) recoverable without another round-trip.
	function loadScopedFromCacheOrFetch(tripId: string) {
		const cached = birdsScopedCache[birdsCacheKey(tripId)];
		if (cached) {
			claimAndClearCandidatePanel('birds');
			itinBirdsSelectedTrip = tripId;
			birdsCommittedTrip = tripId;
			itinGeocode = false;
			itinCandidates = withItinSelection(cached);
			itinBirdsMsg = birdsSummaryMsg(cached);
			return;
		}
		fetchBirdsTripScoped(tripId);
	}

	function onBirdsTripChange() {
		if (itinBirdsTruncated && itinBirdsSelectedTrip) {
			// The discovery payload may have cut this trip mid-list; use the
			// complete scoped payload (cached or refetched) so the import is
			// complete.
			loadScopedFromCacheOrFetch(itinBirdsSelectedTrip);
			return;
		}
		applyBirdsTripFilter();
	}

	function fetchBirdsManualTrip() {
		const id = birdsManualTripId.trim();
		const n = Number(id);
		// Positive safe integer only — the server rejects anything else with a
		// 400 rather than silently falling back to an unscoped fetch, and the
		// client should not send known-bad values in the first place.
		if (!/^\d+$/.test(id) || !Number.isSafeInteger(n) || n < 1) {
			itinBirdsMsg = 'Enter a valid Birds trip id (a positive whole number).';
			return;
		}
		loadScopedFromCacheOrFetch(String(n));
	}
	const itinImportParents = $derived(
		data.itineraryRows.filter((r) => ['day', 'section', 'place'].includes(r.node.item_type))
	);

	function isItinDescendant(candidateId: number, ancestorId: number): boolean {
		let current = data.itineraryRows.find((r) => r.node.id === candidateId)?.node;
		while (current?.parent_id != null) {
			if (current.parent_id === ancestorId) return true;
			current = data.itineraryRows.find((r) => r.node.id === current?.parent_id)?.node;
		}
		return false;
	}

	function itinMoveParentsFor(id: number) {
		return itinImportParents.filter(({ node }) => node.id !== id && !isItinDescendant(node.id, id));
	}

	function itinParentOptionLabel(row: (typeof data.itineraryRows)[number]) {
		return `${'· '.repeat(row.depth)}${row.node.title} (${row.node.item_type})`;
	}

	function itinMoveParentOptionsFor(id: number) {
		return [
			{ value: '', label: 'Top level' },
			...itinMoveParentsFor(id).map((row) => ({
				value: String(row.node.id),
				label: itinParentOptionLabel(row),
				searchText: `${row.node.title} ${row.node.item_type}`
			}))
		];
	}

	const itinImportParentOptions = $derived([
		{ value: '', label: 'Top level' },
		...itinImportParents.map((row) => ({
			value: String(row.node.id),
			label: itinParentOptionLabel(row),
			searchText: `${row.node.title} ${row.node.item_type}`
		}))
	]);

	function withItinSelection(raw: ItinCandidateRaw[]): ItinCandidate[] {
		return raw.map((c) => ({
			...c,
			date: c.date ?? '',
			notes: c.notes ?? '',
			external_url: c.external_url ?? '',
			address: c.address ?? '',
			location_query: c.location_query ?? '',
			selected: !c.duplicate,
			children: withItinSelection(c.children ?? [])
		}));
	}

	function walkItinCandidates(items: ItinCandidate[], fn: (item: ItinCandidate) => void) {
		for (const item of items) {
			fn(item);
			walkItinCandidates(item.children ?? [], fn);
		}
	}

	function selectedItinCount(): number {
		let count = 0;
		walkItinCandidates(itinCandidates, (item) => {
			if (item.selected) count += 1;
		});
		return count;
	}

	function selectAllItin(selected: boolean) {
		walkItinCandidates(itinCandidates, (item) => {
			item.selected = selected;
		});
	}

	function selectedItin(items: ItinCandidate[]): ItinCandidate[] {
		const out: ItinCandidate[] = [];
		for (const item of items) {
			const children = selectedItin(item.children ?? []);
			if (item.selected) out.push({ ...item, children });
			else out.push(...children);
		}
		return out;
	}

	async function importSelectedItinerary() {
		if (itinImporting) return;
		const selected = selectedItin(itinCandidates);
		if (selected.length === 0) return;
		// Capture (not claim) the panel generation the snapshot came from: if
		// another producer takes the panel while the import is in flight, this
		// completion must NOT clear or overwrite the newer panel — it imported
		// the OLD snapshot, and stealing ownership at completion erases work
		// the user started afterwards (peer CODEX, round 3).
		const panelGen = candPanelGen;
		itinImporting = true;
		const fd = new FormData();
		fd.set('candidates', JSON.stringify(selected));
		fd.set('parent_id', itinImportParentId);
		fd.set('geocode', itinGeocode ? 'true' : 'false');
		try {
			const res = await fetch('?/itin-import-candidates', { method: 'POST', body: fd });
			// Parse the action result rather than trusting res.ok: a failed
			// action must NOT clear the review panel (peer CODEX, branch E) —
			// the user needs the candidates intact to adjust and retry.
			const result = deserialize(await res.text());
			if (result.type === 'success' && (result.data as { ok?: boolean } | undefined)?.ok) {
				const imported = (result.data as { imported?: number }).imported ?? 0;
				// Cache hygiene (peer CODEX, round 4): every cached/raw Birds
				// payload carries duplicate annotations computed BEFORE this
				// import — all of it is stale now. One fetch click rebuilds it
				// with fresh marks; serving old annotations re-offers items
				// that were just imported.
				resetBirdsFetchState();
				if (panelGen === candPanelGen) {
					claimAndClearCandidatePanel(null);
					itinExtractText = '';
					itinExtractMsg = `Imported ${imported} item${imported === 1 ? '' : 's'}.`;
				} else {
					// The import really happened — say so — but the panel now
					// belongs to a newer source and stays untouched.
					itinExtractMsg = `Imported ${imported} item${imported === 1 ? '' : 's'} from the earlier selection.`;
				}
				await invalidateAll();
			} else if (result.type === 'failure') {
				itinExtractMsg =
					(result.data as { error?: string } | undefined)?.error ??
					'Import failed. Review the candidates and try again.';
			} else {
				itinExtractMsg = 'Import failed. Review the candidates and try again.';
			}
		} finally {
			itinImporting = false;
		}
	}

	// Single shared confirm-delete modal. Every ✕ / Delete control opens this
	// instead of submitting immediately, so no deletion (and no parent_id
	// ON DELETE CASCADE wipe of children) happens without confirmation. (td-02acd0)
	type PendingDelete = {
		action: string; // form action name, e.g. 'itin-delete'
		fields: Record<string, number>; // hidden inputs the action needs
		heading: string;
		body: string;
		confirmLabel: string;
	};
	let pendingDelete = $state<PendingDelete | null>(null);

	const itinHasChildren = (id: number) => data.itineraryRows.some((r) => r.node.parent_id === id);

	type ItinNode = PageData['itineraryRows'][number]['node'];
	type DayPlan = PageData['dayPlans'][number];
	type DayPlanStop = PageData['dayPlanStops'][number];
	const toPlace = (n: ItinNode): MapPlace => ({
		name: n.title,
		lat: n.lat,
		lon: n.lon,
		place_id: n.place_id,
		apple_maps_place_id: n.apple_maps_place_id
	});

	// Pins for the map: places that have coordinates.
	const pins = $derived(
		data.itineraryRows
			.filter((r) => r.node.lat != null && r.node.lon != null)
			.map((r) => ({ id: r.node.id, title: r.node.title, lat: r.node.lat!, lon: r.node.lon! }))
	);

	// Multi-stop "directions for the day" for a day/section: its direct child places in order.
	function dayDirections(parentId: number): string | null {
		const places = data.itineraryRows
			.filter((r) => r.node.parent_id === parentId && r.node.item_type === 'place')
			.map((r) => toPlace(r.node));
		return googleDayDirectionsLink(places);
	}

	function directChildPlaces(parentId: number) {
		return data.itineraryRows.filter(
			(r) => r.node.parent_id === parentId && r.node.item_type === 'place'
		);
	}

	// ── Day plan builder + saved plan helpers ──
	type BuilderStop = {
		itinerary_item_id: number;
		title: string;
		notes: string;
		lat: number | null;
		lon: number | null;
		place_id: string | null;
		apple_maps_place_id: string | null;
	};
	let dayPlanBuilderOpen = $state(false);
	let dayPlanTitle = $state('');
	let dayPlanDate = $state('');
	let dayPlanNotes = $state('');
	let dayPlanStops = $state<BuilderStop[]>([]);
	let dayPlanAddPlaceId = $state('');
	// Per-plan "add stop" selection. A native <select required> blocked an empty
	// submit; the combobox posts through a hidden input, which browsers exclude
	// from constraint validation, so the Add button is gated on this instead.
	let dayPlanAddStopSel = $state<Record<number, string>>({});
	let dayPlanRouteBusy = $state<number | 'builder' | null>(null);
	let dayPlanRouteStatus = $state<Record<number, string>>({});
	let dayPlanAddStopError = $state<Record<number, string>>({});
	let savedPlanAnchors = $state<Record<number, string>>({});
	let builderAnchor = $state('none');
	let dayPlanBuilderError = $state('');
	let builderRouteKm = $state<number | null>(null);
	let builderRouteMin = $state<number | null>(null);
	let distanceUnit = $state<DistanceUnit>('mi');

	let aiNotesBusy = $state<number | null>(null);
	let aiNotesError = $state<Record<number, string>>({});

	type Suggestion = {
		source: 'internal' | 'external';
		name: string;
		lat: number;
		lng: number;
		/** Extra driving this stop adds, in minutes. Null when it could not be routed. */
		added_min: number | null;
		added_km: number | null;
		/** The road-optimal slot: between these two existing route points. */
		edge_from: string;
		edge_to: string;
		/** Title of another day plan already using this place, if any. */
		scheduled_in: string | null;
		date_matches_plan: boolean;
		approximate: boolean;
		itinerary_item_id?: number | null;
		place_id?: string | null;
		vicinity: string | null;
	};
	type SuggestionSet = {
		pinned: Suggestion[];
		internal: Suggestion[];
		external: Suggestion[];
		approximate: boolean;
		total: number;
	};
	/**
	 * Share-text modal (td-9ae4dd). The old <a> to the inline text/plain
	 * export navigated the installed PWA's only window to a chrome-less text
	 * view iOS gives no way to leave. The text now opens in-app: a dismissible
	 * modal with system-share and copy. `error: true` renders the message
	 * instead of a copyable body.
	 */
	let shareModal = $state<{ title: string; text: string; error: boolean } | null>(null);
	let shareBusy = $state(false);
	let shareCopied = $state(false);
	let shareSheetError = $state('');
	/** The Share text button that opened the modal; focus returns there on close. */
	let shareReturnFocus: HTMLElement | null = null;
	let shareCloseBtn = $state<HTMLButtonElement | null>(null);

	// aria-modal promises a modal focus context: move focus in on open (Close
	// is the deterministic landing spot), give it back on every close path.
	$effect(() => {
		if (shareModal && shareCloseBtn) shareCloseBtn.focus();
	});

	async function openShareText(url: string, title: string) {
		if (shareBusy) return;
		shareBusy = true;
		shareCopied = false;
		shareSheetError = '';
		shareReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		try {
			const res = await fetch(url, { credentials: 'same-origin' });
			if (!res.ok) throw new Error(`Export failed: ${res.status}`);
			shareModal = { title, text: await res.text(), error: false };
		} catch {
			shareModal = {
				title,
				text: 'Could not load the text. Check your connection and try again.',
				error: true
			};
		} finally {
			shareBusy = false;
		}
	}

	function closeShareModal() {
		shareModal = null;
		shareSheetError = '';
		shareReturnFocus?.focus();
		shareReturnFocus = null;
	}

	/** Keep Tab cycling inside the dialog while it is open. */
	function trapShareFocus(e: KeyboardEvent) {
		if (e.key !== 'Tab') return;
		const dialog = e.currentTarget as HTMLElement;
		const focusables = Array.from(
			dialog.querySelectorAll<HTMLElement>('button:not([disabled]), textarea')
		);
		if (focusables.length === 0) return;
		const first = focusables[0];
		const last = focusables[focusables.length - 1];
		if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	}

	async function runShareSheet() {
		if (!shareModal || shareModal.error) return;
		shareSheetError = '';
		const outcome = await shareText(shareModal.text, shareModal.title);
		// 'cancelled' (user closed the sheet) stays quiet; a real failure must
		// not leave the button looking dead.
		if (outcome === 'failed' || outcome === 'unavailable') {
			shareSheetError = 'Sharing failed here — use Copy instead.';
		}
	}

	async function copyShareText() {
		if (!shareModal || shareModal.error) return;
		try {
			await navigator.clipboard.writeText(shareModal.text);
			shareCopied = true;
			setTimeout(() => (shareCopied = false), 1600);
		} catch {
			// Clipboard denied — the text stays selectable in the box.
		}
	}

	/** Day plan awaiting a name for its copy; null when the dialog is closed. */
	let pendingDuplicatePlan = $state<{ id: number; title: string } | null>(null);
	let duplicatePlanError = $state('');
	let dupNameInput = $state<HTMLInputElement | null>(null);
	$effect(() => {
		if (pendingDuplicatePlan && dupNameInput) {
			dupNameInput.focus();
			dupNameInput.select();
		}
	});
	let suggestBusy = $state<number | null>(null);
	let suggestions = $state<Record<number, SuggestionSet>>({});
	/** Max extra driving the user will accept for a suggested stop. */
	let suggestBudget = $state<Record<number, number>>({});
	const DETOUR_BUDGETS = [15, 30, 60];
	function budgetFor(planId: number): number {
		return suggestBudget[planId] ?? 30;
	}
	function fmtAdded(s: Suggestion): string {
		if (s.added_min === null) return 'drive time unavailable';
		if (s.approximate) return `~${fmtDistance(s.added_km ?? 0)} off route`;
		return s.added_min === 0 ? 'on the way' : `+${s.added_min} min`;
	}

	const dayPlanPlaces = $derived(data.itineraryRows.filter((r) => r.node.item_type === 'place'));
	const dayPlanParents = $derived(
		data.itineraryRows.filter((r) => r.node.item_type === 'day' || r.node.item_type === 'section')
	);
	const dayPlanPlaceOptions = $derived(
		dayPlanPlaces.map((row) => ({
			value: String(row.node.id),
			label: `${'· '.repeat(row.depth)}${row.node.title}`,
			searchText: row.node.title
		}))
	);
	// Places already in the builder stay visible but greyed, as the old
	// <option disabled> did, so it's clear why they can't be picked again.
	const builderPlaceOptions = $derived(
		dayPlanPlaceOptions.map((option) => ({
			...option,
			disabled: dayPlanStops.some((s) => String(s.itinerary_item_id) === option.value)
		}))
	);

	function stopPlace(stop: BuilderStop): MapPlace {
		return {
			name: stop.title,
			lat: stop.lat,
			lon: stop.lon,
			place_id: stop.place_id,
			apple_maps_place_id: stop.apple_maps_place_id
		};
	}

	function savedStopPlace(stop: DayPlanStop): MapPlace {
		return {
			name: stop.snapshot_title,
			lat: stop.snapshot_lat,
			lon: stop.snapshot_lon,
			place_id: stop.snapshot_place_id
		};
	}

	/**
	 * Anchor options/resolution live in $lib/dayplan-anchor (pure + unit tested).
	 * These wrappers only supply this page's reservations and located places.
	 */
	const anchorPlaceList = $derived(
		dayPlanPlaces.map(({ node }) => ({
			id: node.id,
			title: node.title,
			lat: node.lat,
			lon: node.lon
		}))
	);

	function anchorOptions(
		planDate: string | null,
		currentAnchor: PlanAnchor | null = null
	): AnchorOption[] {
		return buildAnchorOptions(planDate, data.reservations, anchorPlaceList, currentAnchor);
	}

	/** Always pass a saved plan's persisted anchor — see $lib/dayplan-anchor. */
	function anchorFromValue(
		value: string,
		planDate: string | null,
		currentAnchor: PlanAnchor | null = null
	): PlanAnchor | null {
		return resolveAnchor(value, planDate, data.reservations, anchorPlaceList, currentAnchor);
	}

	function anchorPlace(anchor: PlanAnchor | null): MapPlace | null {
		return anchor ? { name: anchor.title, lat: anchor.lat, lon: anchor.lon } : null;
	}

	// The stored title carries the picker's grouping prefix ("Place: ...",
	// "Stay: ..."), which is noise once an anchor is chosen.
	function planAnchor(plan: DayPlan): PlanAnchor | null {
		if (
			!plan.anchor_source ||
			!plan.anchor_title ||
			typeof plan.anchor_lat !== 'number' ||
			typeof plan.anchor_lon !== 'number'
		) {
			return null;
		}
		return {
			source: plan.anchor_source,
			title: cleanAnchorTitle(plan.anchor_title),
			lat: plan.anchor_lat,
			lon: plan.anchor_lon
		};
	}

	function routePlaces(stops: DayPlanStop[], anchor: PlanAnchor | null): MapPlace[] {
		return [anchorPlace(anchor), ...stops.map(savedStopPlace)].filter(
			(p): p is MapPlace => p !== null
		);
	}

	function builderRoutePlaces(): MapPlace[] {
		return [
			anchorPlace(anchorFromValue(builderAnchor, dayPlanDate || null)),
			...dayPlanStops.map(stopPlace)
		].filter((p): p is MapPlace => p !== null);
	}

	function weatherPeriodsForPlan(
		weather: NonNullable<PageData['weatherByPlan']>[number],
		planDate: string | null
	) {
		if (!planDate) return weather.periods.filter((p) => p.isDaytime).slice(0, 2);
		const dated = weather.periods.filter((p) => p.startTime?.slice(0, 10) === planDate);
		const daytime = dated.filter((p) => p.isDaytime);
		if (daytime.length > 0) return daytime.slice(0, 3);
		if (dated.length > 0) return dated.slice(0, 3);
		return weather.periods.filter((p) => p.isDaytime).slice(0, 2);
	}

	function stopsForPlan(planId: number): DayPlanStop[] {
		return data.dayPlanStops.filter((s) => s.day_plan_id === planId);
	}

	function planProgress(stops: DayPlanStop[]): string {
		const visited = stops.filter((s) => s.visited).length;
		return `${visited}/${stops.length} visited`;
	}

	function routeDistanceKm(places: MapPlace[]): number | null {
		let km = 0;
		let legs = 0;
		for (let i = 0; i < places.length - 1; i++) {
			const a = places[i];
			const b = places[i + 1];
			if (
				typeof a.lat === 'number' &&
				typeof a.lon === 'number' &&
				typeof b.lat === 'number' &&
				typeof b.lon === 'number'
			) {
				km += haversineKm(a.lat, a.lon, b.lat, b.lon);
				legs += 1;
			}
		}
		return legs > 0 ? km : null;
	}

	function fmtDistance(km: number): string {
		return formatDistance(km, distanceUnit);
	}

	function routeDistance(places: MapPlace[]): string | null {
		const km = routeDistanceKm(places);
		return km == null ? null : fmtDistance(km);
	}

	function savedRouteStops(stops: DayPlanStop[]): RouteStop[] {
		return stops.map((s) => ({ id: s.id, lat: s.snapshot_lat, lon: s.snapshot_lon }));
	}

	function builderRouteStops(): RouteStop[] {
		return dayPlanStops.map((s) => ({ id: s.itinerary_item_id, lat: s.lat, lon: s.lon }));
	}

	function locatedCount(stops: RouteStop[]): number {
		return stops.filter((s) => typeof s.lat === 'number' && typeof s.lon === 'number').length;
	}

	function allStopsLocated(stops: RouteStop[]): boolean {
		return (
			stops.length > 0 && stops.every((s) => typeof s.lat === 'number' && typeof s.lon === 'number')
		);
	}

	function canCalculateDriving(stops: DayPlanStop[], anchor: PlanAnchor | null): boolean {
		const routeStops = savedRouteStops(stops);
		return routeStops.length >= (anchor ? 1 : 2) && allStopsLocated(routeStops);
	}

	function canOptimizeRoute(stops: RouteStop[], anchor: PlanAnchor | null = null): boolean {
		return locatedCount(stops) >= (anchor ? 2 : 3);
	}

	function canSuggestStops(stops: DayPlanStop[], anchor: PlanAnchor | null): boolean {
		const routePointCount = locatedCount(savedRouteStops(stops)) + (anchor ? 1 : 0);
		return stops.length > 0 && routePointCount >= 2;
	}

	function orderSavedStops(stops: DayPlanStop[], orderedIds: number[]): DayPlanStop[] {
		const byId = new Map(stops.map((s) => [s.id, s]));
		return orderedIds.map((id) => byId.get(id)).filter((s): s is DayPlanStop => !!s);
	}

	function orderBuilderStops(orderedIds: number[]): BuilderStop[] {
		const byId = new Map(dayPlanStops.map((s) => [s.itinerary_item_id, s]));
		return orderedIds.map((id) => byId.get(id)).filter((s): s is BuilderStop => !!s);
	}

	// Driving summaries live in $lib/dayplan-driving so the page and server-side
	// exports render the same numbers. These wrappers only bind the current unit.
	function routeSummary(
		plan: DayPlan,
		stops: DayPlanStop[],
		anchor: PlanAnchor | null
	): string | null {
		return drivingRouteSummary(plan, stops, anchor, distanceUnit);
	}

	function legSummary(
		prev: DayPlanStop | null,
		stop: DayPlanStop,
		anchor: PlanAnchor | null
	): string | null {
		return drivingLegSummary(prev, stop, anchor, distanceUnit);
	}

	function returnSummary(
		plan: DayPlan,
		stops: DayPlanStop[],
		anchor: PlanAnchor | null
	): string | null {
		return drivingReturnSummary(plan, stops, anchor, distanceUnit);
	}

	function setRouteStatus(planId: number, message: string) {
		dayPlanRouteStatus = { ...dayPlanRouteStatus, [planId]: message };
	}

	function setAddStopError(planId: number, message: string) {
		dayPlanAddStopError = { ...dayPlanAddStopError, [planId]: message };
	}

	function addStopError(planId: number): string {
		return dayPlanAddStopError[planId] || (form?.plan_id === planId ? form.error : '') || '';
	}

	async function postAction(action: string, fd: FormData): Promise<ActionData> {
		const response = await fetch(`?/${action}`, {
			method: 'POST',
			body: fd,
			headers: {
				accept: 'application/json',
				'x-sveltekit-action': 'true'
			}
		});
		const result = deserialize(await response.text());
		if (result.type === 'success') return (result.data ?? {}) as ActionData;
		if (result.type === 'failure') {
			throw new Error(((result.data ?? {}) as ActionData).error ?? 'Action failed.');
		}
		throw new Error('Action failed.');
	}

	async function persistDriving(
		planId: number,
		stops: DayPlanStop[],
		anchor: PlanAnchor | null
	): Promise<void> {
		const { legs, returnLeg } = await computeLegDistances(savedRouteStops(stops), anchor);
		const fd = new FormData();
		fd.set('plan_id', String(planId));
		fd.set('legs', JSON.stringify(legs));
		// Anchored plans close the loop; the server rejects a return leg without
		// an anchor and requires one with it.
		if (returnLeg) fd.set('return_leg', JSON.stringify(returnLeg));
		await postAction('dayplan-set-driving', fd);
	}

	async function calculateSavedDriving(
		planId: number,
		stops = stopsForPlan(planId),
		anchor: PlanAnchor | null = null
	) {
		// No MAPS_API_KEY gate: routing runs server-side (td-b580a8) and the
		// display key says nothing about it. Server errors surface below.
		dayPlanRouteBusy = planId;
		try {
			await persistDriving(planId, stops, anchor);
			setRouteStatus(planId, 'Driving distances updated.');
		} catch (err) {
			setRouteStatus(
				planId,
				err instanceof Error ? err.message : 'Could not calculate driving distances.'
			);
		} finally {
			dayPlanRouteBusy = null;
			// Always resync, so a failure shows the server's real state rather than
			// whatever was on screen before.
			await invalidateAll();
		}
	}

	async function setSavedPlanAnchor(
		planId: number,
		planDate: string | null,
		value: string,
		currentAnchor: PlanAnchor | null = null
	) {
		savedPlanAnchors = { ...savedPlanAnchors, [planId]: value };
		const anchor = anchorFromValue(value, planDate, currentAnchor);
		const fd = new FormData();
		fd.set('plan_id', String(planId));
		fd.set('anchor_source', anchor?.source ?? '');
		fd.set('anchor_title', anchor?.title ?? '');
		fd.set('anchor_lat', anchor ? String(anchor.lat) : '');
		fd.set('anchor_lon', anchor ? String(anchor.lon) : '');
		try {
			await postAction('dayplan-set-anchor', fd);
			await invalidateAll();
		} catch (err) {
			setRouteStatus(planId, err instanceof Error ? err.message : 'Could not save anchor.');
		}
	}

	async function optimizeSavedPlan(
		planId: number,
		planDate: string | null,
		selectedAnchor: string,
		stops: DayPlanStop[],
		currentAnchor: PlanAnchor | null = null
	) {
		const anchor = anchorFromValue(selectedAnchor || 'none', planDate, currentAnchor);
		dayPlanRouteBusy = planId;
		try {
			let orderedIds: number[] | undefined;
			let routed = false;
			try {
				const optimized = await optimizeDrivingRoute({
					anchor,
					stops: savedRouteStops(stops)
				});
				orderedIds = optimized.orderedIds;
				routed = true;
			} catch {
				// Fall through to the server-side nearest-neighbor fallback.
			}

			if (!orderedIds) {
				const fallbackFd = new FormData();
				fallbackFd.set('plan_id', String(planId));
				if (anchor) {
					fallbackFd.set('origin_lat', String(anchor.lat));
					fallbackFd.set('origin_lon', String(anchor.lon));
				}
				const fallback = await postAction('dayplan-optimize-fallback', fallbackFd);
				orderedIds = fallback.orderedStopIds;
				if (!orderedIds) throw new Error('Could not optimize stop order.');
			} else {
				const orderFd = new FormData();
				orderFd.set('plan_id', String(planId));
				orderFd.set('ordered_stop_ids', JSON.stringify(orderedIds));
				await postAction('dayplan-set-order', orderFd);
			}

			const orderedStops = orderSavedStops(stops, orderedIds);
			if (routed && allStopsLocated(savedRouteStops(orderedStops))) {
				await persistDriving(planId, orderedStops, anchor);
				setRouteStatus(planId, 'Route optimized and distances updated.');
			} else if (routed) {
				setRouteStatus(
					planId,
					'Route optimized. Add coordinates to every stop to calculate distances.'
				);
			} else {
				setRouteStatus(planId, 'Route optimized using straight-line fallback.');
			}
		} catch (err) {
			setRouteStatus(planId, err instanceof Error ? err.message : 'Could not optimize route.');
		} finally {
			dayPlanRouteBusy = null;
			// Refresh even on failure. Reordering clears the saved driving data
			// before the new legs are written, so a failed persist leaves the page
			// painting totals that no longer exist on the server — numbers the user
			// would reasonably believe were saved.
			await invalidateAll();
		}
	}

	async function optimizeBuilderStops() {
		const routeStops = builderRouteStops();
		const anchor = anchorFromValue(builderAnchor, dayPlanDate || null);
		if (!canOptimizeRoute(routeStops, anchor)) return;
		dayPlanRouteBusy = 'builder';
		try {
			let orderedIds: number[];
			try {
				const optimized = await optimizeDrivingRoute({ anchor, stops: routeStops });
				orderedIds = optimized.orderedIds;
				builderRouteKm = optimized.totalKm;
				builderRouteMin = optimized.totalMin;
			} catch {
				orderedIds = straightLineOptimize(routeStops, anchor);
				builderRouteKm = routeDistanceKm(
					[anchorPlace(anchor), ...orderBuilderStops(orderedIds).map(stopPlace)].filter(
						(p): p is MapPlace => p !== null
					)
				);
				builderRouteMin = null;
			}
			dayPlanStops = orderBuilderStops(orderedIds);
		} catch {
			const orderedIds = straightLineOptimize(routeStops, anchor);
			dayPlanStops = orderBuilderStops(orderedIds);
			builderRouteKm = routeDistanceKm(builderRoutePlaces());
			builderRouteMin = null;
		} finally {
			dayPlanRouteBusy = null;
		}
	}

	async function fetchAiNotes(planId: number) {
		aiNotesBusy = planId;
		aiNotesError = { ...aiNotesError, [planId]: '' };
		try {
			const fd = new FormData();
			fd.set('plan_id', String(planId));
			await postAction('dayplan-ai-notes', fd);
			await invalidateAll();
		} catch (err) {
			aiNotesError = {
				...aiNotesError,
				[planId]: err instanceof Error ? err.message : 'Could not generate notes.'
			};
		} finally {
			aiNotesBusy = null;
		}
	}

	/**
	 * Bring a day plan card's header into view.
	 *
	 * Two things made the naive version land wrong on big cards: `block: 'center'`
	 * centres a 3000px card so its header sits far above the viewport, and weather
	 * panels above the target finish loading after the scroll, shifting everything
	 * down. So this aligns to the top and then re-corrects while the layout is
	 * still settling.
	 */
	async function scrollToPlan(planId: number): Promise<void> {
		let card: Element | null = null;
		for (let attempt = 0; attempt < 10 && !card; attempt++) {
			card = document.querySelector(`[data-plan-id="${planId}"]`);
			if (!card) await new Promise((r) => setTimeout(r, 50));
		}
		if (!card) return;

		card.scrollIntoView({ behavior: 'smooth', block: 'start' });
		// Correct for late layout shifts (weather, driving legs) rather than
		// assuming the first scroll stuck.
		for (const delay of [400, 500, 600]) {
			await new Promise((r) => setTimeout(r, delay));
			const top = card.getBoundingClientRect().top;
			if (Math.abs(top) <= 24) return;
			card.scrollIntoView({ behavior: 'smooth', block: 'start' });
		}
	}

	async function fetchSuggestions(planId: number) {
		suggestBusy = planId;
		const requestedBudget = budgetFor(planId);
		try {
			const fd = new FormData();
			fd.set('plan_id', String(planId));
			fd.set('detour_budget_min', String(requestedBudget));
			const result = (await postAction('dayplan-suggest', fd)) as ActionData & {
				pinned?: Suggestion[];
				internal?: Suggestion[];
				external?: Suggestion[];
				approximate?: boolean;
				total?: number;
			};
			// Scoring is a single round trip, but a second click or a budget change
			// mid-flight can still land out of order — drop anything that no longer
			// matches what the user is currently asking for.
			if (budgetFor(planId) !== requestedBudget) return;
			suggestions = {
				...suggestions,
				[planId]: {
					pinned: result.pinned ?? [],
					internal: result.internal ?? [],
					external: result.external ?? [],
					approximate: result.approximate ?? false,
					total: result.total ?? 0
				}
			};
		} catch (err) {
			suggestions = {
				...suggestions,
				[planId]: { pinned: [], internal: [], external: [], approximate: false, total: 0 }
			};
			aiNotesError = {
				...aiNotesError,
				[planId]: err instanceof Error ? err.message : 'Could not load suggestions.'
			};
		} finally {
			suggestBusy = null;
		}
	}

	async function addSuggestionAsStop(planId: number, sug: Suggestion) {
		const fd = new FormData();
		fd.set('plan_id', String(planId));
		fd.set('name', sug.name);
		fd.set('lat', String(sug.lat));
		fd.set('lng', String(sug.lng));
		fd.set('place_id', sug.place_id ?? '');
		fd.set('vicinity', sug.vicinity ?? '');
		if (sug.source === 'internal' && sug.itinerary_item_id) {
			fd.set('itinerary_item_id', String(sug.itinerary_item_id));
		}
		try {
			aiNotesError = { ...aiNotesError, [planId]: '' };
			await postAction('dayplan-add-suggestion', fd);
			await invalidateAll();
			if (suggestions[planId]) {
				const s = suggestions[planId];
				suggestions = {
					...suggestions,
					[planId]: {
						...s,
						pinned: s.pinned.filter((i) => i.name !== sug.name),
						internal: s.internal.filter((i) => i.name !== sug.name),
						external: s.external.filter((i) => i.name !== sug.name)
					}
				};
			}
		} catch (err) {
			aiNotesError = {
				...aiNotesError,
				[planId]: err instanceof Error ? err.message : 'Could not add that stop.'
			};
		}
	}

	const activeBuilderAnchor = $derived(anchorFromValue(builderAnchor, dayPlanDate || null));
	const builderRoute = $derived(googleDayDirectionsLink(builderRoutePlaces()));
	const builderLegs = $derived(googleLegByLegLinks(builderRoutePlaces()));
	const builderDistance = $derived(routeDistance(builderRoutePlaces()));
	const builderRouteSummary = $derived(
		builderRouteKm == null
			? ''
			: builderRouteMin == null
				? fmtDistance(builderRouteKm)
				: `${fmtDistance(builderRouteKm)}, ${formatDuration(builderRouteMin)}`
	);
	const builderStopsJson = $derived(
		JSON.stringify(
			dayPlanStops.map((s) => ({
				itinerary_item_id: s.itinerary_item_id,
				notes: s.notes.trim() || null
			}))
		)
	);

	function resetDayPlanBuilder() {
		dayPlanTitle = '';
		dayPlanDate = '';
		dayPlanNotes = '';
		dayPlanStops = [];
		dayPlanAddPlaceId = '';
		builderAnchor = 'none';
		dayPlanBuilderError = '';
		builderRouteKm = null;
		builderRouteMin = null;
	}

	function openDayPlanBuilder() {
		resetDayPlanBuilder();
		dayPlanBuilderOpen = true;
	}

	function addBuilderPlace(row: PageData['itineraryRows'][number]) {
		if (dayPlanStops.some((s) => s.itinerary_item_id === row.node.id)) return;
		dayPlanStops = [
			...dayPlanStops,
			{
				itinerary_item_id: row.node.id,
				title: row.node.title,
				notes: '',
				lat: row.node.lat,
				lon: row.node.lon,
				place_id: row.node.place_id,
				apple_maps_place_id: row.node.apple_maps_place_id
			}
		];
		builderRouteKm = null;
		builderRouteMin = null;
	}

	function addSelectedBuilderPlace() {
		const id = Number(dayPlanAddPlaceId);
		const row = dayPlanPlaces.find((r) => r.node.id === id);
		if (row) addBuilderPlace(row);
		dayPlanAddPlaceId = '';
	}

	function startDayPlanFromParent(parent: ItinNode) {
		const rows = directChildPlaces(parent.id);
		dayPlanTitle = parent.title;
		dayPlanDate = parent.date ?? '';
		dayPlanNotes = '';
		dayPlanStops = [];
		for (const row of rows) addBuilderPlace(row);
		dayPlanBuilderOpen = true;
	}

	function moveBuilderStop(index: number, delta: number) {
		const target = index + delta;
		if (target < 0 || target >= dayPlanStops.length) return;
		const next = [...dayPlanStops];
		[next[index], next[target]] = [next[target], next[index]];
		dayPlanStops = next;
		builderRouteKm = null;
		builderRouteMin = null;
	}

	function removeBuilderStop(index: number) {
		dayPlanStops = dayPlanStops.filter((_, i) => i !== index);
		builderRouteKm = null;
		builderRouteMin = null;
	}

	// A native checkbox flips its own DOM state before the request is even
	// sent, so a failed PATCH left the control lying about what was saved
	// (peer CODEX, td-430ffe review). On any failure: revert the control to
	// the server's truth and say so. The pending set drops re-clicks while a
	// request is in flight, so out-of-order completions can't interleave.
	const visitedPending = new Set<string>();
	let visitedSaveError = $state<string | null>(null);
	async function sendVisited(
		kind: 'stop' | 'item',
		id: number,
		visited: boolean,
		input: HTMLInputElement
	) {
		const key = `${kind}:${id}`;
		if (visitedPending.has(key)) {
			input.checked = !visited;
			return;
		}
		visitedPending.add(key);
		visitedSaveError = null;
		try {
			const res = await fetch(kind === 'stop' ? '/api/dayplan/visited' : '/api/itinerary/visited', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id, visited })
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			await invalidateAll();
		} catch {
			input.checked = !visited;
			visitedSaveError = 'Could not save that visited change — it has been undone. Try again.';
		} finally {
			visitedPending.delete(key);
		}
	}

	function toggleVisited(id: number, visited: boolean, input: HTMLInputElement) {
		return sendVisited('stop', id, visited, input);
	}

	// Check a place off from the Places tree (td-430ffe). The server fans the
	// flag out to every day-plan stop copy, so both surfaces always agree.
	function toggleItemVisited(id: number, visited: boolean, input: HTMLInputElement) {
		return sendVisited('item', id, visited, input);
	}

	async function reorderSavedStop(planId: number, stopId: number, delta: number) {
		const ids = stopsForPlan(planId).map((s) => s.id);
		const index = ids.indexOf(stopId);
		const target = index + delta;
		if (index === -1 || target < 0 || target >= ids.length) return;
		[ids[index], ids[target]] = [ids[target], ids[index]];
		const fd = new FormData();
		fd.set('plan_id', String(planId));
		fd.set('ordered_stop_ids', JSON.stringify(ids));
		const res = await fetch('?/dayplan-reorder', { method: 'POST', body: fd });
		if (res.ok) await invalidateAll();
	}

	function selectPin(id: number) {
		placesSearch = '';
		flushSync();
		selectedPin = id;
		document.getElementById(`itin-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
	}

	function fmtRange(start: string | null, end: string | null): string {
		if (!start && !end) return 'No dates set';
		const f = (d: string) =>
			new Date(d + 'T00:00:00').toLocaleDateString(undefined, {
				weekday: 'short',
				month: 'short',
				day: 'numeric',
				year: 'numeric'
			});
		if (start && end) return `${f(start)} – ${f(end)}`;
		return f((start ?? end) as string);
	}

	function fmtPlaceDate(date: string): string {
		return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
			weekday: 'short',
			month: 'short',
			day: 'numeric'
		});
	}

	function fmtSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}
	function fmtDateTime(s: string | null): string {
		if (!s) return '';
		return new Date(s).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	// Optimistic packing check-off (works for owner + viewer via the API route).
	async function toggleCheck(id: number, checked: boolean) {
		const res = await fetch('/api/packing/check', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id, checked })
		});
		if (res.ok) invalidateAll();
	}

	// ── Collapse / expand (client-only, persisted in localStorage) ──────────
	// CarbonFin-style branch folding. Itinerary and packing items live in
	// separate tables (ids can collide), so each tree keeps its own collapsed-id
	// set, namespaced per trip. State is purely client-side: no DB column, no
	// mutation — so viewers can fold freely without tripping the write guard.
	const itinKey = $derived(`trips:${data.trip.id}:itinCollapsed`);
	const packKey = $derived(`trips:${data.trip.id}:packCollapsed`);
	const distanceUnitKey = $derived(`trips:${data.trip.id}:distanceUnit`);

	let itinCollapsed = $state<Set<number>>(new Set());
	let packCollapsed = $state<Set<number>>(new Set());

	onMount(() => {
		localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
		itinCollapsed = loadIds(itinKey);
		packCollapsed = loadIds(packKey);
		const savedUnit = localStorage.getItem(distanceUnitKey);
		if (savedUnit === 'km' || savedUnit === 'mi') distanceUnit = savedUnit;
	});

	function setDistanceUnit(unit: DistanceUnit) {
		distanceUnit = unit;
		if (browser) localStorage.setItem(distanceUnitKey, unit);
	}

	function loadIds(key: string): Set<number> {
		if (!browser) return new Set();
		try {
			const v = JSON.parse(localStorage.getItem(key) ?? '[]');
			return new Set(Array.isArray(v) ? v.map(Number).filter(Number.isInteger) : []);
		} catch {
			return new Set();
		}
	}
	function saveIds(key: string, ids: Set<number>) {
		if (browser) localStorage.setItem(key, JSON.stringify([...ids]));
	}

	type TreeRow = { node: { id: number; parent_id: number | null }; depth: number };

	function childMap(rows: TreeRow[]): Map<number, number[]> {
		const m = new Map<number, number[]>();
		for (const { node } of rows) {
			if (node.parent_id != null) {
				const arr = m.get(node.parent_id);
				if (arr) arr.push(node.id);
				else m.set(node.parent_id, [node.id]);
			}
		}
		return m;
	}
	// Ids hidden because some ancestor is collapsed (the collapsed node itself stays visible).
	function hiddenIds(rows: TreeRow[], collapsed: Set<number>): Set<number> {
		const kids = childMap(rows);
		const hidden = new Set<number>();
		const walk = (id: number) => {
			for (const c of kids.get(id) ?? []) {
				if (!hidden.has(c)) {
					hidden.add(c);
					walk(c);
				}
			}
		};
		for (const id of collapsed) if (kids.has(id)) walk(id);
		return hidden;
	}
	// Ids with at least one child (i.e. foldable).
	function parentIds(rows: TreeRow[]): Set<number> {
		const s = new Set<number>();
		for (const { node } of rows) if (node.parent_id != null) s.add(node.parent_id);
		return s;
	}

	let placesSearch = $state('');
	const placesQuery = $derived(placesSearch.trim().toLowerCase());

	function itinerarySearchText(node: PageData['itineraryRows'][number]['node']): string {
		return [
			node.item_type,
			node.title,
			node.notes,
			node.external_url,
			node.date,
			node.lat,
			node.lon
		]
			.filter((v) => v != null && String(v).trim() !== '')
			.join(' ')
			.toLowerCase();
	}

	// ── Bulk "move under" selection (td-947440) ──────────────
	// Selection is by id, so it survives folding and searching; the bulk-bar
	// count is the source of truth, not what happens to be visible.
	let placesSelectMode = $state(false);
	let placesSelected = $state<Record<number, boolean>>({});
	let bulkMoveParent = $state('');
	let bulkMoveError = $state('');
	const placesSelectedIds = $derived(
		Object.entries(placesSelected)
			.filter(([, on]) => on)
			.map(([id]) => Number(id))
	);

	function exitPlacesSelectMode() {
		placesSelectMode = false;
		placesSelected = {};
		bulkMoveParent = '';
		bulkMoveError = '';
	}

	/**
	 * With a search active, select only the DIRECT matches — the ancestor rows
	 * the filter shows for context would silently drag whole subtrees along.
	 */
	function selectAllPlaces() {
		const ids = placesQuery ? [...placesDirectMatchIds] : data.itineraryRows.map((r) => r.node.id);
		const next: Record<number, boolean> = { ...placesSelected };
		for (const id of ids) next[id] = true;
		placesSelected = next;
	}

	// Bulk targets exclude every selected node and everything inside a selected
	// subtree (the server re-checks — this is UX, the union cycle check is the
	// backstop).
	const bulkExcludedIds = $derived.by(() => {
		const out = new Set(placesSelectedIds);
		for (const { node } of data.itineraryRows) {
			if (out.has(node.id)) continue;
			if (placesSelectedIds.some((a) => isItinDescendant(node.id, a))) out.add(node.id);
		}
		return out;
	});
	const bulkMoveParentOptions = $derived([
		{ value: '', label: 'Top level' },
		...itinImportParents
			.filter((row) => !bulkExcludedIds.has(row.node.id))
			.map((row) => ({
				value: String(row.node.id),
				label: itinParentOptionLabel(row),
				searchText: `${row.node.title} ${row.node.item_type}`
			}))
	]);
	/** The chosen target became excluded by a later selection change. */
	const bulkTargetInvalid = $derived(
		bulkMoveParent !== '' && bulkExcludedIds.has(Number(bulkMoveParent))
	);

	const placesDirectMatchIds = $derived.by(() => {
		const matches = new Set<number>();
		if (!placesQuery) return matches;
		for (const { node } of data.itineraryRows) {
			if (itinerarySearchText(node).includes(placesQuery)) matches.add(node.id);
		}
		return matches;
	});

	const placesVisibleIds = $derived.by(() => {
		if (!placesQuery) return new Set<number>();
		const rowsById = new Map(data.itineraryRows.map((row) => [row.node.id, row]));
		const visible = new Set<number>();
		for (const id of placesDirectMatchIds) {
			let row = rowsById.get(id);
			while (row) {
				visible.add(row.node.id);
				row = row.node.parent_id == null ? undefined : rowsById.get(row.node.parent_id);
			}
		}
		return visible;
	});

	// Per-row roll-up of descendant LEAF checked-state (td-b60112). For each node
	// returns {leaves, checked}: a leaf counts as itself; a parent sums its
	// descendants. A checkbox is then derived — all leaves checked → checked,
	// some → indeterminate, none → unchecked — with no extra writes (so the
	// viewer's single-write constraint holds). The same formula collapses to a
	// leaf's own state, and a packing list's progress = its roots' totals.
	type PackRow = {
		node: { id: number; parent_id: number | null; checked: boolean };
		depth: number;
	};
	function leafStats(rows: PackRow[]): Map<number, { leaves: number; checked: number }> {
		const kids = childMap(rows);
		const byId = new Map(rows.map((r) => [r.node.id, r.node]));
		const memo = new Map<number, { leaves: number; checked: number }>();
		function stats(id: number): { leaves: number; checked: number } {
			const hit = memo.get(id);
			if (hit) return hit;
			const childIds = kids.get(id) ?? [];
			let res: { leaves: number; checked: number };
			if (childIds.length === 0) {
				res = { leaves: 1, checked: byId.get(id)?.checked ? 1 : 0 };
			} else {
				let leaves = 0;
				let checked = 0;
				for (const c of childIds) {
					const s = stats(c);
					leaves += s.leaves;
					checked += s.checked;
				}
				res = { leaves, checked };
			}
			memo.set(id, res);
			return res;
		}
		const out = new Map<number, { leaves: number; checked: number }>();
		for (const { node } of rows) out.set(node.id, stats(node.id));
		return out;
	}
	const packChecked = (s?: { leaves: number; checked: number }) =>
		!!s && s.leaves > 0 && s.checked === s.leaves;
	const packIndeterminate = (s?: { leaves: number; checked: number }) =>
		!!s && s.checked > 0 && s.checked < s.leaves;

	const itinHidden = $derived(hiddenIds(data.itineraryRows, itinCollapsed));
	const itinParents = $derived(parentIds(data.itineraryRows));
	// Folded rows stay in the DOM (hidden by the `.folded` class) so that
	// `@media print` can reveal them: print correctness must not depend on any
	// JS running at print time. An active search still *filters* — that is a
	// query, not a fold, and print has always respected it.
	const placesVisibleRows = $derived.by(() => {
		if (placesQuery)
			return data.itineraryRows
				.filter(({ node }) => placesVisibleIds.has(node.id))
				.map((row) => ({ ...row, folded: false }));
		return data.itineraryRows.map((row) => ({ ...row, folded: itinHidden.has(row.node.id) }));
	});

	// The reason the Places check-off exists: a visited roll-up for the header.
	const placeVisitStats = $derived.by(() => {
		let total = 0;
		let visited = 0;
		for (const { node } of data.itineraryRows) {
			if (node.item_type === 'place') {
				total++;
				if (node.visited) visited++;
			}
		}
		return { total, visited };
	});

	function toggled(set: Set<number>, key: string, id: number): Set<number> {
		const next = new Set(set);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		saveIds(key, next);
		return next;
	}
	const toggleItin = (id: number) => (itinCollapsed = toggled(itinCollapsed, itinKey, id));
	const togglePack = (id: number) => (packCollapsed = toggled(packCollapsed, packKey, id));

	function bulkFold(
		set: Set<number>,
		key: string,
		ids: Set<number>,
		collapse: boolean
	): Set<number> {
		const next = new Set(set);
		for (const id of ids) {
			if (collapse) next.add(id);
			else next.delete(id);
		}
		saveIds(key, next);
		return next;
	}
	const collapseAllItin = () =>
		(itinCollapsed = bulkFold(itinCollapsed, itinKey, itinParents, true));
	const expandAllItin = () =>
		(itinCollapsed = bulkFold(itinCollapsed, itinKey, itinParents, false));
	const collapsePack = (rows: TreeRow[]) =>
		(packCollapsed = bulkFold(packCollapsed, packKey, parentIds(rows), true));
	const expandPack = (rows: TreeRow[]) =>
		(packCollapsed = bulkFold(packCollapsed, packKey, parentIds(rows), false));

	// ── Section-level collapse (Places / Packing / Reservations / Documents) ──
	const sectionKey = $derived(`trips:${data.trip.id}:sections`);
	let sections = $state<CollapseMap>({});
	function toggleSection(name: string) {
		sections = toggleCollapse(sections, name, false);
		if (browser) localStorage.setItem(sectionKey, serializeCollapseState(sections));
	}
	const sectionCollapsed = (name: string) => isCollapsed(sections, name, false);

	// ── Per-plan collapse (td-1372a5) ──
	// Day plans start COLLAPSED so the section reads as an index of days rather
	// than a wall of stops. Expressing that needs the tri-state map above: the
	// old Set-of-collapsed-ids could not record "this one is open".
	const dayPlanCardKey = $derived(`trips:${data.trip.id}:dayplanCards`);
	let dayPlanCards = $state<CollapseMap>({});
	const DAY_PLAN_DEFAULT_COLLAPSED = true;
	function toggleDayPlanCard(planId: number) {
		dayPlanCards = toggleCollapse(dayPlanCards, planId, DAY_PLAN_DEFAULT_COLLAPSED);
		if (browser) localStorage.setItem(dayPlanCardKey, serializeCollapseState(dayPlanCards));
	}
	const dayPlanCollapsed = (planId: number) =>
		isCollapsed(dayPlanCards, planId, DAY_PLAN_DEFAULT_COLLAPSED);

	onMount(() => {
		sections = parseCollapseState(localStorage.getItem(sectionKey));
		dayPlanCards = parseCollapseState(localStorage.getItem(dayPlanCardKey));
	});

	// Print a one-page trip sheet (td-a2d073).
	//
	// No JS expansion happens here, deliberately. Folded content is hidden with
	// the `.folded` class rather than removed from the DOM, and `@media print`
	// reveals it — so print correctness never depends on event timing. The
	// previous design raised a `printing` flag and lowered it on `afterprint`,
	// but Safari paginates its preview lazily and can fire `afterprint` before
	// the tail pages render, which silently truncated the printed sheet
	// (browser QA caught the Expenses section missing).
	function printSheet() {
		window.print();
	}

	const packingPrintHref = $derived(
		`/trips/${data.trip.id}/packing/print?collapsed=${encodeURIComponent([...packCollapsed].join(','))}`
	);
</script>

<svelte:head><title>{data.trip.name}</title></svelte:head>

<div class="page-head trip-page-head">
	<a class="muted back" href="/">← All trips</a>
	<h1>{data.trip.name}</h1>
	<div class="sub">
		{fmtRange(data.trip.start_date, data.trip.end_date)}{#if data.trip.archived_at}
			· <span class="badge need">archived</span>{/if}
	</div>
	<button type="button" class="btn small print-btn" onclick={printSheet}>🖨 Print</button>
	<button
		type="button"
		class="btn small"
		disabled={shareBusy}
		onclick={() =>
			openShareText(`/trips/${data.trip.id}/export?format=txt&units=${distanceUnit}`, data.trip.name)}
		title="share or copy as plain text">Share text</button
	>
</div>

{#if data.trip.notes}
	<div class="card">
		<h2>Notes</h2>
		<p style="white-space: pre-wrap">{data.trip.notes}</p>
	</div>
{/if}

<!-- reusable owner control cluster for an outliner row -->
{#snippet treeControls(
	id: number,
	moveAction: string,
	deleteAction: string,
	listId: number | null,
	label: string,
	hasChildren: boolean
)}
	<span class="row-controls">
		{#each [['indent', '⇥'], ['outdent', '⇤'], ['move-up', '↑'], ['move-down', '↓']] as [op, glyph] (op)}
			<form method="POST" action="?/{moveAction}" use:enhance>
				<input type="hidden" name="id" value={id} />
				{#if listId !== null}<input type="hidden" name="list_id" value={listId} />{/if}
				<input type="hidden" name="op" value={op} />
				<button type="submit" title={op}>{glyph}</button>
			</form>
		{/each}
		<button
			type="button"
			class="del"
			title="delete"
			onclick={() =>
				(pendingDelete = {
					action: deleteAction,
					fields: listId !== null ? { id, list_id: listId } : { id },
					heading: 'Delete this item?',
					body: hasChildren
						? `"${label}" and everything nested under it will be permanently removed.`
						: `"${label}" will be permanently removed.`,
					confirmLabel: 'Delete'
				})}>✕</button
		>
	</span>
{/snippet}

<!-- inline "insert item here" form, rendered above or below the reference row -->
{#snippet packInsertForm(listId: number, refId: number, position: 'above' | 'below', depth: number)}
	<li style="padding-left: {depth * 22}px">
		<form
			method="POST"
			action="?/pack-add-at"
			class="add-row insert-row"
			use:enhance={() => {
				return async ({ result, update }) => {
					if (result.type === 'success') packInsert = null;
					await update();
				};
			}}
		>
			<input type="hidden" name="list_id" value={listId} />
			<input type="hidden" name="ref_id" value={refId} />
			<input type="hidden" name="position" value={position} />
			<input name="name" placeholder="Insert {position}…" required use:autofocus />
			<input name="quantity" type="number" min="1" value="1" class="qty" aria-label="quantity" />
			<button class="btn small primary" type="submit">Add</button>
			<button class="btn small" type="button" onclick={() => (packInsert = null)}>Cancel</button>
		</form>
	</li>
{/snippet}

{#snippet itineraryCandidateRows(items: ItinCandidate[], depth: number)}
	{#each items as c}
		<div class="itin-cand-row" style="margin-left: {depth * 18}px">
			<label class="itin-cand-check">
				<input type="checkbox" bind:checked={c.selected} />
				<span class="sr-only">Import {c.title}</span>
			</label>
			<div class="itin-cand-fields">
				<div class="form-row">
					<select bind:value={c.item_type} aria-label="type">
						{#each ['place', 'day', 'section', 'note'] as t (t)}
							<option value={t}>{t}</option>
						{/each}
					</select>
					<input bind:value={c.title} placeholder="Title" />
					<input type="date" bind:value={c.date} aria-label="date" />
				</div>
				<textarea bind:value={c.notes} rows="2" placeholder="Brief notes"></textarea>
				<div class="form-row">
					<input bind:value={c.address} placeholder="Address (if known)" />
					<input bind:value={c.location_query} placeholder="Location query" />
				</div>
				<input bind:value={c.external_url} placeholder="Reference URL" />
				{#if c.duplicate}
					<p class="dup-warning">Possible duplicate: {c.duplicate_title}</p>
				{/if}
			</div>
		</div>
		{#if c.children.length > 0}
			{@render itineraryCandidateRows(c.children, depth + 1)}
		{/if}
	{/each}
{/snippet}

<!-- ── DAY PLANS ─────────────────────────────────────── -->
<div class="card dayplans-card">
	<div class="section-header">
		<button class="section-toggle" type="button" onclick={() => toggleSection('dayplans')}>
			<span class="section-caret">{sectionCollapsed('dayplans') ? '▸' : '▾'}</span>
			<h2>Day Plans</h2>
			<span class="count-badge">{data.dayPlans.length}</span>
		</button>
		<div class="unit-toggle" aria-label="distance units">
			<button
				type="button"
				class:active={distanceUnit === 'mi'}
				aria-pressed={distanceUnit === 'mi'}
				onclick={() => setDistanceUnit('mi')}>mi</button
			>
			<button
				type="button"
				class:active={distanceUnit === 'km'}
				aria-pressed={distanceUnit === 'km'}
				onclick={() => setDistanceUnit('km')}>km</button
			>
		</div>
		{#if !isViewer}
			<button class="btn small" type="button" onclick={openDayPlanBuilder}>Build day</button>
		{/if}
	</div>

	<div class="fold" class:folded={sectionCollapsed('dayplans')}>
		<details class="dayplan-help">
			<summary>How day plans work</summary>
			<div class="dayplan-help-body">
				<details>
					<summary>Building a day plan</summary>
					<ol>
						<li>Click <strong>Build day</strong> to open the builder.</li>
						<li>Type a <strong>title</strong> (required) and optionally pick a date.</li>
						<li>
							Add stops — either click a <strong>group chip</strong> (e.g. "Anniversary & Dining
							Out") to load all places from that itinerary section at once, or pick individual
							places from the dropdown and click <strong>Add place</strong>. The "Filter places" box
							narrows the dropdown by name.
						</li>
						<li>Reorder with the arrow buttons, add per-stop notes if you like.</li>
						<li>Click <strong>Save day</strong> — requires a title and at least one stop.</li>
					</ol>
				</details>
				<details>
					<summary>After saving: stops, routes, and driving</summary>
					<ol>
						<li>
							Your saved plan shows stops, visited count, and weather (US only, if a date is set).
						</li>
						<li>
							Each stop has a <strong>checkbox</strong> to mark visited and a
							<strong>Google</strong> link to open it on a map.
						</li>
						<li>
							Use <strong>Calculate distances</strong> to get driving time between each leg via Google
							Directions.
						</li>
						<li>
							Use <strong>Optimize order</strong> to sort stops by shortest driving route. Pick an anchor
							(your lodging) from the dropdown first.
						</li>
						<li>
							<strong>Open directions</strong> opens the full multi-stop route in Google Maps.
						</li>
						<li>Individual <strong>Leg</strong> links open each segment separately.</li>
					</ol>
				</details>
				<details>
					<summary>AI tools and suggestions</summary>
					<ol>
						<li>
							<strong>Get visit notes</strong> generates 1–3 sentence tips per stop (best time to visit,
							logistics, weather-aware advice).
						</li>
						<li>
							<strong>Suggest stops</strong> finds nearby places — both from your own itinerary and from
							Google Places (landmarks, museums, etc.).
						</li>
						<li>Click <strong>Add</strong> on any suggestion to add it as a stop.</li>
					</ol>
				</details>
				<details>
					<summary>Editing a saved plan</summary>
					<ol>
						<li>Click <strong>edit plan</strong> to change the title, date, or notes.</li>
						<li>Use the <strong>Add a place</strong> form at the bottom to add more stops.</li>
						<li>Remove individual stops or reorder them with the arrows.</li>
						<li>The <strong>delete button</strong> (✕) removes the entire plan.</li>
					</ol>
				</details>
			</div>
		</details>

		{#if data.dayPlans.length === 0}
			<p class="muted">No day plans yet.</p>
		{:else}
			{#if visitedSaveError}
				<p class="field-error" role="alert">{visitedSaveError}</p>
			{/if}
			<div class="dayplan-list">
				{#each data.dayPlans as plan (plan.id)}
					{@const stops = stopsForPlan(plan.id)}
					{@const anchor = planAnchor(plan)}
					{@const route = dayPlanRouteLink(stops, anchor)}
					{@const directions = route.url}
					{@const legLinks = googleLegByLegLinks(routePlaces(stops, anchor))}
					{@const summary = routeSummary(plan, stops, anchor)}
					{@const weather = data.weatherByPlan?.[plan.id]}
					<article class="dayplan-card" data-plan-id={plan.id}>
						<div class="dayplan-head">
							<div class="grow">
								<div class="ttl">{plan.title}</div>
								<div class="meta">
									{#if plan.optional_date}
										{new Date(plan.optional_date + 'T00:00:00').toLocaleDateString(undefined, {
											weekday: 'short',
											month: 'short',
											day: 'numeric'
										})}
										-
									{/if}
									{#if anchor}Anchor +
									{/if}{stops.length} stop{stops.length === 1 ? '' : 's'} -
									{planProgress(stops)}
									{#if summary}
										- {summary}{/if}
								</div>
								{#if plan.notes}<div class="meta">{plan.notes}</div>{/if}
								{#if weather}
									<div class="weather-strip" class:stale={weather.stale}>
										{#if weather.locationLabel}
											<span class="weather-loc">{weather.locationLabel}</span>
										{/if}
										{#each weatherPeriodsForPlan(weather, plan.optional_date) as period}
											<span class="weather-period">
												<strong>{period.name}</strong>
												{period.tempF}°F
												{period.shortForecast}
												{#if period.precipPct != null && period.precipPct > 0}
													({period.precipPct}% precip)
												{/if}
												{period.windSpeed}
												{period.windDirection}
											</span>
										{/each}
										{#if weather.stale}
											<span class="weather-stale-badge">stale</span>
										{/if}
									</div>
								{/if}
							</div>
							<div class="dayplan-actions">
								{#if directions && !route.unreliable}
									<a class="btn small primary" href={directions} target="_blank" rel="noopener"
										>Open directions</a
									>
								{:else if directions && route.unreliable}
									<!-- Google silently drops waypoints past 3 on a phone and truncates
									     past 2048 chars, so a link here would quietly lie. The
									     leg-by-leg links below cover the same route reliably. -->
									<span class="route-capped"
										>{route.reason === 'length'
											? 'Route too long for one Maps link'
											: 'Too many stops for one Maps link'} — use the Leg links below</span
									>
								{:else if stops.length === 1}
									<a
										class="btn small"
										href={googleMapsLink(savedStopPlace(stops[0]))}
										target="_blank"
										rel="noopener">Open map</a
									>
								{/if}
								{#if stops.length > 0}
									{@const exportBase = `/trips/${data.trip.id}/dayplan/${plan.id}`}
									<button
										type="button"
										class="btn small"
										disabled={shareBusy}
										onclick={() =>
											openShareText(
												`${exportBase}/export?format=txt&units=${distanceUnit}`,
												plan.title
											)}
										title="share or copy as plain text">Share text</button
									>
									<a class="btn small" href="{exportBase}/print?units={distanceUnit}"
										>🖨 Print / PDF</a
									>
									{#if plan.optional_date}
										<a
											class="btn small"
											href="{exportBase}/export?format=ics&units={distanceUnit}"
											title="add to Calendar as an all-day event">Calendar</a
										>
									{/if}
								{/if}
								{#if !isViewer}
									<button
										type="button"
										class="btn small"
										title="duplicate this day plan"
										onclick={() => {
											duplicatePlanError = '';
											pendingDuplicatePlan = { id: plan.id, title: `${plan.title} (copy)` };
										}}>⧉ Duplicate</button
									>
									<button
										type="button"
										class="del"
										title="delete"
										onclick={() =>
											(pendingDelete = {
												action: 'dayplan-delete',
												fields: { id: plan.id },
												heading: 'Delete this day plan?',
												body: `"${plan.title}" and its saved route stops will be permanently removed.`,
												confirmLabel: 'Delete'
											})}>✕</button
									>
								{/if}
							</div>
						</div>

						<!-- The app's own disclosure rather than <details open>: <details>
						     fires ontoggle during hydration, which fights the persisted
						     state. This also matches the six section-toggle controls
						     elsewhere. -->
						<button
							type="button"
							class="dayplan-toggle"
							aria-expanded={!dayPlanCollapsed(plan.id)}
							onclick={() => toggleDayPlanCard(plan.id)}
						>
							<span class="section-caret">{dayPlanCollapsed(plan.id) ? '▸' : '▾'}</span>
							<span>Stops ({planProgress(stops)})</span>
							{#if dayPlanCollapsed(plan.id) && summary}
								<span class="muted collapsed-summary">{summary}</span>
							{/if}
						</button>
						<div
							class="dayplan-stops-section fold"
							class:folded={dayPlanCollapsed(plan.id)}
						>
								{#if stops.length === 0}
									<p class="muted">No stops saved.</p>
								{:else}
									{#if !isViewer}
										<div class="route-tools">
											<!-- One-way selectedValue + onSelect: binding into the keyed
											     savedPlanAnchors record throws when the entry is undefined
											     (devlog 2026-07-28). clearOnEdit=false: the anchor is
											     persisted state, so typing only filters — the committed
											     pick survives and Escape/blur restore its label. -->
											<SearchableSelect
												name={`route-anchor-${plan.id}`}
												selectedValue={savedPlanAnchors[plan.id] ??
													plan.anchor_source ??
													'none'}
												clearOnEdit={false}
												onSelect={(value) =>
													setSavedPlanAnchor(plan.id, plan.optional_date, value, anchor)}
												options={anchorOptions(plan.optional_date, anchor)}
												ariaLabel="route anchor"
												placeholder="Search anchor…"
												emptyMessage="No anchors match"
												maxResults={500}
												listboxId={`route-anchor-options-${plan.id}`}
											/>
											<button
												class="btn small"
												type="button"
												disabled={!canCalculateDriving(stops, anchor) ||
													dayPlanRouteBusy === plan.id}
												onclick={() => calculateSavedDriving(plan.id, stops, anchor)}
											>
												{dayPlanRouteBusy === plan.id ? 'Working...' : 'Calculate distances'}
											</button>
											<button
												class="btn small primary"
												type="button"
												disabled={!canOptimizeRoute(savedRouteStops(stops), anchor) ||
													dayPlanRouteBusy === plan.id}
												onclick={() =>
													optimizeSavedPlan(
														plan.id,
														plan.optional_date,
														savedPlanAnchors[plan.id] ?? plan.anchor_source ?? 'none',
														stops,
														anchor
													)}
											>
												Optimize order
											</button>
										</div>
										{#if dayPlanRouteStatus[plan.id]}
											<p class="route-status">{dayPlanRouteStatus[plan.id]}</p>
										{/if}
									{/if}
									<ol class="dayplan-stops">
										{#if anchor}
											<li class="dayplan-anchor-stop">
												<div class="dayplan-stop-row">
													<div class="dayplan-visited">
														<span class="anchor-badge">Anchor</span>
														<span>{anchor.title}</span>
													</div>
													<div class="dayplan-stop-links">
														<a
															class="chip-link"
															href={googleMapsLink(anchorPlace(anchor)!)}
															target="_blank"
															rel="noopener">Google</a
														>
														<a
															class="chip-link"
															href={appleMapsLink(anchorPlace(anchor)!)}
															target="_blank"
															rel="noopener">Apple</a
														>
													</div>
												</div>
											</li>
										{/if}
										{#each stops as stop, i (stop.id)}
											{@const leg = legSummary(i > 0 ? stops[i - 1] : null, stop, anchor)}
											<li>
												{#if leg}
													<div class="drive-leg">
														Drive from {i === 0 && anchor ? 'anchor' : 'previous'}: {leg}
													</div>
												{/if}
												<div class="dayplan-stop-row">
													<label class="dayplan-visited">
														<input
															type="checkbox"
															checked={stop.visited}
															onchange={(e) =>
															toggleVisited(stop.id, e.currentTarget.checked, e.currentTarget)}
														/>
														<span class:done={stop.visited}>{stop.snapshot_title}</span>
													</label>
													<div class="dayplan-stop-links">
														<a
															class="chip-link"
															href={googleMapsLink(savedStopPlace(stop))}
															target="_blank"
															rel="noopener">Google</a
														>
														<a
															class="chip-link"
															href={appleMapsLink(savedStopPlace(stop))}
															target="_blank"
															rel="noopener">Apple</a
														>
														{#if !isViewer}
															<button
																type="button"
																title="move up"
																disabled={i === 0}
																onclick={() => reorderSavedStop(plan.id, stop.id, -1)}>↑</button
															>
															<button
																type="button"
																title="move down"
																disabled={i === stops.length - 1}
																onclick={() => reorderSavedStop(plan.id, stop.id, 1)}>↓</button
															>
															<form
																method="POST"
																action="?/dayplan-remove-stop"
																use:enhance
																class="inline"
															>
																<input type="hidden" name="id" value={stop.id} />
																<button type="submit" class="del">Remove</button>
															</form>
														{/if}
													</div>
												</div>
												{#if stop.notes}<div class="meta dayplan-stop-note">{stop.notes}</div>{/if}
												{#if stop.ai_notes}<div class="ai-note">{stop.ai_notes}</div>{/if}
												{#if !isViewer}
													<form
														method="POST"
														action="?/dayplan-stop-notes"
														use:enhance={() => {
															return async ({ update }) => {
																await update({ reset: false });
															};
														}}
														class="dayplan-note-form"
													>
														<input type="hidden" name="id" value={stop.id} />
														<input name="notes" value={stop.notes ?? ''} placeholder="Stop note" />
														<button class="btn small" type="submit">Save</button>
													</form>
												{/if}
											</li>
										{/each}
										{#if anchor}
											{@const home = returnSummary(plan, stops, anchor)}
											{#if home}
												<li class="dayplan-return-stop">
													<div class="drive-leg">Drive home to {anchor.title}: {home}</div>
												</li>
											{/if}
										{/if}
									</ol>
								{/if}

								{#if legLinks}
									<div class="leg-links">
										{#each legLinks as leg, i}
											<a class="chip-link route" href={leg.url} target="_blank" rel="noopener">
												Leg {i + 1}: {leg.from} to {leg.to}
											</a>
										{/each}
									</div>
								{/if}

								{#if !isViewer}
									<div class="dayplan-ai-tools">
										<button
											class="btn small"
											type="button"
											disabled={aiNotesBusy === plan.id || stops.length === 0}
											onclick={() => fetchAiNotes(plan.id)}
										>
											{aiNotesBusy === plan.id ? 'Generating...' : 'Get visit notes'}
										</button>
										<button
											class="btn small"
											type="button"
											disabled={suggestBusy === plan.id || !canSuggestStops(stops, anchor)}
											onclick={() => fetchSuggestions(plan.id)}
										>
											{suggestBusy === plan.id ? 'Scoring routes...' : 'Suggest stops'}
										</button>
										<label class="detour-budget">
											<span class="visually-hidden">Maximum extra driving</span>
											<select
												value={budgetFor(plan.id)}
												onchange={(e) => {
													suggestBudget = {
														...suggestBudget,
														[plan.id]: Number(e.currentTarget.value)
													};
													// Drop whatever is on screen: it was scored against the
													// OLD budget, and leaving it painted under the new label
													// reads as though those results match the new setting.
													// Dropping the in-flight response is not enough on its own.
													const { [plan.id]: _stale, ...rest } = suggestions;
													suggestions = rest;
													if (_stale) fetchSuggestions(plan.id);
												}}
											>
												{#each DETOUR_BUDGETS as mins}
													<option value={mins}>adds under {mins} min</option>
												{/each}
											</select>
										</label>
									</div>
									{#if aiNotesError[plan.id]}
										<p class="field-error">{aiNotesError[plan.id]}</p>
									{/if}
									{#if suggestions[plan.id]}
										{@const s = suggestions[plan.id]}
										{#if s.pinned.length > 0 || s.internal.length > 0 || s.external.length > 0}
											<div class="suggestions-panel">
												{#if s.approximate}
													<p class="field-error" role="alert">
														Approximate — road times unavailable, ordered by straight-line distance.
													</p>
												{/if}
												{#if s.pinned.length > 0}
													<p class="suggestions-heading pinned-heading">
														Scheduled for this day
													</p>
													{#each s.pinned as sug}
														<div class="suggestion-row pinned">
															<span class="grow">
																{sug.name}
																<span class="added-cost" class:free={sug.added_min === 0}>
																	{fmtAdded(sug)}
																</span>
																<span class="muted sug-slot">
																	{#if sug.edge_from && sug.edge_to}
																		between {sug.edge_from} and {sug.edge_to}
																	{/if}
																</span>
															</span>
															<button
																class="btn small"
																type="button"
																onclick={() => addSuggestionAsStop(plan.id, sug)}>Add</button
															>
														</div>
													{/each}
												{/if}
												{#if s.internal.length > 0}
													<p class="suggestions-heading">
														From your itinerary
														{#if s.total > s.internal.length + s.external.length + s.pinned.length}
															<span class="muted"
																>— showing best {s.internal.length} of {s.total}</span
															>
														{/if}
													</p>
													{#each s.internal as sug}
														<div class="suggestion-row">
															<span class="grow">
																{sug.name}
																<span class="added-cost" class:free={sug.added_min === 0}>
																	{fmtAdded(sug)}
																</span>
																{#if sug.scheduled_in}
																	<span class="sug-badge">in {sug.scheduled_in}</span>
																{/if}
																<span class="muted sug-slot">
																	{#if sug.edge_from && sug.edge_to}
																		between {sug.edge_from} and {sug.edge_to}
																	{/if}{#if sug.vicinity} — {sug.vicinity}{/if}
																</span>
															</span>
															<button
																class="btn small"
																type="button"
																onclick={() => addSuggestionAsStop(plan.id, sug)}>Add</button
															>
														</div>
													{/each}
												{/if}
												{#if s.external.length > 0}
													<p class="suggestions-heading">Nearby discoveries</p>
													{#each s.external as sug}
														<div class="suggestion-row">
															<span class="grow">
																{sug.name}
																<span class="added-cost" class:free={sug.added_min === 0}>
																	{fmtAdded(sug)}
																</span>
																{#if sug.scheduled_in}
																	<span class="sug-badge">in {sug.scheduled_in}</span>
																{/if}
																<span class="muted sug-slot">
																	{#if sug.edge_from && sug.edge_to}
																		between {sug.edge_from} and {sug.edge_to}
																	{/if}{#if sug.vicinity} — {sug.vicinity}{/if}
																</span>
															</span>
															<button
																class="btn small"
																type="button"
																onclick={() => addSuggestionAsStop(plan.id, sug)}>Add</button
															>
														</div>
													{/each}
												{/if}
											</div>
										{:else}
											<p class="muted">No suggestions found nearby.</p>
										{/if}
									{/if}
								{/if}
						</div>

						{#if !isViewer}
							<details class="edit">
								<summary>edit plan</summary>
								<form method="POST" action="?/dayplan-edit" use:enhance class="edit-form">
									<input type="hidden" name="id" value={plan.id} />
									<input name="title" value={plan.title} placeholder="Title" required />
									<input name="optional_date" type="date" value={plan.optional_date ?? ''} />
									<textarea name="notes" rows="2" placeholder="Notes">{plan.notes ?? ''}</textarea>
									<button class="btn small primary" type="submit">Save</button>
								</form>
							</details>
							<form
								method="POST"
								action="?/dayplan-add-stop"
								use:enhance={() => {
									setAddStopError(plan.id, '');
									return async ({ result, update }) => {
										await update({ reset: result.type === 'success' });
										if (result.type === 'success') {
											// A native form reset can't clear the combobox's own state.
											dayPlanAddStopSel[plan.id] = '';
										}
										if (result.type === 'failure') {
											setAddStopError(
												plan.id,
												(result.data as { error?: string })?.error ?? 'Could not add stop.'
											);
										}
									};
								}}
								class="add-row"
							>
								<input type="hidden" name="plan_id" value={plan.id} />
								<div class="add-stop-place">
									<SearchableSelect
										name="itinerary_item_id"
										selectedValue={dayPlanAddStopSel[plan.id] ?? ''}
										onSelect={(value) => (dayPlanAddStopSel[plan.id] = value)}
										options={dayPlanPlaceOptions}
										ariaLabel={`Add a place to ${plan.title}`}
										placeholder="Add a place…"
										emptyMessage="No places match"
										maxResults={500}
										listboxId={`dayplan-add-stop-options-${plan.id}`}
									/>
								</div>
								<input name="notes" placeholder="Stop note" />
								<button
									class="btn small"
									type="submit"
									disabled={!dayPlanAddStopSel[plan.id]}>Add stop</button
								>
							</form>
							{@const addStopMessage = addStopError(plan.id)}
							{#if addStopMessage}
								<p class="field-error add-stop-error" role="alert">{addStopMessage}</p>
							{/if}
						{/if}
					</article>
				{/each}
			</div>
		{/if}

		{#if !isViewer && dayPlanBuilderOpen}
			<form
				method="POST"
				action="?/dayplan-create"
				class="dayplan-builder"
				use:enhance={({ formData }) => {
					formData.set('title', dayPlanTitle.trim());
					formData.set('optional_date', dayPlanDate);
					formData.set('notes', dayPlanNotes);
					formData.set('stops', builderStopsJson);
					const anchor = anchorFromValue(builderAnchor, dayPlanDate || null);
					formData.set('anchor_source', anchor?.source ?? '');
					formData.set('anchor_title', anchor?.title ?? '');
					formData.set('anchor_lat', anchor ? String(anchor.lat) : '');
					formData.set('anchor_lon', anchor ? String(anchor.lon) : '');
					return async ({ result, update }) => {
						await update({ reset: false, invalidateAll: result.type !== 'success' });
						if (result.type === 'success') {
							resetDayPlanBuilder();
							dayPlanBuilderOpen = false;
							await invalidateAll();
						} else if (result.type === 'failure') {
							dayPlanBuilderError =
								(result.data as { error?: string })?.error ?? 'Could not save day plan.';
						}
					};
				}}
			>
				<input type="hidden" name="stops" value={builderStopsJson} />
				<div class="builder-step">
					<div class="builder-step-label">1. Name your day</div>
					<div class="form-row">
						<input name="title" placeholder="Title (required)" required bind:value={dayPlanTitle} />
						<input name="optional_date" type="date" bind:value={dayPlanDate} />
					</div>
					<textarea
						name="notes"
						rows="2"
						placeholder="Plan notes (optional)"
						bind:value={dayPlanNotes}
					></textarea>
				</div>

				<div class="builder-step">
					<div class="builder-step-label">2. Add stops</div>
					{#if dayPlanParents.length > 0}
						<p class="builder-hint">Load an entire group at once:</p>
						<div class="quick-groups">
							{#each dayPlanParents as { node } (node.id)}
								{#if directChildPlaces(node.id).length > 0}
									<button
										class="chip-action group-chip"
										type="button"
										onclick={() => startDayPlanFromParent(node)}
									>
										{node.title}
									</button>
								{/if}
							{/each}
						</div>
						<p class="builder-hint">Or pick individual places:</p>
					{/if}
					<div class="dayplan-picker">
						<SearchableSelect
							name="dayplan-builder-place"
							bind:selectedValue={dayPlanAddPlaceId}
							options={builderPlaceOptions}
							ariaLabel="Choose a place"
							placeholder="Choose a place…"
							emptyMessage="No places match"
							maxResults={500}
							listboxId="dayplan-builder-place-options"
						/>
						<button
							class="btn small"
							type="button"
							onclick={addSelectedBuilderPlace}
							disabled={!dayPlanAddPlaceId}
						>
							Add place
						</button>
					</div>
				</div>

				{#if dayPlanStops.length > 0}
					<div class="builder-step">
						<div class="builder-step-label">3. Review &amp; reorder</div>
						<div class="route-tools">
							<!-- clearOnEdit=false: builderAnchor always holds a real option
							     value ('none' = no anchor); typing only filters. -->
							<SearchableSelect
								name="dayplan-builder-anchor"
								bind:selectedValue={builderAnchor}
								clearOnEdit={false}
								options={anchorOptions(dayPlanDate || null)}
								ariaLabel="route anchor"
								placeholder="Search anchor…"
								emptyMessage="No anchors match"
								maxResults={500}
								listboxId="dayplan-builder-anchor-options"
							/>
							<button
								class="btn small primary"
								type="button"
								disabled={!canOptimizeRoute(
									builderRouteStops(),
									anchorFromValue(builderAnchor, dayPlanDate || null)
								) || dayPlanRouteBusy === 'builder'}
								onclick={optimizeBuilderStops}
							>
								{dayPlanRouteBusy === 'builder' ? 'Working...' : 'Optimize order'}
							</button>
							{#if builderRouteSummary}
								<span class="route-status">Total: {builderRouteSummary}</span>
							{/if}
						</div>
						<ol class="builder-stops">
							{#if activeBuilderAnchor}
								<li class="dayplan-anchor-stop">
									<span class="anchor-badge">Anchor</span>
									<span class="ttl">{activeBuilderAnchor.title}</span>
								</li>
							{/if}
							{#each dayPlanStops as stop, i (stop.itinerary_item_id)}
								<li>
									<span class="ttl">{stop.title}</span>
									<input bind:value={stop.notes} placeholder="Stop note" />
									<div class="builder-controls">
										<button
											type="button"
											title="move up"
											disabled={i === 0}
											onclick={() => moveBuilderStop(i, -1)}>↑</button
										>
										<button
											type="button"
											title="move down"
											disabled={i === dayPlanStops.length - 1}
											onclick={() => moveBuilderStop(i, 1)}>↓</button
										>
										<button type="button" class="del" onclick={() => removeBuilderStop(i)}
											>Remove</button
										>
									</div>
								</li>
							{/each}
						</ol>
						<div class="dayplan-preview">
							<span>{dayPlanStops.length} stop{dayPlanStops.length === 1 ? '' : 's'}</span>
							{#if builderDistance}<span>~{builderDistance} straight-line</span>{/if}
							{#if builderRoute}
								<a class="chip-link route" href={builderRoute} target="_blank" rel="noopener"
									>Open as one route</a
								>
							{/if}
							{#if builderLegs}
								{#each builderLegs as leg, i}
									<a class="chip-link" href={leg.url} target="_blank" rel="noopener">
										Leg {i + 1}
									</a>
								{/each}
							{/if}
						</div>
					</div>
				{/if}
				{#if dayPlanBuilderError}
					<p class="field-error">{dayPlanBuilderError}</p>
				{/if}
				<div class="cand-actions">
					<button
						class="btn small primary save-day-btn"
						type="submit"
						disabled={!dayPlanTitle.trim() || dayPlanStops.length === 0}
					>
						Save day{#if !dayPlanTitle.trim() || dayPlanStops.length === 0}
							<span class="save-hint">
								{#if !dayPlanTitle.trim()}(needs title){:else}(add stops first){/if}
							</span>
						{/if}
					</button>
					<button
						class="btn small"
						type="button"
						onclick={() => {
							resetDayPlanBuilder();
							dayPlanBuilderOpen = false;
						}}
					>
						Cancel
					</button>
				</div>
			</form>
		{/if}
	</div>
</div>

<!-- ── PLACES ─────────────────────────────────────────── -->
<div class="card" id="places">
	<div class="section-header">
		<button class="section-toggle" type="button" onclick={() => toggleSection('places')}>
			<span class="section-caret">{sectionCollapsed('places') ? '▸' : '▾'}</span>
			<h2>Places</h2>
			{#if placeVisitStats.total > 0}
				<span class="count-badge">{placeVisitStats.visited} / {placeVisitStats.total} visited</span>
			{/if}
		</button>
		<a class="btn small places-schedule-btn" href="/trips/{data.trip.id}/places/schedule">
			📅 Schedule
		</a>
	</div>

	<div class="fold" class:folded={sectionCollapsed('places')}>
		{#if visitedSaveError}
			<p class="field-error" role="alert">{visitedSaveError}</p>
		{/if}
		{#if data.itineraryRows.length > 0}
			<PinMap {pins} onselect={selectPin} />
		{/if}

		{#if data.itineraryRows.length === 0}
			<p class="muted">No places yet.</p>
		{:else}
			<div class="places-searchbar">
				<label class="sr-only" for="places-search">Search places</label>
				<input
					id="places-search"
					class="places-search-input"
					type="search"
					bind:value={placesSearch}
					placeholder="Search places..."
					autocomplete="off"
					spellcheck="false"
					aria-describedby="places-search-count"
				/>
				{#if placesSearch}
					<button
						class="btn small places-search-clear"
						type="button"
						onclick={() => (placesSearch = '')}>Clear</button
					>
				{/if}
				<span id="places-search-count" class="places-search-count">
					{#if placesQuery}
						{placesDirectMatchIds.size} match{placesDirectMatchIds.size === 1 ? '' : 'es'}
					{:else}
						{data.itineraryRows.length} items
					{/if}
				</span>
			</div>
			{#if itinParents.size > 0 || !isViewer}
				<div class="tree-tools">
					{#if itinParents.size > 0}
						<button type="button" class="linkbtn" onclick={collapseAllItin}>Collapse all</button>
						<span class="sep" aria-hidden="true">·</span>
						<button type="button" class="linkbtn" onclick={expandAllItin}>Expand all</button>
					{/if}
					{#if !isViewer}
						{#if itinParents.size > 0}<span class="sep" aria-hidden="true">·</span>{/if}
						<button
							type="button"
							class="linkbtn"
							onclick={() => (placesSelectMode ? exitPlacesSelectMode() : (placesSelectMode = true))}
							>{placesSelectMode ? 'Done' : 'Select'}</button
						>
						{#if placesSelectMode}
							<span class="sep" aria-hidden="true">·</span>
							<button type="button" class="linkbtn" onclick={selectAllPlaces}>Select all</button>
							<span class="sep" aria-hidden="true">·</span>
							<button type="button" class="linkbtn" onclick={() => (placesSelected = {})}
								>Clear</button
							>
						{/if}
					{/if}
					{#if placesQuery}
						<span class="muted">Matches include parent groups</span>
					{/if}
				</div>
			{/if}
			{#if placesVisibleRows.length === 0}
				<p class="muted places-empty">No places match "{placesSearch.trim()}".</p>
			{:else}
				<ul class="outline places-outline">
					{#each placesVisibleRows as { node, depth, folded } (node.id)}
						{@const route =
							node.item_type === 'day' || node.item_type === 'section'
								? dayDirections(node.id)
								: null}
						<li
							id="itin-{node.id}"
							style="padding-left: {depth * 22}px"
							class:folded
							class:flash={selectedPin === node.id}
							class:search-match={!!placesQuery && placesDirectMatchIds.has(node.id)}
						>
							<div class="line">
								{#if itinParents.has(node.id)}
									<button
										class="caret"
										type="button"
										aria-expanded={!itinCollapsed.has(node.id)}
										aria-label={itinCollapsed.has(node.id) ? 'Expand' : 'Collapse'}
										onclick={() => toggleItin(node.id)}
										>{itinCollapsed.has(node.id) ? '▸' : '▾'}</button
									>
								{:else}
									<span class="caret-spacer" aria-hidden="true"></span>
								{/if}
								{#if !isViewer && placesSelectMode}
									<!-- Takes the visited checkbox's slot; accent + every row type
									     (not just places) make the different meaning visible. -->
									<label class="chk-hit">
										<input
											type="checkbox"
											class="chk select-chk"
											checked={placesSelected[node.id] ?? false}
											aria-label={`Select ${node.title}`}
											onchange={(e) =>
												(placesSelected = { ...placesSelected, [node.id]: e.currentTarget.checked })}
										/>
									</label>
								{:else if node.item_type === 'place'}
									<label class="chk-hit">
										<input
											type="checkbox"
											class="chk"
											checked={node.visited}
											aria-label="visited"
											onchange={(e) =>
												toggleItemVisited(node.id, e.currentTarget.checked, e.currentTarget)}
										/>
									</label>
								{/if}
								<span class="badge {node.item_type === 'place' ? 'seen' : 'need'}"
									>{node.item_type}</span
								>
								<span class="grow">
									<span class="place-title-line">
										<span class="ttl" class:done={node.item_type === 'place' && node.visited}
											>{node.title}</span
										>
										{#if node.item_type === 'place' && node.date}
											<time class="place-date" datetime={node.date}>
												📅 {fmtPlaceDate(node.date)}
											</time>
										{/if}
									</span>
									{#if node.notes}<div class="meta">{node.notes}</div>{/if}
									<div class="chips">
										{#if node.item_type === 'place'}
											<a
												class="chip-link"
												href={googleMapsLink(toPlace(node))}
												target="_blank"
												rel="noopener">Google</a
											>
											<a
												class="chip-link"
												href={appleMapsLink(toPlace(node))}
												target="_blank"
												rel="noopener">Apple</a
											>
											<a
												class="chip-link"
												href={googleDirectionsLink(toPlace(node))}
												target="_blank"
												rel="noopener">Directions</a
											>
										{/if}
										{#if route}
											<a class="chip-link route" href={route} target="_blank" rel="noopener"
												>Route this group</a
											>
										{/if}
										{#if !isViewer && (node.item_type === 'day' || node.item_type === 'section') && directChildPlaces(node.id).length > 0}
											<button
												class="chip-action"
												type="button"
												onclick={() => startDayPlanFromParent(node)}>Day plan</button
											>
										{/if}
										{#if node.external_url}
											<a class="chip-link" href={node.external_url} target="_blank" rel="noopener"
												>Reference</a
											>
										{/if}
										{#if !isViewer && node.item_type === 'place'}
											<a class="chip-link loc" href="/trips/{data.trip.id}/place/{node.id}">
												{node.lat != null ? '📍 location' : '＋ location'}
											</a>
										{/if}
									</div>
								</span>
								{#if !isViewer && !placesSelectMode}{@render treeControls(
										node.id,
										'itin-move',
										'itin-delete',
										null,
										node.title,
										itinHasChildren(node.id)
									)}{/if}
							</div>
							{#if !isViewer && !placesSelectMode}
								<details class="edit">
									<summary>edit</summary>
									<form
										method="POST"
										action="?/itin-edit"
										use:enhance={() => {
											return async ({ update }) => {
												await update({ reset: false });
											};
										}}
										class="edit-form"
									>
										<input type="hidden" name="id" value={node.id} />
										<select name="item_type" aria-label="type">
											{#each ['place', 'day', 'section', 'note'] as t (t)}
												<option value={t} selected={node.item_type === t}>{t}</option>
											{/each}
										</select>
										<input name="title" value={node.title} placeholder="Title" />
										<input
											name="external_url"
											value={node.external_url ?? ''}
											placeholder="Reference URL"
										/>
										<input name="date" type="date" value={node.date ?? ''} />
										<textarea name="notes" rows="2" placeholder="Notes">{node.notes ?? ''}</textarea
										>
										<button class="btn small primary" type="submit">Save</button>
									</form>
									<form method="POST" action="?/itin-reparent" use:enhance class="move-under-form">
										<input type="hidden" name="id" value={node.id} />
										<label>
											Move under
											<SearchableSelect
												name="parent_id"
												selectedValue={node.parent_id === null ? '' : String(node.parent_id)}
												options={itinMoveParentOptionsFor(node.id)}
												ariaLabel={`Move ${node.title} under`}
												placeholder="Search parent"
												maxResults={500}
												listboxId={`itin-parent-options-${node.id}`}
											/>
										</label>
										<button class="btn small" type="submit">Move</button>
									</form>
								</details>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
			{#if !isViewer && placesSelectMode}
				<form
					method="POST"
					action="?/itin-reparent-many"
					class="bulk-move-bar"
					use:enhance={() => {
						bulkMoveError = '';
						return async ({ result, update }) => {
							if (result.type === 'failure') {
								bulkMoveError = (result.data as { error?: string })?.error ?? 'Could not move.';
								return;
							}
							await update({ reset: false });
							// Reveal the destination so the moved rows are visible.
							const target = bulkMoveParent === '' ? null : Number(bulkMoveParent);
							if (target !== null && itinCollapsed.has(target)) toggleItin(target);
							exitPlacesSelectMode();
						};
					}}
				>
					{#each placesSelectedIds as id (id)}
						<input type="hidden" name="ids" value={id} />
					{/each}
					<span class="bulk-count">{placesSelectedIds.length} selected</span>
					<div class="bulk-move-target">
						<SearchableSelect
							name="parent_id"
							bind:selectedValue={bulkMoveParent}
							options={bulkMoveParentOptions}
							ariaLabel="Move selected under"
							placeholder="Search destination"
							emptyMessage="No destinations match"
							maxResults={500}
							listboxId="bulk-move-parent-options"
						/>
					</div>
					<button
						class="btn small"
						type="button"
						disabled={placesSelectedIds.length === 0}
						onclick={() => (placesSelected = {})}>Clear</button
					>
					<button
						class="btn small primary"
						type="submit"
						disabled={placesSelectedIds.length === 0 || bulkTargetInvalid}>Move</button
					>
				</form>
				{#if bulkMoveError}
					<p class="field-error" role="alert">{bulkMoveError}</p>
				{/if}
			{/if}
		{/if}

		{#if !isViewer}
			<form method="POST" action="?/itin-add" use:enhance class="add-row">
				<select name="item_type" aria-label="type">
					<option value="place">place</option>
					<option value="day">day</option>
					<option value="section">section</option>
					<option value="note">note</option>
				</select>
				<input name="title" placeholder="Add a place / day / note…" required />
				<input type="date" name="date" aria-label="date (optional)" class="itin-date" />
				<textarea name="notes" rows="2" placeholder="Notes"></textarea>
				<button class="btn small primary" type="submit">Add</button>
			</form>
			<details class="paste">
				<summary>Paste many (one per line)</summary>
				<form method="POST" action="?/itin-paste" use:enhance>
					<input type="hidden" name="item_type" value="place" />
					<textarea name="text" rows="4" placeholder="Palais des Papes&#10;Pont d'Avignon&#10;…"
					></textarea>
					<label class="paste-date">
						Date for all (optional)
						<input type="date" name="date" class="itin-date" />
					</label>
					<button class="btn small" type="submit">Add all</button>
				</form>
			</details>
			<details class="paste">
				<summary>Import itinerary from text</summary>
				<div class="extract">
					<p class="extract-head">
						Paste AI output, notes, web text, or bullets. Review before importing.
					</p>
					<form
						method="POST"
						action="?/itin-extract"
						class="extract-form"
						use:enhance={() => {
							const panelGen = claimAndClearCandidatePanel();
							itinExtracting = true;
							itinExtractMsg = '';
							return async ({ result }) => {
								itinExtracting = false;
								if (panelGen !== candPanelGen) return; // a newer source owns the panel
								if (result.type === 'success' && result.data?.ok) {
									const raw = (result.data as { candidates?: ItinCandidateRaw[] }).candidates ?? [];
									itinCandidates = withItinSelection(raw);
									if (raw.length === 0) {
										itinExtractMsg = 'No itinerary items found in the text.';
									} else {
										const dupes = raw.filter((c) => c.duplicate).length;
										itinExtractMsg = `${raw.length} item${raw.length === 1 ? '' : 's'} found${dupes ? `, ${dupes} possible duplicate${dupes === 1 ? '' : 's'}` : ''}.`;
									}
								} else if (result.type === 'failure') {
									itinExtractMsg =
										(result.data as { error?: string })?.error ?? 'Extraction failed.';
								} else {
									itinExtractMsg = 'Extraction failed.';
								}
							};
						}}
					>
						<textarea
							name="text"
							rows="5"
							bind:value={itinExtractText}
							placeholder="Paste rough itinerary text here..."
						></textarea>
						<button
							class="btn small"
							type="submit"
							disabled={itinExtracting || !itinExtractText.trim()}
						>
							{itinExtracting ? 'Extracting...' : 'Extract itinerary'}
						</button>
					</form>
					{#if itinExtractMsg}<p class="extract-msg">{itinExtractMsg}</p>{/if}
				</div>
			</details>
			<details class="paste">
				<summary>Import from Maps link</summary>
				<div class="extract">
					<p class="extract-head">
						Paste a Google Maps or Apple Maps link to extract the place and coordinates.
					</p>
					<form
						method="POST"
						action="?/itin-extract-url"
						class="extract-form"
						use:enhance={() => {
							const panelGen = claimAndClearCandidatePanel();
							itinUrlExtracting = true;
							itinUrlMsg = '';
							return async ({ result }) => {
								itinUrlExtracting = false;
								if (panelGen !== candPanelGen) return; // a newer source owns the panel
								if (result.type === 'success' && result.data?.ok) {
									const raw = (result.data as { candidates?: ItinCandidateRaw[] }).candidates ?? [];
									itinCandidates = withItinSelection(raw);
									if (raw.length === 0) {
										itinUrlMsg = 'Could not extract a place from that link.';
									} else {
										const dupes = raw.filter((c) => c.duplicate).length;
										itinUrlMsg = `${raw.length} place${raw.length === 1 ? '' : 's'} found${dupes ? `, ${dupes} possible duplicate${dupes === 1 ? '' : 's'}` : ''}.`;
									}
								} else if (result.type === 'failure') {
									itinUrlMsg = (result.data as { error?: string })?.error ?? 'Extraction failed.';
								} else {
									itinUrlMsg = 'Extraction failed.';
								}
							};
						}}
					>
						<input
							type="url"
							name="url"
							bind:value={itinUrlText}
							placeholder="https://maps.google.com/... or https://maps.apple.com/..."
						/>
						<button
							class="btn small"
							type="submit"
							disabled={itinUrlExtracting || !itinUrlText.trim()}
						>
							{itinUrlExtracting ? 'Extracting...' : 'Extract place'}
						</button>
					</form>
					{#if itinUrlMsg}<p class="extract-msg">{itinUrlMsg}</p>{/if}
				</div>
			</details>
			<details class="paste">
				<summary>Import from Birds</summary>
				<div class="extract">
					<p class="extract-head">
						Fetch birding trip stops from Birds, then review them before importing.
					</p>
					<form
						method="POST"
						action="?/itin-fetch-birds"
						class="extract-form"
						bind:this={birdsFormEl}
						use:enhance={({ formData }) => {
							// Everything about this request is captured HERE, at submit
							// time — the completion below must never consult mutable
							// globals to classify itself (two in-flight requests would
							// corrupt the state machine; peer CODEX, round 1).
							const scopedTrip = (formData.get('birds_trip_id') ?? '').toString();
							// Discovery replaces the whole Birds context: reset FIRST
							// (which also cancels any in-flight request by bumping the
							// generation), THEN take this request's own generation so
							// the reset cannot cancel it (peer CODEX, round 5).
							if (!scopedTrip) resetBirdsFetchState();
							const reqId = ++birdsReqSeq;
							const panelGen = scopedTrip
								? claimCandidatePanel()
								: claimAndClearCandidatePanel('birds');
							itinBirdsFetching = true;
							itinBirdsMsg = scopedTrip ? 'Fetching trip from Birds…' : '';
							// The state produced by this request belongs to THIS username.
							birdsStateUsername = (formData.get('username') ?? '').toString().trim();
							return async ({ result }) => {
								if (reqId !== birdsReqSeq) return; // a newer Birds request owns the state
								itinBirdsFetching = false;
								const scoped = scopedTrip !== '';
								// The candidate PANEL may have been claimed by another
								// source (text/URL/photo) while this was in flight; the
								// Birds-local state below still updates, but the panel
								// belongs to whoever wrote it last.
								const ownsPanel = panelGen === candPanelGen;
								if (result.type === 'success' && result.data?.ok) {
									const raw = (result.data as { candidates?: ItinCandidateRaw[] }).candidates ?? [];
									const trips = (result.data as { birdsTrips?: BirdsTripOption[] }).birdsTrips ?? [];
									const truncated = (result.data as { truncated?: boolean }).truncated === true;
									if (scoped) {
										// Single-trip refetch: the discovery trip list stays,
										// but its count for THIS trip is corrected from the
										// complete scoped response.
										if (truncated) {
											birdsExactCounts = { ...birdsExactCounts, [scopedTrip]: -1 };
											itinBirdsMsg =
												'This trip alone has more places than one fetch can carry — its import cannot be complete.';
											if (ownsPanel) {
												itinCandidates = [];
												birdsCommittedTrip = scopedTrip;
											} else {
												// Revert the dropdown so choosing this trip later
												// is a real change event.
												itinBirdsSelectedTrip = birdsCommittedTrip;
											}
										} else {
											// Cache the complete payload regardless of panel
											// ownership so the trip is loadable later without a
											// refetch.
											birdsScopedCache = {
												...birdsScopedCache,
												[birdsCacheKey(scopedTrip)]: raw
											};
											const summary = trips.find((t) => String(t.id) === scopedTrip);
											if (summary) {
												birdsExactCounts = {
													...birdsExactCounts,
													[scopedTrip]: summary.placeCount
												};
												// Manual-id path: a trip the truncated discovery
												// never listed becomes selectable once fetched.
												if (!itinBirdsTrips.some((t) => String(t.id) === scopedTrip)) {
													itinBirdsTrips = [...itinBirdsTrips, summary];
												}
											}
											if (ownsPanel) {
												itinBirdsSelectedTrip = scopedTrip;
												birdsCommittedTrip = scopedTrip;
												itinGeocode = false;
												itinCandidates = withItinSelection(raw);
												itinBirdsMsg = birdsSummaryMsg(raw);
											} else {
												// Never leave a finished request labeled as
												// fetching, and never steal the panel. REVERT the
												// dropdown to the committed selection: the bind
												// already moved it to the fetched trip before
												// onchange fired, so without the revert,
												// "select it in the dropdown" would re-select the
												// same option and fire no change event (peer
												// CODEX, browser QA). The payload is cached —
												// choosing the trip loads it instantly.
												itinBirdsSelectedTrip = birdsCommittedTrip;
												itinBirdsMsg =
													'Trip fetched — select it in the Trip dropdown to load its places.';
											}
										}
									} else {
										itinBirdsRaw = raw;
										itinBirdsTrips = trips;
										itinBirdsTruncated = truncated;
										itinBirdsSelectedTrip = '';
										if (ownsPanel) {
											itinGeocode = false;
											applyBirdsTripFilter();
										} else {
											itinBirdsMsg = `${trips.length} Birds trip${trips.length === 1 ? '' : 's'} fetched — pick one to load its places.`;
										}
									}
								} else if (result.type === 'failure') {
									// A failed scoped request also reverts the dropdown, so
									// retrying by selecting the trip again is a real change.
									if (scoped) itinBirdsSelectedTrip = birdsCommittedTrip;
									itinBirdsMsg =
										(result.data as { error?: string })?.error ?? 'Birds import failed.';
								} else {
									if (scoped) itinBirdsSelectedTrip = birdsCommittedTrip;
									itinBirdsMsg = 'Birds import failed.';
								}
							};
						}}
					>
						<input
							name="username"
							bind:value={itinBirdsUsername}
							oninput={onBirdsUsernameInput}
							placeholder="Birds username (optional)"
						/>
						<input type="hidden" name="birds_trip_id" bind:this={birdsTripInputEl} />
						<button class="btn small" type="submit" disabled={itinBirdsFetching}>
							{itinBirdsFetching ? 'Fetching...' : 'Fetch Birds places'}
						</button>
					</form>
					{#if itinBirdsTrips.length > 0}
						<label class="birds-trip-filter">
							Trip
							<select
								bind:value={itinBirdsSelectedTrip}
								onchange={onBirdsTripChange}
								disabled={itinBirdsFetching}
							>
								<option value="">
									All trips ({itinBirdsRaw.length}{itinBirdsTruncated ? '+' : ''})
								</option>
								{#each itinBirdsTrips as t (t.id)}
									<option value={String(t.id)}>
										{t.name}{t.start_date ? ` — ${t.start_date}` : ''} ({birdsCountLabel(t)})
									</option>
								{/each}
							</select>
						</label>
						{#if itinBirdsTruncated}
							<div class="birds-manual-id">
								<input
									inputmode="numeric"
									bind:value={birdsManualTripId}
									placeholder="Trip id not listed above?"
									aria-label="Birds trip id"
								/>
								<button
									type="button"
									class="btn small"
									onclick={fetchBirdsManualTrip}
									disabled={itinBirdsFetching || !birdsManualTripId.trim()}
								>
									Fetch trip
								</button>
							</div>
						{/if}
					{/if}
					{#if itinBirdsMsg}<p class="extract-msg">{itinBirdsMsg}</p>{/if}
				</div>
			</details>
			<details
				class="paste"
				ontoggle={(e) => {
					if ((e.currentTarget as HTMLDetailsElement).open) {
						const zone = (e.currentTarget as HTMLElement).querySelector(
							'.photo-drop'
						) as HTMLElement | null;
						zone?.focus();
					}
				}}
			>
				<summary>Import from photo</summary>
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="extract photo-drop"
					tabindex="-1"
					onpaste={(e) => {
						const items = e.clipboardData?.items;
						if (!items) return;
						for (const item of items) {
							if (item.type.startsWith('image/')) {
								e.preventDefault();
								const file = item.getAsFile();
								if (!file) return;
								itinImageFile = file;
								itinImagePasted = true;
								const dt = new DataTransfer();
								dt.items.add(file);
								const input = (e.currentTarget as HTMLElement).querySelector(
									'input[type="file"]'
								) as HTMLInputElement | null;
								if (input) input.files = dt.files;
								return;
							}
						}
					}}
				>
					<p class="extract-head">
						Upload or paste (⌘V) a photo and the AI will identify the place.
					</p>
					<form
						method="POST"
						action="?/itin-extract-image"
						enctype="multipart/form-data"
						class="extract-form"
						use:enhance={() => {
							const panelGen = claimAndClearCandidatePanel();
							itinImageExtracting = true;
							itinImageMsg = '';
							return async ({ result }) => {
								itinImageExtracting = false;
								if (panelGen !== candPanelGen) return; // a newer source owns the panel
								if (result.type === 'success' && result.data?.ok) {
									const raw = (result.data as { candidates?: ItinCandidateRaw[] }).candidates ?? [];
									itinCandidates = withItinSelection(raw);
									if (raw.length === 0) {
										itinImageMsg = 'Could not identify a place in this photo.';
									} else {
										const dupes = raw.filter((c) => c.duplicate).length;
										itinImageMsg = `${raw.length} place${raw.length === 1 ? '' : 's'} identified${dupes ? `, ${dupes} possible duplicate${dupes === 1 ? '' : 's'}` : ''}.`;
									}
								} else if (result.type === 'failure') {
									itinImageMsg = (result.data as { error?: string })?.error ?? 'Extraction failed.';
								} else {
									itinImageMsg = 'Extraction failed.';
								}
							};
						}}
					>
						<input
							type="file"
							name="image"
							accept="image/jpeg,image/png,image/webp,image/heic,.jpg,.jpeg,.png,.webp,.heic"
							onchange={(e) => {
								itinImageFile = (e.currentTarget as HTMLInputElement).files?.[0] ?? null;
								itinImagePasted = false;
							}}
						/>
						<button
							class="btn small"
							type="submit"
							disabled={itinImageExtracting || !itinImageFile}
						>
							{itinImageExtracting ? 'Identifying...' : 'Identify place'}
						</button>
					</form>
					{#if itinImagePasted && itinImageFile}
						<p class="extract-msg">
							Pasted image ready ({Math.round(itinImageFile.size / 1024)} KB)
						</p>
					{/if}
					{#if itinImageMsg}<p class="extract-msg">{itinImageMsg}</p>{/if}
				</div>
			</details>
			{#if itinCandidates.length > 0}
				<div class="candidates itinerary-candidates">
					<!-- The whole review panel locks while an import is in flight: the
					     import posts a SNAPSHOT, so any edit made after clicking
					     Import would be silently discarded when success clears the
					     panel (peer CODEX, round 4). A fieldset disables every
					     descendant control natively. -->
					<fieldset class="cand-lock" disabled={itinImporting}>
					<div class="import-target">
						<label class="import-parent">
							Import under
							<SearchableSelect
								name="itin-import-parent"
								bind:selectedValue={itinImportParentId}
								options={itinImportParentOptions}
								ariaLabel="Import under"
								placeholder="Search parent"
								maxResults={500}
								listboxId="itin-import-parent-options"
							/>
						</label>
						<label class="extract-opt">
							<input type="checkbox" bind:checked={itinGeocode} />
							Geocode places
						</label>
					</div>
					<div class="cand-list">
						{@render itineraryCandidateRows(itinCandidates, 0)}
					</div>
					<div class="cand-actions">
						<button class="btn small" type="button" onclick={() => selectAllItin(true)}>
							Select all
						</button>
						<button class="btn small" type="button" onclick={() => selectAllItin(false)}>
							Select none
						</button>
						<button
							class="btn small primary"
							type="button"
							onclick={importSelectedItinerary}
							disabled={itinImporting ||
								selectedItinCount() === 0 ||
								selectedItinCount() > MAX_IMPORT_ITEMS}
						>
							{itinImporting
								? 'Importing...'
								: `Import ${selectedItinCount()} item${selectedItinCount() === 1 ? '' : 's'}`}
						</button>
						{#if selectedItinCount() > MAX_IMPORT_ITEMS}
							<p class="field-error" role="alert">
								One import is limited to {MAX_IMPORT_ITEMS} items — narrow the selection
								(e.g. pick a single trip) and import in batches.
							</p>
						{/if}
						<button
							class="btn small"
							type="button"
							onclick={() => {
								claimAndClearCandidatePanel(null);
								itinExtractMsg = '';
								itinUrlMsg = '';
								itinImageMsg = '';
								itinBirdsMsg = '';
							}}>Clear</button
						>
					</div>
					</fieldset>
				</div>
			{/if}
		{/if}
	</div>
</div>

<!-- ── PACKING ────────────────────────────────────────── -->
<div class="card packing-card">
	<div class="section-header">
		<button class="section-toggle" type="button" onclick={() => toggleSection('packing')}>
			<span class="section-caret">{sectionCollapsed('packing') ? '▸' : '▾'}</span>
			<h2>Packing</h2>
		</button>
		<a class="btn small packing-print-btn" href={packingPrintHref}>🖨 Print packing</a>
	</div>
	<div class="fold" class:folded={sectionCollapsed('packing')}>
		{#each data.packing as { list, rows, total, checked } (list.id)}
			{@const packHidden = hiddenIds(rows, packCollapsed)}
			{@const packParents = parentIds(rows)}
			{@const packStats = leafStats(rows)}
			<section class="plist">
				<div class="plist-head">
					<strong>{list.name}</strong>
					<span class="muted">{checked} / {total} packed</span>
					{#if packParents.size > 0}
						<button type="button" class="linkbtn" onclick={() => collapsePack(rows)}
							>Collapse all</button
						>
						<span class="sep" aria-hidden="true">·</span>
						<button type="button" class="linkbtn" onclick={() => expandPack(rows)}
							>Expand all</button
						>
					{/if}
					{#if !isViewer}
						<button
							class="del"
							type="button"
							title="delete list"
							onclick={() =>
								(pendingDelete = {
									action: 'list-delete',
									fields: { list_id: list.id },
									heading: 'Delete this packing list?',
									body: `"${list.name}" and all ${total} item${total === 1 ? '' : 's'} in it will be permanently removed.`,
									confirmLabel: 'Delete list'
								})}>✕ list</button
						>
					{/if}
				</div>
				{#if total > 0}
					<div class="progress">
						<span style="width: {Math.round((checked / total) * 100)}%"></span>
					</div>
				{/if}

				<ul class="outline">
					{#each rows as { node, depth } (node.id)}
							{#if !isViewer && !packHidden.has(node.id) && isInserting(node.id, 'above')}{@render packInsertForm(
									list.id,
									node.id,
									'above',
									depth
								)}{/if}
							<li
								style="padding-left: {depth * 22}px"
								class:folded={packHidden.has(node.id)}
								class:drop-before={dropTarget?.id === node.id && dropTarget?.pos === 'before'}
								class:drop-after={dropTarget?.id === node.id && dropTarget?.pos === 'after'}
								ondragover={(e) => onRowDragOver(e, list.id, node.id)}
								ondrop={() => onRowDrop(list.id, rows)}
							>
								<div class="line pack-line">
									<div class="pack-main">
										{#if !isViewer}
											<span
												class="drag-handle"
												title="drag to reorder"
												draggable="true"
												ondragstart={() => {
													dragId = node.id;
													dragListId = list.id;
												}}
												ondragend={() => {
													dragId = null;
													dragListId = null;
													dropTarget = null;
												}}
												role="button"
												tabindex="-1"
												aria-label="drag to reorder">⠿</span
											>
										{/if}
										{#if packParents.has(node.id)}
											<button
												class="caret"
												type="button"
												aria-expanded={!packCollapsed.has(node.id)}
												aria-label={packCollapsed.has(node.id) ? 'Expand' : 'Collapse'}
												onclick={() => togglePack(node.id)}
												>{packCollapsed.has(node.id) ? '▸' : '▾'}</button
											>
										{:else}
											<span class="caret-spacer" aria-hidden="true"></span>
										{/if}
										<label class="chk-hit">
											<input
												type="checkbox"
												class="chk"
												checked={packChecked(packStats.get(node.id))}
												indeterminate={packIndeterminate(packStats.get(node.id))}
												aria-label="packed"
												onchange={(e) => toggleCheck(node.id, e.currentTarget.checked)}
											/>
										</label>
										<span class="grow" class:done={packChecked(packStats.get(node.id))}>
											{node.name}{#if node.quantity > 1}<span class="muted">
													×{node.quantity}</span
												>{/if}
											{#if node.notes}<div class="meta note">{node.notes}</div>{/if}
										</span>
									</div>
									{#if !isViewer}
										<div class="pack-controls">
											<span class="insert-controls">
												<button
													type="button"
													title="insert above"
													onclick={() => openInsert(node.id, 'above')}>＋↑</button
												>
												<button
													type="button"
													title="insert below"
													onclick={() => openInsert(node.id, 'below')}>＋↓</button
												>
											</span>
											{@render treeControls(
												node.id,
												'pack-move',
												'pack-delete',
												list.id,
												node.name,
												rows.some((r) => r.node.parent_id === node.id)
											)}
										</div>
									{/if}
								</div>
								{#if !isViewer}
									<details class="edit" style="padding-left: {depth * 22 + 26}px">
										<summary>edit</summary>
										<form
											method="POST"
											action="?/pack-edit"
											use:enhance={() => {
												return async ({ update }) => {
													await update({ reset: false });
												};
											}}
											class="edit-form"
										>
											<input type="hidden" name="id" value={node.id} />
											<input type="hidden" name="list_id" value={list.id} />
											<input type="hidden" name="category" value={node.category ?? ''} />
											<input name="name" value={node.name} placeholder="Name" required />
											<input
												name="quantity"
												type="number"
												min="1"
												value={node.quantity}
												class="qty"
												aria-label="quantity"
											/>
											<textarea name="notes" rows="2" placeholder="Notes"
												>{node.notes ?? ''}</textarea
											>
											<button class="btn small primary" type="submit">Save</button>
										</form>
									</details>
								{/if}
							</li>
							{#if !isViewer && !packHidden.has(node.id) && isInserting(node.id, 'below')}{@render packInsertForm(
									list.id,
									node.id,
									'below',
									depth
								)}{/if}
					{/each}
				</ul>

				{#if !isViewer}
					<form method="POST" action="?/pack-add" use:enhance class="add-row">
						<input type="hidden" name="list_id" value={list.id} />
						<input name="name" placeholder="Add item…" required />
						<input
							name="quantity"
							type="number"
							min="1"
							value="1"
							class="qty"
							aria-label="quantity"
						/>
						<button class="btn small primary" type="submit">Add</button>
					</form>
					<details class="paste">
						<summary>Paste many · save as template</summary>
						<form method="POST" action="?/pack-paste" use:enhance>
							<input type="hidden" name="list_id" value={list.id} />
							<textarea name="text" rows="3" placeholder="Socks&#10;Charger&#10;…"></textarea>
							<button class="btn small" type="submit">Add all</button>
						</form>
						<form method="POST" action="?/tmpl-save" use:enhance class="add-row">
							<input type="hidden" name="list_id" value={list.id} />
							<input name="name" placeholder="Template name" required />
							<button class="btn small" type="submit">Save as template</button>
						</form>
					</details>
				{/if}
			</section>
		{/each}

		{#if !isViewer}
			<form method="POST" action="?/list-add" use:enhance class="add-row">
				<input name="name" placeholder="New packing list name" />
				<button class="btn small primary" type="submit">Add list</button>
			</form>

			<div class="templates">
				{#if data.templates.length === 0}
					<form method="POST" action="?/tmpl-seed" use:enhance class="inline">
						<button class="btn small" type="submit">Add starter "Essentials" template</button>
					</form>
				{:else}
					<span class="muted">Apply a template:</span>
					{#each data.templates as t (t.id)}
						<span class="tmpl-chip">
							<form method="POST" action="?/tmpl-apply" use:enhance class="inline">
								<input type="hidden" name="template_id" value={t.id} />
								<button class="btn small" type="submit">{t.name} ({t.item_count})</button>
							</form>
							{#if !isViewer}
								<button
									type="button"
									class="del"
									title="delete template"
									onclick={() =>
										(pendingDelete = {
											action: 'tmpl-delete',
											fields: { template_id: t.id },
											heading: 'Delete this template?',
											body: `"${t.name}" will be permanently removed. Packing lists already created from it are not affected.`,
											confirmLabel: 'Delete'
										})}>✕</button
								>
							{/if}
						</span>
					{/each}
				{/if}
			</div>
		{/if}
	</div>
</div>

<!-- ── RESERVATIONS ───────────────────────────────────── -->
<div class="card">
	<button class="section-toggle" type="button" onclick={() => toggleSection('reservations')}>
		<span class="section-caret">{sectionCollapsed('reservations') ? '▸' : '▾'}</span>
		<h2>Reservations</h2>
	</button>
	<div class="fold" class:folded={sectionCollapsed('reservations')}>
		{#if data.reservations.length === 0}
			<p class="muted">No reservations yet.</p>
		{:else}
			<ul class="outline">
				{#each data.reservations as r (r.id)}
					<li>
						<div class="res-row">
							<div class="res-header">
								<span class="badge need">{r.reservation_type}</span>
								{#if !isViewer}
									<span class="res-controls">
										{#each ['up', 'down'] as dir}
											<form method="POST" action="?/res-move" use:enhance>
												<input type="hidden" name="id" value={r.id} />
												<input type="hidden" name="direction" value={dir} />
												<button type="submit" title="move {dir}">{dir === 'up' ? '↑' : '↓'}</button>
											</form>
										{/each}
										<button
											type="button"
											class="del"
											title="delete"
											onclick={() =>
												(pendingDelete = {
													action: 'res-delete',
													fields: { id: r.id },
													heading: 'Delete this reservation?',
													body: `"${r.title}" will be permanently removed.`,
													confirmLabel: 'Delete'
												})}>✕</button
										>
									</span>
								{/if}
							</div>
							<span class="ttl">{r.title}</span>
							<div class="meta">
								{#if r.confirmation_code}Conf: {r.confirmation_code} ·
								{/if}
								{#if r.status}{r.status} ·
								{/if}
								{#if r.start_at}{fmtDateTime(r.start_at)}{/if}
								{#if r.end_at}
									→ {fmtDateTime(r.end_at)}{/if}
							</div>
							{#if r.notes}
								<details class="res-notes">
									<summary>Show details</summary>
									<pre class="res-notes-body">{r.notes}</pre>
								</details>
							{/if}
						</div>
						{#if !isViewer}
							<details class="edit">
								<summary>edit</summary>
								<form method="POST" action="?/res-edit" use:enhance class="edit-form">
									<input type="hidden" name="id" value={r.id} />
									<select name="reservation_type" aria-label="type">
										{#each ['accommodation', 'flight', 'restaurant', 'transport', 'other'] as t (t)}
											<option value={t} selected={r.reservation_type === t}>{t}</option>
										{/each}
									</select>
									<input name="title" value={r.title} placeholder="Title" />
									<input
										name="confirmation_code"
										value={r.confirmation_code ?? ''}
										placeholder="Confirmation code"
									/>
									<input name="status" value={r.status ?? ''} placeholder="Status" />
									<label class="dt"
										>Start <input
											type="datetime-local"
											name="start_at"
											value={r.start_at ?? ''}
										/></label
									>
									<label class="dt"
										>End <input type="datetime-local" name="end_at" value={r.end_at ?? ''} /></label
									>
									<textarea name="notes" rows="2" placeholder="Notes">{r.notes ?? ''}</textarea>
									<button class="btn small primary" type="submit">Save</button>
								</form>
							</details>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}

		{#if !isViewer}
			<details class="paste">
				<summary>Add reservation</summary>

				<div class="extract">
					<p class="extract-head">Auto-fill from a confirmation (then review below)</p>
					<form
						method="POST"
						action="?/res-extract"
						class="extract-form"
						use:enhance={() => {
							extracting = true;
							extractMsg = '';
							return async ({ result }) => {
								extracting = false;
								if (result.type === 'success' && result.data?.ok) {
									applyExtract((result.data as { fields?: Record<string, unknown> }).fields ?? {});
									extractMsg = 'Filled from the email — review and edit, then Add reservation.';
								} else if (result.type === 'failure') {
									extractMsg = (result.data as { error?: string })?.error ?? 'Extraction failed.';
								} else {
									extractMsg = 'Extraction failed.';
								}
							};
						}}
					>
						<input type="hidden" name="source" value="text" />
						<textarea
							name="text"
							rows="3"
							bind:value={extractText}
							placeholder="Paste a confirmation email here…"
						></textarea>
						<button class="btn small" type="submit" disabled={extracting || !extractText.trim()}>
							{extracting ? 'Extracting…' : 'Extract from text'}
						</button>
					</form>

					{#if extractableDocs.length > 0}
						<form
							method="POST"
							action="?/res-extract"
							class="extract-form"
							use:enhance={() => {
								extracting = true;
								extractMsg = '';
								return async ({ result }) => {
									extracting = false;
									if (result.type === 'success' && result.data?.ok) {
										applyExtract(
											(result.data as { fields?: Record<string, unknown> }).fields ?? {}
										);
										extractMsg =
											'Filled from the document — review and edit, then Add reservation.';
									} else if (result.type === 'failure') {
										extractMsg = (result.data as { error?: string })?.error ?? 'Extraction failed.';
									} else {
										extractMsg = 'Extraction failed.';
									}
								};
							}}
						>
							<input type="hidden" name="source" value="document" />
							<select name="attachment_id" bind:value={extractDocId} aria-label="document">
								<option value="" disabled>Choose a document…</option>
								{#each extractableDocs as a (a.id)}
									<option value={a.id}>{a.original_name}</option>
								{/each}
							</select>
							<button class="btn small" type="submit" disabled={extracting || !extractDocId}>
								{extracting ? 'Extracting…' : 'Extract from document'}
							</button>
						</form>
					{/if}
					{#if extractMsg}<p class="extract-msg">{extractMsg}</p>{/if}
				</div>

				<form
					method="POST"
					action="?/res-add"
					class="edit-form"
					use:enhance={() => {
						return async ({ result, update }) => {
							if (result.type === 'success') {
								resDraft = emptyResDraft();
								extractText = '';
								extractDocId = '';
								extractMsg = '';
							}
							await update();
						};
					}}
				>
					<select name="reservation_type" aria-label="type" bind:value={resDraft.reservation_type}>
						{#each ['accommodation', 'flight', 'restaurant', 'transport', 'other'] as t (t)}
							<option value={t}>{t}</option>
						{/each}
					</select>
					<input
						name="title"
						placeholder="Title (e.g. Hôtel d'Europe)"
						required
						bind:value={resDraft.title}
					/>
					<input
						name="confirmation_code"
						placeholder="Confirmation code"
						bind:value={resDraft.confirmation_code}
					/>
					<input name="status" placeholder="Status" bind:value={resDraft.status} />
					<label class="dt"
						>Start <input
							type="datetime-local"
							name="start_at"
							bind:value={resDraft.start_at}
						/></label
					>
					<label class="dt"
						>End <input type="datetime-local" name="end_at" bind:value={resDraft.end_at} /></label
					>
					<textarea name="notes" rows="2" placeholder="Notes" bind:value={resDraft.notes}
					></textarea>
					<button class="btn small primary" type="submit">Add reservation</button>
				</form>
			</details>
		{/if}
	</div>
</div>

<!-- ── ATTACHMENTS ────────────────────────────────────── -->
<div class="card">
	<button class="section-toggle" type="button" onclick={() => toggleSection('documents')}>
		<span class="section-caret">{sectionCollapsed('documents') ? '▸' : '▾'}</span>
		<h2>Documents</h2>
	</button>
	<div class="fold" class:folded={sectionCollapsed('documents')}>
		{#if data.attachments.length === 0}
			<p class="muted">No documents yet.</p>
		{:else}
			<ul class="outline">
				{#each data.attachments as a (a.id)}
					<li>
						<div class="line">
							<span class="grow">
								{#if a.kind === 'text'}
									<details class="textdoc">
										<summary class="ttl">{a.display_name || a.original_name}</summary>
										<pre class="textdoc-body">{a.text_content}</pre>
									</details>
									<div class="meta">text · {fmtSize(a.size_bytes)}</div>
								{:else}
									<span class="ttl">{a.display_name || a.original_name}</span>
									<div class="meta doc-links">
										{a.mime_type} · {fmtSize(a.size_bytes)}
										<a class="chip-link" href="/trips/{data.trip.id}/attachments/{a.id}/view"
											>View</a
										>
										<AttachmentDownloadButton
											class="chip-link"
											url={`/trips/${data.trip.id}/attachments/${a.id}`}
											filename={a.original_name}
											mimeType={a.mime_type}
										/>
									</div>
								{/if}
							</span>
							{#if !isViewer}
								<button
									type="button"
									class="del"
									title="delete"
									onclick={() =>
										(pendingDelete = {
											action: 'attach-delete',
											fields: { id: a.id },
											heading: 'Delete this document?',
											body: `"${a.display_name || a.original_name}" will be permanently removed from storage.`,
											confirmLabel: 'Delete'
										})}>✕</button
								>
							{/if}
						</div>
						{#if !isViewer}
							<details class="edit">
								<summary>edit</summary>
								<form
									method="POST"
									action="?/attach-rename"
									use:enhance={() => {
										return async ({ update }) => {
											await update({ reset: false });
										};
									}}
									class="edit-form"
								>
									<input type="hidden" name="id" value={a.id} />
									<input
										name="display_name"
										value={a.display_name ?? ''}
										placeholder="Display name (optional)"
									/>
									<button class="btn small primary" type="submit">Save</button>
								</form>
							</details>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}

		{#if !isViewer}
			<form
				method="POST"
				action="?/attach-upload"
				use:enhance
				enctype="multipart/form-data"
				class="add-row upload-row"
			>
				<input name="display_name" placeholder="Label (optional)" />
				<input type="file" name="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif" required />
				<button class="btn small primary" type="submit">Upload</button>
			</form>
			<p class="muted" style="font-size: 0.78rem">PDF or image, up to 30 MB. Stored privately.</p>
			<details class="paste">
				<summary>Paste text instead</summary>
				<form method="POST" action="?/doc-text-add" use:enhance class="add-row textdoc-form">
					<input name="title" placeholder="Title (e.g. Hotel confirmation email)" />
					<textarea name="text" rows="4" placeholder="Paste an email body or any note…" required
					></textarea>
					<button class="btn small primary" type="submit">Save text</button>
				</form>
				<p class="muted" style="font-size: 0.78rem">
					Saved as a searchable note — no file needed. Good for confirmation emails on a phone.
				</p>
			</details>
		{/if}
	</div>
</div>

<!-- ── EXPENSES ──────────────────────────────────────── -->
<div class="card">
	<button class="section-toggle" type="button" onclick={() => toggleSection('expenses')}>
		<span class="section-caret">{sectionCollapsed('expenses') ? '▸' : '▾'}</span>
		<h2>Expenses</h2>
		<span class="expense-total">{fmtAmount(expenseTotal)}</span>
	</button>
	<div class="fold" class:folded={sectionCollapsed('expenses')}>
		{#if data.expenses.length === 0}
			<p class="muted">No expenses yet.</p>
		{:else}
			<ul class="outline">
				{#each data.expenses as e (e.id)}
					<li>
						<div class="exp-row">
							<div class="exp-main">
								<span class="badge need">{e.category}</span>
								<div class="exp-desc">{e.description}</div>
								<div class="meta">
									{#if e.expense_date}{new Date(e.expense_date + 'T00:00').toLocaleDateString(
											'en-US',
											{ month: 'short', day: 'numeric' }
										)}{/if}
									{#if e.notes}
										· {e.notes}{/if}
								</div>
								{#if e.attachment_id}
									{@const att = data.attachments.find((a) => a.id === e.attachment_id)}
									{#if att}
										<a class="exp-doc-link" href="/trips/{data.trip.id}/attachments/{att.id}/view">
											{att.display_name || att.original_name}
										</a>
									{/if}
								{/if}
							</div>
							<span class="exp-amount">{fmtAmount(e.amount_cents)}</span>
							{#if !isViewer}
								<span class="exp-controls">
									{#each ['up', 'down'] as dir}
										<form method="POST" action="?/exp-move" use:enhance>
											<input type="hidden" name="id" value={e.id} />
											<input type="hidden" name="direction" value={dir} />
											<button type="submit" title="move {dir}">{dir === 'up' ? '↑' : '↓'}</button>
										</form>
									{/each}
									<button
										type="button"
										class="del"
										title="delete"
										onclick={() =>
											(pendingDelete = {
												action: 'exp-delete',
												fields: { id: e.id },
												heading: 'Delete this expense?',
												body: `"${e.description}" will be permanently removed.`,
												confirmLabel: 'Delete'
											})}>✕</button
									>
								</span>
							{/if}
						</div>
						{#if !isViewer}
							<details class="edit">
								<summary>edit</summary>
								<form method="POST" action="?/exp-edit" use:enhance class="edit-form">
									<input type="hidden" name="id" value={e.id} />
									<div class="form-row">
										<input type="date" name="expense_date" value={e.expense_date ?? ''} />
										<select name="category" aria-label="category">
											{#each ['lodging', 'food', 'transport', 'activities', 'other'] as c (c)}
												<option value={c} selected={e.category === c}>{c}</option>
											{/each}
										</select>
									</div>
									<input
										name="description"
										value={e.description}
										placeholder="Description"
										required
									/>
									<div class="form-row">
										<input
											name="amount"
											value={(e.amount_cents / 100).toFixed(2)}
											placeholder="$0.00"
											inputmode="decimal"
										/>
										<select name="attachment_id" aria-label="linked document">
											<option value="">Link document (optional)</option>
											{#each data.attachments as a (a.id)}
												<option value={a.id} selected={e.attachment_id === a.id}
													>{a.display_name || a.original_name}</option
												>
											{/each}
										</select>
									</div>
									<textarea name="notes" rows="1" placeholder="Notes (optional)"
										>{e.notes ?? ''}</textarea
									>
									<button class="btn small primary" type="submit">Save</button>
								</form>
							</details>
						{/if}
					</li>
				{/each}
			</ul>

			{@const catTotals = data.expenses.reduce(
				(acc: Record<string, number>, e: { category: string; amount_cents: number }) => {
					acc[e.category] = (acc[e.category] ?? 0) + e.amount_cents;
					return acc;
				},
				{} as Record<string, number>
			)}
			{#if Object.keys(catTotals).length > 1}
				<div class="cat-subtotals">
					{#each Object.entries(catTotals) as [cat, cents]}
						<span class="cat-sub"
							><span class="badge need">{cat}</span> {fmtAmount(cents as number)}</span
						>
					{/each}
				</div>
			{/if}

			<div class="exp-total-row">
				<span>Total</span>
				<span class="exp-amount">{fmtAmount(expenseTotal)}</span>
			</div>
		{/if}

		{#if !isViewer}
			<details class="paste">
				<summary>Add expense</summary>

				<div class="extract">
					<p class="extract-head">Extract from a bank statement or receipt</p>
					<form
						method="POST"
						action="?/exp-extract"
						class="extract-form"
						use:enhance={() => {
							expExtracting = true;
							expExtractMsg = '';
							return async ({ result }) => {
								expExtracting = false;
								if (result.type === 'success' && result.data?.ok) {
									const raw =
										(
											result.data as {
												candidates?: Array<{
													expense_date: string | null;
													description: string;
													amount: number;
													category: string | null;
													notes: string | null;
												}>;
											}
										).candidates ?? [];
									expCandidates = raw.map((c) => ({ ...c, selected: true }));
									if (raw.length === 0) {
										expExtractMsg = 'No transactions found in the text.';
									} else {
										expExtractMsg = `${raw.length} transaction${raw.length > 1 ? 's' : ''} found — review below.`;
									}
								} else if (result.type === 'failure') {
									expExtractMsg =
										(result.data as { error?: string })?.error ?? 'Extraction failed.';
								} else {
									expExtractMsg = 'Extraction failed.';
								}
							};
						}}
					>
						<input type="hidden" name="source" value="text" />
						<textarea
							name="text"
							rows="4"
							bind:value={expExtractText}
							placeholder="Paste bank statement text, credit card transactions, or a receipt..."
						></textarea>
						<div class="extract-actions">
							<button
								class="btn small"
								type="submit"
								disabled={expExtracting || !expExtractText.trim()}
							>
								{expExtracting ? 'Extracting...' : 'Extract expenses'}
							</button>
							<label class="extract-opt">
								<input type="checkbox" bind:checked={expSaveTextAsDoc} />
								Also save text as document
							</label>
						</div>
					</form>

					{#if extractableDocs.length > 0}
						<form
							method="POST"
							action="?/exp-extract"
							class="extract-form"
							use:enhance={() => {
								expExtracting = true;
								expExtractMsg = '';
								return async ({ result }) => {
									expExtracting = false;
									if (result.type === 'success' && result.data?.ok) {
										const raw =
											(
												result.data as {
													candidates?: Array<{
														expense_date: string | null;
														description: string;
														amount: number;
														category: string | null;
														notes: string | null;
													}>;
												}
											).candidates ?? [];
										expCandidates = raw.map((c) => ({ ...c, selected: true }));
										if (raw.length === 0) {
											expExtractMsg = 'No transactions found in the document.';
										} else {
											expExtractMsg = `${raw.length} transaction${raw.length > 1 ? 's' : ''} found — review below.`;
										}
									} else if (result.type === 'failure') {
										expExtractMsg =
											(result.data as { error?: string })?.error ?? 'Extraction failed.';
									} else {
										expExtractMsg = 'Extraction failed.';
									}
								};
							}}
						>
							<input type="hidden" name="source" value="document" />
							<select name="attachment_id" bind:value={expExtractDocId} aria-label="document">
								<option value="" disabled>Choose a document...</option>
								{#each extractableDocs as a (a.id)}
									<option value={a.id}>{a.display_name || a.original_name}</option>
								{/each}
							</select>
							<button class="btn small" type="submit" disabled={expExtracting || !expExtractDocId}>
								{expExtracting ? 'Extracting...' : 'Extract from document'}
							</button>
						</form>
					{/if}
					{#if expExtractMsg}<p class="extract-msg">{expExtractMsg}</p>{/if}
				</div>

				{#if expCandidates.length > 0}
					<div class="candidates">
						<div class="cand-list">
							{#each expCandidates as c, i}
								<div class="cand-row">
									<input type="checkbox" bind:checked={c.selected} />
									<span class="cand-date">{c.expense_date ?? '--'}</span>
									<span class="cand-desc">{c.description}</span>
									<span class="cand-amount">${c.amount.toFixed(2)}</span>
									<select bind:value={c.category} class="cand-cat" aria-label="category">
										{#each ['lodging', 'food', 'transport', 'activities', 'other'] as cat (cat)}
											<option value={cat}>{cat}</option>
										{/each}
									</select>
								</div>
							{/each}
						</div>
						<div class="cand-actions">
							<button
								class="btn small"
								type="button"
								onclick={() => expCandidates.forEach((c) => (c.selected = true))}>Select all</button
							>
							<button
								class="btn small"
								type="button"
								onclick={() => expCandidates.forEach((c) => (c.selected = false))}
								>Select none</button
							>
							<button
								class="btn small primary"
								type="button"
								onclick={addSelectedExpenses}
								disabled={!expCandidates.some((c) => c.selected)}
							>
								Add {expCandidates.filter((c) => c.selected).length} expense{expCandidates.filter(
									(c) => c.selected
								).length !== 1
									? 's'
									: ''}
							</button>
							<button
								class="btn small"
								type="button"
								onclick={() => {
									expCandidates = [];
									expExtractMsg = '';
								}}>Clear</button
							>
						</div>
					</div>
				{/if}

				<form
					method="POST"
					action="?/exp-add"
					class="edit-form"
					use:enhance={() => {
						return async ({ result, update }) => {
							if (result.type === 'success') {
								expDraft = emptyExpDraft();
							}
							await update();
						};
					}}
				>
					<p class="extract-head" style="margin-top: 8px">Or add manually</p>
					<div class="form-row">
						<input type="date" name="expense_date" bind:value={expDraft.expense_date} />
						<select name="category" aria-label="category" bind:value={expDraft.category}>
							{#each ['lodging', 'food', 'transport', 'activities', 'other'] as c (c)}
								<option value={c}>{c}</option>
							{/each}
						</select>
					</div>
					<input
						name="description"
						placeholder="Description (required)"
						required
						bind:value={expDraft.description}
					/>
					<div class="form-row">
						<input
							name="amount"
							placeholder="$0.00"
							inputmode="decimal"
							required
							bind:value={expDraft.amount}
						/>
						<select
							name="attachment_id"
							aria-label="linked document"
							bind:value={expDraft.attachment_id}
						>
							<option value="">Link document (optional)</option>
							{#each data.attachments as a (a.id)}
								<option value={a.id}>{a.display_name || a.original_name}</option>
							{/each}
						</select>
					</div>
					<textarea name="notes" rows="1" placeholder="Notes (optional)" bind:value={expDraft.notes}
					></textarea>
					<button class="btn small primary" type="submit">Add expense</button>
				</form>
			</details>
		{/if}
	</div>
</div>

<!-- ── Trip actions ───────────────────────────────────── -->
{#if !isViewer}
	<div class="form-actions">
		<a class="btn" href="/trips/{data.trip.id}/edit">Edit trip</a>
		<form method="POST" action="?/duplicate" use:enhance class="inline">
			<input type="hidden" name="client_time_zone" value={localTimeZone} />
			<button class="btn" type="submit">Duplicate</button>
		</form>
		<!-- Reversible, so no confirm modal (house rule reserves those for
		     destructive actions). -->
		<form method="POST" action="?/archive" use:enhance class="inline">
			<input type="hidden" name="archived" value={data.trip.archived_at ? 'false' : 'true'} />
			<button class="btn" type="submit">
				{data.trip.archived_at ? 'Unarchive' : 'Archive'}
			</button>
		</form>
		<button
			class="btn danger"
			type="button"
			onclick={() =>
				(pendingDelete = {
					action: 'delete',
					fields: {},
					heading: 'Delete this trip?',
					body: `"${data.trip.name}" and everything in it will be permanently removed.`,
					confirmLabel: 'Delete trip'
				})}>Delete</button
		>
	</div>

	<div class="modal-overlay" class:open={pendingDelete !== null}>
		{#if pendingDelete}
			<div class="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-del-title">
				<h3 id="confirm-del-title">{pendingDelete.heading}</h3>
				<p>{pendingDelete.body}</p>
				<div class="actions">
					<button class="btn" type="button" onclick={() => (pendingDelete = null)}>Cancel</button>
					<form
						method="POST"
						action="?/{pendingDelete.action}"
						use:enhance={() => {
							return async ({ update }) => {
								await update();
								pendingDelete = null;
							};
						}}
					>
						{#each Object.entries(pendingDelete.fields) as [k, v] (k)}
							<input type="hidden" name={k} value={v} />
						{/each}
						<button class="btn danger" type="submit">{pendingDelete.confirmLabel}</button>
					</form>
				</div>
			</div>
		{/if}
	</div>

	<!-- Separate from the delete modal: that one hardcodes a danger button and has
	     no text input, and duplicating is not destructive. -->
	<div class="modal-overlay" class:open={pendingDuplicatePlan !== null}>
		{#if pendingDuplicatePlan}
			<div class="modal" role="dialog" aria-modal="true" aria-labelledby="dup-plan-title">
				<h3 id="dup-plan-title">Duplicate day plan</h3>
				<p class="muted">
					Copies the stops, notes and starting point. Visited marks and drive times start fresh.
				</p>
				<form
					method="POST"
					action="?/dayplan-duplicate"
					use:enhance={({ formData, cancel }) => {
						duplicatePlanError = '';
						// Validate here rather than with `required`: the native block
						// suppressed the submit silently, so no error ever surfaced.
						if (!(formData.get('title') ?? '').toString().trim()) {
							duplicatePlanError = 'Title is required.';
							cancel();
							return;
						}
						return async ({ result }) => {
							if (result.type === 'failure') {
								duplicatePlanError =
									(result.data as { error?: string })?.error ?? 'Could not duplicate.';
								return;
							}
							const newId =
								result.type === 'success'
									? (result.data as { new_plan_id?: number })?.new_plan_id
									: undefined;
							await invalidateAll();
							pendingDuplicatePlan = null;
							// A single rAF fired before Svelte had committed the new card,
							// so the query found nothing and the page never moved. Wait for
							// the render, then poll briefly for the node.
							if (newId) {
								await tick();
								await scrollToPlan(newId);
							}
						};
					}}
				>
					<input type="hidden" name="id" value={pendingDuplicatePlan.id} />
					<label class="dup-name">
						<span>Name</span>
						<input
							bind:this={dupNameInput}
							name="title"
							value={pendingDuplicatePlan.title}
							maxlength="300"
							onfocus={(e) => e.currentTarget.select()}
							onmouseup={(e) => e.preventDefault()}
						/>
					</label>
					{#if duplicatePlanError}
						<p class="field-error" role="alert">{duplicatePlanError}</p>
					{/if}
					<div class="actions">
						<button class="btn" type="button" onclick={() => (pendingDuplicatePlan = null)}>
							Cancel
						</button>
						<button class="btn primary" type="submit">Duplicate</button>
					</div>
				</form>
			</div>
		{/if}
	</div>
{/if}

<!-- Outside the editor-only block: viewers can share too. Unlike the confirm
     modals this one closes on backdrop tap — the ticket is precisely that iOS
     users had no way out, and Escape does not exist on a phone. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
	class="modal-overlay"
	class:open={shareModal !== null}
	onclick={(e) => {
		if (e.target === e.currentTarget) closeShareModal();
	}}
>
	{#if shareModal}
		<div
			class="modal share-modal"
			role="dialog"
			aria-modal="true"
			aria-labelledby="share-text-title"
			tabindex="-1"
			onkeydown={trapShareFocus}
		>
			<h3 id="share-text-title">{shareModal.title}</h3>
			{#if shareModal.error}
				<p class="field-error" role="alert">{shareModal.text}</p>
			{:else}
				<textarea class="share-text-body" readonly value={shareModal.text}></textarea>
			{/if}
			{#if shareSheetError}
				<p class="field-error" role="alert">{shareSheetError}</p>
			{/if}
			<div class="actions">
				{#if !shareModal.error && canShareText()}
					<button class="btn" type="button" onclick={runShareSheet}>Share…</button>
				{/if}
				{#if !shareModal.error}
					<button class="btn" type="button" onclick={copyShareText}
						>{shareCopied ? 'Copied ✓' : 'Copy'}</button
					>
				{/if}
				<button class="btn primary" type="button" bind:this={shareCloseBtn} onclick={closeShareModal}
					>Close</button
				>
			</div>
		</div>
	{/if}
</div>

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape') {
			pendingDelete = null;
			pendingDuplicatePlan = null;
			if (shareModal) closeShareModal();
		}
	}}
/>

<style>
	.back {
		text-decoration: none;
		font-size: 0.85rem;
		display: inline-flex;
		align-items: center;
		min-height: 44px;
	}
	.outline {
		list-style: none;
		margin: 8px 0;
		padding: 0;
	}
	.outline li {
		border-top: 1px solid var(--border);
	}
	.line {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		min-height: 44px;
		padding: 4px 0;
	}
	/* Collapse/expand caret on foldable rows; spacer keeps leaf rows aligned. */
	.caret {
		flex-shrink: 0;
		/* 44x44 hit target (cs.md); negative margins keep the dense row's
		   flow at ~28px and the right spill inside the 8px flex gap, so the
		   expanded box cannot overlap the neighbouring checkbox target. */
		width: 44px;
		height: 44px;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 0.8rem;
		line-height: 1;
		color: var(--muted);
		background: transparent;
		border: none;
		border-radius: 4px;
		cursor: pointer;
	}
	.caret:hover {
		background: var(--bg);
		color: var(--text);
	}
	.caret-spacer {
		flex-shrink: 0;
		width: 24px;
	}
	.tree-tools {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
		margin: 4px 0;
		font-size: 0.85rem;
	}
	.tree-tools .sep {
		color: var(--muted);
	}
	.places-searchbar {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 10px 0 6px;
	}
	.places-search-input {
		flex: 1;
		min-width: 0;
		font-size: 16px;
		padding: 9px 11px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--card);
		color: var(--text);
	}
	.places-search-count {
		flex-shrink: 0;
		color: var(--muted);
		font-size: 0.82rem;
	}
	.places-search-clear {
		flex-shrink: 0;
	}
	@media (max-width: 480px) {
		.places-searchbar {
			flex-wrap: wrap;
		}
		.places-search-input {
			flex-basis: 100%;
		}
		.places-search-count {
			margin-left: auto;
		}
	}
	.places-empty {
		margin: 10px 0 4px;
	}
	li.search-match {
		background: var(--accent-soft);
	}
	li.search-match .line {
		padding-left: 6px;
		padding-right: 6px;
	}
	.linkbtn {
		background: none;
		border: none;
		/* 44px-tall in-flow hit box. */
		padding: 12px 4px;
		font-size: inherit;
		color: var(--link);
		cursor: pointer;
		text-decoration: underline;
	}
	.grow {
		flex: 1;
		min-width: 0;
	}
	.ttl {
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.place-title-line {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 5px 8px;
	}
	.place-date {
		display: inline-flex;
		align-items: center;
		flex-shrink: 0;
		padding: 2px 7px;
		border-radius: 999px;
		background: var(--need-bg);
		color: var(--need-text);
		font-size: 0.76rem;
		font-weight: 700;
		white-space: nowrap;
	}
	/* Place rows have five tree controls. On phones those controls otherwise
	   squeeze long titles into a nearly one-word-wide column. Keep the controls
	   available, but give them their own row below the place content. */
	.places-outline .line {
		flex-wrap: wrap;
	}
	.places-outline .row-controls {
		flex: 1 0 100%;
		justify-content: flex-end;
	}
	.meta {
		color: var(--muted);
		font-size: 0.85rem;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.done {
		text-decoration: line-through;
		color: var(--muted);
	}
	.chk {
		width: 22px;
		height: 22px;
		flex-shrink: 0;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		/* Row gap must absorb the chip-links' 4px vertical hit-box spill so
		   expanded targets touch but never overlap. */
		gap: 8px 6px;
		margin-top: 4px;
	}
	.chip-link {
		font-size: 0.78rem;
		/* 44px in-flow hit target. */
		padding: 10px 9px;
		border: 0;
		border-radius: 999px;
		background: var(--accent-soft);
		color: var(--accent);
		text-decoration: none;
		min-height: 44px;
		display: inline-flex;
		align-items: center;
	}
	.chip-link.route {
		background: var(--need-bg);
		color: var(--need-text);
	}
	.chip-link.loc {
		background: var(--bg);
		border: 1px solid var(--border);
		color: var(--muted);
	}
	.chip-action {
		font: inherit;
		font-size: 0.78rem;
		padding: 10px 9px;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--card);
		color: var(--link);
		text-decoration: none;
		/* 44 as the ONLY min-height — a later duplicate 28px in this same
		   rule silently won over an earlier 44 (last declaration wins). */
		min-height: 44px;
		display: inline-flex;
		align-items: center;
		cursor: pointer;
	}
	li.flash {
		animation: flash 1.4s ease-out;
	}
	@keyframes flash {
		from {
			background: var(--accent-soft);
		}
		to {
			background: transparent;
		}
	}
	.row-controls {
		display: flex;
		gap: 2px;
		flex-shrink: 0;
	}
	.row-controls form {
		margin: 0;
	}
	.row-controls button {
		border: 1px solid var(--border);
		background: var(--card);
		border-radius: 6px;
		/* Dense-row controls meet 44 at THIS specificity — a lower-specificity
		   .del rule loses to these selectors (peer CODEX, td-3b3f5e round 1).
		   Vertical negative margin keeps row heights. */
		min-width: 44px;
		min-height: 44px;
		color: var(--muted);
	}
	.row-controls button.del {
		color: var(--danger);
	}
	.insert-controls {
		display: flex;
		gap: 2px;
		flex-shrink: 0;
	}
	.insert-controls button {
		border: 1px solid var(--border);
		background: var(--card);
		border-radius: 6px;
		min-width: 44px;
		min-height: 32px;
		color: var(--muted);
		font-size: 0.8rem;
	}
	.insert-row {
		margin: 2px 0;
	}
	.drag-handle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 44px;
		min-height: 44px;
		cursor: grab;
		color: var(--muted);
		user-select: none;
		padding: 0 4px;
		flex-shrink: 0;
		touch-action: none;
	}
	.drag-handle:active {
		cursor: grabbing;
	}
	/* iOS/WebKit doesn't fire HTML5 drag-and-drop on touch, so the handle would
	   highlight but do nothing. Hide it on touch devices — reordering there uses
	   the ↑/↓, indent/outdent, and insert buttons (td-4f7d9b follow-up). */
	@media (hover: none) and (pointer: coarse) {
		.drag-handle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 44px;
		min-height: 44px;
			display: none;
		}
	}
	@media (min-width: 640px) {
		.places-outline .line {
			flex-wrap: nowrap;
		}
		.places-outline .row-controls {
			flex: 0 0 auto;
		}
	}
	li.drop-before {
		box-shadow: inset 0 2px 0 0 var(--link);
	}
	li.drop-after {
		box-shadow: inset 0 -2px 0 0 var(--link);
	}
	.textdoc summary {
		cursor: pointer;
	}
	.textdoc-body {
		white-space: pre-wrap;
		word-break: break-word;
		margin: 6px 0 0;
		padding: 8px 10px;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 6px;
		font-family: inherit;
		font-size: 0.85rem;
	}
	.textdoc-form {
		flex-wrap: wrap;
	}
	.textdoc-form textarea {
		flex: 1 1 100%;
		min-height: 80px;
	}
	.extract {
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 10px 12px;
		margin-bottom: 12px;
		background: var(--bg);
	}
	.photo-drop:focus {
		outline: 2px dashed var(--link);
		outline-offset: -2px;
	}
	.extract-head {
		margin: 0 0 8px;
		font-size: 0.82rem;
		font-weight: 600;
		color: var(--muted);
	}
	.extract-form {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: flex-start;
		margin-bottom: 8px;
	}
	.extract-form textarea {
		flex: 1 1 100%;
		min-height: 64px;
	}
	.extract-msg {
		margin: 4px 0 0;
		font-size: 0.82rem;
		color: var(--link);
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
	.edit summary,
	.paste summary {
		cursor: pointer;
		color: var(--link);
		font-size: 0.8rem;
		padding: 2px 0;
	}
	.edit-form input,
	.edit-form select,
	.edit-form textarea,
	.move-under-form select,
	.add-row input,
	.add-row select,
	.add-row textarea,
	.dayplan-builder input,
	.dayplan-builder select,
	.dayplan-builder textarea,
	.dayplan-note-form input,
	.paste textarea {
		font-size: 1rem;
		padding: 8px 10px;
		border: 1px solid var(--border);
		border-radius: 8px;
	}
	.edit-form {
		display: grid;
		gap: 6px;
		margin: 6px 0 10px;
	}
	.move-under-form {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: end;
		margin: 0 0 10px;
		padding-top: 8px;
		border-top: 1px solid var(--border);
	}
	.move-under-form label {
		display: grid;
		gap: 4px;
		flex: 1 1 240px;
		font-size: 0.85rem;
		color: var(--muted);
	}
	.move-under-form select {
		width: 100%;
		color: var(--fg);
		background: var(--card);
	}
	.edit-form .dt {
		font-size: 0.85rem;
		color: var(--muted);
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.edit-form .dt input {
		flex: 1;
	}
	.add-row {
		display: flex;
		gap: 8px;
		align-items: center;
		margin-top: 10px;
		flex-wrap: wrap;
	}
	/* A native select sizes to its widest <option>, and as a flex item it
	   defaults to min-width: auto — so one long, indented place title makes the
	   control wider than the viewport and scrolls the whole page sideways.
	   Let these shrink and let the label text truncate instead. */
	.add-row select,
	.dayplan-builder select {
		min-width: 0;
		max-width: 100%;
	}
	.add-row input[name='title'],
	.add-row input[name='name'] {
		flex: 1;
		min-width: 140px;
	}
	.add-row textarea[name='notes'] {
		flex: 1 0 100%;
		min-height: 64px;
	}
	.field-error {
		color: var(--danger);
		font-size: 0.85rem;
		margin: 4px 0 0;
	}
	.add-stop-error {
		margin-top: 6px;
	}
	.qty {
		width: 64px;
	}
	.paste textarea {
		width: 100%;
		margin: 6px 0;
	}
	.plist {
		padding: 10px 0;
		border-top: 1px solid var(--border);
	}
	.plist:first-of-type {
		border-top: none;
	}
	.plist-head {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.progress {
		height: 8px;
		background: var(--border);
		border-radius: 999px;
		overflow: hidden;
		margin: 6px 0;
	}
	.progress > span {
		display: block;
		height: 100%;
		background: var(--accent);
	}
	.inline {
		display: inline;
		margin: 0;
	}
	.del {
		background: none;
		border: none;
		color: var(--danger);
		font-size: 0.8rem;
		/* Destructive controls were the worst offenders (the plan delete X
		   measured 11x21.6). Dense rows: 44 via negative margins. */
		min-width: 44px;
		min-height: 44px;
		padding: 10px 6px;
	}
	/* In the plan-card actions row the delete is a standalone control ->
	   48px (cs.md), and there is room to keep it in flow. */
	.dayplan-actions .del {
		min-width: 48px;
		min-height: 48px;
		margin: 0;
	}
	.templates {
		margin-top: 12px;
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		align-items: center;
	}
	.tmpl-chip {
		display: inline-flex;
		align-items: center;
		gap: 2px;
	}
	/* ── Section-level collapse toggles ── */
	.section-header {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.section-toggle {
		min-height: 48px;
		display: flex;
		align-items: center;
		gap: 6px;
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		width: 100%;
		text-align: left;
	}
	.section-header .section-toggle {
		flex: 1;
		min-width: 0;
	}
	.section-toggle h2 {
		margin: 0;
	}
	.places-schedule-btn {
		flex-shrink: 0;
		min-height: 48px;
		text-decoration: none;
	}
	.section-caret {
		font-size: 0.9rem;
		color: var(--muted);
		flex-shrink: 0;
		width: 18px;
	}
	.packing-print-btn {
		flex-shrink: 0;
	}
	.count-badge {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 24px;
		height: 24px;
		padding: 0 7px;
		border-radius: 999px;
		background: var(--accent-soft);
		color: var(--accent);
		font-size: 0.78rem;
		font-weight: 700;
	}
	/* ── Day plans ── */
	.dayplans-card .section-header {
		margin-bottom: 8px;
	}
	.unit-toggle {
		display: inline-flex;
		flex-shrink: 0;
		border: 1px solid var(--border);
		border-radius: 6px;
		overflow: hidden;
		background: var(--card);
	}
	.unit-toggle button {
		min-width: 44px;
		min-height: 44px;
		border: 0;
		border-radius: 0;
		padding: 6px 10px;
		background: transparent;
		color: var(--muted);
		font-weight: 700;
		font-size: 0.82rem;
	}
	.unit-toggle button + button {
		border-left: 1px solid var(--border);
	}
	.unit-toggle button.active {
		background: var(--accent);
		color: #fff;
	}
	.dayplan-list {
		display: grid;
		/* An `auto` track sizes to its content's min-content width, so a wide
		   descendant (deep stop nesting, a long unbroken token) stretches the
		   card past the viewport and gives the whole page a horizontal
		   scrollbar. minmax(0, 1fr) caps the track at the container width. */
		grid-template-columns: minmax(0, 1fr);
		gap: 10px;
	}
	.dayplan-card {
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 12px;
		background: var(--card);
		/* Grid items default to min-width: auto — without this the card still
		   refuses to shrink below its content. */
		min-width: 0;
	}
	/* New controls (branch E) meet the ≥44px bar directly rather than joining
	   the td-3b3f5e sweep. 16px font per cs.md input rule. */
	.birds-trip-filter {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 8px;
		font-size: 0.9rem;
	}
	.birds-trip-filter select {
		flex: 1;
		min-width: 0;
		min-height: 44px;
		font-size: 16px;
	}
	.birds-manual-id {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 8px;
	}
	.birds-manual-id input {
		flex: 1;
		min-width: 0;
		min-height: 44px;
		font-size: 16px;
	}
	/* Invisible wrapper; only exists to disable every review-panel control
	   while an import is in flight. pointer-events also covers any non-native
	   click handler a fieldset's disabled state wouldn't reach. */
	.cand-lock {
		border: 0;
		padding: 0;
		margin: 0;
		min-width: 0;
	}
	.cand-lock[disabled] {
		pointer-events: none;
		opacity: 0.7;
	}
	.itin-date {
		min-height: 44px;
		font-size: 16px;
	}
	.paste-date {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 6px 0;
		font-size: 0.9rem;
	}
	/* The visited checkbox keeps its 22px glyph but the interactive target is
	   the wrapping label at ≥44×44 (cs.md tap-target rule — this is a NEW
	   control, so it meets the bar now rather than waiting for the
	   td-3b3f5e sweep). The negative margins keep the dense row's visual
	   rhythm: the extra hit area hangs over the row padding vertically and
	   the NON-interactive type badge to the right — never over the caret
	   button on the left. z-index puts the overlap above the badge so the
	   whole 44px square actually receives the tap. */
	.chk-hit {
		position: relative;
		z-index: 1;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 44px;
		min-height: 44px;
		margin: -11px -22px -11px 0;
		cursor: pointer;
	}
	/* Folded content stays in the DOM so `@media print` can reveal it — print
	   correctness must never depend on JS running at print time (Safari fires
	   `afterprint` before its lazy pagination finishes). */
	.fold.folded,
	.folded {
		display: none !important;
	}
	.dayplan-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 10px;
		/* Let the actions row wrap below the title instead of starving it —
		   a wide actions row (e.g. the too-many-stops warning) was squeezing
		   the title to one character per line. */
		flex-wrap: wrap;
	}
	.dayplan-head > .grow {
		flex-basis: 240px;
	}
	.dayplan-actions {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		flex-wrap: wrap;
		justify-content: flex-end;
	}
	.dayplan-toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		width: 100%;
		margin-top: 8px;
		padding: 8px 0;
		min-height: 44px;
		background: none;
		border: 0;
		text-align: left;
		cursor: pointer;
		color: var(--link);
		font-size: 0.85rem;
		font-weight: 600;
	}
	/* The driving total, shown only while collapsed, so a folded card still says
	   enough to choose between days. */
	.dayplan-toggle .collapsed-summary {
		font-weight: 400;
	}
	.dayplan-stops-section {
		margin-top: 8px;
	}
	.dayplan-stops,
	.builder-stops {
		margin: 8px 0 0 1.4rem;
		padding: 0;
	}
	.dayplan-stops li,
	.builder-stops li {
		padding: 8px 0;
		border-top: 1px solid var(--border);
	}
	.dayplan-stops li:first-child,
	.builder-stops li:first-child {
		border-top: none;
	}
	.dayplan-stop-row {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 8px;
	}
	.dayplan-visited {
		display: flex;
		align-items: center;
		gap: 8px;
		flex: 1;
		min-width: 0;
		/* The label is the real target (the input is a 22px glyph). */
		min-height: 44px;
		cursor: pointer;
	}
	.dayplan-visited input {
		width: 22px;
		height: 22px;
		flex-shrink: 0;
		margin-top: 1px;
	}
	.dayplan-stop-links,
	.builder-controls {
		display: flex;
		align-items: center;
		gap: 4px;
		flex-wrap: wrap;
		justify-content: flex-end;
	}
	.dayplan-stop-links button,
	.builder-controls button {
		border: 1px solid var(--border);
		background: var(--card);
		border-radius: 6px;
		/* In-flow 44 (td-3b3f5e): the audit proved negative-margin tricks
		   overlap neighbouring targets, so density yields to the rule. */
		min-width: 44px;
		min-height: 44px;
		color: var(--muted);
	}
	.dayplan-stop-links button:disabled,
	.builder-controls button:disabled {
		opacity: 0.45;
	}
	.dayplan-anchor-stop {
		color: var(--text);
	}
	.anchor-badge {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
		padding: 0 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--muted);
		font-size: 0.78rem;
		font-weight: 700;
		text-transform: uppercase;
	}
	.dayplan-stop-note {
		padding-left: 30px;
	}
	.dayplan-note-form {
		display: flex;
		gap: 6px;
		margin: 6px 0 0 30px;
	}
	.dayplan-note-form input {
		flex: 1;
		min-width: 120px;
	}
	.leg-links,
	.dayplan-preview,
	.quick-groups,
	.route-tools {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 8px;
		align-items: center;
	}
	/* Scoped baseline: the app.css global `select` rule loses to any
	   scoped `select.s-*` selector, so the floor must exist at component
	   scope too (audit round: type/reservation/expense selects at 26px). */
	select,
	textarea {
		min-height: 44px;
		font-size: 16px;
	}
	/* Safari-specific: WebKit renders native selects at their intrinsic
	   ~26px despite a min-height floor (Chromium honors it — verified by
	   cross-engine computed-style probes in the audit round). An explicit
	   height is what Safari respects. Textareas keep min-height only. */
	select {
		height: 44px;
	}
	.route-tools select {
		flex: 1 1 180px;
		/* Same native-select shrink problem as .add-row select above. */
		min-width: 0;
		max-width: min(320px, 100%);
		/* Measured 298x25.5 — selects are controls too. 16px per cs.md. */
		min-height: 44px;
		font-size: 16px;
	}
	/* The anchor combobox takes the slot the native select had; its input
	   gets 44px/16px from the global input rule. */
	.route-tools :global(.searchable-select) {
		flex: 1 1 180px;
		min-width: 0;
		max-width: min(320px, 100%);
	}
	.route-status {
		color: var(--muted);
		font-size: 0.85rem;
		margin: 4px 0 0;
	}
	.route-capped {
		color: var(--muted);
		font-size: 0.85rem;
		align-self: center;
	}
	.drive-leg {
		color: var(--muted);
		font-size: 0.78rem;
		margin: 4px 0 4px 30px;
	}
	.dayplan-help {
		margin-bottom: 12px;
		font-size: 0.9rem;
	}
	.dayplan-help > summary {
		cursor: pointer;
		color: var(--link);
		font-size: 0.85rem;
		font-weight: 600;
	}
	.dayplan-help-body {
		margin-top: 6px;
		display: grid;
		gap: 2px;
	}
	.dayplan-help-body details {
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0;
	}
	.dayplan-help-body details[open] {
		padding-bottom: 8px;
	}
	.dayplan-help-body summary {
		cursor: pointer;
		padding: 8px 10px;
		font-weight: 600;
		font-size: 0.85rem;
	}
	.dayplan-help-body ol {
		margin: 0 10px 0 28px;
		padding: 0;
		font-size: 0.85rem;
		line-height: 1.5;
	}
	.dayplan-help-body li {
		margin-bottom: 2px;
	}
	.dayplan-stops-section {
		margin-top: 8px;
	}
	.builder-step {
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 10px 12px;
		margin: 0;
	}
	.builder-step-label {
		font-weight: 600;
		font-size: 0.85rem;
		color: var(--fg);
		margin-bottom: 6px;
	}
	.builder-hint {
		font-size: 0.8rem;
		color: var(--muted);
		margin: 4px 0 2px;
	}
	/* A place title can be long enough to push the chip past the viewport;
	   let it wrap inside the chip rather than widen the row. */
	.quick-groups .chip-action {
		max-width: 100%;
		white-space: normal;
		overflow-wrap: anywhere;
		text-align: left;
	}
	.group-chip {
		background: var(--accent-soft, #e8f0fe);
		border-color: var(--link);
		font-weight: 600;
		font-size: 0.82rem;
	}
	.save-day-btn {
		font-size: 1rem;
		padding: 8px 20px;
		min-height: 44px;
	}
	.save-hint {
		font-weight: 400;
		font-size: 0.78rem;
		opacity: 0.8;
		margin-left: 4px;
	}
	.dayplan-builder {
		display: grid;
		/* Same implicit auto-track problem as .dayplan-list: without this the
		   builder's steps size to their min-content width and the panel runs
		   off-screen on mobile. */
		grid-template-columns: minmax(0, 1fr);
		gap: 10px;
		border: 2px solid var(--link);
		border-radius: 8px;
		padding: 12px;
		margin-top: 12px;
		background: var(--bg);
	}
	.dayplan-builder textarea {
		width: 100%;
	}
	/* Grid/flex children default to min-width: auto and so refuse to shrink
	   below their content — these are the builder's direct children. */
	.builder-step,
	.dayplan-builder .cand-actions {
		min-width: 0;
	}
	.dayplan-picker {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		min-width: 0;
	}
	.dayplan-picker :global(.searchable-select) {
		flex: 1 1 220px;
		min-width: 0;
	}
	/* The add-stop combobox needs room for a full place name but must still
	   shrink on a phone. */
	.add-stop-place {
		flex: 1 1 200px;
		min-width: 0;
	}
	.weather-strip {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 12px;
		font-size: 0.85rem;
		color: var(--fg-muted, #666);
		margin-top: 4px;
	}
	.weather-strip.stale {
		opacity: 0.7;
	}
	.weather-loc {
		font-weight: 600;
		flex-basis: 100%;
	}
	.weather-period strong {
		font-weight: 600;
	}
	.weather-stale-badge {
		font-size: 0.75rem;
		background: var(--bg-warning, #f5e6c8);
		color: var(--fg-warning, #7a5c00);
		padding: 0 4px;
		border-radius: 3px;
	}
	.ai-note {
		font-size: 0.85rem;
		color: var(--fg-muted, #666);
		font-style: italic;
		margin-top: 2px;
		padding-left: 26px;
	}
	.dayplan-ai-tools {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		margin-top: 8px;
	}
	.suggestions-panel {
		margin-top: 8px;
		padding: 8px;
		border: 1px solid var(--border, #ddd);
		border-radius: 6px;
	}
	.suggestions-heading {
		font-size: 0.85rem;
		font-weight: 600;
		margin: 4px 0;
	}
	.suggestions-heading:first-child {
		margin-top: 0;
	}
	.suggestion-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 0;
		font-size: 0.9rem;
	}
	.suggestion-row .grow {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 4px 6px;
	}
	/* The added-driving figure is the whole point of the ranking, so it reads as
	   a value rather than as trailing prose. */
	.added-cost {
		font-variant-numeric: tabular-nums;
		font-weight: 600;
		font-size: 0.8rem;
		padding: 1px 6px;
		border-radius: 10px;
		background: var(--chip-bg, #eceff3);
		color: var(--text, #1b1f24);
		white-space: nowrap;
	}
	.added-cost.free {
		background: #1c6b3f;
		color: #fff;
	}
	.sug-badge {
		font-size: 0.75rem;
		padding: 1px 6px;
		border-radius: 10px;
		border: 1px solid var(--border, #ddd);
		white-space: nowrap;
	}
	.sug-slot {
		font-size: 0.78rem;
	}
	.pinned-heading {
		color: #7a4b00;
	}
	.suggestion-row.pinned {
		background: #fff6e5;
		border-radius: 4px;
		padding: 4px 6px;
	}
	.dayplan-card {
		/* Keeps the header below the sticky nav when scrolled to. */
		scroll-margin-top: 72px;
	}
	.dup-name {
		display: grid;
		gap: 4px;
		margin: 8px 0;
	}
	.dup-name input {
		width: 100%;
		min-height: 48px;
	}
	.detour-budget select {
		font-size: 0.85rem;
		/* cs.md mandates >=48px tap targets. */
		min-height: 48px;
		padding: 4px 6px;
	}
	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}
	@media (prefers-color-scheme: dark) {
		.added-cost {
			background: #2c3238;
			color: #e8eaed;
		}
		.pinned-heading {
			color: #ffca7a;
		}
		.suggestion-row.pinned {
			background: #33291a;
		}
	}
	.builder-stops input {
		width: 100%;
		margin-top: 6px;
	}
	.builder-stops li {
		display: grid;
		gap: 4px;
	}
	/* ── Packing row: wrap controls below text on mobile ── */
	.pack-line {
		flex-wrap: wrap;
	}
	.pack-main {
		display: flex;
		align-items: center;
		gap: 8px;
		flex: 1;
		min-width: 0;
	}
	.pack-controls {
		display: flex;
		gap: 4px;
		flex-shrink: 0;
	}
	@media (max-width: 639px) {
		.pack-controls {
			width: 100%;
			padding: 4px 0 2px 54px;
		}
	}
	/* ── Reservation card layout ── */
	.res-row {
		padding: 8px 0;
	}
	.res-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 4px;
	}
	.res-controls {
		display: flex;
		gap: 2px;
	}
	.res-controls form {
		margin: 0;
	}
	.res-controls button {
		border: 1px solid var(--border);
		background: var(--card);
		border-radius: 6px;
		min-width: 44px;
		min-height: 44px;
		color: var(--muted);
		margin: -6px 0;
	}
	.res-controls button.del {
		color: var(--danger);
	}
	/* ── Reservation notes toggle ── */
	.res-notes summary {
		cursor: pointer;
		color: var(--link);
		font-size: 0.82rem;
		padding: 2px 0;
	}
	.res-notes-body {
		white-space: pre-wrap;
		word-break: break-word;
		margin: 6px 0 0;
		padding: 8px 10px;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 6px;
		font-family: inherit;
		font-size: 0.85rem;
	}
	/* ── Document links row ── */
	.doc-links {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
	}
	.upload-row {
		flex-wrap: wrap;
	}
	/* A file input's intrinsic width (filename + button) is wider than a phone
	   viewport and it will not shrink on its own. Styles here are
	   component-scoped, so this covers every file input on the trip page. */
	input[type='file'] {
		min-width: 0;
		max-width: 100%;
	}
	.upload-row input[name='display_name'] {
		flex: 1;
		min-width: 140px;
	}
	/* ── Expense section ── */
	.expense-total {
		font-size: 0.95rem;
		font-weight: 600;
		color: var(--accent);
		white-space: nowrap;
	}
	.exp-row {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 10px 0;
		flex-wrap: wrap;
	}
	.exp-main {
		flex: 1;
		min-width: 0;
	}
	.exp-desc {
		font-weight: 500;
	}
	.exp-amount {
		font-weight: 600;
		font-size: 1rem;
		white-space: nowrap;
		text-align: right;
		min-width: 70px;
	}
	.exp-doc-link {
		font-size: 0.78rem;
		color: var(--link);
		text-decoration: none;
		margin-top: 2px;
		display: inline-block;
	}
	.exp-controls {
		display: flex;
		gap: 2px;
	}
	.exp-controls form {
		margin: 0;
	}
	.exp-controls button {
		border: 1px solid var(--border);
		background: var(--card);
		border-radius: 6px;
		min-width: 44px;
		min-height: 44px;
		color: var(--muted);
		margin: -6px 0;
	}
	.exp-controls button.del {
		color: var(--danger);
	}
	.exp-total-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 12px 0 4px;
		font-weight: 600;
		border-top: 2px solid var(--border);
	}
	.exp-total-row .exp-amount {
		font-size: 1.1rem;
	}
	.cat-subtotals {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		padding: 6px 0 8px;
		font-size: 0.82rem;
		color: var(--muted);
	}
	.cat-sub {
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.form-row {
		display: flex;
		gap: 8px;
	}
	.form-row input[type='date'] {
		max-width: 150px;
	}
	.form-row input[name='amount'] {
		max-width: 110px;
	}
	.extract-actions {
		display: flex;
		gap: 8px;
		align-items: center;
		margin-top: 6px;
	}
	.extract-opt {
		font-size: 0.82rem;
		color: var(--muted);
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.candidates {
		background: var(--accent-soft);
		border: 1px solid var(--accent);
		border-radius: 8px;
		padding: 12px;
		margin: 12px 0;
	}
	.itinerary-candidates {
		background: var(--bg);
		border-color: var(--border);
	}
	.import-target {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		align-items: center;
		margin-bottom: 8px;
	}
	.import-target label {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.85rem;
		color: var(--muted);
	}
	.import-target label.import-parent {
		flex: 1 1 260px;
		max-width: 440px;
	}
	.import-target label.import-parent :global(.searchable-select) {
		flex: 1;
	}
	.itin-cand-fields input,
	.itin-cand-fields select,
	.itin-cand-fields textarea {
		font-size: 0.9rem;
		padding: 6px 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
	}
	.itin-cand-row {
		display: flex;
		gap: 8px;
		padding: 10px 0;
		border-top: 1px solid var(--border);
	}
	.itin-cand-row:first-child {
		border-top: none;
	}
	.itin-cand-check {
		padding-top: 8px;
	}
	.itin-cand-check input {
		width: 20px;
		height: 20px;
	}
	.itin-cand-fields {
		display: grid;
		gap: 6px;
		flex: 1;
		min-width: 0;
	}
	.itin-cand-fields .form-row {
		flex-wrap: wrap;
	}
	.itin-cand-fields input,
	.itin-cand-fields textarea {
		min-width: 0;
		flex: 1 1 140px;
	}
	.itin-cand-fields textarea {
		width: 100%;
		resize: vertical;
	}
	.dup-warning {
		margin: 0;
		color: var(--danger);
		font-size: 0.8rem;
	}
	.cand-row {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 0;
		border-top: 1px solid rgba(0, 0, 0, 0.08);
		flex-wrap: wrap;
	}
	.cand-row:first-child {
		border-top: none;
	}
	.cand-row input[type='checkbox'] {
		width: 20px;
		height: 20px;
		flex-shrink: 0;
	}
	.cand-date {
		font-size: 0.82rem;
		color: var(--muted);
		width: 80px;
		flex-shrink: 0;
	}
	.cand-desc {
		flex: 1;
		min-width: 0;
		font-size: 0.9rem;
	}
	.cand-amount {
		font-weight: 600;
		font-size: 0.9rem;
		white-space: nowrap;
		min-width: 60px;
		text-align: right;
	}
	.cand-cat {
		font-size: 0.8rem;
		padding: 4px;
		border: 1px solid var(--border);
		border-radius: 4px;
	}
	.cand-actions {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		margin-top: 10px;
		padding-top: 8px;
		border-top: 1px solid rgba(0, 0, 0, 0.08);
	}
	@media (max-width: 639px) {
		.dayplan-head,
		.dayplan-stop-row {
			flex-direction: column;
		}
		.dayplan-actions,
		.dayplan-stop-links {
			justify-content: flex-start;
		}
		.dayplan-note-form {
			margin-left: 0;
			flex-wrap: wrap;
		}
		.exp-controls {
			width: 100%;
			padding-top: 4px;
		}
		.form-row {
			flex-wrap: wrap;
		}
	}
	/* Share-text modal: wider than the 420px confirm modals (app.css) so a
	   whole-trip export is readable, body scrolls internally. */
	.share-modal {
		width: min(560px, calc(100vw - 32px));
		max-width: none;
	}
	.share-text-body {
		width: 100%;
		box-sizing: border-box;
		min-height: 180px;
		max-height: min(48vh, 420px);
		resize: vertical;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		line-height: 1.45;
		white-space: pre-wrap;
	}
	/* Bulk move-under (td-947440): selection checkboxes read differently from
	   the visited ones, and the bar rides above the phone bottom nav. */
	.select-chk {
		accent-color: var(--accent);
	}
	.bulk-move-bar {
		position: sticky;
		bottom: calc(var(--bottomnav-h) + env(safe-area-inset-bottom) + 8px);
		z-index: 30;
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
		padding: 10px;
		margin-top: 10px;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--card);
		box-shadow: 0 6px 18px rgb(0 0 0 / 0.12);
	}
	@media (min-width: 640px) {
		.bulk-move-bar {
			bottom: 12px;
		}
	}
	.bulk-count {
		font-size: 0.9rem;
		color: var(--muted);
		white-space: nowrap;
	}
	.bulk-move-target {
		flex: 1 1 200px;
		min-width: 0;
	}
	@media print {
		/* Reveal everything folded on screen: `revert` lands on the UA default
		   (block / list-item), and this rule is after the screen rule so it wins. */
		.fold.folded,
		.folded {
			display: revert !important;
		}
		/* The folded-card driving summary would duplicate the card's own meta
		   line once the stops are revealed. */
		.dayplan-toggle .collapsed-summary {
			display: none !important;
		}
		.dayplan-actions,
		.dayplan-stop-links,
		.dayplan-note-form,
		.dayplan-builder,
		.dayplan-visited input,
		.bulk-move-bar,
		.leg-links {
			display: none !important;
		}
		.dayplan-card {
			border: none;
			padding: 0;
			/* `avoid` on a block that can exceed one page makes Safari drop it
			   from the PDF entirely (see .card in app.css) — a many-stop plan
			   card can be that tall, so it must be breakable. The head stays
			   atomic; per-stop rows are kept whole by app.css's `li` rule. */
			break-inside: auto;
		}
		.dayplan-head {
			break-inside: avoid;
		}
		.dayplan-stops-section {
			display: block;
		}
		.dayplan-help {
			display: none;
		}
		.dayplan-stops li {
			padding: 1pt 0;
			border-top: none;
		}
	}
</style>
