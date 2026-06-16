import { describe, it, expect } from 'vitest';
import { detectFileType, validateUpload, safeFilename, MAX_ATTACHMENT_BYTES } from './filevalidate';

function bytes(...vals: number[]): Uint8Array {
	const a = new Uint8Array(16);
	vals.forEach((v, i) => (a[i] = v));
	return a;
}
function withAscii(prefix: number[], at: { [pos: number]: string }): Uint8Array {
	const a = new Uint8Array(16);
	prefix.forEach((v, i) => (a[i] = v));
	for (const [pos, str] of Object.entries(at)) {
		[...str].forEach((c, i) => (a[Number(pos) + i] = c.charCodeAt(0)));
	}
	return a;
}

describe('detectFileType', () => {
	it('detects PDF', () => {
		expect(detectFileType(bytes(0x25, 0x50, 0x44, 0x46))?.kind).toBe('pdf');
	});
	it('detects JPEG', () => {
		expect(detectFileType(bytes(0xff, 0xd8, 0xff, 0xe0))?.kind).toBe('jpeg');
	});
	it('detects PNG', () => {
		expect(detectFileType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))?.kind).toBe('png');
	});
	it('detects WebP', () => {
		expect(detectFileType(withAscii([], { 0: 'RIFF', 8: 'WEBP' }))?.kind).toBe('webp');
	});
	it('detects HEIC by ftyp brand', () => {
		expect(detectFileType(withAscii([], { 4: 'ftyp', 8: 'heic' }))?.kind).toBe('heic');
	});
	it('rejects unknown / disguised content', () => {
		expect(detectFileType(withAscii([], { 0: 'MZ' }))).toBeNull(); // exe
		expect(detectFileType(bytes(0x00, 0x01, 0x02, 0x03))).toBeNull();
	});
	it('rejects too-short input', () => {
		expect(detectFileType(new Uint8Array([0x25, 0x50]))).toBeNull();
	});
});

describe('validateUpload', () => {
	it('accepts a valid PDF', () => {
		const r = validateUpload(bytes(0x25, 0x50, 0x44, 0x46));
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.mime).toBe('application/pdf');
	});
	it('rejects empty', () => {
		expect(validateUpload(new Uint8Array(0))).toEqual({ ok: false, error: 'File is empty.' });
	});
	it('rejects oversize', () => {
		// Build a buffer just over the limit with a valid PDF header.
		const big = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
		big.set([0x25, 0x50, 0x44, 0x46]);
		const r = validateUpload(big);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/30 MB/);
	});
	it('rejects a disguised file (wrong magic)', () => {
		const r = validateUpload(withAscii([], { 0: 'MZ' }));
		expect(r.ok).toBe(false);
	});
});

describe('safeFilename', () => {
	it('strips paths and unsafe chars', () => {
		expect(safeFilename('../../etc/pass wd!.pdf')).toBe('pass_wd_.pdf');
		expect(safeFilename('Boarding Pass #3.pdf')).toBe('Boarding_Pass__3.pdf');
	});
	it('falls back when empty', () => {
		expect(safeFilename('')).toBe('file');
	});
});
