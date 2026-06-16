// Pure hierarchy logic shared by the itinerary and packing outliners.
// Operates on an in-memory list of nodes already scoped to ONE container
// (one trip's itinerary_items, or one list's packing_items). No DB here, so
// it is fully unit-testable; the SQL layer loads nodes, calls these, writes back.
//
// Ordering strategy matches birds: sequential reindex (0..n) within a sibling
// group, recomputed in a transaction. Trip lists are small, so this is simple
// and robust (no fractional-rank drift).

export interface TreeNode {
	id: number;
	parent_id: number | null;
	sort_order: number;
}

export interface Change {
	id: number;
	parent_id: number | null;
	sort_order: number;
}

export type Direction = -1 | 1; // -1 = up, +1 = down

/** Children of `parentId` (null = top level), sorted by current sort_order. */
export function childrenOf<T extends TreeNode>(nodes: T[], parentId: number | null): T[] {
	return nodes.filter((n) => n.parent_id === parentId).sort((a, b) => a.sort_order - b.sort_order);
}

/** All transitive descendant ids of `id` (excludes `id` itself). */
export function descendantIds(nodes: TreeNode[], id: number): Set<number> {
	const out = new Set<number>();
	const stack = [id];
	while (stack.length) {
		const cur = stack.pop() as number;
		for (const n of nodes) {
			if (n.parent_id === cur && !out.has(n.id)) {
				out.add(n.id);
				stack.push(n.id);
			}
		}
	}
	return out;
}

/** True if reparenting `id` under `newParentId` would form a cycle. */
export function wouldCreateCycle(
	nodes: TreeNode[],
	id: number,
	newParentId: number | null
): boolean {
	if (newParentId === null) return false;
	if (newParentId === id) return true;
	return descendantIds(nodes, id).has(newParentId);
}

/**
 * Order nodes so every parent precedes its children (BFS from roots), each
 * sibling group by sort_order. Used when copying a tree (templates, duplicate
 * trip) so a parent's new id exists before its children reference it.
 */
export function orderParentsFirst<T extends TreeNode>(nodes: T[]): T[] {
	const out: T[] = [];
	const queue: (number | null)[] = [null];
	const seen = new Set<number>();
	while (queue.length) {
		const parent = queue.shift() as number | null;
		for (const child of childrenOf(nodes, parent)) {
			if (seen.has(child.id)) continue; // guard against malformed cycles
			seen.add(child.id);
			out.push(child);
			queue.push(child.id);
		}
	}
	return out;
}

/** Depth-first flatten (parent then its subtree) with a depth for indentation. */
export function flattenTree<T extends TreeNode>(nodes: T[]): { node: T; depth: number }[] {
	const out: { node: T; depth: number }[] = [];
	const walk = (parentId: number | null, depth: number) => {
		for (const child of childrenOf(nodes, parentId)) {
			out.push({ node: child, depth });
			walk(child.id, depth + 1);
		}
	};
	walk(null, 0);
	return out;
}

function reindex(group: TreeNode[], parentId: number | null): Change[] {
	return group.map((n, idx) => ({ id: n.id, parent_id: parentId, sort_order: idx }));
}

/** Move a node up/down among its siblings. Returns changed rows ([] if no-op). */
export function computeMove(nodes: TreeNode[], id: number, dir: Direction): Change[] {
	const node = nodes.find((n) => n.id === id);
	if (!node) return [];
	const sibs = childrenOf(nodes, node.parent_id);
	const i = sibs.findIndex((n) => n.id === id);
	const j = i + dir;
	if (j < 0 || j >= sibs.length) return [];
	const arr = [...sibs];
	[arr[i], arr[j]] = [arr[j], arr[i]];
	return reindex(arr, node.parent_id);
}

/** Indent: make the node the last child of its immediately-preceding sibling. */
export function computeIndent(nodes: TreeNode[], id: number): Change[] {
	const node = nodes.find((n) => n.id === id);
	if (!node) return [];
	const sibs = childrenOf(nodes, node.parent_id);
	const i = sibs.findIndex((n) => n.id === id);
	if (i <= 0) return []; // no previous sibling → cannot indent
	const newParent = sibs[i - 1];
	const newParentKids = childrenOf(nodes, newParent.id);
	const moved: Change = {
		id: node.id,
		parent_id: newParent.id,
		sort_order: newParentKids.length
	};
	const oldSibsReindexed = reindex(
		sibs.filter((n) => n.id !== id),
		node.parent_id
	);
	return [moved, ...oldSibsReindexed];
}

/** Outdent: lift the node to sit immediately after its parent in the grandparent group. */
export function computeOutdent(nodes: TreeNode[], id: number): Change[] {
	const node = nodes.find((n) => n.id === id);
	if (!node || node.parent_id === null) return []; // already top-level
	const parent = nodes.find((n) => n.id === node.parent_id);
	if (!parent) return [];
	const grandParentId = parent.parent_id;
	const targetGroup = childrenOf(nodes, grandParentId);
	const parentIdx = targetGroup.findIndex((n) => n.id === parent.id);

	const newOrder = [...targetGroup];
	newOrder.splice(parentIdx + 1, 0, node);
	const targetChanges = reindex(newOrder, grandParentId);

	const oldSibsReindexed = reindex(
		childrenOf(nodes, node.parent_id).filter((n) => n.id !== id),
		node.parent_id
	);
	return [...targetChanges, ...oldSibsReindexed];
}

/**
 * Reparent a node under `newParentId` at `index` among that parent's children.
 * Returns [] (rejected) if it would create a cycle. Used for drag-and-drop;
 * the SQL layer additionally guarantees both nodes share the same container.
 */
export function computeReparent(
	nodes: TreeNode[],
	id: number,
	newParentId: number | null,
	index: number
): Change[] {
	const node = nodes.find((n) => n.id === id);
	if (!node) return [];
	if (newParentId !== null && !nodes.find((n) => n.id === newParentId)) return []; // unknown parent
	if (wouldCreateCycle(nodes, id, newParentId)) return [];

	const targetGroup = childrenOf(nodes, newParentId).filter((n) => n.id !== id);
	const clamped = Math.max(0, Math.min(index, targetGroup.length));
	targetGroup.splice(clamped, 0, node);
	const targetChanges = reindex(targetGroup, newParentId);

	const changes = [...targetChanges];
	if (node.parent_id !== newParentId) {
		changes.push(
			...reindex(
				childrenOf(nodes, node.parent_id).filter((n) => n.id !== id),
				node.parent_id
			)
		);
	}
	return changes;
}
