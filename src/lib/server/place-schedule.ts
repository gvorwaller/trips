import { flattenTree, type TreeNode } from './tree';
import { dateStatus, type PlaceDateStatus } from '$lib/place-date';

export interface PlaceScheduleSource extends TreeNode {
	item_type: string;
	title: string;
	notes: string | null;
	date: string | null;
	lat: number | null;
	lon: number | null;
	place_id: string | null;
	apple_maps_place_id: string | null;
}

export type { PlaceDateStatus } from '$lib/place-date';

export interface PlaceScheduleEntry {
	id: number;
	title: string;
	notes: string | null;
	date: string | null;
	ancestorTitles: string[];
	branchTitle: string;
	lat: number | null;
	lon: number | null;
	place_id: string | null;
	apple_maps_place_id: string | null;
}

export interface PlaceDateGroup {
	date: string;
	status: PlaceDateStatus;
	places: PlaceScheduleEntry[];
}

export interface UndatedPlaceGroup {
	title: string;
	places: PlaceScheduleEntry[];
}

export interface PlaceSchedule {
	dateGroups: PlaceDateGroup[];
	undatedGroups: UndatedPlaceGroup[];
	datedCount: number;
	undatedCount: number;
	outsideTripCount: number;
	totalPlaces: number;
}


/**
 * Build a read-only chronological view of place rows without changing the
 * outliner's hierarchy or sort_order. Non-place rows only contribute
 * breadcrumb context.
 */
export function buildPlaceSchedule(
	items: PlaceScheduleSource[],
	tripStart: string | null,
	tripEnd: string | null
): PlaceSchedule {
	const rows = flattenTree(items);
	const byId = new Map(items.map((item) => [item.id, item]));

	function ancestorTitles(item: PlaceScheduleSource): string[] {
		const titles: string[] = [];
		const seen = new Set<number>([item.id]);
		let parentId = item.parent_id;
		while (parentId !== null && !seen.has(parentId)) {
			seen.add(parentId);
			const parent = byId.get(parentId);
			if (!parent) break;
			titles.unshift(parent.title);
			parentId = parent.parent_id;
		}
		return titles;
	}

	const places = rows
		.filter(({ node }) => node.item_type === 'place')
		.map(({ node }) => {
			const ancestors = ancestorTitles(node);
			return {
				id: node.id,
				title: node.title,
				notes: node.notes,
				date: node.date,
				ancestorTitles: ancestors,
				branchTitle: ancestors[0] ?? 'Top level',
				lat: node.lat,
				lon: node.lon,
				place_id: node.place_id,
				apple_maps_place_id: node.apple_maps_place_id
			} satisfies PlaceScheduleEntry;
		});

	const datedByDate = new Map<string, PlaceScheduleEntry[]>();
	const undated = places.filter((place) => {
		if (!place.date) return true;
		const group = datedByDate.get(place.date);
		if (group) group.push(place);
		else datedByDate.set(place.date, [place]);
		return false;
	});

	const dateGroups = [...datedByDate.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([date, datedPlaces]) => ({
			date,
			status: dateStatus(date, tripStart, tripEnd),
			places: datedPlaces
		}));

	const undatedByBranch = new Map<string, PlaceScheduleEntry[]>();
	for (const place of undated) {
		const group = undatedByBranch.get(place.branchTitle);
		if (group) group.push(place);
		else undatedByBranch.set(place.branchTitle, [place]);
	}

	return {
		dateGroups,
		undatedGroups: [...undatedByBranch.entries()].map(([title, undatedPlaces]) => ({
			title,
			places: undatedPlaces
		})),
		datedCount: places.length - undated.length,
		undatedCount: undated.length,
		outsideTripCount: dateGroups
			.filter((group) => group.status === 'before' || group.status === 'after')
			.reduce((sum, group) => sum + group.places.length, 0),
		totalPlaces: places.length
	};
}
