import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, query } from '$lib/db';
import {
	bulkUpdateDriving,
	createDayPlan,
	duplicateDayPlan,
	getDayPlan,
	listStopsForTrip,
	setDayPlanAnchor
} from '$server/dayplans';

/**
 * Storage boundary for the drive home (td-bf2909, migration 0013), plus the
 * stale-driving path found in peer review: changing a plan's anchor used to
 * leave the old legs painted as though they described the new base.
 */

const USERNAME = 'dbtest_dayplan_return_leg';

let userId = 0;
let tripId = 0;
let placeA = 0;
let placeB = 0;
let placeC = 0;

const ANCHOR = { source: 'custom:base', title: 'Blue Hill Inn', lat: 44.41, lon: -68.59 };

async function place(title: string, lat: number, lon: number): Promise<number> {
	return (
		await query<{ id: number }>(
			`INSERT INTO itinerary_items (trip_id, item_type, title, lat, lon)
			 VALUES ($1, 'place', $2, $3, $4) RETURNING id`,
			[tripId, title, lat, lon]
		)
	).rows[0].id;
}

async function newPlan(withAnchor: boolean): Promise<number> {
	const planId = await createDayPlan(tripId, {
		title: 'Return leg plan',
		notes: null,
		optional_date: null,
		stops: [
			{ itinerary_item_id: placeA, notes: null },
			{ itinerary_item_id: placeB, notes: null },
			{ itinerary_item_id: placeC, notes: null }
		]
	});
	if (withAnchor) await setDayPlanAnchor(tripId, planId, ANCHOR);
	return planId;
}

function stopIds(planId: number, all: Awaited<ReturnType<typeof listStopsForTrip>>): number[] {
	return all.filter((s) => s.day_plan_id === planId).map((s) => s.id);
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
			'Return leg test'
		])
	).rows[0].id;
	placeA = await place('Stop A', 44.45, -68.52);
	placeB = await place('Stop B', 44.52, -68.44);
	placeC = await place('Stop C', 44.58, -68.61);
});

beforeEach(async () => {
	await query(`DELETE FROM day_plans WHERE trip_id = $1`, [tripId]);
});

afterAll(async () => {
	await query(`DELETE FROM users WHERE id = $1`, [userId]);
	await closePool();
});

describe('bulkUpdateDriving — the return leg is required exactly when anchored', () => {
	it('persists the drive home on an anchored plan', async () => {
		const planId = await newPlan(true);
		const ids = stopIds(planId, await listStopsForTrip(tripId));

		const ok = await bulkUpdateDriving(
			tripId,
			planId,
			[
				{ stopId: ids[0], km: 8, min: 12 },
				{ stopId: ids[1], km: 9, min: 14 },
				{ stopId: ids[2], km: 11, min: 16 }
			],
			{ km: 20, min: 25 }
		);

		expect(ok).toBe(true);
		const plan = await getDayPlan(tripId, planId);
		expect(plan?.return_drive_km).toBe(20);
		expect(plan?.return_drive_min).toBe(25);
	});

	it('rejects an anchored plan submitted without a return leg', async () => {
		const planId = await newPlan(true);
		const ids = stopIds(planId, await listStopsForTrip(tripId));

		const ok = await bulkUpdateDriving(
			tripId,
			planId,
			ids.map((id) => ({ stopId: id, km: 5, min: 8 })),
			null
		);

		expect(ok).toBe(false);
		const plan = await getDayPlan(tripId, planId);
		expect(plan?.return_drive_km).toBeNull();
	});

	it('rejects a return leg on an unanchored plan', async () => {
		const planId = await newPlan(false);
		const ids = stopIds(planId, await listStopsForTrip(tripId));

		// Unanchored: legs belong to every stop but the first.
		const ok = await bulkUpdateDriving(
			tripId,
			planId,
			[
				{ stopId: ids[1], km: 9, min: 14 },
				{ stopId: ids[2], km: 11, min: 16 }
			],
			{ km: 20, min: 25 }
		);

		expect(ok).toBe(false);
	});

	it('accepts an unanchored plan with no return leg', async () => {
		const planId = await newPlan(false);
		const ids = stopIds(planId, await listStopsForTrip(tripId));

		const ok = await bulkUpdateDriving(tripId, planId, [
			{ stopId: ids[1], km: 9, min: 14 },
			{ stopId: ids[2], km: 11, min: 16 }
		]);

		expect(ok).toBe(true);
		const plan = await getDayPlan(tripId, planId);
		expect(plan?.return_drive_km).toBeNull();
	});
});

