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
	/** Drive home from the last stop back to the anchor. Anchored plans only (0013). */
	return_drive_km: number | null;
	return_drive_min: number | null;
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
	return_drive_km, return_drive_min,
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

		// Lock every distinct linked itinerary item FIRST — before the plan
		// INSERT. Two reasons, both load-bearing:
		// 1. The stop-copy INSERT…SELECT below reads i.visited; without the
		//    lock a concurrent visited toggle can commit between that read and
		//    ours, leaving the new copies stale outside the toggle's fan-out.
		// 2. Lock ORDER. The 0010 activity triggers make every day_plans /
		//    itinerary_items write also lock the trips row, so the canonical
		//    order is item → trips. Inserting the plan first (trips lock via
		//    trigger) and locking items after deadlocks against setItemVisited,
		//    which takes item → trips — the visited.dbtest race caught exactly
		//    that.
		await client.query(
			`SELECT id FROM itinerary_items
			  WHERE id IN (SELECT DISTINCT itinerary_item_id
			                 FROM day_plan_stops
			                WHERE day_plan_id = $1 AND itinerary_item_id IS NOT NULL)
			  ORDER BY id
			  FOR UPDATE`,
			[planId]
		);

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

		// Linked copies are born agreeing with the canonical item (td-430ffe:
		// the place is the single source of truth, so a duplicated plan must
		// not show a false copy of a visited place; the items were locked
		// above). Orphan stops have no canonical truth and deliberately reset
		// to unvisited — duplicating a plan means doing that day again.
		await client.query(
			`INSERT INTO day_plan_stops
			   (day_plan_id, itinerary_item_id, sort_order, notes, visited,
			    snapshot_title, snapshot_lat, snapshot_lon, snapshot_place_id)
			 SELECT $1, s.itinerary_item_id, s.sort_order, s.notes, COALESCE(i.visited, FALSE),
			        s.snapshot_title, s.snapshot_lat, s.snapshot_lon, s.snapshot_place_id
			   FROM day_plan_stops s
			   LEFT JOIN itinerary_items i ON i.id = s.itinerary_item_id
			  WHERE s.day_plan_id = $2
			  ORDER BY s.sort_order, s.id`,
			[newPlanId, planId]
		);

		return newPlanId;
	});
}

async function insertStop(
	client: Pick<pg.PoolClient, 'query'>,
	tripId: number,
	planId: number,
	// null = compute MAX(sort_order)+1 AFTER the locks are held. Callers may
	// only pass a number for a plan created in this same transaction (no
	// concurrent sibling can exist yet); for any pre-existing plan a caller-
	// computed sort races a concurrent add and duplicates sort_order.
	sortOrder: number | null,
	input: StopInput
): Promise<number | null> {
	// item_type = 'place': only places may become linked stops. Sections, days
	// and notes are not visitable, and a non-place-linked stop would let the
	// viewer-whitelisted setStopVisited fan-out mutate a non-place item,
	// bypassing setItemVisited's place-only authorization. (All existing prod
	// stops are place-linked, verified 2026-08-02.)
	// FOR UPDATE: the visited read must participate in the canonical
	// item-first lock order — without it, a concurrent setItemVisited can
	// commit between this read and the INSERT below, and the new copy is born
	// stale with no error anywhere.
	const item = await client.query<{
		id: number;
		title: string;
		lat: number | null;
		lon: number | null;
		place_id: string | null;
		visited: boolean;
	}>(
		`SELECT id, title, lat, lon, place_id, visited
		   FROM itinerary_items
		  WHERE id = $1 AND trip_id = $2 AND item_type = 'place'
		  FOR UPDATE`,
		[input.itinerary_item_id, tripId]
	);
	if (item.rowCount === 0) return null;
	const i = item.rows[0];
	// Canonical order: the item lock above, then the plan row + ALL existing
	// stop locks, before the INSERT below fires the trips trigger. Without
	// this, addStop holds trips (INSERT trigger) and then clearDrivingForPlan
	// seeks the other stops — the reproduced 40P01.
	await lockPlanStops(client, planId);
	const sort =
		sortOrder ??
		(
			await client.query<{ next: number }>(
				`SELECT COALESCE(MAX(sort_order) + 1, 0) AS next
				   FROM day_plan_stops
				  WHERE day_plan_id = $1`,
				[planId]
			)
		).rows[0].next;
	await assertLocationIsNewToPlan(client, planId, {
		title: i.title,
		itinerary_item_id: i.id,
		place_id: i.place_id,
		lat: i.lat,
		lon: i.lon
	});
	// New copies are born agreeing with the canonical item's visited flag —
	// adding an already-visited place to a plan must not create a false copy
	// (td-430ffe single-source-of-truth invariant).
	const res = await client.query<{ id: number }>(
		`INSERT INTO day_plan_stops
		   (day_plan_id, itinerary_item_id, sort_order, notes, visited,
		    snapshot_title, snapshot_lat, snapshot_lon, snapshot_place_id)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		 RETURNING id`,
		[planId, i.id, sort, input.notes, i.visited, i.title, i.lat, i.lon, i.place_id]
	);
	return res.rows[0].id;
}

