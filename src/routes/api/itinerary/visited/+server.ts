import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { setItemVisited } from '$server/itinerary';

// Viewer-safe mutation allowed by hooks for this exact path + method.
// Ownership is enforced through trips.owner_id inside setItemVisited, which
// also fans the flag out to every day-plan stop copy of the place.
export const PATCH: RequestHandler = async ({ request, locals }) => {
	if (!locals.ownerId) throw error(500, 'No owner configured');
	let body: { id?: unknown; visited?: unknown };
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON');
	}
	const id = Number(body.id);
	if (!Number.isInteger(id) || id <= 0) throw error(400, 'Invalid item id');
	// Strict boolean: coercing "true"/1/null to a default would turn a
	// malformed request into a silent "un-visit" instead of an error.
	if (typeof body.visited !== 'boolean') throw error(400, 'visited must be a boolean');

	const ok = await setItemVisited(locals.ownerId, id, body.visited);
	if (!ok) throw error(404, 'Item not found');
	return json({ id, visited: body.visited });
};
