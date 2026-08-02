/**
 * Render one day plan as shareable text or a calendar file.
 *
 * Pure — no DB, no fetch, no Svelte — so the same bytes are produced wherever
 * this is called and the output is unit testable.
 *
 * Two deliberate choices worth not re-litigating:
 *
 * 1. Links are emitted as BARE URLs on their own lines, not Markdown
 *    `[label](url)`. The target surface is iMessage, which linkifies bare URLs;
 *    Markdown syntax would arrive as a wall of unclickable brackets on the
 *    phone. (Empirical — Apple publishes no contract either way — which is why
 *    there is a real-device acceptance test rather than only unit tests.)
 *
 * 2. No arrival times. day_plan_stops stores drive_min but no time of day, and
 *    cs.md forbids fabricated data, so the export shows drive legs instead of
 *    invented clock times. Adding real times needs a plan start time and a
 *    per-stop dwell, which is a schema change, not a formatting choice.
 *
 * Driving totals come from $lib/dayplan-driving — the same functions the trip
 * page renders — so an export can never disagree with the screen it came from.
 */

import { appleMapsLink, dayPlanDirectionsLink, googleMapsLink, type MapPlace } from '$lib/maplinks';
import { cleanAnchorTitle } from '$lib/dayplan-anchor';
import {
	legSummary,
	returnLegSummary,
	routeSummary,
	type DrivingAnchor
} from '$lib/dayplan-driving';
import type { DistanceUnit } from '$lib/geo';
import { buildAllDayCalendar } from '$lib/ics';

export interface ExportStop {
	snapshot_title: string;
	snapshot_lat: number | null;
	snapshot_lon: number | null;
	snapshot_place_id: string | null;
	notes: string | null;
	ai_notes: string | null;
	visited: boolean;
	drive_km: number | null;
	drive_min: number | null;
}

export interface ExportPlan {
	id: number;
	title: string;
	notes: string | null;
	optional_date: string | null;
	anchor_title: string | null;
	anchor_lat: number | null;
	anchor_lon: number | null;
	return_drive_km: number | null;
	return_drive_min: number | null;
	updated_at: string;
}

export interface ExportTrip {
	id: number;
	name: string;
}

export interface ExportOptions {
	unit?: DistanceUnit;
	/** Origin for absolute links inside the calendar file, e.g. https://trips.gaylon.photos */
	origin?: string;
	/**
	 * Include per-stop AI visit notes. Off by default in EVERY format: they run
	 * to a paragraph each, which buries a four-stop day under 800 words. The
	 * ticket asked for the user's own notes; these are opt-in.
	 */
	aiNotes?: boolean;
	/**
	 * Emit Markdown heading markers. On for the .md download; OFF for the plain
	 * text share, where a literal "# Seal Cove" is just noise in Messages. Same
	 * content either way — this is a two-character difference, not a second
	 * builder, so the two cannot drift.
	 */
	markdown?: boolean;
	/**
	 * When this file was generated. RFC 5545 §3.8.7.2: with METHOD present,
	 * DTSTAMP is the creation time of the iCalendar object — not the record's
	 * last revision. It must be injected rather than read from a clock inside
	 * the builder so tests stay deterministic.
	 */
	generatedAt?: Date | string;
}

/**
 * Google Maps URLs accept only THREE waypoints in mobile browsers (nine
 * elsewhere), plus a 2048-character URL cap:
 * https://developers.google.com/maps/documentation/urls/get-started
 * The export exists to be opened on a phone, so 3 is the number that matters.
 */
export const MOBILE_WAYPOINT_LIMIT = 3;

/** Google Maps URLs are capped at 2,048 characters (same doc). */
export const MAX_MAPS_URL_LENGTH = 2048;

export function slugify(s: string): string {
	const out = s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60);
	return out || 'day-plan';
}

