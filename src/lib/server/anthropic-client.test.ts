import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const envMock: { ANTHROPIC_API_KEY?: string } = {};
vi.mock('$env/dynamic/private', () => ({ env: envMock }));

const { callClaude, AnthropicError } = await import('./anthropic-client');

function textResponse(text: string, status = 200) {
	return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status });
}

beforeEach(() => {
	envMock.ANTHROPIC_API_KEY = 'test-key';
	vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('callClaude', () => {
	it('throws AnthropicError when the API key is unset, without calling fetch', async () => {
		envMock.ANTHROPIC_API_KEY = '';
		await expect(callClaude({ system: 's', userText: 'u', maxTokens: 100 })).rejects.toThrow(
			AnthropicError
		);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('sends the api key as a header, not a query param', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(textResponse('hello'));
		await callClaude({ system: 'sys', userText: 'hi', maxTokens: 100 });
		const [url, init] = vi.mocked(fetch).mock.calls[0];
		expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
		expect((init?.headers as Record<string, string>)['x-api-key']).toBe('test-key');
	});

	it('joins text content blocks and trims the result', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					content: [
						{ type: 'text', text: '  hello ' },
						{ type: 'other', text: 'ignored' },
						{ type: 'text', text: 'world  ' }
					]
				}),
				{ status: 200 }
			)
		);
		const text = await callClaude({ system: 's', userText: 'u', maxTokens: 100 });
		expect(text).toBe('hello world');
	});

	it('throws AnthropicError on a 401', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(textResponse('', 401));
		await expect(callClaude({ system: 's', userText: 'u', maxTokens: 100 })).rejects.toThrow(
			AnthropicError
		);
	});

	it('throws AnthropicError on a 429', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(textResponse('', 429));
		await expect(callClaude({ system: 's', userText: 'u', maxTokens: 100 })).rejects.toThrow(
			AnthropicError
		);
	});

	it('throws AnthropicError on other non-ok statuses', async () => {
		vi.mocked(fetch).mockResolvedValueOnce(textResponse('', 500));
		await expect(callClaude({ system: 's', userText: 'u', maxTokens: 100 })).rejects.toThrow(
			AnthropicError
		);
	});

	it('throws AnthropicError on a network failure', async () => {
		vi.mocked(fetch).mockRejectedValueOnce(new Error('network down'));
		await expect(callClaude({ system: 's', userText: 'u', maxTokens: 100 })).rejects.toThrow(
			AnthropicError
		);
	});
});
