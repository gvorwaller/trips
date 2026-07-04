import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from '$lib/db';
import { importItineraryCandidates } from '$server/itinerary-import';

const USERNAME = 'dbtest_itinerary_import_birds';

let userId = 0;
let tripId = 0;

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
			'Birds import duplicate test'
		])
	).rows[0].id;
});

afterAll(async () => {
	await query(`DELETE FROM users WHERE username = $1`, [USERNAME]);
	await closePool();
});

describe('importItineraryCandidates', () => {
	it('preserves source metadata in itinerary_items.meta', async () => {
		const imported = await importItineraryCandidates(
			tripId,
			[
				{
					item_type: 'place',
					title: 'Harbor Point',
					lat: 44.3,
					lon: -68.2,
					place_id: 'place-harbor',
					meta: {
						source_app: 'birds',
						source_id: 'birds:trip_stop:10',
						birds_trip_id: 2,
						birds_stop_id: 10
					}
				}
			],
			{ parentId: null, geocode: false }
		);

		expect(imported).toBe(1);
		const row = (
			await query<{ meta: Record<string, unknown> }>(
				`SELECT meta FROM itinerary_items WHERE trip_id = $1 AND title = 'Harbor Point'`,
				[tripId]
			)
		).rows[0];
		expect(row.meta).toMatchObject({
			source_app: 'birds',
			source_id: 'birds:trip_stop:10',
			birds_trip_id: 2,
			birds_stop_id: 10
		});
	});

	it('skips duplicate source ids, place ids, and nearby coordinates at write time', async () => {
		const imported = await importItineraryCandidates(
			tripId,
			[
				{
					item_type: 'place',
					title: 'Harbor Point renamed',
					lat: 44.31,
					lon: -68.21,
					place_id: 'place-harbor-renamed',
					meta: {
						source_app: 'birds',
						source_id: 'birds:trip_stop:10'
					}
				},
				{
					item_type: 'place',
					title: 'Other title same Google id',
					lat: 44.5,
					lon: -68.5,
					place_id: 'place-harbor'
				},
				{
					item_type: 'place',
					title: 'Other title same coordinates',
					lat: 44.300001,
					lon: -68.200001
				},
				{
					item_type: 'place',
					title: 'Fresh place',
					lat: 45.1,
					lon: -69.1,
					meta: {
						source_app: 'birds',
						source_id: 'birds:trip_stop:11'
					}
				}
			],
			{ parentId: null, geocode: false }
		);

		expect(imported).toBe(1);
		const rows = await query<{ title: string }>(
			`SELECT title FROM itinerary_items
			  WHERE trip_id = $1
			    AND title IN (
			      'Harbor Point renamed',
			      'Other title same Google id',
			      'Other title same coordinates',
			      'Fresh place'
			    )
			  ORDER BY title`,
			[tripId]
		);
		expect(rows.rows.map((row) => row.title)).toEqual(['Fresh place']);
	});
});
