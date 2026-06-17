import { query, withTransaction } from '$lib/db';
import { nextSortOrder } from './tree-sql';

export interface PackingList {
	id: number;
	trip_id: number;
	name: string;
	sort_order: number;
}

export interface PackingItem {
	id: number;
	list_id: number;
	parent_id: number | null;
	sort_order: number;
	name: string;
	quantity: number;
	checked: boolean;
	category: string | null;
	notes: string | null;
}

export async function listPackingLists(tripId: number): Promise<PackingList[]> {
	const res = await query<PackingList>(
		`SELECT id, trip_id, name, sort_order FROM packing_lists
		  WHERE trip_id = $1 ORDER BY sort_order, id`,
		[tripId]
	);
	return res.rows;
}

export async function getPackingItems(listId: number): Promise<PackingItem[]> {
	const res = await query<PackingItem>(
		`SELECT id, list_id, parent_id, sort_order, name, quantity, checked, category, notes
		   FROM packing_items
		  WHERE list_id = $1
		  ORDER BY parent_id NULLS FIRST, sort_order`,
		[listId]
	);
	return res.rows;
}

/** All packing items for a trip's lists, keyed by list_id (one round-trip). */
export async function getPackingItemsForTrip(tripId: number): Promise<Map<number, PackingItem[]>> {
	const res = await query<PackingItem>(
		`SELECT pi.id, pi.list_id, pi.parent_id, pi.sort_order, pi.name, pi.quantity,
		        pi.checked, pi.category, pi.notes
		   FROM packing_items pi
		   JOIN packing_lists pl ON pl.id = pi.list_id
		  WHERE pl.trip_id = $1
		  ORDER BY pi.parent_id NULLS FIRST, pi.sort_order`,
		[tripId]
	);
	const byList = new Map<number, PackingItem[]>();
	for (const row of res.rows) {
		if (!byList.has(row.list_id)) byList.set(row.list_id, []);
		byList.get(row.list_id)!.push(row);
	}
	return byList;
}

export async function createList(tripId: number, name: string): Promise<number> {
	return withTransaction(async (client) => {
		const sortRes = await client.query<{ next: number }>(
			`SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM packing_lists WHERE trip_id = $1`,
			[tripId]
		);
		const res = await client.query<{ id: number }>(
			`INSERT INTO packing_lists (trip_id, name, sort_order) VALUES ($1, $2, $3) RETURNING id`,
			[tripId, name || 'Packing List', sortRes.rows[0].next]
		);
		return res.rows[0].id;
	});
}

export async function renameList(tripId: number, listId: number, name: string): Promise<boolean> {
	const res = await query(
		`UPDATE packing_lists SET name = $3, updated_at = NOW() WHERE id = $1 AND trip_id = $2`,
		[listId, tripId, name]
	);
	return (res.rowCount ?? 0) > 0;
}

export async function deleteList(tripId: number, listId: number): Promise<boolean> {
	const res = await query(`DELETE FROM packing_lists WHERE id = $1 AND trip_id = $2`, [
		listId,
		tripId
	]);
	return (res.rowCount ?? 0) > 0;
}

/** Confirm a list belongs to the trip before mutating its items. */
export async function assertListInTrip(tripId: number, listId: number): Promise<void> {
	const r = await query(`SELECT 1 FROM packing_lists WHERE id = $1 AND trip_id = $2`, [
		listId,
		tripId
	]);
	if (r.rowCount === 0) throw new Error('List is not in this trip');
}

export interface NewPackingItem {
	parent_id: number | null;
	name: string;
	quantity?: number;
	category?: string | null;
	notes?: string | null;
}

async function assertParentInList(
	client: Pick<import('pg').PoolClient, 'query'>,
	listId: number,
	parentId: number | null
): Promise<void> {
	if (parentId === null) return;
	const r = await client.query(`SELECT 1 FROM packing_items WHERE id = $1 AND list_id = $2`, [
		parentId,
		listId
	]);
	if (r.rowCount === 0) throw new Error('Parent item is not in this list');
}

