<script lang="ts">
	import TripForm from '$components/TripForm.svelte';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();
</script>

<svelte:head><title>New trip</title></svelte:head>

<div class="page-head"><h1>New trip</h1></div>

<div class="card">
	<TripForm values={form?.values ?? {}} error={form?.error ?? null} submitLabel="Create trip" />
</div>
