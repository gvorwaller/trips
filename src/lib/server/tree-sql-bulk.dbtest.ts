// td-947440: bulk "move under" runs as ONE transaction. The pure layer
// (computeReparentMany, unit-tested) cannot cover the two things that live at
// the SQL boundary: a batch containing an id from ANOTHER trip must throw and
// write NOTHING (all-or-nothing rollback), and a valid batch must commit its
// combined change set atomically. Runs against the real test cluster
// (npm run test:db).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query, withTransaction } from '$lib/db';
import { createItem } from '$server/itinerary';
import { createPackingItemAt } from '$server/packing';
import { TreeConcurrencyError, runReparentMany, runTreeOp } from '$server/tree-sql';

const USERNAME_A = 'dbtest_bulk_move_a';
const USERNAME_B = 'dbtest_bulk_move_b';

let tripA = 0;
let tripB = 0;
let sectionA = 0; // top-level section in trip A (bulk target)
let placeA1 = 0; // top-level place in trip A
let placeA2 = 0; // top-level place in trip A
let placeB = 0; // place in trip B — the foreign id

async function insertUserTrip(username: string, tripName: string) {
	await query(`DELETE FROM users WHERE username = $1`, [username]);
	const userId = (
		await query<{ id: number }>(
			`INSERT INTO users (username, display_name, password_hash, role)
			 VALUES ($1, $1, 'x', 'user') RETURNING id`,
			[username]
		)
	).rows[0].id;
	const tripId = (
		await query<{ id: number }>(`INSERT INTO trips (owner_id, name) VALUES ($1, $2) RETURNING id`, [
			userId,
			tripName
		])
	).rows[0].id;
	return tripId;
}

async function insertItem(
	tripId: number,
	itemType: string,
	title: string,
	sortOrder: number
): Promise<number> {
	return (
		await query<{ id: number }>(
			`INSERT INTO itinerary_items (trip_id, item_type, title, sort_order)
			 VALUES ($1, $2, $3, $4) RETURNING id`,
			[tripId, itemType, title, sortOrder]
		)
	).rows[0].id;
}

async function rowsOf(tripId: number) {
	return (
		await query<{ id: number; parent_id: number | null; sort_order: number }>(
			`SELECT id, parent_id, sort_order FROM itinerary_items WHERE trip_id = $1 ORDER BY id`,
			[tripId]
		)
	).rows;
}

beforeAll(async () => {
	tripA = await insertUserTrip(USERNAME_A, 'Bulk move test A');
	tripB = await insertUserTrip(USERNAME_B, 'Bulk move test B');
	sectionA = await insertItem(tripA, 'section', 'Target section', 0);
	placeA1 = await insertItem(tripA, 'place', 'Place one', 1);
	placeA2 = await insertItem(tripA, 'place', 'Place two', 2);
	placeB = await insertItem(tripB, 'place', 'Foreign place', 0);
});

afterAll(async () => {
	await query(`DELETE FROM users WHERE username = ANY($1::text[])`, [[USERNAME_A, USERNAME_B]]);
	await closePool();
});

