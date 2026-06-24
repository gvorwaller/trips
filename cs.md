# AI Assistant Session Guide — trips

## Session Startup (Required)
1. Read `cs.md` (this file) — hard rules that override defaults.
2. Read `docs/trip-planner-V3-FINAL-plan.md` — authoritative design (V1 `grok-…` and V2 `codex-…` are superseded, kept for history).
3. Review `docs/mockups/` — UI reference (open `trips.html`).
4. Check recent devlog entries in `docs/devlog/`.
5. Run `td usage --new-session` to see current tasks.

---

## Core Principles
- **No assumptions** — read source/config, test the layer, then diagnose. State uncertainty; ask rather than guess.
- **No quick fixes** — find root causes, implement maintainable solutions.
- **Evidence-based debugging** — trace client → route → server module → DB → response; test each boundary with curl / psql / devtools.
- **No synthetic or fallback data** — missing data is an explicit empty state or error, never fabricated.

---

## Production Infrastructure

### DigitalOcean Droplet (shared with gaylonphotos, giftlist, madonnahist, birds)
- **SSH**: `ssh root@134.199.211.199` — **always by IP** (the domain resolves to Cloudflare).
- **App directory**: `/opt/trips`
- **App port**: `3004` (gaylonphotos=3000, giftlist=3001, madonnahist=3002, birds=3003, **trips=3004**).
- **Process manager**: PM2 (NOT systemd). `pm2 startOrReload ecosystem.config.cjs --update-env`; logs `pm2 logs trips`.
- **Domain**: `trips.gaylon.photos` — proxied through Cloudflare (HTTP-only origin).
- **Deploy**: `./scripts/deploy-to-DO.sh` only. **Never deploy manually.** Health (`/api/health`, `db=="ok"`) gates deploys.
- **Uploads**: adapter-node `BODY_SIZE_LIMIT='Infinity'` (set in `ecosystem.config.cjs`); nginx `client_max_body_size 32m` enforces the real 30 MB cap upstream. Do NOT use `BODY_SIZE_LIMIT=0` (breaks all bodies — see gaylonphotos devlog 2026-02-28).

### Shared Droplet Awareness
Five apps share RAM/disk/CPU. Keep `max_memory_restart` modest. Headless-PDF (if enabled) must be serialized and re-profiled before raising memory.

---

## Database & Schema (PostgreSQL 17)
- **Own cluster** — prod `127.0.0.1:5437`, database `trips`, roles `trips_owner` (migrations) / `trips_app` (runtime). Test cluster `127.0.0.1:15437`, database `trips_test`.
- **Reserved ports — NEVER touch**: 5433 (BTC), 5434 (madonnahist), 5435 (prod tunnel), 5436 (birds).
- **Query**: `psql -h 127.0.0.1 -p 5437 -U trips_app -d trips -c "SQL"`.
- **Migrations**: DDL only in `backend/db/migrations/NNNN_*.sql`, applied only via `./backend/db/migrate_pg.sh` (tracks `admin.schema_migrations`). Never inline DDL, never raw `psql -f`. If you change DB state, write a migration.
- **Test isolation**: `TRIPS_ENV=test` guards refuse reserved ports + the prod DB name. Bring up with `npm run test:db:up`; run app via `npm run dev:test`.
- **Type safety across SQL boundary**: NUMERIC → string (coerce/`::float8`); JSONB → object (no blind `JSON.parse`); store `TIMESTAMPTZ` in UTC, format at the edge. Itinerary day grouping uses `DATE` (no tz); reservation instants use `TIMESTAMPTZ`.
- **Integrity in server helpers (Vitest-covered)**: reject cross-trip/cross-list parents; reject moving an item under itself/a descendant (cycle); reorder reindexes the sibling group in one `withTransaction`; attachments with a parent must share the trip.

---

## Auth & Roles
- `argon2id` hashes, `sessions` table, 30-day httpOnly `sameSite=strict` cookie (`secure` in prod), sliding expiry. `locals.user` + `locals.ownerId`.
- Roles: `owner` (full) and `viewer` (read-only) — `users.role CHECK IN ('owner','viewer')`.
- **Viewer write exceptions**: viewers may toggle a packing item's `checked` state (`PATCH /api/packing/check`) and a day-plan stop's `visited` state (`PATCH /api/dayplan/visited`); each endpoint must verify nothing else changed. Everything else → 403.
- Same-origin check on all POST/PUT/PATCH/DELETE (defense-in-depth beyond `sameSite`).
- Never log secrets, session tokens, Spaces keys, Maps keys, or object keys.

---

## Attachments (app-proxied private downloads)
- DO Spaces objects use **private ACL**; every download streams through an authenticated SvelteKit route (no public/CDN/signed URL exposed to the client). Distinct from gaylonphotos' public bucket.
- Enforce 30 MB at four layers: client, route, nginx, DB CHECK (`<= 31457280`).
- Validate MIME **and magic bytes** (never trust browser MIME). On DB-insert failure after upload, delete the object; on Spaces-delete failure, mark `delete_pending` so metadata never lies.
- Object key: `trips/{tripId}/{attachmentId}/{randomSegment}/{safeName}`.

---

## URL unfurl (SSRF surface)
Server-side fetch only: ~3s timeout, response-size cap, block private/loopback/link-local IPs and non-http(s) schemes; parse OG/`<title>` only.

---

## CSS & UI
- **No Tailwind / utility frameworks** — component-scoped `<style>` only; tokens in `src/app.css` (from birds `docs/mockups/mockup.css`).
- **No toast notifications** — modal confirmation dialogs.
- Mobile-first; breakpoints `640px` / `1024px` only; fixed bottom-nav + drawer <640px; top-nav ≥640px; ≥48px tap targets; ≥16px input font; WCAG AAA 7:1 contrast; status uses color + text label.

---

## Development Workflow
- **Dev port**: `5179`. Always `cd` back to `/Users/gaylonvorwaller/trips`; use absolute paths.
- `npm run check` + `npm run build` before every commit; fix new warnings before commit. Only commit when explicitly asked.
- Ask the user to restart the dev server after config changes.
- Track work with `td`; document decisions in `docs/devlog/YYYY-MM-DD.md`.

---

## Reuse Map (verified sibling sources to adapt, not reinvent)
- App architecture, DB, auth, Maps, export, deploy, UI: `/Users/gaylonvorwaller/birds`.
- DO Spaces + upload safety (magic bytes, rollback, `BODY_SIZE_LIMIT`): `/Users/gaylonvorwaller/gaylonphotos`.
- Google Maps public key + `GOOGLE_GEOCODING_KEY` live in `gaylonphotos/.env`; add `trips.gaylon.photos/*` and `http://127.0.0.1:5179/*` to the key's website restrictions in the gaylonphotos GCP project.
