import { haversineKm } from '$lib/geo';
import { loadGoogleMaps } from '$lib/google-maps';

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

async function directionsService(apiKey: string) {
	const libs = await loadGoogleMaps(apiKey, ['routes']);
	/* eslint-disable @typescript-eslint/no-explicit-any */
	const routes = libs.routes as any;
	return new routes.DirectionsService();
	/* eslint-enable @typescript-eslint/no-explicit-any */
}

function totals(route: {
	legs?: Array<{ distance?: { value?: number }; duration?: { value?: number } }>;
}) {
	let meters = 0;
	let seconds = 0;
	for (const leg of route.legs ?? []) {
		meters += leg.distance?.value ?? 0;
		seconds += leg.duration?.value ?? 0;
	}
	return { km: meters / 1000, min: Math.round(seconds / 60) };
}

/**
 * Compute driving distance/duration for each leg in the current stop order.
 * Returned stopId is the destination stop for the leg from the previous stop.
 *
 * An anchored plan is a CLOSED LOOP: anchor -> every stop -> back to the anchor.
 * Google returns stops.length + 1 legs for that shape; legs 0..n-1 belong to
 * stops 0..n-1, and the final leg is the drive home, returned separately as
 * returnLeg because it has no destination stop to attach to. This matches
 * optimizeDrivingRoute, which has always modelled the anchored day as a loop —
 * the disagreement between the two was td-bf2909, and it made every anchored
 * plan's saved total short by the drive home.
 *
 * An unanchored plan stays an open path (first stop -> last stop, n-1 legs) and
 * gets returnLeg: null. There is no base to return to.
 */
export async function computeLegDistances(
	apiKey: string,
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

	const service = await directionsService(apiKey);
	const origin = anchor ?? located[0];
	const destination = anchor ?? located[located.length - 1];
	const waypointSource = anchor ? located : located.slice(1, -1);
	const waypoints = waypointSource.map((s) => ({
		location: { lat: s.lat, lng: s.lon },
		stopover: true
	}));

	const result = await service.route({
		origin: { lat: origin.lat, lng: origin.lon },
		destination: { lat: destination.lat, lng: destination.lon },
		waypoints,
		optimizeWaypoints: false,
		travelMode: 'DRIVING'
	});

	const route = result?.routes?.[0];
	if (!route) throw new Error('No drivable route found.');

	// Reject partial responses before attributing anything. Without this, a short
	// leg array would slide the mapping and silently label some intermediate leg
	// as the drive home — a wrong number wearing the label of the fix.
	const rawLegs: Array<{ distance?: { value?: number }; duration?: { value?: number } }> =
		route.legs ?? [];
	const expected = anchor ? located.length + 1 : located.length - 1;
	if (rawLegs.length !== expected) {
		throw new Error(
			`Directions returned ${rawLegs.length} legs for ${located.length} stops; expected ${expected}.`
		);
	}

	const toLeg = (leg: { distance?: { value?: number }; duration?: { value?: number } }) => ({
		km: (leg.distance?.value ?? 0) / 1000,
		min: Math.round((leg.duration?.value ?? 0) / 60)
	});

	// Anchored: leg i ends at stop i. Unanchored: leg i ends at stop i + 1.
	const stopLegs = anchor ? rawLegs.slice(0, -1) : rawLegs;
	const legs: DrivingLeg[] = stopLegs.map((leg, i) => ({
		stopId: located[anchor ? i : i + 1].id,
		...toLeg(leg)
	}));

	return { legs, returnLeg: anchor ? toLeg(rawLegs[rawLegs.length - 1]) : null };
}

/**
 * Optimize stop order with Google Directions. An anchor acts as a lodging/base
 * loop. Without an anchor, the first located stop is treated as the fixed base.
 * Stops without coordinates are appended in their original order.
 */
export async function optimizeDrivingRoute(
	apiKey: string,
	opts: { anchor: AnchorPoint | null; stops: RouteStop[] }
): Promise<OptimizeResult> {
	const located = locatedStops(opts.stops);
	const unlocated = missingStops(opts.stops);
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

	const service = await directionsService(apiKey);
	const fixedAnchor = opts.anchor ?? { lat: located[0].lat, lon: located[0].lon };
	const keptPrefix = opts.anchor ? [] : [located[0]];
	const waypointStops = opts.anchor ? located : located.slice(1);

	const result = await service.route({
		origin: { lat: fixedAnchor.lat, lng: fixedAnchor.lon },
		destination: { lat: fixedAnchor.lat, lng: fixedAnchor.lon },
		waypoints: waypointStops.map((s) => ({
			location: { lat: s.lat, lng: s.lon },
			stopover: true
		})),
		optimizeWaypoints: true,
		travelMode: 'DRIVING'
	});

	const route = result?.routes?.[0];
	if (!route) throw new Error('No drivable route found.');
	const order: number[] = route.waypoint_order ?? waypointStops.map((_, i) => i);
	const orderedWaypoints = order.map((i) => waypointStops[i]);
	const t = totals(route);

	return {
		orderedIds: [...keptPrefix, ...orderedWaypoints, ...unlocated].map((s) => s.id),
		totalKm: t.km,
		totalMin: t.min
	};
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
