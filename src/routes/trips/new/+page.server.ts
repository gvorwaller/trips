import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { createTrip, parseTripForm } from '$server/trips';

export const load: PageServerLoad = ({ locals }) => {
	// Owner-only page; viewers are sent home (mutations are also blocked in hooks).
	if (locals.user?.role === 'viewer') throw redirect(303, '/');
	return {};
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		if (!locals.ownerId) throw error(500, 'No owner configured');
		const form = await request.formData();
		const { input, error: parseError } = parseTripForm(form);
		if (!input) {
			return fail(400, {
				error: parseError,
				values: Object.fromEntries(form)
			});
		}
		const id = await createTrip(locals.ownerId, input);
		throw redirect(303, `/trips/${id}`);
	}
};
