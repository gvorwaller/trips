import { describe, expect, it } from 'vitest';
import { query } from '$lib/db';
import { bulkCreate, createItem, setItemDate, setItemDates } from '$server/itinerary';
import {
	importItineraryCandidates,
	ImportTooLargeError,
	type ItineraryImportCandidate
} from '$server/itinerary-import';
import { MAX_IMPORT_ITEMS } from '$lib/import-limits';

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

// td-2092b7: the creation paths themselves can set a date, so add / paste no
// longer produce undated places when the user supplies one.
describe('date on creation paths', () => {
	it('createItem persists an optional date (the itin-add path)', async () => {
		const tripId = await makeTrip();
		const dated = await createItem(tripId, {
			parent_id: null,
			item_type: 'place',
			title: 'Saturday market',
			date: '2026-08-08'
		});
		const undated = await createItem(tripId, {
			parent_id: null,
			item_type: 'place',
			title: 'Anytime cafe'
		});
		expect(await dateOf(dated)).toBe('2026-08-08');
		expect(await dateOf(undated)).toBeNull();
		await query(`DELETE FROM trips WHERE id=$1`, [tripId]);
	});

	it('bulkCreate applies one optional date to every pasted line', async () => {
		const tripId = await makeTrip();
		const n = await bulkCreate(tripId, null, 'place', ['One', 'Two', ' '], '2026-08-09');
		expect(n).toBe(2);
		const rows = await query<{ d: string | null }>(
			`SELECT to_char(date,'YYYY-MM-DD') d FROM itinerary_items
			  WHERE trip_id=$1 ORDER BY sort_order, id`,
			[tripId]
		);
		expect(rows.rows.map((r) => r.d)).toEqual(['2026-08-09', '2026-08-09']);

		const m = await bulkCreate(tripId, null, 'place', ['Three']);
		expect(m).toBe(1);
		const undated = await query<{ d: string | null }>(
			`SELECT to_char(date,'YYYY-MM-DD') d FROM itinerary_items WHERE trip_id=$1 AND title='Three'`,
			[tripId]
		);
		expect(undated.rows[0].d).toBeNull();
		await query(`DELETE FROM trips WHERE id=$1`, [tripId]);
	});
});

// Peer CODEX (branch E round 1): the import cap used to be a silent
// slice(0, 200) — a 201-item birds trip showed "Import 201", committed 200,
// and cleared the review panel. Over-limit is now an explicit rejection that
// mutates NOTHING.
describe('import batch limit is a rejection, not a silent slice', () => {
	function candidate(n: number): ItineraryImportCandidate {
		// Fixed-width unique titles: the importer's fuzzy duplicate matcher
		// treats substring containment as a dupe ("Place 1" ⊂ "Place 1000"),
		// and equal-length distinct strings can never contain each other.
		return { item_type: 'place', title: `Spot ${String(n).padStart(4, '0')}z`, children: [] };
	}

	it('tolerates malformed candidate entries instead of throwing a 500', async () => {
		const tripId = await makeTrip();
		// The route only JSON-parses and Array.isArray-checks, so hand-rolled
		// payloads like [null, 7] reach the importer — they must be counted
		// and dropped, never crash the preflight counter.
		const junk = [null, 7, { title: 42 }] as unknown as ItineraryImportCandidate[];
		const imported = await importItineraryCandidates(tripId, junk, {
			parentId: null,
			geocode: false,
			tripName: 'T'
		});
		expect(imported).toBe(0);
		await query(`DELETE FROM trips WHERE id=$1`, [tripId]);
	});

	it(`rejects ${MAX_IMPORT_ITEMS + 1} candidates and inserts nothing`, async () => {
		const tripId = await makeTrip();
		const over = Array.from({ length: MAX_IMPORT_ITEMS + 1 }, (_, i) => candidate(i));
		await expect(
			importItineraryCandidates(tripId, over, { parentId: null, geocode: false, tripName: 'T' })
		).rejects.toBeInstanceOf(ImportTooLargeError);
		const count = await query<{ n: string }>(
			`SELECT count(*) n FROM itinerary_items WHERE trip_id=$1`,
			[tripId]
		);
		expect(Number(count.rows[0].n)).toBe(0);
		await query(`DELETE FROM trips WHERE id=$1`, [tripId]);
	});

	it('counts NESTED children against the limit, and a full batch imports completely', async () => {
		const tripId = await makeTrip();
		// 100 parents × 1 child each = 200 total — exactly at the limit.
		const atLimit = Array.from({ length: MAX_IMPORT_ITEMS / 2 }, (_, i) => ({
			...candidate(i),
			children: [candidate(1000 + i)]
		}));
		const imported = await importItineraryCandidates(tripId, atLimit, {
			parentId: null,
			geocode: false,
			tripName: 'T'
		});
		expect(imported).toBe(MAX_IMPORT_ITEMS);

		// One more child anywhere tips the total over: rejected outright.
		const overNested = [
			...atLimit,
			{ ...candidate(9999), children: [] }
		];
		await expect(
			importItineraryCandidates(tripId, overNested, {
				parentId: null,
				geocode: false,
				tripName: 'T'
			})
		).rejects.toBeInstanceOf(ImportTooLargeError);
		await query(`DELETE FROM trips WHERE id=$1`, [tripId]);
	});
});
