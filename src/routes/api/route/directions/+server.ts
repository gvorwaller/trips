import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	planDrivingLegs,
	planOptimizedRoute,
	RouteInputError,
	RouteUpstreamError,
	type RouteStopInput
} from '$server/route-directions';

/**
 * Driving legs / route optimization for a set of points (td-b580a8): the
 * browser used to call the deprecated Maps JS DirectionsService directly;
 * routing now runs server-side through the Routes API v2 with api_cache in
 * front. POST, so viewers are blocked by hooks — matching the UI, which
 * hides the route tools from them. The payload is pure geometry the client
 * already holds; ownership checks are not needed beyond the login gate.
 *
 * Every malformed input is a 400 — null entries, coerced ids and wrong-type
 * coordinates were previously 500s or silent "unlocated" conversions (peer
 * CODEX, round 1). Known upstream conditions carry their own HTTP status via
 * RouteUpstreamError so the client sees the real message instead of a
 * SvelteKit-sanitized 500.
 */
const MAX_STOPS = 50;

function parseStops(raw: unknown): RouteStopInput[] {
	if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_STOPS) {
		throw error(400, 'stops must be a non-empty array.');
	}
	return raw.map((s) => {
		if (s === null || typeof s !== 'object' || Array.isArray(s)) {
			throw error(400, 'Every stop must be an object.');
		}
		const row = s as { id?: unknown; lat?: unknown; lon?: unknown };
		if (typeof row.id !== 'number' || !Number.isSafeInteger(row.id)) {
			throw error(400, 'Every stop needs an integer id.');
		}
		const coord = (v: unknown, name: string, min: number, max: number): number | null => {
			if (v === null || v === undefined) return null;
			if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
				throw error(400, `${name} must be a number in range or null.`);
			}
			return v;
		};
		return {
			id: row.id,
			lat: coord(row.lat, 'lat', -90, 90),
			lon: coord(row.lon, 'lon', -180, 180)
		};
	});
}

function parseAnchor(raw: unknown): { lat: number; lon: number } | null {
	if (raw === null || raw === undefined) return null;
	if (typeof raw !== 'object' || Array.isArray(raw)) {
		throw error(400, 'anchor must be {lat, lon} or null.');
	}
	const a = raw as { lat?: unknown; lon?: unknown };
	if (
		typeof a.lat !== 'number' ||
		!Number.isFinite(a.lat) ||
		a.lat < -90 ||
		a.lat > 90 ||
		typeof a.lon !== 'number' ||
		!Number.isFinite(a.lon) ||
		a.lon < -180 ||
		a.lon > 180
	) {
		throw error(400, 'anchor must be {lat, lon} or null.');
	}
	return { lat: a.lat, lon: a.lon };
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.ownerId) throw error(500, 'No owner configured');
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON');
	}
	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		throw error(400, 'Body must be an object.');
	}
	const { mode, stops: rawStops, anchor: rawAnchor } = body as {
		mode?: unknown;
		stops?: unknown;
		anchor?: unknown;
	};
	if (mode !== 'legs' && mode !== 'optimize') throw error(400, 'mode must be legs or optimize.');
	const stops = parseStops(rawStops);
	const anchor = parseAnchor(rawAnchor);

	try {
		if (mode === 'legs') {
			return json(await planDrivingLegs(stops, anchor));
		}
		return json(await planOptimizedRoute(stops, anchor));
	} catch (err) {
		if (err instanceof RouteInputError) throw error(400, err.message);
		if (err instanceof RouteUpstreamError) throw error(err.httpStatus, err.message);
		throw err;
	}
};
