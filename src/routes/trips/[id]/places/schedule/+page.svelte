<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { googleMapsLink, googleDirectionsLink } from '$lib/maplinks';
	import { dateStatus, rangeWarning } from '$lib/place-date';

	let { data } = $props();
	const isViewer = $derived(data.user?.role === 'viewer');

	/** Places ticked for a bulk assign, keyed by id. */
	let selected = $state<Record<number, boolean>>({});
	let bulkDate = $state('');
	let editError = $state('');
	const selectedIds = $derived(
		Object.entries(selected)
			.filter(([, on]) => on)
			.map(([id]) => Number(id))
	);

	/** Advisory only — an out-of-range date still saves. */
	function warnFor(value: string): string | null {
		if (!value) return null;
		return rangeWarning(dateStatus(value, data.trip.start_date, data.trip.end_date));
	}

	function toggleGroup(ids: number[], on: boolean) {
		const next = { ...selected };
		for (const id of ids) next[id] = on;
		selected = next;
	}

	function fmtDate(date: string, includeYear = true): string {
		return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
			weekday: 'long',
			month: 'long',
			day: 'numeric',
			year: includeYear ? 'numeric' : undefined
		});
	}

	function fmtRange(start: string | null, end: string | null): string {
		if (start && end) return `${fmtDate(start)} – ${fmtDate(end)}`;
		if (start) return `Starts ${fmtDate(start)}`;
		if (end) return `Ends ${fmtDate(end)}`;
		return 'No trip dates set';
	}

	function rangeLabel(status: 'before' | 'during' | 'after' | 'unknown'): string | null {
		if (status === 'before') return 'Before trip';
		if (status === 'after') return 'After trip';
		return null;
	}

	function placeMap(place: {
		title: string;
		lat: number | null;
		lon: number | null;
		place_id: string | null;
		apple_maps_place_id: string | null;
	}) {
		return {
			name: place.title,
			lat: place.lat,
			lon: place.lon,
			place_id: place.place_id,
			apple_maps_place_id: place.apple_maps_place_id
		};
	}
</script>

<svelte:head><title>Places schedule - {data.trip.name}</title></svelte:head>

<div class="page-head schedule-head">
	<a class="muted back" href="/trips/{data.trip.id}#places">← {data.trip.name}</a>
	<h1>Places schedule</h1>
	<div class="sub">{fmtRange(data.trip.start_date, data.trip.end_date)}</div>
	<div class="head-actions">
		<a class="btn small" href="/trips/{data.trip.id}#places">Edit dates in Places</a>
		<button type="button" class="btn small print-btn" onclick={() => window.print()}>
			🖨 Print
		</button>
	</div>
</div>

<div class="card overview">
	<div>
		<strong>{data.schedule.datedCount}</strong>
		<span>Dated</span>
	</div>
	<div>
		<strong>{data.schedule.undatedCount}</strong>
		<span>Unscheduled</span>
	</div>
	<div class:warning={data.schedule.outsideTripCount > 0}>
		<strong>{data.schedule.outsideTripCount}</strong>
		<span>Outside trip dates</span>
	</div>
</div>

<p class="schedule-note">
	This is a chronological view of Places only. Your Places hierarchy and manual ordering are
	unchanged.
</p>

