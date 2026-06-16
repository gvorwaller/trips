import { query } from '$lib/db';

export interface Trip {
	id: number;
	owner_id: number;
	name: string;
	start_date: string | null; // 'YYYY-MM-DD'
	end_date: string | null;
	notes: string | null;
	created_at: string;
	updated_at: string;
}

export interface TripInput {
	name: string;
	start_date: string | null;
	end_date: string | null;
	notes: string | null;
}

/** All trips for an owner. Viewers pass the owner's id (locals.ownerId). */
export async function listTrips(ownerId: number): Promise<Trip[]> {
	const res = await query<Trip>(
		`SELECT id, owner_id, name,
		        to_char(start_date, 'YYYY-MM-DD') AS start_date,
		        to_char(end_date,   'YYYY-MM-DD') AS end_date,
		        notes, created_at, updated_at
		   FROM trips
		  WHERE owner_id = $1
		  ORDER BY start_date DESC NULLS LAST, created_at DESC`,
		[ownerId]
	);
	return res.rows;
}

/** A single trip, scoped to the owner. Returns null if not found / not owned. */
export async function getTrip(ownerId: number, tripId: number): Promise<Trip | null> {
	const res = await query<Trip>(
		`SELECT id, owner_id, name,
		        to_char(start_date, 'YYYY-MM-DD') AS start_date,
		        to_char(end_date,   'YYYY-MM-DD') AS end_date,
		        notes, created_at, updated_at
		   FROM trips
		  WHERE id = $1 AND owner_id = $2`,
		[tripId, ownerId]
	);
	return res.rows[0] ?? null;
}

export async function createTrip(ownerId: number, input: TripInput): Promise<number> {
	const res = await query<{ id: number }>(
		`INSERT INTO trips (owner_id, name, start_date, end_date, notes)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id`,
		[ownerId, input.name, input.start_date, input.end_date, input.notes]
	);
	return res.rows[0].id;
}

/** Update a trip the owner owns. Returns true if a row was changed. */
export async function updateTrip(
	ownerId: number,
	tripId: number,
	input: TripInput
): Promise<boolean> {
	const res = await query(
		`UPDATE trips
		    SET name = $3, start_date = $4, end_date = $5, notes = $6, updated_at = NOW()
		  WHERE id = $1 AND owner_id = $2`,
		[tripId, ownerId, input.name, input.start_date, input.end_date, input.notes]
	);
	return (res.rowCount ?? 0) > 0;
}

export async function deleteTrip(ownerId: number, tripId: number): Promise<boolean> {
	const res = await query(`DELETE FROM trips WHERE id = $1 AND owner_id = $2`, [tripId, ownerId]);
	return (res.rowCount ?? 0) > 0;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate + normalize a trip form. Returns either {input} or {error}. */
export function parseTripForm(form: FormData): { input?: TripInput; error?: string } {
	const name = (form.get('name') ?? '').toString().trim();
	const start_date = (form.get('start_date') ?? '').toString().trim() || null;
	const end_date = (form.get('end_date') ?? '').toString().trim() || null;
	const notes = (form.get('notes') ?? '').toString().trim() || null;

	if (!name) return { error: 'Trip name is required.' };
	if (name.length > 200) return { error: 'Trip name is too long.' };
	if (start_date && !DATE_RE.test(start_date)) return { error: 'Start date is invalid.' };
	if (end_date && !DATE_RE.test(end_date)) return { error: 'End date is invalid.' };
	if (start_date && end_date && end_date < start_date) {
		return { error: 'End date is before the start date.' };
	}
	return { input: { name, start_date, end_date, notes } };
}
