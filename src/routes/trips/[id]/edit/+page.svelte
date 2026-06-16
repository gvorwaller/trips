<script lang="ts">
	import TripForm from '$components/TripForm.svelte';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const values = $derived(
		form?.values ?? {
			name: data.trip.name,
			start_date: data.trip.start_date,
			end_date: data.trip.end_date,
			notes: data.trip.notes
		}
	);
</script>

<svelte:head><title>Edit {data.trip.name}</title></svelte:head>

<div class="page-head"><h1>Edit trip</h1></div>

<div class="card">
	<TripForm
		{values}
		error={form?.error ?? null}
		submitLabel="Save changes"
		cancelHref="/trips/{data.trip.id}"
	/>
</div>
