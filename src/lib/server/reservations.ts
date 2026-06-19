import { query, withTransaction } from '$lib/db';

export const RESERVATION_TYPES = [
	'accommodation',
	'flight',
	'restaurant',
	'transport',
	'other'
] as const;
export type ReservationType = (typeof RESERVATION_TYPES)[number];

export interface Reservation {
	id: number;
	trip_id: number;
	reservation_type: ReservationType;
	title: string;
	confirmation_code: string | null;
	status: string | null;
	start_at: string | null;
	end_at: string | null;
	notes: string | null;
	sort_order: number;
}

const SELECT_COLS = `id, trip_id, reservation_type, title, confirmation_code, status,
	to_char(start_at, 'YYYY-MM-DD"T"HH24:MI') AS start_at,
	to_char(end_at,   'YYYY-MM-DD"T"HH24:MI') AS end_at,
	notes, sort_order`;

export async function listReservations(tripId: number): Promise<Reservation[]> {
	const res = await query<Reservation>(
		`SELECT ${SELECT_COLS} FROM reservations
		  WHERE trip_id = $1
		  ORDER BY sort_order, id`,
		[tripId]
	);
	return res.rows;
}

export interface ReservationInput {
	reservation_type: ReservationType;
	title: string;
	confirmation_code: string | null;
	status: string | null;
	start_at: string | null;
	end_at: string | null;
	notes: string | null;
}

export async function createReservation(tripId: number, input: ReservationInput): Promise<number> {
	return withTransaction(async (client) => {
		const sortRes = await client.query<{ next: number }>(
			`SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM reservations WHERE trip_id = $1`,
			[tripId]
		);
		const res = await client.query<{ id: number }>(
			`INSERT INTO reservations
			   (trip_id, reservation_type, title, confirmation_code, status, start_at, end_at, notes, sort_order)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
			[
				tripId,
				input.reservation_type,
				input.title,
				input.confirmation_code,
				input.status,
				input.start_at,
				input.end_at,
				input.notes,
				sortRes.rows[0].next
			]
		);
		return res.rows[0].id;
	});
}

export async function updateReservation(
	tripId: number,
	id: number,
	input: ReservationInput
): Promise<boolean> {
	const res = await query(
		`UPDATE reservations SET
		   reservation_type = $3, title = $4, confirmation_code = $5, status = $6,
		   start_at = $7, end_at = $8, notes = $9, updated_at = NOW()
		 WHERE id = $1 AND trip_id = $2`,
		[
			id,
			tripId,
			input.reservation_type,
			input.title,
			input.confirmation_code,
			input.status,
			input.start_at,
			input.end_at,
			input.notes
		]
	);
	return (res.rowCount ?? 0) > 0;
}

export async function moveReservation(
	tripId: number,
	id: number,
	direction: 'up' | 'down'
): Promise<void> {
	await withTransaction(async (client) => {
		const res = await client.query<{ id: number; sort_order: number }>(
			`SELECT id, sort_order FROM reservations WHERE trip_id = $1 ORDER BY sort_order, id`,
			[tripId]
		);
		const rows = res.rows;
		const idx = rows.findIndex((r) => r.id === id);
		if (idx === -1) throw new Error('Reservation not found');
		const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
		if (swapIdx < 0 || swapIdx >= rows.length) return;
		await client.query(
			`UPDATE reservations SET sort_order = $2 WHERE id = $1 AND trip_id = $3`,
			[rows[idx].id, rows[swapIdx].sort_order, tripId]
		);
		await client.query(
			`UPDATE reservations SET sort_order = $2 WHERE id = $1 AND trip_id = $3`,
			[rows[swapIdx].id, rows[idx].sort_order, tripId]
		);
	});
}

export async function deleteReservation(tripId: number, id: number): Promise<boolean> {
	const res = await query(`DELETE FROM reservations WHERE id = $1 AND trip_id = $2`, [id, tripId]);
	return (res.rowCount ?? 0) > 0;
}

export function parseReservationForm(form: FormData): { input?: ReservationInput; error?: string } {
	const title = (form.get('title') ?? '').toString().trim();
	if (!title) return { error: 'Title is required.' };
	const t = (form.get('reservation_type') ?? 'other').toString();
	const reservation_type = (RESERVATION_TYPES as readonly string[]).includes(t)
		? (t as ReservationType)
		: 'other';
	const clean = (k: string) => (form.get(k) ?? '').toString().trim() || null;
	return {
		input: {
			reservation_type,
			title: title.slice(0, 300),
			confirmation_code: clean('confirmation_code'),
			status: clean('status'),
			start_at: clean('start_at'),
			end_at: clean('end_at'),
			notes: clean('notes')
		}
	};
}
