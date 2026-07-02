import { query } from '$lib/db';
import type { Role } from '$server/auth';

export interface ManagedUser {
	id: number;
	username: string;
	display_name: string;
	role: Role;
	views_user_id: number | null;
	last_login_at: string | null;
}

/** Current user's stored hash, for verifying the supplied current password. */
export async function getPasswordHash(userId: number): Promise<string | null> {
	const res = await query<{ password_hash: string }>(
		'SELECT password_hash FROM users WHERE id = $1',
		[userId]
	);
	return res.rows[0]?.password_hash ?? null;
}

/** All accounts, for the admin Users panel. */
export async function listUsers(): Promise<ManagedUser[]> {
	const res = await query<ManagedUser>(
		`SELECT id, username, display_name, role, views_user_id, last_login_at
		   FROM users ORDER BY id`
	);
	return res.rows;
}

export async function getUser(userId: number): Promise<ManagedUser | null> {
	const res = await query<ManagedUser>(
		`SELECT id, username, display_name, role, views_user_id, last_login_at
		   FROM users WHERE id = $1`,
		[userId]
	);
	return res.rows[0] ?? null;
}

export async function usernameTaken(username: string, exceptId?: number): Promise<boolean> {
	const res = await query<{ id: number }>('SELECT id FROM users WHERE username = $1', [username]);
	const row = res.rows[0];
	return !!row && row.id !== exceptId;
}

export async function updateDisplayName(userId: number, displayName: string): Promise<void> {
	await query('UPDATE users SET display_name = $2, updated_at = NOW() WHERE id = $1', [
		userId,
		displayName
	]);
}

export async function updatePasswordHash(userId: number, passwordHash: string): Promise<void> {
	await query('UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1', [
		userId,
		passwordHash
	]);
}

/**
 * Create an account. Viewers must carry viewsUserId (an admin/user account);
 * admin/user must not — the users_views_matches_role constraint and the
 * users_role_integrity trigger enforce both beyond this signature.
 * Returns the new id.
 */
export async function createUser(
	username: string,
	displayName: string,
	passwordHash: string,
	role: Role,
	viewsUserId: number | null
): Promise<number> {
	const res = await query<{ id: number }>(
		`INSERT INTO users (username, display_name, password_hash, role, views_user_id)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id`,
		[username, displayName, passwordHash, role, viewsUserId]
	);
	return res.rows[0].id;
}
