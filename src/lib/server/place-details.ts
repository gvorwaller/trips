/**
 * Google Places API (New) "Place Details" lookup by itinerary_items.place_id,
 * cached in the shared api_cache table. This is a different Google product
 * than the legacy Places calls in geocode.ts (X-Goog-* headers instead of a
 * ?key= query param, HTTP status codes instead of a `status` JSON field) —
 * do not reuse geocode.ts's request/response conventions here.
 */
import { env } from '$env/dynamic/private';
import { query as dbQuery } from '$lib/db';

// Middle of the plan's 12-24h TTL window. Deliberately does not surface a
// live "open now" boolean (see openingHoursWeekday below) so a stale cache
// entry can't misreport whether a place is currently open.
const CACHE_TTL_MS = 18 * 60 * 60_000;

const FIELD_MASK = [
	'id',
	'displayName',
	'formattedAddress',
	'location',
	'googleMapsUri',
	'websiteUri',
	'nationalPhoneNumber',
	'businessStatus',
	'types',
	'rating',
	'userRatingCount',
	'currentOpeningHours',
	'regularOpeningHours',
	'generativeSummary'
].join(',');

interface CachedPayload {
	name: string | null;
	formattedAddress: string | null;
	lat: number | null;
	lng: number | null;
	googleMapsUri: string | null;
	websiteUri: string | null;
	phone: string | null;
	businessStatus: string | null;
	types: string[];
	rating: number | null;
	userRatingCount: number | null;
	openingHoursWeekday: string[] | null;
	// Google's AI-powered place summary (Enterprise + Atmosphere tier — same
	// tier already touched by rating/userRatingCount/hours, so no added
	// cost). Not available for every place (English only, US/India, certain
	// categories) — null means absent, not an error. Display requires the
	// disclosure text and report-content link per Google's summary policy;
	// see summaryDisclosure/summaryReportUri below.
	summary: string | null;
	summaryDisclosure: string | null;
	summaryReportUri: string | null;
}

export interface PlaceDetails extends CachedPayload {
	fetchedAt: string;
	stale: boolean;
}

export type PlaceDetailsResult =
	| { status: 'ok'; details: PlaceDetails }
	| { status: 'missing_place_id' }
	| { status: 'not_configured' }
	| { status: 'not_found' }
	| { status: 'rate_limited' }
	| { status: 'upstream_error' };

/* eslint-disable @typescript-eslint/no-explicit-any */
interface GooglePlaceDetailsResponse {
	displayName?: { text?: string };
	formattedAddress?: string;
	location?: { latitude?: number; longitude?: number };
	googleMapsUri?: string;
	websiteUri?: string;
	nationalPhoneNumber?: string;
	businessStatus?: string;
	types?: string[];
	rating?: number;
	userRatingCount?: number;
	currentOpeningHours?: { weekdayDescriptions?: string[] };
	regularOpeningHours?: { weekdayDescriptions?: string[] };
	generativeSummary?: {
		overview?: { text?: string };
		overviewFlagContentUri?: string;
		disclosureText?: { text?: string };
	};
}
/* eslint-enable @typescript-eslint/no-explicit-any */

type FetchResult =
	| { status: 'ok'; payload: CachedPayload }
	| { status: 'not_found' }
	| { status: 'rate_limited' }
	| { status: 'upstream_error' };

async function fetchPlaceDetails(placeId: string): Promise<FetchResult> {
	const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`;

	let res: Response;
	try {
		res = await fetch(url, {
			headers: {
				'X-Goog-Api-Key': env.GOOGLE_GEOCODING_KEY as string,
				'X-Goog-FieldMask': FIELD_MASK
			},
			signal: AbortSignal.timeout(10000)
		});
	} catch {
		return { status: 'upstream_error' };
	}
	if (res.status === 404) return { status: 'not_found' };
	if (res.status === 429) return { status: 'rate_limited' };
	if (!res.ok) return { status: 'upstream_error' };

	let data: GooglePlaceDetailsResponse;
	try {
		data = (await res.json()) as GooglePlaceDetailsResponse;
	} catch {
		return { status: 'upstream_error' };
	}

	const hours = data.currentOpeningHours ?? data.regularOpeningHours;
	return {
		status: 'ok',
		payload: {
			name: data.displayName?.text ?? null,
			formattedAddress: data.formattedAddress ?? null,
			lat: data.location?.latitude ?? null,
			lng: data.location?.longitude ?? null,
			googleMapsUri: data.googleMapsUri ?? null,
			websiteUri: data.websiteUri ?? null,
			phone: data.nationalPhoneNumber ?? null,
			businessStatus: data.businessStatus ?? null,
			types: data.types ?? [],
			rating: typeof data.rating === 'number' ? data.rating : null,
			userRatingCount: typeof data.userRatingCount === 'number' ? data.userRatingCount : null,
			openingHoursWeekday: hours?.weekdayDescriptions ?? null,
			summary: data.generativeSummary?.overview?.text ?? null,
			summaryDisclosure: data.generativeSummary?.disclosureText?.text ?? null,
			summaryReportUri: data.generativeSummary?.overviewFlagContentUri ?? null
		}
	};
}

/**
 * Fetch place details for `placeId`, serving from api_cache when fresh.
 * Pass `forceRefresh: true` for the Phase 4 "Refresh details" action —
 * this bypasses the cache-hit check and re-fetches-and-upserts rather than
 * deleting the row, matching the upsert-only convention used elsewhere
 * against api_cache (see weather.ts, geocode.ts).
 */
export async function getPlaceDetails(
	placeId: string | null | undefined,
	opts: { forceRefresh?: boolean } = {}
): Promise<PlaceDetailsResult> {
	const id = placeId?.trim();
	if (!id) return { status: 'missing_place_id' };
	if (!env.GOOGLE_GEOCODING_KEY) return { status: 'not_configured' };

	const cacheKey = `place-details:${id}:v1`;
	const cached = await dbQuery<{ payload: CachedPayload; fetched_at: string }>(
		'SELECT payload, fetched_at FROM api_cache WHERE cache_key = $1',
		[cacheKey]
	);
	const row = cached.rows[0];
	const fresh =
		row && !opts.forceRefresh && Date.now() - new Date(row.fetched_at).getTime() < CACHE_TTL_MS;
	if (row && fresh) {
		return {
			status: 'ok',
			details: { ...row.payload, fetchedAt: new Date(row.fetched_at).toISOString(), stale: false }
		};
	}

	const result = await fetchPlaceDetails(id);
	if (result.status === 'ok') {
		await dbQuery(
			`INSERT INTO api_cache (cache_key, payload, fetched_at)
			 VALUES ($1, $2, NOW())
			 ON CONFLICT (cache_key) DO UPDATE SET payload = $2, fetched_at = NOW()`,
			[cacheKey, JSON.stringify(result.payload)]
		);
		return {
			status: 'ok',
			details: { ...result.payload, fetchedAt: new Date().toISOString(), stale: false }
		};
	}

	// Rate limit / upstream errors: serve stale cached data if we have it,
	// mirroring weatherFor()'s stale-fallback. A definitive not_found is not
	// retried this way — it means the place_id itself is gone, not that the
	// request failed transiently.
	if (row && (result.status === 'rate_limited' || result.status === 'upstream_error')) {
		return {
			status: 'ok',
			details: { ...row.payload, fetchedAt: new Date(row.fetched_at).toISOString(), stale: true }
		};
	}
	return result;
}
