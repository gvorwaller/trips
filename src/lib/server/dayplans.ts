import type pg from 'pg';
import { query, withTransaction } from '$lib/db';
import { haversineKm } from '$lib/geo';

export interface DayPlan {
	id: number;
	trip_id: number;
	title: string;
	notes: string | null;
	optional_date: string | null;
	anchor_source: string | null;
	anchor_title: string | null;
	anchor_lat: number | null;
	anchor_lon: number | null;
	created_at: string;
	updated_at: string;
}

export interface DayPlanStop {
	id: number;
	day_plan_id: number;
	itinerary_item_id: number | null;
	sort_order: number;
	notes: string | null;
	visited: boolean;
	snapshot_title: string;
	snapshot_lat: number | null;
	snapshot_lon: number | null;
	snapshot_place_id: string | null;
	drive_km: number | null;
	drive_min: number | null;
	ai_notes: string | null;
}

export interface DayPlanInput {
	title: string;
	notes: string | null;
	optional_date: string | null;
}

export interface AnchorInput {
	source: string;
	title: string;
	lat: number;
	lon: number;
}

export interface StopInput {
	itinerary_item_id: number;
	notes: string | null;
}

export interface DrivingLegInput {
	stopId: number;
	km: number;
	min: number;
}

export interface OptimizeOrigin {
	lat: number;
	lon: number;
}

const DUPLICATE_COORD_KM = 0.03;

export class DuplicateDayPlanStopError extends Error {
	constructor(title: string) {
		super(`${title} is already in this route.`);
		this.name = 'DuplicateDayPlanStopError';
	}
}

const PLAN_SELECT = `id, trip_id, title, notes,
	to_char(optional_date, 'YYYY-MM-DD') AS optional_date,
	anchor_source, anchor_title, anchor_lat, anchor_lon,
	created_at::text AS created_at,
	updated_at::text AS updated_at`;

interface LocationIdentity {
	title: string;
	itinerary_item_id: number | null;
	place_id: string | null;
	lat: number | null;
	lon: number | null;
}

function cleanPlaceId(placeId: string | null): string | null {
	const s = placeId?.trim();
	return s ? s : null;
}

function sameRouteLocation(a: LocationIdentity, b: LocationIdentity): boolean {
	if (
		a.itinerary_item_id !== null &&
		b.itinerary_item_id !== null &&
		a.itinerary_item_id === b.itinerary_item_id
	) {
		return true;
	}
	const aPlace = cleanPlaceId(a.place_id);
	const bPlace = cleanPlaceId(b.place_id);
	if (aPlace && bPlace) return aPlace === bPlace;
	if (
		typeof a.lat === 'number' &&
		typeof a.lon === 'number' &&
		typeof b.lat === 'number' &&
		typeof b.lon === 'number'
	) {
		return haversineKm(a.lat, a.lon, b.lat, b.lon) <= DUPLICATE_COORD_KM;
	}
	return false;
}

async function assertLocationIsNewToPlan(
	client: Pick<pg.PoolClient, 'query'>,
	planId: number,
	candidate: LocationIdentity
): Promise<void> {
	const anchor = await client.query<{
		anchor_source: string | null;
		anchor_title: string | null;
		anchor_lat: number | null;
		anchor_lon: number | null;
	}>(
		`SELECT anchor_source, anchor_title, anchor_lat, anchor_lon
		   FROM day_plans
		  WHERE id = $1`,
		[planId]
	);
	const anchorRow = anchor.rows[0];
	if (anchorRow?.anchor_title && anchorRow.anchor_lat !== null && anchorRow.anchor_lon !== null) {
		const anchorIdentity: LocationIdentity = {
			title: anchorRow.anchor_title,
			itinerary_item_id: anchorRow.anchor_source?.startsWith('place:')
				? Number(anchorRow.anchor_source.slice(6)) || null
				: null,
			place_id: null,
			lat: anchorRow.anchor_lat,
			lon: anchorRow.anchor_lon
		};
		if (sameRouteLocation(candidate, anchorIdentity)) {
			throw new DuplicateDayPlanStopError(anchorIdentity.title);
		}
	}

	const existing = await client.query<LocationIdentity>(
		`SELECT itinerary_item_id,
		        snapshot_title AS title,
		        snapshot_place_id AS place_id,
		        snapshot_lat AS lat,
		        snapshot_lon AS lon
		   FROM day_plan_stops
		  WHERE day_plan_id = $1`,
		[planId]
	);
	for (const stop of existing.rows) {
		if (sameRouteLocation(candidate, stop)) {
			throw new DuplicateDayPlanStopError(stop.title);
		}
	}
}

