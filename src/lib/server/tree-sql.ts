import type pg from 'pg';
import { withTransaction } from '$lib/db';
import {
	computeMove,
	computeIndent,
	computeOutdent,
	computeReparent,
	computeReparentMany,
	childrenOf,
	type Change,
	type TreeNode
} from './tree';

// Tables that use the parent_id + sort_order outliner model, mapped to their
// container column. Allow-listed so the table name can be safely interpolated.
const CONTAINER_COL = {
	itinerary_items: 'trip_id',
	packing_items: 'list_id'
} as const;

export type TreeTable = keyof typeof CONTAINER_COL;
export type TreeOp = 'move-up' | 'move-down' | 'indent' | 'outdent';

/** A batch id that is not in the loaded container (cross-trip/list, or stale). */
export class ItemNotInContainerError extends Error {
	constructor() {
		super('Item does not belong to this container');
	}
}

/** The tree changed between snapshot and lock; the transaction wrote nothing. */
export class TreeConcurrencyError extends Error {
	constructor() {
		super('Tree changed concurrently; nothing was written');
	}
}

function assertTable(table: TreeTable): string {
	const col = CONTAINER_COL[table];
	if (!col) throw new Error(`Unknown tree table: ${table}`);
	return col;
}

/**
 * Serialize every group-membership-changing writer per (table, container):
 * the reindexers (move/indent/outdent/reparent/bulk reparent) and the
 * inserters (nextSortOrder's MAX — every insert path funnels through it).
 * Without a common barrier, an INSERT can compute MAX from a group a
 * concurrent reindex is rewriting and commit a duplicate sort_order (peer
 * CODEX, td-947440 re-review: the row-count guard only proves rows the
 * change set already knows about still exist; it cannot see phantoms).
 * Advisory xact locks are re-entrant in-transaction and release at commit,
 * and are taken BEFORE any row lock, so the global order stays
 * advisory → item rows → trips (td-36b55b). Exported for writers that must
 * take their own row locks before calling nextSortOrder (createPackingItemAt)
 * — they acquire this FIRST or the order inverts into a deadlock cycle.
 */
export async function lockTreeContainer(
	client: pg.PoolClient,
	table: TreeTable,
	containerId: number
): Promise<void> {
	assertTable(table);
	const tableKey = table === 'itinerary_items' ? 1 : 2;
	await client.query(`SELECT pg_advisory_xact_lock($1::int4, $2::int4)`, [tableKey, containerId]);
}

async function loadNodes(
	client: pg.PoolClient,
	table: TreeTable,
	containerId: number
): Promise<TreeNode[]> {
	const col = assertTable(table);
	const res = await client.query<TreeNode>(
		`SELECT id, parent_id, sort_order FROM ${table} WHERE ${col} = $1`,
		[containerId]
	);
	return res.rows;
}

async function applyChanges(
	client: pg.PoolClient,
	table: TreeTable,
	changes: Change[]
): Promise<void> {
	assertTable(table);
	if (changes.length === 0) return;
	// Trigger-free prelock of every row this op will touch, in id order,
	// BEFORE the first UPDATE fires a 0010 activity trigger (which locks the
	// trips row). Without it the first UPDATE holds trips while later
	// UPDATEs seek other item rows — a trips → items edge that deadlocks
	// against writers following the canonical item(s) → … → trips order
	// (peer CODEX reproduced move-up vs deleteItem, td-36b55b round 1).
	const ids = [...new Set(changes.map((c) => c.id))].sort((x, y) => x - y);
	const locked = await client.query(
		`SELECT id FROM ${table} WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE`,
		[ids]
	);
	// The snapshot the changes were computed from must still be intact: a row
	// deleted between load and prelock would otherwise be skipped silently —
	// a partial write from a change set that promised all-or-nothing, plus
	// sort-order gaps from reindexing stale state (peer CODEX, td-947440).
	if (locked.rowCount !== ids.length) throw new TreeConcurrencyError();
	for (const c of changes) {
		const updated = await client.query(
			`UPDATE ${table} SET parent_id = $2, sort_order = $3, updated_at = NOW() WHERE id = $1`,
			[c.id, c.parent_id, c.sort_order]
		);
		if (updated.rowCount !== 1) throw new TreeConcurrencyError();
	}
}

