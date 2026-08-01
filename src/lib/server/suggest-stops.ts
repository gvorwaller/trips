/**
 * Ranking for day-plan stop suggestions (td-65f48c).
 *
 * Candidates are ordered by how many minutes of driving they actually add to
 * the day, computed as cheapest insertion across every edge of the route using
 * real road times. The previous implementation measured straight-line distance
 * to the centroid of the route and never sorted at all, which on the Maine 2026
 * trip offered 64 candidates of which 51 cost more than 10 km of detour.
 *
 * Straight-line distance appears here only as a pre-filter to bound how many
 * points get sent for road scoring. It must never order the output: on a
 * winding coast the chord between two stops is not the road, so a place can be
 * far "off the chord" while sitting exactly on the drivable route.
 */
import {
	buildRoutePolyline,
	cheapestInsertion,
	detourFitKm,
	nearestVertexKm,
	type GeoPoint,
	type InsertionEdge
} from '$lib/route-detour';
import { computeRouteMatrixCached, type MatrixPoint } from '$server/route-matrix';

export interface RouteVertex extends GeoPoint {
	/** Label used for the "between X and Y" explanation. */
	title: string;
}

export interface SuggestCandidate {
	source: 'internal' | 'external';
	name: string;
	lat: number;
	lng: number;
	itinerary_item_id: number | null;
	place_id: string | null;
	vicinity: string | null;
	/** The place's own date, if it has one — drives the fixed-event tiebreak. */
	date: string | null;
	/** Title of another day plan already containing this place, if any. */
	scheduled_in: string | null;
}

export interface RankedSuggestion extends SuggestCandidate {
	/** Added driving minutes; null only when the road leg could not be priced. */
	added_min: number | null;
	added_km: number | null;
	/** Where it slots in, from the road-optimal edge (not the straight-line one). */
	edge_from: string;
	edge_to: string;
	/** True when this row fell back to straight-line scoring. */
	approximate: boolean;
	/** The place's date equals the plan's date — a fixed commitment for this day. */
	date_matches_plan: boolean;
}

export interface RankSuggestionsResult {
	/**
	 * Places dated for this exact day — fixed commitments (a market that only
	 * runs Saturday, a booked dinner) rather than suggestions. Surfaced as their
	 * own group so they cannot be missed, which is what the user actually wants
	 * place dates for. Kept out of `items` so the cost ordering stays clean.
	 */
	pinned: RankedSuggestion[];
	items: RankedSuggestion[];
	/** True when road times were unavailable and the whole list is straight-line. */
	approximate: boolean;
	/** How many candidates passed the budget before any display cap. */
	total: number;
}

/** Assumed average speed for converting a minutes budget into a km pre-filter bound. */
const ASSUMED_KMH = 60;
/**
 * Pre-filter headroom. Straight-line under-states road detour, so the bound must
 * be generous or the road stage never sees genuinely cheap candidates — the
 * failure that killed the earlier shortlist design.
 */
const PREFILTER_SLACK = 2.5;
/**
 * Candidates this close to a route vertex are the route itself — the anchor
 * lodging, or a duplicate row for a place already being visited. Matches
 * DUPLICATE_COORD_KM in dayplans.ts so the two agree on what "same location"
 * means. Without this the suggester cheerfully recommends your own hotel.
 */
const SAME_LOCATION_KM = 0.03;

function toMatrixPoints(points: GeoPoint[]): MatrixPoint[] {
	return points.map((p) => ({ lat: p.lat, lon: p.lon }));
}

/**
 * Order candidates for display.
 *
 * Sorts on the *displayed* whole-minute figure so the rendered list is always
 * monotonic. An earlier version bucketed minutes into 3-minute bands and broke
 * ties on relevance, which was defensible but produced a list reading
 * "+2min, +2min, +1min, +0min" — visually indistinguishable from the unsorted
 * output this task exists to fix. Relevance is expressed by pinning instead
 * (see `pinned` in RankSuggestionsResult), not by perturbing the cost order.
 *
 * Places already used in another day plan are deliberately NOT demoted: on this
 * trip cross-plan reuse is normal (one place appears in three plans), so plan
 * membership is surfaced as a badge rather than treated as a penalty.
 */
function compareSuggestions(a: RankedSuggestion, b: RankedSuggestion): number {
	const cost = (s: RankedSuggestion) => s.added_min ?? Number.POSITIVE_INFINITY;
	const byCost = cost(a) - cost(b);
	if (byCost !== 0) return byCost;

	const near = (s: RankedSuggestion) => s.added_km ?? Number.POSITIVE_INFINITY;
	const byDistance = near(a) - near(b);
	if (byDistance !== 0) return byDistance;

	return a.name.localeCompare(b.name);
}

/**
 * Rank candidates by added driving time against the plan's route.
 *
 * `stops` must already be in visiting order. When `anchor` is set the day is
 * treated as a loop that returns to it, matching optimizeDrivingRoute — without
 * that, the drive home is invisible and anything near it scores as though that
 * leg did not exist.
 */