async function assertAnchorIsNewToPlan(
	client: Pick<pg.PoolClient, 'query'>,
	planId: number,
	anchor: AnchorInput | null
): Promise<void> {
	if (!anchor) return;
	const candidate: LocationIdentity = {
		title: anchor.title,
		itinerary_item_id: anchor.source.startsWith('place:')
			? Number(anchor.source.slice(6)) || null
			: null,
		place_id: null,
		lat: anchor.lat,
		lon: anchor.lon
	};
	const existing = await client.query<LocationIdentity>(
		`SELECT itinerary_item_id,
		        snapshot_title AS title,
		        snapshot_place_id AS place_id,
		        snapshot_lat AS lat,
		        snapshot_lon AS lon
		   FROM day_plan_stops
		  WHERE day_plan_id = $1`,
		[planId]
	);
	for (const stop of existing.rows) {
		if (sameRouteLocation(candidate, stop)) {
			throw new DuplicateDayPlanStopError(stop.title);
		}
	}
}

export async function listDayPlans(tripId: number): Promise<DayPlan[]> {
	const res = await query<DayPlan>(
		`SELECT ${PLAN_SELECT}
		   FROM day_plans
		  WHERE trip_id = $1
		  ORDER BY optional_date NULLS LAST, id`,
		[tripId]
	);
	return res.rows;
}

export async function getDayPlan(tripId: number, planId: number): Promise<DayPlan | null> {
	const res = await query<DayPlan>(
		`SELECT ${PLAN_SELECT} FROM day_plans WHERE id = $1 AND trip_id = $2`,
		[planId, tripId]
	);
	return res.rows[0] ?? null;
}

async function assertPlanInTrip(
	client: Pick<pg.PoolClient, 'query'>,
	tripId: number,
	planId: number
): Promise<boolean> {
	const res = await client.query(`SELECT 1 FROM day_plans WHERE id = $1 AND trip_id = $2`, [
		planId,
		tripId
	]);
	return (res.rowCount ?? 0) > 0;
}

/**
 * Copy a day plan and its stops under a new title, within the same trip.
 *
 * Mirrors the deep copy duplicateTrip already performs (src/lib/server/clone.ts)
 * and keeps its policy: `visited` resets, and drive_km/drive_min/ai_notes are
 * deliberately not copied because drive legs get recomputed and AI notes
 * regenerated for the new plan.
 *
 * Stops are copied row-for-row rather than through addStop/insertStop, so the
 * duplicate-location guard does not re-fire — the source plan is already valid,
 * and re-running the 30 m proximity check would reject legitimate copies. This
 * matches how clone.ts copies stops.
 *
 * itinerary_item_id carries over unchanged: unlike clone.ts, which remaps ids
 * because it rebuilds the itinerary in a new trip, this stays in one trip so the
 * references remain valid. The same is true of the anchor's `place:<id>` /
 * `res:<id>` reference.
 *
 * Returns the new plan id, or null when the source plan is not in this trip.
 */
