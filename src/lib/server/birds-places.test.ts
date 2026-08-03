import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({
	env: {
		BIRDS_API_BASE_URL: 'https://birds.test',
		BIRDS_API_TOKEN: 'test-token',
		BIRDS_API_USERNAME: 'defaultuser'
	}
}));

import {
	birdsPlacesToItineraryCandidates,
	fetchBirdsItineraryCandidates,
	groupBirdsTrips,
	parseBirdsTripIdParam,
	type BirdsTripPlace
} from './birds-places';

function birdsPlace(overrides: Partial<BirdsTripPlace> = {}): BirdsTripPlace {
	return {
		source: 'birds',
		source_id: 'birds:trip_stop:10',
		birds_trip_id: 2,
		birds_trip_name: 'Coast run',
		birds_trip_start_date: '2026-07-04',
		birds_trip_end_date: null,
		stop_id: 10,
		sort_order: 0,
		name: 'Harbor Point',
		lat: 44.3,
		lon: -68.2,
		google_place_id: 'place-harbor',
		hotspot_id: 'L123',
		notes: 'Check tide',
		field_tip: 'Scope early',
		field_tip_generated_at: '2026-07-04T12:00:00.000Z',
		target_count_at_save: 4,
		...overrides
	};
}

describe('birdsPlacesToItineraryCandidates', () => {
	it('maps Birds trip places into itinerary candidates with source metadata', () => {
		expect(birdsPlacesToItineraryCandidates([birdsPlace()])).toEqual([
			{
				item_type: 'place',
				title: 'Harbor Point',
				date: null,
				notes:
					'Imported from Birds trip: Coast run\n' +
					'Birds trip dates: 2026-07-04\n' +
					'Check tide\n' +
					'Field tip: Scope early\n' +
					'eBird hotspot: L123\n' +
					'Targets at save: 4',
				external_url: null,
				address: null,
				location_query: null,
				lat: 44.3,
				lon: -68.2,
				place_id: 'place-harbor',
				apple_maps_place_id: null,
				meta: {
					source_app: 'birds',
					source_id: 'birds:trip_stop:10',
					birds_trip_id: 2,
					birds_stop_id: 10,
					birds_hotspot_id: 'L123',
					birds_trip_name: 'Coast run'
				},
				children: []
			}
		]);
	});

	it('sets the candidate date only for a genuine single-day trip', () => {
		const singleDay = birdsPlace({
			birds_trip_start_date: '2026-07-04',
			birds_trip_end_date: '2026-07-04'
		});
		const range = birdsPlace({
			birds_trip_start_date: '2026-07-04',
			birds_trip_end_date: '2026-07-10'
		});
		const startOnly = birdsPlace({
			birds_trip_start_date: '2026-07-04',
			birds_trip_end_date: null
		});
		const undated = birdsPlace({
			birds_trip_start_date: null,
			birds_trip_end_date: null
		});
		const dates = birdsPlacesToItineraryCandidates([singleDay, range, startOnly, undated]).map(
			(c) => c.date
		);
		// A range would mean guessing which day; start-only is not proof of a
		// single-day trip either.
		expect(dates).toEqual(['2026-07-04', null, null, null]);
	});
});

describe('groupBirdsTrips', () => {
	it('groups by trip with counts, newest start date first, undated last', () => {
		const places = [
			birdsPlace({ birds_trip_id: 1, birds_trip_name: 'Older', birds_trip_start_date: '2025-05-01', stop_id: 1 }),
			birdsPlace({ birds_trip_id: 2, birds_trip_name: 'Newer', birds_trip_start_date: '2026-07-04', stop_id: 2 }),
			birdsPlace({ birds_trip_id: 2, birds_trip_name: 'Newer', birds_trip_start_date: '2026-07-04', stop_id: 3 }),
			birdsPlace({
				birds_trip_id: 3,
				birds_trip_name: 'Undated',
				birds_trip_start_date: null,
				birds_trip_end_date: null,
				stop_id: 4
			})
		];
		expect(groupBirdsTrips(places)).toEqual([
			{ id: 2, name: 'Newer', start_date: '2026-07-04', end_date: null, placeCount: 2 },
			{ id: 1, name: 'Older', start_date: '2025-05-01', end_date: null, placeCount: 1 },
			{ id: 3, name: 'Undated', start_date: null, end_date: null, placeCount: 1 }
		]);
	});

	it('returns an empty list for no places', () => {
		expect(groupBirdsTrips([])).toEqual([]);
	});
});

