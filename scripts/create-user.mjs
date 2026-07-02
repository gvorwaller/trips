// Create or update a trips user (break-glass/bootstrap path — the normal way
// is the admin Users panel in /settings).
// Reads PG connection from the environment (use Node's --env-file).
//
// Usage:
//   node --env-file=.env.test scripts/create-user.mjs <username> <password> <role> "<Display Name>" [--views <username>]
//   role = admin | user | viewer
//   viewer requires --views <username of an admin/user account>
//
// Idempotent: upserts by username (updates password/role/display_name/views).
import argon2 from 'argon2';
import pg from 'pg';

const args = process.argv.slice(2);
let viewsUsername = null;
const viewsIdx = args.indexOf('--views');
if (viewsIdx !== -1) {
	viewsUsername = args[viewsIdx + 1] ?? null;
	args.splice(viewsIdx, 2);
}
const [username, password, role = 'user', displayName] = args;

function usage(msg) {
	console.error(msg);
	console.error(
		'Usage: create-user.mjs <username> <password> <role=admin|user|viewer> "<Display Name>" [--views <username>]'
	);
	process.exitCode = 2;
}

if (!username || !password) {
	usage('Missing username or password.');
} else if (role !== 'admin' && role !== 'user' && role !== 'viewer') {
	usage(`Invalid role "${role}" (must be admin, user, or viewer).`);
} else if (role === 'viewer' && !viewsUsername) {
	usage('A viewer requires --views <username> naming the admin/user account it reads.');
} else if (role !== 'viewer' && viewsUsername) {
	usage('--views is only valid for role=viewer.');
} else {
	const hash = await argon2.hash(password, {
		type: argon2.argon2id,
		memoryCost: 19456,
		timeCost: 2,
		parallelism: 1
	});

	const pool = new pg.Pool({
		host: process.env.PGHOST ?? '127.0.0.1',
		port: Number(process.env.PGPORT ?? 5437),
		database: process.env.PGDATABASE ?? 'trips',
		user: process.env.PGUSER ?? 'trips_app',
		password: process.env.PGPASSWORD
	});

	try {
		let viewsUserId = null;
		if (role === 'viewer') {
			const target = await pool.query(`SELECT id, role FROM users WHERE username = $1`, [
				viewsUsername.toLowerCase()
			]);
			const row = target.rows[0];
			if (!row) throw new Error(`--views target "${viewsUsername}" does not exist.`);
			if (row.role === 'viewer') {
				throw new Error(`--views target "${viewsUsername}" is a viewer; must be admin or user.`);
			}
			viewsUserId = row.id;
		}

		const display = displayName ?? username;
		// The users_role_integrity trigger is the backstop for anything missed here.
		const res = await pool.query(
			`INSERT INTO users (username, display_name, password_hash, role, views_user_id)
			 VALUES ($1, $2, $3, $4, $5)
			 ON CONFLICT (username) DO UPDATE
			   SET display_name = EXCLUDED.display_name,
			       password_hash = EXCLUDED.password_hash,
			       role = EXCLUDED.role,
			       views_user_id = EXCLUDED.views_user_id,
			       updated_at = NOW()
			 RETURNING id, username, role, views_user_id`,
			[username.toLowerCase(), display, hash, role, viewsUserId]
		);
		console.log('Upserted user:', res.rows[0]);
	} catch (err) {
		console.error(err instanceof Error ? err.message : err);
		process.exitCode = 1;
	} finally {
		await pool.end();
	}
}
