import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getTrip } from '$server/trips';
import { getItem, setLocation, clearLocation } from '$server/itinerary';

function parseId(v: string | FormDataEntryValue | null): number {
	const id = Number(v);
	if (!Number.isInteger(id) || id <= 0) throw error(400, 'Invalid id');
	return id;
}

export const load: PageServerLoad = async ({ params, locals }) => {
	if (locals.user?.role === 'viewer') throw redirect(303, '/');
	if (!locals.ownerId) throw error(500, 'No owner configured');
	const tripId = parseId(params.id);
	const trip = await getTrip(locals.ownerId, tripId);
	if (!trip) throw error(404, 'Trip not found');
	const item = await getItem(tripId, parseId(params.itemId));
	if (!item) throw error(404, 'Item not found');
	return { trip, item };
};

export const actions: Actions = {
	save: async ({ params, request, locals }) => {
		if (!locals.ownerId) throw error(500, 'No owner configured');
		const tripId = parseId(params.id);
		const trip = await getTrip(locals.ownerId, tripId);
		if (!trip) throw error(404, 'Trip not found');
		const form = await request.formData();
		const lat = Number(form.get('lat'));
		const lon = Number(form.get('lon'));
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
			return fail(400, { error: 'Pick a location on the map first.' });
		}
		const placeId = (form.get('place_id') ?? '').toString().trim() || null;
		await setLocation(tripId, parseId(params.itemId), lat, lon, placeId);
		throw redirect(303, `/trips/${tripId}`);
	},

	clear: async ({ params, locals }) => {
		if (!locals.ownerId) throw error(500, 'No owner configured');
		const tripId = parseId(params.id);
		const trip = await getTrip(locals.ownerId, tripId);
		if (!trip) throw error(404, 'Trip not found');
		await clearLocation(tripId, parseId(params.itemId));
		throw redirect(303, `/trips/${tripId}`);
	}
};
