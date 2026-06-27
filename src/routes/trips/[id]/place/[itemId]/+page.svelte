<script lang="ts">
	import MapPicker from '$components/MapPicker.svelte';
	import { type PickedLocation } from '$lib/google-maps';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Starts null; the saved coords (if any) are the fallback in the hidden inputs.
	let picked = $state<PickedLocation | null>(null);
	const hasCoords = $derived(picked != null || data.item.lat != null);
</script>

<svelte:head><title>Location · {data.item.title}</title></svelte:head>

<div class="page-head">
	<a class="muted back" href="/trips/{data.trip.id}">← {data.trip.name}</a>
	<h1>Location: {data.item.title}</h1>
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
</style>
