import { randomUUID } from 'node:crypto';
import { env } from '$env/dynamic/private';
import type { ItineraryImportCandidate } from './itinerary-import';

const TIMEOUT_MS = 10_000;

export class BirdsPlacesError extends Error {}

type LogFields = Record<string, string | number | boolean | null | undefined>;

function logBirdsImport(level: 'info' | 'warn', event: string, fields: LogFields = {}) {
	console[level](
		`[birds-places-import] ${JSON.stringify({
			event,
			...fields
		})}`
	);
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export interface BirdsTripPlace {
	source: 'birds';
	source_id: string;
	birds_trip_id: number;
	birds_trip_name: string;
	birds_trip_start_date: string | null;
	birds_trip_end_date: string | null;
	stop_id: number;
	sort_order: number;
	name: string;
	lat: number;
	lon: number;
	google_place_id: string | null;
	hotspot_id: string | null;
	notes: string | null;
	field_tip: string | null;
	field_tip_generated_at: string | null;
	target_count_at_save: number | null;
}

function cleanString(value: unknown, max = 500): string | null {
	const text = typeof value === 'string' ? value.trim() : '';
	return text ? text.slice(0, max) : null;
}

function cleanNumber(value: unknown, min: number, max: number): number | null {
	const n = typeof value === 'number' && Number.isFinite(value) ? value : null;
	return n !== null && n >= min && n <= max ? n : null;
}

function parseBirdsPlace(value: unknown): BirdsTripPlace | null {
	if (value === null || typeof value !== 'object') return null;
	const row = value as Record<string, unknown>;
	const source = row.source === 'birds' ? 'birds' : null;
	const sourceId = cleanString(row.source_id, 300);
	const birdsTripId = cleanNumber(row.birds_trip_id, 1, Number.MAX_SAFE_INTEGER);
	const stopId = cleanNumber(row.stop_id, 1, Number.MAX_SAFE_INTEGER);
	const sortOrder = cleanNumber(row.sort_order, 0, Number.MAX_SAFE_INTEGER) ?? 0;
	const name = cleanString(row.name, 500);
	const lat = cleanNumber(row.lat, -90, 90);
	const lon = cleanNumber(row.lon, -180, 180);
	const tripName = cleanString(row.birds_trip_name, 500);
	if (!source || !sourceId || !birdsTripId || !stopId || !name || lat === null || lon === null || !tripName) {
		return null;
	}
	return {
		source,
		source_id: sourceId,
		birds_trip_id: birdsTripId,
		birds_trip_name: tripName,
		birds_trip_start_date: cleanString(row.birds_trip_start_date, 10),
		birds_trip_end_date: cleanString(row.birds_trip_end_date, 10),
		stop_id: stopId,
		sort_order: sortOrder,
		name,
		lat,
		lon,
		google_place_id: cleanString(row.google_place_id, 300),
		hotspot_id: cleanString(row.hotspot_id, 100),
		notes: cleanString(row.notes, 2000),
		field_tip: cleanString(row.field_tip, 2000),
		field_tip_generated_at: cleanString(row.field_tip_generated_at, 80),
		target_count_at_save: cleanNumber(row.target_count_at_save, 0, Number.MAX_SAFE_INTEGER)
	};
}

function tripDateText(place: BirdsTripPlace): string | null {
	if (place.birds_trip_start_date && place.birds_trip_end_date) {
		return `${place.birds_trip_start_date} to ${place.birds_trip_end_date}`;
	}
	return place.birds_trip_start_date ?? place.birds_trip_end_date;
}

function notesForBirdsPlace(place: BirdsTripPlace): string | null {
	const lines = [`Imported from Birds trip: ${place.birds_trip_name}`];
	const dates = tripDateText(place);
	if (dates) lines.push(`Birds trip dates: ${dates}`);
	if (place.notes) lines.push(place.notes);
	if (place.field_tip) lines.push(`Field tip: ${place.field_tip}`);
	if (place.hotspot_id) lines.push(`eBird hotspot: ${place.hotspot_id}`);
	if (place.target_count_at_save != null) {
		lines.push(`Targets at save: ${place.target_count_at_save}`);
	}
	return lines.join('\n');
}

export function birdsPlacesToItineraryCandidates(
	places: BirdsTripPlace[]
): ItineraryImportCandidate[] {
	return places.map((place) => ({
		item_type: 'place',
		title: place.name,
		// Only a genuine single-day trip pins a date on its places; for a
		// range we would be guessing which day, so leave null and let the
		// per-row date input in the review UI decide (td-2092b7).
		date:
			place.birds_trip_start_date &&
			place.birds_trip_start_date === place.birds_trip_end_date
				? place.birds_trip_start_date
				: null,
		notes: notesForBirdsPlace(place),
		external_url: null,
		address: null,
		location_query: null,
		lat: place.lat,
		lon: place.lon,
		place_id: place.google_place_id,
		apple_maps_place_id: null,
		meta: {
			source_app: 'birds',
			source_id: place.source_id,
			birds_trip_id: place.birds_trip_id,
			birds_stop_id: place.stop_id,
			birds_hotspot_id: place.hotspot_id,
			birds_trip_name: place.birds_trip_name
		},
		children: []
	}));
}

export interface BirdsTripSummary {
	id: number;
	name: string;
	start_date: string | null;
	end_date: string | null;
	placeCount: number;
}

/**
 * Derive the trip list from the places payload — every place already carries
 * its trip's id/name/dates, so grouping client-of-birds-side costs one pure
 * function and zero birds deploys (td-428a1d). Sorted by start date, newest
 * first; undated trips sink to the end.
 */
export function groupBirdsTrips(places: BirdsTripPlace[]): BirdsTripSummary[] {
	const byId = new Map<number, BirdsTripSummary>();
	for (const place of places) {
		const existing = byId.get(place.birds_trip_id);
		if (existing) {
			existing.placeCount += 1;
		} else {
			byId.set(place.birds_trip_id, {
				id: place.birds_trip_id,
				name: place.birds_trip_name,
				start_date: place.birds_trip_start_date,
				end_date: place.birds_trip_end_date,
				placeCount: 1
			});
		}
	}
	return [...byId.values()].sort((a, b) => {
		if (a.start_date && b.start_date) return b.start_date.localeCompare(a.start_date);
		if (a.start_date) return -1;
		if (b.start_date) return 1;
		return a.name.localeCompare(b.name);
	});
}

function configuredBaseUrl(): string {
	const base = env.BIRDS_API_BASE_URL?.trim();
	if (!base) throw new BirdsPlacesError('Birds import is not configured: BIRDS_API_BASE_URL is missing.');
	return base.replace(/\/+$/, '');
}

function configuredToken(): string {
	const token = env.BIRDS_API_TOKEN?.trim();
	if (!token) throw new BirdsPlacesError('Birds import is not configured: BIRDS_API_TOKEN is missing.');
	return token;
}

/** Birds caps `limit` at 5000; ask for the cap so `truncated` in the
 * response really means "more than the API can ever return in one call".
 * BIRDS_IMPORT_FETCH_LIMIT (test envs only) lowers it so the truncation
 * state machine is exercisable against a small fixture. */
function birdsFetchLimit(): number {
	const raw = Number(env.BIRDS_IMPORT_FETCH_LIMIT ?? '');
	return Number.isSafeInteger(raw) && raw >= 1 && raw <= 5000 ? raw : 5000;
}

/**
 * Parse the optional birds_trip_id form value. Absent/empty means "all
 * trips"; anything present must be a positive safe integer. Deliberately NOT
 * optId(): that helper maps invalid to null, and here null means an UNSCOPED
 * discovery — so a malformed id would silently fetch everything while the
 * client believes the request was scoped (peer CODEX, branch E round 2).
 */
export function parseBirdsTripIdParam(
	raw: unknown
): { id: number | null } | { error: string } {
	const s = (raw ?? '').toString().trim();
	if (!s) return { id: null };
	if (!/^\d+$/.test(s)) return { error: 'Birds trip id must be a positive integer.' };
	const n = Number(s);
	if (!Number.isSafeInteger(n) || n < 1) {
		return { error: 'Birds trip id must be a positive integer.' };
	}
	return { id: n };
}

export interface BirdsFetchResult {
	candidates: ItineraryImportCandidate[];
	trips: BirdsTripSummary[];
	truncated: boolean;
}

export async function fetchBirdsItineraryCandidates(options: {
	username?: string | null;
	tripId?: number | null;
} = {}): Promise<BirdsFetchResult> {
	const requestId = randomUUID();
	const started = Date.now();
	let baseUrl: string;
	let token: string;
	try {
		baseUrl = configuredBaseUrl();
		token = configuredToken();
	} catch (err) {
		logBirdsImport('warn', 'config_error', {
			request_id: requestId,
			duration_ms: Date.now() - started,
			error: errorText(err)
		});
		throw err;
	}

	const url = new URL(`${baseUrl}/api/internal/trip-places`);
	const username = options.username?.trim() || env.BIRDS_API_USERNAME?.trim();
	if (username) url.searchParams.set('username', username);
	if (options.tripId != null) url.searchParams.set('tripId', String(options.tripId));
	url.searchParams.set('limit', String(birdsFetchLimit()));
	logBirdsImport('info', 'fetch_start', {
		request_id: requestId,
		base_url: baseUrl,
		username: username || null,
		birds_trip_id: options.tripId ?? null
	});

	let res: Response;
	try {
		res = await fetch(url, {
			headers: {
				accept: 'application/json',
				authorization: `Bearer ${token}`,
				'x-trips-import-request-id': requestId
			},
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
	} catch (err) {
		logBirdsImport('warn', 'fetch_error', {
			request_id: requestId,
			duration_ms: Date.now() - started,
			error: errorText(err)
		});
		throw new BirdsPlacesError(
			err instanceof Error ? `Could not reach Birds: ${err.message}` : 'Could not reach Birds.'
		);
	}

	if (!res.ok) {
		let message = `Birds import failed with HTTP ${res.status}.`;
		try {
			const body = (await res.json()) as { error?: unknown };
			if (typeof body.error === 'string' && body.error.trim()) {
				message = body.error.trim();
			}
		} catch {
			/* keep status-based message */
		}
		logBirdsImport('warn', 'fetch_failure', {
			request_id: requestId,
			status: res.status,
			duration_ms: Date.now() - started,
			error: message
		});
		throw new BirdsPlacesError(message);
	}

	let body: unknown;
	try {
		body = await res.json();
	} catch {
		logBirdsImport('warn', 'invalid_json', {
			request_id: requestId,
			duration_ms: Date.now() - started
		});
		throw new BirdsPlacesError('Birds returned invalid JSON.');
	}
	const rawPlaces = Array.isArray((body as { places?: unknown }).places)
		? (body as { places: unknown[] }).places
		: null;
	if (!rawPlaces) {
		logBirdsImport('warn', 'invalid_payload', {
			request_id: requestId,
			duration_ms: Date.now() - started
		});
		throw new BirdsPlacesError('Birds returned an invalid places payload.');
	}
	const places = rawPlaces.map(parseBirdsPlace).filter((place): place is BirdsTripPlace => place !== null);
	const candidates = birdsPlacesToItineraryCandidates(places);
	const trips = groupBirdsTrips(places);
	const truncated = (body as { truncated?: unknown }).truncated === true;
	logBirdsImport('info', 'fetch_success', {
		request_id: requestId,
		status: res.status,
		raw_places: rawPlaces.length,
		accepted_places: places.length,
		candidates: candidates.length,
		trips: trips.length,
		truncated,
		dropped_places: rawPlaces.length - places.length,
		duration_ms: Date.now() - started
	});
	return { candidates, trips, truncated };
}
