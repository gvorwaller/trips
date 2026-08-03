// td-430ffe: the itinerary item is the single source of truth for "visited",
// and writes propagate BOTH ways between a place and every day-plan stop copy
// of it. Runs against the real test cluster (npm run test:db) because the
// thing under test is the transactional SQL fan-out itself. The fixture
// deliberately puts the same place in TWO plans: updating only the clicked
// copy is exactly the disagreement the design exists to prevent (the prod
// copy had 21 multi-plan items and 4 already-conflicting ones when this was
// designed).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query, withTransaction } from '$lib/db';
import { deleteItem, setItemVisited } from '$server/itinerary';
import {
	addStop,
	duplicateDayPlan,
	removeStop,
	reorderStops,
	setStopVisited,
	updateDayPlan
} from '$server/dayplans';
import { duplicateTrip } from '$server/clone';
import { PATCH as itinVisitedPatch } from '../../routes/api/itinerary/visited/+server';

const USERNAME = 'dbtest_visited_prop';

let userId = 0;
let tripId = 0;
let place = 0; // the shared place
let plan1 = 0;
let plan2 = 0;
let copy1 = 0; // stop in plan1 → place
let copy2 = 0; // stop in plan2 → place
let orphan = 0; // stop in plan1 with NULL itinerary_item_id

async function flags() {
	const item = (
		await query<{ visited: boolean }>(`SELECT visited FROM itinerary_items WHERE id = $1`, [place])
	).rows[0].visited;
	const stops = new Map<number, boolean>();
	for (const row of (
		await query<{ id: number; visited: boolean }>(
			`SELECT id, visited FROM day_plan_stops WHERE id = ANY($1::int[])`,
			[[copy1, copy2, orphan]]
		)
	).rows) {
		stops.set(row.id, row.visited);
	}
	return { item, copy1: stops.get(copy1), copy2: stops.get(copy2), orphan: stops.get(orphan) };
}

beforeAll(async () => {
	await query(`DELETE FROM users WHERE username = $1`, [USERNAME]);
	userId = (
		await query<{ id: number }>(
			`INSERT INTO users (username, display_name, password_hash, role)
			 VALUES ($1, $1, 'x', 'user') RETURNING id`,
			[USERNAME]
		)
	).rows[0].id;
	tripId = (
		await query<{ id: number }>(`INSERT INTO trips (owner_id, name) VALUES ($1, $2) RETURNING id`, [
			userId,
			'Visited propagation test'
		])
	).rows[0].id;
	place = (
		await query<{ id: number }>(
			`INSERT INTO itinerary_items (trip_id, item_type, title, lat, lon)
			 VALUES ($1, 'place', 'Shared lighthouse', 44.4, -68.2) RETURNING id`,
			[tripId]
		)
	).rows[0].id;
	plan1 = (
		await query<{ id: number }>(
			`INSERT INTO day_plans (trip_id, title) VALUES ($1, 'Day 1') RETURNING id`,
			[tripId]
		)
	).rows[0].id;
	plan2 = (
		await query<{ id: number }>(
			`INSERT INTO day_plans (trip_id, title) VALUES ($1, 'Day 2') RETURNING id`,
			[tripId]
		)
	).rows[0].id;
	copy1 = (
		await query<{ id: number }>(
			`INSERT INTO day_plan_stops (day_plan_id, itinerary_item_id, snapshot_title)
			 VALUES ($1, $2, 'Shared lighthouse') RETURNING id`,
			[plan1, place]
		)
	).rows[0].id;
	copy2 = (
		await query<{ id: number }>(
			`INSERT INTO day_plan_stops (day_plan_id, itinerary_item_id, snapshot_title)
			 VALUES ($1, $2, 'Shared lighthouse') RETURNING id`,
			[plan2, place]
		)
	).rows[0].id;
	orphan = (
		await query<{ id: number }>(
			`INSERT INTO day_plan_stops (day_plan_id, itinerary_item_id, snapshot_title)
			 VALUES ($1, NULL, 'Deleted place remnant') RETURNING id`,
			[plan1]
		)
	).rows[0].id;
});

afterAll(async () => {
	await query(`DELETE FROM users WHERE username = $1`, [USERNAME]);
	await closePool();
});