export async function createDayPlan(
	tripId: number,
	input: DayPlanInput & { stops: StopInput[]; anchor?: AnchorInput | null }
): Promise<number> {
	return withTransaction(async (client) => {
		// Canonical lock order is item → trips (see duplicateDayPlan): the
		// 0010 trigger on the day_plans INSERT below locks the trips row, and
		// insertStop's FOR UPDATE locks items — so the items must be locked
		// BEFORE the plan INSERT or this deadlocks against a concurrent
		// visited toggle.
		const itemIds = [...new Set(input.stops.map((s) => s.itinerary_item_id))].sort(
			(x, y) => x - y
		);
		if (itemIds.length > 0) {
			await client.query(
				`SELECT id FROM itinerary_items
				  WHERE id = ANY($1::int[]) AND trip_id = $2
				  ORDER BY id
				  FOR UPDATE`,
				[itemIds, tripId]
			);
		}
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

/**
 * Set or clear a plan's route anchor.
 *
 * Every persisted driving metric is derived from the anchor — the first leg
 * starts there and, since 0013, the return leg ends there — so changing it
 * invalidates all of them. Without the clear, switching a plan's base from A to
 * B leaves the old legs and the old drive home painted as though they described
 * the route to B. (This was already wrong for the first leg before 0013 existed;
 * found in peer review of td-bf2909.)
 */
export async function setDayPlanAnchor(
	tripId: number,
	planId: number,
	anchor: AnchorInput | null
): Promise<boolean> {
	return withTransaction(async (client) => {
		if (!(await assertPlanInTrip(client, tripId, planId))) return false;
		await lockPlanStops(client, planId);
		await assertAnchorIsNewToPlan(client, planId, anchor);
		await clearDrivingForPlan(client, planId);
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

/**
 * Take the write locks for a plan-and-its-stops transaction, trigger-free and
 * in canonical order: **item(s) → plan row → stop rows → trips**, where the
 * trips lock is only ever acquired implicitly by the FIRST trigger-firing
 * write afterwards (every day_plans/day_plan_stops write locks the trips row
 * through the 0010 activity triggers).
 *
 * The plan-row lock is load-bearing twice over (peer CODEX, rounds 4–5, both
 * reproduced as 40P01):
 * - ORDER: updateDayPlan is a bare UPDATE day_plans, i.e. plan → trips.
 *   A writer that touched stops first (holding trips via the stop trigger)
 *   and only then updated the plan row cycled against it.
 * - MEMBERSHIP: FOR UPDATE on the parent conflicts with the FK key-share an
 *   INSERTing child must take, so while it is held no new stop can appear —
 *   the stop enumeration below is phantom-proof, and MAX(sort_order) is
 *   stable iff computed AFTER this call.
 * Once prelocked, statements may run in any business order reentrantly.
 */
async function lockPlanStops(
	client: Pick<pg.PoolClient, 'query'>,
	planId: number
): Promise<void> {
	await client.query(`SELECT id FROM day_plans WHERE id = $1 FOR UPDATE`, [planId]);
	await client.query(
		`SELECT id FROM day_plan_stops WHERE day_plan_id = $1 ORDER BY id FOR UPDATE`,
		[planId]
	);
}

export async function deleteDayPlan(tripId: number, planId: number): Promise<boolean> {
	return withTransaction(async (client) => {
		if (!(await assertPlanInTrip(client, tripId, planId))) return false;
		// The plan DELETE takes the trips lock (trigger) and then cascades into
		// the stop rows — prelock the stops so the cascade never seeks a stop
		// while holding trips.
		await lockPlanStops(client, planId);
		const res = await client.query(`DELETE FROM day_plans WHERE id = $1 AND trip_id = $2`, [
			planId,
			tripId
		]);
		return (res.rowCount ?? 0) > 0;
	});
}

export async function addStop(
	tripId: number,
	planId: number,
	input: StopInput
): Promise<number | null> {
	return withTransaction(async (client) => {
		if (!(await assertPlanInTrip(client, tripId, planId))) return null;
		// sort order is computed inside insertStop AFTER the plan-row barrier —
		// computing it here raced a concurrent add into duplicate sort_order
		// (peer CODEX, round 5).
		const id = await insertStop(client, tripId, planId, null, input);
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
		await lockPlanStops(client, planId);
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

/**
 * Drop every persisted driving metric for a plan: the per-stop legs and the
 * plan-level return leg (0013). Both are derived from one Directions call over
 * one stop order and one anchor, so they must always be cleared together —
 * leaving the return behind would paint a drive home for a route that no longer
 * exists.
 */
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
	await client.query(
		`UPDATE day_plans
		    SET return_drive_km = NULL, return_drive_min = NULL
		  WHERE id = $1`,
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
		// Prelock in id order — two reorders with opposite requested orders
		// would otherwise take the per-stop UPDATE locks in opposite orders.
		await lockPlanStops(client, planId);
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
		await lockPlanStops(client, planId);
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
	return withTransaction(async (client) => {
		// Authorize and resolve the link with a plain SELECT — deliberately no
		// row write yet, so BOTH propagation entry points take their locks in
		// one canonical order: itinerary item first, then stop copies.
		// (setItemVisited is item→stops; writing the clicked stop first here
		// would be stop→item→stops, and the two orders deadlock under
		// ordinary simultaneous check-offs.)
		const res = await client.query<{ itinerary_item_id: number | null }>(
			`SELECT s.itinerary_item_id
			   FROM day_plan_stops s
			   JOIN day_plans p ON p.id = s.day_plan_id
			   JOIN trips t ON t.id = p.trip_id
			  WHERE s.id = $1 AND t.owner_id = $2`,
			[stopId, ownerId]
		);
		if ((res.rowCount ?? 0) === 0) return false;
		const itemId = res.rows[0].itinerary_item_id;

		// Orphan stops (place deleted after the plan was built) keep their own
		// independent flag.
		if (itemId === null) {
			await client.query(`UPDATE day_plan_stops SET visited = $2 WHERE id = $1`, [
				stopId,
				visited
			]);
			return true;
		}

		// The place is the single source of truth (td-430ffe): a linked stop's
		// flag fans out to the item and EVERY stop copy of it (including the
		// clicked one) — a place can sit in several plans, and updating only
		// the clicked copy is exactly the disagreement the design prevents.
		// The authorization independently re-asserts owner AND item_type =
		// 'place' rather than trusting the stop's link: this path is viewer-
		// whitelisted, and without the predicate a stop linked to a non-place
		// item would let a viewer flip that item's flag, bypassing
		// setItemVisited's place-only authorization.
		//
		// LOCK ORDER (do not reorder — peer CODEX reproduced the deadlock):
		// item row → stop rows → trips row; all row locks via trigger-free
		// SELECT … FOR UPDATE before any UPDATE fires a 0010 trigger. See
		// setItemVisited for the full reasoning; both writers must match.
		const item = await client.query<{ trip_id: number }>(
			`SELECT i.trip_id
			   FROM itinerary_items i
			   JOIN trips t ON t.id = i.trip_id
			  WHERE i.id = $1 AND t.owner_id = $2 AND i.item_type = 'place'
			  FOR UPDATE OF i`,
			[itemId, ownerId]
		);
		if ((item.rowCount ?? 0) === 0) {
			// The linked row is not an updatable place — deleted since the
			// SELECT (FK nulls the link), or a legacy non-place link. Either
			// way the stop's flag is independent data; honor the click on the
			// stop alone and leave the item untouched.
			await client.query(`UPDATE day_plan_stops SET visited = $2 WHERE id = $1`, [
				stopId,
				visited
			]);
			return true;
		}
		// Fan-out scoped through day_plans to the item's own trip (the FKs
		// alone don't force stop.plan.trip == item.trip, and the account
		// partition must hold even against a malformed link). The clicked
		// stop is included explicitly: it was authorized above, and if its
		// link IS malformed it still must honor the click.
		const locked = await client.query<{ id: number }>(
			`SELECT s.id
			   FROM day_plan_stops s
			   JOIN day_plans p ON p.id = s.day_plan_id
			  WHERE (s.itinerary_item_id = $1 AND p.trip_id = $2) OR s.id = $3
			  ORDER BY s.id
			  FOR UPDATE OF s`,
			[itemId, item.rows[0].trip_id, stopId]
		);
		await client.query(`UPDATE itinerary_items SET visited = $2 WHERE id = $1`, [
			itemId,
			visited
		]);
		await client.query(`UPDATE day_plan_stops SET visited = $2 WHERE id = ANY($1::int[])`, [
			locked.rows.map((r) => r.id),
			visited
		]);
		return true;
	});
}

/**
 * Stops for a single plan, scoped by trip so a plan id from another account
 * cannot be read. Used by the export routes, which need one plan rather than
 * the whole trip's stops.
 */
export async function listStopsForPlan(tripId: number, planId: number): Promise<DayPlanStop[]> {
	const res = await query<DayPlanStop>(
		`SELECT s.id, s.day_plan_id, s.itinerary_item_id, s.sort_order, s.notes, s.visited,
		        s.snapshot_title, s.snapshot_lat, s.snapshot_lon, s.snapshot_place_id,
		        s.drive_km, s.drive_min, s.ai_notes
		   FROM day_plan_stops s
		   JOIN day_plans p ON p.id = s.day_plan_id
		  WHERE p.id = $1 AND p.trip_id = $2
		  ORDER BY s.sort_order, s.id`,
		[planId, tripId]
	);
	return res.rows;
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

/**
 * Persist one Directions result for a plan: a leg per stop, plus the drive home
 * when the plan is anchored (0013).
 *
 * The return leg is required exactly when the plan has an anchor, and rejected
 * otherwise — an unanchored plan is an open path with no base to return to, and
 * day_plans_return_leg_complete would reject it at the DB anyway. Enforcing it
 * here turns a constraint violation into a clean false.
 */
export async function bulkUpdateDriving(
	tripId: number,
	planId: number,
	legs: DrivingLegInput[],
	returnLeg: { km: number; min: number } | null = null
): Promise<boolean> {
	return withTransaction(async (client) => {
		if (!(await assertPlanInTrip(client, tripId, planId))) return false;
		await lockPlanStops(client, planId);
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
		if (hasAnchor !== (returnLeg != null)) return false;

		await clearDrivingForPlan(client, planId);
		for (const leg of legs) {
			await client.query(
				`UPDATE day_plan_stops
				    SET drive_km = $3, drive_min = $4
				  WHERE id = $1 AND day_plan_id = $2`,
				[leg.stopId, planId, leg.km, leg.min]
			);
		}
		await client.query(
			`UPDATE day_plans
			    SET return_drive_km = $2, return_drive_min = $3, updated_at = NOW()
			  WHERE id = $1`,
			[planId, returnLeg?.km ?? null, returnLeg?.min ?? null]
		);
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
		await lockPlanStops(client, planId);
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
