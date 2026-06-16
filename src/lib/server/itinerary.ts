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
	external_url: string | null;
	google_maps_url: string | null;
	date: string | null;
}

const SELECT_COLS = `id, trip_id, parent_id, sort_order, item_type, title, notes,
	lat, lon, place_id, external_url, google_maps_url,
	to_char(date, 'YYYY-MM-DD') AS date`;

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
		`UPDATE itinerary_items SET lat = $3, lon = $4, place_id = $5, updated_at = NOW()
		 WHERE id = $1 AND trip_id = $2`,
		[id, tripId, lat, lon, placeId]
	);
	return (res.rowCount ?? 0) > 0;
}

export async function clearLocation(tripId: number, id: number): Promise<boolean> {
	const res = await query(
		`UPDATE itinerary_items SET lat = NULL, lon = NULL, place_id = NULL, updated_at = NOW()
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
