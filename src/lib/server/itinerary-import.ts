import { withTransaction } from '$lib/db';
import { haversineKm } from '$lib/geo';
import { geocodePlace } from './geocode';
import { ITEM_TYPES, type ItemType } from './itinerary';
import { nextSortOrder } from './tree-sql';
import type pg from 'pg';

const MAX_ITEMS = 200;
const MAX_META_BYTES = 5000;
const DUPLICATE_COORD_KM = 0.03;
const ITINERARY_IMPORT_LOCK_NS = 774747;

export interface ItineraryImportCandidate {
	item_type?: string | null;
	title?: string | null;
	date?: string | null;
	notes?: string | null;
	external_url?: string | null;
	address?: string | null;
	location_query?: string | null;
	lat?: number | null;
	lon?: number | null;
	place_id?: string | null;
	apple_maps_place_id?: string | null;
	meta?: Record<string, unknown> | null;
	children?: ItineraryImportCandidate[];
}

interface PreparedItem {
	item_type: ItemType;
	title: string;
	date: string | null;
	notes: string | null;
	external_url: string | null;
	lat: number | null;
	lon: number | null;
	place_id: string | null;
	apple_maps_place_id: string | null;
	meta: Record<string, unknown> | null;
	children: PreparedItem[];
}

interface DuplicateState {
	titles: Set<string>;
	placeIds: Set<string>;
	sourceKeys: Set<string>;
	coords: Array<{ lat: number; lon: number }>;
}