describe('visited propagation between a place and its stop copies', () => {
	it('item click fans out to EVERY linked stop copy, not just one plan', async () => {
		expect(await setItemVisited(userId, place, true)).toBe(true);
		expect(await flags()).toEqual({ item: true, copy1: true, copy2: true, orphan: false });

		expect(await setItemVisited(userId, place, false)).toBe(true);
		expect(await flags()).toEqual({ item: false, copy1: false, copy2: false, orphan: false });
	});

	it('stop click updates the item and every OTHER copy of it', async () => {
		expect(await setStopVisited(userId, copy1, true)).toBe(true);
		expect(await flags()).toEqual({ item: true, copy1: true, copy2: true, orphan: false });

		// Un-visiting from the second plan's copy clears everywhere too.
		expect(await setStopVisited(userId, copy2, false)).toBe(true);
		expect(await flags()).toEqual({ item: false, copy1: false, copy2: false, orphan: false });
	});

	it('orphan stops (place deleted) keep their own flag, both directions', async () => {
		expect(await setStopVisited(userId, orphan, true)).toBe(true);
		expect(await flags()).toEqual({ item: false, copy1: false, copy2: false, orphan: true });

		// Item writes never touch the orphan.
		expect(await setItemVisited(userId, place, true)).toBe(true);
		expect((await flags()).orphan).toBe(true);
		expect(await setItemVisited(userId, place, false)).toBe(true);
		expect((await flags()).orphan).toBe(true);

		expect(await setStopVisited(userId, orphan, false)).toBe(true);
		expect((await flags()).orphan).toBe(false);
	});
});

describe('the invariant survives future writes, not just the migration', () => {
	it('adding an already-visited place to a plan creates a stop born visited', async () => {
		await setItemVisited(userId, place, true);
		const plan3 = (
			await query<{ id: number }>(
				`INSERT INTO day_plans (trip_id, title) VALUES ($1, 'Day 3') RETURNING id`,
				[tripId]
			)
		).rows[0].id;
		const newStop = await addStop(tripId, plan3, { itinerary_item_id: place, notes: null });
		expect(newStop).not.toBeNull();
		const row = await query<{ visited: boolean }>(
			`SELECT visited FROM day_plan_stops WHERE id = $1`,
			[newStop]
		);
		expect(row.rows[0].visited).toBe(true);
		await query(`DELETE FROM day_plans WHERE id = $1`, [plan3]);
		await setItemVisited(userId, place, false);
	});

	it('duplicating a plan keeps linked copies agreeing with the item; orphans reset', async () => {
		await setItemVisited(userId, place, true);
		await query(`UPDATE day_plan_stops SET visited = TRUE WHERE id = $1`, [orphan]);

		const copyPlan = await duplicateDayPlan(tripId, plan1, 'Day 1 again');
		expect(copyPlan).not.toBeNull();
		const rows = await query<{ itinerary_item_id: number | null; visited: boolean }>(
			`SELECT itinerary_item_id, visited FROM day_plan_stops WHERE day_plan_id = $1`,
			[copyPlan]
		);
		const linked = rows.rows.find((r) => r.itinerary_item_id === place);
		const orphanCopy = rows.rows.find((r) => r.itinerary_item_id === null);
		expect(linked?.visited).toBe(true); // mirrors the canonical item
		expect(orphanCopy?.visited).toBe(false); // no canonical truth → reset

		await query(`DELETE FROM day_plans WHERE id = $1`, [copyPlan]);
		await query(`UPDATE day_plan_stops SET visited = FALSE WHERE id = $1`, [orphan]);
		await setItemVisited(userId, place, false);
	});
});

describe('place-only authorization (viewer-whitelisted endpoint)', () => {
	let sectionId = 0;

	beforeAll(async () => {
		sectionId = (
			await query<{ id: number }>(
				`INSERT INTO itinerary_items (trip_id, item_type, title)
				 VALUES ($1, 'section', 'Not a place') RETURNING id`,
				[tripId]
			)
		).rows[0].id;
	});

	it('setItemVisited refuses non-place items and changes nothing', async () => {
		expect(await setItemVisited(userId, sectionId, true)).toBe(false);
		const still = await query<{ visited: boolean }>(
			`SELECT visited FROM itinerary_items WHERE id = $1`,
			[sectionId]
		);
		expect(still.rows[0].visited).toBe(false);
	});

	it('the PATCH endpoint 404s a non-place id', async () => {
		const event = {
			request: new Request('http://localhost/api/itinerary/visited', {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id: sectionId, visited: true })
			}),
			locals: { ownerId: userId }
		} as never;
		await expect(itinVisitedPatch(event)).rejects.toMatchObject({ status: 404 });
	});
});

