import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({
	env: { GOOGLE_GEOCODING_KEY: 'test-routes-key' }
}));
// api_cache lives in Postgres; these are unit tests, so the cache always
// misses and never stores.
vi.mock('$lib/db', () => ({
	query: vi.fn(async () => ({ rows: [], rowCount: 0 }))
}));

import { planDrivingLegs, planOptimizedRoute, RouteInputError } from './route-directions';

/**
 * Behavioral port of the old src/lib/route.test.ts suite (branch A) onto the
 * Routes API v2 wire format: same loop semantics, same attribution rules,
 * same partial-response rejections — now asserted against the REAL request
 * body and response shapes instead of a stubbed DirectionsService class.
 */

interface WireBody {
	origin: { location: { latLng: { latitude: number; longitude: number } } };
	destination: { location: { latLng: { latitude: number; longitude: number } } };
	intermediates: Array<{ location: { latLng: { latitude: number; longitude: number } } }>;
	travelMode: string;
	routingPreference: string;
	optimizeWaypointOrder: boolean;
}

let lastBody: WireBody | null = null;
let lastHeaders: Record<string, string> = {};
let nextResponse: () => Response = () => new Response('{}', { status: 200 });

function stubFetch() {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
			lastBody = JSON.parse(String(init?.body)) as WireBody;
			lastHeaders = (init?.headers ?? {}) as Record<string, string>;
			return nextResponse();
		})
	);
}

/** Wire leg: metres + "…s" duration string. */
const leg = (km: number, min: number) => ({
	distanceMeters: km * 1000,
	duration: `${min * 60}s`
});

const routeWith = (legs: ReturnType<typeof leg>[], optimizedOrder?: number[]) =>
	new Response(
		JSON.stringify({
			routes: [
				{
					legs,
					distanceMeters: legs.reduce((a, l) => a + l.distanceMeters, 0),
					duration: `${legs.reduce((a, l) => a + Number(l.duration.slice(0, -1)), 0)}s`,
					optimizedIntermediateWaypointIndex: optimizedOrder
				}
			]
		}),
		{ status: 200 }
	);

// Blue Hill area, spaced well beyond the 30 m duplicate guard.
const ANCHOR = { lat: 44.41, lon: -68.59 };
const STOPS = [
	{ id: 11, lat: 44.45, lon: -68.52 },
	{ id: 22, lat: 44.52, lon: -68.44 },
	{ id: 33, lat: 44.58, lon: -68.61 }
];

const latLng = (w: { location: { latLng: { latitude: number; longitude: number } } }) => [
	w.location.latLng.latitude,
	w.location.latLng.longitude
];

