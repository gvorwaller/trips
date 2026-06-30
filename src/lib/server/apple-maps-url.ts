export interface ParsedAppleMapsUrl {
	lat: number;
	lng: number;
	name: string | null;
	address: string | null;
	placeQuery: string | null;
	appleMapsPlaceId: string | null;
}

const APPLE_MAPS_HOST_RE = /^(www\.)?maps\.apple\.com$/;
const COORD_KEYS = ['ll', 'sll', 'center', 'coordinate'];
const PLACE_ID_KEYS = ['auid', 'place-id', 'place_id', 'id'];

function parseCoordPair(s: string): { lat: number; lng: number } | null {
	const m = s.trim().match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/);
	if (!m) return null;
	const lat = Number(m[1]);
	const lng = Number(m[2]);
	if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
	return { lat, lng };
}

function cleanParam(v: string | null): string | null {
	const s = (v ?? '').trim();
	return s ? s.slice(0, 1000) : null;
}

function firstParam(url: URL, keys: string[]): string | null {
	for (const key of keys) {
		const v = cleanParam(url.searchParams.get(key));
		if (v) return v;
	}
	return null;
}

async function resolveAppleUrl(rawUrl: string): Promise<string | null> {
	for (const method of ['HEAD', 'GET'] as const) {
		try {
			const res = await fetch(rawUrl, {
				method,
				redirect: 'follow',
				signal: AbortSignal.timeout(8000)
			});
			if (res.url && res.url !== rawUrl) return res.url;
		} catch {
			/* try the next method */
		}
	}
	return null;
}

export function isAppleMapsUrl(text: string): boolean {
	try {
		const url = new URL(text.trim());
		return APPLE_MAPS_HOST_RE.test(url.hostname);
	} catch {
		return false;
	}
}

export async function parseAppleMapsUrl(rawUrl: string): Promise<ParsedAppleMapsUrl | null> {
	let url: URL;
	try {
		url = new URL(rawUrl.trim());
	} catch {
		return null;
	}
	if (!APPLE_MAPS_HOST_RE.test(url.hostname)) return null;

	if (url.pathname.startsWith('/p/')) {
		const resolved = await resolveAppleUrl(rawUrl.trim());
		if (resolved) {
			try {
				const resolvedUrl = new URL(resolved);
				if (APPLE_MAPS_HOST_RE.test(resolvedUrl.hostname)) url = resolvedUrl;
			} catch {
				/* keep the original URL */
			}
		}
	}

	const name = cleanParam(url.searchParams.get('q')) ?? cleanParam(url.searchParams.get('name'));
	const address = cleanParam(url.searchParams.get('address'));
	const appleMapsPlaceId = firstParam(url, PLACE_ID_KEYS);
	let coords: { lat: number; lng: number } | null = null;

	for (const key of COORD_KEYS) {
		const parsed = parseCoordPair(url.searchParams.get(key) ?? '');
		if (parsed) {
			coords = parsed;
			break;
		}
	}
	if (!coords) {
		const qCoords = parseCoordPair(url.searchParams.get('q') ?? '');
		if (qCoords) coords = qCoords;
	}

	const placeQuery = name ?? address;
	if (!coords && !placeQuery && !appleMapsPlaceId) return null;

	return {
		lat: coords?.lat ?? NaN,
		lng: coords?.lng ?? NaN,
		name,
		address,
		placeQuery,
		appleMapsPlaceId
	};
}
