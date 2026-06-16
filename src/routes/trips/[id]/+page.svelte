<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const isViewer = $derived(data.user?.role === 'viewer');
	let confirming = $state(false);

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
</script>

<svelte:head><title>{data.trip.name}</title></svelte:head>

<div class="page-head">
	<a class="muted" href="/" style="text-decoration: none; font-size: 0.85rem">← All trips</a>
	<h1>{data.trip.name}</h1>
	<div class="sub">{fmtRange(data.trip.start_date, data.trip.end_date)}</div>
</div>

{#if data.trip.notes}
	<div class="card">
		<h2>Notes</h2>
		<p style="white-space: pre-wrap">{data.trip.notes}</p>
	</div>
{/if}

<div class="card">
	<h2>Sections</h2>
	<p class="muted">Places and packing arrive in Phase 2.</p>
</div>

{#if !isViewer}
	<div class="form-actions">
		<a class="btn" href="/trips/{data.trip.id}/edit">Edit</a>
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
