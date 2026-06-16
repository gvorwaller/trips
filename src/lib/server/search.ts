import { query } from '$lib/db';

export type HitKind = 'trip' | 'place' | 'packing' | 'reservation';

export interface SearchHit {
	kind: HitKind;
	trip_id: number;
	trip_name: string;
	title: string;
	item_id: number | null;
}

/** Simple ILIKE search across an owner's trips, places, packing, reservations. */
export async function search(ownerId: number, q: string): Promise<SearchHit[]> {
	const term = q.trim().toLowerCase();
	if (term.length < 2) return [];
	const like = `%${term}%`;
	const res = await query<SearchHit>(
		`SELECT 'trip'::text AS kind, t.id AS trip_id, t.name AS trip_name, t.name AS title, NULL::int AS item_id
		   FROM trips t
		  WHERE t.owner_id = $1 AND lower(t.name) LIKE $2
		 UNION ALL
		 SELECT 'place', t.id, t.name, ii.title, ii.id
		   FROM itinerary_items ii JOIN trips t ON t.id = ii.trip_id
		  WHERE t.owner_id = $1 AND (lower(ii.title) LIKE $2 OR lower(COALESCE(ii.notes, '')) LIKE $2)
		 UNION ALL
		 SELECT 'packing', t.id, t.name, pi.name, pi.id
		   FROM packing_items pi
		   JOIN packing_lists pl ON pl.id = pi.list_id
		   JOIN trips t ON t.id = pl.trip_id
		  WHERE t.owner_id = $1 AND lower(pi.name) LIKE $2
		 UNION ALL
		 SELECT 'reservation', t.id, t.name, r.title, r.id
		   FROM reservations r JOIN trips t ON t.id = r.trip_id
		  WHERE t.owner_id = $1 AND lower(r.title) LIKE $2
		 LIMIT 50`,
		[ownerId, like]
	);
	return res.rows;
}
