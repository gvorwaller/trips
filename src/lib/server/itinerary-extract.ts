import { env } from '$env/dynamic/private';
import { ITEM_TYPES, type ItemType } from './itinerary';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const TIMEOUT_MS = 30_000;
const MAX_ITEMS = 200;
const MAX_DEPTH = 3;

const DEFAULT_MODEL = env.ANTHROPIC_ITINERARY_MODEL ?? 'claude-sonnet-4-6';

export interface ExtractedItineraryItem {
	item_type: ItemType;
	title: string;
	date: string | null;
	notes: string | null;
	external_url: string | null;
	address: string | null;
	location_query: string | null;
	lat: number | null;
	lon: number | null;
	children: ExtractedItineraryItem[];
}

export interface ItineraryExtractContext {
	tripName?: string;
	tripDates?: string;
	tripNotes?: string | null;
	existingTitles?: string[];
}

interface ToolUseContent {
	type: 'tool_use';
	name: string;
	input: { items: unknown[] };
}

const SUBMIT_TOOL = {
	name: 'submit_itinerary_candidates',
	description: 'Return candidate itinerary items extracted from rough trip text.',
	input_schema: {
		type: 'object',
		properties: {
			items: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						item_type: {
							type: 'string',
							enum: [...ITEM_TYPES],
							description: 'Best-fit type: place, note, day, or section.'
						},
						title: {
							type: 'string',
							description: 'Short readable title for the itinerary item.'
						},
						date: {
							type: ['string', 'null'],
							description: 'YYYY-MM-DD date if explicit, otherwise null.'
						},
						notes: {
							type: ['string', 'null'],
							description:
								'Brief descriptive text from the source. Do not put address here unless it is the only useful context.'
						},
						external_url: {
							type: ['string', 'null'],
							description: 'Relevant source/reference URL if present.'
						},
						address: {
							type: ['string', 'null'],
							description: 'Street address or precise location text if present.'
						},
						location_query: {
							type: ['string', 'null'],
							description:
								'Best geocoding query, including city/state/country from trip context when useful.'
						},
						lat: {
							type: ['number', 'null'],
							description: 'Latitude only if explicitly present in the source.'
						},
						lon: {
							type: ['number', 'null'],
							description: 'Longitude only if explicitly present in the source.'
						},
						children: {
							type: 'array',
							items: { type: 'object' },
							description:
								'Nested child items only when the source gives an obvious hierarchy. Prefer flat output for V1.'
						}
					},
					required: [
						'item_type',
						'title',
						'date',
						'notes',
						'external_url',
						'address',
						'location_query',
						'lat',
						'lon',
						'children'
					]
				}
			}
		},
		required: ['items']
	}
} as const;

const SYSTEM_PROMPT = `You extract candidate itinerary items from rough travel-planning text.

Return your answer ONLY by calling the submit_itinerary_candidates tool. Rules:
- Extract places, notes, explicit day headings, and explicit sections that would be useful in a trip itinerary.
- Be conservative. If the source is ambiguous, prefer fewer high-confidence items.
- V1 should usually be a flat list. Use children only when the source has an obvious tiny hierarchy.
- Preserve the source order.
- Do not invent attractions, dates, addresses, URLs, coordinates, or facts.
- Use item_type "place" for visitable locations, "note" for general reminders, "day" for explicit dated/day headings, and "section" for explicit grouping headings.
- Put brief descriptive source text in notes when useful.
- Keep addresses separate in address/location_query. Do not duplicate addresses in notes unless they are descriptive context too.
- Build location_query from the best available location text plus trip context when it helps geocoding.
- Use date as YYYY-MM-DD only when the source makes it clear.
- Return an empty array if there are no itinerary candidates.`;

type ContentBlock = { type: 'text'; text: string };

