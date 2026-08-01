/**
 * Server-side driving matrices via Google Routes API v2 (td-65f48c).
 *
 * Day-plan suggestions rank by how much driving a candidate actually adds, and
 * straight-line distance cannot answer that on a coast where two points 5 km
 * apart across a bay are 45 km by road. This wraps computeRouteMatrix, which
 * returns every origin->destination pair in one call.
 *
 * Server-side rather than the browser Maps JS RouteMatrix class, deliberately:
 *  - it reuses GOOGLE_GEOCODING_KEY, already present and Routes-enabled;
 *  - results land in api_cache, and because TRAFFIC_UNAWARE durations are
 *    deterministic the TTL can be long, so repeat clicks cost nothing;
 *  - the suggest action can return one fully-ranked list instead of the client
 *    re-sorting asynchronously (which would visibly shuffle results).
 *
 * Response shape notes, verified against the live API on 2026-08-01:
 *  - the body is a bare JSON array, not an object wrapper;
 *  - entries arrive OUT OF ORDER, so they must be placed by originIndex /
 *    destinationIndex rather than by position;
 *  - distanceMeters is OMITTED when it would be 0 (e.g. a point to itself), so
 *    a missing field means zero, not "unroutable";
 *  - duration is a string with a trailing "s" ("1244s");
 *  - costs are asymmetric (A->B 1244s vs B->A 1234s), which is why callers need
 *    both rectangular matrices rather than assuming symmetry.
 */
import { createHash } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { query as dbQuery } from '$lib/db';

export interface MatrixPoint {
	lat: number;
	lon: number;
}

export interface RouteMatrix {
	/** seconds[originIndex][destIndex], null when no route exists. */
	seconds: (number | null)[][];
	/** metres[originIndex][destIndex], null when no route exists. */
	metres: (number | null)[][];
}

export type RouteMatrixResult =
	| { status: 'ok'; matrix: RouteMatrix }
	| { status: 'not_configured' | 'upstream_error' | 'rate_limited' };

/**
 * Google caps a non-traffic matrix at 625 elements. Chunk destinations so
 * origins x chunk stays under it; a 14-vertex route against 60 candidates would
 * otherwise be rejected outright rather than degrading.
 */
const MAX_ELEMENTS = 600;
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * TRAFFIC_UNAWARE durations depend only on the road network, not on when you
 * ask, so this can be far longer than the 1 h used for places/weather. Road
 * geometry changes on a scale of months; a week of staleness costs at most a
 * minute of estimate accuracy and removes essentially all repeat API spend.
 */
const CACHE_TTL_MS = 7 * 24 * 60 * 60_000;

interface MatrixElement {
	originIndex?: number;
	destinationIndex?: number;
	duration?: string;
	distanceMeters?: number;
	condition?: string;
	status?: { code?: number; message?: string };
}

/** "1244s" -> 1244. Returns null for anything unparseable. */
function parseDuration(raw: string | undefined): number | null {
	if (typeof raw !== 'string') return null;
	const m = /^(\d+(?:\.\d+)?)s$/.exec(raw.trim());
	if (!m) return null;
	const n = Number(m[1]);
	return Number.isFinite(n) ? n : null;
}

function emptyMatrix(rows: number, cols: number): RouteMatrix {
	return {
		seconds: Array.from({ length: rows }, () => Array<number | null>(cols).fill(null)),
		metres: Array.from({ length: rows }, () => Array<number | null>(cols).fill(null))
	};
}

const waypoint = (p: MatrixPoint) => ({
	waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lon } } }
});

async function requestChunk(
	apiKey: string,
	origins: MatrixPoint[],
	destinations: MatrixPoint[]
): Promise<MatrixElement[] | 'rate_limited' | 'error'> {
	let res: Response;
	try {
		res = await fetch('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Goog-Api-Key': apiKey,
				'X-Goog-FieldMask':
					'originIndex,destinationIndex,duration,distanceMeters,condition,status'
			},
			body: JSON.stringify({
				origins: origins.map(waypoint),
				destinations: destinations.map(waypoint),
				travelMode: 'DRIVE',
				routingPreference: 'TRAFFIC_UNAWARE'
			}),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		});
	} catch {
		return 'error';
	}
	if (res.status === 429) return 'rate_limited';
	if (!res.ok) return 'error';

	let data: unknown;
	try {
		data = await res.json();
	} catch {
		return 'error';
	}
	if (!Array.isArray(data)) return 'error';
	return data as MatrixElement[];
}

