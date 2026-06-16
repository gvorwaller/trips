# Trip Planner — V3 FINAL Plan (Authoritative)

**Project**: trips.gaylon.photos
**Date**: 2026-06-15
**Status**: FINAL. This document supersedes `grok-trip-planner-V1-plan.md` and `codex-trip-planner-V2-plan.md` (both retained for history). Implementation begins from this plan.
**Lineage**: Grok V1 (product vision) → Codex V2 (risk-reduction, schema discipline) → Claude V3 (verified-against-source tightening + user-approved UX layer).

---

## 1. Product center

A private, fast, delightful trip-reference web app for one owner + one read-only-ish viewer (wife). Highest value: **packing lists** and **places/itinerary**, both as CarbonFin-style nestable outliners, ready for the **July 27 trip**. Postgres-backed, mobile-first, link-rich, with one-tap maps, attachments, search, templates, offline use, and print/PDF export.

**Non-goals (V1):** realtime multi-user, public share links, full budget tracking, calendar/email import, heavy AI generation, two-way sync with gaylon.photos, route optimization beyond Maps links.

---

## 2. Locked decisions (this supersedes any ambiguity in V1/V2)

1. **Attachments = app-proxied private downloads.** Objects stored with private ACL; every download streams through an authenticated SvelteKit route (no public CDN URL, no signed URL). The shared gaylonphotos bucket is public-only, so trips uses private-ACL objects (own bucket or private prefix) + a download proxy.
2. **Viewer (wife) is read-only EXCEPT may toggle packing-item checked state.** One explicit allow in the auth guard; everything else returns 403 for viewer.
3. **Roles = `owner` + `viewer`** (DB CHECK, hooks, UI all consistent). Note: birds uses `'admin'|'viewer'` — the copied guard logic changes the role string only.
4. **UX features in core scope:** templates & duplicate-trip, offline current-trip PWA, one-tap Google/Apple directions, global search.
5. **Confirmed infrastructure (verified against sibling repos):**
   - Dev port `5179`, prod PM2 app `trips` on port `3004`, app dir `/opt/trips`, domain `trips.gaylon.photos`.
   - **Own Postgres cluster**: prod `5437`, test `15437` (taken: 5433 BTC, 5434 madonnahist, 5435 tunnel, 5436 birds).
   - Sibling map for reference: gaylonphotos 3000/5174, giftlist 3001/5175, madonnahist 3002/5176, birds 3003/5178.

---

## 3. Stack & reuse map (every claim verified against source this session)

