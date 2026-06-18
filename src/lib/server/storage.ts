/**
 * DO Spaces storage for trip attachments — PRIVATE objects, app-proxied reads.
 * Distinct from gaylonphotos' public bucket: objects are written with a private
 * ACL and never served via a public/CDN URL; downloads stream through an
 * authenticated SvelteKit route. Adapted from gaylonphotos/src/lib/server/storage.js.
 */
import {
	S3Client,
	PutObjectCommand,
	GetObjectCommand,
	DeleteObjectCommand
} from '@aws-sdk/client-s3';
import { env } from '$env/dynamic/private';

let client: S3Client | undefined;

export function storageConfigured(): boolean {
	return !!(env.SPACES_KEY && env.SPACES_SECRET && env.SPACES_BUCKET && env.SPACES_ENDPOINT);
}

function getClient(): S3Client {
	if (!storageConfigured()) throw new Error('Spaces storage is not configured (SPACES_* env).');
	if (!client) {
		client = new S3Client({
			region: env.SPACES_REGION ?? 'sfo3',
			endpoint: env.SPACES_ENDPOINT,
			forcePathStyle: false, // virtual-hosted style (DO Spaces)
			credentials: {
				accessKeyId: env.SPACES_KEY as string,
				secretAccessKey: env.SPACES_SECRET as string
			}
		});
	}
	return client;
}

const BUCKET = () => env.SPACES_BUCKET as string;

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
	await getClient().send(
		new PutObjectCommand({
			Bucket: BUCKET(),
			Key: key,
			Body: body,
			ContentType: contentType,
			ACL: 'private'
		})
	);
}

export interface FetchedObject {
	body: import('stream').Readable;
	contentType: string | undefined;
	contentLength: number | undefined;
}

/** Fetch an object for streaming through the download proxy. */
export async function getObject(key: string): Promise<FetchedObject> {
	const res = await getClient().send(new GetObjectCommand({ Bucket: BUCKET(), Key: key }));
	return {
		body: res.Body as import('stream').Readable,
		contentType: res.ContentType,
		contentLength: res.ContentLength
	};
}

export async function deleteObject(key: string): Promise<void> {
	await getClient().send(new DeleteObjectCommand({ Bucket: BUCKET(), Key: key }));
}

/** Fetch an object fully into memory (for LLM vision input, not streaming). */
export async function getObjectBuffer(key: string): Promise<Buffer> {
	const obj = await getObject(key);
	const chunks: Buffer[] = [];
	for await (const chunk of obj.body) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}