describe('concurrent check-offs do not deadlock (canonical lock order)', () => {
	it('simultaneous item and stop writes on the same place all settle', async () => {
		// Before the lock-order fix, item→stops racing stop→item→stops made
		// PostgreSQL abort one transaction with a deadlock error. Ten rounds of
		// deliberately opposed concurrent writes; every call must resolve.
		for (let round = 0; round < 10; round++) {
			const target = round % 2 === 0;
			const results = await Promise.all([
				setItemVisited(userId, place, target),
				setStopVisited(userId, copy1, !target),
				setStopVisited(userId, copy2, target)
			]);
			expect(results).toEqual([true, true, true]);
			// Whichever write won, the invariant must hold: item and every
			// linked copy agree.
			const state = await flags();
			expect(state.copy1).toBe(state.item);
			expect(state.copy2).toBe(state.item);
		}
		await setItemVisited(userId, place, false);
	});
});

describe('non-place items cannot be reached through stops', () => {
	let sectionB = 0;
	let legacyStop = 0;

	beforeAll(async () => {
		sectionB = (
			await query<{ id: number }>(
				`INSERT INTO itinerary_items (trip_id, item_type, title)
				 VALUES ($1, 'section', 'Legacy section') RETURNING id`,
				[tripId]
			)
		).rows[0].id;
		// A legacy-shaped stop linked to a NON-place, inserted with raw SQL —
		// insertStop refuses to create these now, but pre-fix rows could exist.
		legacyStop = (
			await query<{ id: number }>(
				`INSERT INTO day_plan_stops (day_plan_id, itinerary_item_id, snapshot_title)
				 VALUES ($1, $2, 'Legacy section stop') RETURNING id`,
				[plan1, sectionB]
			)
		).rows[0].id;
	});

	it('addStop refuses to link a section/day/note', async () => {
		expect(await addStop(tripId, plan2, { itinerary_item_id: sectionB, notes: null })).toBeNull();
	});

	it('setStopVisited on a non-place-linked stop flips ONLY the stop', async () => {
		expect(await setStopVisited(userId, legacyStop, true)).toBe(true);
		const stop = await query<{ visited: boolean }>(
			`SELECT visited FROM day_plan_stops WHERE id = $1`,
			[legacyStop]
		);
		const section = await query<{ visited: boolean }>(
			`SELECT visited FROM itinerary_items WHERE id = $1`,
			[sectionB]
		);
		expect(stop.rows[0].visited).toBe(true); // the click is honored…
		expect(section.rows[0].visited).toBe(false); // …the non-place item is not touched
		await setStopVisited(userId, legacyStop, false);
	});
});

describe('the invariant survives CONCURRENT writes (locked reads)', () => {
	it('addStop racing a toggle never births a stale copy', async () => {
		// Pre-lock, an all-success schedule existed: addStop reads visited,
		// the toggle commits item+copies, addStop inserts its stale read. The
		// FOR UPDATE read closes it. Whatever the interleaving, the new copy
		// must agree with the item once both settle.
		for (let round = 0; round < 8; round++) {
			const plan = (
				await query<{ id: number }>(
					`INSERT INTO day_plans (trip_id, title) VALUES ($1, $2) RETURNING id`,
					[tripId, `add race ${round}`]
				)
			).rows[0].id;
			const [stopId, toggled] = await Promise.all([
				addStop(tripId, plan, { itinerary_item_id: place, notes: null }),
				setItemVisited(userId, place, round % 2 === 0)
			]);
			expect(stopId).not.toBeNull();
			expect(toggled).toBe(true);
			const item = await query<{ visited: boolean }>(
				`SELECT visited FROM itinerary_items WHERE id = $1`,
				[place]
			);
			const stop = await query<{ visited: boolean }>(
				`SELECT visited FROM day_plan_stops WHERE id = $1`,
				[stopId]
			);
			expect(stop.rows[0].visited).toBe(item.rows[0].visited);
			await query(`DELETE FROM day_plans WHERE id = $1`, [plan]);
		}
		await setItemVisited(userId, place, false);
	});

	it('duplicateDayPlan racing a toggle never births stale copies', async () => {
		for (let round = 0; round < 8; round++) {
			const [copyPlan, toggled] = await Promise.all([
				duplicateDayPlan(tripId, plan2, `dup race ${round}`),
				setItemVisited(userId, place, round % 2 === 0)
			]);
			expect(copyPlan).not.toBeNull();
			expect(toggled).toBe(true);
			const item = await query<{ visited: boolean }>(
				`SELECT visited FROM itinerary_items WHERE id = $1`,
				[place]
			);
			const copies = await query<{ visited: boolean }>(
				`SELECT visited FROM day_plan_stops WHERE day_plan_id = $1 AND itinerary_item_id = $2`,
				[copyPlan, place]
			);
			expect(copies.rows.length).toBeGreaterThan(0);
			for (const copy of copies.rows) {
				expect(copy.visited).toBe(item.rows[0].visited);
			}
			await query(`DELETE FROM day_plans WHERE id = $1`, [copyPlan]);
		}
		await setItemVisited(userId, place, false);
	});
});

