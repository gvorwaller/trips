import { callClaude, AnthropicError } from './anthropic-client';
import type { WeatherResult } from '$server/weather';

export { AnthropicError as AiNotesError };

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

	const text = await callClaude({ system: SYSTEM, userText, maxTokens: 1500 });

	let arr: { n: number; note: string }[];
	try {
		const start = text.indexOf('[');
		const end = text.lastIndexOf(']');
		if (start < 0 || end < 0) throw new Error('no array');
		arr = JSON.parse(text.slice(start, end + 1));
	} catch {
		throw new AnthropicError('The AI response could not be read — try again.');
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
