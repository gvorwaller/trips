#!/usr/bin/env node
// Safari/safaridriver tap-target audit (td-3b3f5e).
//
// Loads self-provisioned fixture pages at iPhone width (390x844) and reports
// every interactive control whose REAL target misses the cs.md bar:
// >= 44x44 CSS px (WCAG 2.5.5 AAA / Apple HIG), with < 24px flagged CRITICAL
// (below even WCAG 2.2's minimum).
//
// The measurement spec carries four corrections from peer review — a naive
// rect sweep reports failures on correctly-fixed controls and passes broken
// ones:
//  1. LABEL RESOLUTION — a checkbox glyph is 22px by design; the target is
//     its wrapping <label>. Every input inside a label resolves to the label.
//  2. HIT-TEST, NOT JUST RECTS — each target's center must actually resolve
//     to the target via document.elementFromPoint (an occluded control is a
//     failure no rect can see).
//  3. FULL ENUMERATION — buttons, links, inputs, selects, textareas, summary
//     and [role=button], with an explicit exclusion list for inline prose
//     links only.
//  4. OVERLAP — two expanded targets that intersect are ambiguous to tap;
//     any pairwise intersection of resolved targets is a violation.
//
// Hard-guarded: TRIPS_ENV=test AND a *_test database off the prod port, with
// deliberately NO override flag (it creates and deletes rows). Fixtures are
// provisioned per run and deleted in a finally; run it twice to confirm
// idempotency before trusting it. Requires `safaridriver --enable` once
// (interactive, out of band).
import { spawn } from 'node:child_process';
import process from 'node:process';
import argon2 from 'argon2';
import pg from 'pg';
import { Builder, By, until } from 'selenium-webdriver';
import safari from 'selenium-webdriver/safari.js';

const QA_USERNAME = 'safari_qa';
const QA_PASSWORD = 'safari-qa-smoke-test';
const MIN_TARGET = 44;
const CRITICAL_TARGET = 24;

function usage() {
	console.log(`Usage: node scripts/safari-audit-tap-targets.mjs [options]

Audits tap-target sizes at 390x844 against the cs.md >=44px rule.
Requires TRIPS_ENV=test and a one-time \`safaridriver --enable\`.

Options:
  --base-url URL      App under test. Default http://127.0.0.1:5179
  --driver-port PORT  safaridriver port. Default 4444 (auto-started).
  --keep              Keep the fixture trip afterwards.

There is deliberately NO --force: this script creates and deletes rows, so it
hard-requires TRIPS_ENV=test AND a *_test database off the prod port.`);
}

