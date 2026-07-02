#!/usr/bin/env node
// Safari/safaridriver smoke test for the place workspace (docs/2026-07-01-place-ai-interaction-plan-claude.md
// Phase 2): resolve-candidate card, "Link this match", Known Details render, and the no-coordinates
// state. Faster and cleaner than driving Chrome for this — Safari has surfaced its own timing bugs in
// this app before (see docs/devlog/2026-06-27-dayplan-safari-bugs.md), so it's worth checking directly
// rather than assuming Chrome parity.
//
// Usage:
//   npm run test:db:up && npm run dev:test   # in another terminal, left running
//   node --env-file=.env.test scripts/safari-smoke-place-workspace.mjs
//
// Requires `safaridriver --enable` to have been run once (one-time, interactive, out of band — this
// script does not attempt it). Creates its own throwaway trip + itinerary items under a dedicated
// `safari_qa` user and deletes the trip afterward; the user fixture is left in place (idempotent
// upsert, harmless) so repeat runs don't need to re-provision it.
import { spawn } from 'node:child_process';
import process from 'node:process';
import argon2 from 'argon2';
import pg from 'pg';
import { Builder, By, until } from 'selenium-webdriver';
import safari from 'selenium-webdriver/safari.js';

const QA_USERNAME = 'safari_qa';
const QA_PASSWORD = 'safari-qa-smoke-test';
// A real, stable Google-resolvable point (used elsewhere in this app's manual QA) — reverse-geocodes
// to a fixed street address, which is what the resolve-candidate assertions check against.
const COORDS_ITEM = { lat: 44.5419, lon: -68.4246 };
const EXPECTED_RESOLVED_SUBSTRING = 'Ellsworth, ME';

function usage() {
	console.log(`Usage:
  node --env-file=.env.test scripts/safari-smoke-place-workspace.mjs [options]

Requires npm run test:db:up and npm run dev:test already running in another terminal,
and requires \`safaridriver --enable\` to have been run once already (one-time, interactive).

Options:
  --base-url URL      App base URL. Default http://127.0.0.1:5179.
  --driver-port PORT  safaridriver port. Default 4444. Started automatically if not already up.
  --keep              Leave the throwaway trip/data behind instead of deleting it (debugging).
  --force              Skip the TRIPS_ENV=test safety check. Do not use against production.
`);
}

function parseArgs(argv) {
	const args = { baseUrl: 'http://127.0.0.1:5179', driverPort: 4444, keep: false, force: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--help' || arg === '-h') {
			usage();
			process.exit(0);
		}
		if (arg === '--keep') {
			args.keep = true;
			continue;
		}
		if (arg === '--force') {
			args.force = true;
			continue;
		}
		const next = argv[++i];
		if (!next) throw new Error(`Missing value for ${arg}`);
		if (arg === '--base-url') args.baseUrl = next.replace(/\/$/, '');
		else if (arg === '--driver-port') args.driverPort = Number(next);
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return args;
}

async function ensureSafaridriver(port) {
	try {
		const res = await fetch(`http://localhost:${port}/status`, {
			signal: AbortSignal.timeout(2000)
		});
		if (res.ok) return { startedByUs: false };
	} catch {
		// not running yet — fall through and start it
	}
	const child = spawn('safaridriver', ['-p', String(port)], { stdio: 'ignore', detached: true });
	child.unref();
	for (let attempt = 0; attempt < 20; attempt += 1) {
		await new Promise((r) => setTimeout(r, 250));
		try {
			const res = await fetch(`http://localhost:${port}/status`, {
				signal: AbortSignal.timeout(1000)
			});
			if (res.ok) return { startedByUs: true, pid: child.pid };
		} catch {
			// keep waiting
		}
	}
	throw new Error(
		`safaridriver did not come up on port ${port}. If this is the first run, enable it once with: safaridriver --enable`
	);
}

