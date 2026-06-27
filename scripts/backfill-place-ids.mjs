#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import pg from 'pg';

const DEFAULT_RADIUS_M = 2500;
const DEFAULT_MIN_CONFIDENCE = 0.7;

function usage() {
	console.log(`Usage:
  node scripts/backfill-place-ids.mjs --env-file /opt/trips/.env --trip-name "Maine 2026" [--apply]

Options:
  --env-file PATH          Load PG* and GOOGLE_GEOCODING_KEY from an env file.
  --trip-id ID             Limit to one trip id.
  --trip-name NAME         Limit to one exact trip name.
  --apply                  Update itinerary_items.place_id. Default is dry-run.
  --radius-m N             Candidate max distance from saved lat/lon. Default ${DEFAULT_RADIUS_M}.
  --min-confidence N       Minimum match confidence 0..1. Default ${DEFAULT_MIN_CONFIDENCE}.
  --out-dir PATH           Audit output directory. Default data/place-id-backfill.
  --limit N                Limit number of rows processed.
  --skip-item-id ID        Skip one itinerary item id. Repeatable; comma-separated IDs accepted.
`);
}

function parseArgs(argv) {
	const args = {
		apply: false,
		envFile: null,
		tripId: null,
		tripName: null,
		radiusM: DEFAULT_RADIUS_M,
		minConfidence: DEFAULT_MIN_CONFIDENCE,
		outDir: 'data/place-id-backfill',
		limit: null,
		skipItemIds: new Set()
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--help' || arg === '-h') {
			usage();
			process.exit(0);
		}
		if (arg === '--apply') {
			args.apply = true;
			continue;
		}
		const next = argv[++i];
		if (!next) throw new Error(`Missing value for ${arg}`);
		if (arg === '--env-file') args.envFile = next;
		else if (arg === '--trip-id') args.tripId = Number(next);
		else if (arg === '--trip-name') args.tripName = next;
		else if (arg === '--radius-m') args.radiusM = Number(next);
		else if (arg === '--min-confidence') args.minConfidence = Number(next);
		else if (arg === '--out-dir') args.outDir = next;
		else if (arg === '--limit') args.limit = Number(next);
		else if (arg === '--skip-item-id') {
			for (const id of next.split(',')) {
				const n = Number(id.trim());
				if (!Number.isInteger(n) || n <= 0) throw new Error('--skip-item-id must be a positive integer');
				args.skipItemIds.add(n);
			}
		}
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (args.tripId != null && !Number.isInteger(args.tripId)) throw new Error('--trip-id must be an integer');
	if (!Number.isFinite(args.radiusM) || args.radiusM <= 0) throw new Error('--radius-m must be positive');
	if (!Number.isFinite(args.minConfidence) || args.minConfidence < 0 || args.minConfidence > 1) {
		throw new Error('--min-confidence must be between 0 and 1');
	}
	if (args.limit != null && (!Number.isInteger(args.limit) || args.limit <= 0)) {
		throw new Error('--limit must be a positive integer');
	}
	return args;
}

