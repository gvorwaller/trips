import { describe, expect, it } from 'vitest';
import {
	buildRoutePolyline,
	cheapestInsertion,
	detourFitKm,
	haversineKm,
	nearestVertexKm,
	type GeoPoint
} from './route-detour';

/** Roughly 1 km of latitude, for building predictable offsets. */
const KM_LAT = 1 / 111.32;

const A: GeoPoint = { lat: 44.4, lon: -68.6 };
const B: GeoPoint = { lat: 44.5, lon: -68.6 };
const C: GeoPoint = { lat: 44.6, lon: -68.6 };

describe('cheapestInsertion', () => {
	it('returns the cheapest edge and its index', () => {
		const fit = cheapestInsertion([
			{ toC: 10, fromC: 10, base: 5 }, // +15
			{ toC: 3, fromC: 3, base: 4 }, // +2
			{ toC: 8, fromC: 8, base: 1 } // +15
		]);
		expect(fit).toEqual({ added: 2, edgeIndex: 1 });
	});

	it('skips edges that are not fully priced rather than treating them as free', () => {
		const fit = cheapestInsertion([
			{ toC: null, fromC: 1, base: 1 },
			{ toC: 1, fromC: null, base: 1 },
			{ toC: 6, fromC: 6, base: 2 }
		]);
		expect(fit).toEqual({ added: 10, edgeIndex: 2 });
	});

	it('returns null when nothing is routable', () => {
		expect(cheapestInsertion([{ toC: null, fromC: null, base: null }])).toBeNull();
		expect(cheapestInsertion([])).toBeNull();
	});

	it('clamps triangle-inequality noise to zero instead of advertising a shortcut', () => {
		const fit = cheapestInsertion([{ toC: 5, fromC: 5, base: 10.4 }]);
		expect(fit?.added).toBe(0);
	});

	it('ignores non-finite costs', () => {
		const fit = cheapestInsertion([
			{ toC: Number.NaN, fromC: 1, base: 1 },
			{ toC: Number.POSITIVE_INFINITY, fromC: 1, base: 1 },
			{ toC: 2, fromC: 2, base: 1 }
		]);
		expect(fit).toEqual({ added: 3, edgeIndex: 2 });
	});
});

describe('buildRoutePolyline', () => {
	it('closes the loop back to the anchor', () => {
		expect(buildRoutePolyline(A, [B, C])).toEqual([A, B, C, A]);
	});

	it('leaves an unanchored day open', () => {
		expect(buildRoutePolyline(null, [A, B, C])).toEqual([A, B, C]);
	});

	it('still produces a usable single out-and-back edge pair for one stop', () => {
		expect(buildRoutePolyline(A, [B])).toEqual([A, B, A]);
	});
});

