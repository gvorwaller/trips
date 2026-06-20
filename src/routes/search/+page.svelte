<script lang="ts">
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();

	const KIND_LABEL: Record<string, string> = {
		trip: 'Trip',
		place: 'Place',
		packing: 'Packing',
		reservation: 'Reservation',
		document: 'Document',
		expense: 'Expense'
	};
</script>

<svelte:head><title>Search</title></svelte:head>

<div class="page-head"><h1>Search</h1></div>

<form method="GET" class="search-form">
	<input name="q" type="search" placeholder="Search trips, places, packing…" value={data.q} />
	<button class="btn small primary" type="submit">Search</button>
</form>

{#if data.q.trim().length >= 2}
	{#if data.hits.length === 0}
		<p class="muted">No matches for “{data.q}”.</p>
	{:else}
		<div class="card">
			{#each data.hits as hit, i (hit.kind + '-' + (hit.item_id ?? 'trip') + '-' + i)}
				<div class="obs">
					<div class="grow">
						<div class="name"><a href="/trips/{hit.trip_id}">{hit.title}</a></div>
						<div class="meta">{KIND_LABEL[hit.kind] ?? hit.kind} · in {hit.trip_name}</div>
					</div>
				</div>
			{/each}
		</div>
	{/if}
{:else}
	<p class="muted">Type at least two characters.</p>
{/if}

<style>
	.search-form {
		display: flex;
		gap: 8px;
		margin-bottom: 16px;
	}
	.search-form input {
		flex: 1;
		font-size: 1rem;
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-radius: 8px;
	}
	.muted {
		color: var(--muted);
	}
</style>
