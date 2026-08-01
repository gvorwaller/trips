import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getTrip } from '$server/trips';
import { listItinerary, setItemDate, setItemDates } from '$server/itinerary';
import { buildPlaceSchedule } from '$server/place-schedule';
import { parsePlaceDate } from '$lib/place-date';

function parseId(param: string): number {
	const id = Number(param);
	if (!Number.isInteger(id) || id <= 0) throw error(404, 'Not found');
	return id;
}

/** Owner gate. getTrip is already scoped by owner_id, so a miss means 404. */
async function ctx(locals: App.Locals, params: { id: string }) {
	if (!locals.ownerId) throw error(500, 'No owner configured');
	const tripId = parseId(params.id);
	const trip = await getTrip(locals.ownerId, tripId);
	if (!trip) throw error(404, 'Trip not found');
	return { tripId, trip };
}

export const load: PageServerLoad = async ({ params, locals }) => {
	const { tripId, trip } = await ctx(locals, params);
	const itinerary = await listItinerary(tripId);
	return {
		trip,
		schedule: buildPlaceSchedule(itinerary, trip.start_date, trip.end_date)
	};
};

export const actions: Actions = {
	/**
	 * Set or clear one place's date. Out-of-trip-range dates are allowed on
	 * purpose — travel days and pre-trip stops are legitimate, and the schedule
	 * view already labels them "Before trip"/"After trip". Only malformed input
	 * is rejected.
	 */
	'set-date': async ({ params, request, locals }) => {
		const { tripId } = await ctx(locals, params);
		const form = await request.formData();
		const id = Number(form.get('id'));
		if (!Number.isInteger(id) || id <= 0) return fail(400, { error: 'Invalid place.' });

		// The Clear button posts its own field; the date input is still submitted
		// alongside it and would otherwise win.
		const clearing = form.get('clear') !== null;
		const parsed = clearing ? { date: null } : parsePlaceDate(form.get('date'));
		if ('error' in parsed) return fail(400, { error: parsed.error });

		const ok = await setItemDate(tripId, id, parsed.date);
		if (!ok) return fail(404, { error: 'That place is no longer in this trip.' });
		return { ok: true };
	},

	/** Apply one date to many places at once. All or nothing. */
	'bulk-set-date': async ({ params, request, locals }) => {
		const { tripId } = await ctx(locals, params);
		const form = await request.formData();

		const parsed = parsePlaceDate(form.get('date'));
		if ('error' in parsed) return fail(400, { error: parsed.error });

		const ids = form
			.getAll('ids')
			.map((v) => Number(v))
			.filter((n) => Number.isInteger(n) && n > 0);
		if (ids.length === 0) return fail(400, { error: 'Select at least one place.' });

		try {
			const updated = await setItemDates(tripId, ids, parsed.date);
			return { ok: true, updated: updated.length };
		} catch {
			// setItemDates rolls back and throws when the returned set does not match
			// the request, so nothing was written.
			return fail(400, { error: 'Some places could not be updated. Nothing was changed.' });
		}
	}
};