function loadEnvFile(file) {
	if (!file) return;
	const text = fs.readFileSync(file, 'utf8');
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
		if (!m) continue;
		const [, key, raw] = m;
		if (process.env[key] != null) continue;
		process.env[key] = raw.replace(/^['"]|['"]$/g, '');
	}
}

function csvEscape(value) {
	const s = value == null ? '' : String(value);
	return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function writeCsv(file, rows) {
	const headers = [
		'action',
		'reason',
		'trip_id',
		'trip_name',
		'item_id',
		'parent_title',
		'title',
		'lat',
		'lon',
		'candidate_name',
		'candidate_place_id',
		'candidate_lat',
		'candidate_lng',
		'distance_m',
		'name_score',
		'confidence',
		'candidate_types',
		'google_url',
		'external_url'
	];
	const lines = [headers.join(',')];
	for (const row of rows) {
		lines.push(headers.map((h) => csvEscape(row[h])).join(','));
	}
	fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

function normalizeName(s) {
	return String(s ?? '')
		.toLowerCase()
		.replace(/&/g, ' and ')
		.replace(/\b(me|maine|usa|united states|the|at|of|and)\b/g, ' ')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

function tokens(s) {
	return normalizeName(s)
		.split(/\s+/)
		.filter((t) => t.length > 1);
}

function nameScore(query, candidate) {
	const q = tokens(query);
	const c = tokens(candidate);
	if (q.length === 0 || c.length === 0) return 0;
	const cSet = new Set(c);
	const exact = normalizeName(query) === normalizeName(candidate) ? 1 : 0;
	const overlap = q.filter((t) => cSet.has(t) || c.some((ct) => ct.includes(t) || t.includes(ct))).length;
	const coverage = overlap / q.length;
	const reverse = overlap / c.length;
	return Math.max(exact, coverage * 0.75 + reverse * 0.25);
}

function haversineMeters(aLat, aLng, bLat, bLng) {
	const r = 6371000;
	const dLat = ((bLat - aLat) * Math.PI) / 180;
	const dLng = ((bLng - aLng) * Math.PI) / 180;
	const lat1 = (aLat * Math.PI) / 180;
	const lat2 = (bLat * Math.PI) / 180;
	const x =
		Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
	return 2 * r * Math.asin(Math.sqrt(x));
}

function confidence(saved, candidate, radiusM) {
	const distanceM = haversineMeters(saved.lat, saved.lon, candidate.lat, candidate.lng);
	const distanceScore = Math.max(0, 1 - distanceM / radiusM);
	const nScore = nameScore(saved.title, candidate.name);
	const score = nScore * 0.78 + distanceScore * 0.22;
	return { distanceM, nameScore: nScore, confidence: Math.min(1, score) };
}

async function googleJson(url) {
	const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
	if (!res.ok) throw new Error(`Google HTTP ${res.status}`);
	return res.json();
}

async function textSearch(apiKey, item, query, radiusM) {
	const url = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json');
	url.searchParams.set('key', apiKey);
	url.searchParams.set('query', query);
	url.searchParams.set('location', `${item.lat},${item.lon}`);
	url.searchParams.set('radius', String(Math.round(radiusM)));
	const data = await googleJson(url);
	if (data.status === 'ZERO_RESULTS') return [];
	if (data.status !== 'OK') throw new Error(`Text Search ${data.status}: ${data.error_message ?? ''}`);
	return (data.results ?? [])
		.filter((r) => r.place_id && r.geometry?.location)
		.map((r) => ({
			source: 'textsearch',
			name: r.name ?? r.formatted_address ?? '',
			place_id: r.place_id,
			lat: r.geometry.location.lat,
			lng: r.geometry.location.lng,
			types: r.types ?? []
		}));
}

async function geocode(apiKey, item, query) {
	const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
	url.searchParams.set('key', apiKey);
	url.searchParams.set('address', query);
	const data = await googleJson(url);
	if (data.status === 'ZERO_RESULTS') return [];
	if (data.status !== 'OK') throw new Error(`Geocode ${data.status}: ${data.error_message ?? ''}`);
	return (data.results ?? [])
		.filter((r) => r.place_id && r.geometry?.location)
		.map((r) => ({
			source: 'geocode',
			name: r.formatted_address ?? query,
			place_id: r.place_id,
			lat: r.geometry.location.lat,
			lng: r.geometry.location.lng,
			types: r.types ?? []
		}));
}

function uniqCandidates(candidates) {
	const seen = new Set();
	const out = [];
	for (const candidate of candidates) {
		if (seen.has(candidate.place_id)) continue;
		seen.add(candidate.place_id);
		out.push(candidate);
	}
	return out;
}

async function findCandidate(apiKey, item, radiusM) {
	const scoped = [item.title, item.parent_title, item.trip_name].filter(Boolean).join(', ');
	const broader = [item.title, item.trip_name].filter(Boolean).join(', ');
	const queries = Array.from(new Set([scoped, broader, item.title].filter(Boolean)));
	const candidates = [];
	for (const query of queries) {
		candidates.push(...(await textSearch(apiKey, item, query, radiusM)));
	}
	if (candidates.length === 0) {
		for (const query of queries.slice(0, 2)) candidates.push(...(await geocode(apiKey, item, query)));
	}
	const scored = uniqCandidates(candidates)
		.map((candidate) => ({ ...candidate, ...confidence(item, candidate, radiusM) }))
		.sort((a, b) => b.confidence - a.confidence || a.distanceM - b.distanceM);
	return scored[0] ?? null;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	loadEnvFile(args.envFile);
	const apiKey = process.env.GOOGLE_GEOCODING_KEY || process.env.PUBLIC_GOOGLE_MAPS_API_KEY;
	if (!apiKey) throw new Error('GOOGLE_GEOCODING_KEY or PUBLIC_GOOGLE_MAPS_API_KEY is required');

	const pool = new pg.Pool({
		host: process.env.PGHOST ?? '127.0.0.1',
		port: Number(process.env.PGPORT ?? '5437'),
		database: process.env.PGDATABASE ?? 'trips',
		user: process.env.PGUSER,
		password: process.env.PGPASSWORD
	});

	const where = [
		"i.item_type = 'place'",
		'i.lat IS NOT NULL',
		'i.lon IS NOT NULL',
		"COALESCE(BTRIM(i.place_id), '') = ''"
	];
	const params = [];
	if (args.tripId != null) {
		params.push(args.tripId);
		where.push(`t.id = $${params.length}`);
	}
	if (args.tripName) {
		params.push(args.tripName);
		where.push(`t.name = $${params.length}`);
	}
	const limitSql = args.limit ? ` LIMIT ${args.limit}` : '';
	const sql = `
		SELECT i.id AS item_id, i.title, i.lat, i.lon, COALESCE(i.external_url, '') AS external_url,
		       t.id AS trip_id, t.name AS trip_name, COALESCE(p.title, '') AS parent_title
		  FROM itinerary_items i
		  JOIN trips t ON t.id = i.trip_id
		  LEFT JOIN itinerary_items p ON p.id = i.parent_id
		 WHERE ${where.join(' AND ')}
		 ORDER BY t.start_date NULLS LAST, t.id, i.parent_id NULLS FIRST, i.sort_order, i.id
		 ${limitSql}`;
	const { rows } = await pool.query(sql, params);
	const audit = [];
	let updated = 0;
	let skipped = 0;
	console.log(`${args.apply ? 'APPLY' : 'DRY-RUN'}: scanning ${rows.length} located place rows without place_id`);

	for (const row of rows) {
		let best = null;
		let action = 'skip';
		let reason = '';
		try {
			if (args.skipItemIds.has(row.item_id)) {
				reason = 'manual_skip_item_id';
			} else {
				best = await findCandidate(apiKey, row, args.radiusM);
			}
			if (reason) {
				// Explicit/manual skip.
			} else if (!best) {
				reason = 'no_google_candidate';
			} else if (best.distanceM > args.radiusM) {
				reason = `too_far>${args.radiusM}m`;
			} else if (best.confidence < args.minConfidence) {
				reason = `low_confidence<${args.minConfidence}`;
			} else {
				action = args.apply ? 'updated' : 'would_update';
				reason = 'confident_match';
				if (args.apply) {
					await pool.query(
						`UPDATE itinerary_items
						    SET place_id = $1, updated_at = NOW()
						  WHERE id = $2 AND COALESCE(BTRIM(place_id), '') = ''`,
						[best.place_id, row.item_id]
					);
					updated += 1;
				}
			}
		} catch (err) {
			reason = err instanceof Error ? err.message : 'lookup_failed';
		}
		if (action === 'skip') skipped += 1;
		console.log(
			`${action.padEnd(12)} #${row.item_id} ${row.title} -> ${best?.name ?? '(none)'} ${best ? `${Math.round(best.distanceM)}m score=${best.confidence.toFixed(2)}` : ''} ${reason}`
		);
		audit.push({
			action,
			reason,
			trip_id: row.trip_id,
			trip_name: row.trip_name,
			item_id: row.item_id,
			parent_title: row.parent_title,
			title: row.title,
			lat: row.lat,
			lon: row.lon,
			candidate_name: best?.name ?? '',
			candidate_place_id: best?.place_id ?? '',
			candidate_lat: best?.lat ?? '',
			candidate_lng: best?.lng ?? '',
			distance_m: best ? Math.round(best.distanceM) : '',
			name_score: best ? best.nameScore.toFixed(3) : '',
			confidence: best ? best.confidence.toFixed(3) : '',
			candidate_types: best?.types?.join('|') ?? '',
			google_url: best
				? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(row.title)}&query_place_id=${encodeURIComponent(best.place_id)}`
				: '',
			external_url: row.external_url
		});
	}

	fs.mkdirSync(args.outDir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const file = path.join(args.outDir, `${stamp}-${args.apply ? 'apply' : 'dry-run'}-place-id-backfill.csv`);
	writeCsv(file, audit);
	await pool.end();
	console.log(`\nRows scanned: ${rows.length}`);
	console.log(`Rows ${args.apply ? 'updated' : 'would update'}: ${audit.filter((r) => r.action === (args.apply ? 'updated' : 'would_update')).length}`);
	console.log(`Rows skipped: ${skipped}`);
	console.log(`Audit CSV: ${file}`);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