export async function rankSuggestions(opts: {
	anchor: RouteVertex | null;
	stops: RouteVertex[];
	candidates: SuggestCandidate[];
	budgetMin: number;
	planDate: string | null;
}): Promise<RankSuggestionsResult> {
	const { anchor, stops, candidates, budgetMin, planDate } = opts;
	const route = buildRoutePolyline(anchor, stops) as RouteVertex[];
	const empty: RankSuggestionsResult = { pinned: [], items: [], approximate: false, total: 0 };
	if (route.length < 2 || candidates.length === 0) return empty;

	const budgetKm = (budgetMin / 60) * ASSUMED_KMH;
	const prefiltered = candidates
		// Drop anything sitting on the route already — the anchor lodging, or a
		// second row for a place being visited. Recommending your own hotel is
		// noise, and it also breaks the "between X and Y" explanation.
		.filter((c) => {
			const near = nearestVertexKm({ lat: c.lat, lon: c.lng }, route);
			return near === null || near > SAME_LOCATION_KM;
		})
		.map((c) => ({ candidate: c, fit: detourFitKm({ lat: c.lat, lon: c.lng }, route) }))
		.filter((row) => row.fit !== null && row.fit.added <= budgetKm * PREFILTER_SLACK);

	if (prefiltered.length === 0) return empty;

	const straightFallback = (): RankSuggestionsResult => {
		const items = prefiltered
			.map(({ candidate, fit }) => ({
				...candidate,
				added_min: null,
				added_km: fit ? Math.round(fit.added * 10) / 10 : null,
				edge_from: route[fit?.edgeIndex ?? 0]?.title ?? '',
				edge_to: route[(fit?.edgeIndex ?? 0) + 1]?.title ?? '',
				approximate: true,
				date_matches_plan: Boolean(planDate && candidate.date === planDate)
			}))
			.sort((a, b) => (a.added_km ?? Infinity) - (b.added_km ?? Infinity));
		return {
			pinned: items.filter((i) => i.date_matches_plan),
			items: items.filter((i) => !i.date_matches_plan),
			approximate: true,
			total: items.length
		};
	};

	const vertexPoints = toMatrixPoints(route);
	const candidatePoints = toMatrixPoints(
		prefiltered.map(({ candidate }) => ({ lat: candidate.lat, lon: candidate.lng }))
	);

	// Driving cost is directed, so both rectangular matrices are required; the
	// vertex-to-vertex matrix supplies the baseline legs we stop paying for.
	const [toCandidates, fromCandidates, baseline] = await Promise.all([
		computeRouteMatrixCached(vertexPoints, candidatePoints),
		computeRouteMatrixCached(candidatePoints, vertexPoints),
		computeRouteMatrixCached(vertexPoints, vertexPoints)
	]);

	if (
		toCandidates.status !== 'ok' ||
		fromCandidates.status !== 'ok' ||
		baseline.status !== 'ok'
	) {
		return straightFallback();
	}

	const items: RankedSuggestion[] = [];
	for (let j = 0; j < prefiltered.length; j++) {
		const { candidate, fit } = prefiltered[j];
		const edges: InsertionEdge[] = [];
		for (let i = 0; i < route.length - 1; i++) {
			edges.push({
				toC: toCandidates.matrix.seconds[i][j],
				fromC: fromCandidates.matrix.seconds[j][i + 1],
				base: baseline.matrix.seconds[i][i + 1]
			});
		}
		const roadFit = cheapestInsertion(edges);
		const metreEdges: InsertionEdge[] = edges.map((_, i) => ({
			toC: toCandidates.matrix.metres[i][j],
			fromC: fromCandidates.matrix.metres[j][i + 1],
			base: baseline.matrix.metres[i][i + 1]
		}));
		const roadKm = roadFit
			? metreEdges[roadFit.edgeIndex] &&
				metreEdges[roadFit.edgeIndex].toC !== null &&
				metreEdges[roadFit.edgeIndex].fromC !== null &&
				metreEdges[roadFit.edgeIndex].base !== null
				? Math.max(
						0,
						(metreEdges[roadFit.edgeIndex].toC! +
							metreEdges[roadFit.edgeIndex].fromC! -
							metreEdges[roadFit.edgeIndex].base!) /
							1000
					)
				: null
			: null;

		const edgeIndex = roadFit?.edgeIndex ?? fit?.edgeIndex ?? 0;
		items.push({
			...candidate,
			added_min: roadFit ? Math.round(roadFit.added / 60) : null,
			added_km: roadKm !== null ? Math.round(roadKm * 10) / 10 : null,
			edge_from: route[edgeIndex]?.title ?? '',
			edge_to: route[edgeIndex + 1]?.title ?? '',
			approximate: roadFit === null,
			date_matches_plan: Boolean(planDate && candidate.date === planDate)
		});
	}

	const withinBudget = items.filter((i) => i.added_min === null || i.added_min <= budgetMin);
	withinBudget.sort(compareSuggestions);
	return {
		pinned: withinBudget.filter((i) => i.date_matches_plan),
		items: withinBudget.filter((i) => !i.date_matches_plan),
		approximate: false,
		total: withinBudget.length
	};
}

export { nearestVertexKm };