- **Framework**: SvelteKit 2 + Svelte 5 (runes) + TypeScript, `@sveltejs/adapter-node`. Prettier + Vitest.
- **DB access**: adapt `birds/src/lib/db.ts` — `query<T>()`, `withTransaction()`, pooled `pg` (`max:10`, `idleTimeoutMillis:30000`).
- **Migrations**: adapt `birds/backend/db/migrate_pg.sh` — tracks applied files in `admin.schema_migrations(filename, applied_at)`; supports `--dry-run`/`--env`. Raw SQL in `backend/db/migrations/NNNN_*.sql`. Never inline DDL, never raw `psql -f`.
- **Auth/session**: adapt `birds/src/hooks.server.ts` + `src/lib/server/session.ts` + `auth.ts` — argon2id, `sessions` table, 30-day httpOnly sameSite=strict cookie (`secure` in prod), sliding expiry, `locals.user`. Viewer blocked from POST/PUT/PATCH/DELETE + `/settings`.
- **Reorder model**: `birds/src/lib/server/trips.ts` `moveStop`/`setStopOrder` — **sequential reindex within a sibling group inside `withTransaction`**. Adopt directly for outliner move/indent/outdent.
- **Maps**: adapt `birds/src/lib/google-maps.ts` (lazy loader, caches script promise), `MapPicker.svelte` (binds `selected {lat,lng,label}`, search + reverse-geocode), `/api/geocode` (`GOOGLE_GEOCODING_KEY`). Public keys `PUBLIC_GOOGLE_MAPS_API_KEY` + `PUBLIC_GOOGLE_MAPS_MAP_ID` live in `gaylonphotos/.env`.
- **Export**: adapt `birds/src/routes/trips/[id]/export/+server.ts` (server-built Markdown, `Content-Disposition` attachment, `slugify`).
- **CSS/UI**: adapt `birds/docs/mockups/mockup.css` — CSS vars, mobile-first, breakpoints `640px`/`1024px` only, fixed bottom-nav + drawer <640px, top-nav ≥640px, `.btn` (≥48px), `.card`, `.obs` rows, WCAG AAA 7:1. **No Tailwind/utility frameworks. No toasts — modal confirms.**
- **Object storage**: adapt `gaylonphotos/src/lib/server/storage.js` — `@aws-sdk/client-s3`, `S3Client` `forcePathStyle:false`, `PutObjectCommand`/`DeleteObjectCommand`. We add a streaming GET for the proxy and use **private ACL** (gaylonphotos uses `public-read` — we diverge here). Magic-byte validation + rollback-on-failure patterns reused directly.
- **Deploy/PM2**: adapt `birds/ecosystem.config.cjs` (`name:'trips'`, `build/index.js`, port 3004, modest `max_memory_restart`, `--env-file=.env`) + `scripts/deploy-to-DO.sh` (SSH by IP `134.199.211.199`, `git pull --ff-only`, `npm ci`, build, migrate, conditional nginx reload, `pm2 startOrReload`, health gate on `db==ok`). Set `BODY_SIZE_LIMIT='Infinity'` in ecosystem env (nginx enforces upstream — see gaylonphotos devlog 2026-02-28).
- **Test isolation**: adapt `birds/scripts/test-db-*.sh`; `TRIPS_ENV=test` guard; test cluster `15437`; dev-test server on `127.0.0.1:5179 --strictPort --mode test`.

---

## 4. Data model

Tables: `users`, `sessions`, `trips`, `itinerary_items`, `packing_lists`, `packing_items`, `reservations`, `attachments`, `packing_templates`, `packing_template_items`.

Key fields & constraints:
- `users.role TEXT NOT NULL CHECK (role IN ('owner','viewer'))`.
- All mutable tables: `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`, `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()` (helpers touch `updated_at` on write — app-level, matching birds).
- `trips(id, owner_id→users ON DELETE CASCADE, name, start_date DATE, end_date DATE, notes, created_at, updated_at)`.
- `itinerary_items(id, trip_id→trips CASCADE, parent_id→itinerary_items CASCADE, sort_order INT NOT NULL DEFAULT 0, item_type CHECK IN ('section','day','place','note'), title, notes, lat double precision, lon double precision, place_id, external_url, google_maps_url, date DATE, meta JSONB, created_at, updated_at)`.
- `packing_lists(id, trip_id→trips CASCADE, name, created_at, updated_at)`.
- `packing_items(id, list_id→packing_lists CASCADE, parent_id→packing_items CASCADE, sort_order INT NOT NULL DEFAULT 0, name, quantity INT NOT NULL DEFAULT 1 CHECK (quantity>0), checked BOOLEAN NOT NULL DEFAULT FALSE, category, notes, weight_grams INT, created_at, updated_at)`.
- `reservations(id, trip_id→trips CASCADE, reservation_type CHECK IN ('accommodation','flight','restaurant','transport','other'), title, confirmation_code, status, start_at TIMESTAMPTZ, end_at TIMESTAMPTZ, details JSONB, notes, sort_order INT, created_at, updated_at)`.
- `attachments(id, trip_id→trips CASCADE, reservation_id NULL, itinerary_item_id NULL, packing_item_id NULL, original_name, mime_type, size_bytes BIGINT NOT NULL CHECK (size_bytes>0 AND size_bytes<=31457280), object_key TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','delete_pending')), meta JSONB, uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`.
- `packing_templates(id, owner_id→users CASCADE, name, created_at, updated_at)` + `packing_template_items(id, template_id→packing_templates CASCADE, parent_id→packing_template_items CASCADE, sort_order INT, name, category, quantity INT DEFAULT 1, notes)`.

