/**
 * Whole-trip export to plain text / Markdown (td-359579, split out of
 * td-24721a on review: the day-plan P1 asked for ONE day, and a trip is not
 * an ~80-line adaptation).
 *
 * SCOPE — stated, not emergent:
 * INCLUDED: the trip header (name, dates, notes); the Places tree, nested
 * with indentation, dates, notes, visited state and per-place map links; the
 * day plans, each rendered by the SAME buildDayPlanText that powers the
 * standalone day export (headingDepth 2) so the two can never drift; the
 * reservations; the packing lists as nested checklists.
 * DELIBERATELY OMITTED: expenses (money is private — a shared trip sheet
 * must never leak what anything cost) and attachment CONTENTS (binaries; the
 * export states the count so the reader knows files exist). AI visit notes
 * follow the day-plan default: off unless ?ai=1.
 *
 * Same artifact philosophy as the day export: text and Markdown are ONE
 * builder two characters apart, bare URLs so Messages linkifies them.
 */
import {
	buildDayPlanText,
	prefixedLines,
	slugify,
	type ExportOptions,
	type ExportPlan,
	type ExportStop,
	type ExportTrip
} from '$lib/dayplan-export';
import { appleMapsLink, googleMapsLink } from '$lib/maplinks';
import { flattenTree } from './tree';

export interface TripExportPlace {
	id: number;
	parent_id: number | null;
	sort_order: number;
	item_type: string;
	title: string;
	notes: string | null;
	date: string | null;
	lat: number | null;
	lon: number | null;
	place_id: string | null;
	apple_maps_place_id: string | null;
	visited: boolean;
}

export interface TripExportReservation {
	reservation_type: string;
	title: string;
	confirmation_code: string | null;
	status: string | null;
	start_at: string | null;
	end_at: string | null;
	notes: string | null;
}

export interface TripExportPackingItem {
	id: number;
	parent_id: number | null;
	sort_order: number;
	name: string;
	quantity: number;
	notes: string | null;
	checked: boolean;
}

export interface TripExportData {
	trip: ExportTrip & {
		start_date: string | null;
		end_date: string | null;
		notes: string | null;
	};
	places: TripExportPlace[];
	plans: Array<{ plan: ExportPlan; stops: ExportStop[] }>;
	reservations: TripExportReservation[];
	packing: Array<{ name: string; items: TripExportPackingItem[] }>;
	attachmentCount: number;
}

function fmtDateRange(start: string | null, end: string | null): string | null {
	if (start && end) return `${start} to ${end}`;
	return start ?? end;
}

function placeLinkLines(place: TripExportPlace, pad: string): string[] {
	if (place.item_type !== 'place') return [];
	const p = {
		name: place.title,
		lat: place.lat,
		lon: place.lon,
		place_id: place.place_id,
		apple_maps_place_id: place.apple_maps_place_id
	};
	return [`${pad}Apple: ${appleMapsLink(p)}`, `${pad}Google: ${googleMapsLink(p)}`];
}

export function buildTripText(data: TripExportData, opts: ExportOptions = {}): string {
	const md = opts.markdown === true;
	const h1 = md ? '# ' : '';
	const h2 = md ? '## ' : '';
	const lines: string[] = [];

	lines.push(`${h1}${data.trip.name}`, '');
	const when = fmtDateRange(data.trip.start_date, data.trip.end_date);
	if (when) lines.push(`Dates: ${when}`);
	// Indented so a note line can never sit at column 0 impersonating a
	// section or the omissions footer.
	if (data.trip.notes) lines.push(...prefixedLines(data.trip.notes, '  ', md));
	lines.push('');

	if (data.places.length > 0) {
		lines.push(`${h2}Places`, '');
		for (const { node, depth } of flattenTree(data.places)) {
			const pad = '  '.repeat(depth);
			// Markdown needs REAL list items — bare indented lines are
			// paragraph soft-breaks (nesting vanishes) and 4-space-indented
			// links become code blocks (peer CODEX, round 1). Text keeps the
			// plain layout.
			const marker = md ? '- ' : '';
			const mark = node.item_type === 'place' ? (node.visited ? '[x] ' : '[ ] ') : '';
			const date = node.date ? ` (${node.date})` : '';
			lines.push(`${pad}${marker}${mark}${node.title}${date}`);
			const contPad = md ? `${pad}  ` : `${pad}  `;
			if (node.notes) lines.push(...prefixedLines(node.notes, contPad, md));
			lines.push(...placeLinkLines(node, contPad));
		}
		lines.push('');
	}

	for (const { plan, stops } of data.plans) {
		// The identical renderer the standalone day export uses — one level
		// down so days read as sections of the trip document.
		lines.push(
			buildDayPlanText(data.trip, plan, stops, { ...opts, headingDepth: 2 }).trimEnd(),
			''
		);
	}

	if (data.reservations.length > 0) {
		lines.push(`${h2}Reservations`, '');
		for (const r of data.reservations) {
			const range = fmtDateRange(r.start_at, r.end_at);
			lines.push(`- ${r.title} (${r.reservation_type})${range ? ` — ${range}` : ''}`);
			if (r.confirmation_code) lines.push(`  Confirmation: ${r.confirmation_code}`);
			if (r.status) lines.push(`  Status: ${r.status}`);
			if (r.notes) lines.push(...prefixedLines(r.notes, '  ', md));
		}
		lines.push('');
	}

	for (const list of data.packing) {
		if (list.items.length === 0) continue;
		lines.push(`${h2}Packing — ${list.name}`, '');
		for (const { node, depth } of flattenTree(list.items)) {
			const pad = '  '.repeat(depth);
			const qty = node.quantity > 1 ? ` ×${node.quantity}` : '';
			// Markdown gets a REAL task list (`- [x]`); text keeps the plain
			// checklist layout.
			const marker = md ? '- ' : '';
			lines.push(`${pad}${marker}[${node.checked ? 'x' : ' '}] ${node.name}${qty}`);
			if (node.notes) lines.push(...prefixedLines(node.notes, `${pad}  `, md));
		}
		lines.push('');
	}

	// Honest omission statement — a reader should know these exist and were
	// left out on purpose, not lost.
	const omitted = ['expenses'];
	if (data.attachmentCount > 0) {
		omitted.push(
			`${data.attachmentCount} attached file${data.attachmentCount === 1 ? '' : 's'}`
		);
	}
	lines.push(`Not included: ${omitted.join(', ')}.`);

	return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export function tripFilename(trip: { name: string }, ext: string): string {
	return `${slugify(trip.name, 'trip')}.${ext}`;
}