describe('detourFitKm', () => {
	it('scores a point on the line at ~zero', () => {
		const mid: GeoPoint = { lat: 44.45, lon: -68.6 };
		const fit = detourFitKm(mid, [A, B]);
		expect(fit?.added).toBeLessThan(0.01);
	});

	/**
	 * A sideways offset h from the midpoint of a leg of length L costs about
	 * 2h^2/L, NOT 2h — diverting off a long drive is nearly free, and only
	 * becomes an out-and-back when the leg is short relative to the offset.
	 * Locking this in because the reverse ("~2x the offset") was the intuition
	 * this module was first specified with, and it is wrong by ~5x here.
	 */
	it('charges only ~2h^2/L for a small sideways offset on a long leg', () => {
		const kmLon = (lat: number) => 1 / (111.32 * Math.cos((lat * Math.PI) / 180));
		const off: GeoPoint = { lat: 44.45, lon: -68.6 + 2 * kmLon(44.45) };
		const legKm = haversineKm(A.lat, A.lon, B.lat, B.lon);
		const fit = detourFitKm(off, [A, B]);
		const predicted = (2 * 2 ** 2) / legKm;
		expect(fit?.added).toBeCloseTo(predicted, 1);
		expect(fit?.added).toBeLessThan(1); // emphatically not ~4 km
	});

	it('grows the cost as the offset grows, and approaches out-and-back on a short leg', () => {
		const kmLon = (lat: number) => 1 / (111.32 * Math.cos((lat * Math.PI) / 180));
		const near = detourFitKm({ lat: 44.45, lon: -68.6 + 1 * kmLon(44.45) }, [A, B])!;
		const far = detourFitKm({ lat: 44.45, lon: -68.6 + 4 * kmLon(44.45) }, [A, B])!;
		expect(far.added).toBeGreaterThan(near.added);

		// Same 4 km offset, but from a leg only ~1.1 km long: now it really is
		// close to a 2x out-and-back.
		const shortB: GeoPoint = { lat: 44.41, lon: -68.6 };
		const fromShort = detourFitKm({ lat: 44.405, lon: -68.6 + 4 * kmLon(44.405) }, [A, shortB])!;
		expect(fromShort.added).toBeGreaterThan(6.5);
	});

	it('picks the nearest leg on a multi-leg route', () => {
		const nearSecondLeg: GeoPoint = { lat: 44.55, lon: -68.6 };
		const fit = detourFitKm(nearSecondLeg, [A, B, C]);
		expect(fit?.edgeIndex).toBe(1);
	});

	it('slots a point beyond the last stop onto the terminal edge, not a middle one', () => {
		// Extending straight past C on an open route: the only edge that can absorb
		// it cheaply is the final one.
		const beyond: GeoPoint = { lat: 44.62, lon: -68.6 };
		const fit = detourFitKm(beyond, [A, B, C]);
		expect(fit?.edgeIndex).toBe(1);
	});

	it('needs at least two vertices', () => {
		expect(detourFitKm(A, [])).toBeNull();
		expect(detourFitKm(A, [B])).toBeNull();
	});

	it('survives a degenerate route of identical points without NaN', () => {
		const fit = detourFitKm(B, [A, A, A]);
		expect(fit).not.toBeNull();
		expect(Number.isFinite(fit!.added)).toBe(true);
	});

	/**
	 * The regression that defines td-65f48c. A candidate sitting near the drive
	 * home is expensive while the route is measured open, and cheap once the loop
	 * is closed. Modelled on the measured Seal Cove case, where Downeast Scenic
	 * Railroad went 32.8 km open -> 17.7 km closed.
	 */
	it('makes a candidate near the return leg cheap only once the loop is closed', () => {
		const anchor: GeoPoint = { lat: 44.4, lon: -68.6 };
		const stops: GeoPoint[] = [
			{ lat: 44.5, lon: -68.4 },
			{ lat: 44.6, lon: -68.2 }
		];
		// Sits on the straight line from the last stop back to the anchor.
		const onWayHome: GeoPoint = { lat: 44.5, lon: -68.4 + (-68.2 + 68.4) / 2 };

		const openFit = detourFitKm(onWayHome, buildRoutePolyline(null, [anchor, ...stops]));
		const closedFit = detourFitKm(onWayHome, buildRoutePolyline(anchor, stops));

		expect(closedFit!.added).toBeLessThan(openFit!.added);
		// And it lands on the closing edge, which does not exist in the open form.
		expect(closedFit!.edgeIndex).toBe(2);
	});
});

describe('nearestVertexKm', () => {
	it('measures to the closest vertex', () => {
		const p: GeoPoint = { lat: 44.59, lon: -68.6 };
		const km = nearestVertexKm(p, [A, B, C]);
		expect(km).toBeCloseTo(haversineKm(p.lat, p.lon, C.lat, C.lon), 6);
	});

	it('returns null for an empty route', () => {
		expect(nearestVertexKm(A, [])).toBeNull();
	});
});

describe('haversineKm', () => {
	it('matches a known one-degree-of-latitude span', () => {
		expect(haversineKm(44, -68, 45, -68)).toBeCloseTo(111.19, 1);
	});

	it('is zero for identical points', () => {
		expect(haversineKm(44.4, -68.6, 44.4, -68.6)).toBe(0);
	});

	it('agrees with a 1 km latitude offset', () => {
		expect(haversineKm(44.4, -68.6, 44.4 + KM_LAT, -68.6)).toBeCloseTo(1, 2);
	});
});
