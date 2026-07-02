/**
 * Shared low-level Anthropic call: auth, timeout, and error-status mapping.
 * Callers own their own system prompt, user text, and response parsing —
 * see ai-notes.ts (day-plan visit notes) and place-ai.ts (Ask AI About This
 * Place) for the two current callers.
 */
import { env } from '$env/dynamic/private';

export const CLAUDE_MODEL = 'claude-sonnet-4-6';

export class AnthropicError extends Error {}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function callClaude(opts: {
	system: string;
	userText: string;
	maxTokens: number;
}): Promise<string> {
	const apiKey = env.ANTHROPIC_API_KEY;
	if (!apiKey) throw new AnthropicError('AI is not configured (no API key set).');

	let res: Response;
	try {
		res = await fetch('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			headers: {
				'x-api-key': apiKey,
				'anthropic-version': '2023-06-01',
				'content-type': 'application/json'
			},
			body: JSON.stringify({
				model: CLAUDE_MODEL,
				max_tokens: opts.maxTokens,
				system: opts.system,
				messages: [{ role: 'user', content: opts.userText }]
			}),
			signal: AbortSignal.timeout(30000)
		});
	} catch {
		throw new AnthropicError('Could not reach the AI service — try again shortly.');
	}

	if (res.status === 401) throw new AnthropicError('The AI API key is missing or invalid.');
	if (res.status === 429)
		throw new AnthropicError('AI service is rate-limited — try again shortly.');
	if (!res.ok) throw new AnthropicError(`AI service error (${res.status}).`);

	const data = (await res.json()) as any;
	return (data.content ?? [])
		.filter((b: any) => b.type === 'text')
		.map((b: any) => b.text)
		.join('')
		.trim();
}
/* eslint-enable @typescript-eslint/no-explicit-any */
