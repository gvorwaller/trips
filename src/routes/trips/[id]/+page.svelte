<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
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
	let confirming = $state(false);
	let selectedPin = $state<number | null>(null);

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
{#snippet treeControls(id: number, moveAction: string, deleteAction: string, listId: number | null)}
	<span class="row-controls">
		{#each [['indent', '⇥'], ['outdent', '⇤'], ['move-up', '↑'], ['move-down', '↓']] as [op, glyph] (op)}
			<form method="POST" action="?/{moveAction}" use:enhance>
				<input type="hidden" name="id" value={id} />
				{#if listId !== null}<input type="hidden" name="list_id" value={listId} />{/if}
				<input type="hidden" name="op" value={op} />
				<button type="submit" title={op}>{glyph}</button>
			</form>
		{/each}
		<form method="POST" action="?/{deleteAction}" use:enhance>
			<input type="hidden" name="id" value={id} />
			{#if listId !== null}<input type="hidden" name="list_id" value={listId} />{/if}
			<button type="submit" class="del" title="delete">✕</button>
		</form>
	</span>
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
		<ul class="outline">
			{#each data.itineraryRows as { node, depth } (node.id)}
				{@const route =
					node.item_type === 'day' || node.item_type === 'section' ? dayDirections(node.id) : null}
				<li
					id="itin-{node.id}"
					style="padding-left: {depth * 22}px"
					class:flash={selectedPin === node.id}
				>
					<div class="line">
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
						{#if !isViewer}{@render treeControls(node.id, 'itin-move', 'itin-delete', null)}{/if}
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
		<section class="plist">
			<div class="plist-head">
				<strong>{list.name}</strong>
				<span class="muted">{checked} / {total} packed</span>
				{#if !isViewer}
					<form method="POST" action="?/list-delete" use:enhance class="inline">
						<input type="hidden" name="list_id" value={list.id} />
						<button class="del" type="submit" title="delete list">✕ list</button>
					</form>
				{/if}
			</div>
			{#if total > 0}
				<div class="progress">
					<span style="width: {Math.round((checked / total) * 100)}%"></span>
				</div>
			{/if}

			<ul class="outline">
				{#each rows as { node, depth } (node.id)}
					<li style="padding-left: {depth * 22}px">
						<div class="line">
							<input
								type="checkbox"
								class="chk"
								checked={node.checked}
								onchange={(e) => toggleCheck(node.id, e.currentTarget.checked)}
							/>
							<span class="grow" class:done={node.checked}>
								{node.name}{#if node.quantity > 1}<span class="muted"> ×{node.quantity}</span>{/if}
							</span>
							{#if !isViewer}{@render treeControls(
									node.id,
									'pack-move',
									'pack-delete',
									list.id
								)}{/if}
						</div>
					</li>
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
					<form method="POST" action="?/tmpl-apply" use:enhance class="inline">
						<input type="hidden" name="template_id" value={t.id} />
						<button class="btn small" type="submit">{t.name} ({t.item_count})</button>
					</form>
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
							<form method="POST" action="?/res-delete" use:enhance>
								<input type="hidden" name="id" value={r.id} />
								<button type="submit" class="del" title="delete">✕</button>
							</form>
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
			<form method="POST" action="?/res-add" use:enhance class="edit-form">
				<select name="reservation_type" aria-label="type">
					{#each ['accommodation', 'flight', 'restaurant', 'transport', 'other'] as t (t)}
						<option value={t}>{t}</option>
					{/each}
				</select>
				<input name="title" placeholder="Title (e.g. Hôtel d'Europe)" required />
				<input name="confirmation_code" placeholder="Confirmation code" />
				<label class="dt">Start <input type="datetime-local" name="start_at" /></label>
				<label class="dt">End <input type="datetime-local" name="end_at" /></label>
				<textarea name="notes" rows="2" placeholder="Notes"></textarea>
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
							<a
								class="ttl"
								href="/trips/{data.trip.id}/attachments/{a.id}"
								target="_blank"
								rel="noopener">{a.original_name}</a
							>
							<div class="meta">{a.mime_type} · {fmtSize(a.size_bytes)}</div>
						</span>
						{#if !isViewer}
							<form method="POST" action="?/attach-delete" use:enhance>
								<input type="hidden" name="id" value={a.id} />
								<button type="submit" class="del" title="delete">✕</button>
							</form>
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
	{/if}
</div>

<!-- ── Trip actions ───────────────────────────────────── -->
{#if !isViewer}
	<div class="form-actions">
		<a class="btn" href="/trips/{data.trip.id}/edit">Edit trip</a>
		<form method="POST" action="?/duplicate" use:enhance class="inline">
			<button class="btn" type="submit">Duplicate</button>
		</form>
		<button class="btn danger" type="button" onclick={() => (confirming = true)}>Delete</button>
	</div>

	<div class="modal-overlay" class:open={confirming}>
		<div class="modal" role="dialog" aria-modal="true" aria-labelledby="del-title">
			<h3 id="del-title">Delete this trip?</h3>
			<p>“{data.trip.name}” and everything in it will be permanently removed.</p>
			<div class="actions">
				<button class="btn" type="button" onclick={() => (confirming = false)}>Cancel</button>
				<form method="POST" action="?/delete" use:enhance>
					<button class="btn danger" type="submit">Delete trip</button>
				</form>
			</div>
		</div>
	</div>
{/if}

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
</style>