describe('driving data is invalidated when the route it describes changes', () => {
	it('clears the previous return leg on recalculation', async () => {
		const planId = await newPlan(true);
		const ids = stopIds(planId, await listStopsForTrip(tripId));
		const legs = ids.map((id) => ({ stopId: id, km: 5, min: 8 }));

		await bulkUpdateDriving(tripId, planId, legs, { km: 20, min: 25 });
		await bulkUpdateDriving(tripId, planId, legs, { km: 31, min: 40 });

		const plan = await getDayPlan(tripId, planId);
		expect(plan?.return_drive_km).toBe(31);
		expect(plan?.return_drive_min).toBe(40);
	});

	it('clears every driving metric when the anchor changes', async () => {
		const planId = await newPlan(true);
		const ids = stopIds(planId, await listStopsForTrip(tripId));
		await bulkUpdateDriving(
			tripId,
			planId,
			ids.map((id) => ({ stopId: id, km: 5, min: 8 })),
			{ km: 20, min: 25 }
		);

		// Moving base invalidates the first leg and the drive home alike. Before
		// this fix the old numbers stayed, labelled with the new anchor.
		await setDayPlanAnchor(tripId, planId, {
			source: 'custom:other',
			title: 'Castine Cottage',
			lat: 44.38,
			lon: -68.8
		});

		const plan = await getDayPlan(tripId, planId);
		expect(plan?.return_drive_km).toBeNull();
		expect(plan?.return_drive_min).toBeNull();
		const stops = (await listStopsForTrip(tripId)).filter((s) => s.day_plan_id === planId);
		expect(stops.every((s) => s.drive_km === null && s.drive_min === null)).toBe(true);
	});

	it('clears driving when the anchor is removed entirely', async () => {
		const planId = await newPlan(true);
		const ids = stopIds(planId, await listStopsForTrip(tripId));
		await bulkUpdateDriving(
			tripId,
			planId,
			ids.map((id) => ({ stopId: id, km: 5, min: 8 })),
			{ km: 20, min: 25 }
		);

		await setDayPlanAnchor(tripId, planId, null);

		const plan = await getDayPlan(tripId, planId);
		expect(plan?.return_drive_km).toBeNull();
	});
});

describe('duplicating a plan does not carry computed driving over', () => {
	it('leaves the copy with no return leg and no stop legs', async () => {
		const planId = await newPlan(true);
		const ids = stopIds(planId, await listStopsForTrip(tripId));
		await bulkUpdateDriving(
			tripId,
			planId,
			ids.map((id) => ({ stopId: id, km: 5, min: 8 })),
			{ km: 20, min: 25 }
		);

		const copyId = await duplicateDayPlan(tripId, planId, 'Copy');
		expect(copyId).not.toBeNull();

		const copy = await getDayPlan(tripId, copyId!);
		// The anchor carries over, so the copy is still a loop — but its legs must
		// be recomputed, not inherited.
		expect(copy?.anchor_title).toBe(ANCHOR.title);
		expect(copy?.return_drive_km).toBeNull();
		expect(copy?.return_drive_min).toBeNull();

		const copiedStops = (await listStopsForTrip(tripId)).filter((s) => s.day_plan_id === copyId);
		expect(copiedStops).toHaveLength(3);
		expect(copiedStops.every((s) => s.drive_km === null && s.drive_min === null)).toBe(true);
	});
});

describe('the return leg cannot exist without an anchor', () => {
	it('is rejected by the database constraint', async () => {
		const planId = await newPlan(false);
		await expect(
			query(`UPDATE day_plans SET return_drive_km = 10, return_drive_min = 15 WHERE id = $1`, [
				planId
			])
		).rejects.toThrow(/day_plans_return_leg_complete/);
	});

	it('rejects a half-populated return leg', async () => {
		const planId = await newPlan(true);
		await expect(
			query(`UPDATE day_plans SET return_drive_km = 10 WHERE id = $1`, [planId])
		).rejects.toThrow(/day_plans_return_leg_complete/);
	});
});
