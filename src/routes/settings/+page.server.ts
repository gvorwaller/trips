import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { hashPassword, verifyPassword } from '$server/auth';
import { SESSION_COOKIE_NAME, destroyUserSessions } from '$server/session';
import {
	getPasswordHash,
	getViewer,
	usernameTaken,
	updateDisplayName,
	updatePasswordHash,
	createViewer
} from '$server/users';

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;

function cleanName(v: FormDataEntryValue | null): string {
	return (v ?? '').toString().trim().slice(0, 120);
}

function checkNewPassword(pw: string, confirm: string): string | null {
	if (pw.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters.`;
	if (pw.length > MAX_PASSWORD) return 'Password is too long.';
	if (pw !== confirm) return 'Passwords do not match.';
	return null;
}

// Owner-only. The hook already redirects viewers away from /settings, but guard
// here too so this page never renders or mutates for a non-owner.
export const load: PageServerLoad = async ({ locals }) => {
	if (locals.user?.role !== 'owner') throw redirect(303, '/');
	const viewer = await getViewer();
	return {
		me: { username: locals.user.username, display_name: locals.user.display_name },
		viewer: viewer ? { username: viewer.username, display_name: viewer.display_name } : null
	};
};

export const actions: Actions = {
	// ── Owner: display name ────────────────────────────────────────────
	profile: async ({ locals, request }) => {
		if (locals.user?.role !== 'owner') return fail(403, { error: 'Forbidden' });
		const form = await request.formData();
		const display_name = cleanName(form.get('display_name'));
		if (!display_name) return fail(400, { section: 'profile', error: 'Display name is required.' });
		await updateDisplayName(locals.user.id, display_name);
		return { section: 'profile', ok: true };
	},

	// ── Owner: own password (requires current password) ────────────────
	password: async ({ locals, request, cookies }) => {
		if (locals.user?.role !== 'owner') return fail(403, { error: 'Forbidden' });
		const form = await request.formData();
		const current = (form.get('current_password') ?? '').toString();
		const next = (form.get('new_password') ?? '').toString();
		const confirm = (form.get('confirm_password') ?? '').toString();

		const hash = await getPasswordHash(locals.user.id);
		if (!hash || !(await verifyPassword(hash, current))) {
			return fail(400, { section: 'password', error: 'Current password is incorrect.' });
		}
		const bad = checkNewPassword(next, confirm);
		if (bad) return fail(400, { section: 'password', error: bad });

		await updatePasswordHash(locals.user.id, await hashPassword(next));
		// Keep this session; sign out any others.
		await destroyUserSessions(locals.user.id, cookies.get(SESSION_COOKIE_NAME));
		return { section: 'password', ok: true };
	},

	// ── Viewer: create (only when none exists) ─────────────────────────
	'viewer-create': async ({ locals, request }) => {
		if (locals.user?.role !== 'owner') return fail(403, { error: 'Forbidden' });
		if (await getViewer())
			return fail(409, { section: 'viewer', error: 'A viewer already exists.' });
		const form = await request.formData();
		const username = (form.get('username') ?? '').toString().trim().toLowerCase().slice(0, 60);
		const display_name = cleanName(form.get('display_name')) || username;
		const pw = (form.get('password') ?? '').toString();
		const confirm = (form.get('confirm_password') ?? '').toString();

		if (!/^[a-z0-9._-]{2,60}$/.test(username)) {
			return fail(400, {
				section: 'viewer',
				error: 'Username must be 2–60 chars: lowercase letters, numbers, . _ -'
			});
		}
		if (await usernameTaken(username)) {
			return fail(409, { section: 'viewer', error: 'That username is taken.' });
		}
		const bad = checkNewPassword(pw, confirm);
		if (bad) return fail(400, { section: 'viewer', error: bad });

		await createViewer(username, display_name, await hashPassword(pw));
		return { section: 'viewer', ok: true };
	},

	// ── Viewer: display name ───────────────────────────────────────────
	'viewer-profile': async ({ locals, request }) => {
		if (locals.user?.role !== 'owner') return fail(403, { error: 'Forbidden' });
		const viewer = await getViewer();
		if (!viewer) return fail(404, { section: 'viewer', error: 'No viewer account exists yet.' });
		const form = await request.formData();
		const display_name = cleanName(form.get('display_name'));
		if (!display_name) return fail(400, { section: 'viewer', error: 'Display name is required.' });
		await updateDisplayName(viewer.id, display_name);
		return { section: 'viewer', ok: true };
	},

	// ── Viewer: reset password (owner is admin; no current pw needed) ───
	'viewer-password': async ({ locals, request }) => {
		if (locals.user?.role !== 'owner') return fail(403, { error: 'Forbidden' });
		const viewer = await getViewer();
		if (!viewer) return fail(404, { section: 'viewer-pw', error: 'No viewer account exists yet.' });
		const form = await request.formData();
		const pw = (form.get('password') ?? '').toString();
		const confirm = (form.get('confirm_password') ?? '').toString();
		const bad = checkNewPassword(pw, confirm);
		if (bad) return fail(400, { section: 'viewer-pw', error: bad });

		await updatePasswordHash(viewer.id, await hashPassword(pw));
		// Force the viewer to re-login everywhere with the new password.
		await destroyUserSessions(viewer.id);
		return { section: 'viewer-pw', ok: true };
	}
};
