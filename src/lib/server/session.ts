import { randomBytes } from 'node:crypto';
import { query } from '$lib/db';
import type { Role } from '$server/auth';

export const SESSION_COOKIE_NAME = 'trips_session';
export const SESSION_TTL_DAYS = 30;
const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

function newToken(): string {
	return randomBytes(32).toString('base64url');
}

export async function createSession(userId: number): Promise<string> {
	const id = newToken();
	const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
	await query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, $3)`, [
		id,
		userId,
		expiresAt
	]);
	return id;
}

export interface SessionUser {
	id: number;
	username: string;
	role: Role;
	display_name: string;
	/** For viewers: the admin/user account whose trips they read. NULL otherwise. */
	views_user_id: number | null;
}

export async function validateSession(token: string): Promise<SessionUser | null> {
	const res = await query<{
		sid: string;
		expires_at: string;
		uid: number;
		username: string;
		role: string;
		display_name: string;
		views_user_id: number | null;
	}>(
		`SELECT s.id AS sid, s.expires_at,
		        u.id AS uid, u.username, u.role, u.display_name, u.views_user_id
		   FROM sessions s
		   JOIN users u ON u.id = s.user_id
		  WHERE s.id = $1`,
		[token]
	);

	const row = res.rows[0];
	if (!row) return null;

	if (new Date(row.expires_at).getTime() <= Date.now()) {
		await query('DELETE FROM sessions WHERE id = $1', [token]);
		return null;
	}

	// Sliding expiry
	const nextExpiry = new Date(Date.now() + SESSION_TTL_MS).toISOString();
	await query('UPDATE sessions SET expires_at = $1 WHERE id = $2', [nextExpiry, token]);

	return {
		id: row.uid,
		username: row.username,
		role: row.role as Role,
		display_name: row.display_name,
		views_user_id: row.views_user_id
	};
}

export async function destroySession(token: string): Promise<void> {
	await query('DELETE FROM sessions WHERE id = $1', [token]);
}

/**
 * Invalidate a user's sessions after a password change. Pass `exceptToken` to
 * keep the caller's own session alive (used when someone changes their own
 * password); omit it to force the user off everywhere (used when an admin
 * resets another account's password).
 */
export async function destroyUserSessions(userId: number, exceptToken?: string): Promise<void> {
	if (exceptToken) {
		await query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [userId, exceptToken]);
	} else {
		await query('DELETE FROM sessions WHERE user_id = $1', [userId]);
	}
}
