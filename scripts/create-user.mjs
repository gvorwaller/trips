// Create or update a trips user (owner or viewer).
// Reads PG connection from the environment (use Node's --env-file).
//
// Usage:
//   node --env-file=.env.test scripts/create-user.mjs <username> <password> <role> "<Display Name>"
//   role = owner | viewer
//
// Idempotent: upserts by username (updates password/role/display_name).
import argon2 from 'argon2';
import pg from 'pg';

const [, , username, password, role = 'owner', displayName] = process.argv;

if (!username || !password) {
	console.error(
		'Usage: create-user.mjs <username> <password> <role=owner|viewer> "<Display Name>"'
	);
	process.exit(2);
}
if (role !== 'owner' && role !== 'viewer') {
	console.error(`Invalid role "${role}" (must be owner or viewer).`);
	process.exit(2);
}

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

const display = displayName ?? username;

const res = await pool.query(
	`INSERT INTO users (username, display_name, password_hash, role)
	 VALUES ($1, $2, $3, $4)
	 ON CONFLICT (username) DO UPDATE
	   SET display_name = EXCLUDED.display_name,
	       password_hash = EXCLUDED.password_hash,
	       role = EXCLUDED.role,
	       updated_at = NOW()
	 RETURNING id, username, role`,
	[username.toLowerCase(), display, hash, role]
);

console.log('Upserted user:', res.rows[0]);
await pool.end();