export async function duplicateDayPlan(
	tripId: number,
	planId: number,
	title: string
): Promise<number | null> {
	return withTransaction(async (client) => {
		const source = await client.query<{
			notes: string | null;
			optional_date: string | null;
			anchor_source: string | null;
			anchor_title: string | null;
			anchor_lat: number | null;
			anchor_lon: number | null;
		}>(
			`SELECT notes, optional_date, anchor_source, anchor_title, anchor_lat, anchor_lon
			   FROM day_plans WHERE id = $1 AND trip_id = $2`,
			[planId, tripId]
		);
		const plan = source.rows[0];
		if (!plan) return null;

		// The four anchor columns move together or not at all: day_plans_anchor_complete
		// (migration 0009) rejects a partially populated anchor.
		const created = await client.query<{ id: number }>(
			`INSERT INTO day_plans
			   (trip_id, title, notes, optional_date, anchor_source, anchor_title, anchor_lat, anchor_lon)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			 RETURNING id`,
			[
				tripId,
				title,
				plan.notes,
				plan.optional_date,
				plan.anchor_source,
				plan.anchor_title,
				plan.anchor_lat,
				plan.anchor_lon
			]
		);
		const newPlanId = created.rows[0].id;

		await client.query(
			`INSERT INTO day_plan_stops
			   (day_plan_id, itinerary_item_id, sort_order, notes, visited,
			    snapshot_title, snapshot_lat, snapshot_lon, snapshot_place_id)
			 SELECT $1, itinerary_item_id, sort_order, notes, FALSE,
			        snapshot_title, snapshot_lat, snapshot_lon, snapshot_place_id
			   FROM day_plan_stops
			  WHERE day_plan_id = $2
			  ORDER BY sort_order, id`,
			[newPlanId, planId]
		);

		return newPlanId;
	});
}

async function insertStop(
	client: Pick<pg.PoolClient, 'query'>,
	tripId: number,
	planId: number,
	sortOrder: number,
	input: StopInput
): Promise<number | null> {
	const item = await client.query<{
		id: number;
		title: string;
		lat: number | null;
		lon: number | null;
		place_id: string | null;
	}>(
		`SELECT id, title, lat, lon, place_id
		   FROM itinerary_items
		  WHERE id = $1 AND trip_id = $2`,
		[input.itinerary_item_id, tripId]
	);
	if (item.rowCount === 0) return null;
	const i = item.rows[0];
	await assertLocationIsNewToPlan(client, planId, {
		title: i.title,
		itinerary_item_id: i.id,
		place_id: i.place_id,
		lat: i.lat,
		lon: i.lon
	});
	const res = await client.query<{ id: number }>(
		`INSERT INTO day_plan_stops
		   (day_plan_id, itinerary_item_id, sort_order, notes,
		    snapshot_title, snapshot_lat, snapshot_lon, snapshot_place_id)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		 RETURNING id`,
		[planId, i.id, sortOrder, input.notes, i.title, i.lat, i.lon, i.place_id]
	);
	return res.rows[0].id;
}

export async function createDayPlan(
	tripId: number,
	input: DayPlanInput & { stops: StopInput[]; anchor?: AnchorInput | null }
): Promise<number> {
	return withTransaction(async (client) => {
		const plan = await client.query<{ id: number }>(
			`INSERT INTO day_plans
			   (trip_id, title, notes, optional_date, anchor_source, anchor_title, anchor_lat, anchor_lon)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
			 RETURNING id`,
			[
				tripId,
				input.title,
				input.notes,
				input.optional_date,
				input.anchor?.source ?? null,
				input.anchor?.title ?? null,
				input.anchor?.lat ?? null,
				input.anchor?.lon ?? null
			]
		);
		const planId = plan.rows[0].id;
		let sort = 0;
		for (const stop of input.stops) {
			const id = await insertStop(client, tripId, planId, sort, stop);
			if (id !== null) sort += 1;
		}
		return planId;
	});
}

