import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getTrip } from '$server/trips';
import { getDayPlan, listStopsForPlan } from '$server/dayplans';
import type { DistanceUnit } from '$lib/geo';

function parseId(param: string): number {
	const id = Number(param);
	if (!Number.isInteger(id) || id <= 0) throw error(404, 'Not found');
	return id;
}

export const load: PageServerLoad = async ({ params, locals, url, setHeaders }) => {
	if (!locals.ownerId) throw error(500, 'No owner configured');
	const tripId = parseId(params.id);
	const planId = parseId(params.planId);

	const trip = await getTrip(locals.ownerId, tripId);
	if (!trip) throw error(404, 'Trip not found');
	const plan = await getDayPlan(tripId, planId);
	if (!plan) throw error(404, 'Day plan not found');

	// A whole day's notes and coordinates behind a cookie — don't let it linger
	// in a shared cache.
	setHeaders({ 'Cache-Control': 'private, no-store' });

	return {
		trip,
		plan,
		stops: await listStopsForPlan(tripId, planId),
		unit: (url.searchParams.get('units') === 'km' ? 'km' : 'mi') as DistanceUnit,
		// AI visit notes are opt-in in every format, for the same reason as the
		// text export: a paragraph per stop swamps the itinerary.
		aiNotes: url.searchParams.get('ai') === '1'
	};
};