export function formatPlanDate(isoDate: string | null): string | null {
	if (!isoDate) return null;
	const d = new Date(`${isoDate.slice(0, 10)}T00:00:00`);
	if (Number.isNaN(d.getTime())) return null;
	return d.toLocaleDateString('en-US', {
		weekday: 'long',
		year: 'numeric',
		month: 'long',
		day: 'numeric'
	});
}

function anchorOf(plan: ExportPlan): DrivingAnchor | null {
	return plan.anchor_title && plan.anchor_lat != null && plan.anchor_lon != null
		? { title: plan.anchor_title, lat: plan.anchor_lat, lon: plan.anchor_lon }
		: null;
}

function placeOf(stop: ExportStop): MapPlace {
	return {
		name: stop.snapshot_title,
		lat: stop.snapshot_lat,
		lon: stop.snapshot_lon,
		place_id: stop.snapshot_place_id
	};
}

/** Intermediate stops beyond what a mobile Google Maps URL will carry. */
export function exceedsMobileWaypoints(stopCount: number, hasAnchor: boolean): boolean {
	// Route points = anchor (if any) + stops; origin and destination don't count.
	const points = stopCount + (hasAnchor ? 1 : 0);
	return points - 2 > MOBILE_WAYPOINT_LIMIT;
}

export interface RouteLink {
	url: string | null;
	/** True when the URL exists but a phone will not honour all of it. */
	unreliable: boolean;
	reason: 'waypoints' | 'length' | null;
}

/**
 * The whole-day Google Maps route, plus whether it can actually be trusted on a
 * phone.
 *
 * Judged on the GENERATED URL, not just a stop count: maplinks falls back to
 * place names as waypoint tokens when coordinates are missing, so a route well
 * under the waypoint limit can still breach the 2,048-character cap. Both
 * limits come from
 * https://developers.google.com/maps/documentation/urls/get-started
 * (3 waypoints in mobile browsers, 9 elsewhere, 2,048 characters).
 */
export function dayPlanRouteLink(stops: ExportStop[], anchor: DrivingAnchor | null): RouteLink {
	const url = dayPlanDirectionsLink(
		stops,
		anchor ? { name: cleanAnchorTitle(anchor.title), lat: anchor.lat, lon: anchor.lon } : null
	);
	if (!url) return { url: null, unreliable: false, reason: null };
	if (url.length > MAX_MAPS_URL_LENGTH) return { url, unreliable: true, reason: 'length' };
	if (exceedsMobileWaypoints(stops.length, anchor != null)) {
		return { url, unreliable: true, reason: 'waypoints' };
	}
	return { url, unreliable: false, reason: null };
}

/**
 * Plain text that doubles as Markdown. Used for the Messages share and the
 * downloadable .md — one artifact, so the two can't drift.
 */
