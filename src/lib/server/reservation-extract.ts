import { env } from '$env/dynamic/private';
import { RESERVATION_TYPES, type ReservationType } from './reservations';
import { getAttachmentSource } from './attachments';
import { getObjectBuffer } from './storage';

/**
 * Reservation extraction (td-3a0e29): turn a pasted confirmation email or an
 * uploaded document (PDF/image) into structured reservation fields, so the Add
 * Reservation form can be pre-filled for human review instead of hand-typed.
 *
 * Mirrors giftlist's llm-matcher: raw fetch to the Anthropic Messages API (no
 * SDK dependency), key from $env/dynamic/private, structured output forced via
 * tool_use (never parsed from prose), graceful null on missing key / API error
 * so the form just stays blank and the user types it in.
 *
 * This NEVER creates a reservation — it only returns candidate fields. The
 * caller pre-fills the form; the human reviews and saves. Extraction is not
 * 100% reliable, so it is explicitly not allowed to auto-commit.
 */

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const TIMEOUT_MS = 30_000;

/** Default model. Override via env for cost/quality experiments. */
const DEFAULT_MODEL = env.ANTHROPIC_RESERVATION_MODEL ?? 'claude-opus-4-7';

/** Image/PDF media types Claude can read; matches the upload whitelist. */
const VISION_MIME = new Set([
	'application/pdf',
	'image/jpeg',
	'image/png',
	'image/webp',
	'image/gif',
	'image/heic',
	'image/heif'
]);

export interface ExtractedReservation {
	reservation_type: ReservationType | null;
	title: string | null;
	confirmation_code: string | null;
	status: string | null;
	/** Local wall-clock, YYYY-MM-DDTHH:MM (matches the datetime-local input). */
	start_at: string | null;
	end_at: string | null;
	notes: string | null;
}

interface ToolUseContent {
	type: 'tool_use';
	name: string;
	input: ExtractedReservation;
}

const SUBMIT_TOOL = {
	name: 'submit_reservation',
	description: 'Return the structured reservation details extracted from the source.',
	input_schema: {
		type: 'object',
		properties: {
			reservation_type: {
				type: ['string', 'null'],
				enum: [...RESERVATION_TYPES, null],
				description: 'Best-fit category, or null if unclear.'
			},
			title: {
				type: ['string', 'null'],
				description: 'Short human label, e.g. the hotel/airline/restaurant name.'
			},
			confirmation_code: { type: ['string', 'null'] },
			status: {
				type: ['string', 'null'],
				description: 'e.g. Confirmed, Cancelled, Pending — only if stated.'
			},
			start_at: {
				type: ['string', 'null'],
				description:
					'Check-in / departure / start, as YYYY-MM-DDTHH:MM (24h, local to the venue, no timezone). Null if unknown. Use 00:00 if only a date is given.'
			},
			end_at: {
				type: ['string', 'null'],
				description: 'Check-out / arrival / end, same format. Null if unknown.'
			},
			notes: {
				type: ['string', 'null'],
				description: 'Any other useful details (room type, seats, address, party size).'
			}
		},
		required: [
			'reservation_type',
			'title',
			'confirmation_code',
			'status',
			'start_at',
			'end_at',
			'notes'
		]
	}
} as const;

const SYSTEM_PROMPT = `You extract structured details from a single travel reservation confirmation (hotel, flight, restaurant, car/transport, or other). The source may be a pasted email, a PDF, or an image.

Return your answer ONLY by calling the submit_reservation tool. Rules:
- If a field is not present in the source, set it to null. Never invent values.
- reservation_type must be one of: accommodation, flight, restaurant, transport, other.
- Dates/times: YYYY-MM-DDTHH:MM, 24-hour, local to the venue, no timezone offset. If only a date is given, use 00:00. If a time/date is absent, null.
- title: a concise label a traveler would recognize (the property/airline/restaurant name), not a whole sentence.
- If the source clearly contains more than one reservation, extract the first/primary one only.`;

type ContentBlock =
	| { type: 'text'; text: string }
	| { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
	| { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } };

/** Low-level call: send content blocks, get the forced tool_use result back. */
async function callExtractor(blocks: ContentBlock[]): Promise<ExtractedReservation | null> {
	if (!env.ANTHROPIC_API_KEY) {
		console.warn('[reservation-extract] ANTHROPIC_API_KEY not set — extraction disabled');
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
				max_tokens: 1024,
				system: SYSTEM_PROMPT,
				tools: [SUBMIT_TOOL],
				tool_choice: { type: 'tool', name: 'submit_reservation' },
				messages: [{ role: 'user', content: blocks }]
			}),
			signal: controller.signal
		});
		if (!res.ok) {
			const body = await res.text().catch(() => '');
			console.warn(`[reservation-extract] Anthropic ${res.status}: ${body.slice(0, 300)}`);
			return null;
		}
		const json = (await res.json()) as { content: Array<ToolUseContent | { type: string }> };
		const tool = json.content.find(
			(c): c is ToolUseContent => c.type === 'tool_use' && (c as ToolUseContent).name === 'submit_reservation'
		);
		if (!tool) {
			console.warn('[reservation-extract] no tool_use block in response');
			return null;
		}
		return normalize(tool.input);
	} catch (err) {
		console.warn('[reservation-extract] call failed:', err);
		return null;
	} finally {
		clearTimeout(timeoutId);
	}
}

/** Guard the model output against the enum and trim strings. */
function normalize(raw: ExtractedReservation): ExtractedReservation {
	const str = (v: unknown): string | null => {
		const s = typeof v === 'string' ? v.trim() : '';
		return s.length ? s.slice(0, 1000) : null;
	};
	const type =
		typeof raw.reservation_type === 'string' &&
		(RESERVATION_TYPES as readonly string[]).includes(raw.reservation_type)
			? (raw.reservation_type as ReservationType)
			: null;
	return {
		reservation_type: type,
		title: str(raw.title),
		confirmation_code: str(raw.confirmation_code),
		status: str(raw.status),
		start_at: str(raw.start_at),
		end_at: str(raw.end_at),
		notes: str(raw.notes)
	};
}

/** Extract from pasted confirmation text. */
export function extractFromText(text: string): Promise<ExtractedReservation | null> {
	const trimmed = text.trim().slice(0, 50_000);
	if (!trimmed) return Promise.resolve(null);
	return callExtractor([
		{ type: 'text', text: `Reservation confirmation text:\n\n${trimmed}` }
	]);
}

/**
 * Extract from an already-uploaded document the owner has access to. Text docs
 * route through the text path; PDFs/images go through Claude vision.
 */
export async function extractFromDocument(
	ownerId: number,
	attachmentId: number
): Promise<ExtractedReservation | null> {
	const src = await getAttachmentSource(ownerId, attachmentId);
	if (!src) return null;

	if (src.kind === 'text') {
		return extractFromText(src.text_content ?? '');
	}
	if (!src.object_key || !VISION_MIME.has(src.mime_type)) {
		console.warn(`[reservation-extract] unsupported document mime: ${src.mime_type}`);
		return null;
	}
	const data = (await getObjectBuffer(src.object_key)).toString('base64');
	const instruction: ContentBlock = {
		type: 'text',
		text: 'Extract the reservation details from this document.'
	};
	const media: ContentBlock =
		src.mime_type === 'application/pdf'
			? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
			: { type: 'image', source: { type: 'base64', media_type: src.mime_type, data } };
	return callExtractor([media, instruction]);
}
