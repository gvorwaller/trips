import { query } from '$lib/db';

export interface ManagedUser {
	id: number;
	username: string;
	display_name: string;
	role: 'owner' | 'viewer';
}

/** Current user's stored hash, for verifying the supplied current password. */
export async function getPasswordHash(userId: number): Promise<string | null> {
	const res = await query<{ password_hash: string }>(
		'SELECT password_hash FROM users WHERE id = $1',
		[userId]
	);
	return res.rows[0]?.password_hash ?? null;
}

/** The single viewer account, if one exists (this app has at most one). */
export async function getViewer(): Promise<ManagedUser | null> {
	const res = await query<ManagedUser>(
		"SELECT id, username, display_name, role FROM users WHERE role = 'viewer' ORDER BY id LIMIT 1"
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

/** Create the viewer account. Returns its new id. */
export async function createViewer(
	username: string,
	displayName: string,
	passwordHash: string
): Promise<number> {
	const res = await query<{ id: number }>(
		`INSERT INTO users (username, display_name, password_hash, role)
		 VALUES ($1, $2, $3, 'viewer')
		 RETURNING id`,
		[username, displayName, passwordHash]
	);
	return res.rows[0].id;
}
