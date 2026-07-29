import { describe, expect, it } from 'vitest';
import { buildPlaceSchedule, type PlaceScheduleSource } from './place-schedule';

function item(
	id: number,
	parent_id: number | null,
	sort_order: number,
	item_type: string,
	title: string,
	date: string | null = null
): PlaceScheduleSource {
	return {
		id,
		parent_id,
		sort_order,
		item_type,
		title,
		notes: null,
		date,
		lat: null,
		lon: null,
		place_id: null,
		apple_maps_place_id: null
	};
}

const tree: PlaceScheduleSource[] = [
	item(1, null, 0, 'place', 'Blue Hill'),
	item(2, 1, 0, 'place', 'Farmers Market', '2026-07-29'),
	item(3, null, 1, 'section', 'Birding'),
	item(4, 3, 0, 'place', 'Seal Cove', '2026-07-28'),
	item(5, 3, 1, 'note', 'Bring binoculars', '2026-07-30'),
	item(6, 3, 2, 'section', 'Acadia'),
	item(7, 6, 0, 'place', 'Beech Mountain'),
	item(8, null, 2, 'place', 'Late Cruise', '2026-08-08'),
	item(9, null, 3, 'place', 'Old Cemetery', '2026-07-20')
];

describe('buildPlaceSchedule', () => {
	it('groups only places by date and preserves hierarchy order within a day', () => {
		const schedule = buildPlaceSchedule(tree, '2026-07-27', '2026-08-07');

		expect(schedule.totalPlaces).toBe(6);
		expect(schedule.datedCount).toBe(4);
		expect(schedule.undatedCount).toBe(2);
		expect(schedule.dateGroups.map((group) => group.date)).toEqual([
			'2026-07-20',
			'2026-07-28',
			'2026-07-29',
			'2026-08-08'
		]);
		expect(schedule.dateGroups[1].places.map((place) => place.title)).toEqual(['Seal Cove']);
		expect(
			schedule.dateGroups.flatMap((group) => group.places).some((place) => place.id === 5)
		).toBe(false);
	});

	it('adds breadcrumbs and groups undated places by their top-level branch', () => {
		const schedule = buildPlaceSchedule(tree, '2026-07-27', '2026-08-07');
		const beech = schedule.undatedGroups
			.flatMap((group) => group.places)
			.find((place) => place.id === 7);

		expect(beech?.ancestorTitles).toEqual(['Birding', 'Acadia']);
		expect(schedule.undatedGroups.map((group) => group.title)).toEqual(['Top level', 'Birding']);
		expect(schedule.undatedGroups[0].places.map((place) => place.title)).toEqual(['Blue Hill']);
	});

	it('flags dates before and after the trip without treating missing bounds as outside', () => {
		const bounded = buildPlaceSchedule(tree, '2026-07-27', '2026-08-07');
		expect(bounded.dateGroups.map((group) => group.status)).toEqual([
			'before',
			'during',
			'during',
			'after'
		]);
		expect(bounded.outsideTripCount).toBe(2);

		const unbounded = buildPlaceSchedule(tree, null, null);
		expect(unbounded.dateGroups.every((group) => group.status === 'unknown')).toBe(true);
		expect(unbounded.outsideTripCount).toBe(0);
	});
});
