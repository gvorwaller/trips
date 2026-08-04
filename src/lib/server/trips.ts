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
	archived_at: string | null;
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
		        notes, created_at, updated_at, archived_at
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
		        notes, created_at, updated_at, archived_at
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

/** Archive (or restore) a trip. Reversible; the trip and its data are
 * untouched apart from the flag. Owner-scoped inside the UPDATE. */
export async function setTripArchived(
	ownerId: number,
	tripId: number,
	archived: boolean
): Promise<boolean> {
	const res = await query(
		`UPDATE trips
		    SET archived_at = CASE WHEN $3 THEN NOW() ELSE NULL END,
		        updated_at = NOW()
		  WHERE id = $1 AND owner_id = $2`,
		[tripId, ownerId, archived]
	);
	return (res.rowCount ?? 0) > 0;
}

/**
 * DELIBERATE lock-order exception (td-36b55b): deleting a trip locks the
 * trips row FIRST and then cascades into every child table — the reverse of
 * the canonical item(s) → plan → stops → trips order every other writer
 * follows. A full prelock would have to enumerate every cascade target
 * (items, plans, stops, packing lists/items, reservations, attachments,
 * expenses, …) in canonical order and keep that list in lockstep with the
 * schema forever. Accepted instead: either side of the race may be chosen as
 * the 40P01 deadlock victim — the concurrent writer's request fails
 * retryably, and if the DELETE itself is the victim, the bounded retry below
 * re-runs it so the user's intent still lands (peer CODEX, review round 1:
 * without the retry, "the trip is gone either way" was an overpromise).
 */
export async function deleteTrip(ownerId: number, tripId: number): Promise<boolean> {
	for (let attempt = 1; ; attempt++) {
		try {
			const res = await query(`DELETE FROM trips WHERE id = $1 AND owner_id = $2`, [
				tripId,
				ownerId
			]);
			return (res.rowCount ?? 0) > 0;
		} catch (err) {
			const code = (err as { code?: string }).code;
			if (code === '40P01' && attempt < 3) continue;
			throw err;
		}
	}
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
