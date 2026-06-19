<script lang="ts">
	let { data } = $props();

	type TreeRow = { node: { id: number; parent_id: number | null }; depth: number };
	type PackRow = { node: { id: number; parent_id: number | null; checked: boolean }; depth: number };

	const collapsed = $derived(new Set(data.collapsedIds));

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

	function hiddenIds(rows: TreeRow[], collapsedIds: Set<number>): Set<number> {
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
		for (const id of collapsedIds) if (kids.has(id)) walk(id);
		return hidden;
	}

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

	function fmtRange(a: string | null, b: string | null): string {
		const fmt = (s: string) =>
			new Date(`${s}T00:00:00`).toLocaleDateString(undefined, {
				weekday: 'short',
				month: 'short',
				day: 'numeric',
				year: 'numeric'
			});
		if (a && b) return `${fmt(a)} – ${fmt(b)}`;
		if (a) return fmt(a);
		if (b) return fmt(b);
		return '';
	}
</script>

<svelte:head><title>Packing - {data.trip.name}</title></svelte:head>

<div class="page-head">
	<a class="muted back" href="/trips/{data.trip.id}">← {data.trip.name}</a>
	<h1>{data.trip.name}</h1>
	<div class="sub">{fmtRange(data.trip.start_date, data.trip.end_date)}</div>
	<button type="button" class="btn small print-btn" onclick={() => window.print()}>🖨 Print</button>
</div>

<div class="card">
	<h2>Packing</h2>
	{#if data.packing.length === 0}
		<p class="muted">No packing lists yet.</p>
	{/if}

	{#each data.packing as { list, rows, total, checked } (list.id)}
		{@const hidden = hiddenIds(rows, collapsed)}
		{@const stats = leafStats(rows)}
		<section class="plist">
			<div class="plist-head">
				<strong>{list.name}</strong>
				<span class="muted">{checked} / {total} packed</span>
			</div>
			<ul class="outline">
				{#each rows as { node, depth } (node.id)}
					{#if !hidden.has(node.id)}
						<li style="padding-left: {depth * 22}px">
							<div class="line pack-print-line">
								<input
									type="checkbox"
									class="chk"
									checked={packChecked(stats.get(node.id))}
									indeterminate={packIndeterminate(stats.get(node.id))}
									disabled
								/>
								<span class="grow" class:done={packChecked(stats.get(node.id))}>
									{node.name}{#if node.quantity > 1}<span class="muted"> ×{node.quantity}</span>{/if}
									{#if node.notes}<div class="meta note">{node.notes}</div>{/if}
								</span>
							</div>
						</li>
					{/if}
				{/each}
			</ul>
		</section>
	{/each}
</div>

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
	.plist {
		margin-top: 14px;
	}
	.plist-head {
		display: flex;
		align-items: baseline;
		gap: 10px;
		flex-wrap: wrap;
		margin-bottom: 4px;
	}
	.line {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		min-height: 44px;
		padding: 4px 0;
	}
	.chk {
		width: 22px;
		height: 22px;
		flex-shrink: 0;
	}
	.grow {
		flex: 1;
		min-width: 0;
	}
	.done {
		text-decoration: line-through;
		color: var(--muted);
	}
	.meta {
		color: var(--muted);
		font-size: 0.85rem;
	}
</style>