export function buildDayPlanText(
	trip: ExportTrip,
	plan: ExportPlan,
	stops: ExportStop[],
	opts: ExportOptions = {}
): string {
	const unit = opts.unit ?? 'mi';
	const anchor = anchorOf(plan);
	const lines: string[] = [];

	const h1 = opts.markdown ? '# ' : '';
	const h2 = opts.markdown ? '## ' : '';
	lines.push(`${h1}${plan.title}`, '');
	lines.push(`Trip: ${trip.name}`);
	const when = formatPlanDate(plan.optional_date);
	if (when) lines.push(`Date: ${when}`);
	const base = anchor ? cleanAnchorTitle(anchor.title) : null;
	if (base) lines.push(`Starting from: ${base}`);

	const summary = routeSummary(plan, stops, anchor, unit);
	if (summary) lines.push(`Driving: ${summary}`);
	lines.push('');

	if (plan.notes) lines.push(plan.notes.trim(), '');

	if (stops.length === 0) {
		lines.push('No stops yet.', '');
	} else {
		lines.push(`${h2}Stops (${stops.length})`, '');
		stops.forEach((stop, i) => {
			const leg = legSummary(i > 0 ? stops[i - 1] : null, stop, anchor, unit);
			lines.push(`${i + 1}. ${stop.snapshot_title}${stop.visited ? ' (visited)' : ''}`);
			if (leg) lines.push(`   Drive from ${i === 0 && base ? base : 'previous'}: ${leg}`);
			if (stop.notes) lines.push(`   ${stop.notes.trim()}`);
			if (opts.aiNotes && stop.ai_notes) lines.push(`   ${stop.ai_notes.trim()}`);
			// Bare URLs so Messages linkifies them.
			lines.push(`   Apple: ${appleMapsLink(placeOf(stop))}`);
			lines.push(`   Google: ${googleMapsLink(placeOf(stop))}`);
			lines.push('');
		});

		const home = returnLegSummary(plan, stops, anchor, unit);
		if (home && base) lines.push(`Drive home to ${base}: ${home}`, '');

		// The whole-day route, so the warning below refers to a link that is
		// actually in this artifact rather than to one on a page the reader
		// cannot see.
		const route = dayPlanRouteLink(stops, anchor);
		if (route.url && !route.unreliable) {
			lines.push(`Whole route: ${route.url}`, '');
		} else if (route.url) {
			lines.push(
				route.reason === 'length'
					? 'This route is too long for a single Google Maps link. Use the per-stop links above.'
					: `This route has more stops than a single Google Maps link carries on a phone (${MOBILE_WAYPOINT_LIMIT} waypoints). Use the per-stop links above.`,
				''
			);
		}
	}

	return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/**
 * One all-day event for the plan, with the itinerary in the description.
 *
 * All-day rather than timed because there are no stop times to derive a
 * schedule from. Throws when the plan has no date — a calendar entry invented
 * for "today" would be worse than a clear error.
 */
export function buildDayPlanIcs(
	trip: ExportTrip,
	plan: ExportPlan,
	stops: ExportStop[],
	opts: ExportOptions = {}
): string {
	if (!plan.optional_date) {
		throw new Error('Add a date to this day plan before exporting to Calendar.');
	}
	const unit = opts.unit ?? 'mi';
	const anchor = anchorOf(plan);

	const description: string[] = [];
	if (plan.notes) description.push(plan.notes.trim(), '');
	stops.forEach((stop, i) => {
		description.push(`${i + 1}. ${stop.snapshot_title}`);
		if (stop.notes) description.push(`   ${stop.notes.trim()}`);
		if (opts.aiNotes && stop.ai_notes) description.push(`   ${stop.ai_notes.trim()}`);
		// Both providers, same as the text export — iOS users want Apple.
		description.push(`   Apple: ${appleMapsLink(placeOf(stop))}`);
		description.push(`   Google: ${googleMapsLink(placeOf(stop))}`);
	});
	const summary = routeSummary(plan, stops, anchor, unit);
	if (summary) description.push('', `Driving: ${summary}`);

	const location = anchor ? cleanAnchorTitle(anchor.title) : (stops[0]?.snapshot_title ?? null);

	return buildAllDayCalendar(
		{
			uid: `dayplan-${plan.id}@trips.gaylon.photos`,
			// With METHOD present, RFC 5545 §3.8.7.2 defines DTSTAMP as when this
			// object was created — not the record's revision. plan.updated_at is
			// wrong on both counts: it is a revision timestamp, and stop-level edits
			// (notes, visited) do not bump it, so the same UID could ship changed
			// content under an unchanged stamp.
			dtstamp: opts.generatedAt ?? new Date(),
			date: plan.optional_date,
			summary: `${plan.title} — ${trip.name}`,
			description: description.join('\n').trim() || null,
			location,
			// The trip id, not the plan id — /trips/[id] is a TRIP route.
			url: opts.origin ? `${opts.origin}/trips/${trip.id}` : null
		},
		'-//trips.gaylon.photos//Day Plan//EN'
	);
}

export function dayPlanFilename(plan: ExportPlan, ext: string): string {
	const datePart = plan.optional_date ? `${plan.optional_date.slice(0, 10)}-` : '';
	return `${datePart}${slugify(plan.title)}.${ext}`;
}
