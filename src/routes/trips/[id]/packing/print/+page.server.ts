import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getTrip } from '$server/trips';
import { listPackingLists, getPackingItemsForTrip } from '$server/packing';
import { flattenTree } from '$server/tree';

function parseId(param: string): number {
	const id = Number(param);
	if (!Number.isInteger(id) || id <= 0) throw error(404, 'Not found');
	return id;
}

function parseCollapsed(value: string | null): number[] {
	if (!value) return [];
	return value
		.split(',')
		.map(Number)
		.filter((id) => Number.isInteger(id) && id > 0);
}

export const load: PageServerLoad = async ({ params, locals, url }) => {
	if (!locals.ownerId) throw error(500, 'No owner configured');
	const tripId = parseId(params.id);

	const trip = await getTrip(locals.ownerId, tripId);
	if (!trip) throw error(404, 'Trip not found');

	const [lists, itemsByList] = await Promise.all([
		listPackingLists(tripId),
		getPackingItemsForTrip(tripId)
	]);

	const packing = lists.map((list) => {
		const items = itemsByList.get(list.id) ?? [];
		const parentOf = new Set(items.filter((i) => i.parent_id != null).map((i) => i.parent_id));
		const leaves = items.filter((i) => !parentOf.has(i.id));
		const checked = leaves.filter((i) => i.checked).length;
		return { list, rows: flattenTree(items), total: leaves.length, checked };
	});

	return {
		trip,
		packing,
		collapsedIds: parseCollapsed(url.searchParams.get('collapsed'))
	};
};