describe('visited writers coexist with ordinary stop writers (lock order)', () => {
	it('a fan-out blocked behind a held stop lock resolves without deadlock', async () => {
		// Deterministic replay of the schedule peer CODEX reproduced (40P01):
		// writer B is an ordinary stop writer (notes), which locks stop → trips
		// (0010 trigger). Pre-fix, setItemVisited's item UPDATE grabbed the
		// trips row via its own trigger BEFORE locking the stops, so A held
		// trips wanting the stop while B held the stop wanting trips. The fix
		// takes all row locks with trigger-free SELECT … FOR UPDATE first;
		// under the old code this exact schedule deadlocks, under the new one
		// it serializes.
		let releaseHold!: () => void;
		const holdReleased = new Promise<void>((r) => (releaseHold = r));
		let lockTaken!: () => void;
		const lockTakenP = new Promise<void>((r) => (lockTaken = r));

		const writerB = withTransaction(async (client) => {
			await client.query(`SELECT id FROM day_plan_stops WHERE id = $1 FOR UPDATE`, [copy1]);
			lockTaken();
			await holdReleased;
			await client.query(`UPDATE day_plan_stops SET notes = 'lock test' WHERE id = $1`, [
				copy1
			]);
		});
		await lockTakenP;
		const writerA = setItemVisited(userId, place, true);
		// Give A time to reach the stop-lock wait behind B.
		await new Promise((r) => setTimeout(r, 200));
		releaseHold();
		await writerB;
		expect(await writerA).toBe(true);
		const state = await flags();
		expect(state.item).toBe(true);
		expect(state.copy1).toBe(true);
		expect(state.copy2).toBe(true);
		await query(`UPDATE day_plan_stops SET notes = NULL WHERE id = $1`, [copy1]);
		await setItemVisited(userId, place, false);
	});
});

