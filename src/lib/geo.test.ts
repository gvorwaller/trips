import { describe, expect, it } from 'vitest';
import { formatDistance, formatKm, formatMiles } from './geo';

describe('distance formatting', () => {
	it('keeps kilometre formatting for existing callers', () => {
		expect(formatKm(4.24)).toBe('4.2 km');
		expect(formatKm(12.7)).toBe('13 km');
	});

	it('formats miles from stored kilometres', () => {
		expect(formatMiles(4.24)).toBe('2.6 mi');
		expect(formatMiles(21)).toBe('13 mi');
	});

	it('defaults display distances to miles and supports kilometres', () => {
		expect(formatDistance(10)).toBe('6.2 mi');
		expect(formatDistance(10, 'km')).toBe('10 km');
	});
});
