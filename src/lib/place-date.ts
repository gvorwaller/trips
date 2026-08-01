/**
 * Pure date helpers for places (td-e00086).
 *
 * Lives in $lib rather than $lib/server because the schedule page needs to warn
 * about out-of-range dates as the user types, and SvelteKit blocks $lib/server
 * imports from client code at build time. The server-side schedule builder
 * imports `dateStatus` from here rather than keeping its own copy.
 */

export const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export type PlaceDateStatus = 'before' | 'during' | 'after' | 'unknown';

/**
 * Where a date falls relative to the trip. Lexicographic comparison is safe for
 * YYYY-MM-DD, which is how dates cross the SQL boundary throughout this app.
 *
 * Note a trip with only one bound set reports everything on the open side as
 * 'during' — deliberately permissive, since this only drives an advisory label.
 */
export function dateStatus(
	date: string,
	tripStart: string | null,
	tripEnd: string | null
): PlaceDateStatus {
	if (tripStart && date < tripStart) return 'before';
	if (tripEnd && date > tripEnd) return 'after';
	if (tripStart || tripEnd) return 'during';
	return 'unknown';
}

/** Human label for an out-of-range date, or null when it needs no warning. */
export function rangeWarning(status: PlaceDateStatus): string | null {
	if (status === 'before') return 'Before trip';
	if (status === 'after') return 'After trip';
	return null;
}

/**
 * Validate a submitted date. An empty string is valid and means "clear the
 * date" — place dates are optional, and clearing one is a normal edit, not an
 * error. Anything else must be a well-formed YYYY-MM-DD.
 */
export function parsePlaceDate(raw: unknown): { date: string | null } | { error: string } {
	const s = (raw ?? '').toString().trim();
	if (!s) return { date: null };
	if (!YMD_RE.test(s)) return { error: 'Date must be in YYYY-MM-DD form.' };
	// Reject calendar-invalid values that still match the pattern (2026-02-31).
	const [y, m, d] = s.split('-').map(Number);
	const probe = new Date(Date.UTC(y, m - 1, d));
	if (
		probe.getUTCFullYear() !== y ||
		probe.getUTCMonth() !== m - 1 ||
		probe.getUTCDate() !== d
	) {
		return { error: 'That date does not exist.' };
	}
	return { date: s };
}
