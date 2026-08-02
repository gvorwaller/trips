/**
 * Minimal RFC 5545 (iCalendar) writer.
 *
 * Verified against https://www.rfc-editor.org/rfc/rfc5545.html rather than
 * memory, because every rule here has a silent failure mode: a calendar client
 * that rejects the file, or worse, imports it with mangled text.
 *
 * Rules implemented:
 *  - §3.1 content lines end CRLF, and lines longer than 75 OCTETS are folded
 *    with CRLF + a single space. Octets, not characters — so folding must not
 *    split a multi-byte UTF-8 sequence, and the leading space of a continuation
 *    counts toward the next line's budget.
 *  - §3.3.11 TEXT escapes backslash, semicolon, comma and newline. Order
 *    matters: backslash first, or the escapes we add get escaped again.
 *  - §3.6.1 DTEND for a DATE value is EXCLUSIVE, so a one-day all-day event
 *    ends on the following day.
 *  - §3.6 VCALENDAR requires PRODID + VERSION; VEVENT requires UID + DTSTAMP.
 *  - URI-valued properties (URL) are NOT text-escaped.
 */

const CRLF = '\r\n';
const MAX_OCTETS = 75;

/** Escape a TEXT value. Backslash must be replaced first. */
export function escapeText(value: string): string {
	return value
		.replace(/\\/g, '\\\\')
		.replace(/;/g, '\\;')
		.replace(/,/g, '\\,')
		.replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Fold one content line to 75 octets per line.
 *
 * Walks by code point and measures UTF-8 byte length, so a multi-byte character
 * is never split across a fold — which would produce invalid UTF-8, not merely
 * an ugly line. Continuation lines start with a space that consumes one octet.
 */
export function foldLine(line: string): string {
	const encoder = new TextEncoder();
	if (encoder.encode(line).length <= MAX_OCTETS) return line;

	const out: string[] = [];
	let current = '';
	let currentOctets = 0;
	let budget = MAX_OCTETS;

	for (const char of line) {
		const size = encoder.encode(char).length;
		if (currentOctets + size > budget) {
			out.push(current);
			current = char;
			currentOctets = size;
			// Continuation lines are prefixed with one space when joined.
			budget = MAX_OCTETS - 1;
		} else {
			current += char;
			currentOctets += size;
		}
	}
	out.push(current);
	return out.join(`${CRLF} `);
}

/** A DATE value: YYYYMMDD. */
export function icsDate(isoDate: string): string {
	return isoDate.slice(0, 10).replace(/-/g, '');
}

/** DTEND for an all-day event is exclusive — the day after the last day. */
export function icsDatePlusDays(isoDate: string, days: number): string {
	const d = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/** A UTC DATE-TIME value: YYYYMMDDTHHMMSSZ. */
export function icsDateTimeUtc(value: string | Date): string {
	const d = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(d.getTime())) throw new Error('Invalid timestamp for iCalendar.');
	return `${d.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
}

export interface IcsAllDayEvent {
	uid: string;
	/** Deterministic — pass the record's updated_at, never a wall clock, or the output is untestable. */
	dtstamp: string | Date;
	/** YYYY-MM-DD. */
	date: string;
	summary: string;
	description?: string | null;
	location?: string | null;
	url?: string | null;
}

/** One all-day VEVENT in its own VCALENDAR. */
export function buildAllDayCalendar(event: IcsAllDayEvent, prodId: string): string {
	const lines = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		`PRODID:${escapeText(prodId)}`,
		'CALSCALE:GREGORIAN',
		'METHOD:PUBLISH',
		'BEGIN:VEVENT',
		`UID:${event.uid}`,
		`DTSTAMP:${icsDateTimeUtc(event.dtstamp)}`,
		`DTSTART;VALUE=DATE:${icsDate(event.date)}`,
		`DTEND;VALUE=DATE:${icsDatePlusDays(event.date, 1)}`,
		`SUMMARY:${escapeText(event.summary)}`
	];
	if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
	if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
	// URL is a URI, not TEXT — escaping it would corrupt the link.
	if (event.url) lines.push(`URL:${event.url}`);
	lines.push('END:VEVENT', 'END:VCALENDAR');

	return lines.map(foldLine).join(CRLF) + CRLF;
}
