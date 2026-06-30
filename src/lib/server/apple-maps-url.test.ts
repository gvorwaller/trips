import { describe, expect, it } from 'vitest';
import { isAppleMapsUrl, parseAppleMapsUrl } from './apple-maps-url';

describe('Apple Maps URL parsing', () => {
	it('recognizes Apple Maps hosts', () => {
		expect(isAppleMapsUrl('https://maps.apple.com/?q=Blue%20Hill')).toBe(true);
		expect(isAppleMapsUrl('https://www.google.com/maps/place/Blue+Hill')).toBe(false);
	});

	it('extracts name, coordinates, and Apple place id', async () => {
		const parsed = await parseAppleMapsUrl(
			'https://maps.apple.com/?q=Blue%20Hill%2C%20ME&ll=44.4139,-68.5867&auid=1234567890&lsp=9902'
		);
		expect(parsed).toMatchObject({
			name: 'Blue Hill, ME',
			lat: 44.4139,
			lng: -68.5867,
			appleMapsPlaceId: '1234567890'
		});
	});

	it('uses address and place-id variants as fallbacks', async () => {
		const parsed = await parseAppleMapsUrl(
			'https://maps.apple.com/?address=1%20Main%20St%2C%20Blue%20Hill%2C%20ME&place-id=abc'
		);
		expect(parsed?.address).toBe('1 Main St, Blue Hill, ME');
		expect(parsed?.placeQuery).toBe('1 Main St, Blue Hill, ME');
		expect(parsed?.appleMapsPlaceId).toBe('abc');
		expect(Number.isNaN(parsed?.lat)).toBe(true);
	});
});
