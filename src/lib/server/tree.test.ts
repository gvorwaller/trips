import { describe, it, expect } from 'vitest';
import {
	childrenOf,
	descendantIds,
	wouldCreateCycle,
	computeMove,
	computeIndent,
	computeOutdent,
	computeReparent,
	computeReparentMany,
	orderParentsFirst,
	flattenTree,
	type TreeNode
} from './tree';

// A small tree:
//  1 (top)
//    3
//    4
//  2 (top)
const base: TreeNode[] = [
	{ id: 1, parent_id: null, sort_order: 0 },
	{ id: 2, parent_id: null, sort_order: 1 },
	{ id: 3, parent_id: 1, sort_order: 0 },
	{ id: 4, parent_id: 1, sort_order: 1 }
];

/** Apply a Change[] to a node list and return the resulting list (for assertions). */
function apply(
	nodes: TreeNode[],
	changes: { id: number; parent_id: number | null; sort_order: number }[]
) {
	const map = new Map(nodes.map((n) => [n.id, { ...n }]));
	for (const c of changes) {
		const n = map.get(c.id);
		if (n) {
			n.parent_id = c.parent_id;
			n.sort_order = c.sort_order;
		}
	}
	return [...map.values()];
}

describe('childrenOf', () => {
	it('returns sorted siblings', () => {
		expect(childrenOf(base, null).map((n) => n.id)).toEqual([1, 2]);
		expect(childrenOf(base, 1).map((n) => n.id)).toEqual([3, 4]);
		expect(childrenOf(base, 2)).toEqual([]);
	});
});

describe('descendantIds / cycle detection', () => {
	it('collects transitive descendants', () => {
		expect([...descendantIds(base, 1)].sort()).toEqual([3, 4]);
		expect([...descendantIds(base, 3)]).toEqual([]);
	});
	it('rejects self-parenting and descendant-parenting as cycles', () => {
		expect(wouldCreateCycle(base, 1, 1)).toBe(true); // self
		expect(wouldCreateCycle(base, 1, 3)).toBe(true); // under own child
		expect(wouldCreateCycle(base, 3, 2)).toBe(false); // valid
		expect(wouldCreateCycle(base, 1, null)).toBe(false); // to top level
	});
});

describe('computeMove', () => {
	it('moves down and reindexes siblings', () => {
		const after = apply(base, computeMove(base, 1, 1));
		expect(childrenOf(after, null).map((n) => n.id)).toEqual([2, 1]);
	});
	it('moves up', () => {
		const after = apply(base, computeMove(base, 4, -1));
		expect(childrenOf(after, 1).map((n) => n.id)).toEqual([4, 3]);
	});
	it('is a no-op at the boundary', () => {
		expect(computeMove(base, 1, -1)).toEqual([]);
		expect(computeMove(base, 2, 1)).toEqual([]);
	});
});

describe('computeIndent', () => {
	it('makes node a child of its previous sibling', () => {
		const after = apply(base, computeIndent(base, 4)); // 4 under 3
		expect(after.find((n) => n.id === 4)?.parent_id).toBe(3);
		expect(childrenOf(after, 3).map((n) => n.id)).toEqual([4]);
		expect(childrenOf(after, 1).map((n) => n.id)).toEqual([3]);
	});
	it('cannot indent the first child', () => {
		expect(computeIndent(base, 3)).toEqual([]);
		expect(computeIndent(base, 1)).toEqual([]);
	});
});

describe('computeOutdent', () => {
	it('lifts a node to sit after its parent in the grandparent group', () => {
		const after = apply(base, computeOutdent(base, 3)); // 3 → top level after 1
		expect(after.find((n) => n.id === 3)?.parent_id).toBe(null);
		expect(childrenOf(after, null).map((n) => n.id)).toEqual([1, 3, 2]);
		expect(childrenOf(after, 1).map((n) => n.id)).toEqual([4]);
	});
	it('cannot outdent a top-level node', () => {
		expect(computeOutdent(base, 1)).toEqual([]);
	});
});

describe('computeReparent', () => {
	it('moves a node under a new parent at an index', () => {
		const after = apply(base, computeReparent(base, 2, 1, 0)); // 2 → first child of 1
		expect(childrenOf(after, 1).map((n) => n.id)).toEqual([2, 3, 4]);
		expect(childrenOf(after, null).map((n) => n.id)).toEqual([1]);
	});
	it('rejects cycles (returns no changes)', () => {
		expect(computeReparent(base, 1, 3, 0)).toEqual([]); // 1 under its child 3
		expect(computeReparent(base, 1, 1, 0)).toEqual([]); // under itself
	});
	it('rejects an unknown parent (cross-container guard at logic level)', () => {
		expect(computeReparent(base, 3, 999, 0)).toEqual([]);
	});
});

