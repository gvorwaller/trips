import { describe, expect, it } from 'vitest';
import { query } from '$lib/db';
import { duplicateDayPlan, listDayPlans } from '$server/dayplans';

/**
 * Deep-copy behaviour for td-5e5e46, exercised against the real schema so the
 * anchor CHECK constraint and column list are genuinely proven rather than
 * assumed.
 */
async function makeTrip(): Promise<number> {
	const owner = await query<{ id: number }>(
		`INSERT INTO users (username, password_hash, role, display_name)
		 VALUES ($1, 'x', 'user', 'Dup Test')
		 ON CONFLICT (username) DO UPDATE SET display_name = EXCLUDED.display_name
		 RETURNING id`,
		[`dup-test-${Date.now()}`]
	);
	const trip = await query<{ id: number }>(
		`INSERT INTO trips (owner_id, name) VALUES ($1, 'Dup Test Trip') RETURNING id`,
		[owner.rows[0].id]
	);
	return trip.rows[0].id;
}

describe('duplicateDayPlan', () => {
	it('copies stops in order, resets visited, and drops derived driving data', async () => {
		const tripId = await makeTrip();
		const item = await query<{ id: number }>(
			`INSERT INTO itinerary_items (trip_id, item_type, title, lat, lon)
			 VALUES ($1, 'place', 'Stop A', 44.4, -68.6) RETURNING id`,
			[tripId]
		);
		const plan = await query<{ id: number }>(
			`INSERT INTO day_plans
			   (trip_id, title, notes, optional_date, anchor_source, anchor_title, anchor_lat, anchor_lon)
			 VALUES ($1, 'Source', 'plan notes', '2026-08-02', 'place:1', 'Base', 44.3, -68.5)
			 RETURNING id`,
			[tripId]
		);
		await query(
			`INSERT INTO day_plan_stops
			   (day_plan_id, itinerary_item_id, sort_order, notes, visited,
			    snapshot_title, snapshot_lat, snapshot_lon, snapshot_place_id, drive_km, drive_min, ai_notes)
			 VALUES ($1, $2, 0, 'stop note', TRUE, 'Stop A', 44.4, -68.6, 'pid', 12.5, 20, 'ai text'),
			        ($1, NULL, 1, NULL, TRUE, 'Stop B', 44.5, -68.7, NULL, 3.0, 5, 'more ai')`,
			[plan.rows[0].id, item.rows[0].id]
		);

		const newId = await duplicateDayPlan(tripId, plan.rows[0].id, 'The Copy');
		expect(newId).not.toBeNull();

		const copied = await query<{
			title: string;
			notes: string | null;
			optional_date: string | null;
			anchor_title: string | null;
			anchor_lat: number | null;
		}>(
			`SELECT title, notes, to_char(optional_date,'YYYY-MM-DD') optional_date,
			        anchor_title, anchor_lat
			   FROM day_plans WHERE id = $1`,
			[newId]
		);
		expect(copied.rows[0].title).toBe('The Copy');
		expect(copied.rows[0].notes).toBe('plan notes');
		expect(copied.rows[0].optional_date).toBe('2026-08-02');
		// All four anchor columns must survive together or the CHECK rejects the row.
		expect(copied.rows[0].anchor_title).toBe('Base');
		expect(Number(copied.rows[0].anchor_lat)).toBeCloseTo(44.3, 5);

		const stops = await query<{
			snapshot_title: string;
			sort_order: number;
			visited: boolean;
			notes: string | null;
			itinerary_item_id: number | null;
			drive_km: number | null;
			drive_min: number | null;
			ai_notes: string | null;
		}>(
			`SELECT snapshot_title, sort_order, visited, notes, itinerary_item_id,
			        drive_km, drive_min, ai_notes
			   FROM day_plan_stops WHERE day_plan_id = $1 ORDER BY sort_order`,
			[newId]
		);
		expect(stops.rows.map((r) => r.snapshot_title)).toEqual(['Stop A', 'Stop B']);
		expect(stops.rows.every((r) => r.visited === false)).toBe(true);
		expect(stops.rows[0].notes).toBe('stop note');
		// Same trip, so the soft link to the itinerary item carries over unchanged.
		expect(stops.rows[0].itinerary_item_id).toBe(item.rows[0].id);
		// Derived data is regenerated for the copy, matching clone.ts policy.
		expect(stops.rows.every((r) => r.drive_km === null && r.drive_min === null)).toBe(true);
		expect(stops.rows.every((r) => r.ai_notes === null)).toBe(true);

		// The original is untouched.
		const original = await query<{ visited: boolean; drive_km: number | null }>(
			`SELECT visited, drive_km FROM day_plan_stops WHERE day_plan_id = $1 ORDER BY sort_order`,
			[plan.rows[0].id]
		);
		expect(original.rows[0].visited).toBe(true);
		expect(Number(original.rows[0].drive_km)).toBeCloseTo(12.5, 5);

		expect((await listDayPlans(tripId)).length).toBe(2);
		await query(`DELETE FROM trips WHERE id = $1`, [tripId]);
	});

	it('copies a plan with no anchor without tripping the anchor CHECK', async () => {
		const tripId = await makeTrip();
		const plan = await query<{ id: number }>(
			`INSERT INTO day_plans (trip_id, title) VALUES ($1, 'Bare') RETURNING id`,
			[tripId]
		);
		const newId = await duplicateDayPlan(tripId, plan.rows[0].id, 'Bare copy');
		expect(newId).not.toBeNull();
		await query(`DELETE FROM trips WHERE id = $1`, [tripId]);
	});

	it('refuses a plan belonging to another trip', async () => {
		const tripA = await makeTrip();
		const tripB = await makeTrip();
		const plan = await query<{ id: number }>(
			`INSERT INTO day_plans (trip_id, title) VALUES ($1, 'A plan') RETURNING id`,
			[tripA]
		);
		expect(await duplicateDayPlan(tripB, plan.rows[0].id, 'Stolen')).toBeNull();
		// And nothing was written into the other trip.
		expect((await listDayPlans(tripB)).length).toBe(0);
		await query(`DELETE FROM trips WHERE id = $1`, [tripA]);
		await query(`DELETE FROM trips WHERE id = $1`, [tripB]);
	});
});
