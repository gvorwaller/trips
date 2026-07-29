import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getTrip } from '$server/trips';
import { listItinerary } from '$server/itinerary';
import { buildPlaceSchedule } from '$server/place-schedule';

function parseId(param: string): number {
	const id = Number(param);
	if (!Number.isInteger(id) || id <= 0) throw error(404, 'Not found');
	return id;
}

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.ownerId) throw error(500, 'No owner configured');
	const tripId = parseId(params.id);
	const trip = await getTrip(locals.ownerId, tripId);
	if (!trip) throw error(404, 'Trip not found');

	const itinerary = await listItinerary(tripId);
	return {
		trip,
		schedule: buildPlaceSchedule(itinerary, trip.start_date, trip.end_date)
	};
};
