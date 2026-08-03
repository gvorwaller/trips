import { query, withTransaction } from '$lib/db';
import { nextSortOrder } from './tree-sql';

export const ITEM_TYPES = ['section', 'day', 'place', 'note'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export interface ItineraryItem {
	id: number;
	trip_id: number;
	parent_id: number | null;
	sort_order: number;
	item_type: ItemType;
	title: string;
	notes: string | null;
	lat: number | null;
	lon: number | null;
	place_id: string | null;
	apple_maps_place_id: string | null;
	external_url: string | null;
	google_maps_url: string | null;
	date: string | null;
	meta: Record<string, unknown> | null;
	visited: boolean;
}

const SELECT_COLS = `id, trip_id, parent_id, sort_order, item_type, title, notes,
	lat, lon, place_id, apple_maps_place_id, external_url, google_maps_url,
	to_char(date, 'YYYY-MM-DD') AS date, meta, visited`;

/** Flat list of a trip's itinerary items (the client assembles the tree). */
export async function listItinerary(tripId: number): Promise<ItineraryItem[]> {
	const res = await query<ItineraryItem>(
		`SELECT ${SELECT_COLS} FROM itinerary_items
		  WHERE trip_id = $1
		  ORDER BY parent_id NULLS FIRST, sort_order`,
		[tripId]
	);
	return res.rows;
}

export interface NewItem {
	parent_id: number | null;
	item_type: ItemType;
	title: string;
	notes?: string | null;
	external_url?: string | null;
	date?: string | null;
}

/** Verify a candidate parent belongs to the same trip (cross-trip parents rejected). */
async function assertParentInTrip(
	client: Pick<import('pg').PoolClient, 'query'>,
	tripId: number,
	parentId: number | null
): Promise<void> {
	if (parentId === null) return;
	const r = await client.query(`SELECT 1 FROM itinerary_items WHERE id = $1 AND trip_id = $2`, [
		parentId,
		tripId
	]);
	if (r.rowCount === 0) throw new Error('Parent item is not in this trip');
}

export async function createItem(tripId: number, item: NewItem): Promise<number> {
	return withTransaction(async (client) => {
		await assertParentInTrip(client, tripId, item.parent_id);
		const sort = await nextSortOrder(client, 'itinerary_items', tripId, item.parent_id);
		const res = await client.query<{ id: number }>(
			`INSERT INTO itinerary_items
			   (trip_id, parent_id, sort_order, item_type, title, notes, external_url, date)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			 RETURNING id`,
			[
				tripId,
				item.parent_id,
				sort,
				item.item_type,
				item.title,
				item.notes ?? null,
				item.external_url ?? null,
				item.date ?? null
			]
		);
		return res.rows[0].id;
	});
}

/** Create many items as siblings under one parent (multi-line paste). Returns count. */
export async function bulkCreate(
	tripId: number,
	parentId: number | null,
	itemType: ItemType,
	titles: string[]
): Promise<number> {
	const clean = titles.map((t) => t.trim()).filter((t) => t.length > 0);
	if (clean.length === 0) return 0;
	return withTransaction(async (client) => {
		await assertParentInTrip(client, tripId, parentId);
		let sort = await nextSortOrder(client, 'itinerary_items', tripId, parentId);
		for (const title of clean) {
			await client.query(
				`INSERT INTO itinerary_items (trip_id, parent_id, sort_order, item_type, title)
				 VALUES ($1, $2, $3, $4, $5)`,
				[tripId, parentId, sort++, itemType, title.slice(0, 500)]
			);
		}
		return clean.length;
	});
}

export interface ItemPatch {
	title?: string;
	notes?: string | null;
	external_url?: string | null;
	date?: string | null;
	item_type?: ItemType;
}

export async function updateItem(tripId: number, id: number, patch: ItemPatch): Promise<boolean> {
	const res = await query(
		`UPDATE itinerary_items SET
		   title = COALESCE($3, title),
		   notes = $4,
		   external_url = $5,
		   date = $6,
		   item_type = COALESCE($7, item_type),
		   updated_at = NOW()
		 WHERE id = $1 AND trip_id = $2`,
		[
			id,
			tripId,
			patch.title ?? null,
			patch.notes ?? null,
			patch.external_url ?? null,
			patch.date ?? null,
			patch.item_type ?? null
		]
	);
	return (res.rowCount ?? 0) > 0;
}

/**
 * Set (or clear, with null) one place's date.
 *
 * Deliberately separate from updateItem, which despite its name is a full
 * overwrite — it assigns notes, external_url and date unconditionally, so using
 * it to change only a date would silently wipe the row's notes and link.
 *
 * Restricted to item_type = 'place' so a bulk form cannot re-date section, day
 * or note rows.
 */
export async function setItemDate(
	tripId: number,
	id: number,
	date: string | null
): Promise<boolean> {
	const res = await query(
		`UPDATE itinerary_items SET date = $3, updated_at = NOW()
		  WHERE id = $1 AND trip_id = $2 AND item_type = 'place'`,
		[id, tripId, date]
	);
	return (res.rowCount ?? 0) > 0;
}

/**
 * Apply one date to many places at once, all or nothing.
 *
 * A per-row UPDATE loop inside a transaction would NOT be atomic in the way
 * that matters: an id belonging to another trip simply matches zero rows, and
 * the valid rows would still commit. So this issues a single statement and
 * compares the returned id set against the request, throwing on any mismatch —
 * a partial bulk assign that reports success is worse than an outright failure.
 */
export async function setItemDates(
	tripId: number,
	ids: number[],
	date: string | null
): Promise<number[]> {
	const wanted = [...new Set(ids)];
	if (wanted.length === 0) return [];
	return withTransaction(async (client) => {
		const res = await client.query<{ id: number }>(
			`UPDATE itinerary_items SET date = $3, updated_at = NOW()
			  WHERE id = ANY($1::int[]) AND trip_id = $2 AND item_type = 'place'
			 RETURNING id`,
			[wanted, tripId, date]
		);
		const updated = res.rows.map((r) => r.id);
		if (updated.length !== wanted.length) {
			const missing = wanted.filter((id) => !updated.includes(id));
			throw new Error(`Some places could not be updated: ${missing.join(', ')}`);
		}
		return updated;
	});
}

export async function deleteItem(tripId: number, id: number): Promise<boolean> {
	const res = await query(`DELETE FROM itinerary_items WHERE id = $1 AND trip_id = $2`, [
		id,
		tripId
	]);
	return (res.rowCount ?? 0) > 0;
}

/** Set an item's coordinates (from the MapPicker). google_maps_url is optional. */
export async function setLocation(
	tripId: number,
	id: number,
	lat: number,
	lon: number,
	placeId: string | null
): Promise<boolean> {
	const res = await query(
		`UPDATE itinerary_items
		    SET lat = $3,
		        lon = $4,
		        place_id = $5,
		        apple_maps_place_id = NULL,
		        updated_at = NOW()
		 WHERE id = $1 AND trip_id = $2`,
		[id, tripId, lat, lon, placeId]
	);
	return (res.rowCount ?? 0) > 0;
}

/**
 * Attach a resolved Google place_id without touching coordinates or the
 * Apple Maps id — used when the place workspace resolves a Google match for
 * an item that already has coordinates (e.g. from an Apple Maps import or a
 * manual pin) but no Google place_id of its own.
 */
export async function setPlaceId(tripId: number, id: number, placeId: string): Promise<boolean> {
	const res = await query(
		`UPDATE itinerary_items SET place_id = $3, updated_at = NOW() WHERE id = $1 AND trip_id = $2`,
		[id, tripId, placeId]
	);
	return (res.rowCount ?? 0) > 0;
}

export async function clearLocation(tripId: number, id: number): Promise<boolean> {
	const res = await query(
		`UPDATE itinerary_items
		    SET lat = NULL,
		        lon = NULL,
		        place_id = NULL,
		        apple_maps_place_id = NULL,
		        updated_at = NOW()
		 WHERE id = $1 AND trip_id = $2`,
		[id, tripId]
	);
	return (res.rowCount ?? 0) > 0;
}

export async function getItem(tripId: number, id: number): Promise<ItineraryItem | null> {
	const res = await query<ItineraryItem>(
		`SELECT ${SELECT_COLS} FROM itinerary_items WHERE id = $1 AND trip_id = $2`,
		[id, tripId]
	);
	return res.rows[0] ?? null;
}

/**
 * Mark a place visited (or not) from the Places tree. The itinerary item is
 * the single source of truth: the flag fans out to EVERY day-plan stop that
 * references the item, in one transaction, so no stop copy can disagree — a
 * place can sit in several plans. Ownership is enforced inside the UPDATE,
 * same shape as setStopVisited.
 */
export async function setItemVisited(
	ownerId: number,
	itemId: number,
	visited: boolean
): Promise<boolean> {
	return withTransaction(async (client) => {
		// item_type = 'place' is part of the AUTHORIZATION, not a nicety: this
		// endpoint is viewer-whitelisted, and the exception cs.md grants is
		// "marking a place visited" — sections, days and notes must 404, same
		// as setItemDate's place-only restriction.
		//
		// LOCK ORDER (do not reorder — peer CODEX reproduced the deadlock):
		// item row → stop rows → trips row, where the trips lock comes only
		// from the 0010 activity triggers at UPDATE time. Every row lock is
		// taken with trigger-free SELECT … FOR UPDATE *before* any UPDATE
		// fires a trigger; ordinary stop writers (notes/reorder/remove) go
		// stop → trips, so a visited writer that touched trips before locking
		// the stops would cycle with them. FOR UPDATE OF restricts each lock
		// to the named table — locking the joined trips row here would
		// recreate the same cycle from the other side.
		const auth = await client.query<{ trip_id: number }>(
			`SELECT i.trip_id
			   FROM itinerary_items i
			   JOIN trips t ON t.id = i.trip_id
			  WHERE i.id = $1 AND t.owner_id = $2 AND i.item_type = 'place'
			  FOR UPDATE OF i`,
			[itemId, ownerId]
		);
		if ((auth.rowCount ?? 0) === 0) return false;
		// Fan-out is scoped through day_plans to the item's own trip: the
		// schema's FKs alone do not force stop.plan.trip == item.trip, and the
		// hard account partition must hold even against a malformed cross-trip
		// link (0016 also enforces this for future writes).
		const locked = await client.query<{ id: number }>(
			`SELECT s.id
			   FROM day_plan_stops s
			   JOIN day_plans p ON p.id = s.day_plan_id
			  WHERE s.itinerary_item_id = $1 AND p.trip_id = $2
			  ORDER BY s.id
			  FOR UPDATE OF s`,
			[itemId, auth.rows[0].trip_id]
		);
		await client.query(`UPDATE itinerary_items SET visited = $2 WHERE id = $1`, [
			itemId,
			visited
		]);
		if (locked.rows.length > 0) {
			await client.query(`UPDATE day_plan_stops SET visited = $2 WHERE id = ANY($1::int[])`, [
				locked.rows.map((r) => r.id),
				visited
			]);
		}
		return true;
	});
}
