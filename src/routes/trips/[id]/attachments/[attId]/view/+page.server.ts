import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getAttachmentForDownload } from '$server/attachments';
import { getTrip } from '$server/trips';

function parseId(value: string): number {
	const id = Number(value);
	if (!Number.isInteger(id) || id <= 0) throw error(404, 'Not found');
	return id;
}

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.ownerId) throw error(500, 'No owner configured');

	const tripId = parseId(params.id);
	const attId = parseId(params.attId);

	const [trip, attachment] = await Promise.all([
		getTrip(locals.ownerId, tripId),
		getAttachmentForDownload(locals.ownerId, tripId, attId)
	]);

	if (!trip || !attachment) throw error(404, 'Attachment not found');

	return {
		trip: { id: trip.id, name: trip.name },
		attachment: {
			id: attId,
			name: attachment.original_name,
			mime_type: attachment.mime_type,
			url: `/trips/${tripId}/attachments/${attId}`
		}
	};
};
