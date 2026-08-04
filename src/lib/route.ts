import { haversineKm } from '$lib/geo';

export interface RouteStop {
	id: number;
	lat: number | null;
	lon: number | null;
}

export interface DrivingLeg {
	stopId: number;
	km: number;
	min: number;
}

export interface OptimizeResult {
	orderedIds: number[];
	totalKm: number;
	totalMin: number;
}

/** The closing drive from the last stop back to the anchor. Anchored plans only. */
export interface ReturnLeg {
	km: number;
	min: number;
}

export interface DrivingLegs {
	legs: DrivingLeg[];
	returnLeg: ReturnLeg | null;
}

interface AnchorPoint {
	lat: number;
	lon: number;
}

function locatedStops(stops: RouteStop[]): Array<RouteStop & { lat: number; lon: number }> {
	return stops.filter(
		(s): s is RouteStop & { lat: number; lon: number } =>
			typeof s.lat === 'number' &&
			Number.isFinite(s.lat) &&
			typeof s.lon === 'number' &&
			Number.isFinite(s.lon)
	);
}

function missingStops(stops: RouteStop[]): RouteStop[] {
	return stops.filter((s) => typeof s.lat !== 'number' || typeof s.lon !== 'number');
}

function assertNoDuplicateRoutePoints(
	points: Array<{ lat: number; lon: number }>,
	message = 'Remove duplicate stops before calculating directions.'
): void {
	for (let i = 0; i < points.length; i++) {
		for (let j = i + 1; j < points.length; j++) {
			if (haversineKm(points[i].lat, points[i].lon, points[j].lat, points[j].lon) <= 0.03) {
				throw new Error(message);
			}
		}
	}
}

function requireAllLocated(stops: RouteStop[]): Array<RouteStop & { lat: number; lon: number }> {
	const located = locatedStops(stops);
	if (located.length !== stops.length) {
		throw new Error('Every stop needs coordinates to calculate driving legs.');
	}
	return located;
}

/**
 * Transport to the server's Routes API v2 wrapper (td-b580a8). The browser
 * DirectionsService these helpers used is deprecated; all Google calls now
 * happen server-side (/api/route/directions), where results are cached and
 * the key never leaves the server. The validation kept below is a fast local
 * pre-check for instant error messages — the server re-validates everything
 * and is authoritative.
 */
async function requestDirections<T>(body: {
	mode: 'legs' | 'optimize';
	stops: RouteStop[];
	anchor: AnchorPoint | null;
}): Promise<T> {
	const res = await fetch('/api/route/directions', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
	let data: unknown = null;
	try {
		data = await res.json();
	} catch {
		/* fall through to the status check */
	}
	if (!res.ok) {
		const message = (data as { message?: string; error?: string } | null) ?? {};
		throw new Error(message.message ?? message.error ?? 'Directions service failed.');
	}
	return data as T;
}

/**
 * Compute driving distance/duration for each leg in the current stop order.
 * Returned stopId is the destination stop for the leg from the previous stop.
 *
 * An anchored plan is a CLOSED LOOP: anchor -> every stop -> back to the
 * anchor; the final leg is the drive home, returned separately as returnLeg
 * (td-bf2909). An unanchored plan stays an open path with returnLeg: null.
 * The loop semantics, leg-count validation and attribution all live
 * server-side in $server/route-directions.
 */
export async function computeLegDistances(
	stops: RouteStop[],
	anchor: AnchorPoint | null = null
): Promise<DrivingLegs> {
	const located = requireAllLocated(stops);
	if (located.length < (anchor ? 1 : 2)) {
		throw new Error(
			anchor ? 'Need at least 1 stop with coordinates.' : 'Need at least 2 stops with coordinates.'
		);
	}
	assertNoDuplicateRoutePoints(anchor ? [anchor, ...located] : located);
	return requestDirections<DrivingLegs>({ mode: 'legs', stops, anchor });
}

/**
 * Optimize stop order. An anchor acts as a lodging/base loop; without one the
 * first located stop is the fixed base. Stops without coordinates are
 * appended in their original order (handled server-side).
 */
export async function optimizeDrivingRoute(opts: {
	anchor: AnchorPoint | null;
	stops: RouteStop[];
}): Promise<OptimizeResult> {
	const located = locatedStops(opts.stops);
	const minLocated = opts.anchor ? 2 : 3;
	if (located.length < minLocated) {
		throw new Error(
			opts.anchor
				? 'Need at least 2 stops with coordinates to optimize.'
				: 'Need at least 3 stops with coordinates to optimize.'
		);
	}
	assertNoDuplicateRoutePoints(
		opts.anchor ? [opts.anchor, ...located] : located,
		'Remove duplicate stops before optimizing the route.'
	);
	return requestDirections<OptimizeResult>({
		mode: 'optimize',
		stops: opts.stops,
		anchor: opts.anchor
	});
}

export function straightLineOptimize(stops: RouteStop[], anchor: AnchorPoint | null): number[] {
	const located = locatedStops(stops);
	const unlocated = missingStops(stops);
	if (located.length < 2) return stops.map((s) => s.id);

	let current = anchor ?? { lat: located[0].lat, lon: located[0].lon };
	const remaining = anchor ? [...located] : located.slice(1);
	const ordered = anchor ? [] : [located[0]];

	while (remaining.length > 0) {
		let bestIndex = 0;
		let bestKm = Number.POSITIVE_INFINITY;
		for (let i = 0; i < remaining.length; i++) {
			const candidate = remaining[i];
			const km = haversineKm(current.lat, current.lon, candidate.lat, candidate.lon);
			if (km < bestKm) {
				bestKm = km;
				bestIndex = i;
			}
		}
		const [next] = remaining.splice(bestIndex, 1);
		ordered.push(next);
		current = { lat: next.lat, lon: next.lon };
	}

	return [...ordered, ...unlocated].map((s) => s.id);
}
