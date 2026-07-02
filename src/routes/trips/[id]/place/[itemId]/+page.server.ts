import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getTrip } from '$server/trips';
import { getItem, setLocation, setPlaceId, clearLocation } from '$server/itinerary';
import { getPlaceDetails, type PlaceDetailsResult } from '$server/place-details';
import { placesTextSearchCached } from '$server/geocode';
import { askAboutPlace, AnthropicError, MAX_QUESTION_LENGTH } from '$server/place-ai';
import { PLACE_DETAILS_STATUS_MESSAGE } from '$lib/place-details-status';

function parseId(v: string | FormDataEntryValue | null): number {
	const id = Number(v);
	if (!Number.isInteger(id) || id <= 0) throw error(400, 'Invalid id');
	return id;
}

export interface ResolveCandidate {
	place_id: string;
	name: string;
}

export const load: PageServerLoad = async ({ params, locals }) => {
	if (locals.user?.role === 'viewer') throw redirect(303, '/');
	if (!locals.ownerId) throw error(500, 'No owner configured');
	const tripId = parseId(params.id);
	const trip = await getTrip(locals.ownerId, tripId);
	if (!trip) throw error(404, 'Trip not found');
	const item = await getItem(tripId, parseId(params.itemId));
	if (!item) throw error(404, 'Item not found');

	// Three location states (see docs/2026-07-01-place-ai-interaction-plan-claude.md
	// Phase 2): a Google place_id gets a full details fetch; coordinates with no
	// Google id (an Apple Maps import or a manual pin) try to resolve one for the
	// owner to confirm; no coordinates at all shows the existing re-select prompt.
	let details: PlaceDetailsResult | null = null;
	let resolveCandidate: ResolveCandidate | null = null;
	if (item.place_id) {
		details = await getPlaceDetails(item.place_id);
	} else if (item.lat != null && item.lon != null) {
		// Search by the item's own title, biased tightly to its pin — not a
		// plain reverse-geocode, which only returns the nearest street address
		// and can name a different, unrelated feature than the actual POI.
		// The owner still confirms the candidate by name before it's linked.
		// Cached (like getPlaceDetails/placesNearbyCached) so viewing this page
		// repeatedly doesn't fire a live Google request on every load.
		const candidate = await placesTextSearchCached(item.title, {
			lat: item.lat,
			lng: item.lon,
			radiusM: 200
		});
		if (candidate?.place_id) {
			resolveCandidate = { place_id: candidate.place_id, name: candidate.name };
		}
	}

	return { trip, item, details, resolveCandidate };
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
		if (!placeId) {
			return fail(400, {
				error:
					'Google did not return a place ID for that selection. Search and select the place again.'
			});
		}
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
	},

	// Owner confirms a Google place suggested for an item that only had
	// coordinates (Apple Maps import or manual pin) — see ResolveCandidate above.
	'link-place': async ({ params, request, locals }) => {
		if (!locals.ownerId) throw error(500, 'No owner configured');
		const tripId = parseId(params.id);
		const trip = await getTrip(locals.ownerId, tripId);
		if (!trip) throw error(404, 'Trip not found');
		const itemId = parseId(params.itemId);
		const form = await request.formData();
		const placeId = (form.get('place_id') ?? '').toString().trim();
		if (!placeId) return fail(400, { error: 'Missing place ID to link.' });
		await setPlaceId(tripId, itemId, placeId);
		// Redirect back to the same page (not just return) so a plain-form
		// submission lands on a clean GET URL instead of leaving the browser
		// on the `?/link-place` POST target, which would trigger a "resubmit
		// form?" prompt on refresh.
		throw redirect(303, `/trips/${tripId}/place/${itemId}`);
	},

	'ask-ai': async ({ params, request, locals }) => {
		if (!locals.ownerId) throw error(500, 'No owner configured');
		const tripId = parseId(params.id);
		const trip = await getTrip(locals.ownerId, tripId);
		if (!trip) throw error(404, 'Trip not found');
		const item = await getItem(tripId, parseId(params.itemId));
		if (!item) throw error(404, 'Item not found');

		const form = await request.formData();
		const question = (form.get('question') ?? '').toString().trim();
		if (!question) return fail(400, { askError: 'Enter a question first.' });
		if (question.length > MAX_QUESTION_LENGTH) {
			return fail(400, { askError: `Keep questions under ${MAX_QUESTION_LENGTH} characters.` });
		}

		let details = null;
		if (item.place_id) {
			const result = await getPlaceDetails(item.place_id);
			if (result.status === 'ok') details = result.details;
		}
		const tripDateRange =
			trip.start_date && trip.end_date
				? `${trip.start_date} to ${trip.end_date}`
				: (trip.start_date ?? trip.end_date);

		try {
			const answer = await askAboutPlace({
				tripName: trip.name,
				tripDateRange,
				tripNotes: trip.notes,
				itemTitle: item.title,
				itemNotes: item.notes,
				itemDate: item.date,
				lat: item.lat,
				lon: item.lon,
				placeId: item.place_id,
				appleMapsPlaceId: item.apple_maps_place_id,
				details,
				question
			});
			return { askAnswer: answer, askedQuestion: question, askLimited: details === null };
		} catch (err) {
			if (err instanceof AnthropicError) return fail(502, { askError: err.message });
			throw err;
		}
	},

	'refresh-details': async ({ params, locals }) => {
		if (!locals.ownerId) throw error(500, 'No owner configured');
		const tripId = parseId(params.id);
		const trip = await getTrip(locals.ownerId, tripId);
		if (!trip) throw error(404, 'Trip not found');
		const itemId = parseId(params.itemId);
		const item = await getItem(tripId, itemId);
		if (!item) throw error(404, 'Item not found');
		if (!item.place_id) return fail(400, { refreshError: 'No linked Google place to refresh.' });

		const result = await getPlaceDetails(item.place_id, { forceRefresh: true });
		if (result.status !== 'ok') {
			return fail(502, {
				refreshError: PLACE_DETAILS_STATUS_MESSAGE[result.status] ?? 'Refresh failed.'
			});
		}
		if (result.details.stale) {
			// forceRefresh bypasses the cache-hit check, but the upstream call
			// still failed and getPlaceDetails fell back to the old cached row
			// (its normal graceful-degradation behavior for a plain page load).
			// For an explicit "Refresh details" click, that fallback must read
			// as a failure — otherwise the next ordinary load re-reads the same
			// still-fresh-looking row and the failed refresh goes unnoticed.
			return fail(502, {
				refreshError:
					"Couldn't reach Google for fresh details right now — showing the last-known details. Try again shortly."
			});
		}
		// Redirect back to the same page (see link-place above) so a plain-form
		// submission lands on a clean GET URL, not the `?/refresh-details` POST target.
		throw redirect(303, `/trips/${tripId}/place/${itemId}`);
	}
};