{#if data.schedule.dateGroups.length === 0}
	<div class="card empty">
		<h2>No dated places yet</h2>
		<p>Open a place’s edit controls to assign the day you expect to visit it.</p>
	</div>
{:else}
	<div class="dated-groups">
		{#each data.schedule.dateGroups as group (group.date)}
			<section
				class="card date-group"
				class:outside={group.status === 'before' || group.status === 'after'}
			>
				<header>
					<div>
						<time datetime={group.date}>{fmtDate(group.date)}</time>
						{#if rangeLabel(group.status)}
							<span class="range-warning">{rangeLabel(group.status)}</span>
						{/if}
					</div>
					<span class="count"
						>{group.places.length} place{group.places.length === 1 ? '' : 's'}</span
					>
				</header>
				<ul class="place-list">
					{#each group.places as place (place.id)}
						<li>
							<div class="place-main">
								<a class="place-title" href="/trips/{data.trip.id}#itin-{place.id}">
									{place.title}
								</a>
								<div class="breadcrumb">
									{place.ancestorTitles.length > 0 ? place.ancestorTitles.join(' › ') : 'Top level'}
								</div>
								{#if place.notes}<div class="notes">{place.notes}</div>{/if}
							</div>
							<div class="place-actions">
								<a href={googleMapsLink(placeMap(place))} target="_blank" rel="noopener">Map</a>
								<a href={googleDirectionsLink(placeMap(place))} target="_blank" rel="noopener"
									>Directions</a
								>
							</div>
							{#if !isViewer}
								<form
									method="POST"
									action="?/set-date"
									class="date-form"
									use:enhance={() => {
										editError = '';
										return async ({ result, update }) => {
											if (result.type === 'failure') {
												editError = (result.data as { error?: string })?.error ?? 'Could not save.';
												return;
											}
											await update({ reset: false });
											await invalidateAll();
										};
									}}
								>
									<input type="hidden" name="id" value={place.id} />
									<input type="date" name="date" value={place.date ?? ''} aria-label="Date" />
									<button class="btn tiny" type="submit">Save</button>
									<!-- Distinct field name: a second control also called "date" loses to
									     the input above it, because form.get() returns the first value. -->
									<button
										class="btn tiny"
										type="submit"
										name="clear"
										value="1"
										title="Remove this date">Clear</button
									>
								</form>
							{/if}
						</li>
					{/each}
				</ul>
			</section>
		{/each}
	</div>
{/if}

<details class="card backlog" open={data.schedule.dateGroups.length === 0}>
	<summary>
		<span>Unscheduled places</span>
		<span class="count">{data.schedule.undatedCount}</span>
	</summary>
	{#if data.schedule.undatedGroups.length === 0}
		<p class="all-scheduled">Every place has a date.</p>
	{:else}
		{#if isViewer}
			<p class="backlog-note">Use this as the planning backlog.</p>
		{:else}
			<p class="backlog-note">
				Dates are optional — most days get planned as you go. Set one where the timing is fixed: a
				market that only runs Saturday, a booked dinner.
			</p>
			<form
				method="POST"
				action="?/bulk-set-date"
				class="bulk-bar"
				use:enhance={() => {
					editError = '';
					return async ({ result, update }) => {
						if (result.type === 'failure') {
							editError = (result.data as { error?: string })?.error ?? 'Could not save.';
							return;
						}
						await update({ reset: false });
						selected = {};
						bulkDate = '';
						await invalidateAll();
					};
				}}
			>
				{#each selectedIds as id (id)}
					<input type="hidden" name="ids" value={id} />
				{/each}
				<input type="date" name="date" bind:value={bulkDate} aria-label="Date for selected places" />
				<button class="btn small primary" type="submit" disabled={!bulkDate || selectedIds.length === 0}>
					Assign to {selectedIds.length} selected
				</button>
				{#if warnFor(bulkDate)}
					<span class="range-warning">{warnFor(bulkDate)}</span>
				{/if}
			</form>
			{#if editError}
				<p class="field-error" role="alert">{editError}</p>
			{/if}
		{/if}
		{#each data.schedule.undatedGroups as group (group.title)}
			<section class="backlog-group">
				<h2>
					{group.title}
					{#if !isViewer}
						<button
							type="button"
							class="btn tiny"
							onclick={() =>
								toggleGroup(
									group.places.map((p) => p.id),
									!group.places.every((p) => selected[p.id])
								)}
						>
							{group.places.every((p) => selected[p.id]) ? 'Clear' : 'Select all'}
						</button>
					{/if}
				</h2>
				<ul class="place-list compact">
					{#each group.places as place (place.id)}
						<li>
							{#if !isViewer}
								<input
									type="checkbox"
									checked={selected[place.id] ?? false}
									onchange={(e) => (selected = { ...selected, [place.id]: e.currentTarget.checked })}
									aria-label={`Select ${place.title}`}
								/>
							{/if}
							<div class="place-main">
								<a class="place-title" href="/trips/{data.trip.id}#itin-{place.id}">
									{place.title}
								</a>
								{#if place.ancestorTitles.length > 0}
									<div class="breadcrumb">{place.ancestorTitles.join(' › ')}</div>
								{/if}
							</div>
							<div class="place-actions">
								<a href={googleMapsLink(placeMap(place))} target="_blank" rel="noopener">Map</a>
							</div>
						</li>
					{/each}
				</ul>
			</section>
		{/each}
	{/if}
</details>

<style>
	.date-form {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		align-items: center;
		margin-top: 6px;
	}
	.date-form input[type='date'] {
		min-height: 48px;
		font-size: 16px;
	}
	.bulk-bar {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: center;
		margin: 8px 0;
	}
	.bulk-bar input[type='date'] {
		min-height: 48px;
		font-size: 16px;
	}
	.btn.tiny {
		min-height: 48px;
		padding: 4px 10px;
		font-size: 0.8rem;
	}
	.backlog-group input[type='checkbox'] {
		width: 24px;
		height: 24px;
		margin-right: 8px;
		flex: none;
	}
	/* The printed schedule is a reference sheet — editing controls have no place on it. */
	@media print {
		.date-form,
		.bulk-bar,
		.backlog-group input[type='checkbox'],
		.btn.tiny {
			display: none !important;
		}
	}
	.back {
		text-decoration: none;
		font-size: 0.85rem;
	}
	.schedule-head {
		display: grid;
		gap: 3px;
	}
	.head-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 8px;
	}
	.head-actions a {
		text-decoration: none;
	}
	.overview {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 8px;
		text-align: center;
	}
	.overview div {
		min-width: 0;
		padding: 8px 4px;
		border-radius: 8px;
		background: var(--bg);
	}
	.overview strong,
	.overview span {
		display: block;
	}
	.overview strong {
		font-size: 1.25rem;
	}
	.overview span {
		color: var(--muted);
		font-size: 0.75rem;
	}
	.overview .warning {
		background: var(--need-bg);
		color: var(--need-text);
	}
	.overview .warning span {
		color: var(--need-text);
	}
	.schedule-note {
		color: var(--muted);
		font-size: 0.88rem;
		margin: -2px 0 12px;
	}
	.dated-groups {
		display: grid;
		gap: 12px;
	}
	.date-group {
		margin: 0;
		padding: 0;
		overflow: hidden;
	}
	.date-group > header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 10px;
		padding: 12px 14px;
		background: var(--accent-soft);
		border-bottom: 1px solid var(--border);
	}
	.date-group > header time {
		font-weight: 700;
	}
	.date-group.outside > header {
		background: var(--need-bg);
		color: var(--need-text);
	}
	.range-warning {
		display: block;
		margin-top: 2px;
		font-size: 0.78rem;
		font-weight: 700;
	}
	.count {
		flex-shrink: 0;
		color: var(--muted);
		font-size: 0.8rem;
	}
	.place-list {
		list-style: none;
		margin: 0;
		padding: 0 14px;
	}
	.place-list li {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 11px 0;
		border-top: 1px solid var(--border);
	}
	.place-list li:first-child {
		border-top: 0;
	}
	.place-main {
		flex: 1;
		min-width: 0;
	}
	.place-title {
		font-weight: 650;
		overflow-wrap: anywhere;
	}
	.breadcrumb,
	.notes,
	.backlog-note,
	.all-scheduled {
		color: var(--muted);
		font-size: 0.82rem;
	}
	.notes {
		margin-top: 3px;
		white-space: pre-wrap;
	}
	.place-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 7px;
		flex-shrink: 0;
	}
	.place-actions a {
		font-size: 0.78rem;
	}
	.backlog {
		margin-top: 14px;
	}
	.backlog > summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		font-weight: 700;
		cursor: pointer;
		min-height: 44px;
	}
	.backlog-note {
		margin: 4px 0 14px;
	}
	.backlog-group {
		margin-top: 16px;
	}
	.backlog-group h2 {
		margin: 0;
		padding-bottom: 4px;
		border-bottom: 1px solid var(--border);
		font-size: 0.95rem;
	}
	.place-list.compact {
		padding: 0;
	}
	.place-list.compact li {
		padding: 8px 0;
	}
	.empty p {
		color: var(--muted);
	}

	@media (min-width: 640px) {
		.overview {
			max-width: 620px;
		}
		.date-group > header,
		.place-list {
			padding-left: 18px;
			padding-right: 18px;
		}
	}

	@media print {
		.head-actions,
		.schedule-note,
		.backlog {
			display: none !important;
		}
		.overview {
			display: flex;
			gap: 18pt;
			text-align: left;
			margin-bottom: 8pt;
		}
		.overview div {
			padding: 0;
			background: none !important;
		}
		.overview strong,
		.overview span {
			display: inline;
		}
		.overview strong {
			font-size: inherit;
			margin-right: 3pt;
		}
		.dated-groups {
			display: block;
		}
		.date-group {
			break-inside: avoid;
			margin-bottom: 8pt;
		}
		.date-group > header {
			padding: 3pt 0;
			background: none !important;
			border-bottom: 1px solid #777;
		}
		.place-list {
			padding: 0;
		}
		.place-list li {
			padding: 2pt 0;
		}
		.place-actions {
			display: none;
		}
		.notes,
		.breadcrumb {
			font-size: 8pt;
		}
	}
</style>
