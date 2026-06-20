import { env } from '$env/dynamic/private';
import { EXPENSE_CATEGORIES, type ExpenseCategory } from './expenses';
import { getAttachmentSource } from './attachments';
import { getObjectBuffer } from './storage';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const TIMEOUT_MS = 30_000;

const DEFAULT_MODEL = env.ANTHROPIC_EXPENSE_MODEL ?? 'claude-sonnet-4-6';

const VISION_MIME = new Set([
	'application/pdf',
	'image/jpeg',
	'image/png',
	'image/webp',
	'image/gif',
	'image/heic',
	'image/heif'
]);

export interface ExtractedExpense {
	expense_date: string | null;
	description: string;
	amount: number;
	category: ExpenseCategory | null;
	notes: string | null;
}

interface ToolUseContent {
	type: 'tool_use';
	name: string;
	input: { expenses: ExtractedExpense[] };
}

const SUBMIT_TOOL = {
	name: 'submit_expenses',
	description: 'Return the array of expense transactions extracted from the source.',
	input_schema: {
		type: 'object',
		properties: {
			expenses: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						expense_date: {
							type: ['string', 'null'],
							description: 'Transaction date as YYYY-MM-DD, or null if unclear.'
						},
						description: {
							type: 'string',
							description:
								'Merchant/payee name or transaction description, cleaned up for readability.'
						},
						amount: {
							type: 'number',
							description:
								'Amount in dollars (positive, e.g. 42.50). Use the debit/charge amount, not credits/payments.'
						},
						category: {
							type: ['string', 'null'],
							enum: [...EXPENSE_CATEGORIES, null],
							description: 'Best-fit category, or null if unclear.'
						},
						notes: {
							type: ['string', 'null'],
							description: 'Any additional context (original reference number, location, etc.).'
						}
					},
					required: ['expense_date', 'description', 'amount', 'category', 'notes']
				}
			}
		},
		required: ['expenses']
	}
} as const;

const SYSTEM_PROMPT = `You extract individual expense transactions from bank statements, credit card statements, receipts, or pasted financial text. The source may be a text paste, PDF, or image.

Return your answer ONLY by calling the submit_expenses tool. Rules:
- Extract each individual transaction as a separate entry in the expenses array.
- Dates: YYYY-MM-DD format. If only month/day, infer the year from context or set null.
- description: clean merchant name (remove excess codes/numbers), keep it human-readable.
- amount: positive decimal number in dollars (e.g. 42.50). Extract debits/charges only — skip credits, payments, and refunds unless the source is clearly a receipt for a single purchase.
- category: lodging, food, transport, activities, or other. Infer from merchant name.
- If a line item is clearly not a travel expense (e.g. Netflix subscription, recurring utility), still include it — the user will decide what to keep.
- Order transactions by date (earliest first).
- If the source contains no recognizable transactions, return an empty array.`;

type ContentBlock =
	| { type: 'text'; text: string }
	| { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
	| { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } };

async function callExtractor(blocks: ContentBlock[]): Promise<ExtractedExpense[] | null> {
	if (!env.ANTHROPIC_API_KEY) {
		console.warn('[expense-extract] ANTHROPIC_API_KEY not set — extraction disabled');
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
				max_tokens: 4096,
				system: SYSTEM_PROMPT,
				tools: [SUBMIT_TOOL],
				tool_choice: { type: 'tool', name: 'submit_expenses' },
				messages: [{ role: 'user', content: blocks }]
			}),
			signal: controller.signal
		});
		if (!res.ok) {
			const body = await res.text().catch(() => '');
			console.warn(`[expense-extract] Anthropic ${res.status}: ${body.slice(0, 300)}`);
			return null;
		}
		const json = (await res.json()) as { content: Array<ToolUseContent | { type: string }> };
		const tool = json.content.find(
			(c): c is ToolUseContent =>
				c.type === 'tool_use' && (c as ToolUseContent).name === 'submit_expenses'
		);
		if (!tool) {
			console.warn('[expense-extract] no tool_use block in response');
			return null;
		}
		const raw = tool.input.expenses;
		if (!Array.isArray(raw)) return [];
		return raw.map(normalize).filter((e): e is ExtractedExpense => e !== null);
	} catch (err) {
		console.warn('[expense-extract] call failed:', err);
		return null;
	} finally {
		clearTimeout(timeoutId);
	}
}

function normalize(raw: ExtractedExpense): ExtractedExpense | null {
	const str = (v: unknown): string | null => {
		const s = typeof v === 'string' ? v.trim() : '';
		return s.length ? s.slice(0, 500) : null;
	};
	const desc = str(raw.description);
	if (!desc) return null;
	const amount = typeof raw.amount === 'number' && isFinite(raw.amount) && raw.amount >= 0
		? Math.round(raw.amount * 100) / 100
		: 0;
	const cat =
		typeof raw.category === 'string' &&
		(EXPENSE_CATEGORIES as readonly string[]).includes(raw.category)
			? (raw.category as ExpenseCategory)
			: null;
	return {
		expense_date: str(raw.expense_date),
		description: desc,
		amount,
		category: cat,
		notes: str(raw.notes)
	};
}

export function extractExpensesFromText(text: string): Promise<ExtractedExpense[] | null> {
	const trimmed = text.trim().slice(0, 50_000);
	if (!trimmed) return Promise.resolve(null);
	return callExtractor([
		{ type: 'text', text: `Bank statement / transaction text:\n\n${trimmed}` }
	]);
}

export async function extractExpensesFromDocument(
	ownerId: number,
	attachmentId: number
): Promise<ExtractedExpense[] | null> {
	const src = await getAttachmentSource(ownerId, attachmentId);
	if (!src) return null;

	if (src.kind === 'text') {
		return extractExpensesFromText(src.text_content ?? '');
	}
	if (!src.object_key || !VISION_MIME.has(src.mime_type)) {
		console.warn(`[expense-extract] unsupported document mime: ${src.mime_type}`);
		return null;
	}
	const data = (await getObjectBuffer(src.object_key)).toString('base64');
	const instruction: ContentBlock = {
		type: 'text',
		text: 'Extract expense transactions from this document.'
	};
	const media: ContentBlock =
		src.mime_type === 'application/pdf'
			? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
			: { type: 'image', source: { type: 'base64', media_type: src.mime_type, data } };
	return callExtractor([media, instruction]);
}
