<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();
	let submitting = $state(false);
</script>

<svelte:head>
	<title>Sign in — trips</title>
</svelte:head>

<div class="login">
	<div class="card">
		<h1>trips</h1>
		<p class="subtitle">Sign in to continue.</p>

		<form
			method="POST"
			action="?/login"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update();
					submitting = false;
				};
			}}
			novalidate
		>
			<label>
				<span>Username</span>
				<input
					type="text"
					name="username"
					autocomplete="username"
					autocapitalize="none"
					autocorrect="off"
					spellcheck="false"
					required
					value={form?.username ?? ''}
				/>
			</label>
			<label>
				<span>Password</span>
				<input type="password" name="password" autocomplete="current-password" required />
			</label>

			{#if form?.error}
				<p class="error" role="alert">{form.error}</p>
			{/if}

			<button class="btn primary" type="submit" disabled={submitting}>
				{submitting ? 'Signing in…' : 'Sign in'}
			</button>
		</form>
	</div>
</div>

<style>
	.login {
		min-height: 70vh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 16px;
	}
	.card {
		width: 100%;
		max-width: 380px;
	}
	h1 {
		margin: 0 0 0.25rem;
		color: var(--accent);
	}
	.subtitle {
		margin: 0 0 1.25rem;
		color: var(--muted);
	}
	label {
		display: block;
		margin-bottom: 1rem;
	}
	label span {
		display: block;
		margin-bottom: 0.35rem;
		font-weight: 600;
	}
	input {
		width: 100%;
		font-size: 16px; /* >=16px avoids iOS zoom */
		padding: 12px;
		border: 1px solid var(--border);
		border-radius: 8px;
	}
	.error {
		color: var(--danger);
		margin: 0 0 1rem;
	}
	button {
		width: 100%;
	}
</style>
