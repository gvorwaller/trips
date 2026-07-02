import { beforeEach, describe, expect, it, vi } from 'vitest';

const callClaudeMock = vi.fn();
vi.mock('./anthropic-client', async () => {
	const actual = await vi.importActual<typeof import('./anthropic-client')>('./anthropic-client');
	return {
		...actual,
		callClaude: (...args: unknown[]) => callClaudeMock(...args)
	};
});

const { askAboutPlace, AnthropicError, MAX_QUESTION_LENGTH } = await import('./place-ai');

beforeEach(() => {
	callClaudeMock.mockReset();
});

const BASE_INPUT = {
	tripName: 'Maine 2026',
	tripDateRange: '2026-07-01 to 2026-07-10',
	tripNotes: null,
	itemTitle: 'Blue Hill Books',
	itemNotes: null,
	itemDate: null,
	lat: 44.5,
	lon: -68.5,
	placeId: 'abc123',
	appleMapsPlaceId: null,
	details: null,
	question: 'What should I know before visiting?'
};

describe('askAboutPlace', () => {
	it('re-exports AnthropicError from the shared client', async () => {
		const actual = await vi.importActual<typeof import('./anthropic-client')>('./anthropic-client');
		expect(AnthropicError).toBe(actual.AnthropicError);
	});

	it('includes trip/item context, provider ids, and the question in the prompt', async () => {
		callClaudeMock.mockResolvedValueOnce('an answer');
		const answer = await askAboutPlace(BASE_INPUT);
		expect(answer).toBe('an answer');

		const call = callClaudeMock.mock.calls[0][0];
		expect(call.userText).toContain('Maine 2026');
		expect(call.userText).toContain('Blue Hill Books');
		expect(call.userText).toContain('Google place_id: abc123');
		expect(call.userText).toContain('What should I know before visiting?');
	});

	it('says no verified details are available when details is null', async () => {
		callClaudeMock.mockResolvedValueOnce('answer');
		await askAboutPlace(BASE_INPUT);
		const call = callClaudeMock.mock.calls[0][0];
		expect(call.userText).toContain('No verified Google place details are available');
	});

	it('includes known place details (address, hours, no live open/closed status) when present', async () => {
		callClaudeMock.mockResolvedValueOnce('answer');
		await askAboutPlace({
			...BASE_INPUT,
			details: {
				name: 'Blue Hill Books',
				formattedAddress: '26 Pleasant St, Blue Hill, ME',
				lat: 44.5,
				lng: -68.5,
				googleMapsUri: null,
				websiteUri: 'https://example.com',
				phone: '555-1234',
				businessStatus: 'OPERATIONAL',
				types: [],
				rating: 4.8,
				userRatingCount: 42,
				openingHoursWeekday: ['Monday: 9am-5pm', 'Tuesday: 9am-5pm'],
				summary: null,
				summaryDisclosure: null,
				summaryReportUri: null,
				fetchedAt: '2026-07-01T12:00:00.000Z',
				stale: false
			}
		});
		const call = callClaudeMock.mock.calls[0][0];
		expect(call.userText).toContain('26 Pleasant St, Blue Hill, ME');
		expect(call.userText).toContain('Monday: 9am-5pm');
		expect(call.userText).toContain('https://example.com');
		expect(call.userText).not.toMatch(/open now/i);
	});

	it('does not feed Google\'s AI-generated summary into the prompt as a "known" fact', async () => {
		// Deliberate: the plan treats Google's summary as display-only context,
		// never as a factual source — feeding one AI's generated text into
		// another AI's prompt as "known" would blur that distinction.
		callClaudeMock.mockResolvedValueOnce('answer');
		await askAboutPlace({
			...BASE_INPUT,
			details: {
				name: 'Blue Hill Books',
				formattedAddress: null,
				lat: 44.5,
				lng: -68.5,
				googleMapsUri: null,
				websiteUri: null,
				phone: null,
				businessStatus: null,
				types: [],
				rating: null,
				userRatingCount: null,
				openingHoursWeekday: null,
				summary: 'A cozy independent bookshop with a curated selection and friendly staff.',
				summaryDisclosure: 'Summarized with Gemini',
				summaryReportUri: 'https://example.com/report',
				fetchedAt: '2026-07-01T12:00:00.000Z',
				stale: false
			}
		});
		const call = callClaudeMock.mock.calls[0][0];
		expect(call.userText).not.toContain('cozy independent bookshop');
	});

	it('propagates AnthropicError from callClaude', async () => {
		callClaudeMock.mockRejectedValueOnce(new AnthropicError('AI is not configured.'));
		await expect(askAboutPlace(BASE_INPUT)).rejects.toThrow(AnthropicError);
	});

	it('exports a 500-character question cap matching the plan', () => {
		expect(MAX_QUESTION_LENGTH).toBe(500);
	});
});