/** sort_order for a new node appended to the end of its sibling group. */
export async function nextSortOrder(
	client: pg.PoolClient,
	table: TreeTable,
	containerId: number,
	parentId: number | null
): Promise<number> {
	const col = assertTable(table);
	await lockTreeContainer(client, table, containerId);
	const res = await client.query<{ next: number }>(
		`SELECT COALESCE(MAX(sort_order) + 1, 0) AS next
		   FROM ${table}
		  WHERE ${col} = $1 AND parent_id IS NOT DISTINCT FROM $2`,
		[containerId, parentId]
	);
	return res.rows[0].next;
}

/**
 * Place a freshly-inserted node (already appended to the end of its sibling
 * group) immediately above or below a reference sibling, then reindex the group.
 * Runs inside the caller's transaction (takes the client) so the INSERT and the
 * reorder commit together. Returns the new node's index among its siblings.
 */
export async function placeNodeRelative(
	client: pg.PoolClient,
	table: TreeTable,
	containerId: number,
	newId: number,
	parentId: number | null,
	refId: number,
	position: 'above' | 'below'
): Promise<void> {
	await lockTreeContainer(client, table, containerId);
	const nodes = await loadNodes(client, table, containerId);
	// Index of the reference among siblings as they stand before placing newId.
	const sibs = childrenOf(
		nodes.filter((n) => n.id !== newId),
		parentId
	);
	const refIdx = sibs.findIndex((n) => n.id === refId);
	if (refIdx === -1) throw new Error('Reference item is not a sibling');
	const targetIdx = position === 'below' ? refIdx + 1 : refIdx;
	const changes = computeReparent(nodes, newId, parentId, targetIdx);
	await applyChanges(client, table, changes);
}

/** Run a keyboard tree op (move/indent/outdent). containerId must be pre-authorized. */
export async function runTreeOp(
	table: TreeTable,
	containerId: number,
	id: number,
	op: TreeOp
): Promise<void> {
	await withTransaction(async (client) => {
		await lockTreeContainer(client, table, containerId);
		const nodes = await loadNodes(client, table, containerId);
		if (!nodes.find((n) => n.id === id)) {
			throw new Error('Item does not belong to this container');
		}
		let changes: Change[];
		switch (op) {
			case 'move-up':
				changes = computeMove(nodes, id, -1);
				break;
			case 'move-down':
				changes = computeMove(nodes, id, 1);
				break;
			case 'indent':
				changes = computeIndent(nodes, id);
				break;
			case 'outdent':
				changes = computeOutdent(nodes, id);
				break;
		}
		await applyChanges(client, table, changes);
	});
}

/**
 * Bulk reparent, appended at the end of the new parent's children, in ONE
 * transaction with ONE applyChanges — the id-ordered FOR UPDATE prelock must
 * cover every touched row of the whole batch (td-36b55b), so this must never
 * be a loop over runReparent. All-or-nothing: any id outside the container
 * throws and nothing is written.
 */
export async function runReparentMany(
	table: TreeTable,
	containerId: number,
	ids: number[],
	newParentId: number | null
): Promise<boolean> {
	return withTransaction(async (client) => {
		await lockTreeContainer(client, table, containerId);
		const nodes = await loadNodes(client, table, containerId);
		const known = new Set(nodes.map((n) => n.id));
		if (ids.some((id) => !known.has(id))) {
			throw new ItemNotInContainerError();
		}
		const changes = computeReparentMany(nodes, ids, newParentId);
		if (changes.length === 0) return false; // rejected (empty / unknown parent / cycle union)
		await applyChanges(client, table, changes);
		return true;
	});
}

/** Drag-and-drop reparent. Cross-container is impossible (nodes scoped to one container). */
export async function runReparent(
	table: TreeTable,
	containerId: number,
	id: number,
	newParentId: number | null,
	index: number
): Promise<boolean> {
	return withTransaction(async (client) => {
		await lockTreeContainer(client, table, containerId);
		const nodes = await loadNodes(client, table, containerId);
		if (!nodes.find((n) => n.id === id)) {
			throw new Error('Item does not belong to this container');
		}
		const changes = computeReparent(nodes, id, newParentId, index);
		if (changes.length === 0) return false; // rejected (cycle / unknown parent) or no-op
		await applyChanges(client, table, changes);
		return true;
	});
}
