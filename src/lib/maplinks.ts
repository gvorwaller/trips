// Pure builders for map deep links — Google Maps, Apple Maps, and directions.
// No DOM/Google JS API needed, so these work in SSR, the PWA offline shell, and
// are fully unit-testable. A place needs only a name to get useful links;
// coordinates / place_id make them precise.

export interface MapPlace {
	name: string;
	lat?: number | null;
	lon?: number | null;
	place_id?: string | null;
}

export interface DayPlanDirectionStop {
	snapshot_title: string;
	snapshot_lat: number | null;
	snapshot_lon: number | null;
	snapshot_place_id: string | null;
}

function hasCoords(p: MapPlace): p is MapPlace & { lat: number; lon: number } {
	return typeof p.lat === 'number' && typeof p.lon === 'number';
}

function coordStr(p: MapPlace & { lat: number; lon: number }): string {
	return `${p.lat},${p.lon}`;
}

function searchToken(p: MapPlace): string {
	return p.name || (hasCoords(p) ? coordStr(p) : 'place');
}

/** "View on Google Maps" — prefers place_id, then coords (with name label), then name search. */
export function googleMapsLink(p: MapPlace): string {
	const base = 'https://www.google.com/maps/search/?api=1';
	if (p.place_id) {
		return `${base}&query=${encodeURIComponent(p.name || 'place')}&query_place_id=${encodeURIComponent(p.place_id)}`;
	}
	if (hasCoords(p)) {
		return `${base}&query=${encodeURIComponent(coordStr(p))}`;
	}
	return `${base}&query=${encodeURIComponent(searchToken(p))}`;
}

/** "Open in Apple Maps" — https form redirects into the app on iOS. */
export function appleMapsLink(p: MapPlace): string {
	const params = new URLSearchParams();
	if (p.name) {
		params.set('q', p.name);
	} else if (hasCoords(p)) {
		params.set('ll', coordStr(p));
	}
	return `https://maps.apple.com/?${params.toString()}`;
}

/** "Directions from here" — Google routes from the user's current location. */
export function googleDirectionsLink(p: MapPlace): string {
	const base = 'https://www.google.com/maps/dir/?api=1';
	if (p.place_id) {
		return `${base}&destination=${encodeURIComponent(p.name || 'place')}&destination_place_id=${encodeURIComponent(p.place_id)}`;
	}
	if (hasCoords(p)) return `${base}&destination=${encodeURIComponent(coordStr(p))}`;
	return `${base}&destination=${encodeURIComponent(p.name)}`;
}

function waypointToken(p: MapPlace): string {
	return hasCoords(p) ? coordStr(p) : p.name;
}

/**
 * Multi-stop directions for an ordered list of places (a day's route).
 * Returns null if fewer than 2 places. First = origin, last = destination,
 * the rest become waypoints (Google caps free waypoints ~9; we pass through).
 */
export function googleDayDirectionsLink(places: MapPlace[]): string | null {
	const usable = places.filter((p) => p.name || hasCoords(p));
	if (usable.length < 2) return null;
	const origin = usable[0];
	const destination = usable[usable.length - 1];
	const waypoints = usable.slice(1, -1);
	const params = new URLSearchParams({ api: '1' });
	params.set('origin', waypointToken(origin));
	params.set('destination', waypointToken(destination));
	if (waypoints.length) {
		params.set('waypoints', waypoints.map(waypointToken).join('|'));
	}
	return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/** Leg-by-leg directions links for consecutive pairs in an ordered route. */
export function googleLegByLegLinks(
	places: MapPlace[]
): Array<{ from: string; to: string; url: string }> | null {
	const usable = places.filter((p) => p.name || hasCoords(p));
	if (usable.length < 2) return null;
	return usable.slice(0, -1).map((from, i) => {
		const to = usable[i + 1];
		const params = new URLSearchParams({ api: '1' });
		params.set('origin', waypointToken(from));
		params.set('destination', waypointToken(to));
		return {
			from: from.name || waypointToken(from),
			to: to.name || waypointToken(to),
			url: `https://www.google.com/maps/dir/?${params.toString()}`
		};
	});
}

/** Day-plan directions using captured snapshot fields, robust to deleted places. */
export function dayPlanDirectionsLink(stops: DayPlanDirectionStop[]): string | null {
	return googleDayDirectionsLink(
		stops.map((s) => ({
			name: s.snapshot_title,
			lat: s.snapshot_lat,
			lon: s.snapshot_lon,
			place_id: s.snapshot_place_id
		}))
	);
}