/**
 * Full origins x destinations driving matrix. Chunks destinations to respect
 * the element cap and assembles the result by index, never by arrival order.
 */
export async function computeRouteMatrix(
	origins: MatrixPoint[],
	destinations: MatrixPoint[]
): Promise<RouteMatrixResult> {
	const apiKey = env.GOOGLE_GEOCODING_KEY;
	if (!apiKey) return { status: 'not_configured' };
	if (origins.length === 0 || destinations.length === 0) {
		return { status: 'ok', matrix: emptyMatrix(origins.length, destinations.length) };
	}

	const matrix = emptyMatrix(origins.length, destinations.length);
	const chunkSize = Math.max(1, Math.floor(MAX_ELEMENTS / origins.length));

	for (let start = 0; start < destinations.length; start += chunkSize) {
		const slice = destinations.slice(start, start + chunkSize);
		const elements = await requestChunk(apiKey, origins, slice);
		if (elements === 'rate_limited') return { status: 'rate_limited' };
		if (elements === 'error') return { status: 'upstream_error' };

		for (const el of elements) {
			const o = el.originIndex;
			const d = el.destinationIndex;
			if (typeof o !== 'number' || typeof d !== 'number') continue;
			if (o < 0 || o >= origins.length || d < 0 || d >= slice.length) continue;
			// A non-empty status, or any condition other than ROUTE_EXISTS, means
			// this pair is genuinely unroutable — leave it null so cheapestInsertion
			// skips the edge instead of pricing it as free.
			if (el.condition && el.condition !== 'ROUTE_EXISTS') continue;
			if (el.status?.code) continue;
			const seconds = parseDuration(el.duration);
			if (seconds === null) continue;
			matrix.seconds[o][start + d] = seconds;
			// distanceMeters is omitted rather than sent as 0 for zero-length pairs.
			matrix.metres[o][start + d] = typeof el.distanceMeters === 'number' ? el.distanceMeters : 0;
		}
	}

	return { status: 'ok', matrix };
}

/**
 * Cache key over the exact point sets. Hashed rather than embedded: migration
 * 0012 established that api_cache keys must not carry user data in plaintext,
 * and a route's coordinates say where someone is going. Coordinates are fixed
 * to 6dp (~0.1 m) so float noise cannot cause spurious misses.
 */
function matrixCacheKey(origins: MatrixPoint[], destinations: MatrixPoint[]): string {
	const fmt = (pts: MatrixPoint[]) =>
		pts.map((p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`).join(';');
	const digest = createHash('sha256')
		.update(`${fmt(origins)}|${fmt(destinations)}|DRIVE|TRAFFIC_UNAWARE`)
		.digest('hex')
		.slice(0, 32);
	return `routematrix:${digest}`;
}

/** computeRouteMatrix behind api_cache. Only successful results are stored. */
export async function computeRouteMatrixCached(
	origins: MatrixPoint[],
	destinations: MatrixPoint[]
): Promise<RouteMatrixResult> {
	if (origins.length === 0 || destinations.length === 0) {
		return computeRouteMatrix(origins, destinations);
	}
	const key = matrixCacheKey(origins, destinations);
	const cached = await dbQuery<{ payload: RouteMatrix; fetched_at: string }>(
		'SELECT payload, fetched_at FROM api_cache WHERE cache_key = $1',
		[key]
	);
	const row = cached.rows[0];
	if (row && Date.now() - new Date(row.fetched_at).getTime() < CACHE_TTL_MS) {
		return { status: 'ok', matrix: row.payload };
	}

	const result = await computeRouteMatrix(origins, destinations);
	if (result.status === 'ok') {
		await dbQuery(
			`INSERT INTO api_cache (cache_key, payload, fetched_at)
			 VALUES ($1, $2, NOW())
			 ON CONFLICT (cache_key) DO UPDATE SET payload = $2, fetched_at = NOW()`,
			[key, JSON.stringify(result.matrix)]
		);
	}
	return result;
}
