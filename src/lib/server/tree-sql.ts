import type pg from 'pg';
import { withTransaction } from '$lib/db';
import {
	computeMove,
	computeIndent,
	computeOutdent,
	computeReparent,
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

function assertTable(table: TreeTable): string {
	const col = CONTAINER_COL[table];
	if (!col) throw new Error(`Unknown tree table: ${table}`);
	return col;
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
	for (const c of changes) {
		await client.query(
			`UPDATE ${table} SET parent_id = $2, sort_order = $3, updated_at = NOW() WHERE id = $1`,
			[c.id, c.parent_id, c.sort_order]
		);
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
	const res = await client.query<{ next: number }>(
		`SELECT COALESCE(MAX(sort_order) + 1, 0) AS next
		   FROM ${table}
		  WHERE ${col} = $1 AND parent_id IS NOT DISTINCT FROM $2`,
		[containerId, parentId]
	);
	return res.rows[0].next;
}

/** Run a keyboard tree op (move/indent/outdent). containerId must be pre-authorized. */
export async function runTreeOp(
	table: TreeTable,
	containerId: number,
	id: number,
	op: TreeOp
): Promise<void> {
	await withTransaction(async (client) => {
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

/** Drag-and-drop reparent. Cross-container is impossible (nodes scoped to one container). */
export async function runReparent(
	table: TreeTable,
	containerId: number,
	id: number,
	newParentId: number | null,
	index: number
): Promise<boolean> {
	return withTransaction(async (client) => {
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
