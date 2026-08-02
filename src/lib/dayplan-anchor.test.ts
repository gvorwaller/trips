import { describe, expect, it } from 'vitest';
import {
	anchorFromValue,
	anchorOptions,
	dateMatchesReservation,
	matchingPlaceForReservation,
	type AnchorPlace,
	type AnchorReservation,
	type PlanAnchor
} from './dayplan-anchor';

const LODGING: AnchorPlace = {
	id: 700,
	title: 'Summit Sanctuary - Minutes to Downtown Blue Hill!',
	lat: 44.41,
	lon: -68.59
};
const MUSEUM: AnchorPlace = { id: 502, title: 'Blue Hill, ME', lat: 44.45, lon: -68.52 };
const PLACES = [LODGING, MUSEUM];

/**
 * The real reservation that produced the defect: a mistyped year puts the stay
 * in 2020 while the plans it anchors are in 2026.
 */
const STAY_2020: AnchorReservation = {
	id: 21,
	title: 'Summit Sanctuary - Minutes to Downtown Blue Hill!',
	reservation_type: 'accommodation',
	start_at: '2020-07-27T15:00:00Z',
	end_at: '2020-08-07T11:00:00Z'
};

const SAVED_ANCHOR: PlanAnchor = {
	source: 'res:21',
	title: 'Stay: Summit Sanctuary - Minutes to Downtown Blue Hill!',
	lat: 44.41,
	lon: -68.59
};

describe('a saved anchor stays resolvable when its reservation is filtered out', () => {
	it('excludes the out-of-range reservation from the offered options', () => {
		const options = anchorOptions('2026-07-03', [STAY_2020], PLACES);
		expect(options.some((o) => o.value === 'res:21')).toBe(false);
	});

	it('still offers it when the plan carries it as its persisted anchor', () => {
		const options = anchorOptions('2026-07-03', [STAY_2020], PLACES, SAVED_ANCHOR);
		expect(options.find((o) => o.value === 'res:21')?.lat).toBe(44.41);
	});

	it('RESOLVES the persisted anchor — the regression guard', () => {
		// Without currentAnchor this returned null, which turned an anchored loop
		// into an open path: optimize planned from stop 1 instead of the lodging,
		// the server rejected the resulting leg count, and the saved driving data
		// was already gone.
		expect(anchorFromValue('res:21', '2026-07-03', [STAY_2020], PLACES, SAVED_ANCHOR)).toEqual(
			SAVED_ANCHOR
		);
	});

	it('resolves to null without the persisted anchor, documenting why it must be passed', () => {
		expect(anchorFromValue('res:21', '2026-07-03', [STAY_2020], PLACES)).toBeNull();
	});

	it('does not duplicate the option when the reservation date does match', () => {
		const options = anchorOptions('2020-07-28', [STAY_2020], PLACES, SAVED_ANCHOR);
		expect(options.filter((o) => o.value === 'res:21')).toHaveLength(1);
	});

	it('resolves a place anchor with no help, since places are never date-filtered', () => {
		// Why Seal Cove (place:502) worked while Scenic loop (res:21) did not.
		expect(anchorFromValue('place:502', '2026-07-03', [STAY_2020], PLACES)).toEqual({
			source: 'place:502',
			title: 'Place: Blue Hill, ME',
			lat: 44.45,
			lon: -68.52
		});
	});
});

describe('dateMatchesReservation', () => {
	it('matches a date inside the stay', () => {
		expect(dateMatchesReservation('2020-07-28', STAY_2020)).toBe(true);
	});

	it('matches the first and last day', () => {
		expect(dateMatchesReservation('2020-07-27', STAY_2020)).toBe(true);
		expect(dateMatchesReservation('2020-08-07', STAY_2020)).toBe(true);
	});

	it('rejects a date outside the stay', () => {
		expect(dateMatchesReservation('2026-07-03', STAY_2020)).toBe(false);
	});

	it('matches an undated plan, so nothing is hidden before a date is set', () => {
		expect(dateMatchesReservation(null, STAY_2020)).toBe(true);
	});

	it('matches an open-ended reservation', () => {
		expect(
			dateMatchesReservation('2026-07-03', { start_at: null, end_at: null })
		).toBe(true);
	});

	it('treats a start with no end as a single day', () => {
		const oneDay = { start_at: '2026-07-03T12:00:00Z', end_at: null };
		expect(dateMatchesReservation('2026-07-03', oneDay)).toBe(true);
		expect(dateMatchesReservation('2026-07-04', oneDay)).toBe(false);
	});
});

describe('anchorOptions composition', () => {
	it('always leads with the no-anchor choice', () => {
		expect(anchorOptions(null, [], [])[0]).toMatchObject({ value: 'none', lat: null });
	});

	it('offers every located place', () => {
		const values = anchorOptions(null, [], PLACES).map((o) => o.value);
		expect(values).toEqual(['none', 'place:700', 'place:502']);
	});

	it('skips places without coordinates', () => {
		const unlocated: AnchorPlace = { id: 9, title: 'Somewhere', lat: null, lon: null };
		const values = anchorOptions(null, [], [MUSEUM, unlocated]).map((o) => o.value);
		expect(values).toEqual(['none', 'place:502']);
	});

	it('ignores reservations that are not accommodation', () => {
		const dinner = { ...STAY_2020, id: 5, reservation_type: 'restaurant' };
		expect(anchorOptions('2020-07-28', [dinner], PLACES).some((o) => o.value === 'res:5')).toBe(
			false
		);
	});

	it('drops a matching reservation with no located place to borrow coordinates from', () => {
		const orphan = { ...STAY_2020, id: 8, title: 'Unmatched Lodge' };
		expect(anchorOptions('2020-07-28', [orphan], [MUSEUM]).some((o) => o.value === 'res:8')).toBe(
			false
		);
	});
});

describe('matchingPlaceForReservation', () => {
	it('matches on a normalised exact title', () => {
		expect(matchingPlaceForReservation(STAY_2020, PLACES)?.id).toBe(700);
	});

	it('matches when the place title contains the reservation title', () => {
		const short = { title: 'Summit Sanctuary' };
		expect(matchingPlaceForReservation(short, PLACES)?.id).toBe(700);
	});

	it('ignores punctuation and case differences', () => {
		const noisy = { title: 'SUMMIT   SANCTUARY -- minutes to downtown blue hill!!!' };
		expect(matchingPlaceForReservation(noisy, PLACES)?.id).toBe(700);
	});

	it('returns undefined when nothing matches', () => {
		expect(matchingPlaceForReservation({ title: 'Nowhere Inn' }, [MUSEUM])).toBeUndefined();
	});
});
