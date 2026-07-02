// Multi-user isolation suite (td-d3af9d Phase 4). Runs against the REAL test
// cluster (npm run test:db) — no $lib/db mocks — because the thing under test
// is the SQL owner filtering itself. Three-account fixture: admin A, user B,
// viewer V of A. Every cross-account probe must miss; every same-account and
// viewer-of-A probe must hit.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closePool } from '$lib/db';
import { listTrips, getTrip, updateTrip, deleteTrip } from '$server/trips';
import {
	listTemplates,
	saveListAsTemplate,
	applyTemplate,
	deleteTemplate
} from '$server/templates';
import { search } from '$server/search';
import { duplicateTrip } from '$server/clone';
import { getAttachmentForDownload, getAttachmentSource } from '$server/attachments';
import { setPackingItemChecked } from '$server/packing';
import { setStopVisited } from '$server/dayplans';
import { actions as settingsActions } from '../../routes/settings/+page.server';
import { actions as placeActions } from '../../routes/trips/[id]/place/[itemId]/+page.server';

const U = {
	admin: 'dbtest_admin_a',
	user: 'dbtest_user_b',
	viewer: 'dbtest_viewer_v'
};

// Unique marker baked into A's data so search() hits can't collide with
// anything else living in the shared test database.
const MARK = 'zqxisolation';

let a = 0; // admin A id
let b = 0; // user B id
let v = 0; // viewer V id (views A)
let tripA = 0;
let tripB = 0;
let packItemA = 0;
let stopA = 0;
let attA = 0;
let tmplA = 0;
let listA = 0;

async function insertUser(
	username: string,
	role: string,
	viewsUserId: number | null = null
): Promise<number> {
	const r = await query<{ id: number }>(
		`INSERT INTO users (username, display_name, password_hash, role, views_user_id)
		 VALUES ($1, $1, 'x', $2, $3) RETURNING id`,
		[username, role, viewsUserId]
	);
	return r.rows[0].id;
}

beforeAll(async () => {
	// Re-runs after a crashed run should start clean (cascades wipe trips etc.).
	await query(`DELETE FROM users WHERE username LIKE 'dbtest\\_%'`);

	a = await insertUser(U.admin, 'admin');
	b = await insertUser(U.user, 'user');
	v = await insertUser(U.viewer, 'viewer', a);

	tripA = (
		await query<{ id: number }>(`INSERT INTO trips (owner_id, name) VALUES ($1, $2) RETURNING id`, [
			a,
			`A trip ${MARK}`
		])
	).rows[0].id;
	tripB = (
		await query<{ id: number }>(
			`INSERT INTO trips (owner_id, name) VALUES ($1, 'B trip') RETURNING id`,
			[b]
		)
	).rows[0].id;

	const itemA = (
		await query<{ id: number }>(
			`INSERT INTO itinerary_items (trip_id, item_type, title, lat, lon)
			 VALUES ($1, 'place', $2, 44.39, -68.20) RETURNING id`,
			[tripA, `A place ${MARK}`]
		)
	).rows[0].id;

	listA = (
		await query<{ id: number }>(
			`INSERT INTO packing_lists (trip_id, name) VALUES ($1, 'A list') RETURNING id`,
			[tripA]
		)
	).rows[0].id;
	packItemA = (
		await query<{ id: number }>(
			`INSERT INTO packing_items (list_id, name) VALUES ($1, $2) RETURNING id`,
			[listA, `A item ${MARK}`]
		)
	).rows[0].id;

	const planA = (
		await query<{ id: number }>(
			`INSERT INTO day_plans (trip_id, title) VALUES ($1, 'A plan') RETURNING id`,
			[tripA]
		)
	).rows[0].id;
	stopA = (
		await query<{ id: number }>(
			`INSERT INTO day_plan_stops (day_plan_id, itinerary_item_id, snapshot_title)
			 VALUES ($1, $2, 'A stop') RETURNING id`,
			[planA, itemA]
		)
	).rows[0].id;

	attA = (
		await query<{ id: number }>(
			`INSERT INTO attachments (trip_id, kind, original_name, mime_type, size_bytes, object_key, status)
			 VALUES ($1, 'file', 'a.pdf', 'application/pdf', 123, $2, 'active') RETURNING id`,
			[tripA, `dbtest/${MARK}-a.pdf`]
		)
	).rows[0].id;

	await query(`INSERT INTO expenses (trip_id, description, amount_cents) VALUES ($1, $2, 100)`, [
		tripA,
		`A expense ${MARK}`
	]);

	tmplA = (
		await query<{ id: number }>(
			`INSERT INTO packing_templates (owner_id, name) VALUES ($1, 'A template') RETURNING id`,
			[a]
		)
	).rows[0].id;
});

afterAll(async () => {
	// trips/templates cascade from users; api_cache rows are not per-user.
	await query(`DELETE FROM users WHERE username LIKE 'dbtest\\_%'`);
	await closePool();
});

