/**
 * Ask AI About This Place: a source-grounded Q&A helper distinct from
 * ai-notes.ts's day-plan visit notes (different prompt, different shape of
 * answer), but sharing the low-level Anthropic call in anthropic-client.ts.
 */
import { callClaude, AnthropicError } from './anthropic-client';
import type { PlaceDetails } from './place-details';
import { MAX_QUESTION_LENGTH } from '$lib/place-ai-shared';

export { AnthropicError, MAX_QUESTION_LENGTH };

const SYSTEM =
	'You are a trip-planning assistant answering one specific question about one place. ' +
	'Answer briefly and practically — a few sentences, not an essay. ' +
	'When relevant, make clear whether your answer draws on the known place details ' +
	'provided below (verified) versus general knowledge or the trip/item notes (unverified). ' +
	'Hedge uncertain claims ("likely", "typically", "probably"). ' +
	'Never invent exact hours, prices, ticket requirements, ferry schedules, train schedules, ' +
	'or closure information — if the provided facts do not answer the question, say plainly ' +
	'that it needs official-source verification instead of guessing. ' +
	'Respond in plain prose only — no markdown (no asterisks, headers, or bullet lists); ' +
	'the answer is rendered as plain text.';

// Deliberately excludes d.summary: Google's AI-generated overview is display-only
// context (per the plan), never fed to another AI as if it were a known fact.
function detailsBlock(d: PlaceDetails | null): string {
	if (!d) return 'No verified Google place details are available for this location.';
	const lines: string[] = [];
	if (d.formattedAddress) lines.push(`Address: ${d.formattedAddress}`);
	if (d.openingHoursWeekday?.length) {
		lines.push(`Hours (schedule, as of ${d.fetchedAt}):\n${d.openingHoursWeekday.join('\n')}`);
	}
	if (d.websiteUri) lines.push(`Website: ${d.websiteUri}`);
	if (d.phone) lines.push(`Phone: ${d.phone}`);
	if (d.businessStatus && d.businessStatus !== 'OPERATIONAL') {
		lines.push(`Business status: ${d.businessStatus}`);
	}
	if (d.rating != null) lines.push(`Rating: ${d.rating} (${d.userRatingCount ?? 0} ratings)`);
	if (lines.length === 0)
		return 'No verified Google place details are available beyond the coordinates.';
	return lines.join('\n');
}

export interface PlaceAiInput {
	tripName: string;
	tripDateRange: string | null;
	tripNotes: string | null;
	itemTitle: string;
	itemNotes: string | null;
	itemDate: string | null;
	lat: number | null;
	lon: number | null;
	placeId: string | null;
	appleMapsPlaceId: string | null;
	details: PlaceDetails | null;
	question: string;
}

export async function askAboutPlace(input: PlaceAiInput): Promise<string> {
	const providerIds = [
		input.placeId ? `Google place_id: ${input.placeId}` : null,
		input.appleMapsPlaceId ? `Apple Maps place id: ${input.appleMapsPlaceId}` : null
	].filter((l): l is string => l != null);

	const userText = [
		`Trip: ${input.tripName}${input.tripDateRange ? ` (${input.tripDateRange})` : ''}`,
		input.tripNotes ? `Trip notes: ${input.tripNotes}` : null,
		`Place: ${input.itemTitle}${input.itemDate ? ` — ${input.itemDate}` : ''}`,
		input.itemNotes ? `Place notes: ${input.itemNotes}` : null,
		input.lat != null && input.lon != null ? `Coordinates: ${input.lat}, ${input.lon}` : null,
		providerIds.length ? providerIds.join('\n') : null,
		'',
		'Known Google place details:',
		detailsBlock(input.details),
		'',
		`Question: ${input.question}`
	]
		.filter((line): line is string => line != null)
		.join('\n');

	return callClaude({ system: SYSTEM, userText, maxTokens: 600 });
}
