import { withTransaction } from '$lib/db';
import { orderParentsFirst } from './tree';

/**
 * Deep-copy a trip owned by `ownerId`: trip row + itinerary tree + packing
 * lists and their item trees. Returns the new trip id, or null if not owned.
 * Checked state is reset (a fresh trip starts unpacked).
 */
export async function duplicateTrip(ownerId: number, tripId: number): Promise<number | null> {
	return withTransaction(async (client) => {
		const trip = await client.query<{
			name: string;
			start_date: string;
			end_date: string;
			notes: string;
		}>(`SELECT name, start_date, end_date, notes FROM trips WHERE id = $1 AND owner_id = $2`, [
			tripId,
			ownerId
		]);
		if (trip.rowCount === 0) return null;
		const t = trip.rows[0];

		const newTrip = await client.query<{ id: number }>(
			`INSERT INTO trips (owner_id, name, start_date, end_date, notes)
			 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
			[ownerId, `${t.name} (copy)`, t.start_date, t.end_date, t.notes]
		);
		const newTripId = newTrip.rows[0].id;

		// Itinerary tree
		const itin = await client.query(
			`SELECT id, parent_id, sort_order, item_type, title, notes, lat, lon,
			        place_id, external_url, google_maps_url, date
			   FROM itinerary_items WHERE trip_id = $1`,
			[tripId]
		);
		const itinMap = new Map<number, number>();
		for (const r of orderParentsFirst(itin.rows)) {
			const np = r.parent_id === null ? null : (itinMap.get(r.parent_id) ?? null);
			const ins = await client.query<{ id: number }>(
				`INSERT INTO itinerary_items
				   (trip_id, parent_id, sort_order, item_type, title, notes, lat, lon,
				    place_id, external_url, google_maps_url, date)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
				[
					newTripId,
					np,
					r.sort_order,
					r.item_type,
					r.title,
					r.notes,
					r.lat,
					r.lon,
					r.place_id,
					r.external_url,
					r.google_maps_url,
					r.date
				]
			);
			itinMap.set(r.id, ins.rows[0].id);
		}

		// Packing lists + items
		const lists = await client.query(
			`SELECT id, name, sort_order FROM packing_lists WHERE trip_id = $1`,
			[tripId]
		);
		for (const list of lists.rows) {
			const newList = await client.query<{ id: number }>(
				`INSERT INTO packing_lists (trip_id, name, sort_order) VALUES ($1,$2,$3) RETURNING id`,
				[newTripId, list.name, list.sort_order]
			);
			const newListId = newList.rows[0].id;
			const items = await client.query(
				`SELECT id, parent_id, sort_order, name, quantity, category, notes
				   FROM packing_items WHERE list_id = $1`,
				[list.id]
			);
			const itemMap = new Map<number, number>();
			for (const r of orderParentsFirst(items.rows)) {
				const np = r.parent_id === null ? null : (itemMap.get(r.parent_id) ?? null);
				const ins = await client.query<{ id: number }>(
					`INSERT INTO packing_items
					   (list_id, parent_id, sort_order, name, quantity, checked, category, notes)
					 VALUES ($1,$2,$3,$4,$5,FALSE,$6,$7) RETURNING id`,
					[newListId, np, r.sort_order, r.name, r.quantity, r.category, r.notes]
				);
				itemMap.set(r.id, ins.rows[0].id);
			}
		}

		return newTripId;
	});
}