// ── Trips ────────────────────────────────────────────────────────────────
describe('trips owner filtering', () => {
	it('listTrips shows each account only its own trips', async () => {
		const forA = await listTrips(a);
		const forB = await listTrips(b);
		expect(forA.map((t) => t.id)).toContain(tripA);
		expect(forA.map((t) => t.id)).not.toContain(tripB);
		expect(forB.map((t) => t.id)).toContain(tripB);
		expect(forB.map((t) => t.id)).not.toContain(tripA);
	});

	it("getTrip misses another account's trip", async () => {
		expect(await getTrip(b, tripA)).toBeNull();
		expect(await getTrip(a, tripB)).toBeNull();
		expect((await getTrip(a, tripA))?.id).toBe(tripA);
	});

	it('viewer of A resolves A’s trips, not B’s', async () => {
		// hooks.server.ts sets locals.ownerId = views_user_id for viewers.
		const viewerRow = await query<{ views_user_id: number }>(
			`SELECT views_user_id FROM users WHERE id = $1`,
			[v]
		);
		const viewerOwnerId = viewerRow.rows[0].views_user_id;
		expect(viewerOwnerId).toBe(a);
		expect((await getTrip(viewerOwnerId, tripA))?.id).toBe(tripA);
		expect(await getTrip(viewerOwnerId, tripB)).toBeNull();
	});

	it("updateTrip / deleteTrip refuse another account's trip", async () => {
		expect(
			await updateTrip(b, tripA, {
				name: 'hijacked',
				start_date: null,
				end_date: null,
				notes: null
			})
		).toBe(false);
		expect(await deleteTrip(b, tripA)).toBe(false);
		expect((await getTrip(a, tripA))?.name).toBe(`A trip ${MARK}`);
	});

	it("duplicateTrip refuses another account's trip", async () => {
		expect(await duplicateTrip(b, tripA)).toBeNull();
	});
});

// ── Search ───────────────────────────────────────────────────────────────
describe('search owner filtering', () => {
	it("finds A's data for A, nothing for B", async () => {
		const forA = await search(a, MARK);
		const forB = await search(b, MARK);
		expect(forA.length).toBeGreaterThanOrEqual(4); // trip, place, packing, expense
		expect(forB).toEqual([]);
	});
});

// ── Templates ────────────────────────────────────────────────────────────
describe('packing template owner filtering', () => {
	it('listTemplates is per-account', async () => {
		expect((await listTemplates(a)).map((t) => t.id)).toContain(tmplA);
		expect((await listTemplates(b)).map((t) => t.id)).not.toContain(tmplA);
	});

	it("saveListAsTemplate refuses another account's list", async () => {
		expect(await saveListAsTemplate(b, listA, 'steal')).toBeNull();
	});

	it("applyTemplate refuses another account's template or trip", async () => {
		expect(await applyTemplate(b, tmplA, tripB)).toBeNull(); // B, A's template
		expect(await applyTemplate(a, tmplA, tripB)).toBeNull(); // A, B's trip
	});

	it("deleteTemplate refuses another account's template", async () => {
		expect(await deleteTemplate(b, tmplA)).toBe(false);
		expect((await listTemplates(a)).map((t) => t.id)).toContain(tmplA);
	});
});

// ── Attachments ──────────────────────────────────────────────────────────
describe('attachment owner filtering', () => {
	it("getAttachmentForDownload misses another account's attachment", async () => {
		expect(await getAttachmentForDownload(b, tripA, attA)).toBeNull();
		expect((await getAttachmentForDownload(a, tripA, attA))?.object_key).toBe(
			`dbtest/${MARK}-a.pdf`
		);
	});

	it("getAttachmentSource misses another account's attachment", async () => {
		expect(await getAttachmentSource(b, attA)).toBeNull();
		expect((await getAttachmentSource(a, attA))?.kind).toBe('file');
	});
});

// ── Viewer-permitted PATCH helpers ───────────────────────────────────────
describe('viewer-exception mutations stay owner-scoped', () => {
	it('setPackingItemChecked: B misses, A and viewer-of-A hit', async () => {
		expect(await setPackingItemChecked(b, packItemA, true)).toBe(false);
		const still = await query<{ checked: boolean }>(
			`SELECT checked FROM packing_items WHERE id = $1`,
			[packItemA]
		);
		expect(still.rows[0].checked).toBe(false);

		expect(await setPackingItemChecked(a, packItemA, true)).toBe(true);
		expect(await setPackingItemChecked(a, packItemA, false)).toBe(true);
	});

	it('setStopVisited: B misses, A hits', async () => {
		expect(await setStopVisited(b, stopA, true)).toBe(false);
		expect(await setStopVisited(a, stopA, true)).toBe(true);
		expect(await setStopVisited(a, stopA, false)).toBe(true);
	});
});