Indexes:
- `itinerary_items(trip_id, parent_id, sort_order)`, `packing_items(list_id, parent_id, sort_order)`.
- `lower(title)` on itinerary_items, `lower(name)` on packing_items, `trips(lower(name))` for global search.
- `attachments(trip_id)`, `reservations(trip_id, sort_order)`.

Integrity rules enforced in server helpers (Vitest-covered):
- Reject a `parent_id` belonging to a different trip/list.
- Reject moving an item under itself or any descendant (cycle prevention) before write.
- Reorder reindexes the sibling group in one transaction.
- Attachment with a parent (reservation/item) must share the same `trip_id`.
- Object key format: `trips/{tripId}/{attachmentId}/{randomSegment}/{safeName}`; random segment server-generated; original filename kept only as display metadata.

Timezone rule: itinerary day grouping = `DATE` (no tz); reservation instants = `TIMESTAMPTZ`, displayed in trip/destination context.

---

## 5. Security notes

- Same-origin check on all mutating requests (POST/PUT/PATCH/DELETE) in addition to role guard.
- Viewer allow-list: only `PATCH /trips/[id]/packing/[itemId]/checked` (checked-state toggle only); server verifies no other field changed. All else 403 for viewer.
- Attachment download proxy verifies session + trip ownership/viewer before streaming; no object key is ever exposed to the client.
- URL-unfurl is an SSRF surface: server-side fetch only, ~3s timeout, max response size, block private/loopback/link-local IPs and non-http(s) schemes, parse OG/`<title>` only. MVP may ship "store labeled link" first and add title fetch later.
- Never log secrets, session tokens, Spaces keys, Maps keys, or object keys. No synthetic/fallback data — empty states for missing data. Validate at boundaries (routes); trust internal code.

---

## 6. UX / product layer

- **Quick-capture bar (hero interaction):** one input that routes single-URL → place w/ link, multi-line → bulk packing items, plain text → item.
- **Keyboard-first outliner:** Enter = new sibling, Tab/Shift-Tab = indent/outdent, ↑/↓ = move; drag is secondary polish.
- **Templates & duplicate trip:** save list as template / apply template (transactional row-copy, seed one starter template); deep-copy a whole trip (optional reset-checked + date shift).
- **One-tap directions:** per place "Open in Google Maps" + "Open in Apple Maps" (`maps://`/`maps.apple.com`) + "Directions from here"; per-day multi-stop Google Maps link from ordered places. All link-based.
- **Global search:** `lower() ILIKE` over trips/places/packing/notes/reservations from early on; upgrade to FTS only if weak.
- **Offline current-trip (PWA):** GET-cacheable JSON from Phase 1; SW precaches app shell + runtime-caches active trip's packing/places/links/proxied attachments; offline packing check-off queued + synced on reconnect (last-write-wins).
- **Packing ergonomics:** collapsible categories, per-list progress bar, "reset all checks," quantity; `weight_grams` total deferred.
- **Polish:** link chips (host/title), guided empty states, printable one-page trip sheet via `@media print`.

---

## 7. Phased roadmap

