/**
 * Driving summaries for a saved day plan.
 *
 * Extracted from the trip page so the same numbers can be rendered by the page
 * and by server-side exports without drifting apart, and so they can be unit
 * tested — this logic had no coverage when td-bf2909 (an anchored plan's total
 * silently omitting the drive home) shipped to production.
 *
 * Pure: no Svelte, no DB, no fetch. Everything is passed in.
 *
 * ── The closed-loop rule ──
 * An ANCHORED plan is a loop: anchor -> stop 1 -> ... -> stop n -> anchor. Each
 * stop carries the leg that ARRIVES at it (drive_km/drive_min), and the closing
 * drive home lives on the plan (return_drive_km/return_drive_min, migration
 * 0013) because it has no destination stop to hang on.
 *
 * An UNANCHORED plan is an open path: stop 1 -> ... -> stop n. The first stop
 * has no arriving leg, so it is skipped, and there is no return.
 */

import { formatDistance, formatDuration, haversineKm, type DistanceUnit } from '$lib/geo';

export interface DrivingStop {
	drive_km: number | null;
	drive_min: number | null;
	snapshot_lat: number | null;
	snapshot_lon: number | null;
}

export interface DrivingAnchor {
	title: string;
	lat: number;
	lon: number;
}

export interface DrivingPlan {
	return_drive_km: number | null;
	return_drive_min: number | null;
}

export interface DrivingTotals {
	km: number;
	min: number;
}

/** Stops that should carry an arriving leg: all of them when anchored, all but the first otherwise. */
function legBearingStops<T>(stops: T[], anchor: DrivingAnchor | null): T[] {
	return anchor ? stops : stops.slice(1);
}

/**
 * Total persisted driving for a plan, or null when the data is incomplete.
 *
 * Returns null rather than a partial sum: a total assembled from some-but-not-all
 * legs is a wrong number presented as a right one, which is the exact failure
 * mode td-bf2909 was. Callers fall back to a clearly-labelled straight-line
 * estimate instead.
 */
export function persistedDrivingTotals(
	plan: DrivingPlan,
	stops: DrivingStop[],
	anchor: DrivingAnchor | null
): DrivingTotals | null {
	const legs = legBearingStops(stops, anchor);
	if (legs.length === 0) return null;
	if (!legs.every((s) => s.drive_km != null && s.drive_min != null)) return null;

	// An anchored plan without its return leg is only partly calculated — most
	// likely saved before 0013, or invalidated by an anchor change.
	if (anchor && (plan.return_drive_km == null || plan.return_drive_min == null)) return null;

	const km =
		legs.reduce((sum, s) => sum + (s.drive_km ?? 0), 0) + (anchor ? (plan.return_drive_km ?? 0) : 0);
	const min =
		legs.reduce((sum, s) => sum + (s.drive_min ?? 0), 0) +
		(anchor ? (plan.return_drive_min ?? 0) : 0);
	return { km, min };
}

export function persistedDrivingSummary(
	plan: DrivingPlan,
	stops: DrivingStop[],
	anchor: DrivingAnchor | null,
	unit: DistanceUnit = 'mi'
): string | null {
	const totals = persistedDrivingTotals(plan, stops, anchor);
	return totals ? `${formatDistance(totals.km, unit)}, ${formatDuration(totals.min)}` : null;
}

/**
 * Straight-line distance around the whole route, closing the loop back to the
 * anchor when there is one. Null when fewer than two points have coordinates.
 *
 * The closing leg matters: without it the estimate understated anchored plans
 * exactly the way the persisted total did.
 */
export function straightLineRouteKm(
	stops: DrivingStop[],
	anchor: DrivingAnchor | null
): number | null {
	const points: Array<{ lat: number; lon: number }> = [];
	if (anchor) points.push({ lat: anchor.lat, lon: anchor.lon });
	for (const s of stops) {
		if (typeof s.snapshot_lat === 'number' && typeof s.snapshot_lon === 'number') {
			points.push({ lat: s.snapshot_lat, lon: s.snapshot_lon });
		}
	}
	if (anchor && points.length > 1) points.push({ lat: anchor.lat, lon: anchor.lon });
	if (points.length < 2) return null;

	let km = 0;
	for (let i = 0; i < points.length - 1; i++) {
		km += haversineKm(points[i].lat, points[i].lon, points[i + 1].lat, points[i + 1].lon);
	}
	return km;
}

/** Persisted total when complete, otherwise a straight-line estimate marked as such. */
export function routeSummary(
	plan: DrivingPlan,
	stops: DrivingStop[],
	anchor: DrivingAnchor | null,
	unit: DistanceUnit = 'mi'
): string | null {
	const driving = persistedDrivingSummary(plan, stops, anchor, unit);
	if (driving) return driving;
	const km = straightLineRouteKm(stops, anchor);
	return km == null ? null : `~${formatDistance(km, unit)} straight-line`;
}

/** The leg arriving at `stop`. `prev` is null for the first stop in the plan. */
export function legSummary(
	prev: DrivingStop | null,
	stop: DrivingStop,
	anchor: DrivingAnchor | null,
	unit: DistanceUnit = 'mi'
): string | null {
	if (stop.drive_km != null && stop.drive_min != null) {
		return `${formatDistance(stop.drive_km, unit)}, ${formatDuration(stop.drive_min)}`;
	}
	const to =
		typeof stop.snapshot_lat === 'number' && typeof stop.snapshot_lon === 'number'
			? { lat: stop.snapshot_lat, lon: stop.snapshot_lon }
			: null;
	if (!to) return null;

	const from = !prev
		? anchor
			? { lat: anchor.lat, lon: anchor.lon }
			: null
		: typeof prev.snapshot_lat === 'number' && typeof prev.snapshot_lon === 'number'
			? { lat: prev.snapshot_lat, lon: prev.snapshot_lon }
			: null;
	if (!from) return null;

	return `~${formatDistance(haversineKm(from.lat, from.lon, to.lat, to.lon), unit)} straight-line`;
}

/**
 * The drive home from the last located stop back to the anchor, or null for an
 * unanchored plan (nowhere to return to) and for an empty plan.
 */
export function returnLegSummary(
	plan: DrivingPlan,
	stops: DrivingStop[],
	anchor: DrivingAnchor | null,
	unit: DistanceUnit = 'mi'
): string | null {
	if (!anchor || stops.length === 0) return null;
	if (plan.return_drive_km != null && plan.return_drive_min != null) {
		return `${formatDistance(plan.return_drive_km, unit)}, ${formatDuration(plan.return_drive_min)}`;
	}
	for (let i = stops.length - 1; i >= 0; i--) {
		const s = stops[i];
		if (typeof s.snapshot_lat === 'number' && typeof s.snapshot_lon === 'number') {
			return `~${formatDistance(
				haversineKm(s.snapshot_lat, s.snapshot_lon, anchor.lat, anchor.lon),
				unit
			)} straight-line`;
		}
	}
	return null;
}
