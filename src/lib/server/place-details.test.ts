import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();
vi.mock('$lib/db', () => ({
	query: (...args: unknown[]) => queryMock(...args)
}));

const envMock: { GOOGLE_GEOCODING_KEY?: string } = {};
vi.mock('$env/dynamic/private', () => ({ env: envMock }));

const { getPlaceDetails } = await import('./place-details');

function emptyCacheRow() {
	queryMock.mockResolvedValueOnce({ rows: [] });
}

// fetched_at is a real Date object here, not an ISO string — matching what
// node-postgres actually returns for a TIMESTAMPTZ column at runtime. Passing
// a pre-formatted string here would hide a regression back to using
// `row.fetched_at` raw instead of `new Date(row.fetched_at).toISOString()`.
function cacheRow(payload: Record<string, unknown>, fetchedAt: Date) {
	queryMock.mockResolvedValueOnce({ rows: [{ payload, fetched_at: fetchedAt }] });
}

const ISO_STRING_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

beforeEach(() => {
	queryMock.mockReset();
	envMock.GOOGLE_GEOCODING_KEY = 'test-key';
	vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('getPlaceDetails', () => {
	it('returns missing_place_id for empty/whitespace input', async () => {
		expect(await getPlaceDetails('')).toEqual({ status: 'missing_place_id' });
		expect(await getPlaceDetails('   ')).toEqual({ status: 'missing_place_id' });
		expect(await getPlaceDetails(null)).toEqual({ status: 'missing_place_id' });
		expect(queryMock).not.toHaveBeenCalled();
	});

	it('returns not_configured when the Google key is unset', async () => {
		envMock.GOOGLE_GEOCODING_KEY = '';
		const result = await getPlaceDetails('abc');
		expect(result).toEqual({ status: 'not_configured' });
		expect(queryMock).not.toHaveBeenCalled();
	});

	it('fetches and caches on a cold cache, using X-Goog-* headers not a query param key', async () => {
		emptyCacheRow();
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(
				JSON.stringify({ displayName: { text: 'Test Place' }, formattedAddress: '123 Main St' }),
				{ status: 200 }
			)
		);
		queryMock.mockResolvedValueOnce({ rows: [] });

		const result = await getPlaceDetails('abc');

		expect(result.status).toBe('ok');
		if (result.status === 'ok') {
			expect(result.details.name).toBe('Test Place');
			expect(result.details.stale).toBe(false);
		}
		const [url, init] = vi.mocked(fetch).mock.calls[0];
		expect(String(url)).toBe('https://places.googleapis.com/v1/places/abc');
		expect(String(url)).not.toContain('key=');
		expect((init?.headers as Record<string, string>)['X-Goog-Api-Key']).toBe('test-key');
		expect((init?.headers as Record<string, string>)['X-Goog-FieldMask']).toContain('displayName');
		expect((init?.headers as Record<string, string>)['X-Goog-FieldMask']).toContain(
			'generativeSummary'
		);
	});

	it('maps generativeSummary to summary/summaryDisclosure/summaryReportUri, using disclosureText not disclaimerText', async () => {
		emptyCacheRow();
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					displayName: { text: 'Empire State Building' },
					generativeSummary: {
						overview: { text: 'Famous Manhattan landmark with city views.' },
						overviewFlagContentUri: 'https://www.google.com/local/content/rap/report?postId=abc',
						disclosureText: { text: 'Summarized with Gemini' }
					}
				}),
				{ status: 200 }
			)
		);
		queryMock.mockResolvedValueOnce({ rows: [] });

		const result = await getPlaceDetails('abc');

		expect(result.status).toBe('ok');
		if (result.status === 'ok') {
			expect(result.details.summary).toBe('Famous Manhattan landmark with city views.');
			expect(result.details.summaryDisclosure).toBe('Summarized with Gemini');
			expect(result.details.summaryReportUri).toBe(
				'https://www.google.com/local/content/rap/report?postId=abc'
			);
		}
	});

	it('defaults summary fields to null when generativeSummary is absent (not every place has one)', async () => {
		emptyCacheRow();
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(JSON.stringify({ displayName: { text: 'Some Place' } }), { status: 200 })
		);
		queryMock.mockResolvedValueOnce({ rows: [] });

		const result = await getPlaceDetails('abc');

		expect(result.status).toBe('ok');
		if (result.status === 'ok') {
			expect(result.details.summary).toBeNull();
			expect(result.details.summaryDisclosure).toBeNull();
			expect(result.details.summaryReportUri).toBeNull();
		}
	});

	it('returns not_found on a 404', async () => {
		emptyCacheRow();
		vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 404 }));
		expect(await getPlaceDetails('abc')).toEqual({ status: 'not_found' });
	});

	it('returns rate_limited on a 429', async () => {
		emptyCacheRow();
		vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 429 }));
		expect(await getPlaceDetails('abc')).toEqual({ status: 'rate_limited' });
	});

	it('returns upstream_error on other non-ok statuses', async () => {
		emptyCacheRow();
		vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 500 }));
		expect(await getPlaceDetails('abc')).toEqual({ status: 'upstream_error' });
	});

	it('returns upstream_error on a network failure', async () => {
		emptyCacheRow();
		vi.mocked(fetch).mockRejectedValueOnce(new Error('network down'));
		expect(await getPlaceDetails('abc')).toEqual({ status: 'upstream_error' });
	});

	it('returns upstream_error on a malformed (non-JSON) payload', async () => {
		emptyCacheRow();
		vi.mocked(fetch).mockResolvedValueOnce(new Response('not json', { status: 200 }));
		expect(await getPlaceDetails('abc')).toEqual({ status: 'upstream_error' });
	});

	it('serves a fresh cache entry without calling fetch, formatting fetchedAt as an ISO string', async () => {
		cacheRow({ name: 'Cached Place' }, new Date());
		const result = await getPlaceDetails('abc');
		expect(fetch).not.toHaveBeenCalled();
		expect(result.status).toBe('ok');
		if (result.status === 'ok') {
			expect(result.details.name).toBe('Cached Place');
			expect(result.details.stale).toBe(false);
			expect(result.details.fetchedAt).toMatch(ISO_STRING_RE);
		}
	});

	it('falls back to stale cached data when a refetch hits an upstream error, formatting fetchedAt as an ISO string', async () => {
		const old = new Date(Date.now() - 100 * 60 * 60_000);
		cacheRow({ name: 'Old Cached Place' }, old);
		vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 500 }));

		const result = await getPlaceDetails('abc');

		expect(result.status).toBe('ok');
		if (result.status === 'ok') {
			expect(result.details.stale).toBe(true);
			expect(result.details.name).toBe('Old Cached Place');
			expect(result.details.fetchedAt).toMatch(ISO_STRING_RE);
			expect(result.details.fetchedAt).toBe(old.toISOString());
		}
	});

	it('does not fall back to stale data on a definitive not_found', async () => {
		const old = new Date(Date.now() - 100 * 60 * 60_000);
		cacheRow({ name: 'Old Cached Place' }, old);
		vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 404 }));

		expect(await getPlaceDetails('abc')).toEqual({ status: 'not_found' });
	});

	it('bypasses a fresh cache entry when forceRefresh is set', async () => {
		cacheRow({ name: 'Cached Place' }, new Date());
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(JSON.stringify({ displayName: { text: 'Fresh Place' } }), { status: 200 })
		);
		queryMock.mockResolvedValueOnce({ rows: [] });

		const result = await getPlaceDetails('abc', { forceRefresh: true });

		expect(fetch).toHaveBeenCalled();
		expect(result.status).toBe('ok');
		if (result.status === 'ok') expect(result.details.name).toBe('Fresh Place');
	});
});