// ── users table integrity (migration 0011) ──────────────────────────────
describe('users role constraints and trigger', () => {
	it('rejects a viewer without views_user_id (CHECK)', async () => {
		await expect(insertUser('dbtest_bad1', 'viewer', null)).rejects.toThrow(
			/users_views_matches_role/
		);
	});

	it('rejects a non-viewer with views_user_id (CHECK)', async () => {
		await expect(insertUser('dbtest_bad2', 'user', a)).rejects.toThrow(/users_views_matches_role/);
	});

	it("rejects the retired 'owner' role (CHECK)", async () => {
		await expect(insertUser('dbtest_bad3', 'owner', null)).rejects.toThrow(/users_role_check/);
	});

	it('rejects viewer→viewer links (trigger)', async () => {
		await expect(insertUser('dbtest_bad4', 'viewer', v)).rejects.toThrow(
			/must reference an admin or user account/
		);
	});

	it('rejects a viewer viewing itself (trigger)', async () => {
		await expect(query(`UPDATE users SET views_user_id = id WHERE id = $1`, [v])).rejects.toThrow(
			/cannot view itself/
		);
	});

	it('rejects demoting a trip-owning account to viewer (trigger)', async () => {
		await expect(
			query(`UPDATE users SET role = 'viewer', views_user_id = $2 WHERE id = $1`, [b, a])
		).rejects.toThrow(/still owns trips/);
	});

	it('rejects demoting a viewed account to viewer (trigger)', async () => {
		// A owns a trip too, so retarget: give B a viewer and try demoting B
		// after clearing B's trips... simpler: demote A, who is viewed by V.
		// A also owns tripA, so the owns-trips check fires first — assert on
		// a dedicated fixture instead: user C, viewed by viewer W, no trips.
		const c = await insertUser('dbtest_user_c', 'user');
		await insertUser('dbtest_viewer_w', 'viewer', c);
		await expect(
			query(`UPDATE users SET role = 'viewer', views_user_id = $2 WHERE id = $1`, [c, a])
		).rejects.toThrow(/other viewers point at it/);
	});
});

// ── Settings actions authorization ───────────────────────────────────────
type ActionResult = { status?: number } | undefined;

function settingsEvent(user: Record<string, unknown>, fields: Record<string, string>) {
	const body = new FormData();
	for (const [k, v2] of Object.entries(fields)) body.set(k, v2);
	return {
		locals: { user, ownerId: user.id },
		request: new Request('http://localhost/settings', { method: 'POST', body }),
		cookies: { get: () => undefined }
	} as never;
}

describe('settings Users panel authorization', () => {
	const asUserB = {
		make: () => ({ id: b, username: U.user, role: 'user', display_name: 'B', views_user_id: null })
	};

	it('users-create is admin-only (user → 403)', async () => {
		const res = (await settingsActions['users-create'](
			settingsEvent(asUserB.make(), {
				username: 'dbtest_sneak',
				role: 'user',
				password: 'password123',
				confirm_password: 'password123'
			})
		)) as ActionResult;
		expect(res?.status).toBe(403);
		const exists = await query(`SELECT 1 FROM users WHERE username = 'dbtest_sneak'`);
		expect(exists.rowCount).toBe(0);
	});

	it('users-set-password is admin-only (user → 403)', async () => {
		const res = (await settingsActions['users-set-password'](
			settingsEvent(asUserB.make(), {
				user_id: String(a),
				password: 'password123',
				confirm_password: 'password123'
			})
		)) as ActionResult;
		expect(res?.status).toBe(403);
	});

	it('users-create validates the viewer link target', async () => {
		const admin = {
			id: a,
			username: U.admin,
			role: 'admin',
			display_name: 'A',
			views_user_id: null
		};
		const res = (await settingsActions['users-create'](
			settingsEvent(admin, {
				username: 'dbtest_sneak2',
				role: 'viewer',
				views_user_id: String(v), // a viewer — invalid target
				password: 'password123',
				confirm_password: 'password123'
			})
		)) as ActionResult;
		expect(res?.status).toBe(400);
	});
});

// ── Place workspace actions (raw-id POST surface) ────────────────────────
describe('place workspace actions 404 for another account', () => {
	function placeEvent(fields: Record<string, string> = {}) {
		const body = new FormData();
		for (const [k, v2] of Object.entries(fields)) body.set(k, v2);
		return {
			params: { id: String(tripA), itemId: '1' },
			locals: {
				user: { id: b, username: U.user, role: 'user', display_name: 'B', views_user_id: null },
				ownerId: b
			},
			request: new Request('http://localhost/x', { method: 'POST', body })
		} as never;
	}

	const cases: Array<[string, Record<string, string>]> = [
		['save', { lat: '1', lon: '1', place_id: 'x' }],
		['clear', {}],
		['link-place', { place_id: 'x' }],
		['ask-ai', { question: 'hi' }],
		['refresh-details', {}]
	];

	for (const [name, fields] of cases) {
		it(`${name}: B against A's trip → 404`, async () => {
			const action = placeActions[name as keyof typeof placeActions];
			await expect(action(placeEvent(fields))).rejects.toMatchObject({ status: 404 });
		});
	}
});
