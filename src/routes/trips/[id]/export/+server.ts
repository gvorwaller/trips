import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getTrip } from '$server/trips';
import { listItinerary } from '$server/itinerary';
import { listDayPlans, listStopsForTrip } from '$server/dayplans';
import { listReservations } from '$server/reservations';
import { getPackingItemsForTrip, listPackingLists } from '$server/packing';
import { countAttachmentsForTrip } from '$server/attachments';
import { buildTripText, tripFilename } from '$server/trip-export';
import type { DistanceUnit } from '$lib/geo';

/**
 * Export the whole trip as text or Markdown (td-359579). Mirrors the day-plan
 * export contract exactly: GET ?format=txt|md&units=mi|km&ai=1 — txt inline
 * (the select-all-into-Messages path), md as a download. GET only, so the
 * read-only viewer can share a trip without any hooks change; ownership is
 * enforced by scoping every read through locals.ownerId -> trip.
 *
 * Scope decisions (which sections are included and what is deliberately
 * omitted) live in $server/trip-export — the builder, not the route, owns
 * them.
 */

function parseId(param: string): number {
	const id = Number(param);
	if (!Number.isInteger(id) || id <= 0) throw error(404, 'Not found');
	return id;
}

export const GET: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.ownerId) throw error(500, 'No owner configured');
	const tripId = parseId(params.id);

	const trip = await getTrip(locals.ownerId, tripId);
	if (!trip) throw error(404, 'Trip not found');

	const format = url.searchParams.get('format') ?? 'txt';
	if (format !== 'txt' && format !== 'md') {
		throw error(400, 'Unsupported format. Use txt or md.');
	}
	const unit: DistanceUnit = url.searchParams.get('units') === 'km' ? 'km' : 'mi';
	const aiNotes = url.searchParams.get('ai') === '1';

	const [places, plans, stops, reservations, lists, itemsByList, attachmentCount] =
		await Promise.all([
			listItinerary(tripId),
			listDayPlans(tripId),
			listStopsForTrip(tripId),
			listReservations(tripId),
			listPackingLists(tripId),
			getPackingItemsForTrip(tripId),
			countAttachmentsForTrip(tripId)
		]);

	const stopsByPlan = new Map<number, typeof stops>();
	for (const stop of stops) {
		const group = stopsByPlan.get(stop.day_plan_id) ?? [];
		group.push(stop);
		stopsByPlan.set(stop.day_plan_id, group);
	}

	const body = buildTripText(
		{
			trip,
			places,
			plans: plans.map((plan) => ({ plan, stops: stopsByPlan.get(plan.id) ?? [] })),
			reservations,
			packing: lists.map((list) => ({ name: list.name, items: itemsByList.get(list.id) ?? [] })),
			attachmentCount
		},
		{ unit, aiNotes, markdown: format === 'md' }
	);

	// A whole trip's notes, coordinates and links behind a cookie — same
	// private-download policy as the day-plan export and attachments.
	const base = {
		'Cache-Control': 'private, no-store',
		'X-Content-Type-Options': 'nosniff'
	};

	if (format === 'md') {
		return new Response(body, {
			headers: {
				...base,
				'Content-Type': 'text/markdown; charset=utf-8',
				'Content-Disposition': `attachment; filename="${tripFilename(trip, 'md')}"`
			}
		});
	}
	return new Response(body, { headers: { ...base, 'Content-Type': 'text/plain; charset=utf-8' } });
};