function normalizeTitle(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

function titleLooksDuplicate(title: string, seen: Set<string>): boolean {
	const n = normalizeTitle(title);
	if (!n) return false;
	for (const existing of seen) {
		if (existing === n || existing.includes(n) || n.includes(existing)) return true;
	}
	return false;
}

function sourceKey(meta: Record<string, unknown> | null): string | null {
	const app = typeof meta?.source_app === 'string' ? meta.source_app.trim() : '';
	const id = typeof meta?.source_id === 'string' ? meta.source_id.trim() : '';
	return app && id ? `${app}:${id}` : null;
}

function addItemToDuplicateState(item: PreparedItem, state: DuplicateState) {
	const title = normalizeTitle(item.title);
	if (title) state.titles.add(title);
	if (item.place_id) state.placeIds.add(item.place_id);
	const source = sourceKey(item.meta);
	if (source) state.sourceKeys.add(source);
	if (item.lat !== null && item.lon !== null) state.coords.push({ lat: item.lat, lon: item.lon });
}

function itemLooksDuplicate(item: PreparedItem, state: DuplicateState): boolean {
	if (titleLooksDuplicate(item.title, state.titles)) return true;
	if (item.place_id && state.placeIds.has(item.place_id)) return true;
	const source = sourceKey(item.meta);
	if (source && state.sourceKeys.has(source)) return true;
	if (item.lat !== null && item.lon !== null) {
		for (const coord of state.coords) {
			if (haversineKm(coord.lat, coord.lon, item.lat, item.lon) <= DUPLICATE_COORD_KM) {
				return true;
			}
		}
	}
	return false;
}

function filterDuplicatePrepared(items: PreparedItem[], state: DuplicateState): PreparedItem[] {
	const out: PreparedItem[] = [];
	for (const item of items) {
		if (itemLooksDuplicate(item, state)) continue;
		addItemToDuplicateState(item, state);
		const children = filterDuplicatePrepared(item.children, state);
		const accepted = { ...item, children };
		out.push(accepted);
	}
	return out;
}

export interface ImportOptions {
	parentId: number | null;
	geocode: boolean;
	tripName?: string;
}

function cleanString(v: unknown, max: number): string | null {
	const s = typeof v === 'string' ? v.trim() : '';
	return s ? s.slice(0, max) : null;
}

function cleanDate(v: unknown): string | null {
	const s = cleanString(v, 10);
	return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function cleanNumber(v: unknown, min: number, max: number): number | null {
	const n = typeof v === 'number' && Number.isFinite(v) ? v : null;
	return n !== null && n >= min && n <= max ? n : null;
}

function cleanMeta(v: unknown): Record<string, unknown> | null {
	if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
	try {
		const json = JSON.stringify(v);
		if (json.length > MAX_META_BYTES) return null;
		return JSON.parse(json) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function joinNotes(notes: string | null, extra: string | null): string | null {
	if (!extra) return notes;
	if (notes?.includes(extra)) return notes;
	if (!notes) return extra;
	return `${notes}\n${extra}`;
}

function locationHint(address: string | null, locationQuery: string | null): string | null {
	const preserved = address ?? locationQuery;
	return preserved ? `Address: ${preserved}` : null;
}

async function prepareItem(
	raw: ItineraryImportCandidate,
	options: ImportOptions,
	count: { n: number }
): Promise<PreparedItem | null> {
	if (count.n >= MAX_ITEMS || raw === null || typeof raw !== 'object') return null;
	const title = cleanString(raw.title, 500);
	if (!title) return null;
	const t = cleanString(raw.item_type, 20);
	const item_type = (ITEM_TYPES as readonly string[]).includes(t ?? '')
		? (t as ItemType)
		: 'place';
	const address = cleanString(raw.address, 500);
	const locationQuery = cleanString(raw.location_query, 500);
	let notes = cleanString(raw.notes, 2000);
	let lat = cleanNumber(raw.lat, -90, 90);
	let lon = cleanNumber(raw.lon, -180, 180);
	let placeId = cleanString(raw.place_id, 300);
	const appleMapsPlaceId = cleanString(raw.apple_maps_place_id, 300);
	const meta = cleanMeta(raw.meta);

	if (item_type === 'place' && options.geocode && (lat === null || lon === null)) {
		const q = locationQuery ?? address ?? [title, options.tripName].filter(Boolean).join(', ');
		const geo = await geocodePlace(q);
		if (geo) {
			lat = geo.lat;
			lon = geo.lng;
			placeId = geo.place_id;
		} else {
			notes = joinNotes(notes, locationHint(address, locationQuery));
		}
	} else if (item_type === 'place' && options.geocode && !placeId && lat !== null && lon !== null) {
		const q = locationQuery ?? address ?? [title, options.tripName].filter(Boolean).join(', ');
		const geo = await geocodePlace(q, { lat, lng: lon, radiusM: 750 });
		placeId = geo?.place_id ?? null;
	} else if (item_type === 'place' && lat === null && lon === null) {
		notes = joinNotes(notes, locationHint(address, locationQuery));
	}

	count.n += 1;
	const children: PreparedItem[] = [];
	for (const child of Array.isArray(raw.children) ? raw.children : []) {
		const prepared = await prepareItem(child, options, count);
		if (prepared) children.push(prepared);
	}

	return {
		item_type,
		title,
		date: cleanDate(raw.date),
		notes,
		external_url: cleanString(raw.external_url, 1000),
		lat,
		lon,
		place_id: placeId,
		apple_maps_place_id: appleMapsPlaceId,
		meta,
		children
	};
}

async function assertParentInTrip(
	client: Pick<pg.PoolClient, 'query'>,
	tripId: number,
	parentId: number | null
): Promise<void> {
	if (parentId === null) return;
	const r = await client.query(`SELECT 1 FROM itinerary_items WHERE id = $1 AND trip_id = $2`, [
		parentId,
		tripId
	]);
	if (r.rowCount === 0) throw new Error('Parent item is not in this trip');
}

async function insertPrepared(
	client: pg.PoolClient,
	tripId: number,
	parentId: number | null,
	item: PreparedItem
): Promise<number> {
	const sort = await nextSortOrder(client, 'itinerary_items', tripId, parentId);
	const res = await client.query<{ id: number }>(
		`INSERT INTO itinerary_items
		   (trip_id, parent_id, sort_order, item_type, title, notes, external_url, date, lat, lon, place_id, apple_maps_place_id, meta)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		 RETURNING id`,
		[
			tripId,
			parentId,
			sort,
			item.item_type,
			item.title,
			item.notes,
			item.external_url,
			item.date,
			item.lat,
			item.lon,
			item.place_id,
			item.apple_maps_place_id,
			item.meta
		]
	);
	const id = res.rows[0].id;
	let imported = 1;
	for (const child of item.children) {
		imported += await insertPrepared(client, tripId, id, child);
	}
	return imported;
}

export async function importItineraryCandidates(
	tripId: number,
	candidates: ItineraryImportCandidate[],
	options: ImportOptions
): Promise<number> {
	if (!Array.isArray(candidates) || candidates.length === 0) return 0;
	const count = { n: 0 };
	const prepared: PreparedItem[] = [];
	for (const candidate of candidates.slice(0, MAX_ITEMS)) {
		const item = await prepareItem(candidate, options, count);
		if (item) prepared.push(item);
	}
	if (prepared.length === 0) return 0;

	return withTransaction(async (client) => {
		await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
			ITINERARY_IMPORT_LOCK_NS,
			tripId
		]);
		await assertParentInTrip(client, tripId, options.parentId);
		const existing = await client.query<{
			title: string;
			place_id: string | null;
			lat: number | null;
			lon: number | null;
			meta: Record<string, unknown> | null;
		}>(
			'SELECT title, place_id, lat, lon, meta FROM itinerary_items WHERE trip_id = $1',
			[tripId]
		);
		const duplicateState: DuplicateState = {
			titles: new Set(existing.rows.map((row) => normalizeTitle(row.title)).filter(Boolean)),
			placeIds: new Set(existing.rows.map((row) => row.place_id).filter((id): id is string => !!id)),
			sourceKeys: new Set(
				existing.rows.map((row) => sourceKey(row.meta)).filter((key): key is string => !!key)
			),
			coords: existing.rows
				.filter((row) => typeof row.lat === 'number' && typeof row.lon === 'number')
				.map((row) => ({ lat: row.lat as number, lon: row.lon as number }))
		};
		const uniquePrepared = filterDuplicatePrepared(prepared, duplicateState);
		let imported = 0;
		for (const item of uniquePrepared) {
			imported += await insertPrepared(client, tripId, options.parentId, item);
		}
		return imported;
	});
}
