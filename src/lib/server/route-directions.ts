/**
 * Server-side driving directions via Google Routes API v2 computeRoutes
 * (td-b580a8). Replaces the browser DirectionsService — deprecated
 * 2026-02-25 — for the two day-plan helpers: per-leg distances in a fixed
 * stop order, and waypoint-order optimization.
 *
 * Conventions follow route-matrix.ts deliberately:
 *  - GOOGLE_GEOCODING_KEY (already Routes-enabled, server-side only);
 *  - TRAFFIC_UNAWARE, so results depend only on the road network and can sit
 *    in api_cache for a week;
 *  - hashed cache keys (migration 0012: no user coordinates in plaintext);
 *  - typed status results instead of thrown wire errors.
 *
 * Billing (td-b580a8's checklist): TRAFFIC_UNAWARE computeRoutes with <= 10
 * intermediates bills Basic; 11+ intermediates or optimizeWaypointOrder
 * bills Advanced — the same category the DirectionsService equivalents
 * billed, so this migration does not change spend.
 *
 * Wire-shape notes (mirror the style of route-matrix.ts):
 *  - duration is a string with a trailing "s" ("1244s");
 *  - a completely unroutable request returns an EMPTY body `{}` rather than
 *    an error status;
 *  - optimizedIntermediateWaypointIndex maps optimized position -> ORIGINAL
 *    intermediates index (position i in the optimized order is original
 *    waypoint order[i]).
 */
import { createHash } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { query as dbQuery } from '$lib/db';
import { haversineKm } from '$lib/geo';

export interface RoutePoint {
	lat: number;
	lon: number;
}

export interface RouteStopInput {
	id: number;
	lat: number | null;
	lon: number | null;
}

export interface PlanLeg {
	stopId: number;
	km: number;
	min: number;
}

export interface PlanDrivingLegs {
	legs: PlanLeg[];
	returnLeg: { km: number; min: number } | null;
}

export interface PlanOptimizeResult {
	orderedIds: number[];
	totalKm: number;
	totalMin: number;
}

/** User-safe validation failure — the endpoint maps it to a 400. */
export class RouteInputError extends Error {}

/** Known operational upstream condition with a user-safe message. The
 * endpoint maps httpStatus directly; a generic Error would be sanitized by
 * SvelteKit into an opaque 500 and the client would never see the message. */
export class RouteUpstreamError extends Error {
	constructor(
		message: string,
		public httpStatus: number
	) {
		super(message);
	}
}

const REQUEST_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 7 * 24 * 60 * 60_000;
/** Routes API caps intermediates at 25; day plans run ~a dozen stops. */
const MAX_INTERMEDIATES = 25;

interface WireLeg {
	distanceMeters?: number;
	duration?: string;
}

interface WireRoute {
	legs?: WireLeg[];
	distanceMeters?: number;
	duration?: string;
	optimizedIntermediateWaypointIndex?: number[];
}

interface DirectionsOk {
	status: 'ok';
	legs: Array<{ km: number; min: number }>;
	totalKm: number;
	totalMin: number;
	optimizedOrder: number[] | null;
}

export type DirectionsResult =
	| DirectionsOk
	| { status: 'not_configured' | 'upstream_error' | 'rate_limited' | 'no_route' | 'malformed' };

/** "1244s" -> seconds. Null for anything unparseable. */
function parseDurationSeconds(raw: string | undefined): number | null {
	if (typeof raw !== 'string') return null;
	const m = /^(\d+(?:\.\d+)?)s$/.exec(raw.trim());
	if (!m) return null;
	const n = Number(m[1]);
	return Number.isFinite(n) ? n : null;
}

const wireWaypoint = (p: RoutePoint) => ({
	location: { latLng: { latitude: p.lat, longitude: p.lon } }
});

