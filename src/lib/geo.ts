/** Great-circle distance in km between two lat/lon points (haversine). */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6371;
	const toRad = (d: number) => (d * Math.PI) / 180;
	const dLat = toRad(lat2 - lat1);
	const dLon = toRad(lon2 - lon1);
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(a));
}

export function formatKm(km: number): string {
	return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

export type DistanceUnit = 'mi' | 'km';

export function formatMiles(km: number): string {
	const miles = km * 0.621371;
	return miles < 10 ? `${miles.toFixed(1)} mi` : `${Math.round(miles)} mi`;
}

export function formatDistance(km: number, unit: DistanceUnit = 'mi'): string {
	return unit === 'km' ? formatKm(km) : formatMiles(km);
}

export function formatDuration(min: number): string {
	if (min < 60) return `${min} min`;
	const h = Math.floor(min / 60);
	const m = min % 60;
	return m ? `${h} h ${m} min` : `${h} h`;
}
