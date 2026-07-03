import { describe, expect, it } from 'vitest';
import { computeLegDistances, optimizeDrivingRoute } from './route';

describe('route duplicate guards', () => {
	it('rejects duplicate stop coordinates before calculating directions', async () => {
		await expect(
			computeLegDistances('key', [
				{ id: 1, lat: 44.4, lon: -68.2 },
				{ id: 2, lat: 44.400001, lon: -68.200001 }
			])
		).rejects.toThrow('Remove duplicate stops before calculating directions.');
	});

	it('rejects an anchor that duplicates a saved stop before optimizing', async () => {
		await expect(
			optimizeDrivingRoute('key', {
				anchor: { lat: 44.4, lon: -68.2 },
				stops: [
					{ id: 1, lat: 44.400001, lon: -68.200001 },
					{ id: 2, lat: 44.5, lon: -68.3 }
				]
			})
		).rejects.toThrow('Remove duplicate stops before optimizing the route.');
	});
});
