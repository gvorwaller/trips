import { describe, expect, it } from 'vitest';
import {
	buildDayPlanIcs,
	buildDayPlanText,
	dayPlanFilename,
	dayPlanRouteLink,
	exceedsMobileWaypoints,
	formatPlanDate,
	MAX_MAPS_URL_LENGTH,
	slugify,
	type ExportPlan,
	type ExportStop
} from './dayplan-export';

const TRIP = { id: 10, name: 'Maine 2026' };

/** Fixed generation time so ICS bytes are assertable. */
const FIXED = { generatedAt: '2026-08-02T15:04:05Z' };

const PLAN: ExportPlan = {
	id: 36,
	title: 'Seal Cove',
	notes: null,
	optional_date: '2026-07-29',
	anchor_title: 'Blue Hill, ME',
	anchor_lat: 44.41,
	anchor_lon: -68.59,
	return_drive_km: 20,
	return_drive_min: 25,
	updated_at: '2026-08-02T15:04:05Z'
};

const stop = (over: Partial<ExportStop> = {}): ExportStop => ({
	snapshot_title: 'Bass Harbor Head',
	snapshot_lat: 44.22,
	snapshot_lon: -68.34,
	snapshot_place_id: null,
	notes: null,
	ai_notes: null,
	visited: false,
	drive_km: 8,
	drive_min: 12,
	...over
});

const STOPS = [
	stop({ snapshot_title: 'Bass Harbor Head' }),
	stop({ snapshot_title: 'Seal Cove Pond', drive_km: 9, drive_min: 14 })
];