async function callExtractor(blocks: ContentBlock[]): Promise<ExtractedItineraryItem[] | null> {
	if (!env.ANTHROPIC_API_KEY) {
		console.warn('[itinerary-extract] ANTHROPIC_API_KEY not set - extraction disabled');
		return null;
	}
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(ANTHROPIC_API, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-api-key': env.ANTHROPIC_API_KEY,
				'anthropic-version': ANTHROPIC_VERSION
			},
			body: JSON.stringify({
				model: DEFAULT_MODEL,
				max_tokens: 6000,
				system: SYSTEM_PROMPT,
				tools: [SUBMIT_TOOL],
				tool_choice: { type: 'tool', name: 'submit_itinerary_candidates' },
				messages: [{ role: 'user', content: blocks }]
			}),
			signal: controller.signal
		});
		if (!res.ok) {
			const body = await res.text().catch(() => '');
			console.warn(`[itinerary-extract] Anthropic ${res.status}: ${body.slice(0, 300)}`);
			return null;
		}
		const json = (await res.json()) as { content: Array<ToolUseContent | { type: string }> };
		const tool = json.content.find(
			(c): c is ToolUseContent =>
				c.type === 'tool_use' && (c as ToolUseContent).name === 'submit_itinerary_candidates'
		);
		if (!tool) {
			console.warn('[itinerary-extract] no tool_use block in response');
			return null;
		}
		if (!Array.isArray(tool.input.items)) return [];
		const count = { n: 0 };
		return tool.input.items
			.map((raw) => normalizeItem(raw, 0, count))
			.filter((i): i is ExtractedItineraryItem => i !== null);
	} catch (err) {
		console.warn('[itinerary-extract] call failed:', err);
		return null;
	} finally {
		clearTimeout(timeoutId);
	}
}

function cleanString(v: unknown, max: number): string | null {
	const s = typeof v === 'string' ? v.trim() : '';
	return s ? s.slice(0, max) : null;
}

function cleanDate(v: unknown): string | null {
	const s = cleanString(v, 10);
	return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function cleanNumber(v: unknown, min: number, max: number): number | null {
	const n = typeof v === 'number' && Number.isFinite(v) ? v : null;
	return n !== null && n >= min && n <= max ? n : null;
}

function normalizeItem(raw: unknown, depth: number, count: { n: number }): ExtractedItineraryItem | null {
	if (count.n >= MAX_ITEMS || depth > MAX_DEPTH || raw === null || typeof raw !== 'object') return null;
	const obj = raw as Record<string, unknown>;
	const title = cleanString(obj.title, 500);
	if (!title) return null;
	const t = cleanString(obj.item_type, 20);
	const item_type = (ITEM_TYPES as readonly string[]).includes(t ?? '')
		? (t as ItemType)
		: 'place';
	count.n += 1;
	const rawChildren = Array.isArray(obj.children) ? obj.children : [];
	const children =
		depth >= MAX_DEPTH
			? []
			: rawChildren
					.map((child) => normalizeItem(child, depth + 1, count))
					.filter((i): i is ExtractedItineraryItem => i !== null);
	return {
		item_type,
		title,
		date: cleanDate(obj.date),
		notes: cleanString(obj.notes, 2000),
		external_url: cleanString(obj.external_url, 1000),
		address: cleanString(obj.address, 500),
		location_query: cleanString(obj.location_query, 500),
		lat: cleanNumber(obj.lat, -90, 90),
		lon: cleanNumber(obj.lon, -180, 180),
		children
	};
}

export function extractItineraryFromText(
	text: string,
	context: ItineraryExtractContext = {}
): Promise<ExtractedItineraryItem[] | null> {
	const trimmed = text.trim().slice(0, 50_000);
	if (!trimmed) return Promise.resolve(null);
	const ctx = [
		context.tripName ? `Trip name: ${context.tripName}` : null,
		context.tripDates ? `Trip dates: ${context.tripDates}` : null,
		context.tripNotes ? `Trip notes: ${context.tripNotes}` : null,
		context.existingTitles?.length
			? `Existing itinerary item titles, for duplicate awareness only:\n${context.existingTitles
					.slice(0, 250)
					.join('\n')}`
			: null
	]
		.filter(Boolean)
		.join('\n');
	return callExtractor([
		{
			type: 'text',
			text: `${ctx ? `${ctx}\n\n` : ''}Rough itinerary / place text:\n\n${trimmed}`
		}
	]);
}