export async function setDayPlanAnchor(
	tripId: number,
	planId: number,
	anchor: AnchorInput | null
): Promise<boolean> {
	return withTransaction(async (client) => {
		if (!(await assertPlanInTrip(client, tripId, planId))) return false;
		await assertAnchorIsNewToPlan(client, planId, anchor);
		const res = await client.query(
			`UPDATE day_plans
			    SET anchor_source = $3,
			        anchor_title = $4,
			        anchor_lat = $5,
			        anchor_lon = $6,
			        updated_at = NOW()
			  WHERE id = $1 AND trip_id = $2`,
			[
				planId,
				tripId,
				anchor?.source ?? null,
				anchor?.title ?? null,
				anchor?.lat ?? null,
				anchor?.lon ?? null
			]
		);
		return (res.rowCount ?? 0) > 0;
	});
}

export async function updateDayPlan(
	tripId: number,
	planId: number,
	input: DayPlanInput
): Promise<boolean> {
	const res = await query(
		`UPDATE day_plans
		    SET title = $3, notes = $4, optional_date = $5, updated_at = NOW()
		  WHERE id = $1 AND trip_id = $2`,
		[planId, tripId, input.title, input.notes, input.optional_date]
	);
	return (res.rowCount ?? 0) > 0;
}

export async function deleteDayPlan(tripId: number, planId: number): Promise<boolean> {
	const res = await query(`DELETE FROM day_plans WHERE id = $1 AND trip_id = $2`, [planId, tripId]);
	return (res.rowCount ?? 0) > 0;
}

export async function addStop(
	tripId: number,
	planId: number,
	input: StopInput
): Promise<number | null> {
	return withTransaction(async (client) => {
		if (!(await assertPlanInTrip(client, tripId, planId))) return null;
		const sort = await client.query<{ next: number }>(
			`SELECT COALESCE(MAX(sort_order) + 1, 0) AS next
			   FROM day_plan_stops
			  WHERE day_plan_id = $1`,
			[planId]
		);
		const id = await insertStop(client, tripId, planId, sort.rows[0].next, input);
		if (id !== null) {
			await clearDrivingForPlan(client, planId);
			await client.query(`UPDATE day_plans SET updated_at = NOW() WHERE id = $1`, [planId]);
		}
		return id;
	});
}

export async function removeStop(tripId: number, stopId: number): Promise<boolean> {
	return withTransaction(async (client) => {
		const stop = await client.query<{ day_plan_id: number }>(
			`SELECT s.day_plan_id
			   FROM day_plan_stops s
			   JOIN day_plans p ON p.id = s.day_plan_id
			  WHERE s.id = $1 AND p.trip_id = $2`,
			[stopId, tripId]
		);
		if (stop.rowCount === 0) return false;
		const planId = stop.rows[0].day_plan_id;
		await client.query(`DELETE FROM day_plan_stops WHERE id = $1`, [stopId]);
		await reindexStops(client, planId);
		await clearDrivingForPlan(client, planId);
		await client.query(`UPDATE day_plans SET updated_at = NOW() WHERE id = $1`, [planId]);
		return true;
	});
}

async function reindexStops(client: Pick<pg.PoolClient, 'query'>, planId: number): Promise<void> {
	const stops = await client.query<{ id: number }>(
		`SELECT id FROM day_plan_stops WHERE day_plan_id = $1 ORDER BY sort_order, id`,
		[planId]
	);
	for (let i = 0; i < stops.rows.length; i++) {
		await client.query(`UPDATE day_plan_stops SET sort_order = $2 WHERE id = $1`, [
			stops.rows[i].id,
			i
		]);
	}
}

async function clearDrivingForPlan(
	client: Pick<pg.PoolClient, 'query'>,
	planId: number
): Promise<void> {
	await client.query(
		`UPDATE day_plan_stops
		    SET drive_km = NULL, drive_min = NULL
		  WHERE day_plan_id = $1`,
		[planId]
	);
}

