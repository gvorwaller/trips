// Setup for *.dbtest.ts real-database tests: load .env.test into process.env,
// then refuse to run against anything that doesn't look like the test cluster.
// Mirrors the TRIPS_ENV=test guard in scripts/lib/test-env.sh and the Safari
// QA helper — these tests INSERT/DELETE users and trips.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envPath = resolve(process.cwd(), '.env.test');
let raw: string;
try {
	raw = readFileSync(envPath, 'utf8');
} catch {
	throw new Error(`dbtest: ${envPath} not found — the db test suite needs the test-cluster env.`);
}

for (const line of raw.split('\n')) {
	const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
	if (!m) continue;
	process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
}

if (process.env.TRIPS_ENV !== 'test') {
	throw new Error('dbtest: .env.test must set TRIPS_ENV=test. Refusing to run.');
}
if (!process.env.PGDATABASE || !process.env.PGDATABASE.includes('test')) {
	throw new Error(
		`dbtest: PGDATABASE "${process.env.PGDATABASE}" does not look like a test database. Refusing to run.`
	);
}
if (process.env.PGPORT === '5437') {
	throw new Error('dbtest: PGPORT 5437 is the production cluster. Refusing to run.');
}
