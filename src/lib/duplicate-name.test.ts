import { describe, expect, it } from 'vitest';
import { duplicateTripName } from './duplicate-name';

describe('duplicateTripName', () => {
	it('appends a minute-precision date/time stamp', () => {
		const name = duplicateTripName('Maine 2026', new Date(2026, 5, 25, 11, 18, 42));

		expect(name).toBe('Maine 2026 (copy) 2026-06-25 11:18');
	});

	it('zero-pads date and time fields', () => {
		const name = duplicateTripName('Trip', new Date(2026, 0, 2, 3, 4));

		expect(name).toBe('Trip (copy) 2026-01-02 03:04');
	});
});
