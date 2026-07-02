import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();
vi.mock('$lib/db', () => ({
	query: (...args: unknown[]) => queryMock(...args)
}));

const envMock: { GOOGLE_GEOCODING_KEY?: string } = {};
vi.mock('$env/dynamic/private', () => ({ env: envMock }));

const { placesTextSearchCached } = await import('./geocode');

function textSearchResponse(results: unknown[]) {
	return new Response(JSON.stringify({ status: results.length ? 'OK' : 'ZERO_RESULTS', results }), {
		status: 200
	});
}

beforeEach(() => {
	queryMock.mockReset();
	envMock.GOOGLE_GEOCODING_KEY = 'test-key';
	vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('placesTextSearchCached', () => {
	// This wraps placesTextSearch, which the place workspace's resolve-candidate
	// flow previously called uncached on every page load — a live Google request
	// per view instead of per distinct place. This locks the fix in place.
	it('fetches and caches on a cold cache', async () => {
		queryMock.mockResolvedValueOnce({ rows: [] }); // cache read: miss
		vi.mocked(fetch).mockResolvedValueOnce(
			textSearchResponse([
				{
					name: 'Downeast Scenic Railroad',
					place_id: 'abc123',
					geometry: { location: { lat: 44.5, lng: -68.5 } }
				}
			])
		);
		queryMock.mockResolvedValueOnce({ rows: [] }); // cache write

		const result = await placesTextSearchCached('Downeast Scenic Railroad', {
			lat: 44.5,
			lng: -68.5,
			radiusM: 200
		});

		expect(result?.place_id).toBe('abc123');
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(queryMock).toHaveBeenCalledTimes(2);
	});

	it('serves a fresh cache entry without calling fetch again', async () => {
		const cachedResult = {
			name: 'Downeast Scenic Railroad',
			place_id: 'abc123',
			lat: 44.5,
			lng: -68.5,
			bounds: null
		};
		queryMock.mockResolvedValueOnce({
			rows: [{ payload: cachedResult, fetched_at: new Date() }]
		});

		const result = await placesTextSearchCached('Downeast Scenic Railroad', {
			lat: 44.5,
			lng: -68.5,
			radiusM: 200
		});

		expect(result).toEqual(cachedResult);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('re-fetches once the cache entry is older than an hour', async () => {
		const old = new Date(Date.now() - 90 * 60_000);
		queryMock.mockResolvedValueOnce({
			rows: [
				{
					payload: { name: 'Stale Result', place_id: 'old', lat: 0, lng: 0, bounds: null },
					fetched_at: old
				}
			]
		});
		vi.mocked(fetch).mockResolvedValueOnce(
			textSearchResponse([
				{ name: 'Fresh Result', place_id: 'new', geometry: { location: { lat: 44.5, lng: -68.5 } } }
			])
		);
		queryMock.mockResolvedValueOnce({ rows: [] });

		const result = await placesTextSearchCached('Downeast Scenic Railroad', {
			lat: 44.5,
			lng: -68.5,
			radiusM: 200
		});

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(result?.place_id).toBe('new');
	});
});