describe('multi-stop plan writers coexist with held stop locks (round 4)', () => {
	// Peer CODEX reproduced this exact schedule with the pre-fix code: addStop
	// INSERTed its new stop (taking the trips row via the 0010 trigger) and
	// only then reached clearDrivingForPlan's sweep of the other stops — so it
	// held trips while seeking a stop an ordinary stop writer held, and that
	// writer wanted trips: 40P01. lockPlanStops now takes every stop lock
	// trigger-free BEFORE the INSERT can touch trips.
	it('addStop parked behind a held stop lock resolves without deadlock', async () => {
		const farPlace = (
			await query<{ id: number }>(
				`INSERT INTO itinerary_items (trip_id, item_type, title, lat, lon)
				 VALUES ($1, 'place', 'Far waypoint', 45.0, -69.0) RETURNING id`,
				[tripId]
			)
		).rows[0].id;
		let release!: () => void;
		const released = new Promise<void>((r) => (release = r));
		let lockTaken!: () => void;
		const lockTakenP = new Promise<void>((r) => (lockTaken = r));

		const writerB = withTransaction(async (client) => {
			await client.query(`SELECT id FROM day_plan_stops WHERE id = $1 FOR UPDATE`, [copy1]);
			lockTaken();
			await released;
			await client.query(`UPDATE day_plan_stops SET notes = 'addStop race' WHERE id = $1`, [
				copy1
			]);
		});
		await lockTakenP;
		const writerA = addStop(tripId, plan1, { itinerary_item_id: farPlace, notes: null });
		await new Promise((r) => setTimeout(r, 200));
		release();
		await writerB;
		const newStopId = await writerA;
		expect(newStopId).not.toBeNull();

		expect(await removeStop(tripId, newStopId as number)).toBe(true);
		await query(`UPDATE day_plan_stops SET notes = NULL WHERE id = $1`, [copy1]);
		await query(`DELETE FROM itinerary_items WHERE id = $1`, [farPlace]);
	});

	it('two reorders with opposite requested orders both settle, parked behind a held lock', async () => {
		const ids = (
			await query<{ id: number }>(
				`SELECT id FROM day_plan_stops WHERE day_plan_id = $1 ORDER BY sort_order, id`,
				[plan1]
			)
		).rows.map((r) => r.id);
		expect(ids.length).toBeGreaterThanOrEqual(2);

		let release!: () => void;
		const released = new Promise<void>((r) => (release = r));
		let lockTaken!: () => void;
		const lockTakenP = new Promise<void>((r) => (lockTaken = r));
		const holder = withTransaction(async (client) => {
			await client.query(`SELECT id FROM day_plan_stops WHERE id = $1 FOR UPDATE`, [ids[0]]);
			lockTaken();
			await released;
		});
		await lockTakenP;
		// Both park at the id-ordered prelock; pre-fix their per-stop UPDATEs
		// ran in caller order, so opposite orders could interleave into a
		// deadlock once released.
		const forward = reorderStops(tripId, plan1, ids);
		const backward = reorderStops(tripId, plan1, [...ids].reverse());
		await new Promise((r) => setTimeout(r, 200));
		release();
		await holder;
		expect(await forward).toBe(true);
		expect(await backward).toBe(true);

		const after = await query<{ id: number; sort_order: number }>(
			`SELECT id, sort_order FROM day_plan_stops WHERE day_plan_id = $1 ORDER BY sort_order`,
			[plan1]
		);
		// Whichever writer committed last, the result is a contiguous 0..n-1
		// permutation of the same stops.
		expect(after.rows.map((r) => r.sort_order)).toEqual(ids.map((_, i) => i));
		expect(new Set(after.rows.map((r) => r.id))).toEqual(new Set(ids));
	});
});

describe('the plan row is part of the canonical lock order (round 5)', () => {
	// Peer CODEX reproduced this 40P01: a multi-stop writer updated stops
	// first (each 0010 stop trigger takes trips) and only then wrote the
	// day_plans row, while updateDayPlan naturally goes plan → trips. The
	// plan-row FOR UPDATE now heads lockPlanStops, so a barrier writer parks
	// at the plan row holding nothing instead of holding trips while seeking
	// the plan.
	it('a reorder parked behind a held plan-row lock coexists with a plan update', async () => {
		const ids = (
			await query<{ id: number }>(
				`SELECT id FROM day_plan_stops WHERE day_plan_id = $1 ORDER BY sort_order, id`,
				[plan1]
			)
		).rows.map((r) => r.id);

		let release!: () => void;
		const released = new Promise<void>((r) => (release = r));
		let lockTaken!: () => void;
		const lockTakenP = new Promise<void>((r) => (lockTaken = r));
		const holder = withTransaction(async (client) => {
			await client.query(`SELECT id FROM day_plans WHERE id = $1 FOR UPDATE`, [plan1]);
			lockTaken();
			await released;
			// The holder itself writes the plan row (taking trips through the
			// trigger) before committing — under the pre-fix code the parked
			// reorder held trips at this point and the two deadlocked.
			await client.query(`UPDATE day_plans SET notes = notes WHERE id = $1`, [plan1]);
		});
		await lockTakenP;
		const reorder = reorderStops(tripId, plan1, [...ids].reverse());
		await new Promise((r) => setTimeout(r, 200));
		release();
		await holder;
		expect(await reorder).toBe(true);
		// Restore original order for later blocks.
		expect(await reorderStops(tripId, plan1, ids)).toBe(true);
	});

	it('updateDayPlan against a parked barrier writer also settles', async () => {
		let release!: () => void;
		const released = new Promise<void>((r) => (release = r));
		let lockTaken!: () => void;
		const lockTakenP = new Promise<void>((r) => (lockTaken = r));
		const holder = withTransaction(async (client) => {
			await client.query(`SELECT id FROM day_plan_stops WHERE id = $1 FOR UPDATE`, [copy1]);
			lockTaken();
			await released;
			await client.query(`UPDATE day_plan_stops SET notes = NULL WHERE id = $1`, [copy1]);
		});
		await lockTakenP;
		// A visited writer parks at the held stop (holding its item lock, NOT
		// trips); a direct plan update (plan → trips) must still get through
		// while it waits — nobody in this schedule ever holds trips while
		// seeking another row.
		const parkedVisited = setItemVisited(userId, place, false);
		const plain = updateDayPlan(tripId, plan1, {
			title: 'Day 1',
			notes: null,
			optional_date: null
		});
		await new Promise((r) => setTimeout(r, 200));
		release();
		await holder;
		expect(await plain).toBe(true);
		expect(await parkedVisited).toBe(true);
	});
});

