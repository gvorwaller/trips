import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { hashPassword, verifyPassword, type Role } from '$server/auth';
import { SESSION_COOKIE_NAME, destroyUserSessions } from '$server/session';
import {
	getPasswordHash,
	getUser,
	listUsers,
	usernameTaken,
	updateDisplayName,
	updatePasswordHash,
	createUser
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

// Admin and user both get their own profile/password sections; the Users
// panel (list/create/reset) is admin-only, guarded in load AND per-action.
// The hook already redirects viewers away from /settings; guard here too.
export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user || locals.user.role === 'viewer') throw redirect(303, '/');
	const isAdmin = locals.user.role === 'admin';
	const users = isAdmin ? await listUsers() : [];
	return {
		me: { username: locals.user.username, display_name: locals.user.display_name },
		isAdmin,
		users
	};
};

export const actions: Actions = {
	// ── Own display name (admin or user) ───────────────────────────────
	profile: async ({ locals, request }) => {
		if (!locals.user || locals.user.role === 'viewer') return fail(403, { error: 'Forbidden' });
		const form = await request.formData();
		const display_name = cleanName(form.get('display_name'));
		if (!display_name) return fail(400, { section: 'profile', error: 'Display name is required.' });
		await updateDisplayName(locals.user.id, display_name);
		return { section: 'profile', ok: true };
	},

	// ── Own password (requires current password) ───────────────────────
	password: async ({ locals, request, cookies }) => {
		if (!locals.user || locals.user.role === 'viewer') return fail(403, { error: 'Forbidden' });
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

	// ── Admin: create any account ───────────────────────────────────────
	'users-create': async ({ locals, request }) => {
		if (locals.user?.role !== 'admin') return fail(403, { error: 'Forbidden' });
		const form = await request.formData();
		const username = (form.get('username') ?? '').toString().trim().toLowerCase().slice(0, 60);
		const display_name = cleanName(form.get('display_name')) || username;
		const role = (form.get('role') ?? '').toString();
		const pw = (form.get('password') ?? '').toString();
		const confirm = (form.get('confirm_password') ?? '').toString();

		if (!/^[a-z0-9._-]{2,60}$/.test(username)) {
			return fail(400, {
				section: 'users-create',
				error: 'Username must be 2–60 chars: lowercase letters, numbers, . _ -'
			});
		}
		if (role !== 'admin' && role !== 'user' && role !== 'viewer') {
			return fail(400, { section: 'users-create', error: 'Invalid role.' });
		}
		if (await usernameTaken(username)) {
			return fail(409, { section: 'users-create', error: 'That username is taken.' });
		}
		const bad = checkNewPassword(pw, confirm);
		if (bad) return fail(400, { section: 'users-create', error: bad });

		// A viewer reads one chosen account's trips; default to the creating admin.
		// The DB trigger re-enforces all of this — these checks are for friendly errors.
		let viewsUserId: number | null = null;
		if (role === 'viewer') {
			const raw = Number(form.get('views_user_id'));
			viewsUserId = Number.isInteger(raw) && raw > 0 ? raw : locals.user.id;
			const target = await getUser(viewsUserId);
			if (!target || target.role === 'viewer') {
				return fail(400, {
					section: 'users-create',
					error: 'A viewer must view an admin or user account.'
				});
			}
		}

		await createUser(username, display_name, await hashPassword(pw), role as Role, viewsUserId);
		return { section: 'users-create', ok: true, message: `Created ${role} “${username}”.` };
	},

	// ── Admin: reset any password (no current password — this is an
	//    impersonation-level capability, stated in the panel UI) ─────────
	'users-set-password': async ({ locals, request, cookies }) => {
		if (locals.user?.role !== 'admin') return fail(403, { error: 'Forbidden' });
		const form = await request.formData();
		const targetId = Number(form.get('user_id'));
		const pw = (form.get('password') ?? '').toString();
		const confirm = (form.get('confirm_password') ?? '').toString();

		if (!Number.isInteger(targetId) || targetId <= 0) {
			return fail(400, { section: 'users-pw', error: 'Pick a user.' });
		}
		const bad = checkNewPassword(pw, confirm);
		if (bad) return fail(400, { section: 'users-pw', error: bad });

		const target = await getUser(targetId);
		if (!target) return fail(404, { section: 'users-pw', error: 'User not found.' });

		await updatePasswordHash(targetId, await hashPassword(pw));
		// Force the target to re-login everywhere — except keep this session
		// alive when the admin resets their own password from the panel.
		await destroyUserSessions(
			targetId,
			targetId === locals.user.id ? cookies.get(SESSION_COOKIE_NAME) : undefined
		);
		return {
			section: 'users-pw',
			ok: true,
			message: `Password reset for “${target.username}”. They'll need to sign in again.`
		};
	}
};
