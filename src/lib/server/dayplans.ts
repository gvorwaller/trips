import type pg from 'pg';
import { query, withTransaction } from '$lib/db';

export interface DayPlan {
	id: number;
	trip_id: number;
	title: string;
	notes: string | null;
	optional_date: string | null;
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
}

export interface DayPlanInput {
	title: string;
	notes: string | null;
	optional_date: string | null;
}

export interface StopInput {
	itinerary_item_id: number;
	notes: string | null;
}

const PLAN_SELECT = `id, trip_id, title, notes,
	to_char(optional_date, 'YYYY-MM-DD') AS optional_date,
	created_at::text AS created_at,
	updated_at::text AS updated_at`;

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
	const res = await client.query<{ id: number }>(
		`INSERT INTO day_plan_stops
		   (day_plan_id, itinerary_item_id, sort_order, notes,
		    snapshot_title, snapshot_lat, snapshot_lon, snapshot_place_id)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		 RETURNING id`,
		[
			planId,
			i.id,
			sortOrder,
			input.notes,
			i.title,
			i.lat,
			i.lon,
			i.place_id
		]
	);
	return res.rows[0].id;
}

export async function createDayPlan(
	tripId: number,
	input: DayPlanInput & { stops: StopInput[] }
): Promise<number> {
	return withTransaction(async (client) => {
		const plan = await client.query<{ id: number }>(
			`INSERT INTO day_plans (trip_id, title, notes, optional_date)
			 VALUES ($1,$2,$3,$4)
			 RETURNING id`,
			[tripId, input.title, input.notes, input.optional_date]
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
		        s.snapshot_title, s.snapshot_lat, s.snapshot_lon, s.snapshot_place_id
		   FROM day_plan_stops s
		   JOIN day_plans p ON p.id = s.day_plan_id
		  WHERE p.trip_id = $1
		  ORDER BY s.day_plan_id, s.sort_order, s.id`,
		[tripId]
	);
	return res.rows;
}