export async function reorderStops(
	tripId: number,
	planId: number,
	orderedStopIds: number[]
): Promise<boolean> {
	return withTransaction(async (client) => {
		if (!(await assertPlanInTrip(client, tripId, planId))) return false;
		const existing = await client.query<{ id: number }>(
			`SELECT id FROM day_plan_stops WHERE day_plan_id = $1 ORDER BY sort_order, id`,
			[planId]
		);
		const existingIds = existing.rows.map((r) => r.id);
		if (
			orderedStopIds.length !== existingIds.length ||
			new Set(orderedStopIds).size !== orderedStopIds.length ||
			!orderedStopIds.every((id) => existingIds.includes(id))
		) {
			return false;
		}
		for (let i = 0; i < orderedStopIds.length; i++) {
			await client.query(`UPDATE day_plan_stops SET sort_order = $2 WHERE id = $1`, [
				orderedStopIds[i],
				i
			]);
		}
		await clearDrivingForPlan(client, planId);
		await client.query(`UPDATE day_plans SET updated_at = NOW() WHERE id = $1`, [planId]);
		return true;
	});
}

export async function updateStopNotes(
	tripId: number,
	stopId: number,
	notes: string | null
): Promise<boolean> {
	const res = await query(
		`UPDATE day_plan_stops s
		    SET notes = $3
		   FROM day_plans p
		  WHERE s.id = $1 AND s.day_plan_id = p.id AND p.trip_id = $2`,
		[stopId, tripId, notes]
	);
	return (res.rowCount ?? 0) > 0;
}

export async function bulkUpdateAiNotes(
	tripId: number,
	planId: number,
	notes: Record<number, string>
): Promise<boolean> {
	return withTransaction(async (client) => {
		if (!(await assertPlanInTrip(client, tripId, planId))) return false;
		const stopRes = await client.query<{ id: number }>(
			`SELECT id FROM day_plan_stops WHERE day_plan_id = $1`,
			[planId]
		);
		const validIds = new Set(stopRes.rows.map((r) => r.id));
		for (const [id, note] of Object.entries(notes)) {
			const stopId = Number(id);
			if (!validIds.has(stopId)) continue;
			await client.query(`UPDATE day_plan_stops SET ai_notes = $2 WHERE id = $1`, [
				stopId,
				note.slice(0, 2000)
			]);
		}
		await client.query(`UPDATE day_plans SET updated_at = NOW() WHERE id = $1`, [planId]);
		return true;
	});
}

export async function setStopVisited(
	ownerId: number,
	stopId: number,
	visited: boolean
): Promise<boolean> {
	const res = await query(
		`UPDATE day_plan_stops s
		    SET visited = $3
		   FROM day_plans p
		   JOIN trips t ON t.id = p.trip_id
		  WHERE s.id = $1 AND s.day_plan_id = p.id AND t.owner_id = $2`,
		[stopId, ownerId, visited]
	);
	return (res.rowCount ?? 0) > 0;
}

export async function listStopsForTrip(tripId: number): Promise<DayPlanStop[]> {
	const res = await query<DayPlanStop>(
		`SELECT s.id, s.day_plan_id, s.itinerary_item_id, s.sort_order, s.notes, s.visited,
		        s.snapshot_title, s.snapshot_lat, s.snapshot_lon, s.snapshot_place_id,
		        s.drive_km, s.drive_min, s.ai_notes
		   FROM day_plan_stops s
		   JOIN day_plans p ON p.id = s.day_plan_id
		  WHERE p.trip_id = $1
		  ORDER BY s.day_plan_id, s.sort_order, s.id`,
		[tripId]
	);
	return res.rows;
}

