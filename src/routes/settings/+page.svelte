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

	// ── Admin Users panel state ─────────────────────────────────────────
	let createRole = $state<'admin' | 'user' | 'viewer'>('user');
	let createFormEl = $state<HTMLFormElement | null>(null);
	let resetFormEl = $state<HTMLFormElement | null>(null);
	let resetTargetId = $state('');

	const accountUsers = $derived(data.users.filter((u) => u.role !== 'viewer'));
	const usernameOf = (id: number | null) => data.users.find((u) => u.id === id)?.username ?? '?';

	// Shared confirm modal (project convention: modal confirms, no toasts).
	type PendingConfirm = {
		heading: string;
		body: string;
		confirmLabel: string;
		formEl: HTMLFormElement;
	};
	let pendingConfirm = $state<PendingConfirm | null>(null);

	function confirmThenSubmit(
		formEl: HTMLFormElement | null,
		make: () => Omit<PendingConfirm, 'formEl'>
	) {
		if (!formEl) return;
		if (!formEl.reportValidity()) return;
		pendingConfirm = { ...make(), formEl };
	}

	function runConfirmed() {
		pendingConfirm?.formEl.requestSubmit();
		pendingConfirm = null;
	}

	function fmtLogin(ts: string | null): string {
		if (!ts) return 'never';
		return new Date(ts).toLocaleString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
	}

	const roleHelp: Record<string, string> = {
		admin: 'Full account with its own trips, plus user management.',
		user: 'Full account with its own trips. No user management.',
		viewer:
			'Read-only view of one account’s trips (can still check off packing items and mark day-plan stops visited).'
	};
</script>

<svelte:head>
	<title>Settings — trips</title>
</svelte:head>

<div class="page-head">
	<h1>Settings</h1>
	<div class="sub">Manage your account{data.isAdmin ? ' and everyone’s logins' : ''}.</div>
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

{#if data.isAdmin}
	<!-- ── Users (admin only) ─────────────────────────────────── -->
	<section class="card">
		<h2>Users</h2>
		<p class="muted">
			Accounts on this app. Each admin/user account has its own trips; viewers see one chosen
			account’s trips read-only. As admin you can reset any password — which also means you can sign
			in as anyone, so this panel is for provisioning family accounts, not a boundary.
		</p>

		<ul class="user-list">
			{#each data.users as u (u.id)}
				<li>
					<div class="user-line">
						<strong>{u.username}</strong>
						<span class="role-badge role-{u.role}">{u.role}</span>
					</div>
					<div class="user-meta">
						{u.display_name}
						{#if u.role === 'viewer'}
							· views <strong>{usernameOf(u.views_user_id)}</strong>
						{/if}
						· last login {fmtLogin(u.last_login_at)}
					</div>
				</li>
			{/each}
		</ul>

		<hr />

		<h3>Create account</h3>
		<form
			method="POST"
			action="?/users-create"
			bind:this={createFormEl}
			use:enhance={() => submit('users-create')}
		>
			<label class="field">
				<span>Username</span>
				<input
					name="username"
					autocapitalize="none"
					autocorrect="off"
					spellcheck="false"
					pattern="[a-z0-9._\-]{'{'}2,60{'}'}"
					placeholder="e.g. caleb"
					required
				/>
			</label>
			<label class="field">
				<span>Display name</span>
				<input name="display_name" maxlength="120" placeholder="e.g. Caleb" />
			</label>
			<label class="field">
				<span>Role</span>
				<select name="role" bind:value={createRole}>
					<option value="user">user</option>
					<option value="viewer">viewer</option>
					<option value="admin">admin</option>
				</select>
			</label>
			<p class="muted role-help">{roleHelp[createRole]}</p>
			{#if createRole === 'viewer'}
				<label class="field">
					<span>Views whose trips</span>
					<select name="views_user_id">
						{#each accountUsers as u (u.id)}
							<option value={u.id} selected={u.username === data.me.username}>
								{u.username} ({u.display_name})
							</option>
						{/each}
					</select>
				</label>
			{/if}
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
			{#if msg('users-create')?.error}
				<p class="error" role="alert">{msg('users-create')?.error}</p>
			{/if}
			{#if msg('users-create')?.ok}
				<p class="ok" role="status">
					{(msg('users-create') as { message?: string })?.message ?? 'Account created.'}
				</p>
			{/if}
			<div class="form-actions">
				<button
					class="btn primary"
					type="button"
					disabled={busy === 'users-create'}
					onclick={() =>
						confirmThenSubmit(createFormEl, () => ({
							heading: `Create ${createRole} account?`,
							body:
								createRole === 'admin'
									? 'An admin has full user management, including password resets for every account.'
									: (roleHelp[createRole] ?? ''),
							confirmLabel: 'Create account'
						}))}
				>
					{busy === 'users-create' ? 'Creating…' : 'Create account'}
				</button>
			</div>
		</form>

		<hr />

		<h3>Reset a password</h3>
		<form
			method="POST"
			action="?/users-set-password"
			bind:this={resetFormEl}
			use:enhance={() => submit('users-pw')}
		>
			<label class="field">
				<span>Account</span>
				<select name="user_id" bind:value={resetTargetId} required>
					<option value="" disabled>Pick an account…</option>
					{#each data.users as u (u.id)}
						<option value={u.id}>{u.username} ({u.role})</option>
					{/each}
				</select>
			</label>
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
			{#if msg('users-pw')?.error}<p class="error" role="alert">{msg('users-pw')?.error}</p>{/if}
			{#if msg('users-pw')?.ok}
				<p class="ok" role="status">
					{(msg('users-pw') as { message?: string })?.message ?? 'Password reset.'}
				</p>
			{/if}
			<div class="form-actions">
				<button
					class="btn primary"
					type="button"
					disabled={busy === 'users-pw'}
					onclick={() =>
						confirmThenSubmit(resetFormEl, () => ({
							heading: 'Reset this password?',
							body: `“${usernameOf(Number(resetTargetId))}” will be signed out everywhere and will need the new password to sign in.`,
							confirmLabel: 'Reset password'
						}))}
				>
					{busy === 'users-pw' ? 'Resetting…' : 'Reset password'}
				</button>
			</div>
		</form>
	</section>
{/if}

<div class="modal-overlay" class:open={pendingConfirm !== null}>
	{#if pendingConfirm}
		<div class="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
			<h3 id="confirm-title">{pendingConfirm.heading}</h3>
			<p>{pendingConfirm.body}</p>
			<div class="actions">
				<button class="btn" type="button" onclick={() => (pendingConfirm = null)}>Cancel</button>
				<button class="btn primary" type="button" onclick={runConfirmed}>
					{pendingConfirm.confirmLabel}
				</button>
			</div>
		</div>
	{/if}
</div>

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape') pendingConfirm = null;
	}}
/>

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
	.user-list {
		list-style: none;
		margin: 0 0 0.5rem;
		padding: 0;
	}
	.user-list li {
		padding: 0.6rem 0;
		border-bottom: 1px solid var(--border);
	}
	.user-list li:last-child {
		border-bottom: none;
	}
	.user-line {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.user-meta {
		color: var(--muted);
		font-size: 0.95rem;
		margin-top: 0.15rem;
	}
	.role-badge {
		font-size: 0.8rem;
		font-weight: 600;
		padding: 0.1rem 0.5rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		color: var(--muted);
	}
	.role-badge.role-admin {
		color: var(--accent);
		border-color: var(--accent);
	}
	.role-help {
		margin: -0.25rem 0 0.75rem;
		font-size: 0.95rem;
	}
</style>
