import { describe, expect, it } from 'vitest';
import { dateStatus, parsePlaceDate, rangeWarning } from './place-date';

describe('dateStatus', () => {
	it('classifies against both bounds', () => {
		expect(dateStatus('2026-07-26', '2026-07-27', '2026-08-07')).toBe('before');
		expect(dateStatus('2026-07-30', '2026-07-27', '2026-08-07')).toBe('during');
		expect(dateStatus('2026-08-08', '2026-07-27', '2026-08-07')).toBe('after');
	});
	it('treats the bounds themselves as inside the trip', () => {
		expect(dateStatus('2026-07-27', '2026-07-27', '2026-08-07')).toBe('during');
		expect(dateStatus('2026-08-07', '2026-07-27', '2026-08-07')).toBe('during');
	});
	it('is unknown when the trip has no dates at all', () => {
		expect(dateStatus('2026-07-30', null, null)).toBe('unknown');
	});
	it('is permissive on the open side when only one bound is set', () => {
		expect(dateStatus('2020-01-01', null, '2026-08-07')).toBe('during');
		expect(dateStatus('2030-01-01', '2026-07-27', null)).toBe('during');
	});
});

describe('rangeWarning', () => {
	it('labels only out-of-range statuses', () => {
		expect(rangeWarning('before')).toBe('Before trip');
		expect(rangeWarning('after')).toBe('After trip');
		expect(rangeWarning('during')).toBeNull();
		expect(rangeWarning('unknown')).toBeNull();
	});
});

describe('parsePlaceDate', () => {
	it('treats empty input as clearing the date, not an error', () => {
		expect(parsePlaceDate('')).toEqual({ date: null });
		expect(parsePlaceDate('   ')).toEqual({ date: null });
		expect(parsePlaceDate(null)).toEqual({ date: null });
		expect(parsePlaceDate(undefined)).toEqual({ date: null });
	});
	it('accepts a well-formed date', () => {
		expect(parsePlaceDate('2026-07-30')).toEqual({ date: '2026-07-30' });
		expect(parsePlaceDate('  2026-07-30  ')).toEqual({ date: '2026-07-30' });
	});
	it('rejects malformed input', () => {
		expect(parsePlaceDate('30/07/2026')).toHaveProperty('error');
		expect(parsePlaceDate('2026-7-30')).toHaveProperty('error');
		expect(parsePlaceDate('nonsense')).toHaveProperty('error');
	});
	it('rejects calendar-invalid dates that still match the pattern', () => {
		expect(parsePlaceDate('2026-02-31')).toHaveProperty('error');
		expect(parsePlaceDate('2026-13-01')).toHaveProperty('error');
	});
	it('accepts a real leap day', () => {
		expect(parsePlaceDate('2028-02-29')).toEqual({ date: '2028-02-29' });
	});
});
