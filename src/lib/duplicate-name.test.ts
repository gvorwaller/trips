import { describe, expect, it } from 'vitest';
import { duplicateTripName, duplicateTripTimestamp } from './duplicate-name';

describe('duplicateTripName', () => {
	it('appends a browser-timezone minute-precision date/time stamp', () => {
		const instant = new Date('2026-06-25T15:18:42Z');
		const name = duplicateTripName('Maine 2026', instant, 'America/New_York');

		expect(name).toBe('Maine 2026 (copy) 2026-06-25 11:18');
	});

	it('zero-pads date and time fields in the requested timezone', () => {
		const instant = new Date('2026-01-02T08:04:00Z');
		const name = duplicateTripName('Trip', instant, 'America/New_York');

		expect(name).toBe('Trip (copy) 2026-01-02 03:04');
	});

	it('does not throw on invalid timezone input', () => {
		expect(duplicateTripTimestamp(new Date('2026-01-02T08:04:00Z'), 'bad/timezone')).toMatch(
			/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/
		);
	});
});
