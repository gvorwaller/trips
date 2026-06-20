import { query, withTransaction } from '$lib/db';

export const EXPENSE_CATEGORIES = ['lodging', 'food', 'transport', 'activities', 'other'] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export interface Expense {
	id: number;
	trip_id: number;
	expense_date: string | null;
	description: string;
	amount_cents: number;
	category: ExpenseCategory;
	attachment_id: number | null;
	notes: string | null;
	sort_order: number;
}

export interface ExpenseInput {
	expense_date: string | null;
	description: string;
	amount_cents: number;
	category: ExpenseCategory;
	attachment_id: number | null;
	notes: string | null;
}

export async function listExpenses(tripId: number): Promise<Expense[]> {
	const res = await query<Expense>(
		`SELECT id, trip_id,
		        to_char(expense_date, 'YYYY-MM-DD') AS expense_date,
		        description, amount_cents, category, attachment_id, notes, sort_order
		   FROM expenses
		  WHERE trip_id = $1
		  ORDER BY sort_order, id`,
		[tripId]
	);
	return res.rows;
}

export async function createExpense(tripId: number, input: ExpenseInput): Promise<number> {
	return withTransaction(async (client) => {
		const sortRes = await client.query<{ next: number }>(
			`SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM expenses WHERE trip_id = $1`,
			[tripId]
		);
		const res = await client.query<{ id: number }>(
			`INSERT INTO expenses
			   (trip_id, expense_date, description, amount_cents, category, attachment_id, notes, sort_order)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
			[
				tripId,
				input.expense_date,
				input.description,
				input.amount_cents,
				input.category,
				input.attachment_id,
				input.notes,
				sortRes.rows[0].next
			]
		);
		return res.rows[0].id;
	});
}

export async function updateExpense(
	tripId: number,
	id: number,
	input: ExpenseInput
): Promise<boolean> {
	const res = await query(
		`UPDATE expenses SET
		   expense_date = $3, description = $4, amount_cents = $5, category = $6,
		   attachment_id = $7, notes = $8, updated_at = NOW()
		 WHERE id = $1 AND trip_id = $2`,
		[
			id,
			tripId,
			input.expense_date,
			input.description,
			input.amount_cents,
			input.category,
			input.attachment_id,
			input.notes
		]
	);
	return (res.rowCount ?? 0) > 0;
}

export async function deleteExpense(tripId: number, id: number): Promise<boolean> {
	const res = await query(`DELETE FROM expenses WHERE id = $1 AND trip_id = $2`, [id, tripId]);
	return (res.rowCount ?? 0) > 0;
}

export async function moveExpense(
	tripId: number,
	id: number,
	direction: 'up' | 'down'
): Promise<void> {
	await withTransaction(async (client) => {
		const res = await client.query<{ id: number; sort_order: number }>(
			`SELECT id, sort_order FROM expenses WHERE trip_id = $1 ORDER BY sort_order, id`,
			[tripId]
		);
		const rows = res.rows;
		const idx = rows.findIndex((r) => r.id === id);
		if (idx === -1) throw new Error('Expense not found');
		const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
		if (swapIdx < 0 || swapIdx >= rows.length) return;
		await client.query(
			`UPDATE expenses SET sort_order = $2 WHERE id = $1 AND trip_id = $3`,
			[rows[idx].id, rows[swapIdx].sort_order, tripId]
		);
		await client.query(
			`UPDATE expenses SET sort_order = $2 WHERE id = $1 AND trip_id = $3`,
			[rows[swapIdx].id, rows[idx].sort_order, tripId]
		);
	});
}

export async function bulkCreateExpenses(
	tripId: number,
	inputs: ExpenseInput[]
): Promise<number> {
	if (inputs.length === 0) return 0;
	return withTransaction(async (client) => {
		const sortRes = await client.query<{ next: number }>(
			`SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM expenses WHERE trip_id = $1`,
			[tripId]
		);
		let order = sortRes.rows[0].next;
		for (const input of inputs) {
			await client.query(
				`INSERT INTO expenses
				   (trip_id, expense_date, description, amount_cents, category, attachment_id, notes, sort_order)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
				[
					tripId,
					input.expense_date,
					input.description,
					input.amount_cents,
					input.category,
					input.attachment_id,
					input.notes,
					order++
				]
			);
		}
		return inputs.length;
	});
}

export function parseAmount(raw: string): number | null {
	const cleaned = raw.replace(/[$,\s]/g, '').trim();
	const n = parseFloat(cleaned);
	if (!isFinite(n) || n < 0) return null;
	return Math.round(n * 100);
}

export function formatAmount(cents: number): string {
	return '$' + (cents / 100).toFixed(2);
}

export function parseExpenseForm(form: FormData): { input?: ExpenseInput; error?: string } {
	const description = (form.get('description') ?? '').toString().trim();
	if (!description) return { error: 'Description is required.' };
	const rawAmount = (form.get('amount') ?? '').toString();
	const amount_cents = parseAmount(rawAmount);
	if (amount_cents === null) return { error: 'Enter a valid amount.' };
	const cat = (form.get('category') ?? 'other').toString();
	const category = (EXPENSE_CATEGORIES as readonly string[]).includes(cat)
		? (cat as ExpenseCategory)
		: 'other';
	const clean = (k: string) => (form.get(k) ?? '').toString().trim() || null;
	const attId = (form.get('attachment_id') ?? '').toString().trim();
	return {
		input: {
			expense_date: clean('expense_date'),
			description: description.slice(0, 500),
			amount_cents,
			category,
			attachment_id: attId ? Number(attId) || null : null,
			notes: clean('notes')
		}
	};
}
