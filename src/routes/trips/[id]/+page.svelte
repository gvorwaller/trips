<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { browser } from '$app/environment';
	import { flushSync, onMount } from 'svelte';
	import AttachmentDownloadButton from '$components/AttachmentDownloadButton.svelte';
	import PinMap from '$components/PinMap.svelte';
	import {
		googleMapsLink,
		appleMapsLink,
		googleDirectionsLink,
		googleDayDirectionsLink,
		googleLegByLegLinks,
		dayPlanDirectionsLink,
		type MapPlace
	} from '$lib/maplinks';
	import { haversineKm, formatKm } from '$lib/geo';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const isViewer = $derived(data.user?.role === 'viewer');
	let selectedPin = $state<number | null>(null);

	// Inline "insert item above/below this row" (td-4aa8c4). Clicking a row's ＋
	// opens a one-off input positioned exactly where the new item will land, so a
	// mid-list item arrives in place without repeated move-up/down clicks.
	let packInsert = $state<{ refId: number; position: 'above' | 'below' } | null>(null);
	const openInsert = (refId: number, position: 'above' | 'below') => (packInsert = { refId, position });
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
		children: ItinCandidateRaw[];
		duplicate?: boolean;
		duplicate_title?: string | null;
	}
	interface ItinCandidate
		extends Omit<
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
	const itinImportParents = $derived(
		data.itineraryRows.filter((r) =>
			['day', 'section', 'place'].includes(r.node.item_type)
		)
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
		return itinImportParents.filter(
			({ node }) => node.id !== id && !isItinDescendant(node.id, id)
		);
	}

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
		itinImporting = true;
		const fd = new FormData();
		fd.set('candidates', JSON.stringify(selected));
		fd.set('parent_id', itinImportParentId);
		fd.set('geocode', itinGeocode ? 'true' : 'false');
		try {
			const res = await fetch('?/itin-import-candidates', { method: 'POST', body: fd });
			if (res.ok) {
				itinCandidates = [];
				itinExtractText = '';
				itinExtractMsg = '';
				await invalidateAll();
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

	const itinHasChildren = (id: number) =>
		data.itineraryRows.some((r) => r.node.parent_id === id);

	type ItinNode = PageData['itineraryRows'][number]['node'];
	type DayPlanStop = PageData['dayPlanStops'][number];
	const toPlace = (n: ItinNode): MapPlace => ({
		name: n.title,
		lat: n.lat,
		lon: n.lon,
		place_id: n.place_id
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
	};
	let dayPlanBuilderOpen = $state(false);
	let dayPlanTitle = $state('');
	let dayPlanDate = $state('');
	let dayPlanNotes = $state('');
	let dayPlanStops = $state<BuilderStop[]>([]);
	let dayPlanAddPlaceId = $state('');

	const dayPlanPlaces = $derived(data.itineraryRows.filter((r) => r.node.item_type === 'place'));
	const dayPlanParents = $derived(
		data.itineraryRows.filter((r) => r.node.item_type === 'day' || r.node.item_type === 'section')
	);

	function stopPlace(stop: BuilderStop): MapPlace {
		return { name: stop.title, lat: stop.lat, lon: stop.lon, place_id: stop.place_id };
	}

	function savedStopPlace(stop: DayPlanStop): MapPlace {
		return {
			name: stop.snapshot_title,
			lat: stop.snapshot_lat,
			lon: stop.snapshot_lon,
			place_id: stop.snapshot_place_id
		};
	}

	function stopsForPlan(planId: number): DayPlanStop[] {
		return data.dayPlanStops.filter((s) => s.day_plan_id === planId);
	}

	function planProgress(stops: DayPlanStop[]): string {
		const visited = stops.filter((s) => s.visited).length;
		return `${visited}/${stops.length} visited`;
	}

	function routeDistance(places: MapPlace[]): string | null {
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
		return legs > 0 ? formatKm(km) : null;
	}

	const builderRoute = $derived(googleDayDirectionsLink(dayPlanStops.map(stopPlace)));
	const builderLegs = $derived(googleLegByLegLinks(dayPlanStops.map(stopPlace)));
	const builderDistance = $derived(routeDistance(dayPlanStops.map(stopPlace)));
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
				place_id: row.node.place_id
			}
		];
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
	}

	function removeBuilderStop(index: number) {
		dayPlanStops = dayPlanStops.filter((_, i) => i !== index);
	}

	async function toggleVisited(id: number, visited: boolean) {
		const res = await fetch('/api/dayplan/visited', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id, visited })
		});
		if (res.ok) invalidateAll();
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
		if (res.ok) invalidateAll();
	}

	function selectPin(id: number) {
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

	let itinCollapsed = $state<Set<number>>(new Set());
	let packCollapsed = $state<Set<number>>(new Set());

	onMount(() => {
		itinCollapsed = loadIds(itinKey);
		packCollapsed = loadIds(packKey);
	});

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

	// Per-row roll-up of descendant LEAF checked-state (td-b60112). For each node
	// returns {leaves, checked}: a leaf counts as itself; a parent sums its
	// descendants. A checkbox is then derived — all leaves checked → checked,
	// some → indeterminate, none → unchecked — with no extra writes (so the
	// viewer's single-write constraint holds). The same formula collapses to a
	// leaf's own state, and a packing list's progress = its roots' totals.
	type PackRow = { node: { id: number; parent_id: number | null; checked: boolean }; depth: number };
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

	function toggled(set: Set<number>, key: string, id: number): Set<number> {
		const next = new Set(set);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		saveIds(key, next);
		return next;
	}
	const toggleItin = (id: number) => (itinCollapsed = toggled(itinCollapsed, itinKey, id));
	const togglePack = (id: number) => (packCollapsed = toggled(packCollapsed, packKey, id));

	function bulkFold(set: Set<number>, key: string, ids: Set<number>, collapse: boolean): Set<number> {
		const next = new Set(set);
		for (const id of ids) {
			if (collapse) next.add(id);
			else next.delete(id);
		}
		saveIds(key, next);
		return next;
	}
	const collapseAllItin = () => (itinCollapsed = bulkFold(itinCollapsed, itinKey, itinParents, true));
	const expandAllItin = () => (itinCollapsed = bulkFold(itinCollapsed, itinKey, itinParents, false));
	const collapsePack = (rows: TreeRow[]) =>
		(packCollapsed = bulkFold(packCollapsed, packKey, parentIds(rows), true));
	const expandPack = (rows: TreeRow[]) =>
		(packCollapsed = bulkFold(packCollapsed, packKey, parentIds(rows), false));

	// ── Section-level collapse (Places / Packing / Reservations / Documents) ──
	const sectionKey = $derived(`trips:${data.trip.id}:sections`);
	let sectionsCollapsed = $state<Set<string>>(new Set());
	onMount(() => {
		try {
			const v = JSON.parse(localStorage.getItem(sectionKey) ?? '[]');
			sectionsCollapsed = new Set(Array.isArray(v) ? v.filter((s: unknown) => typeof s === 'string') : []);
		} catch { /* use empty set */ }
	});
	function saveSections(s: Set<string>) {
		if (browser) localStorage.setItem(sectionKey, JSON.stringify([...s]));
	}
	function toggleSection(name: string) {
		const next = new Set(sectionsCollapsed);
		if (next.has(name)) next.delete(name);
		else next.add(name);
		saveSections(next);
		sectionsCollapsed = next;
	}

	// Print a one-page trip sheet (td-a2d073). Collapsed branches are removed from
	// the DOM, so expand everything first (in memory only — don't persist to
	// localStorage), render, print, then restore the user's fold state.
	function printSheet() {
		const savedItin = itinCollapsed;
		const savedPack = packCollapsed;
		const savedSections = sectionsCollapsed;
		itinCollapsed = new Set();
		packCollapsed = new Set();
		sectionsCollapsed = new Set();
		flushSync();
		try {
			window.print();
		} finally {
			itinCollapsed = savedItin;
			packCollapsed = savedPack;
			sectionsCollapsed = savedSections;
		}
	}

	const packingPrintHref = $derived(
		`/trips/${data.trip.id}/packing/print?collapsed=${encodeURIComponent([...packCollapsed].join(','))}`
	);
</script>

<svelte:head><title>{data.trip.name}</title></svelte:head>

<div class="page-head trip-page-head">
	<a class="muted back" href="/">← All trips</a>
	<h1>{data.trip.name}</h1>
	<div class="sub">{fmtRange(data.trip.start_date, data.trip.end_date)}</div>
	<button type="button" class="btn small print-btn" onclick={printSheet}>🖨 Print</button>
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
			<span class="section-caret">{sectionsCollapsed.has('dayplans') ? '▸' : '▾'}</span>
			<h2>Day Plans</h2>
			<span class="count-badge">{data.dayPlans.length}</span>
		</button>
		{#if !isViewer}
			<button class="btn small" type="button" onclick={openDayPlanBuilder}>Build day</button>
		{/if}
	</div>

	{#if !sectionsCollapsed.has('dayplans')}
		{#if data.dayPlans.length === 0}
			<p class="muted">No day plans yet.</p>
		{:else}
			<div class="dayplan-list">
				{#each data.dayPlans as plan (plan.id)}
					{@const stops = stopsForPlan(plan.id)}
					{@const directions = dayPlanDirectionsLink(stops)}
					{@const legLinks = googleLegByLegLinks(stops.map(savedStopPlace))}
					{@const distance = routeDistance(stops.map(savedStopPlace))}
					<article class="dayplan-card">
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
									{stops.length} stop{stops.length === 1 ? '' : 's'} - {planProgress(stops)}
									{#if distance} - ~{distance}{/if}
								</div>
								{#if plan.notes}<div class="meta">{plan.notes}</div>{/if}
							</div>
							<div class="dayplan-actions">
								{#if directions}
									<a class="btn small primary" href={directions} target="_blank" rel="noopener"
										>Open directions</a
									>
								{:else if stops.length === 1}
									<a
										class="btn small"
										href={googleMapsLink(savedStopPlace(stops[0]))}
										target="_blank"
										rel="noopener">Open map</a
									>
								{/if}
								{#if !isViewer}
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

						<details class="dayplan-details">
							<summary>Stops</summary>
							{#if stops.length === 0}
								<p class="muted">No stops saved.</p>
							{:else}
								<ol class="dayplan-stops">
									{#each stops as stop, i (stop.id)}
										<li>
											<div class="dayplan-stop-row">
												<label class="dayplan-visited">
													<input
														type="checkbox"
														checked={stop.visited}
														onchange={(e) => toggleVisited(stop.id, e.currentTarget.checked)}
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
														<form method="POST" action="?/dayplan-remove-stop" use:enhance class="inline">
															<input type="hidden" name="id" value={stop.id} />
															<button type="submit" class="del">Remove</button>
														</form>
													{/if}
												</div>
											</div>
											{#if stop.notes}<div class="meta dayplan-stop-note">{stop.notes}</div>{/if}
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
								<form method="POST" action="?/dayplan-add-stop" use:enhance class="add-row">
									<input type="hidden" name="plan_id" value={plan.id} />
									<select name="itinerary_item_id" required aria-label="place">
										<option value="">Add a place...</option>
										{#each dayPlanPlaces as { node, depth } (node.id)}
											<option value={node.id}>{'· '.repeat(depth)}{node.title}</option>
										{/each}
									</select>
									<input name="notes" placeholder="Stop note" />
									<button class="btn small" type="submit">Add stop</button>
								</form>
							{/if}
						</details>
					</article>
				{/each}
			</div>
		{/if}

		{#if !isViewer && dayPlanBuilderOpen}
			<form
				method="POST"
				action="?/dayplan-create"
				class="dayplan-builder"
				use:enhance={() => {
					return async ({ result, update }) => {
						if (result.type === 'success') {
							resetDayPlanBuilder();
							dayPlanBuilderOpen = false;
						}
						await update();
					};
				}}
			>
				<input type="hidden" name="stops" value={builderStopsJson} />
				<div class="form-row">
					<input name="title" placeholder="Title (required)" required bind:value={dayPlanTitle} />
					<input name="optional_date" type="date" bind:value={dayPlanDate} />
				</div>
				<textarea name="notes" rows="2" placeholder="Plan notes" bind:value={dayPlanNotes}></textarea>

				<div class="dayplan-picker">
					<select bind:value={dayPlanAddPlaceId} aria-label="place">
						<option value="">Choose a place...</option>
						{#each dayPlanPlaces as { node, depth } (node.id)}
							<option
								value={String(node.id)}
								disabled={dayPlanStops.some((s) => s.itinerary_item_id === node.id)}
							>
								{'· '.repeat(depth)}{node.title}
							</option>
						{/each}
					</select>
					<button
						class="btn small"
						type="button"
						onclick={addSelectedBuilderPlace}
						disabled={!dayPlanAddPlaceId}
					>
						Add place
					</button>
				</div>
				{#if dayPlanParents.length > 0}
					<div class="quick-groups">
						{#each dayPlanParents as { node } (node.id)}
							{#if directChildPlaces(node.id).length > 0}
								<button class="chip-action" type="button" onclick={() => startDayPlanFromParent(node)}>
									{node.title}
								</button>
							{/if}
						{/each}
					</div>
				{/if}

				{#if dayPlanStops.length > 0}
					<ol class="builder-stops">
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
									<button type="button" class="del" onclick={() => removeBuilderStop(i)}>Remove</button>
								</div>
							</li>
						{/each}
					</ol>
					<div class="dayplan-preview">
						<span>{dayPlanStops.length} stop{dayPlanStops.length === 1 ? '' : 's'}</span>
						{#if builderDistance}<span>~{builderDistance}</span>{/if}
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
				{/if}
				<div class="cand-actions">
					<button
						class="btn small primary"
						type="submit"
						disabled={!dayPlanTitle.trim() || dayPlanStops.length === 0}
					>
						Save day
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
	{/if}
</div>

<!-- ── PLACES ─────────────────────────────────────────── -->
<div class="card">
	<button class="section-toggle" type="button" onclick={() => toggleSection('places')}>
		<span class="section-caret">{sectionsCollapsed.has('places') ? '▸' : '▾'}</span>
		<h2>Places</h2>
	</button>

	{#if !sectionsCollapsed.has('places')}
	{#if data.itineraryRows.length > 0}
		<PinMap {pins} onselect={selectPin} />
	{/if}

	{#if data.itineraryRows.length === 0}
		<p class="muted">No places yet.</p>
	{:else}
		{#if itinParents.size > 0}
			<div class="tree-tools">
				<button type="button" class="linkbtn" onclick={collapseAllItin}>Collapse all</button>
				<span class="sep" aria-hidden="true">·</span>
				<button type="button" class="linkbtn" onclick={expandAllItin}>Expand all</button>
			</div>
		{/if}
		<ul class="outline">
			{#each data.itineraryRows as { node, depth } (node.id)}
				{#if !itinHidden.has(node.id)}
					{@const route =
						node.item_type === 'day' || node.item_type === 'section'
							? dayDirections(node.id)
							: null}
					<li
						id="itin-{node.id}"
						style="padding-left: {depth * 22}px"
						class:flash={selectedPin === node.id}
					>
						<div class="line">
							{#if itinParents.has(node.id)}
								<button
									class="caret"
									type="button"
									aria-expanded={!itinCollapsed.has(node.id)}
									aria-label={itinCollapsed.has(node.id) ? 'Expand' : 'Collapse'}
									onclick={() => toggleItin(node.id)}>{itinCollapsed.has(node.id) ? '▸' : '▾'}</button
								>
							{:else}
								<span class="caret-spacer" aria-hidden="true"></span>
							{/if}
							<span class="badge {node.item_type === 'place' ? 'seen' : 'need'}"
								>{node.item_type}</span
							>
						<span class="grow">
							<span class="ttl">{node.title}</span>
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
						{#if !isViewer}{@render treeControls(
								node.id,
								'itin-move',
								'itin-delete',
								null,
								node.title,
								itinHasChildren(node.id)
							)}{/if}
					</div>
					{#if !isViewer}
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
								<textarea name="notes" rows="2" placeholder="Notes">{node.notes ?? ''}</textarea>
								<button class="btn small primary" type="submit">Save</button>
							</form>
							<form method="POST" action="?/itin-reparent" use:enhance class="move-under-form">
								<input type="hidden" name="id" value={node.id} />
								<label>
									Move under
									<select name="parent_id">
										<option value="" selected={node.parent_id === null}>Top level</option>
										{#each itinMoveParentsFor(node.id) as parentRow (parentRow.node.id)}
											<option
												value={String(parentRow.node.id)}
												selected={node.parent_id === parentRow.node.id}
											>
												{'· '.repeat(parentRow.depth)}{parentRow.node.title} ({parentRow.node.item_type})
											</option>
										{/each}
									</select>
								</label>
								<button class="btn small" type="submit">Move</button>
							</form>
						</details>
					{/if}
				</li>
				{/if}
			{/each}
		</ul>
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
			<textarea name="notes" rows="2" placeholder="Notes"></textarea>
			<button class="btn small primary" type="submit">Add</button>
		</form>
		<details class="paste">
			<summary>Paste many (one per line)</summary>
			<form method="POST" action="?/itin-paste" use:enhance>
				<input type="hidden" name="item_type" value="place" />
				<textarea name="text" rows="4" placeholder="Palais des Papes&#10;Pont d'Avignon&#10;…"
				></textarea>
				<button class="btn small" type="submit">Add all</button>
			</form>
		</details>
		<details class="paste">
			<summary>Import itinerary from text</summary>
			<div class="extract">
				<p class="extract-head">Paste AI output, notes, web text, or bullets. Review before importing.</p>
				<form
					method="POST"
					action="?/itin-extract"
					class="extract-form"
					use:enhance={() => {
						itinExtracting = true;
						itinExtractMsg = '';
						return async ({ result }) => {
							itinExtracting = false;
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
					<button class="btn small" type="submit" disabled={itinExtracting || !itinExtractText.trim()}>
						{itinExtracting ? 'Extracting...' : 'Extract itinerary'}
					</button>
				</form>
				{#if itinExtractMsg}<p class="extract-msg">{itinExtractMsg}</p>{/if}
			</div>

			{#if itinCandidates.length > 0}
				<div class="candidates itinerary-candidates">
					<div class="import-target">
						<label>
							Import under
							<select bind:value={itinImportParentId}>
								<option value="">Top level</option>
								{#each itinImportParents as { node, depth } (node.id)}
									<option value={String(node.id)}>
										{'· '.repeat(depth)}{node.title} ({node.item_type})
									</option>
								{/each}
							</select>
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
							disabled={itinImporting || selectedItinCount() === 0}
						>
							{itinImporting
								? 'Importing...'
								: `Import ${selectedItinCount()} item${selectedItinCount() === 1 ? '' : 's'}`}
						</button>
						<button
							class="btn small"
							type="button"
							onclick={() => {
								itinCandidates = [];
								itinExtractMsg = '';
							}}>Clear</button
						>
					</div>
				</div>
			{/if}
		</details>
	{/if}
	{/if}
</div>

<!-- ── PACKING ────────────────────────────────────────── -->
<div class="card packing-card">
	<div class="section-header">
		<button class="section-toggle" type="button" onclick={() => toggleSection('packing')}>
			<span class="section-caret">{sectionsCollapsed.has('packing') ? '▸' : '▾'}</span>
			<h2>Packing</h2>
		</button>
		<a class="btn small packing-print-btn" href={packingPrintHref}>🖨 Print packing</a>
	</div>
	{#if !sectionsCollapsed.has('packing')}
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
					<button type="button" class="linkbtn" onclick={() => expandPack(rows)}>Expand all</button>
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
					{#if !packHidden.has(node.id)}
						{#if !isViewer && isInserting(node.id, 'above')}{@render packInsertForm(
								list.id,
								node.id,
								'above',
								depth
							)}{/if}
						<li
							style="padding-left: {depth * 22}px"
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
											onclick={() => togglePack(node.id)}>{packCollapsed.has(node.id) ? '▸' : '▾'}</button
										>
									{:else}
										<span class="caret-spacer" aria-hidden="true"></span>
									{/if}
									<input
										type="checkbox"
										class="chk"
										checked={packChecked(packStats.get(node.id))}
										indeterminate={packIndeterminate(packStats.get(node.id))}
										onchange={(e) => toggleCheck(node.id, e.currentTarget.checked)}
									/>
									<span class="grow" class:done={packChecked(packStats.get(node.id))}>
										{node.name}{#if node.quantity > 1}<span class="muted"> ×{node.quantity}</span>{/if}
										{#if node.notes}<div class="meta note">{node.notes}</div>{/if}
									</span>
								</div>
								{#if !isViewer}
									<div class="pack-controls">
										<span class="insert-controls">
											<button type="button" title="insert above" onclick={() => openInsert(node.id, 'above')}
												>＋↑</button
											>
											<button type="button" title="insert below" onclick={() => openInsert(node.id, 'below')}
												>＋↓</button
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
								<form method="POST" action="?/pack-edit" use:enhance={() => {
									return async ({ update }) => { await update({ reset: false }); };
								}} class="edit-form">
									<input type="hidden" name="id" value={node.id} />
									<input type="hidden" name="list_id" value={list.id} />
									<input type="hidden" name="category" value={node.category ?? ''} />
									<input name="name" value={node.name} placeholder="Name" required />
									<input name="quantity" type="number" min="1" value={node.quantity} class="qty" aria-label="quantity" />
									<textarea name="notes" rows="2" placeholder="Notes">{node.notes ?? ''}</textarea>
									<button class="btn small primary" type="submit">Save</button>
								</form>
							</details>
						{/if}
					</li>
					{#if !isViewer && isInserting(node.id, 'below')}{@render packInsertForm(
							list.id,
							node.id,
							'below',
							depth
						)}{/if}
					{/if}
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
	{/if}
</div>

<!-- ── RESERVATIONS ───────────────────────────────────── -->
<div class="card">
	<button class="section-toggle" type="button" onclick={() => toggleSection('reservations')}>
		<span class="section-caret">{sectionsCollapsed.has('reservations') ? '▸' : '▾'}</span>
		<h2>Reservations</h2>
	</button>
	{#if !sectionsCollapsed.has('reservations')}
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
									applyExtract((result.data as { fields?: Record<string, unknown> }).fields ?? {});
									extractMsg = 'Filled from the document — review and edit, then Add reservation.';
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
					>Start <input type="datetime-local" name="start_at" bind:value={resDraft.start_at} /></label
				>
				<label class="dt"
					>End <input type="datetime-local" name="end_at" bind:value={resDraft.end_at} /></label
				>
				<textarea name="notes" rows="2" placeholder="Notes" bind:value={resDraft.notes}></textarea>
				<button class="btn small primary" type="submit">Add reservation</button>
			</form>
		</details>
	{/if}
	{/if}
</div>

<!-- ── ATTACHMENTS ────────────────────────────────────── -->
<div class="card">
	<button class="section-toggle" type="button" onclick={() => toggleSection('documents')}>
		<span class="section-caret">{sectionsCollapsed.has('documents') ? '▸' : '▾'}</span>
		<h2>Documents</h2>
	</button>
	{#if !sectionsCollapsed.has('documents')}
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
									<a
										class="chip-link"
										href="/trips/{data.trip.id}/attachments/{a.id}/view">View</a
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
							<form method="POST" action="?/attach-rename" use:enhance={() => {
								return async ({ update }) => { await update({ reset: false }); };
							}} class="edit-form">
								<input type="hidden" name="id" value={a.id} />
								<input name="display_name" value={a.display_name ?? ''} placeholder="Display name (optional)" />
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
	{/if}
</div>

<!-- ── EXPENSES ──────────────────────────────────────── -->
<div class="card">
	<button class="section-toggle" type="button" onclick={() => toggleSection('expenses')}>
		<span class="section-caret">{sectionsCollapsed.has('expenses') ? '▸' : '▾'}</span>
		<h2>Expenses</h2>
		<span class="expense-total">{fmtAmount(expenseTotal)}</span>
	</button>
	{#if !sectionsCollapsed.has('expenses')}
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
								{#if e.expense_date}{new Date(e.expense_date + 'T00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}{/if}
								{#if e.notes} · {e.notes}{/if}
							</div>
							{#if e.attachment_id}
								{@const att = data.attachments.find(a => a.id === e.attachment_id)}
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
								<input name="description" value={e.description} placeholder="Description" required />
								<div class="form-row">
									<input name="amount" value={(e.amount_cents / 100).toFixed(2)} placeholder="$0.00" inputmode="decimal" />
									<select name="attachment_id" aria-label="linked document">
										<option value="">Link document (optional)</option>
										{#each data.attachments as a (a.id)}
											<option value={a.id} selected={e.attachment_id === a.id}>{a.display_name || a.original_name}</option>
										{/each}
									</select>
								</div>
								<textarea name="notes" rows="1" placeholder="Notes (optional)">{e.notes ?? ''}</textarea>
								<button class="btn small primary" type="submit">Save</button>
							</form>
						</details>
					{/if}
				</li>
			{/each}
		</ul>

		{@const catTotals = data.expenses.reduce((acc: Record<string, number>, e: { category: string; amount_cents: number }) => {
			acc[e.category] = (acc[e.category] ?? 0) + e.amount_cents;
			return acc;
		}, {} as Record<string, number>)}
		{#if Object.keys(catTotals).length > 1}
			<div class="cat-subtotals">
				{#each Object.entries(catTotals) as [cat, cents]}
					<span class="cat-sub"><span class="badge need">{cat}</span> {fmtAmount(cents as number)}</span>
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
								const raw = (result.data as { candidates?: Array<{ expense_date: string | null; description: string; amount: number; category: string | null; notes: string | null }> }).candidates ?? [];
								expCandidates = raw.map(c => ({ ...c, selected: true }));
								if (raw.length === 0) {
									expExtractMsg = 'No transactions found in the text.';
								} else {
									expExtractMsg = `${raw.length} transaction${raw.length > 1 ? 's' : ''} found — review below.`;
								}
							} else if (result.type === 'failure') {
								expExtractMsg = (result.data as { error?: string })?.error ?? 'Extraction failed.';
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
						<button class="btn small" type="submit" disabled={expExtracting || !expExtractText.trim()}>
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
									const raw = (result.data as { candidates?: Array<{ expense_date: string | null; description: string; amount: number; category: string | null; notes: string | null }> }).candidates ?? [];
									expCandidates = raw.map(c => ({ ...c, selected: true }));
									if (raw.length === 0) {
										expExtractMsg = 'No transactions found in the document.';
									} else {
										expExtractMsg = `${raw.length} transaction${raw.length > 1 ? 's' : ''} found — review below.`;
									}
								} else if (result.type === 'failure') {
									expExtractMsg = (result.data as { error?: string })?.error ?? 'Extraction failed.';
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
						<button class="btn small" type="button"
							onclick={() => expCandidates.forEach(c => c.selected = true)}>Select all</button>
						<button class="btn small" type="button"
							onclick={() => expCandidates.forEach(c => c.selected = false)}>Select none</button>
						<button class="btn small primary" type="button"
							onclick={addSelectedExpenses}
							disabled={!expCandidates.some(c => c.selected)}>
							Add {expCandidates.filter(c => c.selected).length} expense{expCandidates.filter(c => c.selected).length !== 1 ? 's' : ''}
						</button>
						<button class="btn small" type="button"
							onclick={() => { expCandidates = []; expExtractMsg = ''; }}>Clear</button>
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
				<input name="description" placeholder="Description (required)" required bind:value={expDraft.description} />
				<div class="form-row">
					<input name="amount" placeholder="$0.00" inputmode="decimal" required bind:value={expDraft.amount} />
					<select name="attachment_id" aria-label="linked document" bind:value={expDraft.attachment_id}>
						<option value="">Link document (optional)</option>
						{#each data.attachments as a (a.id)}
							<option value={a.id}>{a.display_name || a.original_name}</option>
						{/each}
					</select>
				</div>
				<textarea name="notes" rows="1" placeholder="Notes (optional)" bind:value={expDraft.notes}></textarea>
				<button class="btn small primary" type="submit">Add expense</button>
			</form>
		</details>
	{/if}
	{/if}
</div>

<!-- ── Trip actions ───────────────────────────────────── -->
{#if !isViewer}
	<div class="form-actions">
		<a class="btn" href="/trips/{data.trip.id}/edit">Edit trip</a>
		<form method="POST" action="?/duplicate" use:enhance class="inline">
			<button class="btn" type="submit">Duplicate</button>
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
{/if}

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape') pendingDelete = null;
	}}
/>

<style>
	.back {
		text-decoration: none;
		font-size: 0.85rem;
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
		width: 24px;
		height: 24px;
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
		gap: 8px;
		margin: 4px 0;
		font-size: 0.85rem;
	}
	.tree-tools .sep {
		color: var(--muted);
	}
	.linkbtn {
		background: none;
		border: none;
		padding: 0;
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
		gap: 6px;
		margin-top: 4px;
	}
	.chip-link {
		font-size: 0.78rem;
		padding: 3px 9px;
		border: 0;
		border-radius: 999px;
		background: var(--accent-soft);
		color: var(--accent);
		text-decoration: none;
		min-height: 28px;
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
		padding: 3px 9px;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: var(--card);
		color: var(--link);
		text-decoration: none;
		min-height: 28px;
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
		min-width: 30px;
		min-height: 32px;
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
		min-width: 30px;
		min-height: 32px;
		color: var(--muted);
		font-size: 0.8rem;
	}
	.insert-row {
		margin: 2px 0;
	}
	.drag-handle {
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
			display: none;
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
	.paste summary,
	.dayplan-details summary {
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
	.add-row input[name='title'],
	.add-row input[name='name'] {
		flex: 1;
		min-width: 140px;
	}
	.add-row textarea[name='notes'] {
		flex: 1 0 100%;
		min-height: 64px;
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
	.dayplan-list {
		display: grid;
		gap: 10px;
	}
	.dayplan-card {
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 12px;
		background: var(--card);
	}
	.dayplan-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 10px;
	}
	.dayplan-actions {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		flex-wrap: wrap;
		justify-content: flex-end;
	}
	.dayplan-details {
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
		align-items: flex-start;
		gap: 8px;
		flex: 1;
		min-width: 0;
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
		min-width: 30px;
		min-height: 32px;
		color: var(--muted);
	}
	.dayplan-stop-links button:disabled,
	.builder-controls button:disabled {
		opacity: 0.45;
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
	.quick-groups {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 8px;
		align-items: center;
	}
	.dayplan-builder {
		display: grid;
		gap: 8px;
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 12px;
		margin-top: 12px;
		background: var(--bg);
	}
	.dayplan-builder textarea {
		width: 100%;
	}
	.dayplan-picker {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}
	.dayplan-picker select {
		flex: 1 1 220px;
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
		min-width: 30px;
		min-height: 32px;
		color: var(--muted);
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
		min-width: 30px;
		min-height: 32px;
		color: var(--muted);
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
	.import-target select,
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
	@media print {
		.dayplan-actions,
		.dayplan-stop-links,
		.dayplan-note-form,
		.dayplan-builder,
		.dayplan-visited input,
		.leg-links {
			display: none !important;
		}
		.dayplan-card {
			border: none;
			padding: 0;
			break-inside: avoid;
		}
		.dayplan-details {
			display: block;
		}
		.dayplan-details summary {
			display: none;
		}
		.dayplan-stops li {
			padding: 1pt 0;
			border-top: none;
		}
	}
</style>