### Phase 0 — Verification & Foundation
- Decide/init source control for `/Users/gaylonvorwaller/trips` (deploy script assumes git).
- Create `cs.md` (trips-adapted from birds), update `CLAUDE.md`, expand `AGENTS.md`.
- Droplet-only verification: `pm2 status` (3004 free), `pg_isready -p 5437`, nginx config path + `client_max_body_size`, Cloudflare TLS mode, add `trips.gaylon.photos/*` + `http://127.0.0.1:5179/*` to shared Maps key (GCP project gaylonphotos).
- Scaffold SvelteKit (birds patterns): `db.ts`, `migrate_pg.sh`, test-db scripts, `/api/health`, `ecosystem.config.cjs`, `deploy-to-DO.sh` skeleton, PWA placeholders.
- First concrete migration: all 10 tables + constraints + indexes (no placeholder SQL).
- `docs/mockups/trips.html` + `mockup.css` adapted from birds.
- **Accept:** `npm run check` + `npm run build` pass; `/api/health` returns `db:"ok"`; test-DB scripts refuse prod settings.

### Phase 1 — Auth & Trip Shell
- Owner + viewer users; login/logout; hook protection incl. viewer packing-check-off exception; same-origin guard.
- Trip CRUD + list; responsive shell (top-nav ≥640, bottom-nav + drawer <640); read-only banner for viewer.
- Establish GET-cacheable JSON shape for offline.
- **Accept:** owner manages trips; viewer can view + toggle packing-checked only (all other writes 403); bad-origin mutations rejected.

### Phase 2 — Places & Packing MVP + Templates + Search
- Itinerary outliner (section/day/place/note) + packing lists/items; add/edit/delete/check/move/indent/outdent; multi-line paste; quick-capture bar.
- Templates (save/apply, seed starter) + duplicate trip.
- Global search (ILIKE).
- **Accept:** 10-item nested itinerary + nested packing survive reload; cycle/cross-parent rejected; template-apply + trip-duplicate correct; viewer checks but cannot edit; search finds across types.

### Phase 3 — Maps & Link Polish
- Google Maps links on every place + Apple Maps + directions-from-here + per-day multi-stop; MapPicker coords; interactive pin map w/ item selection; reference link chips.
- **Accept:** links open on iOS + desktop; map renders on dev + prod origins; missing Maps key fails visibly without breaking page.

### Phase 4 — Reservations & Attachments
- Reservation CRUD; app-proxied private attachment upload/download/delete; DO Spaces (private ACL); 30 MB at 4 layers; magic-byte validation; rollback on DB failure; `delete_pending` on Spaces-delete failure.
- **Accept:** valid PDF/image uploads; oversized rejected; disguised file rejected; DB-insert failure cleans object; download proxy enforces auth + ownership; viewer downloads but cannot upload/delete.

### Phase 5 — Export, PWA, Deploy
- Print one-pager + Markdown/HTML export (current checked states + links); PWA manifest/icons + offline current-trip cache + queued check-off sync; headless PDF only after local + droplet memory proof (serialized, conservative PM2 memory); deploy to trips.gaylon.photos.
- **Accept:** print readable mobile + desktop; offline trip view works with no network; health gate green; owner + viewer flows work post-deploy.

---

## 8. Test plan

**Automated:** `npm run check`, `npm run build`; Vitest for reorder/move helpers, cycle prevention, viewer mutation blocking (incl. packing-check-off exception), upload validation where practical.
**Manual:** owner + viewer browser smoke; mobile viewport; real `psql` after migrations; real small PDF/image upload; oversized upload; disguised file; print/export a real sample trip; offline trip view.
**Deploy:** verify PM2 name/port, nginx body-size, Cloudflare routing, `/api/health`, no secrets in logs.

---

## 9. Working rules (carried from birds cs.md)

- No assumptions — read source/config, test the layer, then diagnose. No quick fixes — root causes.
- `withTransaction` for multi-statement writes. Migrations only via `migrate_pg.sh`.
- `npm run check` + `npm run build` before every commit; only commit when asked.
- Absolute paths; always `cd` back to `/Users/gaylonvorwaller/trips`. SSH by IP; PM2 not systemd; never deploy manually.
- SQL boundary: NUMERIC → string (coerce/`::float8`); JSONB → object (no blind `JSON.parse`); `TIMESTAMPTZ` UTC, format at edge.
- Document decisions in `docs/devlog/`; track work with `td`.
