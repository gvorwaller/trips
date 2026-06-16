import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { listTrips } from '$server/trips';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.ownerId) throw error(500, 'No owner configured');
	const trips = await listTrips(locals.ownerId);
	return { trips };
};
