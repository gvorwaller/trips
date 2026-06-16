import { randomBytes } from 'node:crypto';
import { query } from '$lib/db';
import { putObject, getObject, deleteObject, type FetchedObject } from './storage';
import { validateUpload, safeFilename } from '$lib/filevalidate';

export interface Attachment {
	id: number;
	trip_id: number;
	reservation_id: number | null;
	itinerary_item_id: number | null;
	original_name: string;
	mime_type: string;
	size_bytes: number;
	uploaded_at: string;
}

export interface AttachmentLinks {
	reservation_id?: number | null;
	itinerary_item_id?: number | null;
}

/** Active attachments for a trip (newest first). */
export async function listAttachmentsForTrip(tripId: number): Promise<Attachment[]> {
	const res = await query<Attachment>(
		`SELECT id, trip_id, reservation_id, itinerary_item_id, original_name, mime_type,
		        size_bytes::int AS size_bytes, uploaded_at
		   FROM attachments
		  WHERE trip_id = $1 AND status = 'active'
		  ORDER BY uploaded_at DESC`,
		[tripId]
	);
	return res.rows;
}

export type UploadResult = { ok: true; id: number } | { ok: false; status: number; error: string };

/**
 * Validate + store an attachment. Object goes to Spaces first, then the DB row;
 * if the row insert fails, the orphaned object is deleted (no metadata-less blob,
 * no blob-less metadata). Caller must have already verified trip ownership.
 */
export async function uploadAttachment(
	tripId: number,
	originalName: string,
	bytes: Uint8Array,
	links: AttachmentLinks = {}
): Promise<UploadResult> {
	const check = validateUpload(bytes);
	if (!check.ok) return { ok: false, status: 400, error: check.error };

	const safe = safeFilename(originalName);
	const objectKey = `trips/${tripId}/${randomBytes(8).toString('hex')}/${safe}`;
	const buf = Buffer.from(bytes);

	await putObject(objectKey, buf, check.mime);

	try {
		const res = await query<{ id: number }>(
			`INSERT INTO attachments
			   (trip_id, reservation_id, itinerary_item_id, original_name, mime_type, size_bytes, object_key, status)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
			 RETURNING id`,
			[
				tripId,
				links.reservation_id ?? null,
				links.itinerary_item_id ?? null,
				safe,
				check.mime,
				buf.length,
				objectKey
			]
		);
		return { ok: true, id: res.rows[0].id };
	} catch (err) {
		// Roll back the uploaded object so we never keep a blob with no metadata.
		try {
			await deleteObject(objectKey);
		} catch {
			/* best-effort rollback; surface the original error */
		}
		throw err;
	}
}

export interface DownloadInfo {
	object_key: string;
	mime_type: string;
	original_name: string;
}

/** Resolve an attachment for download, enforcing ownership via the trips join. */
export async function getAttachmentForDownload(
	ownerId: number,
	attachmentId: number
): Promise<DownloadInfo | null> {
	const res = await query<DownloadInfo>(
		`SELECT a.object_key, a.mime_type, a.original_name
		   FROM attachments a
		   JOIN trips t ON t.id = a.trip_id
		  WHERE a.id = $1 AND t.owner_id = $2 AND a.status = 'active'`,
		[attachmentId, ownerId]
	);
	return res.rows[0] ?? null;
}

export function fetchObject(objectKey: string): Promise<FetchedObject> {
	return getObject(objectKey);
}

/**
 * Delete an attachment: remove the Spaces object first, then the DB row. If the
 * object delete fails, mark the row 'delete_pending' (so metadata never claims a
 * file that's gone, and a later sweep can retry) and report failure.
 */
export async function deleteAttachment(tripId: number, attachmentId: number): Promise<boolean> {
	const row = await query<{ object_key: string }>(
		`SELECT object_key FROM attachments WHERE id = $1 AND trip_id = $2`,
		[attachmentId, tripId]
	);
	if (row.rowCount === 0) return false;

	try {
		await deleteObject(row.rows[0].object_key);
	} catch {
		await query(`UPDATE attachments SET status = 'delete_pending' WHERE id = $1`, [attachmentId]);
		return false;
	}

	await query(`DELETE FROM attachments WHERE id = $1 AND trip_id = $2`, [attachmentId, tripId]);
	return true;
}
