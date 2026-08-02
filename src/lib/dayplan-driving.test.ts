import { describe, expect, it } from 'vitest';
import {
	legSummary,
	persistedDrivingSummary,
	persistedDrivingTotals,
	returnLegSummary,
	routeSummary,
	straightLineRouteKm,
	type DrivingStop
} from './dayplan-driving';

const ANCHOR = { title: 'Blue Hill Inn', lat: 44.41, lon: -68.59 };

const stop = (over: Partial<DrivingStop> = {}): DrivingStop => ({
	drive_km: null,
	drive_min: null,
	snapshot_lat: 44.45,
	snapshot_lon: -68.52,
	...over
});

/** Three stops with complete legs, as saved after a successful calculation. */
const CALCULATED: DrivingStop[] = [
	stop({ drive_km: 8, drive_min: 12, snapshot_lat: 44.45, snapshot_lon: -68.52 }),
	stop({ drive_km: 9, drive_min: 14, snapshot_lat: 44.52, snapshot_lon: -68.44 }),
	stop({ drive_km: 11, drive_min: 16, snapshot_lat: 44.58, snapshot_lon: -68.61 })
];

const RETURNED = { return_drive_km: 20, return_drive_min: 25 };
const NO_RETURN = { return_drive_km: null, return_drive_min: null };

describe('persistedDrivingTotals — anchored plans include the drive home', () => {
	it('adds the return leg to the stop legs', () => {
		// 8 + 9 + 11 = 28 driving to the stops, plus 20 home.
		expect(persistedDrivingTotals(RETURNED, CALCULATED, ANCHOR)).toEqual({ km: 48, min: 67 });
	});

	it('returns null for an anchored plan whose return leg was never saved', () => {
		// The td-bf2909 state: legs present, drive home missing. Reporting 28 km
		// here is exactly the bug — a short total presented as complete.
		expect(persistedDrivingTotals(NO_RETURN, CALCULATED, ANCHOR)).toBeNull();
	});

	it('sums only the arriving legs when unanchored, skipping the first stop', () => {
		// No leg arrives at the first stop, so its null drive_km is expected.
		const open = [stop({ snapshot_lat: 44.45, snapshot_lon: -68.52 }), CALCULATED[1], CALCULATED[2]];
		expect(persistedDrivingTotals(NO_RETURN, open, null)).toEqual({ km: 20, min: 30 });
	});

	it('returns null when any leg is missing rather than a partial sum', () => {
		const partial = [CALCULATED[0], stop({ drive_km: null, drive_min: null }), CALCULATED[2]];
		expect(persistedDrivingTotals(RETURNED, partial, ANCHOR)).toBeNull();
	});

	it('returns null for an empty plan', () => {
		expect(persistedDrivingTotals(RETURNED, [], ANCHOR)).toBeNull();
	});
});

describe('persistedDrivingSummary formatting', () => {
	it('formats in miles by default', () => {
		expect(persistedDrivingSummary(RETURNED, CALCULATED, ANCHOR)).toBe('30 mi, 1 h 7 min');
	});

	it('formats in kilometres when asked', () => {
		expect(persistedDrivingSummary(RETURNED, CALCULATED, ANCHOR, 'km')).toBe('48 km, 1 h 7 min');
	});
});

describe('straightLineRouteKm — the estimate closes the loop too', () => {
	it('returns to the anchor on an anchored plan', () => {
		const open = straightLineRouteKm(CALCULATED, null) ?? 0;
		const closed = straightLineRouteKm(CALCULATED, ANCHOR) ?? 0;
		// Anchor -> first stop, and last stop -> anchor, are both real driving.
		expect(closed).toBeGreaterThan(open);
	});

	it('does not append a closing leg when unanchored', () => {
		const points = [
			stop({ snapshot_lat: 44.4, snapshot_lon: -68.5 }),
			stop({ snapshot_lat: 44.5, snapshot_lon: -68.5 })
		];
		const km = straightLineRouteKm(points, null) ?? 0;
		expect(km).toBeCloseTo(11.1, 1);
	});

	it('skips stops without coordinates', () => {
		const withGap = [
			stop({ snapshot_lat: 44.4, snapshot_lon: -68.5 }),
			stop({ snapshot_lat: null, snapshot_lon: null }),
			stop({ snapshot_lat: 44.5, snapshot_lon: -68.5 })
		];
		expect(straightLineRouteKm(withGap, null)).toBeCloseTo(11.1, 1);
	});

	it('returns null when fewer than two points have coordinates', () => {
		expect(straightLineRouteKm([stop({ snapshot_lat: null, snapshot_lon: null })], null)).toBeNull();
	});
});

describe('routeSummary falls back to a labelled estimate', () => {
	it('prefers the persisted total when complete', () => {
		expect(routeSummary(RETURNED, CALCULATED, ANCHOR)).toBe('30 mi, 1 h 7 min');
	});

	it('falls back to straight-line when the return leg is missing', () => {
		const summary = routeSummary(NO_RETURN, CALCULATED, ANCHOR);
		expect(summary).toMatch(/^~[\d.]+ mi straight-line$/);
	});

	it('returns null when there is nothing to measure', () => {
		expect(routeSummary(NO_RETURN, [], null)).toBeNull();
	});
});

describe('legSummary', () => {
	it('uses the persisted leg when present', () => {
		expect(legSummary(null, CALCULATED[0], ANCHOR)).toBe('5.0 mi, 12 min');
	});

	it('estimates the first leg from the anchor', () => {
		const first = stop({ snapshot_lat: 44.45, snapshot_lon: -68.52 });
		expect(legSummary(null, first, ANCHOR)).toMatch(/straight-line$/);
	});

	it('has nothing to show for the first stop of an unanchored plan', () => {
		expect(legSummary(null, stop(), null)).toBeNull();
	});

	it('estimates between two stops when the leg was not calculated', () => {
		const prev = stop({ snapshot_lat: 44.4, snapshot_lon: -68.5 });
		const next = stop({ snapshot_lat: 44.5, snapshot_lon: -68.5 });
		expect(legSummary(prev, next, null)).toMatch(/straight-line$/);
	});

	it('returns null when the destination stop has no coordinates', () => {
		expect(legSummary(CALCULATED[0], stop({ snapshot_lat: null, snapshot_lon: null }), ANCHOR)).toBe(
			null
		);
	});
});

describe('returnLegSummary', () => {
	it('shows the persisted drive home', () => {
		expect(returnLegSummary(RETURNED, CALCULATED, ANCHOR)).toBe('12 mi, 25 min');
	});

	it('estimates from the last located stop when not yet calculated', () => {
		expect(returnLegSummary(NO_RETURN, CALCULATED, ANCHOR)).toMatch(/^~[\d.]+ mi straight-line$/);
	});

	it('skips trailing stops without coordinates when estimating', () => {
		const trailingGap = [...CALCULATED, stop({ snapshot_lat: null, snapshot_lon: null })];
		expect(returnLegSummary(NO_RETURN, trailingGap, ANCHOR)).toMatch(/straight-line$/);
	});

	it('has no drive home without an anchor', () => {
		expect(returnLegSummary(NO_RETURN, CALCULATED, null)).toBeNull();
	});

	it('has no drive home for an empty plan', () => {
		expect(returnLegSummary(RETURNED, [], ANCHOR)).toBeNull();
	});
});