describe('the plan-row barrier defeats stop-insert phantoms (round 5)', () => {
	it('two concurrent adds to an EMPTY plan produce unique contiguous sort orders', async () => {
		// Pre-fix: MAX(sort_order) was computed before any lock, and on an
		// empty plan the stop prelock locked no rows at all — two adds both
		// read next=0 and committed duplicate sort_order. The plan-row
		// FOR UPDATE conflicts with the FK key-share an inserting child needs,
		// so while the holder holds it neither add can insert, and each add
		// computes MAX only after acquiring the plan row itself.
		const emptyPlan = (
			await query<{ id: number }>(
				`INSERT INTO day_plans (trip_id, title) VALUES ($1, 'Phantom test') RETURNING id`,
				[tripId]
			)
		).rows[0].id;
		const itemA = (
			await query<{ id: number }>(
				`INSERT INTO itinerary_items (trip_id, item_type, title, lat, lon)
				 VALUES ($1, 'place', 'Phantom A', 45.1, -69.1) RETURNING id`,
				[tripId]
			)
		).rows[0].id;
		const itemB = (
			await query<{ id: number }>(
				`INSERT INTO itinerary_items (trip_id, item_type, title, lat, lon)
				 VALUES ($1, 'place', 'Phantom B', 45.2, -69.2) RETURNING id`,
				[tripId]
			)
		).rows[0].id;

		let release!: () => void;
		const released = new Promise<void>((r) => (release = r));
		let lockTaken!: () => void;
		const lockTakenP = new Promise<void>((r) => (lockTaken = r));
		const holder = withTransaction(async (client) => {
			await client.query(`SELECT id FROM day_plans WHERE id = $1 FOR UPDATE`, [emptyPlan]);
			lockTaken();
			await released;
		});
		await lockTakenP;
		const addA = addStop(tripId, emptyPlan, { itinerary_item_id: itemA, notes: null });
		const addB = addStop(tripId, emptyPlan, { itinerary_item_id: itemB, notes: null });
		await new Promise((r) => setTimeout(r, 200));
		release();
		await holder;
		expect(await addA).not.toBeNull();
		expect(await addB).not.toBeNull();

		const sorts = (
			await query<{ sort_order: number }>(
				`SELECT sort_order FROM day_plan_stops WHERE day_plan_id = $1 ORDER BY sort_order`,
				[emptyPlan]
			)
		).rows.map((r) => r.sort_order);
		expect(sorts).toEqual([0, 1]);

		await query(`DELETE FROM day_plans WHERE id = $1`, [emptyPlan]);
		await query(`DELETE FROM itinerary_items WHERE id = ANY($1::int[])`, [[itemA, itemB]]);
	});

	it('concurrent add and remove keep the stop set contiguous', async () => {
		const p = (
			await query<{ id: number }>(
				`INSERT INTO day_plans (trip_id, title) VALUES ($1, 'Add-remove test') RETURNING id`,
				[tripId]
			)
		).rows[0].id;
		const mk = async (n: number) =>
			(
				await query<{ id: number }>(
					`INSERT INTO itinerary_items (trip_id, item_type, title, lat, lon)
					 VALUES ($1, 'place', $2, $3, $4) RETURNING id`,
					[tripId, `AddRemove ${n}`, 45.3 + n * 0.1, -69.3 - n * 0.1]
				)
			).rows[0].id;
		const i1 = await mk(1);
		const i2 = await mk(2);
		const i3 = await mk(3);
		const s1 = await addStop(tripId, p, { itinerary_item_id: i1, notes: null });
		await addStop(tripId, p, { itinerary_item_id: i2, notes: null });

		let release!: () => void;
		const released = new Promise<void>((r) => (release = r));
		let lockTaken!: () => void;
		const lockTakenP = new Promise<void>((r) => (lockTaken = r));
		const holder = withTransaction(async (client) => {
			await client.query(`SELECT id FROM day_plans WHERE id = $1 FOR UPDATE`, [p]);
			lockTaken();
			await released;
		});
		await lockTakenP;
		const adding = addStop(tripId, p, { itinerary_item_id: i3, notes: null });
		const removing = removeStop(tripId, s1 as number);
		await new Promise((r) => setTimeout(r, 200));
		release();
		await holder;
		expect(await adding).not.toBeNull();
		expect(await removing).toBe(true);

		const sorts = (
			await query<{ sort_order: number }>(
				`SELECT sort_order FROM day_plan_stops WHERE day_plan_id = $1 ORDER BY sort_order`,
				[p]
			)
		).rows.map((r) => r.sort_order);
		expect(sorts).toEqual([0, 1]);

		await query(`DELETE FROM day_plans WHERE id = $1`, [p]);
		await query(`DELETE FROM itinerary_items WHERE id = ANY($1::int[])`, [[i1, i2, i3]]);
	});
});

