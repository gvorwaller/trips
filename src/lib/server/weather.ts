import { query } from '$lib/db';

const UA = 'trips.gaylon.photos trip planner (gaylon@vorwaller.net)';
const TTL_MIN = 60;

class WeatherUnavailable extends Error {}

export interface WeatherPeriod {
	name: string;
	startTime: string | null;
	endTime: string | null;
	isDaytime: boolean;
	tempF: number;
	precipPct: number | null;
	windSpeed: string;
	windDirection: string;
	shortForecast: string;
}

export interface WeatherResult {
	locationLabel: string | null;
	periods: WeatherPeriod[];
	stale: boolean;
	fetchedAt: string;
}

interface CachedPayload {
	label: string | null;
	periods: WeatherPeriod[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function fetchForecast(lat: number, lng: number): Promise<CachedPayload> {
	const headers = { 'User-Agent': UA, Accept: 'application/geo+json' };
	const pointsRes = await fetch(
		`https://api.weather.gov/points/${lat.toFixed(4)},${lng.toFixed(4)}`,
		{ headers, signal: AbortSignal.timeout(10000) }
	);
	if (pointsRes.status === 404) throw new WeatherUnavailable();
	if (!pointsRes.ok) throw new Error(`NWS points ${pointsRes.status}`);
	const pts = (await pointsRes.json()) as any;
	const forecastUrl: string | undefined = pts?.properties?.forecast;
	if (!forecastUrl) throw new Error('NWS points response missing forecast URL');
	const rel = pts?.properties?.relativeLocation?.properties;
	const label = rel?.city && rel?.state ? `${rel.city}, ${rel.state}` : null;

	const fRes = await fetch(forecastUrl, {
		headers,
		signal: AbortSignal.timeout(10000)
	});
	if (!fRes.ok) throw new Error(`NWS forecast ${fRes.status}`);
	const f = (await fRes.json()) as any;
	const periods: WeatherPeriod[] = (f?.properties?.periods ?? []).slice(0, 14).map((p: any) => ({
		name: String(p.name ?? ''),
		startTime: typeof p.startTime === 'string' ? p.startTime : null,
		endTime: typeof p.endTime === 'string' ? p.endTime : null,
		isDaytime: !!p.isDaytime,
		tempF: Number(p.temperature),
		precipPct: p.probabilityOfPrecipitation?.value ?? null,
		windSpeed: String(p.windSpeed ?? ''),
		windDirection: String(p.windDirection ?? ''),
		shortForecast: String(p.shortForecast ?? '')
	}));
	return { label, periods };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function weatherFor(lat: number, lng: number): Promise<WeatherResult | null> {
	const key = `weather:${lat.toFixed(3)}:${lng.toFixed(3)}`;
	const cached = await query<{ payload: CachedPayload; fetched_at: string }>(
		'SELECT payload, fetched_at FROM api_cache WHERE cache_key = $1',
		[key]
	);
	const row = cached.rows[0];
	const fresh = row && Date.now() - new Date(row.fetched_at).getTime() < TTL_MIN * 60_000;
	if (row && fresh) {
		return {
			locationLabel: row.payload.label,
			periods: row.payload.periods,
			stale: false,
			fetchedAt: new Date(row.fetched_at).toISOString()
		};
	}

	try {
		const data = await fetchForecast(lat, lng);
		await query(
			`INSERT INTO api_cache (cache_key, payload, fetched_at)
			 VALUES ($1, $2, NOW())
			 ON CONFLICT (cache_key) DO UPDATE SET payload = $2, fetched_at = NOW()`,
			[key, JSON.stringify(data)]
		);
		return {
			locationLabel: data.label,
			periods: data.periods,
			stale: false,
			fetchedAt: new Date().toISOString()
		};
	} catch (err) {
		if (err instanceof WeatherUnavailable) return null;
		if (row) {
			return {
				locationLabel: row.payload.label,
				periods: row.payload.periods,
				stale: true,
				fetchedAt: new Date(row.fetched_at).toISOString()
			};
		}
		return null;
	}
}
