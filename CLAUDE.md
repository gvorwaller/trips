# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status: PLANNING — no app code exists yet

This repo currently contains only planning artifacts. There is **no SvelteKit app, no `package.json`, no migrations, no source code** here yet. Scaffolding begins at Phase 0 of the plan. Do not assume any build/test commands work until the skeleton is created.

- **What it will be**: `trips.gaylon.photos` — a lightweight personal trip-reference web app (owner + read-only wife viewer) with CarbonFin-outliner-style packing lists and a link-rich places/itinerary, Google Maps integration, DO object-storage attachments (30 MB), and server-rendered PDF export.
- **Authoritative design**: `docs/trip-planner-V3-FINAL-plan.md`. Read it in full before scaffolding — it locks the stack, data model, phased roadmap (Phase 0–5), security model, and the user-approved UX decisions. It supersedes the V1 (`grok-…`) and V2 (`codex-…`) docs, which are retained only for history.

## Session startup (required)

`AGENTS.md` mandates the `td` task CLI:
- Run `td usage --new-session` at conversation start (or after `/clear`).
- Use `td usage -q` for subsequent reads.

Then read `docs/grok-trip-planner-V1-plan.md`, and once they exist, `docs/cs.md`, `docs/mockups/`, and recent `docs/devlog/` entries (these are planned but not yet created).

## This project mirrors the `birds` repo — read it before building

The entire stack, conventions, and ops are deliberately copied from `/Users/gaylonvorwaller/birds`. **Before scaffolding any piece, read the equivalent in birds and adapt it** (e.g. `src/lib/db.ts`, `src/lib/google-maps.ts`, `src/lib/components/MapPicker.svelte`, `hooks.server.ts`, `scripts/deploy-to-DO.sh`, `backend/db/migrate_pg.sh`, `ecosystem.config.cjs`). The binding hard rules live in `/Users/gaylonvorwaller/birds/cs.md`; a `docs/cs.md` for trips is to be created as a light adaptation of it.

### Locked stack (no deviations in first pass)
- SvelteKit 2 + Svelte 5 (runes) + TypeScript, `@sveltejs/adapter-node`.
- **CSS**: component-scoped `<style>` blocks only. No Tailwind/utility frameworks. Base on birds `docs/mockups/mockup.css` (mobile-first; 640px + 1024px breakpoints only; fixed bottom nav <640px; ≥48px tap targets; ≥16px input font; WCAG AAA 7:1 contrast).
- **No toast notifications** — use modal confirmation dialogs.
- **DB**: direct `pg` (node-postgres), no ORM. `Pool` + `query<T>()` + `withTransaction` (copy `birds/src/lib/db.ts`). Raw SQL migrations in `backend/db/migrations/NNNN_*.sql`, applied only via `backend/db/migrate_pg.sh` — never inline DDL, never raw `psql -f`.
- **Auth**: argon2 + session cookie + `hooks.server.ts` gating (copy birds). Two roles: `owner` (full access) and `viewer` (read-only; blocks all non-GET/HEAD mutations except logout). Test viewer-mode leaks aggressively.
- PWA, PM2 deploy via `ecosystem.config.cjs`, `/api/health` returning `{ db: "ok", ... }` (only `db == "ok"` gates deploys).

### Infrastructure — distinct from siblings (don't collide)
This is a **5th app** on the shared DO droplet (IP `134.199.211.199`, SSH by IP only, PM2 not systemd). Existing siblings: gaylonphotos, giftlist, madonnahist, birds. Pick the next free values and confirm against current droplet usage before committing:
- App dir `/opt/trips`; app port suggested 3004/3005 (birds=3003).
- **Separate dedicated Postgres cluster** — suggested prod port 5437, test isolation on 15437 (birds=5436; never touch 5433/5434/5435). Owner role for migrations, app role for runtime. `TIMESTAMPTZ` everywhere (UTC; format at the edge). Heavy thoughtful use of JSONB.
- Test isolation guarded by `TRIPS_ENV=test`; dev server suggested port 5179.
- Google Maps reuses gaylonphotos' `PUBLIC_GOOGLE_MAPS_API_KEY` / `PUBLIC_GOOGLE_MAPS_MAP_ID` + server `GOOGLE_GEOCODING_KEY`; add `trips.gaylon.photos` + dev ports to the key's website restrictions in the gaylonphotos GCP project (RefererNotAllowedMapError otherwise).
- Attachments go to **existing DO object storage** (Spaces/S3-compatible) under a trips prefix — never store blobs in Postgres or local FS. Enforce 30 MB + mime whitelist client + server. Wrap behind a thin `src/lib/server/storage.ts` abstraction.

### Verification before every commit (once the app exists)
- `npm run check` (svelte-check, 0-warning baseline) and `npm run build` — run both.
- Verify with real `psql`, browser devtools, and direct API calls. No guessing, no synthetic/placeholder data, no fallback data to mask broken code. Find root causes.
- `withTransaction` for any multi-statement mutation (especially the `parent_id` + `sort_order` tree moves: `moveItem`/`indentItem`/`outdentItem`/`reorderSiblings`, adapted from birds stop-reordering helpers).

### SQL boundary gotchas (inherited from birds)
- NUMERIC returns as a **string** — `Number()` or cast `::float8` or you get string concatenation.
- JSONB returns as **objects** — don't `JSON.parse()` without a typeof guard.

## Conventions
- Always `cd` back to project root (`/Users/gaylonvorwaller/trips`); use absolute paths.
- Only commit when explicitly asked. Ask the user to restart the dev server after config changes.
- Document decisions in `docs/devlog/` (to be created).
