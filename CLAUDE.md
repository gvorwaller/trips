# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status: LIVE in production

`trips.gaylon.photos` — a personal trip-reference web app (owner, plus a read-only
viewer account) with CarbonFin-outliner-style packing lists, a link-rich
places/itinerary tree, day plans with Google-routed driving, Google Maps
integration, DO object-storage attachments, and print/PDF output.

Shipped and deployed since June 2026. The app, `package.json`, migrations
(`backend/db/migrations/0001`–`0012` and counting) and full test suites all exist —
build and test commands work. **Nothing here is greenfield; treat every change as a
change to running software with real data in it.**

## Session startup (required)

1. **Read `cs.md`** (repo root) — the binding hard rules. It overrides defaults and
   supersedes anything in this file on conflict.
2. Run `td usage --new-session` at conversation start (or after `/clear`);
   `td usage -q` for subsequent reads. Mandated by `AGENTS.md`.
3. Read recent `docs/devlog/` entries — they carry the decisions and the
   already-litigated dead ends.
4. `docs/mockups/trips.html` is the UI reference.

`docs/trip-planner-V3-FINAL-plan.md` is the original design and is still useful for
intent, but the code and `docs/devlog/` are authoritative where they differ. The V1
(`grok-…`) and V2 (`codex-…`) docs are superseded history — do not build from them.

## Relationship to the `birds` repo

The stack, conventions and ops were originally copied from
`/Users/gaylonvorwaller/birds`, and birds remains a useful reference when adding a
*new* kind of thing (e.g. its `src/routes/trips/[id]/export/+server.ts` is the model
for export). But trips has diverged and has its own idioms — **read the trips
equivalent first**, and reach for birds only when trips has no precedent.

Trips also imports place data from birds over HTTP: `src/lib/server/birds-places.ts`
→ birds' `/api/internal/trip-places` (Bearer token). That is the only coupling.

## Locked stack (no deviations)

- SvelteKit 2 + Svelte 5 (runes) + TypeScript, `@sveltejs/adapter-node`.
- **CSS**: component-scoped `<style>` blocks only. No Tailwind/utility frameworks.
  Mobile-first; 640px + 1024px breakpoints only; fixed bottom nav <640px; **≥44px
  tap targets** (WCAG 2.5.5 AAA / Apple HIG) with **≥48px for primary actions,
  bottom-nav items, and standalone controls outside dense list rows**; ≥16px input
  font; WCAG AAA 7:1 contrast. See `cs.md` for the full rule.
- **No toast notifications** — use modal confirmation dialogs.
- **DB**: direct `pg` (node-postgres), no ORM. `Pool` + `query<T>()` +
  `withTransaction` (`src/lib/db.ts`). Raw SQL migrations in
  `backend/db/migrations/NNNN_*.sql`, applied **only** via
  `backend/db/migrate_pg.sh` — never inline DDL, never raw `psql -f`, never
  renumber an applied migration.
- **Auth**: argon2 + session cookie + `hooks.server.ts` gating. Three roles:
  `admin` (own data + Users panel in /settings), `user` (own data), `viewer`
  (read-only view of one account via `users.views_user_id`). Viewers are blocked
  from all non-GET/HEAD mutations except logout and the explicitly whitelisted
  check-off PATCHes in `isViewerAllowedMutation` — `cs.md` enumerates them, and
  that list must be updated in lockstep with the code. Data is hard-partitioned per
  account through `locals.ownerId`; test cross-account and viewer-mode leaks
  aggressively (`npm run test:db` is the real-DB isolation suite).
- PM2 deploy via `ecosystem.config.cjs`; `/api/health` returns `{ db: "ok", … }`
  and only `db == "ok"` gates deploys.

## Infrastructure

Live values are in `cs.md` — read them there rather than trusting any summary.
Headlines: 5th app on the shared DO droplet (SSH by IP `134.199.211.199`, PM2 not
systemd), app dir `/opt/trips`, app port **3004**, dedicated Postgres cluster on
**5437** prod / **15437** test, dev server **5179**, test isolation guarded by
`TRIPS_ENV=test`. Attachments live in DO Spaces behind `src/lib/server/storage.ts` —
never in Postgres or on local disk.

**Never cite droplet facts from memory or docs — verify live** (`free -h`,
`pg_lsclusters`) before asserting them.

## Verification before every commit

- `npm run check` (svelte-check, 0-warning baseline) **and** `npm run build`.
- `npm run test` (vitest units) and, for anything touching SQL,
  `npm run test:db` (real-DB isolation suite against 15437).
- Verify with real `psql`, browser devtools and direct API calls. No guessing, no
  synthetic/placeholder data, no fallback data to mask broken code. Find root causes.
- `withTransaction` for any multi-statement mutation — especially the
  `parent_id` + `sort_order` tree moves (`moveItem`/`indentItem`/`outdentItem`/
  `reorderSiblings`) and the day-plan driving/order writes.
- Static checks miss runtime bugs. Browser QA — via the Safari smoke scripts
  (`npm run test:safari:place-workspace`) or a peer reviewer — has repeatedly caught
  defects that `check`, `build` and every test suite passed. See
  `docs/devlog/2026-08-01.md`.

## SQL boundary gotchas

- NUMERIC returns as a **string** — `Number()` it or cast `::float8`, or you get
  string concatenation.
- JSONB returns as **objects** — don't `JSON.parse()` without a `typeof` guard.
- `TIMESTAMPTZ` everywhere; store UTC, format at the edge.

## Conventions

- Always `cd` back to the project root (`/Users/gaylonvorwaller/trips`); use
  absolute paths.
- Only commit when explicitly asked. Ask the user to restart the dev server after
  config changes.
- Document decisions in `docs/devlog/`.