async function provisionFixtures(pool) {
	const hash = await argon2.hash(QA_PASSWORD, {
		type: argon2.argon2id,
		memoryCost: 19456,
		timeCost: 2,
		parallelism: 1
	});
	await pool.query(
		`INSERT INTO users (username, display_name, password_hash, role)
		 VALUES ($1, $2, $3, 'owner')
		 ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
		[QA_USERNAME, 'Safari QA', hash]
	);

	// This app currently has a single global "owner" — src/lib/server/auth.ts
	// getOwnerId() resolves to the first owner-role user by id, cached for the
	// server process's lifetime. Logging in as any owner-role user (including
	// the fixture above) gets a session that can see that owner's trips, but a
	// *new* trip must be owned by the resolved canonical owner id, not by the
	// fixture user's own id, or the workspace route 404s (owner_id mismatch).
	const ownerRes = await pool.query(
		`SELECT id FROM users WHERE role = 'owner' ORDER BY id LIMIT 1`
	);
	if (!ownerRes.rows[0]) throw new Error('No owner-role user exists in this database yet.');
	const ownerId = ownerRes.rows[0].id;

	const tripRes = await pool.query(
		`INSERT INTO trips (owner_id, name) VALUES ($1, 'Safari smoke test trip') RETURNING id`,
		[ownerId]
	);
	const tripId = tripRes.rows[0].id;

	const coordsItemRes = await pool.query(
		`INSERT INTO itinerary_items (trip_id, item_type, title, lat, lon)
		 VALUES ($1, 'place', 'Coords, no Google place', $2, $3) RETURNING id`,
		[tripId, COORDS_ITEM.lat, COORDS_ITEM.lon]
	);
	const noCoordsItemRes = await pool.query(
		`INSERT INTO itinerary_items (trip_id, item_type, title) VALUES ($1, 'place', 'No location set') RETURNING id`,
		[tripId]
	);

	return {
		tripId,
		coordsItemId: coordsItemRes.rows[0].id,
		noCoordsItemId: noCoordsItemRes.rows[0].id
	};
}

async function cleanupFixtures(pool, tripId, coordsPlaceId) {
	await pool.query(`DELETE FROM trips WHERE id = $1`, [tripId]); // cascades to itinerary_items
	if (coordsPlaceId) {
		await pool.query(`DELETE FROM api_cache WHERE cache_key = $1`, [
			`place-details:${coordsPlaceId}:v1`
		]);
	}
}

async function loadAndSettle(driver, url) {
	await driver.get(url);
	await driver.wait(until.elementLocated(By.css('h1')), 10000);
	// Svelte hydration/render settle — reading the DOM immediately after
	// elementLocated can race hydration attaching handlers/bindings.
	await driver.sleep(800);
}

function check(results, name, pass) {
	results.push({ name, pass: !!pass });
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (process.env.TRIPS_ENV !== 'test' && !args.force) {
		throw new Error(
			'Refusing to run: TRIPS_ENV is not "test". This script creates and deletes real rows. ' +
				'Run with `node --env-file=.env.test ...`, or pass --force if you are certain.'
		);
	}

	const pool = new pg.Pool({
		host: process.env.PGHOST ?? '127.0.0.1',
		port: Number(process.env.PGPORT ?? 15437),
		database: process.env.PGDATABASE ?? 'trips_test',
		user: process.env.PGUSER,
		password: process.env.PGPASSWORD
	});

	let fixtures = null;
	let driver = null;
	let driverInfo = null;
	const results = [];
	let coordsPlaceId = null;

	try {
		fixtures = await provisionFixtures(pool);
		driverInfo = await ensureSafaridriver(args.driverPort);

		driver = await new Builder()
			.forBrowser('safari')
			.usingServer(`http://localhost:${args.driverPort}`)
			.setSafariOptions(new safari.Options())
			.build();
		await driver.manage().window().setRect({ width: 1280, height: 900 });

		// --- Login ---
		await driver.get(`${args.baseUrl}/login`);
		await driver.wait(until.elementLocated(By.css('input')), 10000);
		await driver.sleep(1500);
		const [userInput, passInput] = await driver.findElements(By.css('input'));
		await userInput.sendKeys(QA_USERNAME);
		await passInput.sendKeys(QA_PASSWORD);
		await driver.findElement(By.css('button[type="submit"]')).click();
		await driver.wait(until.urlIs(`${args.baseUrl}/`), 10000);
		check(results, 'login succeeds', true);

		// --- Coords, no Google place_id -> resolve candidate ---
		const coordsUrl = `${args.baseUrl}/trips/${fixtures.tripId}/place/${fixtures.coordsItemId}`;
		await loadAndSettle(driver, coordsUrl);
		let body = await driver.findElement(By.css('body')).getText();
		check(
			results,
			'coords item shows resolve-candidate card',
			body.includes('Possible Google match')
		);
		check(
			results,
			'resolve-candidate address looks right',
			body.includes(EXPECTED_RESOLVED_SUBSTRING)
		);
		check(results, 'coords item has no Known Details yet', !body.includes('Known Details'));

		const linkBtn = await driver.findElement(
			By.xpath("//button[contains(text(),'Link this match')]")
		);
		await linkBtn.click();
		// The redirect lands on the same URL, so wait for the old DOM to go
		// stale (full reload) instead of relying on the URL to change.
		await driver.wait(until.stalenessOf(linkBtn), 10000);
		await driver.wait(until.elementLocated(By.css('h1')), 10000);
		await driver.sleep(800);

		check(
			results,
			'URL is clean after linking (no ?/link-place left in bar)',
			(await driver.getCurrentUrl()) === coordsUrl
		);
		body = await driver.findElement(By.css('body')).getText();
		check(results, 'Known Details renders after linking', body.includes('Known Details'));
		check(
			results,
			'resolve-candidate card is gone after linking',
			!body.includes('Possible Google match')
		);
		check(results, 'Known Details shows a fetched-at line', body.includes('Fetched'));

		const cachedPlaceIdRes = await pool.query(
			`SELECT place_id FROM itinerary_items WHERE id = $1`,
			[fixtures.coordsItemId]
		);
		coordsPlaceId = cachedPlaceIdRes.rows[0]?.place_id ?? null;
		check(results, 'itinerary_items.place_id got set by linking', !!coordsPlaceId);

		// --- No coordinates at all -> plain map picker, no extra cards ---
		const noCoordsUrl = `${args.baseUrl}/trips/${fixtures.tripId}/place/${fixtures.noCoordsItemId}`;
		await loadAndSettle(driver, noCoordsUrl);
		body = await driver.findElement(By.css('body')).getText();
		check(
			results,
			'no-coords item shows no resolve-candidate card',
			!body.includes('Possible Google match')
		);
		check(results, 'no-coords item shows no Known Details', !body.includes('Known Details'));
	} finally {
		if (driver) await driver.quit();
		if (driverInfo?.startedByUs && driverInfo.pid) {
			try {
				process.kill(driverInfo.pid);
			} catch {
				// already gone
			}
		}
		if (fixtures && !args.keep) {
			await cleanupFixtures(pool, fixtures.tripId, coordsPlaceId);
		}
		await pool.end();
	}

	const failed = results.filter((r) => !r.pass);
	for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
	console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
	if (failed.length > 0) process.exitCode = 1;
}

main().catch((err) => {
	// process.exitCode (not process.exit()) so stderr fully flushes before exit.
	process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
	process.exitCode = 1;
});
