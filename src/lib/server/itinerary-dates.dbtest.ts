import { describe, expect, it } from 'vitest';
import { query } from '$lib/db';
import { setItemDate, setItemDates } from '$server/itinerary';

async function makeTrip(): Promise<number> {
	const owner = await query<{ id: number }>(
		`INSERT INTO users (username, password_hash, role, display_name)
		 VALUES ($1, 'x', 'user', 'Date Test')
		 ON CONFLICT (username) DO UPDATE SET display_name = EXCLUDED.display_name RETURNING id`,
		[`date-test-${Date.now()}-${Math.round(performance.now())}`]
	);
	const trip = await query<{ id: number }>(
		`INSERT INTO trips (owner_id, name) VALUES ($1, 'Date Test') RETURNING id`,
		[owner.rows[0].id]
	);
	return trip.rows[0].id;
}
async function addItem(tripId: number, type: string, title: string): Promise<number> {
	const r = await query<{ id: number }>(
		`INSERT INTO itinerary_items (trip_id, item_type, title, notes, external_url)
		 VALUES ($1, $2, $3, 'keep me', 'https://example.com') RETURNING id`,
		[tripId, type, title]
	);
	return r.rows[0].id;
}
const dateOf = async (id: number) =>
	(await query<{ d: string | null }>(`SELECT to_char(date,'YYYY-MM-DD') d FROM itinerary_items WHERE id=$1`, [id]))
		.rows[0].d;

describe('setItemDate', () => {
	it('sets and clears a date without clobbering notes or external_url', async () => {
		const tripId = await makeTrip();
		const id = await addItem(tripId, 'place', 'A place');
		expect(await setItemDate(tripId, id, '2026-07-30')).toBe(true);
		expect(await dateOf(id)).toBe('2026-07-30');

		const row = await query<{ notes: string | null; external_url: string | null }>(
			`SELECT notes, external_url FROM itinerary_items WHERE id=$1`, [id]);
		// updateItem would have wiped both; this is why setItemDate exists.
		expect(row.rows[0].notes).toBe('keep me');
		expect(row.rows[0].external_url).toBe('https://example.com');

		expect(await setItemDate(tripId, id, null)).toBe(true);
		expect(await dateOf(id)).toBeNull();
		await query(`DELETE FROM trips WHERE id=$1`, [tripId]);
	});

	it('refuses non-place rows and rows from another trip', async () => {
		const tripA = await makeTrip();
		const tripB = await makeTrip();
		const day = await addItem(tripA, 'day', 'A day');
		const section = await addItem(tripA, 'section', 'A section');
		const place = await addItem(tripA, 'place', 'A place');

		expect(await setItemDate(tripA, day, '2026-07-30')).toBe(false);
		expect(await setItemDate(tripA, section, '2026-07-30')).toBe(false);
		expect(await setItemDate(tripB, place, '2026-07-30')).toBe(false);
		expect(await dateOf(place)).toBeNull();

		await query(`DELETE FROM trips WHERE id=$1`, [tripA]);
		await query(`DELETE FROM trips WHERE id=$1`, [tripB]);
	});
});

describe('setItemDates', () => {
	it('applies one date to many places', async () => {
		const tripId = await makeTrip();
		const ids = [await addItem(tripId, 'place', 'P1'), await addItem(tripId, 'place', 'P2')];
		expect((await setItemDates(tripId, ids, '2026-08-01')).sort()).toEqual([...ids].sort());
		for (const id of ids) expect(await dateOf(id)).toBe('2026-08-01');
		await query(`DELETE FROM trips WHERE id=$1`, [tripId]);
	});

	it('dedupes repeated ids rather than failing the count check', async () => {
		const tripId = await makeTrip();
		const id = await addItem(tripId, 'place', 'P1');
		expect(await setItemDates(tripId, [id, id, id], '2026-08-01')).toEqual([id]);
		await query(`DELETE FROM trips WHERE id=$1`, [tripId]);
	});

	/**
	 * The specific failure a per-row UPDATE loop would get wrong: the valid rows
	 * would commit and the caller would be told it worked.
	 */
	it('rolls back entirely when one id belongs to another trip', async () => {
		const tripA = await makeTrip();
		const tripB = await makeTrip();
		const mine = [await addItem(tripA, 'place', 'P1'), await addItem(tripA, 'place', 'P2')];
		const theirs = await addItem(tripB, 'place', 'Not mine');

		await expect(setItemDates(tripA, [...mine, theirs], '2026-08-01')).rejects.toThrow();
		for (const id of mine) expect(await dateOf(id)).toBeNull();
		expect(await dateOf(theirs)).toBeNull();

		await query(`DELETE FROM trips WHERE id=$1`, [tripA]);
		await query(`DELETE FROM trips WHERE id=$1`, [tripB]);
	});

	it('rolls back when one id is a non-place row', async () => {
		const tripId = await makeTrip();
		const place = await addItem(tripId, 'place', 'P1');
		const day = await addItem(tripId, 'day', 'D1');
		await expect(setItemDates(tripId, [place, day], '2026-08-01')).rejects.toThrow();
		expect(await dateOf(place)).toBeNull();
		await query(`DELETE FROM trips WHERE id=$1`, [tripId]);
	});
});
