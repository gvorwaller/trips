import { error, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getTrip, deleteTrip } from '$server/trips';

function parseId(param: string): number {
	const id = Number(param);
	if (!Number.isInteger(id) || id <= 0) throw error(404, 'Not found');
	return id;
}

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.ownerId) throw error(500, 'No owner configured');
	const trip = await getTrip(locals.ownerId, parseId(params.id));
	if (!trip) throw error(404, 'Trip not found');
	return { trip };
};

export const actions: Actions = {
	delete: async ({ params, locals }) => {
		if (!locals.ownerId) throw error(500, 'No owner configured');
		await deleteTrip(locals.ownerId, parseId(params.id));
		throw redirect(303, '/');
	}
};
