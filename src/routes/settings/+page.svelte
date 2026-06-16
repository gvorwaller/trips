<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	// Track which form is mid-submit so only its button shows the busy state.
	let busy = $state<string | null>(null);

	function submit(name: string) {
		busy = name;
		return async ({ update }: { update: () => Promise<void> }) => {
			await update();
			busy = null;
		};
	}

	const msg = (section: string) =>
		form && (form as { section?: string }).section === section ? form : null;
</script>

<svelte:head>
	<title>Settings — trips</title>
</svelte:head>

<div class="page-head">
	<h1>Settings</h1>
	<div class="sub">Manage your account and the viewer login.</div>
</div>

<!-- ── Your account ──────────────────────────────────────── -->
<section class="card">
	<h2>Your account</h2>
	<p class="who">
		Signed in as <strong>{data.me.username}</strong>
	</p>

	<form method="POST" action="?/profile" use:enhance={() => submit('profile')}>
		<label class="field">
			<span>Display name</span>
			<input name="display_name" value={data.me.display_name} maxlength="120" required />
		</label>
		{#if msg('profile')?.error}<p class="error" role="alert">{msg('profile')?.error}</p>{/if}
		{#if msg('profile')?.ok}<p class="ok" role="status">Display name saved.</p>{/if}
		<div class="form-actions">
			<button class="btn primary" type="submit" disabled={busy === 'profile'}>
				{busy === 'profile' ? 'Saving…' : 'Save name'}
			</button>
		</div>
	</form>

	<hr />

	<h3>Change password</h3>
	<form method="POST" action="?/password" use:enhance={() => submit('password')}>
		<label class="field">
			<span>Current password</span>
			<input type="password" name="current_password" autocomplete="current-password" required />
		</label>
		<label class="field">
			<span>New password</span>
			<input
				type="password"
				name="new_password"
				autocomplete="new-password"
				minlength="8"
				required
			/>
		</label>
		<label class="field">
			<span>Confirm new password</span>
			<input
				type="password"
				name="confirm_password"
				autocomplete="new-password"
				minlength="8"
				required
			/>
		</label>
		{#if msg('password')?.error}<p class="error" role="alert">{msg('password')?.error}</p>{/if}
		{#if msg('password')?.ok}
			<p class="ok" role="status">Password changed. Other devices have been signed out.</p>
		{/if}
		<div class="form-actions">
			<button class="btn primary" type="submit" disabled={busy === 'password'}>
				{busy === 'password' ? 'Updating…' : 'Update password'}
			</button>
		</div>
	</form>
</section>

<!-- ── Viewer account ────────────────────────────────────── -->
<section class="card">
	<h2>Viewer account</h2>
	<p class="muted">
		The viewer has read-only access and can check off packing items, but cannot edit anything.
	</p>

	{#if data.viewer}
		<p class="who">Viewer username: <strong>{data.viewer.username}</strong></p>

		<form method="POST" action="?/viewer-profile" use:enhance={() => submit('viewer')}>
			<label class="field">
				<span>Viewer display name</span>
				<input name="display_name" value={data.viewer.display_name} maxlength="120" required />
			</label>
			{#if msg('viewer')?.error}<p class="error" role="alert">{msg('viewer')?.error}</p>{/if}
			{#if msg('viewer')?.ok}<p class="ok" role="status">Saved.</p>{/if}
			<div class="form-actions">
				<button class="btn primary" type="submit" disabled={busy === 'viewer'}>
					{busy === 'viewer' ? 'Saving…' : 'Save name'}
				</button>
			</div>
		</form>

		<hr />

		<h3>Reset viewer password</h3>
		<form method="POST" action="?/viewer-password" use:enhance={() => submit('viewer-pw')}>
			<label class="field">
				<span>New password</span>
				<input type="password" name="password" autocomplete="new-password" minlength="8" required />
			</label>
			<label class="field">
				<span>Confirm new password</span>
				<input
					type="password"
					name="confirm_password"
					autocomplete="new-password"
					minlength="8"
					required
				/>
			</label>
			{#if msg('viewer-pw')?.error}<p class="error" role="alert">{msg('viewer-pw')?.error}</p>{/if}
			{#if msg('viewer-pw')?.ok}
				<p class="ok" role="status">Viewer password reset. They'll need to sign in again.</p>
			{/if}
			<div class="form-actions">
				<button class="btn primary" type="submit" disabled={busy === 'viewer-pw'}>
					{busy === 'viewer-pw' ? 'Resetting…' : 'Reset password'}
				</button>
			</div>
		</form>
	{:else}
		<p class="muted">No viewer account exists yet. Create one so your reader can sign in.</p>
		<form method="POST" action="?/viewer-create" use:enhance={() => submit('viewer')}>
			<label class="field">
				<span>Username</span>
				<input
					name="username"
					autocapitalize="none"
					autocorrect="off"
					spellcheck="false"
					placeholder="e.g. wife"
					required
				/>
			</label>
			<label class="field">
				<span>Display name</span>
				<input name="display_name" maxlength="120" placeholder="e.g. Jane" />
			</label>
			<label class="field">
				<span>Password</span>
				<input type="password" name="password" autocomplete="new-password" minlength="8" required />
			</label>
			<label class="field">
				<span>Confirm password</span>
				<input
					type="password"
					name="confirm_password"
					autocomplete="new-password"
					minlength="8"
					required
				/>
			</label>
			{#if msg('viewer')?.error}<p class="error" role="alert">{msg('viewer')?.error}</p>{/if}
			{#if msg('viewer')?.ok}<p class="ok" role="status">Viewer account created.</p>{/if}
			<div class="form-actions">
				<button class="btn primary" type="submit" disabled={busy === 'viewer'}>
					{busy === 'viewer' ? 'Creating…' : 'Create viewer'}
				</button>
			</div>
		</form>
	{/if}
</section>

<style>
	.card {
		max-width: 520px;
		margin: 0 auto 16px;
	}
	h2 {
		margin: 0 0 0.5rem;
		font-size: 1.15rem;
	}
	h3 {
		margin: 0 0 0.75rem;
		font-size: 1rem;
	}
	.who {
		margin: 0 0 1rem;
		color: var(--muted);
	}
	hr {
		border: none;
		border-top: 1px solid var(--border);
		margin: 1.25rem 0;
	}
	.error {
		color: var(--danger);
		margin: 0 0 0.75rem;
	}
	.ok {
		color: var(--accent);
		font-weight: 600;
		margin: 0 0 0.75rem;
	}
</style>