describe('parseBirdsTripIdParam', () => {
	it('absent or empty means "all trips"', () => {
		expect(parseBirdsTripIdParam(null)).toEqual({ id: null });
		expect(parseBirdsTripIdParam('')).toEqual({ id: null });
		expect(parseBirdsTripIdParam('   ')).toEqual({ id: null });
	});

	it('accepts a positive safe integer', () => {
		expect(parseBirdsTripIdParam('42')).toEqual({ id: 42 });
		expect(parseBirdsTripIdParam(' 7 ')).toEqual({ id: 7 });
	});

	it('rejects values optId would have silently mapped to "no scope"', () => {
		// Every one of these must be a 400, never an unscoped all-trips fetch
		// the client mistakes for scoped.
		for (const bad of ['0', '000', '-3', '1e3', '1.5', 'abc', '9007199254740992']) {
			expect(parseBirdsTripIdParam(bad)).toHaveProperty('error');
		}
	});
});

describe('fetchBirdsItineraryCandidates', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function stubFetch(body: unknown) {
		const spy = vi.fn(
			async (_input: RequestInfo | URL) => new Response(JSON.stringify(body), { status: 200 })
		);
		vi.stubGlobal('fetch', spy);
		return spy;
	}

	it('requests the 5000 cap and returns {candidates, trips, truncated}', async () => {
		const spy = stubFetch({
			places: [birdsPlace({ birds_trip_id: 7, birds_trip_name: 'Solo', stop_id: 9 })],
			truncated: false,
			limit: 5000
		});
		const result = await fetchBirdsItineraryCandidates({ username: 'gaylon' });
		const requested = new URL(String(spy.mock.calls[0][0]));
		expect(requested.searchParams.get('limit')).toBe('5000');
		expect(requested.searchParams.get('username')).toBe('gaylon');
		expect(result.truncated).toBe(false);
		expect(result.trips).toEqual([
			{ id: 7, name: 'Solo', start_date: '2026-07-04', end_date: null, placeCount: 1 }
		]);
		expect(result.candidates).toHaveLength(1);
		expect(result.candidates[0].title).toBe('Harbor Point');
	});

	it('propagates the truncated flag, including a cut that falls inside one trip', async () => {
		// Birds orders whole trips then truncates at the limit — so a
		// truncated payload can both omit entire trips AND report a wrong
		// placeCount for the trip the cut landed in. The flag is the only
		// signal; the client must not offer an "All trips" import on it.
		stubFetch({
			places: [
				birdsPlace({ birds_trip_id: 1, birds_trip_name: 'Cut trip', stop_id: 1 }),
				birdsPlace({ birds_trip_id: 1, birds_trip_name: 'Cut trip', stop_id: 2 })
				// stops 3..N of "Cut trip" and every later trip fell past the cap
			],
			truncated: true,
			limit: 5000
		});
		const result = await fetchBirdsItineraryCandidates();
		expect(result.truncated).toBe(true);
		// The visible count is honest about what arrived, not what exists.
		expect(result.trips).toEqual([
			{ id: 1, name: 'Cut trip', start_date: '2026-07-04', end_date: null, placeCount: 2 }
		]);
	});

	it('scopes by trip id when requested', async () => {
		const spy = stubFetch({ places: [], truncated: false });
		await fetchBirdsItineraryCandidates({ tripId: 42 });
		const requested = new URL(String(spy.mock.calls[0][0]));
		expect(requested.searchParams.get('tripId')).toBe('42');
	});
});
