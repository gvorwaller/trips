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
	display_name: string | null;
	mime_type: string;
	size_bytes: number;
	kind: 'file' | 'text';
	text_content: string | null;
	uploaded_at: string;
}

/** Cap a pasted text document well under the 30 MB column CHECK. */
export const MAX_TEXT_DOC_BYTES = 1_000_000;

export interface AttachmentLinks {
	reservation_id?: number | null;
	itinerary_item_id?: number | null;
	display_name?: string | null;
}

/** Active attachments for a trip (newest first). */
export async function listAttachmentsForTrip(tripId: number): Promise<Attachment[]> {
	const res = await query<Attachment>(
		`SELECT id, trip_id, reservation_id, itinerary_item_id, original_name, display_name,
		        mime_type, size_bytes::int AS size_bytes, kind, text_content, uploaded_at
		   FROM attachments
		  WHERE trip_id = $1 AND status = 'active'
		  ORDER BY uploaded_at DESC`,
		[tripId]
	);
	return res.rows;
}

/**
 * Save pasted text as a "document" row (td-072807) — no Spaces object, body
 * stored inline so it stays searchable/editable. Caller must have verified trip
 * ownership. Returns the new id, or an error result for empty/oversized text.
 */
export async function createTextDocument(
	tripId: number,
	title: string,
	text: string,
	links: AttachmentLinks = {}
): Promise<UploadResult> {
	const body = text.trim();
	if (!body) return { ok: false, status: 400, error: 'Text is empty.' };
	const size = Buffer.byteLength(body, 'utf8');
	if (size > MAX_TEXT_DOC_BYTES) {
		return { ok: false, status: 400, error: 'Text is too large.' };
	}
	const name = (title.trim() || 'Pasted note').slice(0, 200);
	const res = await query<{ id: number }>(
		`INSERT INTO attachments
		   (trip_id, reservation_id, itinerary_item_id, original_name, mime_type,
		    size_bytes, object_key, kind, text_content, status)
		 VALUES ($1, $2, $3, $4, 'text/plain', $5, NULL, 'text', $6, 'active')
		 RETURNING id`,
		[tripId, links.reservation_id ?? null, links.itinerary_item_id ?? null, name, size, body]
	);
	return { ok: true, id: res.rows[0].id };
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
			   (trip_id, reservation_id, itinerary_item_id, original_name, display_name, mime_type, size_bytes, object_key, status)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
			 RETURNING id`,
			[
				tripId,
				links.reservation_id ?? null,
				links.itinerary_item_id ?? null,
				safe,
				links.display_name ?? null,
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
		  WHERE a.id = $1 AND t.owner_id = $2 AND a.status = 'active' AND a.kind = 'file'`,
		[attachmentId, ownerId]
	);
	return res.rows[0] ?? null;
}

export function fetchObject(objectKey: string): Promise<FetchedObject> {
	return getObject(objectKey);
}

export interface AttachmentSource {
	kind: 'file' | 'text';
	mime_type: string;
	object_key: string | null;
	text_content: string | null;
}

/** Resolve an attachment for LLM extraction, enforcing ownership via the trips join. */
export async function getAttachmentSource(
	ownerId: number,
	attachmentId: number
): Promise<AttachmentSource | null> {
	const res = await query<AttachmentSource>(
		`SELECT a.kind, a.mime_type, a.object_key, a.text_content
		   FROM attachments a
		   JOIN trips t ON t.id = a.trip_id
		  WHERE a.id = $1 AND t.owner_id = $2 AND a.status = 'active'`,
		[attachmentId, ownerId]
	);
	return res.rows[0] ?? null;
}

/** Update the display name for an attachment. */
export async function renameAttachment(
	tripId: number,
	attachmentId: number,
	displayName: string
): Promise<boolean> {
	const res = await query(
		`UPDATE attachments SET display_name = $3 WHERE id = $1 AND trip_id = $2`,
		[attachmentId, tripId, displayName.trim().slice(0, 200) || null]
	);
	return (res.rowCount ?? 0) > 0;
}

/**
 * Delete an attachment: remove the Spaces object first, then the DB row. If the
 * object delete fails, mark the row 'delete_pending' (so metadata never claims a
 * file that's gone, and a later sweep can retry) and report failure.
 */
export async function deleteAttachment(tripId: number, attachmentId: number): Promise<boolean> {
	const row = await query<{ object_key: string | null }>(
		`SELECT object_key FROM attachments WHERE id = $1 AND trip_id = $2`,
		[attachmentId, tripId]
	);
	if (row.rowCount === 0) return false;

	// Text documents have no Spaces object — just drop the row.
	const objectKey = row.rows[0].object_key;
	if (objectKey) {
		try {
			await deleteObject(objectKey);
		} catch {
			await query(`UPDATE attachments SET status = 'delete_pending' WHERE id = $1`, [
				attachmentId
			]);
			return false;
		}
	}

	await query(`DELETE FROM attachments WHERE id = $1 AND trip_id = $2`, [attachmentId, tripId]);
	return true;
}
