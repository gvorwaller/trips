import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeLegDistances, optimizeDrivingRoute, straightLineOptimize } from './route';

/**
 * These helpers are now a thin client of /api/route/directions (td-b580a8) —
 * the loop semantics, attribution and wire handling are tested server-side in
 * route-directions.test.ts against the real Routes API shapes. What remains
 * here: the fast local pre-checks (which must fire BEFORE any network call)
 * and the transport contract (payload shape, error propagation).
 */

let lastUrl: string | null = null;
let lastBody: Record<string, unknown> | null = null;
let nextResponse: () => Response = () => new Response('{}', { status: 200 });

beforeEach(() => {
	lastUrl = null;
	lastBody = null;
	nextResponse = () => new Response('{}', { status: 200 });
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			lastUrl = String(url);
			lastBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return nextResponse();
		})
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const ANCHOR = { lat: 44.41, lon: -68.59 };
const STOPS = [
	{ id: 11, lat: 44.45, lon: -68.52 },
	{ id: 22, lat: 44.52, lon: -68.44 },
	{ id: 33, lat: 44.58, lon: -68.61 }
];

describe('transport', () => {
	it('posts the legs request and returns the server payload verbatim', async () => {
		const payload = {
			legs: [{ stopId: 11, km: 8, min: 12 }],
			returnLeg: { km: 20, min: 25 }
		};
		nextResponse = () => new Response(JSON.stringify(payload), { status: 200 });
		const result = await computeLegDistances([STOPS[0]], ANCHOR);
		expect(lastUrl).toBe('/api/route/directions');
		expect(lastBody).toEqual({ mode: 'legs', stops: [STOPS[0]], anchor: ANCHOR });
		expect(result).toEqual(payload);
	});

	it('posts the optimize request with ALL stops (unlocated included)', async () => {
		const stops = [...STOPS, { id: 44, lat: null, lon: null }];
		nextResponse = () =>
			new Response(JSON.stringify({ orderedIds: [11, 33, 22, 44], totalKm: 1, totalMin: 2 }), {
				status: 200
			});
		const result = await optimizeDrivingRoute({ anchor: ANCHOR, stops });
		expect(lastBody).toEqual({ mode: 'optimize', stops, anchor: ANCHOR });
		expect(result.orderedIds).toEqual([11, 33, 22, 44]);
	});

	it("propagates the server's error message on failure", async () => {
		nextResponse = () =>
			new Response(JSON.stringify({ message: 'No drivable route found.' }), { status: 400 });
		await expect(computeLegDistances(STOPS, ANCHOR)).rejects.toThrow('No drivable route found.');
	});

	it('falls back to a generic message when the failure body is not JSON', async () => {
		nextResponse = () => new Response('<html>gateway</html>', { status: 502 });
		await expect(computeLegDistances(STOPS, ANCHOR)).rejects.toThrow(
			'Directions service failed.'
		);
	});
});

describe('local pre-checks fire before any network call', () => {
	it('rejects duplicate stop coordinates', async () => {
		const dupes = [STOPS[0], { id: 99, lat: STOPS[0].lat, lon: STOPS[0].lon }];
		await expect(computeLegDistances(dupes, ANCHOR)).rejects.toThrow('duplicate stops');
		expect(lastBody).toBeNull();
	});

	it('rejects an anchor that duplicates a saved stop before optimizing', async () => {
		await expect(
			optimizeDrivingRoute({ anchor: ANCHOR, stops: [{ id: 1, ...ANCHOR }, ...STOPS] })
		).rejects.toThrow('duplicate stops');
		expect(lastBody).toBeNull();
	});

	it('rejects unlocated stops for leg calculation', async () => {
		await expect(
			computeLegDistances([...STOPS, { id: 44, lat: null, lon: null }], ANCHOR)
		).rejects.toThrow('Every stop needs coordinates');
		expect(lastBody).toBeNull();
	});

	it('enforces minimum located stops for optimize', async () => {
		await expect(optimizeDrivingRoute({ anchor: null, stops: STOPS.slice(0, 2) })).rejects.toThrow(
			'at least 3'
		);
		expect(lastBody).toBeNull();
	});
});

describe('straightLineOptimize stays a pure local fallback', () => {
	it('orders by nearest neighbour from the anchor and appends unlocated stops', () => {
		const ids = straightLineOptimize([...STOPS, { id: 44, lat: null, lon: null }], ANCHOR);
		expect(ids).toHaveLength(4);
		expect(ids[3]).toBe(44);
		expect(new Set(ids)).toEqual(new Set([11, 22, 33, 44]));
	});
});
