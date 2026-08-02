import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getTrip } from '$server/trips';
import { getDayPlan, listStopsForPlan } from '$server/dayplans';
import { buildDayPlanIcs, buildDayPlanText, dayPlanFilename } from '$lib/dayplan-export';
import type { DistanceUnit } from '$lib/geo';

/**
 * Export one day plan.
 *
 * GET ?format=txt|md|ics
 *   txt — text/plain INLINE. The iPhone path: open in Safari, select all, paste
 *         into Messages. An attachment download would break that.
 *   md  — same bytes, downloaded as a file.
 *   ics — one all-day calendar event.
 *
 * GET only, so viewers can share a day without any change to the viewer
 * allowlist in hooks.server.ts. Ownership is enforced by scoping every read
 * through locals.ownerId -> trip -> plan.
 */

function parseId(param: string): number {
	const id = Number(param);
	if (!Number.isInteger(id) || id <= 0) throw error(404, 'Not found');
	return id;
}

function parseUnit(value: string | null): DistanceUnit {
	return value === 'km' ? 'km' : 'mi';
}

export const GET: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.ownerId) throw error(500, 'No owner configured');
	const tripId = parseId(params.id);
	const planId = parseId(params.planId);

	const trip = await getTrip(locals.ownerId, tripId);
	if (!trip) throw error(404, 'Trip not found');
	const plan = await getDayPlan(tripId, planId);
	if (!plan) throw error(404, 'Day plan not found');

	const stops = await listStopsForPlan(tripId, planId);
	const unit = parseUnit(url.searchParams.get('units'));
	const aiNotes = url.searchParams.get('ai') === '1';
	const format = url.searchParams.get('format') ?? 'txt';

	if (format !== 'txt' && format !== 'md' && format !== 'ics') {
		throw error(400, 'Unsupported format. Use txt, md, or ics.');
	}

	// These carry a whole day's notes, coordinates and AI text behind a cookie.
	// Match the private-attachment policy rather than trusting cache defaults.
	const base = {
		'Cache-Control': 'private, no-store',
		'X-Content-Type-Options': 'nosniff'
	};

	if (format === 'ics') {
		// Checked here, not caught from the builder: a missing date is the user's
		// to fix, while anything else the writer throws is our defect and must not
		// be relabelled as a bad request.
		if (!plan.optional_date) {
			throw error(400, 'Add a date to this day plan before exporting to Calendar.');
		}
		const body = buildDayPlanIcs(trip, plan, stops, {
			unit,
			aiNotes,
			origin: url.origin,
			generatedAt: new Date()
		});
		return new Response(body, {
			headers: {
				...base,
				'Content-Type': 'text/calendar; charset=utf-8',
				'Content-Disposition': `attachment; filename="${dayPlanFilename(plan, 'ics')}"`
			}
		});
	}

	const body = buildDayPlanText(trip, plan, stops, { unit, aiNotes, markdown: format === 'md' });

	if (format === 'md') {
		return new Response(body, {
			headers: {
				...base,
				'Content-Type': 'text/markdown; charset=utf-8',
				'Content-Disposition': `attachment; filename="${dayPlanFilename(plan, 'md')}"`
			}
		});
	}

	return new Response(body, { headers: { ...base, 'Content-Type': 'text/plain; charset=utf-8' } });
};
