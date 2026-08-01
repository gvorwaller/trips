/**
 * Cheapest-insertion detour scoring for day-plan stop suggestions (td-65f48c).
 *
 * A candidate place is worth suggesting when adding it to the day costs little
 * extra driving — not when it happens to sit near the middle of the route. The
 * cost of inserting candidate C into the edge P_i -> P_i+1 is
 *
 *     cost(P_i -> C) + cost(C -> P_i+1) - cost(P_i -> P_i+1)
 *
 * minimised over every edge. That single number covers all three shapes the
 * user asked for: a place extending the route outward slots cheaply onto a
 * terminal edge, a small sideways detour costs about twice the offset, and a
 * place that fits the loop costs near zero.
 *
 * `cheapestInsertion` is cost-unit agnostic on purpose: the server prefilters
 * with Haversine kilometres and then ranks with real road minutes from the
 * Routes API, using the same argmin logic for both. Keeping it pure keeps that
 * shared core testable without touching Google.
 */

export interface GeoPoint {
	lat: number;
	lon: number;
}

export interface InsertionEdge {
	/** Cost from the edge's start vertex to the candidate. */
	toC: number | null;
	/** Cost from the candidate to the edge's end vertex. */
	fromC: number | null;
	/** Existing cost of the edge, i.e. what we'd stop paying by detouring. */
	base: number | null;
}

export interface InsertionFit {
	/** Extra cost added by inserting at the cheapest edge, never below zero. */
	added: number;
	/** Index of that edge; edge i joins route[i] -> route[i + 1]. */
	edgeIndex: number;
}

const EARTH_KM = 6371;
const toRad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in km. Duplicated from $lib/geo to keep this module dependency-free. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const dLat = toRad(lat2 - lat1);
	const dLon = toRad(lon2 - lon1);
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
	return 2 * EARTH_KM * Math.asin(Math.sqrt(a));
}

/**
 * The day's route as an ordered polyline.
 *
 * When the plan has an anchor (a lodging or start place) the day both starts
 * and ends there, so the polyline closes back to it — matching how
 * optimizeDrivingRoute already models an anchored day (src/lib/route.ts). This
 * matters: leaving it open makes the drive home invisible, so anything near the
 * return leg scores as though that drive did not exist.
 */
export function buildRoutePolyline(anchor: GeoPoint | null, stops: GeoPoint[]): GeoPoint[] {
	if (!anchor) return [...stops];
	return [anchor, ...stops, anchor];
}

/**
 * Cheapest insertion across a set of candidate edges.
 *
 * Returns null when no edge is fully priced — a caller that cannot route to or
 * from a candidate has no honest cost to report and should surface that rather
 * than guess. Negative results are clamped to 0: a detour can never genuinely
 * shorten the drive, and a small negative is triangle-inequality noise in the
 * road data, not a shortcut worth advertising.
 */
export function cheapestInsertion(edges: InsertionEdge[]): InsertionFit | null {
	let best: InsertionFit | null = null;
	for (let i = 0; i < edges.length; i++) {
		const { toC, fromC, base } = edges[i];
		if (toC === null || fromC === null || base === null) continue;
		if (!Number.isFinite(toC) || !Number.isFinite(fromC) || !Number.isFinite(base)) continue;
		const added = Math.max(0, toC + fromC - base);
		if (!best || added < best.added) best = { added, edgeIndex: i };
	}
	return best;
}

/**
 * Straight-line detour cost, used only to bound how many candidates get sent
 * for road scoring. Never use this to order results: on a winding coast the
 * chord between two stops is not the road, so a place can be "off the chord"
 * while sitting exactly on the drivable route.
 */
export function detourFitKm(candidate: GeoPoint, route: GeoPoint[]): InsertionFit | null {
	if (route.length < 2) return null;
	const edges: InsertionEdge[] = [];
	for (let i = 0; i < route.length - 1; i++) {
		const a = route[i];
		const b = route[i + 1];
		edges.push({
			toC: haversineKm(a.lat, a.lon, candidate.lat, candidate.lon),
			fromC: haversineKm(candidate.lat, candidate.lon, b.lat, b.lon),
			base: haversineKm(a.lat, a.lon, b.lat, b.lon)
		});
	}
	return cheapestInsertion(edges);
}

/** Nearest straight-line distance from a candidate to any route vertex. */
export function nearestVertexKm(candidate: GeoPoint, route: GeoPoint[]): number | null {
	let best: number | null = null;
	for (const p of route) {
		const km = haversineKm(p.lat, p.lon, candidate.lat, candidate.lon);
		if (best === null || km < best) best = km;
	}
	return best;
}