describe('cascade deletes follow the canonical lock order (td-36b55b)', () => {
	it('deleteItem parked behind a held stop lock resolves without deadlock', async () => {
		// Pre-fix, the bare DELETE took the trips row (0010 trigger) and THEN
		// swept linked stops via the FK's ON DELETE SET NULL — so it held
		// trips while seeking a stop an ordinary stop writer held, and that
		// writer wanted trips: 40P01. The subtree-items + linked-stops prelock
		// parks the delete before it ever touches trips.
		const parent = (
			await query<{ id: number }>(
				`INSERT INTO itinerary_items (trip_id, item_type, title)
				 VALUES ($1, 'section', 'Doomed section') RETURNING id`,
				[tripId]
			)
		).rows[0].id;
		const child = (
			await query<{ id: number }>(
				`INSERT INTO itinerary_items (trip_id, parent_id, item_type, title, lat, lon)
				 VALUES ($1, $2, 'place', 'Doomed place', 45.5, -69.5) RETURNING id`,
				[tripId, parent]
			)
		).rows[0].id;
		const doomedStop = (
			await query<{ id: number }>(
				`INSERT INTO day_plan_stops (day_plan_id, itinerary_item_id, snapshot_title)
				 VALUES ($1, $2, 'Doomed place') RETURNING id`,
				[plan1, child]
			)
		).rows[0].id;

		let release!: () => void;
		const released = new Promise<void>((r) => (release = r));
		let lockTaken!: () => void;
		const lockTakenP = new Promise<void>((r) => (lockTaken = r));
		const writerB = withTransaction(async (client) => {
			await client.query(`SELECT id FROM day_plan_stops WHERE id = $1 FOR UPDATE`, [
				doomedStop
			]);
			lockTaken();
			await released;
			// The ordinary stop writer's second half: takes trips via trigger.
			await client.query(`UPDATE day_plan_stops SET notes = 'cascade race' WHERE id = $1`, [
				doomedStop
			]);
		});
		await lockTakenP;
		const writerA = deleteItem(tripId, parent);
		await new Promise((r) => setTimeout(r, 200));
		release();
		await writerB;
		expect(await writerA).toBe(true);

		// The subtree is gone and the linked stop became a true orphan.
		const remaining = await query<{ n: string }>(
			`SELECT count(*) n FROM itinerary_items WHERE id = ANY($1::int[])`,
			[[parent, child]]
		);
		expect(Number(remaining.rows[0].n)).toBe(0);
		const orphaned = await query<{ itinerary_item_id: number | null }>(
			`SELECT itinerary_item_id FROM day_plan_stops WHERE id = $1`,
			[doomedStop]
		);
		expect(orphaned.rows[0].itinerary_item_id).toBeNull();
		await query(`DELETE FROM day_plan_stops WHERE id = $1`, [doomedStop]);
	});

	it('deleteItem still refuses cross-trip ids and reports false', async () => {
		const otherTrip = (
			await query<{ id: number }>(
				`INSERT INTO trips (owner_id, name) VALUES ($1, 'Other') RETURNING id`,
				[userId]
			)
		).rows[0].id;
		expect(await deleteItem(otherTrip, place)).toBe(false);
		const still = await query<{ n: string }>(
			`SELECT count(*) n FROM itinerary_items WHERE id = $1`,
			[place]
		);
		expect(Number(still.rows[0].n)).toBe(1);
		await query(`DELETE FROM trips WHERE id = $1`, [otherTrip]);
	});
});

