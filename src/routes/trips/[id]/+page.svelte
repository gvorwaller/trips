<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import PinMap from '$components/PinMap.svelte';
	import {
		googleMapsLink,
		appleMapsLink,
		googleDirectionsLink,
		googleDayDirectionsLink,
		type MapPlace
	} from '$lib/maplinks';
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
</script>

<svelte:head><title>{data.trip.name}</title></svelte:head>

<div class="page-head">
	<a class="muted back" href="/">← All trips</a>
	<h1>{data.trip.name}</h1>
	<div class="sub">{fmtRange(data.trip.start_date, data.trip.end_date)}</div>
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
						? `“${label}” and everything nested under it will be permanently removed.`
						: `“${label}” will be permanently removed.`,
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

<!-- ── PLACES ─────────────────────────────────────────── -->
<div class="card">
	<h2>Places</h2>

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
										>Directions for the day</a
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
							<form method="POST" action="?/itin-edit" use:enhance class="edit-form">
								<input type="hidden" name="id" value={node.id} />
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
	{/if}
</div>

<!-- ── PACKING ────────────────────────────────────────── -->
<div class="card">
	<h2>Packing</h2>
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
								body: `“${list.name}” and all ${total} item${total === 1 ? '' : 's'} in it will be permanently removed.`,
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
						<li style="padding-left: {depth * 22}px">
							<div class="line">
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
							</span>
							{#if !isViewer}
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
								)}{/if}
						</div>
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
					<button class="btn small" type="submit">Add starter “Essentials” template</button>
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
										body: `“${t.name}” will be permanently removed. Packing lists already created from it are not affected.`,
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

<!-- ── RESERVATIONS ───────────────────────────────────── -->
<div class="card">
	<h2>Reservations</h2>
	{#if data.reservations.length === 0}
		<p class="muted">No reservations yet.</p>
	{:else}
		<ul class="outline">
			{#each data.reservations as r (r.id)}
				<li>
					<div class="line">
						<span class="badge need">{r.reservation_type}</span>
						<span class="grow">
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
							{#if r.notes}<div class="meta">{r.notes}</div>{/if}
						</span>
						{#if !isViewer}
							<button
								type="button"
								class="del"
								title="delete"
								onclick={() =>
									(pendingDelete = {
										action: 'res-delete',
										fields: { id: r.id },
										heading: 'Delete this reservation?',
										body: `“${r.title}” will be permanently removed.`,
										confirmLabel: 'Delete'
									})}>✕</button
							>
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
</div>

<!-- ── ATTACHMENTS ────────────────────────────────────── -->
<div class="card">
	<h2>Documents</h2>
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
									<summary class="ttl">{a.original_name}</summary>
									<pre class="textdoc-body">{a.text_content}</pre>
								</details>
								<div class="meta">text · {fmtSize(a.size_bytes)}</div>
							{:else}
								<a
									class="ttl"
									href="/trips/{data.trip.id}/attachments/{a.id}"
									target="_blank"
									rel="noopener">{a.original_name}</a
								>
								<div class="meta">{a.mime_type} · {fmtSize(a.size_bytes)}</div>
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
										body: `“${a.original_name}” will be permanently removed from storage.`,
										confirmLabel: 'Delete'
									})}>✕</button
							>
						{/if}
					</div>
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
			class="add-row"
		>
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
					body: `“${data.trip.name}” and everything in it will be permanently removed.`,
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
		align-items: center;
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
	}
	.meta {
		color: var(--muted);
		font-size: 0.85rem;
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
	.edit summary,
	.paste summary {
		cursor: pointer;
		color: var(--link);
		font-size: 0.8rem;
		padding: 2px 0;
	}
	.edit-form input,
	.edit-form textarea,
	.add-row input,
	.add-row select,
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
</style>
