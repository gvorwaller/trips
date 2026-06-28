import { randomBytes } from 'node:crypto';
import { withTransaction } from '$lib/db';
import { duplicateTripName } from '$lib/duplicate-name';
import { orderParentsFirst } from './tree';
import { copyObject, storageConfigured } from './storage';

/**
 * Deep-copy a trip owned by `ownerId`: trip row + itinerary tree + packing
 * lists + expenses + day plans + reservations + attachments/documents.
 * File attachments get a new S3 object copy. Checked/visited state is reset.
 * Returns the new trip id, or null if not owned.
 */
export async function duplicateTrip(
	ownerId: number,
	tripId: number,
	timeZone?: string | null
): Promise<number | null> {
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
			[ownerId, duplicateTripName(t.name, new Date(), timeZone), t.start_date, t.end_date, t.notes]
		);
		const newTripId = newTrip.rows[0].id;

		// Itinerary tree
		const itin = await client.query(
			`SELECT id, parent_id, sort_order, item_type, title, notes, lat, lon,
			        place_id, apple_maps_place_id, external_url, google_maps_url, date
			   FROM itinerary_items WHERE trip_id = $1`,
			[tripId]
		);
		const itinMap = new Map<number, number>();
		for (const r of orderParentsFirst(itin.rows)) {
			const np = r.parent_id === null ? null : (itinMap.get(r.parent_id) ?? null);
			const ins = await client.query<{ id: number }>(
				`INSERT INTO itinerary_items
				   (trip_id, parent_id, sort_order, item_type, title, notes, lat, lon,
				    place_id, apple_maps_place_id, external_url, google_maps_url, date)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
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
					r.apple_maps_place_id,
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

		// Expenses (flat rows, no tree)
		const expenses = await client.query(
			`SELECT expense_date, description, amount_cents, category, notes, sort_order
			   FROM expenses WHERE trip_id = $1`,
			[tripId]
		);
		for (const e of expenses.rows) {
			await client.query(
				`INSERT INTO expenses (trip_id, expense_date, description, amount_cents, category, notes, sort_order)
				 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
				[newTripId, e.expense_date, e.description, e.amount_cents, e.category, e.notes, e.sort_order]
			);
		}

		// Day plans + stops. Stop visited state resets for a fresh copy, like packing checks.
		const plans = await client.query(
			`SELECT id, title, notes, optional_date FROM day_plans WHERE trip_id = $1 ORDER BY id`,
			[tripId]
		);
		for (const plan of plans.rows) {
			const newPlan = await client.query<{ id: number }>(
				`INSERT INTO day_plans (trip_id, title, notes, optional_date)
				 VALUES ($1,$2,$3,$4)
				 RETURNING id`,
				[newTripId, plan.title, plan.notes, plan.optional_date]
			);
			const stops = await client.query(
				`SELECT itinerary_item_id, sort_order, notes, snapshot_title,
				        snapshot_lat, snapshot_lon, snapshot_place_id
				   FROM day_plan_stops
				  WHERE day_plan_id = $1
				  ORDER BY sort_order, id`,
				[plan.id]
			);
			for (const s of stops.rows) {
				const remappedItemId = s.itinerary_item_id
					? (itinMap.get(s.itinerary_item_id) ?? null)
					: null;
				await client.query(
					`INSERT INTO day_plan_stops
					   (day_plan_id, itinerary_item_id, sort_order, notes, visited,
					    snapshot_title, snapshot_lat, snapshot_lon, snapshot_place_id)
					 VALUES ($1,$2,$3,$4,FALSE,$5,$6,$7,$8)`,
					[
						newPlan.rows[0].id,
						remappedItemId,
						s.sort_order,
						s.notes,
						s.snapshot_title,
						s.snapshot_lat,
						s.snapshot_lon,
						s.snapshot_place_id
					]
				);
			}
		}

		// Reservations
		const reservations = await client.query(
			`SELECT id, reservation_type, title, confirmation_code, status,
			        start_at, end_at, details, notes, sort_order
			   FROM reservations WHERE trip_id = $1`,
			[tripId]
		);
		const resMap = new Map<number, number>();
		for (const r of reservations.rows) {
			const ins = await client.query<{ id: number }>(
				`INSERT INTO reservations
				   (trip_id, reservation_type, title, confirmation_code, status,
				    start_at, end_at, details, notes, sort_order)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
				[
					newTripId, r.reservation_type, r.title, r.confirmation_code,
					r.status, r.start_at, r.end_at, r.details, r.notes, r.sort_order
				]
			);
			resMap.set(r.id, ins.rows[0].id);
		}

		// Attachments (files get a new S3 copy; text docs are just row copies)
		const attachments = await client.query(
			`SELECT id, reservation_id, itinerary_item_id, packing_item_id,
			        original_name, display_name, mime_type, size_bytes,
			        object_key, kind, text_content, meta, status
			   FROM attachments WHERE trip_id = $1`,
			[tripId]
		);
		const canCopyFiles = storageConfigured();
		for (const a of attachments.rows) {
			const newResId = a.reservation_id ? (resMap.get(a.reservation_id) ?? null) : null;
			const newItinId = a.itinerary_item_id ? (itinMap.get(a.itinerary_item_id) ?? null) : null;

			let newObjectKey = a.object_key;
			if (a.kind === 'file' && a.object_key && canCopyFiles) {
				newObjectKey = `trips/${newTripId}/${randomBytes(8).toString('hex')}/${a.original_name}`;
				await copyObject(a.object_key, newObjectKey);
			}

			await client.query(
				`INSERT INTO attachments
				   (trip_id, reservation_id, itinerary_item_id, packing_item_id,
				    original_name, display_name, mime_type, size_bytes,
				    object_key, kind, text_content, meta, status)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
				[
					newTripId, newResId, newItinId, null,
					a.original_name, a.display_name, a.mime_type, a.size_bytes,
					newObjectKey, a.kind, a.text_content, a.meta, a.status
				]
			);
		}

		return newTripId;
	});
}
