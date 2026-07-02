<script lang="ts">
	import MapPicker from '$components/MapPicker.svelte';
	import { type PickedLocation } from '$lib/google-maps';
	import { enhance } from '$app/forms';
	import { MAX_QUESTION_LENGTH } from '$lib/place-ai-shared';
	import { PLACE_DETAILS_STATUS_MESSAGE } from '$lib/place-details-status';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Starts null; the saved coords (if any) are the fallback in the hidden inputs.
	let picked = $state<PickedLocation | null>(null);
	const hasCoords = $derived(picked != null || data.item.lat != null);

	let asking = $state(false);

	function fmtFetched(value: string): string {
		const d = new Date(value);
		if (Number.isNaN(d.getTime())) return 'unknown time';
		return `${d.toLocaleDateString(undefined, {
			month: 'short',
			day: 'numeric'
		})} ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
	}
</script>

<svelte:head><title>Location · {data.item.title}</title></svelte:head>

<div class="page-head">
	<a class="muted back" href="/trips/{data.trip.id}">← {data.trip.name}</a>
	<h1>Place: {data.item.title}</h1>
	<div class="sub">Search or tap the map to set this place’s coordinates.</div>
</div>

<div class="card">
	<MapPicker bind:selected={picked} initialLat={data.item.lat} initialLng={data.item.lon} />

	{#if form?.error}<p style="color: var(--danger)" role="alert">{form.error}</p>{/if}

	<div class="form-actions" style="margin-top: 12px">
		<form method="POST" action="?/save">
			<input type="hidden" name="lat" value={picked?.lat ?? data.item.lat ?? ''} />
			<input type="hidden" name="lon" value={picked?.lng ?? data.item.lon ?? ''} />
			<input type="hidden" name="place_id" value={picked?.place_id ?? data.item.place_id ?? ''} />
			<button class="btn primary" type="submit" disabled={!hasCoords}>Save location</button>
		</form>
		{#if data.item.lat != null}
			<form method="POST" action="?/clear">
				<button class="btn danger" type="submit">Clear</button>
			</form>
		{/if}
		<a class="btn" href="/trips/{data.trip.id}">Cancel</a>
	</div>
</div>

{#if data.resolveCandidate}
	<div class="card">
		<h2>Possible Google match</h2>
		<p class="sub">
			This place has a saved pin but no linked Google place. The closest Google match is:
		</p>
		<p><strong>{data.resolveCandidate.name}</strong></p>
		<form method="POST" action="?/link-place" class="form-actions">
			<input type="hidden" name="place_id" value={data.resolveCandidate.place_id} />
			<button class="btn primary" type="submit">Link this match</button>
		</form>
	</div>
{/if}

{#if data.details}
	<div class="card">
		<h2>Known Details</h2>
		{#if data.details.status === 'ok'}
			{@const d = data.details.details}
			{#if d.summary}
				<div class="ai-summary">
					<p>{d.summary}</p>
					<p class="sub">
						{d.summaryDisclosure ?? 'Summarized with Gemini'} — treat as a helpful overview, not a verified
						fact.
						{#if d.summaryReportUri}
							<a href={d.summaryReportUri} target="_blank" rel="noopener noreferrer">Report</a>
						{/if}
					</p>
				</div>
			{/if}
			<dl class="details-list">
				{#if d.formattedAddress}
					<div>
						<dt>Address</dt>
						<dd>{d.formattedAddress}</dd>
					</div>
				{/if}
				{#if d.openingHoursWeekday?.length}
					<div>
						<dt>Hours</dt>
						<dd>
							{#each d.openingHoursWeekday as line (line)}
								<div>{line}</div>
							{/each}
						</dd>
					</div>
				{/if}
				{#if d.websiteUri}
					<div>
						<dt>Website</dt>
						<dd>
							<a href={d.websiteUri} target="_blank" rel="noopener noreferrer">{d.websiteUri}</a>
						</dd>
					</div>
				{/if}
				{#if d.phone}
					<div>
						<dt>Phone</dt>
						<dd>{d.phone}</dd>
					</div>
				{/if}
				{#if d.googleMapsUri}
					<div>
						<dt>Google Maps</dt>
						<dd><a href={d.googleMapsUri} target="_blank" rel="noopener noreferrer">Open</a></dd>
					</div>
				{/if}
				{#if d.userRatingCount}
					<div>
						<dt>Rating</dt>
						<dd>{d.rating} ({d.userRatingCount} ratings)</dd>
					</div>
				{/if}
				{#if d.businessStatus && d.businessStatus !== 'OPERATIONAL'}
					<div>
						<dt>Status</dt>
						<dd>{d.businessStatus}</dd>
					</div>
				{/if}
			</dl>
			<p class="sub">
				Fetched {fmtFetched(d.fetchedAt)}{d.stale
					? ' (showing last-known details — a refresh failed)'
					: ''}
			</p>
		{:else}
			<p class="sub">
				{PLACE_DETAILS_STATUS_MESSAGE[data.details.status] ?? 'Details are unavailable.'}
			</p>
		{/if}
		<form method="POST" action="?/refresh-details" class="form-actions" style="margin-top: 8px">
			<button class="btn" type="submit">Refresh details</button>
		</form>
		{#if form?.refreshError}
			<p style="color: var(--danger)" role="alert">{form.refreshError}</p>
		{/if}
	</div>
{/if}

<div class="card">
	<h2>Ask AI About This Place</h2>
	<p class="sub">
		Answers are hedged and grounded in known trip/place data — not a source for exact hours, prices,
		tickets, or schedules.
	</p>
	<form
		method="POST"
		action="?/ask-ai"
		use:enhance={() => {
			asking = true;
			return async ({ update }) => {
				await update();
				asking = false;
			};
		}}
	>
		<label class="field">
			<span>Question</span>
			<textarea
				name="question"
				maxlength={MAX_QUESTION_LENGTH}
				rows="2"
				placeholder="What should I know before visiting?"
				disabled={asking}
				required
			></textarea>
		</label>
		<div class="form-actions" style="margin-top: 8px">
			<button class="btn primary" type="submit" disabled={asking}>
				{asking ? 'Asking…' : 'Ask'}
			</button>
		</div>
	</form>

	{#if form?.askError}
		<p style="color: var(--danger)" role="alert">{form.askError}</p>
	{/if}
	{#if form?.askAnswer}
		<div class="ask-answer">
			<p class="sub">You asked: {form.askedQuestion}</p>
			<p>{form.askAnswer}</p>
			{#if form.askLimited}
				<p class="sub">Limited: no verified Google details for this place yet.</p>
			{/if}
		</div>
	{/if}
</div>

<style>
	.back {
		text-decoration: none;
		font-size: 0.85rem;
	}
	.form-actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}
	.form-actions form {
		margin: 0;
	}
	.details-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.details-list dt {
		font-size: 0.78rem;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}
	.details-list dd {
		margin: 2px 0 0;
	}
	.ask-answer {
		margin-top: 12px;
		padding-top: 12px;
		border-top: 1px solid var(--border);
	}
	.ai-summary {
		margin-bottom: 12px;
		padding-bottom: 12px;
		border-bottom: 1px solid var(--border);
	}
	.ai-summary p:first-child {
		font-style: italic;
	}
</style>
