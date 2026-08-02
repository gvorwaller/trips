import { describe, expect, it } from 'vitest';
import {
	buildAllDayCalendar,
	escapeText,
	foldLine,
	icsDate,
	icsDatePlusDays,
	icsDateTimeUtc
} from './ics';

const encoder = new TextEncoder();
const octets = (s: string) => encoder.encode(s).length;

describe('escapeText (RFC 5545 §3.3.11)', () => {
	it('escapes backslash, semicolon, comma and newline', () => {
		expect(escapeText('a\\b;c,d\ne')).toBe('a\\\\b\\;c\\,d\\ne');
	});

	it('escapes the backslash first, so added escapes are not double-escaped', () => {
		// Naive ordering would turn this into '\\\\;' — an escaped backslash
		// followed by a RAW semicolon, which breaks the property.
		expect(escapeText('\\;')).toBe('\\\\\\;');
	});

	it('normalises CRLF and bare CR to the \\n escape', () => {
		expect(escapeText('a\r\nb\rc')).toBe('a\\nb\\nc');
	});

	it('leaves ordinary text alone', () => {
		expect(escapeText('Blue Hill Overlook')).toBe('Blue Hill Overlook');
	});
});

describe('foldLine (RFC 5545 §3.1)', () => {
	it('leaves a short line unfolded', () => {
		expect(foldLine('SUMMARY:Short')).toBe('SUMMARY:Short');
	});

	it('folds with CRLF + a single space', () => {
		const folded = foldLine('SUMMARY:' + 'a'.repeat(200));
		expect(folded).toContain('\r\n ');
	});

	it('keeps every physical line within 75 octets', () => {
		const folded = foldLine('DESCRIPTION:' + 'abcdefghij'.repeat(30));
		for (const line of folded.split('\r\n')) {
			expect(octets(line)).toBeLessThanOrEqual(75);
		}
	});

	it('never splits a multi-byte character', () => {
		// Emoji are 4 octets; a naive per-character or per-byte fold corrupts them.
		const folded = foldLine('SUMMARY:' + '🚗'.repeat(40));
		for (const line of folded.split('\r\n')) {
			expect(octets(line)).toBeLessThanOrEqual(75);
		}
		// Round-tripping proves no code point was cut in half.
		expect(folded.split('\r\n ').join('')).toBe('SUMMARY:' + '🚗'.repeat(40));
	});

	it('handles accented multi-byte text', () => {
		const folded = foldLine('LOCATION:' + 'Café Miramichi — Nouveau-Brunswick '.repeat(6));
		for (const line of folded.split('\r\n')) {
			expect(octets(line)).toBeLessThanOrEqual(75);
		}
	});

	it('accounts for the continuation space in the budget', () => {
		const folded = foldLine('X:' + 'a'.repeat(300));
		const lines = folded.split('\r\n');
		// Every continuation begins with the fold space, and is still <= 75 octets
		// INCLUDING it — the space is not free.
		for (const line of lines.slice(1)) {
			expect(line.startsWith(' ')).toBe(true);
			expect(octets(line)).toBeLessThanOrEqual(75);
		}
	});
});

describe('date helpers', () => {
	it('renders a DATE value', () => {
		expect(icsDate('2026-07-29')).toBe('20260729');
	});

	it('advances a DATE across a month boundary', () => {
		expect(icsDatePlusDays('2026-07-31', 1)).toBe('20260801');
	});

	it('advances across a year boundary', () => {
		expect(icsDatePlusDays('2026-12-31', 1)).toBe('20270101');
	});

	it('handles a leap day', () => {
		expect(icsDatePlusDays('2028-02-28', 1)).toBe('20280229');
	});

	it('renders a UTC DATE-TIME', () => {
		expect(icsDateTimeUtc('2026-08-02T15:04:05.123Z')).toBe('20260802T150405Z');
	});

	it('rejects an unparseable timestamp instead of emitting Invalid Date', () => {
		expect(() => icsDateTimeUtc('not a date')).toThrow('Invalid timestamp');
	});
});

describe('buildAllDayCalendar', () => {
	const event = {
		uid: 'dayplan-36@trips.gaylon.photos',
		dtstamp: '2026-08-02T15:04:05Z',
		date: '2026-07-29',
		summary: 'Seal Cove — Maine 2026',
		description: '1. Bass Harbor Head\n2. Seal Cove Pond',
		location: 'Blue Hill, ME',
		url: 'https://trips.gaylon.photos/trips/36?a=1&b=2'
	};

	it('emits the required VCALENDAR and VEVENT properties', () => {
		const out = buildAllDayCalendar(event, '-//test//EN');
		for (const prop of [
			'BEGIN:VCALENDAR',
			'VERSION:2.0',
			'PRODID:',
			'BEGIN:VEVENT',
			'UID:dayplan-36@trips.gaylon.photos',
			'DTSTAMP:20260802T150405Z',
			'END:VEVENT',
			'END:VCALENDAR'
		]) {
			expect(out).toContain(prop);
		}
	});

	it('ends every line with CRLF, including the last', () => {
		const out = buildAllDayCalendar(event, '-//test//EN');
		expect(out.endsWith('\r\n')).toBe(true);
		expect(out.split('\r\n').filter(Boolean).length).toBeGreaterThan(5);
		// No bare LF anywhere.
		expect(out.replace(/\r\n/g, '')).not.toContain('\n');
	});

	it('makes DTEND exclusive — the day after a one-day event', () => {
		const out = buildAllDayCalendar(event, '-//test//EN');
		expect(out).toContain('DTSTART;VALUE=DATE:20260729');
		expect(out).toContain('DTEND;VALUE=DATE:20260730');
	});

	it('escapes the description but NOT the URL', () => {
		const out = buildAllDayCalendar(event, '-//test//EN');
		expect(out).toContain('DESCRIPTION:1. Bass Harbor Head\\n2. Seal Cove Pond');
		// A TEXT-escaped URL would turn & into \& and break the link.
		expect(out).toContain('URL:https://trips.gaylon.photos/trips/36?a=1&b=2');
	});

	it('is deterministic for a fixed dtstamp', () => {
		expect(buildAllDayCalendar(event, '-//test//EN')).toBe(
			buildAllDayCalendar(event, '-//test//EN')
		);
	});

	it('omits optional properties that are absent', () => {
		const out = buildAllDayCalendar(
			{ uid: 'u', dtstamp: event.dtstamp, date: '2026-07-29', summary: 'Bare' },
			'-//test//EN'
		);
		expect(out).not.toContain('DESCRIPTION:');
		expect(out).not.toContain('LOCATION:');
		expect(out).not.toContain('URL:');
	});
});
