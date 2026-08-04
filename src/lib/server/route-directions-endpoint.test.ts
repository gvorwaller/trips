import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({
	env: { GOOGLE_GEOCODING_KEY: 'test-routes-key' }
}));
vi.mock('$lib/db', () => ({
	query: vi.fn(async () => ({ rows: [], rowCount: 0 }))
}));

import { POST } from '../../routes/api/route/directions/+server';

/**
 * RequestHandler-boundary tests (peer CODEX, td-b580a8 round 1): helper-level
 * assertions are not enough, because SvelteKit sanitizes generic Errors into
 * opaque 500s — the contract that matters is what the HTTP client receives.
 * Malformed payloads that previously threw TypeErrors (→ 500) must be 400s,
 * and known upstream conditions must carry their own status + message.
 */

function event(body: unknown) {
	return {
		request: new Request('http://localhost/api/route/directions', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		}),
		locals: { ownerId: 1 }
	} as never;
}

const ANCHOR = { lat: 44.41, lon: -68.59 };
const STOPS = [
	{ id: 11, lat: 44.45, lon: -68.52 },
	{ id: 22, lat: 44.52, lon: -68.44 },
	{ id: 33, lat: 44.58, lon: -68.61 }
];

beforeEach(() => {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response('{}', { status: 200 }))
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('malformed payloads are 400s, never 500s', () => {
	const cases: Array<[string, unknown]> = [
		['null body', null],
		['array body', []],
		['missing mode', { stops: STOPS, anchor: null }],
		['bad mode', { mode: 'walk', stops: STOPS, anchor: null }],
		['null stop entry', { mode: 'legs', stops: [null, ...STOPS], anchor: ANCHOR }],
		['primitive stop entry', { mode: 'legs', stops: [7, ...STOPS], anchor: ANCHOR }],
		['string id', { mode: 'legs', stops: [{ id: '11', lat: 44.4, lon: -68.5 }], anchor: ANCHOR }],
		['boolean id', { mode: 'legs', stops: [{ id: true, lat: 44.4, lon: -68.5 }], anchor: ANCHOR }],
		[
			'string coordinate',
			{ mode: 'legs', stops: [{ id: 11, lat: '44.4', lon: -68.5 }], anchor: ANCHOR }
		],
		['out-of-range lat', { mode: 'legs', stops: [{ id: 11, lat: 91, lon: -68.5 }], anchor: ANCHOR }],
		['array anchor', { mode: 'legs', stops: STOPS, anchor: [44, -68] }],
		['string anchor coords', { mode: 'legs', stops: STOPS, anchor: { lat: '44', lon: -68 } }],
		['empty stops', { mode: 'legs', stops: [], anchor: ANCHOR }]
	];
	for (const [name, body] of cases) {
		it(`${name} → 400`, async () => {
			await expect(POST(event(body))).rejects.toMatchObject({ status: 400 });
		});
	}
});

describe('upstream statuses reach the client with real messages', () => {
	it('rate limit → 429 with the retry message', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('slow down', { status: 429 }))
		);
		await expect(
			POST(event({ mode: 'legs', stops: STOPS, anchor: ANCHOR }))
		).rejects.toMatchObject({
			status: 429,
			body: { message: expect.stringContaining('rate limit') }
		});
	});

	it('upstream failure → 502', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('boom', { status: 500 }))
		);
		await expect(
			POST(event({ mode: 'legs', stops: STOPS, anchor: ANCHOR }))
		).rejects.toMatchObject({ status: 502 });
	});

	it('no drivable route → 400 with the human message', async () => {
		// Empty body = unroutable, per the wire contract.
		await expect(
			POST(event({ mode: 'legs', stops: STOPS, anchor: ANCHOR }))
		).rejects.toMatchObject({
			status: 400,
			body: { message: 'No drivable route found.' }
		});
	});

	it('malformed wire legs are 502s — never laundered into zeroes or nulls', async () => {
		// Round 2 (peer CODEX): a provided-but-invalid duration or distance
		// must not become 0/NaN→null and get persisted as a routed number.
		const good = { distanceMeters: 8000, duration: '720s' };
		const wires: unknown[] = [
			{ routes: [{ legs: [good, { distanceMeters: 'bad', duration: '60s' }, good, good] }] },
			{ routes: [{ legs: [good, { distanceMeters: 9000, duration: 'bad' }, good, good] }] },
			{ routes: [{ legs: [good, { distanceMeters: -5, duration: '60s' }, good, good] }] },
			{ routes: [{ legs: 'not-an-array' }] },
			{ routes: [{ legs: [good, null, good, good] }] },
			{ routes: [{ legs: [good, good, good, good], duration: 'bad' }] }
		];
		for (const wire of wires) {
			vi.stubGlobal(
				'fetch',
				vi.fn(async () => new Response(JSON.stringify(wire), { status: 200 }))
			);
			await expect(
				POST(event({ mode: 'legs', stops: STOPS, anchor: ANCHOR }))
			).rejects.toMatchObject({
				status: 502,
				body: { message: expect.stringContaining('malformed') }
			});
		}
	});

	it('non-integer wire values are 502s: order indices and distanceMeters (round 3)', async () => {
		const good = { distanceMeters: 8000, duration: '720s' };
		const fourLegs = [good, good, good, good];
		const wires: unknown[] = [
			// String order members coerce through length/Set/range checks and
			// string-index real waypoints — malformed, not an order.
			{ routes: [{ legs: fourLegs, optimizedIntermediateWaypointIndex: ['2', '0', '1'] }] },
			// Fractional index maps to undefined and would crash as a 500.
			{ routes: [{ legs: fourLegs, optimizedIntermediateWaypointIndex: [0.5, 1, 2] }] },
			{ routes: [{ legs: fourLegs, optimizedIntermediateWaypointIndex: 'nope' }] }
		];
		for (const wire of wires) {
			vi.stubGlobal(
				'fetch',
				vi.fn(async () => new Response(JSON.stringify(wire), { status: 200 }))
			);
			await expect(
				POST(event({ mode: 'optimize', stops: STOPS, anchor: ANCHOR }))
			).rejects.toMatchObject({
				status: 502,
				body: { message: expect.stringContaining('malformed') }
			});
		}
		// distanceMeters is an INTEGER in Google's contract: fractional or
		// absurd provided values are malformed wire.
		for (const badDistance of [0.5, 1e100]) {
			vi.stubGlobal(
				'fetch',
				vi.fn(
					async () =>
						new Response(
							JSON.stringify({
								routes: [
									{ legs: [good, { distanceMeters: badDistance, duration: '60s' }, good, good] }
								]
							}),
							{ status: 200 }
						)
				)
			);
			await expect(
				POST(event({ mode: 'legs', stops: STOPS, anchor: ANCHOR }))
			).rejects.toMatchObject({
				status: 502,
				body: { message: expect.stringContaining('malformed') }
			});
		}
	});

	it('a fixed-order partial response is a classified 502, not a sanitized 500', async () => {
		const legFx = { distanceMeters: 8000, duration: '720s' };
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(JSON.stringify({ routes: [{ legs: [legFx, legFx] }] }), { status: 200 })
			)
		);
		await expect(
			POST(event({ mode: 'legs', stops: STOPS, anchor: ANCHOR }))
		).rejects.toMatchObject({
			status: 502,
			body: { message: expect.stringContaining('expected 4') }
		});
	});

	it('a valid request round-trips the plan legs', async () => {
		const legFx = (km: number, min: number) => ({
			distanceMeters: km * 1000,
			duration: `${min * 60}s`
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							routes: [{ legs: [legFx(8, 12), legFx(9, 14), legFx(11, 16), legFx(20, 25)] }]
						}),
						{ status: 200 }
					)
			)
		);
		const res = (await POST(event({ mode: 'legs', stops: STOPS, anchor: ANCHOR }))) as Response;
		const data = await res.json();
		expect(data.legs).toHaveLength(3);
		expect(data.returnLeg).toEqual({ km: 20, min: 25 });
	});
});
