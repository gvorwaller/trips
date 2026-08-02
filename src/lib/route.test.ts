import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeLegDistances, optimizeDrivingRoute } from './route';

/**
 * These helpers reach Google through loadGoogleMaps, so the request they build
 * was untestable and untested — which is how td-65f48c and td-bf2909 (two
 * origin/destination bugs in the same pair of functions) both reached
 * production. Stubbing the Maps loader makes the request object assertable.
 */

interface RouteRequest {
	origin: { lat: number; lng: number };
	destination: { lat: number; lng: number };
	waypoints: Array<{ location: { lat: number; lng: number }; stopover: boolean }>;
	optimizeWaypoints: boolean;
	travelMode: string;
}

let lastRequest: RouteRequest | null = null;
let nextResponse: unknown = null;

vi.mock('$lib/google-maps', () => ({
	loadGoogleMaps: async () => ({
		routes: {
			DirectionsService: class {
				route(req: RouteRequest) {
					lastRequest = req;
					return Promise.resolve(nextResponse);
				}
			}
		}
	})
}));

/** meters/seconds, the shape the Directions JS API returns. */
const leg = (km: number, min: number) => ({
	distance: { value: km * 1000 },
	duration: { value: min * 60 }
});

const routeWith = (legs: ReturnType<typeof leg>[], waypointOrder?: number[]) => ({
	routes: [{ legs, waypoint_order: waypointOrder }]
});

// Blue Hill area, spaced well beyond the 30 m duplicate guard.
const ANCHOR = { lat: 44.41, lon: -68.59 };
const STOPS = [
	{ id: 11, lat: 44.45, lon: -68.52 },
	{ id: 22, lat: 44.52, lon: -68.44 },
	{ id: 33, lat: 44.58, lon: -68.61 }
];

beforeEach(() => {
	lastRequest = null;
	nextResponse = null;
});

describe('computeLegDistances — anchored plans are a closed loop (td-bf2909)', () => {
	it('routes anchor -> every stop -> back to the anchor', async () => {
		nextResponse = routeWith([leg(8, 12), leg(9, 14), leg(11, 16), leg(20, 25)]);

		await computeLegDistances('key', STOPS, ANCHOR);

		expect(lastRequest?.origin).toEqual({ lat: 44.41, lng: -68.59 });
		// The bug: destination used to be the LAST STOP, so the drive home was
		// never requested and never counted.
		expect(lastRequest?.destination).toEqual({ lat: 44.41, lng: -68.59 });
		expect(lastRequest?.waypoints).toHaveLength(3);
		expect(lastRequest?.waypoints.map((w) => w.location.lat)).toEqual([44.45, 44.52, 44.58]);
		expect(lastRequest?.optimizeWaypoints).toBe(false);
	});

	it('attributes each leg to the stop it arrives at, and the last leg to the return', async () => {
		nextResponse = routeWith([leg(8, 12), leg(9, 14), leg(11, 16), leg(20, 25)]);

		const { legs, returnLeg } = await computeLegDistances('key', STOPS, ANCHOR);

		expect(legs).toEqual([
			{ stopId: 11, km: 8, min: 12 },
			{ stopId: 22, km: 9, min: 14 },
			{ stopId: 33, km: 11, min: 16 }
		]);
		expect(returnLeg).toEqual({ km: 20, min: 25 });
	});

	it('handles a single anchored stop as out-and-back', async () => {
		nextResponse = routeWith([leg(6, 9), leg(6, 10)]);

		const { legs, returnLeg } = await computeLegDistances('key', [STOPS[0]], ANCHOR);

		expect(legs).toEqual([{ stopId: 11, km: 6, min: 9 }]);
		expect(returnLeg).toEqual({ km: 6, min: 10 });
	});
});

describe('computeLegDistances — unanchored plans stay an open path', () => {
	it('routes first stop -> last stop with no return leg', async () => {
		nextResponse = routeWith([leg(9, 14), leg(11, 16)]);

		const { legs, returnLeg } = await computeLegDistances('key', STOPS);

		expect(lastRequest?.origin).toEqual({ lat: 44.45, lng: -68.52 });
		expect(lastRequest?.destination).toEqual({ lat: 44.58, lng: -68.61 });
		expect(lastRequest?.waypoints.map((w) => w.location.lat)).toEqual([44.52]);
		// Leg i arrives at stop i+1; the first stop has nothing arriving at it.
		expect(legs).toEqual([
			{ stopId: 22, km: 9, min: 14 },
			{ stopId: 33, km: 11, min: 16 }
		]);
		expect(returnLeg).toBeNull();
	});
});

