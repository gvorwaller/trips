import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { setPackingItemChecked } from '$server/packing';

// The single mutation a read-only viewer may perform (hooks allow this exact
// path + method). Ownership is enforced inside setPackingItemChecked via the
// trips.owner_id join, so a viewer can only touch the owner's items.
export const PATCH: RequestHandler = async ({ request, locals }) => {
	if (!locals.ownerId) throw error(500, 'No owner configured');
	let body: { id?: unknown; checked?: unknown };
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON');
	}
	const id = Number(body.id);
	const checked = body.checked === true;
	if (!Number.isInteger(id) || id <= 0) throw error(400, 'Invalid item id');

	const ok = await setPackingItemChecked(locals.ownerId, id, checked);
	if (!ok) throw error(404, 'Item not found');
	return json({ id, checked });
};
