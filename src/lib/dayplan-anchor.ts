/**
 * Day-plan route anchor options and resolution.
 *
 * Extracted from the trip page after a browser-found defect (2026-08-02): a plan
 * anchored to an accommodation reservation whose dates don't cover the plan date
 * resolved to NO anchor, because the option list filters reservations by date.
 * The dropdown still showed the anchor — the markup passes the persisted anchor
 * in as `currentAnchor` and the list appends it — but the resolver did not, so
 * it silently returned null.
 *
 * The damage was not merely a missing label. A null anchor turned an anchored
 * loop into an open path: "Optimize order" planned a route from the first stop
 * instead of the lodging, then produced n-1 legs for a plan the server knew was
 * anchored, so the write was rejected after the old data had already been
 * cleared. Wrong order, lost data, and a page still painting the old totals.
 *
 * Hence: `currentAnchor` is a REQUIRED argument here, not an optional one. For a
 * saved plan, always pass its persisted anchor.
 *
 * Pure: no Svelte, no DB, no fetch.
 */

export interface AnchorOption {
	value: string;
	label: string;
	title: string;
	lat: number | null;
	lon: number | null;
}

export interface PlanAnchor {
	source: string;
	title: string;
	lat: number;
	lon: number;
}

export interface AnchorReservation {
	id: number;
	title: string;
	reservation_type: string | null;
	start_at: string | null;
	end_at: string | null;
}

export interface AnchorPlace {
	id: number;
	title: string;
	lat: number | null;
	lon: number | null;
}

/**
 * Strip the picker's grouping prefix from a stored anchor title.
 *
 * anchorOptions builds labels as "Place: X" / "Stay: Y" so the dropdown groups
 * sensibly, and that label is what gets persisted to day_plans.anchor_title.
 * The prefix is a UI affordance for choosing one; once chosen it reads as noise
 * ("Drive home to Place: Blue Hill, ME"). Lives here, with the code that adds
 * the prefix, so the two stay in sync.
 */
export function cleanAnchorTitle(title: string): string {
	return title.replace(/^(Place|Stay|Reservation):\s*/i, '');
}

export function normTitle(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

/**
 * Does a reservation's stay cover the plan's date?
 *
 * Undated on either side counts as a match — an undated plan or an open-ended
 * reservation shouldn't hide a legitimate lodging option.
 */
export function dateMatchesReservation(
	planDate: string | null,
	reservation: Pick<AnchorReservation, 'start_at' | 'end_at'>
): boolean {
	if (!planDate || (!reservation.start_at && !reservation.end_at)) return true;
	const start = reservation.start_at?.slice(0, 10) ?? null;
	const end = reservation.end_at?.slice(0, 10) ?? start;
	if (!start) return true;
	return planDate >= start && planDate <= (end ?? start);
}

/** The itinerary place whose title matches a reservation, so lodging gets coordinates. */
export function matchingPlaceForReservation(
	reservation: Pick<AnchorReservation, 'title'>,
	places: AnchorPlace[]
): AnchorPlace | undefined {
	const target = normTitle(reservation.title);
	return places.find((place) => {
		if (place.lat == null || place.lon == null) return false;
		const name = normTitle(place.title);
		return name === target || name.includes(target) || target.includes(name);
	});
}

/**
 * Build the anchor dropdown: no-anchor, date-matching lodging, every located
 * place, and — appended last — the plan's persisted anchor if the filters above
 * excluded it. That last clause is what keeps a saved anchor selectable.
 */
export function anchorOptions(
	planDate: string | null,
	reservations: AnchorReservation[],
	places: AnchorPlace[],
	currentAnchor: PlanAnchor | null = null
): AnchorOption[] {
	const options: AnchorOption[] = [
		{ value: 'none', label: 'No anchor', title: '', lat: null, lon: null }
	];

	for (const reservation of reservations) {
		if (
			reservation.reservation_type !== 'accommodation' ||
			!dateMatchesReservation(planDate, reservation)
		) {
			continue;
		}
		const place = matchingPlaceForReservation(reservation, places);
		if (place?.lat != null && place.lon != null) {
			options.push({
				value: `res:${reservation.id}`,
				label: `Stay: ${reservation.title}`,
				title: `Stay: ${reservation.title}`,
				lat: place.lat,
				lon: place.lon
			});
		}
	}

	for (const place of places) {
		if (place.lat == null || place.lon == null) continue;
		options.push({
			value: `place:${place.id}`,
			label: `Place: ${place.title}`,
			title: `Place: ${place.title}`,
			lat: place.lat,
			lon: place.lon
		});
	}

	if (currentAnchor && !options.some((option) => option.value === currentAnchor.source)) {
		options.push({
			value: currentAnchor.source,
			label: currentAnchor.title,
			title: currentAnchor.title,
			lat: currentAnchor.lat,
			lon: currentAnchor.lon
		});
	}

	return options;
}

/**
 * Resolve a dropdown value to coordinates. Pass a saved plan's persisted anchor
 * as `currentAnchor` — see the module comment for what happens when you don't.
 */
export function anchorFromValue(
	value: string,
	planDate: string | null,
	reservations: AnchorReservation[],
	places: AnchorPlace[],
	currentAnchor: PlanAnchor | null = null
): PlanAnchor | null {
	const option = anchorOptions(planDate, reservations, places, currentAnchor).find(
		(o) => o.value === value
	);
	return option?.lat != null && option.lon != null
		? { source: option.value, title: option.title, lat: option.lat, lon: option.lon }
		: null;
}