async function requestRoute(
	apiKey: string,
	origin: RoutePoint,
	destination: RoutePoint,
	intermediates: RoutePoint[],
	optimize: boolean
): Promise<DirectionsResult> {
	let res: Response;
	try {
		res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Goog-Api-Key': apiKey,
				'X-Goog-FieldMask':
					'routes.legs.distanceMeters,routes.legs.duration,routes.distanceMeters,routes.duration,routes.optimizedIntermediateWaypointIndex'
			},
			body: JSON.stringify({
				origin: wireWaypoint(origin),
				destination: wireWaypoint(destination),
				intermediates: intermediates.map(wireWaypoint),
				travelMode: 'DRIVE',
				routingPreference: 'TRAFFIC_UNAWARE',
				optimizeWaypointOrder: optimize
			}),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		});
	} catch {
		return { status: 'upstream_error' };
	}
	if (res.status === 429) return { status: 'rate_limited' };
	if (!res.ok) return { status: 'upstream_error' };

	let data: unknown;
	try {
		data = await res.json();
	} catch {
		return { status: 'upstream_error' };
	}
	const route = (data as { routes?: WireRoute[] } | null)?.routes?.[0];
	// An unroutable request is an empty body, not an HTTP error.
	if (!route) return { status: 'no_route' };

	// Fail closed on PROVIDED-but-invalid leg fields (peer CODEX, round 2):
	// laundering a malformed duration or distance into 0 persists a wrong
	// number wearing a routed label — the exact class the leg-count and
	// order checks exist to prevent. OMISSION stays zero: the live API omits
	// distanceMeters for zero-length legs rather than sending 0.
	if (route.legs !== undefined && !Array.isArray(route.legs)) {
		return { status: 'malformed' };
	}
	const legs: Array<{ km: number; min: number }> = [];
	let totalKm = 0;
	let totalSeconds = 0;
	for (const leg of route.legs ?? []) {
		if (leg === null || typeof leg !== 'object') return { status: 'malformed' };
		let seconds = 0;
		if (leg.duration !== undefined) {
			const parsed = parseDurationSeconds(leg.duration);
			if (parsed === null || parsed < 0) return { status: 'malformed' };
			seconds = parsed;
		}
		let km = 0;
		if (leg.distanceMeters !== undefined) {
			// Google's REST field is an INTEGER — a provided fractional or
			// absurd value is malformed wire, not a distance (round 3).
			if (
				typeof leg.distanceMeters !== 'number' ||
				!Number.isSafeInteger(leg.distanceMeters) ||
				leg.distanceMeters < 0
			) {
				return { status: 'malformed' };
			}
			km = leg.distanceMeters / 1000;
		}
		legs.push({ km, min: Math.round(seconds / 60) });
		totalKm += km;
		totalSeconds += seconds;
	}
	// Totals accumulate RAW seconds and round once — summing per-leg rounded
	// minutes drifts by up to legs/2 minutes (peer CODEX, round 1). The
	// top-level route.duration is preferred when parseable; a PROVIDED but
	// unparseable one is malformed.
	if (route.duration !== undefined && parseDurationSeconds(route.duration) === null) {
		return { status: 'malformed' };
	}
	const topLevel = parseDurationSeconds(route.duration);
	// Runtime-validate the optimized order's SHAPE here, before caching: the
	// WireRoute interface is only a cast, so ["2","0","1"] would coerce
	// through length/Set/range checks and string-index real waypoints, and
	// [0.5, 1, 2] would map to undefined and crash later as an opaque 500
	// (peer CODEX, round 3). Permutation/range checks stay in
	// planOptimizedRoute where the waypoint count is known.
	if (route.optimizedIntermediateWaypointIndex !== undefined) {
		const o = route.optimizedIntermediateWaypointIndex;
		if (!Array.isArray(o) || o.some((i) => typeof i !== 'number' || !Number.isInteger(i))) {
			return { status: 'malformed' };
		}
	}
	return {
		status: 'ok',
		legs,
		totalKm,
		totalMin: Math.round((topLevel ?? totalSeconds) / 60),
		optimizedOrder: route.optimizedIntermediateWaypointIndex ?? null
	};
}

function directionsCacheKey(
	origin: RoutePoint,
	destination: RoutePoint,
	intermediates: RoutePoint[],
	optimize: boolean
): string {
	const fmt = (p: RoutePoint) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
	const digest = createHash('sha256')
		.update(
			`${fmt(origin)}|${fmt(destination)}|${intermediates.map(fmt).join(';')}|${optimize ? 'opt' : 'fixed'}|DRIVE|TRAFFIC_UNAWARE`
		)
		.digest('hex')
		.slice(0, 32);
	return `routedirections:${digest}`;
}

