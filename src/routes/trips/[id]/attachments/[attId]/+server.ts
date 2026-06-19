import { error } from '@sveltejs/kit';
import { Readable } from 'node:stream';
import type { RequestHandler } from './$types';
import { getAttachmentForDownload, fetchObject } from '$server/attachments';

// Authenticated download proxy: never exposes a public/CDN/signed URL. Ownership
// is enforced via the trips join (owner + viewer share ownerId), so a viewer may
// download but cannot reach another owner's files. The hook allows GET for viewers.
export const GET: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.ownerId) throw error(500, 'No owner configured');
	const attId = Number(params.attId);
	if (!Number.isInteger(attId) || attId <= 0) throw error(404, 'Not found');

	const info = await getAttachmentForDownload(locals.ownerId, attId);
	if (!info) throw error(404, 'Attachment not found');

	const obj = await fetchObject(info.object_key);
	const webStream = Readable.toWeb(obj.body) as unknown as ReadableStream;

	const disposition = url.searchParams.has('download') ? 'attachment' : 'inline';
	const headers: Record<string, string> = {
		'Content-Type': info.mime_type,
		'Content-Disposition': `${disposition}; filename="${info.original_name}"`,
		'Cache-Control': 'private, no-store'
	};
	if (obj.contentLength) headers['Content-Length'] = String(obj.contentLength);

	return new Response(webStream, { headers });
};
