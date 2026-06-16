<script lang="ts">
	import { enhance } from '$app/forms';

	interface Values {
		name?: string;
		start_date?: string | null;
		end_date?: string | null;
		notes?: string | null;
	}

	let {
		values = {},
		error = null,
		submitLabel = 'Save',
		cancelHref = '/'
	}: {
		values?: Values;
		error?: string | null;
		submitLabel?: string;
		cancelHref?: string;
	} = $props();

	let submitting = $state(false);
</script>

<form
	method="POST"
	use:enhance={() => {
		submitting = true;
		return async ({ update }) => {
			await update();
			submitting = false;
		};
	}}
	novalidate
>
	<label class="field">
		<span>Trip name</span>
		<input name="name" required maxlength="200" value={values.name ?? ''} />
	</label>

	<div class="field">
		<div class="row">
			<label>
				<span>Start date</span>
				<input type="date" name="start_date" value={values.start_date ?? ''} />
			</label>
			<label>
				<span>End date</span>
				<input type="date" name="end_date" value={values.end_date ?? ''} />
			</label>
		</div>
	</div>

	<label class="field">
		<span>Notes</span>
		<textarea name="notes" rows="4">{values.notes ?? ''}</textarea>
	</label>

	{#if error}
		<p style="color: var(--danger)" role="alert">{error}</p>
	{/if}

	<div class="form-actions">
		<button class="btn primary" type="submit" disabled={submitting}>
			{submitting ? 'Saving…' : submitLabel}
		</button>
		<a class="btn" href={cancelHref}>Cancel</a>
	</div>
</form>