describe('computeLegDistances — partial responses are rejected, not reinterpreted', () => {
	it('rejects too few legs on an anchored plan instead of mislabelling one as the drive home', async () => {
		// Three legs for three anchored stops: one short. Slicing the last one off
		// would silently report the leg into stop 33 as the drive home.
		nextResponse = routeWith([leg(8, 12), leg(9, 14), leg(11, 16)]);

		await expect(computeLegDistances('key', STOPS, ANCHOR)).rejects.toThrow(
			'Directions returned 3 legs for 3 stops; expected 4.'
		);
	});

	it('rejects too many legs', async () => {
		nextResponse = routeWith([leg(1, 1), leg(1, 1), leg(1, 1), leg(1, 1), leg(1, 1)]);

		await expect(computeLegDistances('key', STOPS, ANCHOR)).rejects.toThrow('expected 4');
	});

	it('rejects an empty leg list', async () => {
		nextResponse = routeWith([]);

		await expect(computeLegDistances('key', STOPS)).rejects.toThrow('expected 2');
	});

	it('rejects a response with no route at all', async () => {
		nextResponse = { routes: [] };

		await expect(computeLegDistances('key', STOPS, ANCHOR)).rejects.toThrow(
			'No drivable route found.'
		);
	});
});

describe('optimizeDrivingRoute — waypoint order remap', () => {
	it('reorders anchored stops by waypoint_order and closes the loop', async () => {
		nextResponse = routeWith([leg(5, 8), leg(6, 9), leg(7, 10), leg(9, 13)], [2, 0, 1]);

		const result = await optimizeDrivingRoute('key', { anchor: ANCHOR, stops: STOPS });

		expect(lastRequest?.origin).toEqual({ lat: 44.41, lng: -68.59 });
		expect(lastRequest?.destination).toEqual({ lat: 44.41, lng: -68.59 });
		expect(lastRequest?.optimizeWaypoints).toBe(true);
		expect(result.orderedIds).toEqual([33, 11, 22]);
		expect(result.totalKm).toBe(27);
		expect(result.totalMin).toBe(40);
	});

	it('keeps the first stop fixed as the base when unanchored', async () => {
		nextResponse = routeWith([leg(5, 8), leg(6, 9), leg(7, 10)], [1, 0]);

		const result = await optimizeDrivingRoute('key', { anchor: null, stops: STOPS });

		// Origin and destination are the first stop; only the rest get reordered.
		expect(lastRequest?.origin).toEqual({ lat: 44.45, lng: -68.52 });
		expect(result.orderedIds).toEqual([11, 33, 22]);
	});

	it('appends stops without coordinates in their original order', async () => {
		nextResponse = routeWith([leg(5, 8), leg(6, 9), leg(7, 10), leg(9, 13)], [2, 0, 1]);

		const result = await optimizeDrivingRoute('key', {
			anchor: ANCHOR,
			stops: [...STOPS, { id: 44, lat: null, lon: null }]
		});

		expect(result.orderedIds).toEqual([33, 11, 22, 44]);
	});
});

describe('route duplicate guards', () => {
	it('rejects duplicate stop coordinates before calculating directions', async () => {
		await expect(
			computeLegDistances('key', [
				{ id: 1, lat: 44.4, lon: -68.2 },
				{ id: 2, lat: 44.400001, lon: -68.200001 }
			])
		).rejects.toThrow('Remove duplicate stops before calculating directions.');
	});

	it('rejects an anchor that duplicates a saved stop before optimizing', async () => {
		await expect(
			optimizeDrivingRoute('key', {
				anchor: { lat: 44.4, lon: -68.2 },
				stops: [
					{ id: 1, lat: 44.400001, lon: -68.200001 },
					{ id: 2, lat: 44.5, lon: -68.3 }
				]
			})
		).rejects.toThrow('Remove duplicate stops before optimizing the route.');
	});
});
