// Pure file-type validation by magic bytes (don't trust the browser's MIME).
// Allowed attachment kinds for trips: PDF + common image formats. Adapted from
// the gaylonphotos signature checks. Fully unit-testable (no I/O).

export const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024; // 30 MB

export interface DetectedType {
	kind: 'pdf' | 'jpeg' | 'png' | 'webp' | 'heic';
	mime: string;
}

const HEIC_BRANDS = new Set(['heic', 'heix', 'heif', 'hevc', 'hevx', 'mif1', 'msf1']);

function ascii(bytes: Uint8Array, start: number, end: number): string {
	let s = '';
	for (let i = start; i < end && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
	return s;
}

/** Identify a supported file by its leading bytes, or null if unrecognized. */
export function detectFileType(bytes: Uint8Array): DetectedType | null {
	if (bytes.length < 12) return null;

	// PDF: "%PDF"
	if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
		return { kind: 'pdf', mime: 'application/pdf' };
	}
	// JPEG: FF D8 FF
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
		return { kind: 'jpeg', mime: 'image/jpeg' };
	}
	// PNG: 89 50 4E 47 0D 0A 1A 0A
	if (
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	) {
		return { kind: 'png', mime: 'image/png' };
	}
	// WebP: "RIFF" .... "WEBP"
	if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
		return { kind: 'webp', mime: 'image/webp' };
	}
	// HEIC/HEIF: ISO-BMFF "ftyp" box at offset 4, brand at offset 8
	if (ascii(bytes, 4, 8) === 'ftyp' && HEIC_BRANDS.has(ascii(bytes, 8, 12))) {
		return { kind: 'heic', mime: 'image/heic' };
	}
	return null;
}

export type ValidationResult =
	| { ok: true; kind: DetectedType['kind']; mime: string }
	| { ok: false; error: string };

/** Validate a candidate upload: size cap + recognized magic bytes. */
export function validateUpload(bytes: Uint8Array): ValidationResult {
	if (bytes.length === 0) return { ok: false, error: 'File is empty.' };
	if (bytes.length > MAX_ATTACHMENT_BYTES) {
		return { ok: false, error: 'File exceeds the 30 MB limit.' };
	}
	const detected = detectFileType(bytes);
	if (!detected) {
		return { ok: false, error: 'Unsupported file type (allowed: PDF, JPEG, PNG, WebP, HEIC).' };
	}
	return { ok: true, kind: detected.kind, mime: detected.mime };
}

/** Sanitize an original filename for use in an object key / Content-Disposition. */
export function safeFilename(name: string): string {
	const base = name.split(/[/\\]/).pop() ?? 'file';
	const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
	return cleaned || 'file';
}
