import { describe, it, expect } from 'vitest';
import {
	googleMapsLink,
	appleMapsLink,
	googleDirectionsLink,
	googleDayDirectionsLink
} from './maplinks';

describe('googleMapsLink', () => {
	it('uses place_id when present', () => {
		const u = googleMapsLink({ name: 'Palais des Papes', place_id: 'CHIJabc' });
		expect(u).toContain('query_place_id=CHIJabc');
		expect(u).toContain('query=Palais%20des%20Papes');
	});
	it('uses coordinates when no place_id', () => {
		expect(googleMapsLink({ name: 'X', lat: 43.95, lon: 4.81 })).toContain('query=43.95%2C4.81');
	});
	it('falls back to a name search', () => {
		expect(googleMapsLink({ name: 'Pont du Gard' })).toContain('query=Pont%20du%20Gard');
	});
});

describe('appleMapsLink', () => {
	it('includes ll when coordinates exist', () => {
		const u = appleMapsLink({ name: 'Arles', lat: 43.67, lon: 4.63 });
		expect(u).toContain('ll=43.67%2C4.63');
		expect(u).toContain('q=Arles');
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
