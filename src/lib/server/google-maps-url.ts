import { reverseGeocode } from './geocode';

export interface ParsedMapsUrl {
	lat: number;
	lng: number;
	name: string | null;
	placeQuery: string | null;
}

const MAPS_HOST_RE = /^(www\.)?google\.(com|[a-z]{2,3}(\.[a-z]{2})?)$/;
const SHORT_HOST_RE = /^(maps\.app\.goo\.gl|goo\.gl)$/;

function parseCoordPair(s: string): { lat: number; lng: number } | null {
	const m = s.match(/^(-?\d+(?:\.\d+)),(-?\d+(?:\.\d+))$/);
	if (!m) return null;
	const lat = Number(m[1]);
	const lng = Number(m[2]);
	if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
	return { lat, lng };
}

function decodePlaceName(encoded: string): string {
	return decodeURIComponent(encoded.replace(/\+/g, ' '));
}

function extractFromFullUrl(url: URL): Omit<ParsedMapsUrl, 'name'> & { rawName: string | null } {
	const path = url.pathname;

	// /maps/place/Place+Name/@lat,lng,zoom...
	const placeAt = path.match(/\/maps\/place\/([^/@]+)\/@(-?\d+(?:\.\d+)),(-?\d+(?:\.\d+))/);
	if (placeAt) {
		const lat = Number(placeAt[2]);
		const lng = Number(placeAt[3]);
		if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
			return { lat, lng, rawName: decodePlaceName(placeAt[1]), placeQuery: null };
		}
	}

	// /maps/place/Place+Name/... (no @ coordinates but place name present)
	const placeOnly = path.match(/\/maps\/place\/([^/@]+)/);

	// /maps/@lat,lng,zoom...
	const atCoords = path.match(/\/maps\/@(-?\d+(?:\.\d+)),(-?\d+(?:\.\d+))/);
	if (atCoords) {
		const lat = Number(atCoords[1]);
		const lng = Number(atCoords[2]);
		if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
			return {
				lat,
				lng,
				rawName: placeOnly ? decodePlaceName(placeOnly[1]) : null,
				placeQuery: null
			};
		}
	}

	// ?q=lat,lng or ?ll=lat,lng
	for (const key of ['q', 'll']) {
		const val = url.searchParams.get(key);
		if (val) {
			const coords = parseCoordPair(val.split('(')[0].trim());
			if (coords) {
				return {
					...coords,
					rawName: placeOnly ? decodePlaceName(placeOnly[1]) : null,
					placeQuery: null
				};
			}
		}
	}

	// ?q=SearchQuery (no coords) — return as placeQuery for geocoding
	const q = url.searchParams.get('q');
	if (q && q.trim()) {
		return { lat: NaN, lng: NaN, rawName: null, placeQuery: q.trim() };
	}

	// /maps/place/Name with no coords at all — name becomes geocoding query
	if (placeOnly) {
		const name = decodePlaceName(placeOnly[1]);
		return { lat: NaN, lng: NaN, rawName: name, placeQuery: name };
	}

	return { lat: NaN, lng: NaN, rawName: null, placeQuery: null };
}

async function resolveShortUrl(shortUrl: string): Promise<string | null> {
	try {
		const res = await fetch(shortUrl, {
			method: 'HEAD',
			redirect: 'follow',
			signal: AbortSignal.timeout(8000)
		});
		const final = res.url;
		if (final && final !== shortUrl) return final;
	} catch { /* fallback: try GET */ }
	try {
		const res = await fetch(shortUrl, {
			redirect: 'follow',
			signal: AbortSignal.timeout(8000)
		});
		if (res.url && res.url !== shortUrl) return res.url;
	} catch { /* give up */ }
	return null;
}

export function isGoogleMapsUrl(text: string): boolean {
	const trimmed = text.trim();
	try {
		const url = new URL(trimmed);
		if (SHORT_HOST_RE.test(url.hostname)) return true;
		if (!MAPS_HOST_RE.test(url.hostname)) return false;
		return url.pathname.startsWith('/maps');
	} catch {
		return false;
	}
}

export async function parseGoogleMapsUrl(rawUrl: string): Promise<ParsedMapsUrl | null> {
	const trimmed = rawUrl.trim();
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return null;
	}

	// Resolve shortened URLs
	if (SHORT_HOST_RE.test(url.hostname)) {
		const resolved = await resolveShortUrl(trimmed);
		if (!resolved) return null;
		try {
			url = new URL(resolved);
		} catch {
			return null;
		}
	}

	if (!MAPS_HOST_RE.test(url.hostname) && !url.hostname.includes('google')) return null;

	const parsed = extractFromFullUrl(url);

	// If we got valid coordinates, use them
	if (Number.isFinite(parsed.lat) && Number.isFinite(parsed.lng)) {
		let name = parsed.rawName;
		if (!name) {
			name = await reverseGeocode(parsed.lat, parsed.lng);
		}
		return { lat: parsed.lat, lng: parsed.lng, name, placeQuery: null };
	}

	// No coords but have a search query — caller should geocode
	if (parsed.placeQuery) {
		return { lat: NaN, lng: NaN, name: parsed.rawName, placeQuery: parsed.placeQuery };
	}

	return null;
}