describe('runReparentMany container isolation', () => {
	it('a foreign id in the batch throws and nothing is written', async () => {
		const before = await rowsOf(tripA);
		const beforeB = await rowsOf(tripB);
		await expect(
			runReparentMany('itinerary_items', tripA, [placeA1, placeB], sectionA)
		).rejects.toThrow('Item does not belong to this container');
		// All-or-nothing: the valid id moved nowhere, the foreign row untouched.
		expect(await rowsOf(tripA)).toEqual(before);
		expect(await rowsOf(tripB)).toEqual(beforeB);
	});

	it('a row deleted between snapshot and prelock aborts the whole batch', async () => {
		// The TOCTOU window: runReparentMany's loadNodes sees a row that a
		// concurrent transaction deletes before the FOR UPDATE prelock runs.
		// Deterministic reproduction: hold the victim's row lock in T1 so the
		// bulk MUST queue on it, delete the victim, commit — the bulk wakes to
		// a smaller locked set and must throw, writing nothing.
		const victim = await insertItem(tripA, 'place', 'Victim', 10);
		const mover = await insertItem(tripA, 'place', 'Mover', 11);
		const before = (await rowsOf(tripA)).filter((r) => r.id !== victim);
		let settled: Promise<unknown> = Promise.resolve(null);
		await withTransaction(async (t1) => {
			await t1.query(`SELECT id FROM itinerary_items WHERE id = $1 FOR UPDATE`, [victim]);
			// Capture as a settled value so the rejection is handled no matter
			// when it fires relative to T1's commit.
			settled = runReparentMany('itinerary_items', tripA, [mover, victim], sectionA).then(
				() => null,
				(e: unknown) => e
			);
			// Wait until the bulk transaction is actually queued on the lock.
			for (let i = 0; i < 200; i++) {
				const waiting = await t1.query<{ n: number }>(
					`SELECT count(*)::int AS n FROM pg_locks WHERE granted = false`
				);
				if (waiting.rows[0].n > 0) break;
				await new Promise((r) => setTimeout(r, 25));
			}
			await t1.query(`DELETE FROM itinerary_items WHERE id = $1`, [victim]);
		}); // commit releases the lock
		const err = await settled;
		expect(err).toBeInstanceOf(TreeConcurrencyError);
		// All-or-nothing held: the surviving batch member did not move.
		expect(await rowsOf(tripA)).toEqual(before);
		await query(`DELETE FROM itinerary_items WHERE id = $1`, [mover]);
	});

	it('a valid batch commits the combined change set', async () => {
		const ok = await runReparentMany('itinerary_items', tripA, [placeA2, placeA1], sectionA);
		expect(ok).toBe(true);
		const after = await rowsOf(tripA);
		const a1 = after.find((r) => r.id === placeA1);
		const a2 = after.find((r) => r.id === placeA2);
		// Both under the section, in document order (placeA1 preceded placeA2
		// on screen, so it lands first despite the reversed ids in the call).
		expect(a1?.parent_id).toBe(sectionA);
		expect(a2?.parent_id).toBe(sectionA);
		expect(a1?.sort_order).toBe(0);
		expect(a2?.sort_order).toBe(1);
		// Top level densified to just the section.
		expect(after.find((r) => r.id === sectionA)?.sort_order).toBe(0);
	});

	it('a concurrent insert into the target group cannot mint a duplicate sort_order', async () => {
		// The phantom race the row-count guard cannot see: an INSERT computes
		// MAX from a group a reindex is rewriting. Both writer kinds now take
		// the per-container advisory xact lock first (tableKey 1 = itinerary),
		// so holding that lock in T1 deterministically queues BOTH a bulk move
		// into the section and a createItem under the same section; releasing
		// it serializes them in some order. Whatever the order, the invariant
		// must hold: unique, dense sort_order among the section's children.
		const mover = await insertItem(tripA, 'place', 'Race mover', 20);
		let bulk: Promise<unknown> = Promise.resolve(null);
		let insert: Promise<unknown> = Promise.resolve(null);
		await withTransaction(async (t1) => {
			await t1.query(`SELECT pg_advisory_xact_lock(1::int4, $1::int4)`, [tripA]);
			bulk = runReparentMany('itinerary_items', tripA, [mover], sectionA).then(
				(v) => v,
				(e: unknown) => e
			);
			insert = createItem(tripA, {
				parent_id: sectionA,
				item_type: 'place',
				title: 'Race insert'
			}).then(
				(v) => v,
				(e: unknown) => e
			);
			// Both must be queued on the advisory lock before we release it.
			for (let i = 0; i < 200; i++) {
				const waiting = await t1.query<{ n: number }>(
					`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`
				);
				if (waiting.rows[0].n >= 2) break;
				await new Promise((r) => setTimeout(r, 25));
			}
		}); // commit releases the barrier; the two writers run one at a time
		expect(await bulk).toBe(true);
		expect(typeof (await insert)).toBe('number');
		const children = (
			await query<{ sort_order: number }>(
				`SELECT sort_order FROM itinerary_items WHERE parent_id = $1 ORDER BY sort_order`,
				[sectionA]
			)
		).rows.map((r) => r.sort_order);
		// Dense and unique — the duplicate-sort_order outcome is impossible.
		expect(new Set(children).size).toBe(children.length);
		expect(Math.max(...children)).toBe(children.length - 1);
	});

	it('packing create-at takes the container barrier BEFORE any row lock (deadlock cycle broken)', async () => {
		// The cycle CODEX flagged: createPackingItemAt used to take its
		// list-wide FOR UPDATE prelock and only then hit the advisory lock in
		// nextSortOrder, while tree ops hold advisory and wait for those same
		// rows — a guaranteed 40P01 under contention. Deterministic proof of
		// the fix: hold the list's advisory lock (tableKey 2 = packing) in T1;
		// a create-at MUST queue on it as its FIRST lock, holding NO row locks
		// on packing_items while it waits (under the old order it would
		// already hold the list-wide RowShareLock). Then queue a tree op too
		// and release: both complete, no deadlock, dense unique orders.
		const listId = (
			await query<{ id: number }>(
				`INSERT INTO packing_lists (trip_id, name) VALUES ($1, 'Barrier list') RETURNING id`,
				[tripA]
			)
		).rows[0].id;
		const mk = async (name: string, sort: number) =>
			(
				await query<{ id: number }>(
					`INSERT INTO packing_items (list_id, sort_order, name) VALUES ($1, $2, $3) RETURNING id`,
					[listId, sort, name]
				)
			).rows[0].id;
		const first = await mk('First', 0);
		const second = await mk('Second', 1);
		let createAt: Promise<unknown> = Promise.resolve(null);
		let treeOp: Promise<unknown> = Promise.resolve(null);
		await withTransaction(async (t1) => {
			await t1.query(`SELECT pg_advisory_xact_lock(2::int4, $1::int4)`, [listId]);
			createAt = createPackingItemAt(listId, first, 'below', { name: 'Injected' }).then(
				(v) => v,
				(e: unknown) => e
			);
			for (let i = 0; i < 200; i++) {
				const waiting = await t1.query<{ n: number }>(
					`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`
				);
				if (waiting.rows[0].n >= 1) break;
				await new Promise((r) => setTimeout(r, 25));
			}
			// While queued on the barrier it must hold NO packing_items row
			// locks — the old order would already hold the list-wide prelock.
			const rowLocks = await t1.query<{ n: number }>(
				`SELECT count(*)::int AS n FROM pg_locks
				  WHERE relation = 'packing_items'::regclass AND mode = 'RowShareLock' AND granted`
			);
			expect(rowLocks.rows[0].n).toBe(0);
			treeOp = runTreeOp('packing_items', listId, second, 'move-up').then(
				() => true,
				(e: unknown) => e
			);
			for (let i = 0; i < 200; i++) {
				const waiting = await t1.query<{ n: number }>(
					`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`
				);
				if (waiting.rows[0].n >= 2) break;
				await new Promise((r) => setTimeout(r, 25));
			}
		}); // release the barrier — both writers proceed serially
		expect(typeof (await createAt)).toBe('number');
		expect(await treeOp).toBe(true);
		const orders = (
			await query<{ sort_order: number }>(
				`SELECT sort_order FROM packing_items WHERE list_id = $1 AND parent_id IS NULL ORDER BY sort_order`,
				[listId]
			)
		).rows.map((r) => r.sort_order);
		expect(new Set(orders).size).toBe(orders.length);
		expect(Math.max(...orders)).toBe(orders.length - 1);
	});
});