describe('computeReparentMany', () => {
	// A wider tree:
	//  1 (top)
	//    3
	//    4
	//  2 (top)
	//    5
	//  6 (top)
	const wide: TreeNode[] = [
		{ id: 1, parent_id: null, sort_order: 0 },
		{ id: 2, parent_id: null, sort_order: 1 },
		{ id: 6, parent_id: null, sort_order: 2 },
		{ id: 3, parent_id: 1, sort_order: 0 },
		{ id: 4, parent_id: 1, sort_order: 1 },
		{ id: 5, parent_id: 2, sort_order: 0 }
	];

	it('appends roots from different parents under the target, densifying old groups', () => {
		const after = apply(wide, computeReparentMany(wide, [4, 5], 6));
		expect(childrenOf(after, 6).map((n) => n.id)).toEqual([4, 5]);
		expect(childrenOf(after, 1).map((n) => n.id)).toEqual([3]);
		expect(childrenOf(after, 2).map((n) => n.id)).toEqual([]);
		// Old groups are dense 0..n-1.
		expect(childrenOf(after, 1).map((n) => n.sort_order)).toEqual([0]);
	});

	it('lands in document order regardless of the order ids were passed', () => {
		const after = apply(wide, computeReparentMany(wide, [5, 3], 6));
		// Document order is 3 (under 1) before 5 (under 2).
		expect(childrenOf(after, 6).map((n) => n.id)).toEqual([3, 5]);
	});

	it('appends after the target’s existing children', () => {
		const after = apply(wide, computeReparentMany(wide, [5], 1));
		expect(childrenOf(after, 1).map((n) => n.id)).toEqual([3, 4, 5]);
	});

	it('drops a selected id whose ancestor is also selected (it travels with the subtree)', () => {
		const changes = computeReparentMany(wide, [1, 4], 6);
		const after = apply(wide, changes);
		// 4 stays under its moved ancestor 1; only 1 landed under 6.
		expect(after.find((n) => n.id === 4)?.parent_id).toBe(1);
		expect(childrenOf(after, 6).map((n) => n.id)).toEqual([1]);
	});

	it('duplicate ids behave as deduped input', () => {
		expect(computeReparentMany(wide, [4, 4, 5], 6)).toEqual(
			computeReparentMany(wide, [4, 5], 6)
		);
	});

	it('rejects a target that is selected or inside a selected subtree', () => {
		expect(computeReparentMany(wide, [1, 2], 1)).toEqual([]); // target selected
		expect(computeReparentMany(wide, [1], 4)).toEqual([]); // target inside selected subtree
	});

	it('rejects unknown ids, unknown parents and empty input', () => {
		expect(computeReparentMany(wide, [999], 6)).toEqual([]);
		expect(computeReparentMany(wide, [4], 999)).toEqual([]);
		expect(computeReparentMany(wide, [], 6)).toEqual([]);
	});

	it('reindexes an item already under the target to the end of its children', () => {
		const after = apply(wide, computeReparentMany(wide, [3, 5], 1));
		expect(childrenOf(after, 1).map((n) => n.id)).toEqual([4, 3, 5]);
	});

	it('moves to top level', () => {
		const after = apply(wide, computeReparentMany(wide, [4, 5], null));
		expect(childrenOf(after, null).map((n) => n.id)).toEqual([1, 2, 6, 4, 5]);
		expect(childrenOf(after, null).map((n) => n.sort_order)).toEqual([0, 1, 2, 3, 4]);
	});

	it('never emits the same id twice across the combined change set', () => {
		for (const [ids, target] of [
			[[4, 5], 6],
			[[1, 4], 6],
			[[3, 5], 1],
			[[4, 5], null]
		] as [number[], number | null][]) {
			const changes = computeReparentMany(wide, ids, target);
			const seen = changes.map((c) => c.id);
			expect(new Set(seen).size, `ids ${ids} → ${target}`).toBe(seen.length);
		}
	});
});

describe('orderParentsFirst', () => {
	it('orders every parent before its children', () => {
		// deliberately shuffled input incl. a 3-level branch: 1 > 3 > 5
		const shuffled: TreeNode[] = [
			{ id: 5, parent_id: 3, sort_order: 0 },
			{ id: 2, parent_id: null, sort_order: 1 },
			{ id: 4, parent_id: 1, sort_order: 1 },
			{ id: 3, parent_id: 1, sort_order: 0 },
			{ id: 1, parent_id: null, sort_order: 0 }
		];
		const ordered = orderParentsFirst(shuffled).map((n) => n.id);
		const pos = (id: number) => ordered.indexOf(id);
		expect(pos(1)).toBeLessThan(pos(3)); // parent before child
		expect(pos(3)).toBeLessThan(pos(5)); // grandparent chain
		expect(pos(1)).toBeLessThan(pos(4));
		expect(ordered).toHaveLength(5);
	});
});

describe('flattenTree', () => {
	it('emits parent then subtree, with depth', () => {
		// 1 > 3,4 ; 2  → expect [1@0, 3@1, 4@1, 2@0]
		const flat = flattenTree(base).map((x) => [x.node.id, x.depth]);
		expect(flat).toEqual([
			[1, 0],
			[3, 1],
			[4, 1],
			[2, 0]
		]);
	});
});