beforeEach(() => {
	lastBody = null;
	lastHeaders = {};
	nextResponse = () => new Response('{}', { status: 200 });
	stubFetch();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('planDrivingLegs — anchored plans are a closed loop (td-bf2909)', () => {
	it('routes anchor -> every stop -> back to the anchor, TRAFFIC_UNAWARE, key in header', async () => {
		nextResponse = () => routeWith([leg(8, 12), leg(9, 14), leg(11, 16), leg(20, 25)]);
		await planDrivingLegs(STOPS, ANCHOR);
		expect(latLng(lastBody!.origin)).toEqual([ANCHOR.lat, ANCHOR.lon]);
		expect(latLng(lastBody!.destination)).toEqual([ANCHOR.lat, ANCHOR.lon]);
		expect(lastBody!.intermediates.map(latLng)).toEqual(STOPS.map((s) => [s.lat, s.lon]));
		expect(lastBody!.optimizeWaypointOrder).toBe(false);
		expect(lastBody!.travelMode).toBe('DRIVE');
		expect(lastBody!.routingPreference).toBe('TRAFFIC_UNAWARE');
		expect(lastHeaders['X-Goog-Api-Key']).toBe('test-routes-key');
		expect(lastHeaders['X-Goog-FieldMask']).toContain('optimizedIntermediateWaypointIndex');
	});

	it('attributes each leg to the stop it arrives at, and the last leg to the return', async () => {
		nextResponse = () => routeWith([leg(8, 12), leg(9, 14), leg(11, 16), leg(20, 25)]);
		const { legs, returnLeg } = await planDrivingLegs(STOPS, ANCHOR);
		expect(legs).toEqual([
			{ stopId: 11, km: 8, min: 12 },
			{ stopId: 22, km: 9, min: 14 },
			{ stopId: 33, km: 11, min: 16 }
		]);
		expect(returnLeg).toEqual({ km: 20, min: 25 });
	});

	it('handles a single anchored stop as out-and-back', async () => {
		nextResponse = () => routeWith([leg(5, 9), leg(5, 8)]);
		const { legs, returnLeg } = await planDrivingLegs([STOPS[0]], ANCHOR);
		expect(legs).toEqual([{ stopId: 11, km: 5, min: 9 }]);
		expect(returnLeg).toEqual({ km: 5, min: 8 });
	});
});

describe('planDrivingLegs — unanchored plans stay an open path', () => {
	it('routes first stop -> last stop with no return leg', async () => {
		nextResponse = () => routeWith([leg(7, 10), leg(12, 18)]);
		const { legs, returnLeg } = await planDrivingLegs(STOPS, null);
		expect(latLng(lastBody!.origin)).toEqual([STOPS[0].lat, STOPS[0].lon]);
		expect(latLng(lastBody!.destination)).toEqual([STOPS[2].lat, STOPS[2].lon]);
		expect(lastBody!.intermediates.map(latLng)).toEqual([[STOPS[1].lat, STOPS[1].lon]]);
		expect(legs).toEqual([
			{ stopId: 22, km: 7, min: 10 },
			{ stopId: 33, km: 12, min: 18 }
		]);
		expect(returnLeg).toBeNull();
	});
});

describe('planDrivingLegs — partial responses are rejected, not reinterpreted', () => {
	it('rejects too few legs on an anchored plan instead of mislabelling the drive home', async () => {
		nextResponse = () => routeWith([leg(8, 12), leg(9, 14), leg(11, 16)]);
		await expect(planDrivingLegs(STOPS, ANCHOR)).rejects.toThrow('expected 4');
	});

	it('rejects too many legs', async () => {
		nextResponse = () =>
			routeWith([leg(1, 1), leg(1, 1), leg(1, 1), leg(1, 1), leg(1, 1)]);
		await expect(planDrivingLegs(STOPS, ANCHOR)).rejects.toThrow('expected 4');
	});

	it('rejects an empty leg list', async () => {
		nextResponse = () => routeWith([]);
		await expect(planDrivingLegs(STOPS, ANCHOR)).rejects.toThrow('expected 4');
	});

	it('rejects a response with no route at all (empty body)', async () => {
		nextResponse = () => new Response('{}', { status: 200 });
		await expect(planDrivingLegs(STOPS, ANCHOR)).rejects.toThrow('No drivable route found.');
	});
});

describe('planOptimizedRoute — waypoint order remap', () => {
	it('reorders anchored stops by optimizedIntermediateWaypointIndex and closes the loop', async () => {
		nextResponse = () => routeWith([leg(5, 8), leg(6, 9), leg(7, 10), leg(8, 11)], [2, 0, 1]);
		const result = await planOptimizedRoute(STOPS, ANCHOR);
		expect(latLng(lastBody!.origin)).toEqual([ANCHOR.lat, ANCHOR.lon]);
		expect(latLng(lastBody!.destination)).toEqual([ANCHOR.lat, ANCHOR.lon]);
		expect(lastBody!.optimizeWaypointOrder).toBe(true);
		expect(result.orderedIds).toEqual([33, 11, 22]);
		expect(result.totalKm).toBe(26);
		expect(result.totalMin).toBe(38);
	});

	it('keeps the first stop fixed as the base when unanchored', async () => {
		nextResponse = () => routeWith([leg(5, 8), leg(6, 9), leg(7, 10)], [1, 0]);
		const result = await planOptimizedRoute(STOPS, null);
		expect(latLng(lastBody!.origin)).toEqual([STOPS[0].lat, STOPS[0].lon]);
		expect(latLng(lastBody!.destination)).toEqual([STOPS[0].lat, STOPS[0].lon]);
		expect(result.orderedIds).toEqual([11, 33, 22]);
	});

	it('appends stops without coordinates in their original order', async () => {
		nextResponse = () => routeWith([leg(5, 8), leg(6, 9), leg(7, 10), leg(8, 11)], [1, 0, 2]);
		const result = await planOptimizedRoute(
			[...STOPS, { id: 44, lat: null, lon: null }, { id: 55, lat: null, lon: null }],
			ANCHOR
		);
		expect(result.orderedIds).toEqual([22, 11, 33, 44, 55]);
	});

	it('rejects an invalid optimized order instead of misattributing stops', async () => {
		for (const bad of [
			[0, 0, 1], // duplicate index
			[0, 1], // wrong length
			[0, 1, 3] // out of range
		]) {
			nextResponse = () => routeWith([leg(5, 8), leg(6, 9), leg(7, 10), leg(8, 11)], bad);
			await expect(planOptimizedRoute(STOPS, ANCHOR)).rejects.toThrow(
				'invalid optimized order'
			);
		}
	});

	it('rejects an ABSENT optimized order — omission is malformed, not identity', async () => {
		nextResponse = () => routeWith([leg(5, 8), leg(6, 9), leg(7, 10), leg(8, 11)]);
		await expect(planOptimizedRoute(STOPS, ANCHOR)).rejects.toThrow('invalid optimized order');
	});

	it('rejects partial optimized responses instead of understated totals', async () => {
		// 3 anchored waypoints => the loop must have exactly 4 legs.
		nextResponse = () => routeWith([leg(5, 8), leg(6, 9)], [2, 0, 1]);
		await expect(planOptimizedRoute(STOPS, ANCHOR)).rejects.toThrow('expected 4');
		nextResponse = () =>
			routeWith([leg(1, 1), leg(1, 1), leg(1, 1), leg(1, 1), leg(1, 1)], [2, 0, 1]);
		await expect(planOptimizedRoute(STOPS, ANCHOR)).rejects.toThrow('expected 4');
	});

	it('rounds totals once from raw seconds, never by summing rounded legs', async () => {
		// Four 31 s legs: per-leg minutes round to 1 each, but the total is
		// round(124/60) = 2, not 4. No top-level duration in this fixture, so
		// the accumulator itself is under test.
		const thirtyOne = { distanceMeters: 1000, duration: '31s' };
		nextResponse = () =>
			new Response(
				JSON.stringify({
					routes: [
						{
							legs: [thirtyOne, thirtyOne, thirtyOne, thirtyOne],
							optimizedIntermediateWaypointIndex: [0, 1, 2]
						}
					]
				}),
				{ status: 200 }
			);
		const result = await planOptimizedRoute(STOPS, ANCHOR);
		expect(result.totalMin).toBe(2);
	});
});

describe('the 25-entry cap counts INTERMEDIATES, not stops', () => {
	const spaced = (n: number) =>
		Array.from({ length: n }, (_, i) => ({
			id: i + 1,
			lat: 44 + i * 0.05,
			lon: -68 - i * 0.05
		}));

	it('unanchored legs: 27 stops = 25 intermediates is valid; 28 is rejected', async () => {
		nextResponse = () =>
			routeWith(Array.from({ length: 26 }, () => leg(1, 1)));
		const { legs } = await planDrivingLegs(spaced(27), null);
		expect(legs).toHaveLength(26);
		expect(lastBody!.intermediates).toHaveLength(25);

		await expect(planDrivingLegs(spaced(28), null)).rejects.toThrow('max 25');
	});

	it('anchored optimize: 25 waypoints is valid; 26 is rejected', async () => {
		const anchor = { lat: 43, lon: -67 };
		nextResponse = () =>
			routeWith(
				Array.from({ length: 26 }, () => leg(1, 1)),
				Array.from({ length: 25 }, (_, i) => i)
			);
		const result = await planOptimizedRoute(spaced(25), anchor);
		expect(result.orderedIds).toHaveLength(25);

		await expect(planOptimizedRoute(spaced(26), anchor)).rejects.toThrow('max 25');
	});
});

describe('input guards and upstream statuses', () => {
	it('rejects duplicate stop coordinates before any request', async () => {
		const dupes = [STOPS[0], { id: 99, lat: STOPS[0].lat, lon: STOPS[0].lon }];
		await expect(planDrivingLegs(dupes, ANCHOR)).rejects.toBeInstanceOf(RouteInputError);
		expect(lastBody).toBeNull();
	});

	it('rejects an anchor that duplicates a stop before optimizing', async () => {
		await expect(
			planOptimizedRoute([{ id: 1, ...ANCHOR }, ...STOPS], ANCHOR)
		).rejects.toBeInstanceOf(RouteInputError);
		expect(lastBody).toBeNull();
	});

	it('rejects unlocated stops for leg calculation', async () => {
		await expect(
			planDrivingLegs([...STOPS, { id: 44, lat: null, lon: null }], ANCHOR)
		).rejects.toThrow('Every stop needs coordinates');
		expect(lastBody).toBeNull();
	});

	it('surfaces a rate limit as a retryable message', async () => {
		nextResponse = () => new Response('slow down', { status: 429 });
		await expect(planDrivingLegs(STOPS, ANCHOR)).rejects.toThrow('rate limit');
	});

	it('surfaces upstream failures without inventing data', async () => {
		nextResponse = () => new Response('boom', { status: 500 });
		await expect(planDrivingLegs(STOPS, ANCHOR)).rejects.toThrow('Directions service failed.');
	});
});
