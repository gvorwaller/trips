import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { setStopVisited } from '$server/dayplans';

// Viewer-safe mutation allowed by hooks for this exact path + method.
// Ownership is enforced through day_plans -> trips.owner_id in setStopVisited.
export const PATCH: RequestHandler = async ({ request, locals }) => {
	if (!locals.ownerId) throw error(500, 'No owner configured');
	let body: { id?: unknown; visited?: unknown };
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON');
	}
	const id = Number(body.id);
	const visited = body.visited === true;
	if (!Number.isInteger(id) || id <= 0) throw error(400, 'Invalid stop id');

	const ok = await setStopVisited(locals.ownerId, id, visited);
	if (!ok) throw error(404, 'Stop not found');
	return json({ id, visited });
};
