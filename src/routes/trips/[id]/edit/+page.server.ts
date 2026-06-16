import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getTrip, updateTrip, parseTripForm } from '$server/trips';

function parseId(param: string): number {
	const id = Number(param);
	if (!Number.isInteger(id) || id <= 0) throw error(404, 'Not found');
	return id;
}

export const load: PageServerLoad = async ({ params, locals }) => {
	if (locals.user?.role === 'viewer') throw redirect(303, '/');
	if (!locals.ownerId) throw error(500, 'No owner configured');
	const trip = await getTrip(locals.ownerId, parseId(params.id));
	if (!trip) throw error(404, 'Trip not found');
	return { trip };
};

export const actions: Actions = {
	default: async ({ params, request, locals }) => {
		if (!locals.ownerId) throw error(500, 'No owner configured');
		const id = parseId(params.id);
		const form = await request.formData();
		const { input, error: parseError } = parseTripForm(form);
		if (!input) {
			return fail(400, { error: parseError, values: Object.fromEntries(form) });
		}
		const ok = await updateTrip(locals.ownerId, id, input);
		if (!ok) throw error(404, 'Trip not found');
		throw redirect(303, `/trips/${id}`);
	}
};
