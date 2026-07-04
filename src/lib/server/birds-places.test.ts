import { describe, expect, it } from 'vitest';
import { birdsPlacesToItineraryCandidates, type BirdsTripPlace } from './birds-places';

describe('birdsPlacesToItineraryCandidates', () => {
	it('maps Birds trip places into itinerary candidates with source metadata', () => {
		const place: BirdsTripPlace = {
			source: 'birds',
			source_id: 'birds:trip_stop:10',
			birds_trip_id: 2,
			birds_trip_name: 'Coast run',
			birds_trip_start_date: '2026-07-04',
			birds_trip_end_date: null,
			stop_id: 10,
			sort_order: 0,
			name: 'Harbor Point',
			lat: 44.3,
			lon: -68.2,
			google_place_id: 'place-harbor',
			hotspot_id: 'L123',
			notes: 'Check tide',
			field_tip: 'Scope early',
			field_tip_generated_at: '2026-07-04T12:00:00.000Z',
			target_count_at_save: 4
		};

		expect(birdsPlacesToItineraryCandidates([place])).toEqual([
			{
				item_type: 'place',
				title: 'Harbor Point',
				notes:
					'Imported from Birds trip: Coast run\n' +
					'Birds trip dates: 2026-07-04\n' +
					'Check tide\n' +
					'Field tip: Scope early\n' +
					'eBird hotspot: L123\n' +
					'Targets at save: 4',
				external_url: null,
				address: null,
				location_query: null,
				lat: 44.3,
				lon: -68.2,
				place_id: 'place-harbor',
				apple_maps_place_id: null,
				meta: {
					source_app: 'birds',
					source_id: 'birds:trip_stop:10',
					birds_trip_id: 2,
					birds_stop_id: 10,
					birds_hotspot_id: 'L123',
					birds_trip_name: 'Coast run'
				},
				children: []
			}
		]);
	});
});