export async function bulkUpdateDriving(
	tripId: number,
	planId: number,
	legs: DrivingLegInput[]
): Promise<boolean> {
	return withTransaction(async (client) => {
		if (!(await assertPlanInTrip(client, tripId, planId))) return false;
		const stopRes = await client.query<{ id: number }>(
			`SELECT id FROM day_plan_stops WHERE day_plan_id = $1 ORDER BY sort_order, id`,
			[planId]
		);
		const planRes = await client.query<{ anchor_lat: number | null; anchor_lon: number | null }>(
			`SELECT anchor_lat, anchor_lon FROM day_plans WHERE id = $1 AND trip_id = $2`,
			[planId, tripId]
		);
		const hasAnchor = planRes.rows[0]?.anchor_lat != null && planRes.rows[0]?.anchor_lon != null;
		const expectedLegStopIds = (hasAnchor ? stopRes.rows : stopRes.rows.slice(1)).map((r) => r.id);
		if (
			legs.length !== expectedLegStopIds.length ||
			new Set(legs.map((leg) => leg.stopId)).size !== legs.length ||
			!legs.every((leg, i) => leg.stopId === expectedLegStopIds[i])
		) {
			return false;
		}

		await clearDrivingForPlan(client, planId);
		for (const leg of legs) {
			await client.query(
				`UPDATE day_plan_stops
				    SET drive_km = $3, drive_min = $4
				  WHERE id = $1 AND day_plan_id = $2`,
				[leg.stopId, planId, leg.km, leg.min]
			);
		}
		await client.query(`UPDATE day_plans SET updated_at = NOW() WHERE id = $1`, [planId]);
		return true;
	});
}

export async function optimizeStopOrder(
	tripId: number,
	planId: number,
	origin: OptimizeOrigin | null
): Promise<number[] | null> {
	return withTransaction(async (client) => {
		if (!(await assertPlanInTrip(client, tripId, planId))) return null;
		const res = await client.query<{
			id: number;
			snapshot_lat: number | null;
			snapshot_lon: number | null;
		}>(
			`SELECT id, snapshot_lat, snapshot_lon
			   FROM day_plan_stops
			  WHERE day_plan_id = $1
			  ORDER BY sort_order, id`,
			[planId]
		);
		if (res.rows.length < 2) return res.rows.map((r) => r.id);
		const located = res.rows.filter(
			(r): r is { id: number; snapshot_lat: number; snapshot_lon: number } =>
				typeof r.snapshot_lat === 'number' && typeof r.snapshot_lon === 'number'
		);
		const unlocated = res.rows.filter(
			(r) => typeof r.snapshot_lat !== 'number' || typeof r.snapshot_lon !== 'number'
		);
		if (located.length < 2) return res.rows.map((r) => r.id);

		let current = origin ?? { lat: located[0].snapshot_lat, lon: located[0].snapshot_lon };
		const remaining = origin ? [...located] : located.slice(1);
		const ordered = origin ? [] : [located[0]];

		while (remaining.length > 0) {
			let bestIndex = 0;
			let bestKm = Number.POSITIVE_INFINITY;
			for (let i = 0; i < remaining.length; i++) {
				const candidate = remaining[i];
				const km = haversineKm(
					current.lat,
					current.lon,
					candidate.snapshot_lat,
					candidate.snapshot_lon
				);
				if (km < bestKm) {
					bestKm = km;
					bestIndex = i;
				}
			}
			const [next] = remaining.splice(bestIndex, 1);
			ordered.push(next);
			current = { lat: next.snapshot_lat, lon: next.snapshot_lon };
		}

		const orderedIds = [...ordered.map((r) => r.id), ...unlocated.map((r) => r.id)];
		for (let i = 0; i < orderedIds.length; i++) {
			await client.query(`UPDATE day_plan_stops SET sort_order = $2 WHERE id = $1`, [
				orderedIds[i],
				i
			]);
		}
		await clearDrivingForPlan(client, planId);
		await client.query(`UPDATE day_plans SET updated_at = NOW() WHERE id = $1`, [planId]);
		return orderedIds;
	});
}