describe('cross-trip stop links are impossible at the data layer (0016)', () => {
	it('inserting or relinking a stop to another trip’s item raises', async () => {
		const trip2 = (
			await query<{ id: number }>(
				`INSERT INTO trips (owner_id, name) VALUES ($1, 'Other trip') RETURNING id`,
				[userId]
			)
		).rows[0].id;
		const foreignPlan = (
			await query<{ id: number }>(
				`INSERT INTO day_plans (trip_id, title) VALUES ($1, 'Foreign plan') RETURNING id`,
				[trip2]
			)
		).rows[0].id;

		await expect(
			query(
				`INSERT INTO day_plan_stops (day_plan_id, itinerary_item_id, snapshot_title)
				 VALUES ($1, $2, 'cross-trip')`,
				[foreignPlan, place]
			)
		).rejects.toThrow(/link rejected/);

		const orphanInTrip2 = (
			await query<{ id: number }>(
				`INSERT INTO day_plan_stops (day_plan_id, itinerary_item_id, snapshot_title)
				 VALUES ($1, NULL, 'legal orphan') RETURNING id`,
				[foreignPlan]
			)
		).rows[0].id;
		await expect(
			query(`UPDATE day_plan_stops SET itinerary_item_id = $2 WHERE id = $1`, [
				orphanInTrip2,
				place
			])
		).rejects.toThrow(/link rejected/);

		await query(`DELETE FROM trips WHERE id = $1`, [trip2]);
	});
});

describe('migration 0014 reconciliation semantics (bool_or)', () => {
	it('any visited stop copy wins over an unvisited item, then all copies normalise', async () => {
		// Recreate the pre-migration shape: item false, copies disagreeing.
		await query(`UPDATE itinerary_items SET visited = FALSE WHERE id = $1`, [place]);
		await query(`UPDATE day_plan_stops SET visited = TRUE  WHERE id = $1`, [copy1]);
		await query(`UPDATE day_plan_stops SET visited = FALSE WHERE id = $1`, [copy2]);

		// The migration's two statements, scoped to this trip so the shared
		// test DB's other fixtures are untouched.
		await query(
			`UPDATE itinerary_items i SET visited = TRUE
			   FROM day_plan_stops s
			  WHERE s.itinerary_item_id = i.id AND s.visited AND i.trip_id = $1`,
			[tripId]
		);
		await query(
			`UPDATE day_plan_stops s SET visited = i.visited
			   FROM itinerary_items i
			  WHERE s.itinerary_item_id = i.id AND s.visited <> i.visited AND i.trip_id = $1`,
			[tripId]
		);

		expect(await flags()).toEqual({ item: true, copy1: true, copy2: true, orphan: false });

		// Reset for any later block.
		await setItemVisited(userId, place, false);
	});
});

describe('clone drops visited by construction', () => {
	it('a duplicated trip starts with every place unvisited', async () => {
		await setItemVisited(userId, place, true);
		const newTripId = await duplicateTrip(userId, tripId);
		expect(newTripId).not.toBeNull();
		const cloned = await query<{ visited: boolean }>(
			`SELECT visited FROM itinerary_items WHERE trip_id = $1`,
			[newTripId]
		);
		expect(cloned.rows.length).toBeGreaterThan(0);
		expect(cloned.rows.every((r) => r.visited === false)).toBe(true);
		// The source item keeps its flag.
		expect((await flags()).item).toBe(true);
		await setItemVisited(userId, place, false);
		await query(`DELETE FROM trips WHERE id = $1`, [newTripId]);
	});
});