/** requestRoute behind api_cache. Only 'ok' results are stored. */
async function requestRouteCached(
	origin: RoutePoint,
	destination: RoutePoint,
	intermediates: RoutePoint[],
	optimize: boolean
): Promise<DirectionsResult> {
	const apiKey = env.GOOGLE_GEOCODING_KEY;
	if (!apiKey) return { status: 'not_configured' };

	const key = directionsCacheKey(origin, destination, intermediates, optimize);
	const cached = await dbQuery<{ payload: DirectionsOk; fetched_at: string }>(
		'SELECT payload, fetched_at FROM api_cache WHERE cache_key = $1',
		[key]
	);
	const row = cached.rows[0];
	if (row && Date.now() - new Date(row.fetched_at).getTime() < CACHE_TTL_MS) {
		return row.payload;
	}

	const result = await requestRoute(apiKey, origin, destination, intermediates, optimize);
	if (result.status === 'ok') {
		await dbQuery(
			`INSERT INTO api_cache (cache_key, payload, fetched_at)
			 VALUES ($1, $2, NOW())
			 ON CONFLICT (cache_key) DO UPDATE SET payload = $2, fetched_at = NOW()`,
			[key, JSON.stringify(result)]
		);
	}
	return result;
}

// ── Plan-shaped helpers (the old src/lib/route.ts contracts, server-side) ──

function locatedStops(stops: RouteStopInput[]): Array<RouteStopInput & RoutePoint> {
	return stops.filter(
		(s): s is RouteStopInput & RoutePoint =>
			typeof s.lat === 'number' &&
			Number.isFinite(s.lat) &&
			typeof s.lon === 'number' &&
			Number.isFinite(s.lon)
	);
}

function missingStops(stops: RouteStopInput[]): RouteStopInput[] {
	return stops.filter((s) => typeof s.lat !== 'number' || typeof s.lon !== 'number');
}

function assertNoDuplicateRoutePoints(points: RoutePoint[], message: string): void {
	for (let i = 0; i < points.length; i++) {
		for (let j = i + 1; j < points.length; j++) {
			if (haversineKm(points[i].lat, points[i].lon, points[j].lat, points[j].lon) <= 0.03) {
				throw new RouteInputError(message);
			}
		}
	}
}

function unwrapStatus(result: DirectionsResult): DirectionsOk {
	switch (result.status) {
		case 'ok':
			return result;
		case 'no_route':
			throw new RouteInputError('No drivable route found.');
		case 'not_configured':
			throw new RouteUpstreamError('Routing is not configured on the server.', 503);
		case 'rate_limited':
			throw new RouteUpstreamError('Routing rate limit reached — try again shortly.', 429);
		case 'malformed':
			throw new RouteUpstreamError('Directions returned a malformed response.', 502);
		default:
			throw new RouteUpstreamError('Directions service failed.', 502);
	}
}

/**
 * Per-leg distances in the CURRENT stop order. Anchored plans are a closed
 * loop (anchor -> every stop -> anchor): n+1 wire legs, legs 0..n-1 attribute
 * to stops 0..n-1 and the final leg is the drive home. Unanchored plans stay
 * an open path (n-1 legs, leg i ends at stop i+1). Partial responses are
 * rejected, never reinterpreted (td-bf2909's hard rule).
 */
