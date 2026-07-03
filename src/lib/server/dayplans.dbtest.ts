import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from '$lib/db';
import {
	addStop,
	createDayPlan,
	DuplicateDayPlanStopError,
	setDayPlanAnchor
} from '$server/dayplans';

const USERNAME = 'dbtest_dayplan_dupes';

let userId = 0;
let tripId = 0;
let placeA = 0;
let placeSameId = 0;
let placeSameCoords = 0;
let placeOther = 0;

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
			'Duplicate stop test'
		])
	).rows[0].id;
	placeA = (
		await query<{ id: number }>(
			`INSERT INTO itinerary_items (trip_id, item_type, title, lat, lon, place_id)
			 VALUES ($1, 'place', 'Museum A', 44.4, -68.2, 'place-a') RETURNING id`,
			[tripId]
		)
	).rows[0].id;
	placeSameId = (
		await query<{ id: number }>(
			`INSERT INTO itinerary_items (trip_id, item_type, title, lat, lon, place_id)
			 VALUES ($1, 'place', 'Museum A alternate title', 44.41, -68.21, 'place-a') RETURNING id`,
			[tripId]
		)
	).rows[0].id;
	placeSameCoords = (
		await query<{ id: number }>(
			`INSERT INTO itinerary_items (trip_id, item_type, title, lat, lon, place_id)
			 VALUES ($1, 'place', 'Manual pin for Museum A', 44.400001, -68.200001, NULL) RETURNING id`,
			[tripId]
		)
	).rows[0].id;
	placeOther = (
		await query<{ id: number }>(
			`INSERT INTO itinerary_items (trip_id, item_type, title, lat, lon, place_id)
			 VALUES ($1, 'place', 'Different stop', 44.6, -68.4, 'place-b') RETURNING id`,
			[tripId]
		)
	).rows[0].id;
});

afterAll(async () => {
	await query(`DELETE FROM users WHERE username = $1`, [USERNAME]);
	await closePool();
});

describe('day plan duplicate stop prevention', () => {
	it('rejects duplicate Google place IDs when creating a plan', async () => {
		await expect(
			createDayPlan(tripId, {
				title: 'Duplicate place id route',
				notes: null,
				optional_date: null,
				stops: [
					{ itinerary_item_id: placeA, notes: null },
					{ itinerary_item_id: placeSameId, notes: null }
				]
			})
		).rejects.toBeInstanceOf(DuplicateDayPlanStopError);

		const plans = await query<{ count: string }>(
			`SELECT COUNT(*) AS count FROM day_plans WHERE trip_id = $1 AND title = 'Duplicate place id route'`,
			[tripId]
		);
		expect(Number(plans.rows[0].count)).toBe(0);
	});

	it('rejects duplicate coordinates when adding to an existing plan', async () => {
		const planId = await createDayPlan(tripId, {
			title: 'Coordinate route',
			notes: null,
			optional_date: null,
			stops: [{ itinerary_item_id: placeA, notes: null }]
		});

		await expect(
			addStop(tripId, planId, { itinerary_item_id: placeSameCoords, notes: null })
		).rejects.toBeInstanceOf(DuplicateDayPlanStopError);
	});

	it('rejects an anchor that duplicates an existing stop', async () => {
		const planId = await createDayPlan(tripId, {
			title: 'Anchor route',
			notes: null,
			optional_date: null,
			stops: [
				{ itinerary_item_id: placeA, notes: null },
				{ itinerary_item_id: placeOther, notes: null }
			]
		});

		await expect(
			setDayPlanAnchor(tripId, planId, {
				source: `place:${placeA}`,
				title: 'Place: Museum A',
				lat: 44.4,
				lon: -68.2
			})
		).rejects.toBeInstanceOf(DuplicateDayPlanStopError);
	});
});
