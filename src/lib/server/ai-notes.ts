import { env } from '$env/dynamic/private';
import type { WeatherResult } from '$server/weather';

const MODEL = 'claude-sonnet-4-6';

export class AiNotesError extends Error {}

interface StopInput {
	id: number;
	name: string;
	notes: string | null;
}

const SYSTEM =
	'You are a trip planning assistant. Give short, practical, HEDGED suggestions ' +
	'a traveler can use when visiting each stop. Base advice on well-established ' +
	'knowledge about the place type (museum, park, restaurant, landmark, etc.): ' +
	'best time of day to visit, typical logistics (parking, crowds, tickets), ' +
	'seasonal tips, and weather-aware advice when weather data is provided. ' +
	'Never invent specific prices, hours, or facts you are unsure of. ' +
	'Keep each note to 1–3 sentences.';

function weatherBlock(w: WeatherResult | null): string {
	if (!w || w.periods.length === 0) return 'No weather data available.';
	return w.periods
		.map(
			(p) =>
				`${p.name}: ${p.tempF}°F, ${p.shortForecast}, wind ${p.windDirection} ${p.windSpeed}` +
				(p.precipPct != null ? `, ${p.precipPct}% precip` : '')
		)
		.join('\n');
}

export async function generateTripNotes(input: {
	tripName: string;
	stops: StopInput[];
	weather: WeatherResult | null;
	date: string | null;
}): Promise<Record<number, string>> {
	const apiKey = env.ANTHROPIC_API_KEY;
	if (!apiKey) throw new AiNotesError('AI notes are not configured (no API key set).');
	if (input.stops.length === 0) return {};

	const stopsText = input.stops
		.map((s, i) => `${i + 1}. ${s.name}${s.notes ? ` — ${s.notes}` : ''}`)
		.join('\n');

	const userText =
		`Trip: ${input.tripName}\n` +
		`Date: ${input.date ?? 'not specified'}\n\n` +
		`Weather near the trip:\n${weatherBlock(input.weather)}\n\n` +
		`Stops (in visit order):\n${stopsText}\n\n` +
		`For each stop, give ONE short visit note (1–3 sentences) with practical advice: ` +
		`best time of day, logistics, seasonal considerations, and how the weather might ` +
		`affect the visit. Hedge everything ("likely", "consider", "typically") — these ` +
		`are suggestions, not guarantees. If a stop has no clear type, give a brief ` +
		`general tip.\n\n` +
		`Respond with ONLY a JSON array, one object per stop in the same order: ` +
		`[{"n": <stop number>, "note": "<note>"}]. No text outside the JSON.`;

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
				model: MODEL,
				max_tokens: 1500,
				system: SYSTEM,
				messages: [{ role: 'user', content: userText }]
			}),
			signal: AbortSignal.timeout(30000)
		});
	} catch {
		throw new AiNotesError('Could not reach the AI service — try again shortly.');
	}

	if (res.status === 401) throw new AiNotesError('The AI API key is missing or invalid.');
	if (res.status === 429) throw new AiNotesError('AI service is rate-limited — try again shortly.');
	if (!res.ok) throw new AiNotesError(`AI service error (${res.status}).`);

	/* eslint-disable @typescript-eslint/no-explicit-any */
	const data = (await res.json()) as any;
	const text: string = (data.content ?? [])
		.filter((b: any) => b.type === 'text')
		.map((b: any) => b.text)
		.join('')
		.trim();
	/* eslint-enable @typescript-eslint/no-explicit-any */

	let arr: { n: number; note: string }[];
	try {
		const start = text.indexOf('[');
		const end = text.lastIndexOf(']');
		if (start < 0 || end < 0) throw new Error('no array');
		arr = JSON.parse(text.slice(start, end + 1));
	} catch {
		throw new AiNotesError('The AI response could not be read — try again.');
	}

	const out: Record<number, string> = {};
	for (const item of arr) {
		const idx = Number(item?.n) - 1;
		const stop = input.stops[idx];
		if (stop && typeof item?.note === 'string' && item.note.trim()) {
			out[stop.id] = item.note.trim();
		}
	}
	return out;
}
