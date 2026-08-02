<script lang="ts">
	import { appleMapsLink, googleMapsLink, type MapPlace } from '$lib/maplinks';
	import { legSummary, returnLegSummary, routeSummary } from '$lib/dayplan-driving';
	import { formatPlanDate } from '$lib/dayplan-export';
	import { cleanAnchorTitle } from '$lib/dayplan-anchor';

	let { data } = $props();

	const anchor = $derived(
		data.plan.anchor_title && data.plan.anchor_lat != null && data.plan.anchor_lon != null
			? {
					title: cleanAnchorTitle(data.plan.anchor_title),
					lat: data.plan.anchor_lat,
					lon: data.plan.anchor_lon
				}
			: null
	);

	const summary = $derived(routeSummary(data.plan, data.stops, anchor, data.unit));
	const home = $derived(returnLegSummary(data.plan, data.stops, anchor, data.unit));

	function placeOf(stop: (typeof data.stops)[number]): MapPlace {
		return {
			name: stop.snapshot_title,
			lat: stop.snapshot_lat,
			lon: stop.snapshot_lon,
			place_id: stop.snapshot_place_id
		};
	}
</script>

<svelte:head><title>{data.plan.title} - {data.trip.name}</title></svelte:head>

<div class="page-head">
	<a class="muted back" href="/trips/{data.trip.id}">← {data.trip.name}</a>
	<h1>{data.plan.title}</h1>
	<div class="sub">
		{data.trip.name}{#if formatPlanDate(data.plan.optional_date)}
			· {formatPlanDate(data.plan.optional_date)}{/if}
	</div>
	<button type="button" class="btn small print-btn" onclick={() => window.print()}>🖨 Print</button>
</div>

<div class="card">
	<div class="plan-meta">
		{#if anchor}<div>Starting from <strong>{anchor.title}</strong></div>{/if}
		{#if summary}<div>Driving: {summary}</div>{/if}
	</div>

	{#if data.plan.notes}
		<p class="notes">{data.plan.notes}</p>
	{/if}

	{#if data.stops.length === 0}
		<p class="muted">No stops saved.</p>
	{:else}
		<ol class="stops">
			{#each data.stops as stop, i (stop.id)}
				{@const leg = legSummary(i > 0 ? data.stops[i - 1] : null, stop, anchor, data.unit)}
				<li>
					{#if leg}
						<div class="leg">
							Drive from {i === 0 && anchor ? anchor.title : 'previous'}: {leg}
						</div>
					{/if}
					<div class="stop">
						<span class="num">{i + 1}.</span>
						<div class="grow">
							<div class="ttl" class:done={stop.visited}>{stop.snapshot_title}</div>
							{#if stop.notes}<div class="note">{stop.notes}</div>{/if}
							{#if data.aiNotes && stop.ai_notes}<div class="note">{stop.ai_notes}</div>{/if}
							<div class="links">
								<a href={appleMapsLink(placeOf(stop))} target="_blank" rel="noopener">Apple</a>
								<a href={googleMapsLink(placeOf(stop))} target="_blank" rel="noopener">Google</a>
							</div>
						</div>
					</div>
				</li>
			{/each}
		</ol>

		{#if home && anchor}
			<div class="leg home">Drive home to {anchor.title}: {home}</div>
		{/if}
	{/if}
</div>

<style>
	.back {
		text-decoration: none;
		font-size: 0.85rem;
	}
	.plan-meta {
		color: var(--muted);
		font-size: 0.9rem;
		display: grid;
		gap: 2px;
		margin-bottom: 10px;
	}
	.notes {
		white-space: pre-wrap;
		margin: 0 0 12px;
	}
	.stops {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.stops li {
		border-top: 1px solid var(--border);
		padding: 6px 0;
	}
	.stop {
		display: flex;
		align-items: flex-start;
		gap: 8px;
	}
	.num {
		color: var(--muted);
		min-width: 1.6em;
	}
	.grow {
		flex: 1;
		min-width: 0;
	}
	.ttl {
		font-weight: 600;
	}
	.done {
		text-decoration: line-through;
		color: var(--muted);
	}
	.note {
		font-size: 0.9rem;
		white-space: pre-wrap;
		margin-top: 2px;
	}
	.links {
		display: flex;
		gap: 12px;
		margin-top: 4px;
		font-size: 0.85rem;
	}
	.leg {
		color: var(--muted);
		font-size: 0.85rem;
		padding: 2px 0;
	}
	.home {
		border-top: 1px solid var(--border);
		padding-top: 6px;
		font-weight: 600;
	}

	@media print {
		.back,
		.print-btn {
			display: none !important;
		}
		.stops li {
			break-inside: avoid;
		}
	}
</style>