export async function createPackingItem(listId: number, item: NewPackingItem): Promise<number> {
	return withTransaction(async (client) => {
		await assertParentInList(client, listId, item.parent_id);
		const sort = await nextSortOrder(client, 'packing_items', listId, item.parent_id);
		const res = await client.query<{ id: number }>(
			`INSERT INTO packing_items (list_id, parent_id, sort_order, name, quantity, category, notes)
			 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
			[
				listId,
				item.parent_id,
				sort,
				item.name,
				item.quantity ?? 1,
				item.category ?? null,
				item.notes ?? null
			]
		);
		return res.rows[0].id;
	});
}

/** Multi-line paste → many sibling items under one parent. Returns count. */
export async function bulkCreatePacking(
	listId: number,
	parentId: number | null,
	lines: string[]
): Promise<number> {
	const clean = lines.map((l) => l.trim()).filter((l) => l.length > 0);
	if (clean.length === 0) return 0;
	return withTransaction(async (client) => {
		await assertParentInList(client, listId, parentId);
		let sort = await nextSortOrder(client, 'packing_items', listId, parentId);
		for (const name of clean) {
			await client.query(
				`INSERT INTO packing_items (list_id, parent_id, sort_order, name) VALUES ($1, $2, $3, $4)`,
				[listId, parentId, sort++, name.slice(0, 300)]
			);
		}
		return clean.length;
	});
}

export interface PackingPatch {
	name?: string;
	quantity?: number;
	category?: string | null;
	notes?: string | null;
}

export async function updatePackingItem(
	listId: number,
	id: number,
	patch: PackingPatch
): Promise<boolean> {
	const res = await query(
		`UPDATE packing_items SET
		   name = COALESCE($3, name),
		   quantity = COALESCE($4, quantity),
		   category = $5,
		   notes = $6,
		   updated_at = NOW()
		 WHERE id = $1 AND list_id = $2`,
		[
			id,
			listId,
			patch.name ?? null,
			patch.quantity ?? null,
			patch.category ?? null,
			patch.notes ?? null
		]
	);
	return (res.rowCount ?? 0) > 0;
}

export async function deletePackingItem(listId: number, id: number): Promise<boolean> {
	const res = await query(`DELETE FROM packing_items WHERE id = $1 AND list_id = $2`, [id, listId]);
	return (res.rowCount ?? 0) > 0;
}

/**
 * Toggle a packing item's checked state AND cascade it to every nested
 * descendant (td-54f560): checking a category checks everything under it,
 * unchecking it clears them. One atomic statement — ownership is enforced at
 * the subtree root via the trips.owner_id join, and descendants inherit it
 * (same list → same trip → same owner). This is the single mutation a read-only
 * viewer is permitted (so a couple can pack together), and the cascade rides
 * that same endpoint. Returns false (→ 404) if the root isn't the owner's.
 */
export async function setPackingItemChecked(
	ownerId: number,
	itemId: number,
	checked: boolean
): Promise<boolean> {
	const res = await query(
		`WITH RECURSIVE root AS (
		     SELECT pi.id, pi.list_id
		       FROM packing_items pi
		       JOIN packing_lists pl ON pl.id = pi.list_id
		       JOIN trips t ON t.id = pl.trip_id
		      WHERE pi.id = $1 AND t.owner_id = $2
		 ),
		 subtree AS (
		     SELECT id, list_id FROM root
		     UNION ALL
		     SELECT c.id, c.list_id
		       FROM packing_items c
		       JOIN subtree s ON c.parent_id = s.id AND c.list_id = s.list_id
		 )
		 UPDATE packing_items
		    SET checked = $3, updated_at = NOW()
		  WHERE id IN (SELECT id FROM subtree)`,
		[itemId, ownerId, checked]
	);
	return (res.rowCount ?? 0) > 0;
}
