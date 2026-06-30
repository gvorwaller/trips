<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const isViewer = $derived(data.user?.role === 'viewer');

	function fmtRange(start: string | null, end: string | null): string {
		if (!start && !end) return 'No dates set';
		const f = (d: string) =>
			new Date(d + 'T00:00:00').toLocaleDateString(undefined, {
				month: 'short',
				day: 'numeric',
				year: 'numeric'
			});
		if (start && end) return `${f(start)} – ${f(end)}`;
		return f((start ?? end) as string);
	}

	function fmtUpdated(value: string): string {
		const d = new Date(value);
		if (Number.isNaN(d.getTime())) return 'Updated date unknown';
		return `Updated ${d.toLocaleDateString(undefined, {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		})} ${d.toLocaleTimeString(undefined, {
			hour: 'numeric',
			minute: '2-digit'
		})}`;
	}
</script>

<svelte:head><title>Trips</title></svelte:head>

<div class="page-head trip-row" style="justify-content: space-between">
	<h1>Trips</h1>
	{#if !isViewer}
		<a class="btn primary small" href="/trips/new">＋ New trip</a>
	{/if}
</div>

{#if data.trips.length === 0}
	<div class="card empty">
		<p>No trips yet.</p>
		{#if !isViewer}
			<p><a class="btn primary" href="/trips/new">Create your first trip</a></p>
		{/if}
	</div>
{:else}
	<div class="card">
		{#each data.trips as trip (trip.id)}
			<div class="obs">
				<div class="grow">
					<div class="name"><a href="/trips/{trip.id}">{trip.name}</a></div>
					<div class="meta">{fmtRange(trip.start_date, trip.end_date)}</div>
					<div class="meta">{fmtUpdated(trip.updated_at)}</div>
				</div>
			</div>
		{/each}
	</div>
{/if}
