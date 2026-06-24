import { describe, it, expect } from 'vitest';
import {
	googleMapsLink,
	appleMapsLink,
	googleDirectionsLink,
	googleDayDirectionsLink,
	googleLegByLegLinks,
	dayPlanDirectionsLink
} from './maplinks';

describe('googleMapsLink', () => {
	it('uses place_id when present', () => {
		const u = googleMapsLink({ name: 'Palais des Papes', place_id: 'CHIJabc' });
		expect(u).toContain('query_place_id=CHIJabc');
		expect(u).toContain('query=Palais%20des%20Papes');
	});
	it('uses a name search even when coordinates exist', () => {
		expect(googleMapsLink({ name: 'Arborvine', lat: 44.4115, lon: -68.5924 })).toContain(
			'query=Arborvine'
		);
	});
	it('uses coordinates only when no name exists', () => {
		expect(googleMapsLink({ name: '', lat: 43.95, lon: 4.81 })).toContain('query=43.95%2C4.81');
	});
	it('falls back to a name search', () => {
		expect(googleMapsLink({ name: 'Pont du Gard' })).toContain('query=Pont%20du%20Gard');
	});
});

describe('appleMapsLink', () => {
	it('uses a name search when a name exists', () => {
		const u = appleMapsLink({ name: 'Arles', lat: 43.67, lon: 4.63 });
		expect(u).toContain('q=Arles');
		expect(u).not.toContain('ll=');
	});
	it('includes ll when only coordinates exist', () => {
		const u = appleMapsLink({ name: '', lat: 43.67, lon: 4.63 });
		expect(u).toContain('ll=43.67%2C4.63');
	});
	it('name-only still produces a query', () => {
		expect(appleMapsLink({ name: 'Arles' })).toBe('https://maps.apple.com/?q=Arles');
	});
});

describe('googleDirectionsLink', () => {
	it('targets coordinates', () => {
		expect(googleDirectionsLink({ name: 'X', lat: 1, lon: 2 })).toContain('destination=1%2C2');
	});
	it('targets place_id', () => {
		expect(googleDirectionsLink({ name: 'X', place_id: 'PID' })).toContain(
			'destination_place_id=PID'
		);
	});
});

describe('googleDayDirectionsLink', () => {
	it('returns null for fewer than 2 usable places', () => {
		expect(googleDayDirectionsLink([])).toBeNull();
		expect(googleDayDirectionsLink([{ name: 'only' }])).toBeNull();
	});
	it('chains origin, destination, and waypoints in order', () => {
		const u = googleDayDirectionsLink([
			{ name: 'A', lat: 1, lon: 1 },
			{ name: 'B', lat: 2, lon: 2 },
			{ name: 'C', lat: 3, lon: 3 }
		]) as string;
		expect(u).toContain('origin=1%2C1');
		expect(u).toContain('destination=3%2C3');
		expect(u).toContain('waypoints=2%2C2');
	});
	it('mixes names and coordinates', () => {
		const u = googleDayDirectionsLink([
			{ name: 'Start' },
			{ name: 'End', lat: 9, lon: 9 }
		]) as string;
		expect(u).toContain('origin=Start');
		expect(u).toContain('destination=9%2C9');
		expect(u).not.toContain('waypoints=');
	});
});

describe('googleLegByLegLinks', () => {
	it('returns one link per consecutive pair', () => {
		const legs = googleLegByLegLinks([
			{ name: 'A', lat: 1, lon: 1 },
			{ name: 'B' },
			{ name: 'C', lat: 3, lon: 3 }
		]);
		expect(legs).toHaveLength(2);
		expect(legs?.[0].from).toBe('A');
		expect(legs?.[0].to).toBe('B');
		expect(legs?.[0].url).toContain('origin=1%2C1');
		expect(legs?.[0].url).toContain('destination=B');
		expect(legs?.[1].url).toContain('destination=3%2C3');
	});
	it('returns null for fewer than two usable places', () => {
		expect(googleLegByLegLinks([{ name: 'A' }])).toBeNull();
	});
});

describe('dayPlanDirectionsLink', () => {
	it('uses snapshot fields for route links', () => {
		const u = dayPlanDirectionsLink([
			{
				snapshot_title: 'Start',
				snapshot_lat: null,
				snapshot_lon: null,
				snapshot_place_id: null
			},
			{
				snapshot_title: 'End',
				snapshot_lat: 4,
				snapshot_lon: 5,
				snapshot_place_id: null
			}
		]) as string;
		expect(u).toContain('origin=Start');
		expect(u).toContain('destination=4%2C5');
	});
});