function parseArgs(argv) {
	const args = { baseUrl: 'http://127.0.0.1:5179', driverPort: 4444, keep: false };
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

/**
 * A dense fixture on purpose: the audit must render every control family —
 * places tree with a folded child, packing list with a child item, an
 * anchored day plan with linked stops and persisted driving (so the legs,
 * arrows, chip links and visited checkboxes all appear), a reservation and
 * an expense.
 */
async function provisionFixtures(pool) {
	const hash = await argon2.hash(QA_PASSWORD, {
		type: argon2.argon2id,
		memoryCost: 19456,
		timeCost: 2,
		parallelism: 1
	});
	const userRes = await pool.query(
		`INSERT INTO users (username, display_name, password_hash, role)
		 VALUES ($1, $2, $3, 'user')
		 ON CONFLICT (username) DO UPDATE
		   SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role
		 RETURNING id`,
		[QA_USERNAME, 'Safari QA', hash]
	);
	const ownerId = userRes.rows[0].id;
	const tripId = (
		await pool.query(
			`INSERT INTO trips (owner_id, name, start_date, end_date, notes)
			 VALUES ($1, 'Tap target audit trip', '2026-08-01', '2026-08-07', 'audit fixture') RETURNING id`,
			[ownerId]
		)
	).rows[0].id;

	const section = (
		await pool.query(
			`INSERT INTO itinerary_items (trip_id, item_type, title) VALUES ($1, 'section', 'Audit section') RETURNING id`,
			[tripId]
		)
	).rows[0].id;
	// Real POI titles at true coordinates (fixture rule from the smoke script).
	const p1 = (
		await pool.query(
			`INSERT INTO itinerary_items (trip_id, parent_id, item_type, title, lat, lon, notes, date)
			 VALUES ($1, $2, 'place', 'Downeast Scenic Railroad', 44.5543, -68.3797, 'audit note', '2026-08-02') RETURNING id`,
			[tripId, section]
		)
	).rows[0].id;
	const p2 = (
		await pool.query(
			`INSERT INTO itinerary_items (trip_id, parent_id, item_type, title, lat, lon, visited)
			 VALUES ($1, $2, 'place', 'Fort Knox State Park', 44.5662, -68.8028, TRUE) RETURNING id`,
			[tripId, section]
		)
	).rows[0].id;

	const planId = (
		await pool.query(
			`INSERT INTO day_plans (trip_id, title, optional_date, anchor_source, anchor_title, anchor_lat, anchor_lon)
			 VALUES ($1, 'Audit day', '2026-08-02', $2, 'Place: Downeast Scenic Railroad', 44.5543, -68.3797) RETURNING id`,
			[tripId, `place:${p1}`]
		)
	).rows[0].id;
	await pool.query(
		`INSERT INTO day_plan_stops (day_plan_id, itinerary_item_id, sort_order, snapshot_title, snapshot_lat, snapshot_lon, drive_km, drive_min)
		 VALUES ($1, $2, 0, 'Downeast Scenic Railroad', 44.5543, -68.3797, 12.5, 18),
		        ($1, $3, 1, 'Fort Knox State Park', 44.5662, -68.8028, 30.1, 33)`,
		[planId, p1, p2]
	);

	const listId = (
		await pool.query(
			`INSERT INTO packing_lists (trip_id, name) VALUES ($1, 'Audit list') RETURNING id`,
			[tripId]
		)
	).rows[0].id;
	const packParent = (
		await pool.query(
			`INSERT INTO packing_items (list_id, name, sort_order) VALUES ($1, 'Audit bag', 0) RETURNING id`,
			[listId]
		)
	).rows[0].id;
	await pool.query(
		`INSERT INTO packing_items (list_id, parent_id, name, sort_order, checked) VALUES ($1, $2, 'Audit socks', 0, TRUE)`,
		[listId, packParent]
	);

	await pool.query(
		`INSERT INTO reservations (trip_id, reservation_type, title, start_at) VALUES ($1, 'accommodation', 'Audit inn', '2026-08-01T15:00:00Z')`,
		[tripId]
	);
	await pool.query(
		`INSERT INTO expenses (trip_id, description, amount_cents) VALUES ($1, 'Audit expense', 1234)`,
		[tripId]
	);

	return { tripId, planId };
}

/**
 * Runs in the page. Returns violations for size, occlusion and overlap using
 * resolved targets and live hit-testing.
 */
const AUDIT_SNIPPET = `
const MIN = arguments[0];
const CRITICAL = arguments[1];
const EXCLUDE = 'p a, .meta a, .extract-msg a, .sub a';
// The whole audit assumes the mobile viewport it claims to measure.
if (innerWidth < 370 || innerWidth > 400) {
	return { count: 0, violations: [{ kind: 'setup', what: 'viewport', detail: 'innerWidth=' + innerWidth + ', expected ~390' }] };
}
const seen = new Set();
const resolved = [];
for (const el of document.querySelectorAll(
	'button, a[href], input, select, textarea, summary, [role="button"]'
)) {
	if (el.matches(EXCLUDE)) continue;
	if (el.disabled) continue;
	// Vendor exclusion, deliberately NARROW: only Google-owned internals of
	// the embedded map (its container and gmp-* custom elements). First-party
	// controls never live inside .gm-style, and the map's own presence is
	// separately asserted so this exclusion cannot hide a missing map.
	if (el.closest('.gm-style') || el.tagName.startsWith('GMP-') || el.closest('gmp-advanced-marker')) continue;
	const target = (el.matches('input') && el.closest('label')) || el;
	if (seen.has(target)) continue;
	seen.add(target);
	const style = getComputedStyle(target);
	if (style.visibility === 'hidden' || style.display === 'none') continue;
	resolved.push(target);
}
const targets = [];
for (const target of resolved) {
	// Occlusion must be tested where the target actually is: scroll each one
	// into view before hit-testing (round 1: centers below the fold were
	// silently never checked). scrollIntoView forces sync layout.
	target.scrollIntoView({ block: 'center', inline: 'nearest' });
	const rect = target.getBoundingClientRect();
	if (rect.width === 0 || rect.height === 0) continue; // hidden
	const cx = Math.min(Math.max(rect.left + rect.width / 2, 0), innerWidth - 1);
	const cy = Math.min(Math.max(rect.top + rect.height / 2, 0), innerHeight - 1);
	const hit = document.elementFromPoint(cx, cy);
	const occluded = !!hit && hit !== target && !target.contains(hit) && !hit.contains(target);
	const describe =
		target.tagName.toLowerCase() +
		(target.className && typeof target.className === 'string'
			? '.' + target.className.trim().split(/\\s+/).slice(0, 2).join('.')
			: '') +
		' "' +
		(target.textContent || target.getAttribute('aria-label') || target.getAttribute('title') || '')
			.trim()
			.slice(0, 30) +
		'"';
	// Fixed/sticky-layer targets have viewport-anchored geometry: their
	// page-absolute coordinates depend on the scroll state at measurement
	// time, so comparing them against document-flow targets produces phantom
	// overlaps (peer CODEX, rerun round). Occlusion is still covered by the
	// per-target live hit-test above.
	let fixedLayer = false;
	for (let a = target; a && a !== document.documentElement; a = a.parentElement) {
		const pos = getComputedStyle(a).position;
		if (pos === 'fixed' || pos === 'sticky') { fixedLayer = true; break; }
	}
	// Store page-absolute coordinates so overlap comparison is scroll-proof.
	targets.push({
		describe,
		w: Math.round(rect.width * 10) / 10,
		h: Math.round(rect.height * 10) / 10,
		left: rect.left + scrollX,
		top: rect.top + scrollY,
		right: rect.right + scrollX,
		bottom: rect.bottom + scrollY,
		occluded,
		fixedLayer
	});
}
scrollTo(0, 0);
const violations = [];
for (const t of targets) {
	if (t.w < MIN || t.h < MIN) {
		violations.push({
			kind: t.w < CRITICAL || t.h < CRITICAL ? 'CRITICAL-size' : 'size',
			what: t.describe,
			detail: t.w + 'x' + t.h
		});
	}
	if (t.occluded) {
		violations.push({ kind: 'occluded', what: t.describe, detail: 'center hit-test misses target' });
	}
}
for (let i = 0; i < targets.length; i++) {
	for (let j = i + 1; j < targets.length; j++) {
		const a = targets[i], b = targets[j];
		// Cross-layer comparisons are geometric fiction — see fixedLayer note.
		if (a.fixedLayer !== b.fixedLayer) continue;
		const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
		const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
		if (x > 1 && y > 1) {
			violations.push({
				kind: 'overlap',
				what: a.describe + ' vs ' + b.describe,
				detail: Math.round(x) + 'x' + Math.round(y) + 'px shared'
			});
		}
	}
}
return { count: targets.length, violations };
`;

async function expandEverything(driver) {
	// Sections, plan cards and tree branches are Svelte-controlled buttons:
	// they must be CLICKED (round 1: a no-op forEach left them display:none
	// and the audit could pass green over an empty page). Repeat until a pass
	// clicks nothing, since expanding a section reveals more carets.
	for (let pass = 0; pass < 5; pass += 1) {
		const clicked = await driver.executeScript(`
			let n = 0;
			for (const d of document.querySelectorAll('details:not([open])')) { d.open = true; n++; }
			for (const b of document.querySelectorAll('.dayplan-toggle[aria-expanded="false"]')) { b.click(); n++; }
			for (const b of document.querySelectorAll('.caret[aria-expanded="false"]')) { b.click(); n++; }
			for (const c of document.querySelectorAll('.section-toggle .section-caret')) {
				if ((c.textContent || '').includes('\u25b8')) { c.closest('button').click(); n++; }
			}
			return n;
		`);
		await driver.sleep(450); // Svelte DOM settle after state changes
		if (!clicked) break;
	}
}

/**
 * A page whose expected control families are missing must FAIL, not audit
 * green over an empty DOM (peer CODEX, round 1).
 */
async function assertFamilies(driver, name, families, all) {
	for (const [selector, min] of families) {
		const count = await driver.executeScript(
			`return document.querySelectorAll(${JSON.stringify(selector)}).length;`
		);
		if (count < min) {
			all.push({
				page: name,
				kind: 'setup',
				what: `expected control family ${selector}`,
				detail: `found ${count}, expected >= ${min}`
			});
		}
	}
}

async function auditPage(driver, name, url, all, families = []) {
	await driver.get(url);
	await driver.wait(until.elementLocated(By.css('h1, main')), 10000);
	await driver.sleep(900); // hydration settle (see smoke script)
	await expandEverything(driver);
	await assertFamilies(driver, name, families, all);
	const result = await driver.executeScript(AUDIT_SNIPPET, MIN_TARGET, CRITICAL_TARGET);
	for (const v of result.violations) all.push({ page: name, ...v });
	console.log(`${name}: ${result.count} targets audited, ${result.violations.length} violations`);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	// Destructive fixture script: no override exists on purpose (peer CODEX).
	const dbName = process.env.PGDATABASE ?? 'trips_test';
	const dbPort = Number(process.env.PGPORT ?? 15437);
	if (
		process.env.TRIPS_ENV !== 'test' ||
		!dbName.endsWith('_test') ||
		dbPort === 5437 ||
		dbName === 'trips'
	) {
		console.error(
			'Refusing to run: requires TRIPS_ENV=test, a *_test database, and a non-prod port. ' +
				`Got TRIPS_ENV=${process.env.TRIPS_ENV}, PGDATABASE=${dbName}, PGPORT=${dbPort}.`
		);
		process.exitCode = 2;
		return;
	}

	const pool = new pg.Pool({
		host: process.env.PGHOST ?? '127.0.0.1',
		port: Number(process.env.PGPORT ?? 15437),
		database: process.env.PGDATABASE ?? 'trips_test',
		user: process.env.PGUSER ?? 'trips_app',
		password: process.env.PGPASSWORD
	});

	let fixtures = null;
	let driver = null;
	const violations = [];
	try {
		fixtures = await provisionFixtures(pool);
		await ensureSafaridriver(args.driverPort);
		driver = await new Builder()
			.forBrowser('safari')
			.usingServer(`http://localhost:${args.driverPort}`)
			.setSafariOptions(new safari.Options())
			.build();
		await driver.manage().window().setRect({ width: 390, height: 844 });

		// Login (its own controls are audited too).
		await driver.get(`${args.baseUrl}/login`);
		await driver.wait(until.elementLocated(By.css('input[name="username"]')), 10000);
		await driver.sleep(900);
		await auditPage(driver, 'login', `${args.baseUrl}/login`, violations);
		await driver.findElement(By.css('input[name="username"]')).sendKeys(QA_USERNAME);
		await driver.findElement(By.css('input[name="password"]')).sendKeys(QA_PASSWORD);
		const loginBtn = await driver.findElement(By.css('button[type="submit"]'));
		await loginBtn.click();
		// The login page has its own h1, so elementLocated('h1') resolves
		// against the PRE-navigation DOM and the audit proceeds
		// unauthenticated (caught on the first live run). Wait for the actual
		// redirect — the same-URL trap the smoke script already documents —
		// then assert a signed-in marker before auditing anything.
		await driver.wait(until.urlIs(`${args.baseUrl}/`), 10000);
		await driver.sleep(600);
		const signedIn = await driver.executeScript(
			`return !!document.querySelector('a[href="/trips/new"], .trip-row, nav');`
		);
		if (!signedIn) throw new Error('Login did not reach an authenticated home page.');

		await auditPage(driver, 'home', `${args.baseUrl}/`, violations);
		await auditPage(driver, 'trip', `${args.baseUrl}/trips/${fixtures.tripId}`, violations, [
			['.map', 1],
			['.del', 2],
			['.chip-link', 2],
			['.dayplan-visited', 2],
			['.dayplan-stop-links > button', 2],
			['.caret', 2],
			['.chk-hit', 2],
			['.route-tools select', 1],
			['.linkbtn', 1]
		]);

		if (violations.length > 0) {
			console.log('\nVIOLATIONS');
			for (const v of violations) {
				console.log(`  [${v.kind}] ${v.page}: ${v.what} — ${v.detail}`);
			}
			process.exitCode = 1;
		} else {
			console.log('\nAll audited targets meet the 44px bar with no occlusion or overlap.');
		}
	} finally {
		try {
			if (driver) await driver.quit();
		} catch {
			// driver may already be gone
		}
		if (fixtures && !args.keep) {
			await pool.query(`DELETE FROM trips WHERE id = $1`, [fixtures.tripId]);
		}
		await pool.end();
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exitCode = 1;
});