export async function planDrivingLegs(
	stops: RouteStopInput[],
	anchor: RoutePoint | null
): Promise<PlanDrivingLegs> {
	const located = locatedStops(stops);
	if (located.length !== stops.length) {
		throw new RouteInputError('Every stop needs coordinates to calculate driving legs.');
	}
	if (located.length < (anchor ? 1 : 2)) {
		throw new RouteInputError(
			anchor ? 'Need at least 1 stop with coordinates.' : 'Need at least 2 stops with coordinates.'
		);
	}
	assertNoDuplicateRoutePoints(
		anchor ? [anchor, ...located] : located,
		'Remove duplicate stops before calculating directions.'
	);

	const origin = anchor ?? located[0];
	const destination = anchor ?? located[located.length - 1];
	const intermediates = anchor ? located : located.slice(1, -1);
	// The 25-entry limit is on INTERMEDIATES, not stops: an unanchored path
	// of 27 stops carries 25 intermediates and is valid (peer CODEX,
	// round 1; https://developers.google.com/maps/documentation/routes/intermed_waypoints).
	if (intermediates.length > MAX_INTERMEDIATES) {
		throw new RouteInputError(
			`Too many stops to route in one request (max ${MAX_INTERMEDIATES} between the endpoints).`
		);
	}

	const result = unwrapStatus(
		await requestRouteCached(origin, destination, intermediates, false)
	);

	const expected = anchor ? located.length + 1 : located.length - 1;
	if (result.legs.length !== expected) {
		// Same known malformed-upstream condition as the optimize path — a
		// plain Error here would be sanitized to an opaque 500 at the
		// endpoint (peer CODEX, round 2).
		throw new RouteUpstreamError(
			`Directions returned ${result.legs.length} legs for ${located.length} stops; expected ${expected}.`,
			502
		);
	}

	const stopLegs = anchor ? result.legs.slice(0, -1) : result.legs;
	return {
		legs: stopLegs.map((leg, i) => ({ stopId: located[anchor ? i : i + 1].id, ...leg })),
		returnLeg: anchor ? result.legs[result.legs.length - 1] : null
	};
}

/**
 * Optimize stop order. An anchor is the fixed loop base; without one the
 * first located stop is held fixed. Stops without coordinates are appended in
 * their original order.
 */
export async function planOptimizedRoute(
	stops: RouteStopInput[],
	anchor: RoutePoint | null
): Promise<PlanOptimizeResult> {
	const located = locatedStops(stops);
	const unlocated = missingStops(stops);
	if (located.length < (anchor ? 2 : 3)) {
		throw new RouteInputError(
			anchor
				? 'Need at least 2 stops with coordinates to optimize.'
				: 'Need at least 3 stops with coordinates to optimize.'
		);
	}
	assertNoDuplicateRoutePoints(
		anchor ? [anchor, ...located] : located,
		'Remove duplicate stops before optimizing the route.'
	);

	const base = anchor ?? { lat: located[0].lat, lon: located[0].lon };
	const keptPrefix = anchor ? [] : [located[0]];
	const waypointStops = anchor ? located : located.slice(1);
	if (waypointStops.length > MAX_INTERMEDIATES) {
		throw new RouteInputError(
			`Too many stops to optimize in one request (max ${MAX_INTERMEDIATES} between the endpoints).`
		);
	}

	const result = unwrapStatus(await requestRouteCached(base, base, waypointStops, true));

	// The loop is base -> every waypoint -> base: exactly n+1 legs. A partial
	// optimized response must be rejected, not rendered as understated totals
	// (same fail-closed rule as planDrivingLegs; peer CODEX, round 1).
	const expected = waypointStops.length + 1;
	if (result.legs.length !== expected) {
		throw new RouteUpstreamError(
			`Directions returned ${result.legs.length} legs for ${waypointStops.length} waypoints; expected ${expected}.`,
			502
		);
	}
	// With optimizeWaypointOrder: true and the field mask requesting it, an
	// ABSENT optimizedIntermediateWaypointIndex is a malformed response, not
	// evidence of identity order — fail closed
	// (https://developers.google.com/maps/documentation/routes/opt-way).
	const order = result.optimizedOrder;
	if (
		!order ||
		order.length !== waypointStops.length ||
		new Set(order).size !== order.length ||
		order.some((i) => i < 0 || i >= waypointStops.length)
	) {
		throw new RouteUpstreamError('Directions returned an invalid optimized order.', 502);
	}
	const orderedWaypoints = order.map((i) => waypointStops[i]);

	return {
		orderedIds: [...keptPrefix, ...orderedWaypoints, ...unlocated].map((s) => s.id),
		totalKm: result.totalKm,
		totalMin: result.totalMin
	};
}