describe('buildDayPlanText', () => {
	it('leads with the plan, trip, date, anchor and driving total', () => {
		const out = buildDayPlanText(TRIP, PLAN, STOPS);
		expect(out).toContain('Seal Cove');
		expect(out).toContain('Trip: Maine 2026');
		expect(out).toContain('Date: Wednesday, July 29, 2026');
		expect(out).toContain('Starting from: Blue Hill, ME');
		// 8 + 9 + 20 return = 37 km -> 23 mi
		expect(out).toContain('Driving: 23 mi, 51 min');
	});

	it('numbers the stops in order', () => {
		const out = buildDayPlanText(TRIP, PLAN, STOPS);
		expect(out).toContain('1. Bass Harbor Head');
		expect(out).toContain('2. Seal Cove Pond');
		expect(out.indexOf('1. Bass Harbor')).toBeLessThan(out.indexOf('2. Seal Cove'));
	});

	it('emits BARE urls, never markdown link syntax', () => {
		// The whole point: iMessage linkifies bare URLs, not [label](url).
		const out = buildDayPlanText(TRIP, PLAN, STOPS);
		expect(out).toMatch(/Apple: https:\/\/maps\.apple\.com\/\?/);
		expect(out).toMatch(/Google: https:\/\/www\.google\.com\/maps\/search\//);
		expect(out).not.toMatch(/\]\(http/);
	});

	it('names the anchor on the first leg and "previous" thereafter', () => {
		const out = buildDayPlanText(TRIP, PLAN, STOPS);
		expect(out).toContain('Drive from Blue Hill, ME:');
		expect(out).toContain('Drive from previous:');
	});

	it('closes with the drive home', () => {
		expect(buildDayPlanText(TRIP, PLAN, STOPS)).toContain('Drive home to Blue Hill, ME: 12 mi');
	});

	it('has no drive home for an unanchored plan', () => {
		const open = { ...PLAN, anchor_title: null, anchor_lat: null, anchor_lon: null };
		const out = buildDayPlanText(TRIP, { ...open, return_drive_km: null, return_drive_min: null }, STOPS);
		expect(out).not.toContain('Drive home');
	});

	it('marks visited stops', () => {
		const out = buildDayPlanText(TRIP, PLAN, [stop({ visited: true }), STOPS[1]]);
		expect(out).toContain('1. Bass Harbor Head (visited)');
	});

	it('multiline plan, stop and AI notes cannot forge structure in either format', () => {
		const evil = 'ok line\n# fake heading\n- [x] fake item\nNot included: nothing';
		const plan = { ...PLAN, notes: evil };
		const stops = [stop({ notes: evil, ai_notes: evil }), STOPS[1]];
		for (const markdown of [false, true]) {
			const out = buildDayPlanText(TRIP, plan, stops, { markdown, aiNotes: true });
			// No user-authored line may land at column 0.
			expect(out).not.toMatch(/\n# fake heading/);
			expect(out).not.toMatch(/\n- \[x\] fake item/);
			expect(out).not.toMatch(/\nNot included: nothing/);
			if (markdown) {
				// Structural leaders are backslash-escaped in Markdown.
				expect(out).toContain('\\# fake heading');
				expect(out).toContain('\\- [x] fake item');
			}
		}
	});

	it("includes the user's own stop notes", () => {
		const out = buildDayPlanText(TRIP, PLAN, [stop({ notes: 'Park at the top lot' }), STOPS[1]]);
		expect(out).toContain('Park at the top lot');
	});

	it('omits AI visit notes by default — they are a paragraph each', () => {
		const withAi = [stop({ ai_notes: 'Busy before 10am' }), STOPS[1]];
		expect(buildDayPlanText(TRIP, PLAN, withAi)).not.toContain('Busy before 10am');
	});

	it('includes AI notes when explicitly requested', () => {
		const withAi = [stop({ ai_notes: 'Busy before 10am' }), STOPS[1]];
		expect(buildDayPlanText(TRIP, PLAN, withAi, { aiNotes: true })).toContain('Busy before 10am');
	});

	it('strips the dropdown grouping prefix from the anchor name', () => {
		// Stored as "Place: Blue Hill, ME" for the picker; "Drive home to Place:
		// Blue Hill, ME" reads as noise in something you send to someone.
		const prefixed = { ...PLAN, anchor_title: 'Place: Blue Hill, ME' };
		const out = buildDayPlanText(TRIP, prefixed, STOPS);
		expect(out).toContain('Starting from: Blue Hill, ME');
		expect(out).toContain('Drive home to Blue Hill, ME:');
		expect(out).not.toContain('Place: Blue Hill');
	});

	it('strips a Stay: prefix too', () => {
		const stay = { ...PLAN, anchor_title: 'Stay: Summit Sanctuary' };
		expect(buildDayPlanText(TRIP, stay, STOPS)).toContain('Starting from: Summit Sanctuary');
	});

	it('handles a plan with no stops without inventing a route', () => {
		const out = buildDayPlanText(TRIP, PLAN, []);
		expect(out).toContain('No stops yet.');
		expect(out).not.toContain('Drive home');
	});

	it('converts to kilometres on request', () => {
		expect(buildDayPlanText(TRIP, PLAN, STOPS, { unit: 'km' })).toContain('Driving: 37 km');
	});

	it('collapses runs of blank lines and ends with exactly one newline', () => {
		const out = buildDayPlanText(TRIP, PLAN, STOPS);
		expect(out).not.toMatch(/\n{3}/);
		expect(out.endsWith('\n')).toBe(true);
		expect(out.endsWith('\n\n')).toBe(false);
	});

	it('warns when the route exceeds what a mobile Maps link carries', () => {
		const many = Array.from({ length: 6 }, (_, i) =>
			stop({ snapshot_title: `Stop ${i}`, snapshot_lat: 44 + i * 0.1 })
		);
		const out = buildDayPlanText(TRIP, PLAN, many);
		expect(out).toContain('more stops than a single Google Maps link carries on a phone');
	});

	it('does not warn for a short route', () => {
		expect(buildDayPlanText(TRIP, PLAN, STOPS)).not.toContain('more stops than');
	});
});

describe('exceedsMobileWaypoints', () => {
	it('allows up to 3 intermediate waypoints', () => {
		// anchor + 4 stops = 5 points = origin + 3 waypoints + destination
		expect(exceedsMobileWaypoints(4, true)).toBe(false);
	});

	it('flags a fourth intermediate waypoint', () => {
		expect(exceedsMobileWaypoints(5, true)).toBe(true);
	});

	it('accounts for the missing anchor on an open route', () => {
		expect(exceedsMobileWaypoints(5, false)).toBe(false);
		expect(exceedsMobileWaypoints(6, false)).toBe(true);
	});
});

describe('buildDayPlanIcs', () => {
	it('produces one dated all-day event', () => {
		const out = buildDayPlanIcs(TRIP, PLAN, STOPS, FIXED);
		expect(out).toContain('BEGIN:VEVENT');
		expect(out).toContain('DTSTART;VALUE=DATE:20260729');
		expect(out).toContain('DTEND;VALUE=DATE:20260730');
		expect(out).toContain('SUMMARY:Seal Cove — Maine 2026');
	});

	it('uses a stable UID derived from the plan id', () => {
		expect(buildDayPlanIcs(TRIP, PLAN, STOPS, FIXED)).toContain('UID:dayplan-36@trips.gaylon.photos');
	});

	it('stamps DTSTAMP from the injected generation time, per RFC 5545 3.8.7.2', () => {
		// With METHOD present DTSTAMP is when the FILE was made, not when the plan
		// was last edited. plan.updated_at was wrong twice over: wrong semantics,
		// and stop-level edits (notes, visited) never bump it, so identical stamps
		// could ship different content under one UID.
		const out = buildDayPlanIcs(TRIP, PLAN, STOPS, FIXED);
		expect(out).toContain('DTSTAMP:20260802T150405Z');
		expect(out).toBe(buildDayPlanIcs(TRIP, PLAN, STOPS, FIXED));
	});

	it('changes DTSTAMP when regenerated later, even if the plan did not change', () => {
		const later = { generatedAt: '2026-08-03T09:00:00Z' };
		expect(buildDayPlanIcs(TRIP, PLAN, STOPS, later)).toContain('DTSTAMP:20260803T090000Z');
	});

	it('sets LOCATION to the anchor', () => {
		expect(buildDayPlanIcs(TRIP, PLAN, STOPS, FIXED)).toContain('LOCATION:Blue Hill\\, ME');
	});

	it('falls back to the first stop for LOCATION when unanchored', () => {
		const open = {
			...PLAN,
			anchor_title: null,
			anchor_lat: null,
			anchor_lon: null,
			return_drive_km: null,
			return_drive_min: null
		};
		expect(buildDayPlanIcs(TRIP, open, STOPS, FIXED)).toContain('LOCATION:Bass Harbor Head');
	});

	it('refuses an undated plan rather than inventing today', () => {
		expect(() => buildDayPlanIcs(TRIP, { ...PLAN, optional_date: null }, STOPS, FIXED)).toThrow(
			'Add a date to this day plan'
		);
	});

	it('includes an absolute url only when an origin is given', () => {
		expect(buildDayPlanIcs(TRIP, PLAN, STOPS, FIXED)).not.toContain('URL:');
		expect(
			buildDayPlanIcs(TRIP, PLAN, STOPS, { ...FIXED, origin: 'https://trips.gaylon.photos' })
		).toContain('URL:https://trips.gaylon.photos/trips/10');
	});

	it('links to the TRIP, not the plan — /trips/[id] is a trip route', () => {
		// TRIP.id is 10 and PLAN.id is 36 on purpose: an assertion written against
		// a fixture where they match cannot see this class of bug.
		const out = buildDayPlanIcs(TRIP, PLAN, STOPS, {
			...FIXED,
			origin: 'https://trips.gaylon.photos'
		});
		expect(out).toContain('URL:https://trips.gaylon.photos/trips/10');
		expect(out).not.toContain('/trips/36');
	});

	it('includes both Apple and Google links per stop', () => {
		const out = buildDayPlanIcs(TRIP, PLAN, STOPS, FIXED);
		expect(out).toContain('Apple: ');
		expect(out).toContain('Google: ');
	});

	it('omits AI notes by default and includes them on request', () => {
		const withAi = [stop({ ai_notes: 'Busy before 10am' }), STOPS[1]];
		expect(buildDayPlanIcs(TRIP, PLAN, withAi, FIXED)).not.toContain('Busy before 10am');
		expect(buildDayPlanIcs(TRIP, PLAN, withAi, { ...FIXED, aiNotes: true })).toContain(
			'Busy before 10am'
		);
	});
});

describe('filenames', () => {
	it('slugifies a title', () => {
		expect(slugify('Seal Cove & Bass Harbor!')).toBe('seal-cove-bass-harbor');
	});

	it('falls back when a title has no usable characters', () => {
		expect(slugify('!!!')).toBe('day-plan');
	});

	it('truncates a very long title', () => {
		expect(slugify('a'.repeat(200)).length).toBeLessThanOrEqual(60);
	});

	it('prefixes the date when the plan has one', () => {
		expect(dayPlanFilename(PLAN, 'ics')).toBe('2026-07-29-seal-cove.ics');
	});

	it('omits the prefix for an undated plan', () => {
		expect(dayPlanFilename({ ...PLAN, optional_date: null }, 'md')).toBe('seal-cove.md');
	});
});

describe('formatPlanDate', () => {
	it('formats a date without timezone drift', () => {
		expect(formatPlanDate('2026-07-29')).toBe('Wednesday, July 29, 2026');
	});

	it('returns null for a missing or unparseable date', () => {
		expect(formatPlanDate(null)).toBeNull();
		expect(formatPlanDate('not-a-date')).toBeNull();
	});
});

describe('dayPlanRouteLink — judged on the generated URL, not a stop count', () => {
	it('returns a usable whole-route link for a short day', () => {
		const link = dayPlanRouteLink(STOPS, {
			title: 'Place: Blue Hill, ME',
			lat: 44.41,
			lon: -68.59
		});
		expect(link.url).toContain('https://www.google.com/maps/dir/');
		expect(link.unreliable).toBe(false);
		expect(link.reason).toBeNull();
	});

	it('flags a route with too many waypoints for a phone', () => {
		const many = Array.from({ length: 6 }, (_, i) =>
			stop({ snapshot_title: `Stop ${i}`, snapshot_lat: 44 + i * 0.1 })
		);
		const link = dayPlanRouteLink(many, { title: 'Base', lat: 44.41, lon: -68.59 });
		expect(link.url).not.toBeNull();
		expect(link.unreliable).toBe(true);
		expect(link.reason).toBe('waypoints');
	});

	it('flags an over-long URL even when the waypoint count is legal', () => {
		// Stops WITHOUT coordinates fall back to their names as waypoint tokens,
		// so a 3-waypoint route can still blow the 2,048-character cap. A
		// count-only check cannot see this.
		const huge = Array.from({ length: 4 }, (_, i) =>
			stop({
				snapshot_title: `${'Extremely Long Place Name '.repeat(40)}${i}`,
				snapshot_lat: null,
				snapshot_lon: null
			})
		);
		const link = dayPlanRouteLink(huge, null);
		expect(link.url!.length).toBeGreaterThan(MAX_MAPS_URL_LENGTH);
		expect(link.unreliable).toBe(true);
		expect(link.reason).toBe('length');
	});

	it('has no route link for a single stop', () => {
		expect(dayPlanRouteLink([STOPS[0]], null)).toEqual({
			url: null,
			unreliable: false,
			reason: null
		});
	});

	it('strips the anchor prefix in the route link label', () => {
		const link = dayPlanRouteLink(STOPS, {
			title: 'Stay: Summit Sanctuary',
			lat: 44.41,
			lon: -68.59
		});
		expect(link.url).not.toContain('Stay%3A');
	});
});

describe('the whole-route link and its warning travel together', () => {
	it('includes the route link when it is reliable', () => {
		const out = buildDayPlanText(TRIP, PLAN, STOPS);
		expect(out).toContain('Whole route: https://www.google.com/maps/dir/');
		expect(out).not.toContain('more stops than');
	});

	it('replaces the link with a warning when it is not', () => {
		// The earlier version warned about a link the artifact never contained.
		const many = Array.from({ length: 6 }, (_, i) =>
			stop({ snapshot_title: `Stop ${i}`, snapshot_lat: 44 + i * 0.1 })
		);
		const out = buildDayPlanText(TRIP, PLAN, many);
		expect(out).not.toContain('Whole route:');
		expect(out).toContain('more stops than a single Google Maps link carries on a phone');
	});
});

describe('heading markers belong to the .md download, not the text share', () => {
	it('omits markdown markers by default — they read as noise in Messages', () => {
		const out = buildDayPlanText(TRIP, PLAN, STOPS);
		expect(out.startsWith('Seal Cove')).toBe(true);
		expect(out).not.toContain('# Seal Cove');
		expect(out).toContain('Stops (2)');
		expect(out).not.toContain('## Stops');
	});

	it('emits them for markdown', () => {
		const out = buildDayPlanText(TRIP, PLAN, STOPS, { markdown: true });
		expect(out).toContain('# Seal Cove');
		expect(out).toContain('## Stops (2)');
	});

	it('changes nothing but the markers', () => {
		const plain = buildDayPlanText(TRIP, PLAN, STOPS);
		const md = buildDayPlanText(TRIP, PLAN, STOPS, { markdown: true });
		expect(md.replace(/^#{1,2} /gm, '')).toBe(plain);
	});
});
