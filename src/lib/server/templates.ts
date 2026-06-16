import { query, withTransaction } from '$lib/db';
import { orderParentsFirst } from './tree';

export interface PackingTemplate {
	id: number;
	name: string;
	item_count: number;
}

export async function listTemplates(ownerId: number): Promise<PackingTemplate[]> {
	const res = await query<PackingTemplate>(
		`SELECT pt.id, pt.name, COUNT(pti.id)::int AS item_count
		   FROM packing_templates pt
		   LEFT JOIN packing_template_items pti ON pti.template_id = pt.id
		  WHERE pt.owner_id = $1
		  GROUP BY pt.id
		  ORDER BY pt.name`,
		[ownerId]
	);
	return res.rows;
}

/** Save an existing packing list (owned by ownerId) as a reusable template. */
export async function saveListAsTemplate(
	ownerId: number,
	listId: number,
	name: string
): Promise<number | null> {
	return withTransaction(async (client) => {
		// Ownership: the list's trip must belong to ownerId.
		const own = await client.query(
			`SELECT 1 FROM packing_lists pl JOIN trips t ON t.id = pl.trip_id
			  WHERE pl.id = $1 AND t.owner_id = $2`,
			[listId, ownerId]
		);
		if (own.rowCount === 0) return null;

		const tmpl = await client.query<{ id: number }>(
			`INSERT INTO packing_templates (owner_id, name) VALUES ($1, $2) RETURNING id`,
			[ownerId, name]
		);
		const templateId = tmpl.rows[0].id;

		const items = await client.query(
			`SELECT id, parent_id, sort_order, name, category, quantity
			   FROM packing_items WHERE list_id = $1`,
			[listId]
		);
		const idMap = new Map<number, number>();
		for (const r of orderParentsFirst(items.rows)) {
			const np = r.parent_id === null ? null : (idMap.get(r.parent_id) ?? null);
			const ins = await client.query<{ id: number }>(
				`INSERT INTO packing_template_items
				   (template_id, parent_id, sort_order, name, category, quantity)
				 VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
				[templateId, np, r.sort_order, r.name, r.category, r.quantity]
			);
			idMap.set(r.id, ins.rows[0].id);
		}
		return templateId;
	});
}

/** Apply a template into a trip as a new packing list. Returns new list id. */
export async function applyTemplate(
	ownerId: number,
	templateId: number,
	tripId: number
): Promise<number | null> {
	return withTransaction(async (client) => {
		const tmpl = await client.query<{ name: string }>(
			`SELECT name FROM packing_templates WHERE id = $1 AND owner_id = $2`,
			[templateId, ownerId]
		);
		if (tmpl.rowCount === 0) return null;
		const trip = await client.query(`SELECT 1 FROM trips WHERE id = $1 AND owner_id = $2`, [
			tripId,
			ownerId
		]);
		if (trip.rowCount === 0) return null;

		const sortRes = await client.query<{ next: number }>(
			`SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM packing_lists WHERE trip_id = $1`,
			[tripId]
		);
		const list = await client.query<{ id: number }>(
			`INSERT INTO packing_lists (trip_id, name, sort_order) VALUES ($1, $2, $3) RETURNING id`,
			[tripId, tmpl.rows[0].name, sortRes.rows[0].next]
		);
		const listId = list.rows[0].id;

		const items = await client.query(
			`SELECT id, parent_id, sort_order, name, category, quantity
			   FROM packing_template_items WHERE template_id = $1`,
			[templateId]
		);
		const idMap = new Map<number, number>();
		for (const r of orderParentsFirst(items.rows)) {
			const np = r.parent_id === null ? null : (idMap.get(r.parent_id) ?? null);
			const ins = await client.query<{ id: number }>(
				`INSERT INTO packing_items
				   (list_id, parent_id, sort_order, name, quantity, checked, category)
				 VALUES ($1,$2,$3,$4,$5,FALSE,$6) RETURNING id`,
				[listId, np, r.sort_order, r.name, r.quantity, r.category]
			);
			idMap.set(r.id, ins.rows[0].id);
		}
		return listId;
	});
}

export async function deleteTemplate(ownerId: number, templateId: number): Promise<boolean> {
	const res = await query(`DELETE FROM packing_templates WHERE id = $1 AND owner_id = $2`, [
		templateId,
		ownerId
	]);
	return (res.rowCount ?? 0) > 0;
}

const STARTER: { name: string; children: string[] }[] = [
	{
		name: 'Documents',
		children: ['Passports', 'Boarding passes', 'Travel insurance', 'Reservations printout']
	},
	{ name: 'Clothing', children: ['Shirts', 'Trousers', 'Underwear', 'Socks', 'Rain jacket'] },
	{ name: 'Toiletries', children: ['Toothbrush + paste', 'Sunscreen', 'Medications', 'Razor'] },
	{ name: 'Electronics', children: ['Phone + charger', 'Camera', 'Adapters', 'Power bank'] }
];

/** Create the one-time starter "Essentials" template if the owner has none. */
export async function seedStarterTemplate(ownerId: number): Promise<number | null> {
	return withTransaction(async (client) => {
		const existing = await client.query(
			`SELECT 1 FROM packing_templates WHERE owner_id = $1 LIMIT 1`,
			[ownerId]
		);
		if ((existing.rowCount ?? 0) > 0) return null;

		const tmpl = await client.query<{ id: number }>(
			`INSERT INTO packing_templates (owner_id, name) VALUES ($1, 'Essentials') RETURNING id`,
			[ownerId]
		);
		const templateId = tmpl.rows[0].id;
		let topSort = 0;
		for (const cat of STARTER) {
			const parent = await client.query<{ id: number }>(
				`INSERT INTO packing_template_items (template_id, parent_id, sort_order, name)
				 VALUES ($1, NULL, $2, $3) RETURNING id`,
				[templateId, topSort++, cat.name]
			);
			let childSort = 0;
			for (const child of cat.children) {
				await client.query(
					`INSERT INTO packing_template_items (template_id, parent_id, sort_order, name)
					 VALUES ($1, $2, $3, $4)`,
					[templateId, parent.rows[0].id, childSort++, child]
				);
			}
		}
		return templateId;
	});
}
