> **SUPERSEDED by [`trip-planner-V3-FINAL-plan.md`](./trip-planner-V3-FINAL-plan.md) (2026-06-15).** Retained for history. V3 is authoritative.

# Grok Trip Planner — V1 Plan (Dedicated General-Purpose Trip Reference App)

**Project**: trips.gaylon.photos  
**Date**: 2026-06-15  
**Author**: Grok (based on direct user feedback + research)  
**Status**: Detailed planning complete. No app code yet. Implementation can begin immediately after review.  
**Primary Goal**: Have fun building a lightweight, delightful personal (owner + wife viewer) trip reference tool that feels like a modern, web-powered CarbonFin Outliner while delivering TREK-like structure and ease-of-use for maps, places, packing, and references. Use Postgres as a "real database." Reuse birds patterns aggressively in the first pass.

This plan incorporates:
- All user answers to the 11 design questions (2026-06-15).
- TREK specs (plagiarize ideas heavily for structure and features, but sideline the TREK app itself and move forward independently).
- Strict adherence to the birds repo tech stack, conventions, and `cs.md` rules (create equivalent docs for this project).
- Focus on high-value items for the July 27 trip (and beyond): **packing lists** and **list of places to visit** (cultural/historical/birding) with one-click Google Maps links and reference websites.
- CarbonFin "feel": easy adding, moving, nesting, reordering, hierarchical outlines.
- Server-rendered PDF as the stronger option.
- 30 MB attachment limit integrated with existing DO object storage.
- Owner-only primary with family (wife) viewer support.
- Separate Postgres cluster (copy birds isolation pattern exactly).
- Later phase: export/link to gaylon.photos trips feature (no coding now).

**Timeline note (user)**: "As fast as development has been going, it will be done in a week." Plan is phased for rapid, joyful iteration with clear high-value MVP slices. We can ship something genuinely useful for packing + places in the first few days.

---

## 1. Executive Summary & Success Criteria

A self-hosted, single-purpose web app (SvelteKit on the existing shared DO droplet) for storing, organizing, and quickly retrieving trip information. It prioritizes **frictionless capture and rearrangement** (CarbonFin spirit) over heavy automation.

**High-value MVP (what will actually be used on July 27 and future trips)**:
- Hierarchical / outliner-style **packing lists** — easy paste, drag-reorder, check-off, categories, progress.
- **Places / itinerary** as a rich, link-rich list of cultural, historical, and birding attractions — each with title, notes, Google Maps deep link (or Directions), reference website links, photos/attachments, easy nesting/reordering.
- Basic trip container + dates + overview.
- Google Maps integration (interactive + links) following birds patterns exactly.
- Owner (you) full control + wife read-only viewer mode (like birds family viewer).
- 30 MB attachments (photos, PDFs, tickets) stored in existing DO object storage.
- Server-rendered PDF export of the whole trip (or sections) for printing / offline reference.
- Fast search + retrieval of past trips.

**Non-goals for V1** (deliberately sidelined for fun + speed):
- Real-time multi-user editing (single user + viewer is enough).
- Heavy AI generation (optional later thin layer only).
- Full bookings engine or budget tracking (add only if it feels fun and low-effort).
- Birding-specific needs counts (defer to the existing birds app).

**Success = fun to build + delightful to use**:
- Paste an Airbnb link or a list of places and watch structured, reorderable items appear.
- Drag to nest and reorder like CarbonFin, with instant visual feedback (Svelte 5 runes).
- One tap from any place to Google Maps or a saved reference site.
- Beautiful, printable PDF that actually gets used.
- Feels like "your data, your way," with a real Postgres backend.

---

## 2. Tech Stack (Locked — Birds Exact, No Deviations in First Pass)

Use **exactly** the same stack and patterns as `/Users/gaylonvorwaller/birds` (unless a change is proven to increase fun or is required by a hard constraint).

- **Frontend / Fullstack**: SvelteKit 2 + Svelte 5 (runes mode) + TypeScript
- **Adapter**: `@sveltejs/adapter-node`
- **Styling**: Hand-written component-scoped `<style>` blocks **only**. No Tailwind, no utility frameworks. Base on `birds/docs/mockups/mockup.css` (mobile-first, 640px + 1024px breakpoints, fixed bottom nav on phone, ≥48px tap targets, WCAG AAA 7:1 contrast, system fonts, no iOS zoom on inputs). Create `docs/mockups/` for trips-specific mockups.
- **Database**: Direct `pg` (node-postgres). No ORM/Prisma/Drizzle. See `birds/src/lib/db.ts` (Pool + `query<T>()` + `withTransaction`). Raw SQL migrations in `backend/db/migrations/NNNN_*.sql`.
- **Postgres**: **Separate dedicated cluster** (copy birds pattern: prod on e.g. port 5437, test isolation on 15437 with `TRIPS_ENV=test` guards). Owner role for migrations, app role for runtime. `TIMESTAMPTZ` everywhere. Heavy but thoughtful use of JSONB for flexible "various object types."
- **Google Maps**: Exact reuse/adaptation of birds patterns:
  - `src/lib/google-maps.ts` loader (async `importLibrary`, callback).
  - `src/lib/components/MapPicker.svelte` (bindable, search, reverse geocode via `/api/geocode`).
  - Server geocode via `GOOGLE_GEOCODING_KEY`.
  - Public key: `PUBLIC_GOOGLE_MAPS_API_KEY` + `PUBLIC_GOOGLE_MAPS_MAP_ID` (add `trips.gaylon.photos` + dev ports to gaylonphotos GCP restrictions).
  - Places API enabled (no billing concerns per user).
- **Auth**: Copy birds (`argon2`, sessions cookie, `hooks.server.ts` gating). Primary "owner" role (full access). Add "viewer" role for wife (read-only, blocks all writes and sensitive paths). Simple login; no OIDC yet.
- **PWA**: Full support (service-worker.ts, `static/manifest.webmanifest`, icons) like birds + TREK inspiration.
- **Deploy / Ops**: 
  - PM2 via `ecosystem.config.cjs` on the shared droplet (IP 134.199.211.199).
  - Next available port (e.g. 3004 or 3005 — confirm current usage).
  - App dir: `/opt/trips`.
  - `scripts/deploy-to-DO.sh` (adapt from birds — preflight, pull, npm ci, build, migrate, optional nginx reload, pm2 startOrReload --update-env, health gate).
  - Health: `/api/health` returning `{ db: "ok", ... }`. Only `db == "ok"` gates deploys.
  - nginx + Cloudflare for `trips.gaylon.photos` (HTTP origin, like birds).
  - Separate `.env` (mode 600 on prod).
- **Dev**:
  - `npm run dev` on dedicated port (e.g. 5179).
  - `npm run check` (svelte-check) + `npm run build` **before every commit**.
  - Prettier.
  - Test DB scripts (`scripts/test-db-*.sh`).
  - Absolute paths + "always cd back to project root."
- **Other reused patterns** (first pass — modify only if painful):
  - Aliases: `$components`, `$server`.
  - `src/lib/server/*.ts` modules (e.g. `trips.ts`, `packing.ts`).
  - `withTransaction` for all multi-statement writes.
  - Ownership guards (`assertOwnsTrip` style).
  - Numbered migrations + `backend/db/migrate_pg.sh` (supports --dry-run, --env).
  - Backup script adapted from `scripts/backup-pg.sh`.
  - `docs/devlog/`, `docs/mockups/`.

**Why this stack feels fun here**:
- Svelte 5 runes + fine-grained reactivity make drag-to-reorder + live map sync / outliner indent magic.
- SvelteKit server actions + progressive forms make "paste URL → structured entry" extremely satisfying.
- Direct SQL + Postgres JSONB gives Oracle-style control without bloat.
- Consistency with birds means zero context switching and instant velocity.

**Clear advantages considered and rejected for V1**:
- Tailwind or shadcn → violates birds rules and hand-crafted aesthetic.
- Prisma or full ORM → loses explicit SQL joy and adds deps.
- Realtime (WS) → overkill for single-user + viewer; adds complexity on shared droplet.
- Client-only PDF or pure jsPDF → user explicitly wants server-rendered as stronger option.

---

## 3. Hosting, Infrastructure & Object Storage

**Droplet (shared with gaylonphotos, giftlist, madonnahist, birds)**:
- Same IP, same SSH pattern (IP only).
- New app "trips" on next port.
- Separate Postgres cluster (birds uses 5436; suggest 5437 for trips prod; test on 15437).
- Follow birds `cs.md` "Production Infrastructure" and "Shared Droplet Awareness" exactly (modest memory_restart, no heavy processing).

**Object Storage for Attachments (30 MB max)**:
- Integrate with **existing DO object storage** used by gaylon.photos (DO Spaces or S3-compatible).
- Do **not** store blobs in Postgres or local FS long-term.
- Design:
  - Server-side upload proxy (or direct presigned POST from client with server-generated policy for security).
  - Enforce 30 MB limit + mime whitelist (images, PDF, common docs) in code.
  - Store in DB: `original_name`, `mime_type`, `size_bytes`, `object_key` (or URL path), `trip_id` / `reservation_id` / `item_id` foreign keys, `uploaded_at`.
  - Access: Presigned GET URLs (time-limited) or public bucket prefix with appropriate ACLs (prefer private + signed).
  - Bucket strategy: Use existing gaylon.photos bucket with a `trips/` or `attachments/trips/` prefix, or a dedicated `trips-attachments` bucket if cleaner. Coordinate with gaylon.photos repo for credentials/config.
  - Cleanup: Optional soft-delete + lifecycle policy on the bucket side.
- Future: Thumbnail generation for photos (later phase, respect shared droplet limits).

**Backups**:
- Adapt `scripts/backup-pg.sh` (pg_dump for the trips cluster + .env + nginx + PM2 state).
- Include object storage snapshot strategy if available from DO.

**Health & Gating**:
- `/api/health` must confirm DB connectivity and (later) object storage reachability.

---

## 4. Auth Model

- **Owner** (you): Full read/write on all trips.
- **Viewer** (wife): Read-only access to all trips (or a designated shared set). No writes, no settings, no delete. Mirrors birds viewer role exactly (hooks.server.ts blocks non-GET/HEAD mutations except logout; redirect settings-like paths).
- Login page with simple password (argon2, like birds).
- Single shared "family viewer" account or per-person (start simple: one viewer account).
- No public sharing, no invite links in V1.
- Sessions: 30-day cookie, httpOnly, sameSite=strict, secure in prod.

---

## 5. Data Model (Postgres + Hierarchical CarbonFin Feel)

Core tables (start from birds `trips` + `trip_stops` and expand). Use `sort_order` + parent relationships for true outliner nesting. JSONB for flexible payloads.

```sql
-- Core (adapt from birds 0001_schema.sql + trips tables)
CREATE TABLE users (...); -- minimal copy from birds
CREATE TABLE sessions (...);

CREATE TABLE trips (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    start_date DATE,
    end_date DATE,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hierarchical outliner-style items (places, day plans, notes, sub-lists)
-- parent_id + sort_order gives CarbonFin nesting + easy move/indent/promote/demote
CREATE TABLE itinerary_items (
    id SERIAL PRIMARY KEY,
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    parent_id INTEGER REFERENCES itinerary_items(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    item_type TEXT NOT NULL DEFAULT 'place', -- 'place' | 'note' | 'day' | 'section' | 'packing-ref'
    title TEXT NOT NULL,
    notes TEXT,
    lat DOUBLE PRECISION,
    lon DOUBLE PRECISION,
    external_url TEXT,           -- reference website or notes:// link
    google_maps_url TEXT,        -- pre-built or deep link
    date DATE,                   -- for day-to-day grouping
    meta JSONB,                  -- flexible (e.g. {category: 'historical', duration: '2h'})
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX itinerary_items_trip_parent_sort ON itinerary_items(trip_id, parent_id, sort_order);

-- Reservations / Accommodations (TREK-style, with flexible details)
CREATE TABLE reservations (
    id SERIAL PRIMARY KEY,
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    item_type TEXT NOT NULL,     -- 'accommodation' | 'flight' | 'restaurant' | 'other'
    title TEXT NOT NULL,
    confirmation_code TEXT,
    status TEXT,
    start_at TIMESTAMPTZ,
    end_at TIMESTAMPTZ,
    details JSONB,               -- { "airbnb_url": "...", "guests": 2, "checkin": "..." }
    notes TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Packing lists (high priority per user)
CREATE TABLE packing_lists (
    id SERIAL PRIMARY KEY,
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT 'Packing List',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE packing_items (
    id SERIAL PRIMARY KEY,
    list_id INTEGER NOT NULL REFERENCES packing_lists(id) ON DELETE CASCADE,
    parent_id INTEGER REFERENCES packing_items(id) ON DELETE CASCADE, -- nesting support
    sort_order INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    quantity INTEGER DEFAULT 1,
    checked BOOLEAN DEFAULT FALSE,
    category TEXT,
    notes TEXT,
    weight_grams INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Attachments (30 MB max, DO object storage)
CREATE TABLE attachments (
    id SERIAL PRIMARY KEY,
    trip_id INTEGER REFERENCES trips(id) ON DELETE CASCADE,
    reservation_id INTEGER REFERENCES reservations(id) ON DELETE CASCADE,
    itinerary_item_id INTEGER REFERENCES itinerary_items(id) ON DELETE CASCADE,
    packing_item_id INTEGER REFERENCES packing_items(id) ON DELETE CASCADE,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes <= 30 * 1024 * 1024),
    object_key TEXT NOT NULL,    -- key in DO Spaces / S3 bucket
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    meta JSONB
);
CREATE INDEX attachments_trip_idx ON attachments(trip_id);

-- Optional supporting
CREATE TABLE places_cache ( ... ); -- for Google place results if useful
```

**Hierarchical / CarbonFin feel**:
- `parent_id` + `sort_order` on `itinerary_items` and `packing_items`.
- Server helpers: `moveItem`, `indentItem`, `outdentItem`, `reorderSiblings` (using `withTransaction` + careful sort_order swaps/reindexing, exactly like birds `moveStop` / `setStopOrder` + `optimizeStopOrder`).
- Client: Drag-and-drop with visual nesting (Svelte 5 runes for live preview), keyboard shortcuts (move up/down, indent), collapse/expand.

**JSONB usage** (leverages Postgres strength per user preference):
- `reservation.details`, `itinerary_items.meta`, attachment `meta` (extracted text, EXIF, etc.).

**Ownership**: Every query includes `user_id` filter or explicit guard functions.

---

## 6. Core Features & User Flows (Prioritized)

**MVP High-Value Slice (packing + places list — ship this fast)**:
- Create/edit trip (name, dates, notes).
- **Places / Itinerary view**: Outliner of places to visit.
  - Add anywhere (quick form or paste).
  - Paste a reference URL → unfurl title + description + image (server or client) → create place item with link + optional Google Maps lookup.
  - Drag to reorder, nest under days/sections, promote/demote.
  - Every item: title, notes (rich-ish textarea), external reference link(s), Google Maps link (auto-generated from lat/lon or search), date for day grouping.
  - Map sidebar or embedded interactive Google Map showing all pins (click pin → highlight/scroll to list item). Reuse MapPicker + birds map components.
  - Birding places explicitly lower priority (link out to birds app if needed).
- **Packing List view** (or tab/section):
  - One or more named lists per trip.
  - Hierarchical items (categories as parents?).
  - Checkboxes, quantity, notes.
  - Paste multi-line text → bulk create items (split on newlines, smart category detection).
  - Drag-reorder + check-off with live progress.
  - Templates? (global or per-trip copy) — nice-to.
- Quick add from anywhere (floating action or keyboard).
- List of all past trips with search/filter (by date, name, has-packing, etc.).
- Basic retrieval: trip detail loads fast with all sections.

**Next (still high fun/impact)**:
- Reservations (accommodations especially): structured form + confirmation + link to places. Attach 30 MB files (to DO object storage).
- Attachments gallery per trip (photos, tickets, PDFs) — view, download (presigned), delete. Upload with progress.
- Day-to-day grouping (use `date` + collapsible sections in the outliner).
- Server-rendered PDF export: endpoint that renders a clean, print-optimized view of the entire trip (itinerary outliner, packing, reservations with attachment list, maps summary, notes) to high-quality PDF. Use puppeteer (or equivalent Node HTML-to-PDF) on the server for fidelity. Button per trip + per-section. Respect shared droplet memory (perhaps queue or lightweight).
- Google Maps deep integration: place search in quick-add, "Open in Google Maps" buttons everywhere, optional Directions link for multi-stop days.

**Polish & Delight**:
- Excellent mobile experience (bottom nav, large targets).
- PWA install (feels like a real app on phone).
- Fast copy/paste everywhere (URL unfurl is magic).
- Simple stats (e.g. "12 places • 3 packed bags").
- Print CSS as immediate fallback even before full PDF.

**Later phases (explicitly deferred)**:
- Export / link to gaylon.photos trips feature (one-way or two-way sync of places/photos).
- Budget tracking, weather panels, route optimization (can lift more from birds + TREK).
- Real-time (if it ever feels necessary).
- Advanced importers (email forward, GPX, etc.).
- Journal entries with photo attachments.

---

## 7. Google Maps Integration (Birds Patterns, TREK Flavor)

- Loader and MapPicker reused/adapted first pass.
- Interactive planner map: pins for itinerary items, drag markers to update lat/lon (optimistic + server save).
- Place search: Google Places (via server or client library) for adding new cultural/historical spots.
- Every place item gets reliable "View on Google Maps" (deep link or constructed URL) and optional reference website(s).
- Server geocode for pasted addresses or reverse from map taps.
- No hard dependency on live Directions in V1 (but easy to add later using birds patterns).

---

## 8. Attachments & DO Object Storage Flow

1. User selects file(s) on trip / reservation / packing / place form (≤30 MB enforced client + server).
2. Upload goes through authenticated SvelteKit action or `+server.ts` endpoint.
3. Server (or direct presigned) puts object into the existing DO Spaces bucket under a trips prefix.
4. Record metadata row in `attachments` table.
5. UI shows thumbnail (if image) or icon + filename + size + "Download" (presigned URL) and "Remove".
6. On delete: remove DB row + (optionally) delete object (or rely on bucket lifecycle).

Credential management: Mirror how gaylon.photos / birds handle secrets (encrypted in DB or .env, never logged). Add to trips `.env`.

---

## 9. Server-Rendered PDF (Stronger Option)

- `POST /trips/[id]/export/pdf` (or GET for simplicity).
- Server uses a headless browser (puppeteer recommended for fidelity; evaluate memory impact on shared droplet — start with small viewport + essential sections only).
- Renders a dedicated clean "print view" route (or the main trip page with `?print` param + CSS) that includes:
  - Cover with trip name/dates.
  - Hierarchical itinerary (collapsed or expanded).
  - Packing lists (checked state).
  - Reservations + attachment list (links or note "see original for files").
  - Notes and reference links.
  - Simple map overview image (static map or omitted for size).
- Stream PDF response with good filename.
- Also provide "Print this view" button that uses browser print (with excellent `@media print` CSS) as instant win.

Alternative lightweight path if puppeteer proves heavy: server-side HTML → PDF via a pure-JS lib with good layout, or even high-quality Markdown + conversion. User preference is server-rendered, so puppeteer or equivalent is the target.

---

## 10. UI/UX Principles & CarbonFin Outliner Feel

- **Hierarchical first**: Every major list (itinerary, packing) supports nesting via parent_id + sort_order.
- **Move anything, anywhere**: Drag handles + keyboard (↑↓, Tab/Shift-Tab for indent). Visual feedback with Svelte 5 runes (live ghost, auto-expand parents on drag-over).
- **Easy add everywhere**: "+" buttons at every level + a global quick-capture bar that intelligently routes (URL → place/reservation, multi-line → packing).
- **Paste power**: 
  - Single URL → unfurl + create structured item.
  - Multi-line text in packing context → multiple items.
- **Links out**: Every place has prominent Google Maps and reference website buttons (open in new tab or Maps app).
- **Cards + lists**: Follow birds mockup aesthetic (clean cards, obs-style rows, badges for status/category).
- **Responsive**: Phone-first with bottom nav (Itinerary / Packing / Reservations / Overview). Tablet/desktop side-by-side map+list where it helps (like birds trips mockup).
- **No toasts, use modals** for confirmations (per birds rules).
- **Fast & local-feeling**: Optimistic updates on reorder/check + background save. Offline shell via PWA for viewing packing and lists.

Create `docs/mockups/trips.html` + `mockup.css` early (adapt from birds `trips.html` mockup and index).

---

## 11. Phased Roadmap (Prioritized for Value + Fun)

**Phase 0 — Skeleton & Foundations (½–1 day, high setup satisfaction)**
- `mkdir -p` structure mirroring birds exactly.
- Copy/adapt: `package.json` (add minimal), `svelte.config.js`, `vite.config.ts`, `src/lib/db.ts`, `src/lib/google-maps.ts`, basic `MapPicker.svelte`, `hooks.server.ts` + auth/session modules, `src/routes/+layout.svelte` + top/bottom nav, health route, PWA files.
- Dedicated PG cluster + test isolation scripts.
- First migration: users/sessions + basic trips + itinerary_items + packing scaffolding (with parent_id + sort_order).
- `migrate_pg.sh`, `test-db-*` scripts, `deploy-to-DO.sh` skeleton, `ecosystem.config.cjs`.
- Basic owner login flow.
- Verification: `npm run check && npm run build`, local dev on 5179, psql against test DB, MapPicker renders, health passes.

**Phase 1 — Core Trip + Hierarchical Places/Itinerary (CarbonFin + Maps — high value)**
- Trip CRUD + list.
- `itinerary_items` full CRUD with nesting.
- Reorder/indent/outdent helpers (server + client drag).
- Google Map in trip view (pins from items, click syncs selection).
- Quick add + URL unfurl (basic) for places.
- External ref links + auto Google Maps link generation.
- Day grouping via date field + collapsible sections.
- Verification: build a 10-item nested itinerary for a sample trip, drag-reorder + nest, map updates live, links work, psql confirms tree, `npm run check`.

**Phase 2 — Packing Lists (User's #1 High-Value Item)**
- `packing_lists` + `packing_items` (with nesting/parent).
- Checkboxes, quantity, category, notes, progress bar.
- Paste multi-line → bulk create.
- Same drag-reorder + indent as itinerary.
- Per-trip or multiple lists.
- Verification: create rich packing list from pasted text, nest categories, check items, reorder, survives reload.

**Phase 3 — Reservations + DO Object Storage Attachments (30 MB)**
- Reservations model + UI (focus on accommodation + flights first).
- File upload flow to DO object storage (presigned or server proxy), 30 MB enforcement, metadata rows.
- Link attachments to reservations / itinerary items.
- Attachment gallery + download (presigned URLs).
- Verification: create reservation, attach a real 5–10 MB PDF/photo, view/download/delete, object appears in bucket, DB row correct, no local blob storage.

**Phase 4 — Server-Rendered PDF + Polish + Deploy**
- Dedicated print/PDF route + puppeteer (or chosen server-render lib) endpoint.
- Clean, comprehensive PDF (cover, full outliner itinerary, packing with checks, reservations, attachment list, notes, links).
- Excellent accompanying print CSS.
- Search / past trips retrieval.
- PWA manifest + install.
- Full deploy to trips.gaylon.photos (nginx, PM2, health gate, separate PG).
- Verification: generate beautiful PDF from a complete sample trip, print looks good, deployed site works for owner + viewer, all checks pass.

**Phase 5 — Delight & Later Items**
- Gaylon.photos trips export/link (planning only for now).
- Additional TREK-inspired polish if it feels fun (simple weather, basic route opt using Google like birds).
- More unfurl intelligence, templates, etc.
- Devlog entries, docs updates.

Each phase ends with: `npm run check && npm run build`, manual + psql verification, ownership guards tested, no synthetic data.

---

## 12. Project Structure (Birds Mirror)

Exact same top-level layout as birds, with "trips" names:
- `src/routes/trips/...` or root-level for simplicity (decide in Phase 0).
- `backend/db/migrations/`
- `scripts/`
- `docs/` (this plan + future design/devlog/mockups)
- `static/`, `deploy/`, etc.

Create `docs/grok-trip-planner-V1-plan.md` (this file), `cs.md` (light adaptation of birds), `CLAUDE.md` / `AGENTS.md` pointing to it.

---

## 13. Development Workflow & Rules (Birds cs.md Alignment)

- Session startup: Read this plan + new `cs.md` + recent devlog + mockups.
- Always verify with real `psql`, browser devtools, and direct API calls — no guessing.
- `npm run check` + `npm run build` before commit.
- Migrations only via the script; never inline DDL.
- Use `withTransaction` for anything that touches multiple tables.
- Absolute paths, cd back to `/Users/gaylonvorwaller/trips`.
- Shared droplet discipline: keep footprint small (PDF rendering is the main risk — monitor).
- Document decisions in `docs/devlog/`.

---

## 14. Risks & Mitigations

- **Puppeteer / PDF memory on shared droplet**: Mitigate by rendering only essential sections, using a lightweight config, or falling back to high-quality print CSS + user "Save as PDF". Profile early.
- **DO object storage integration details**: Need actual bucket name, credentials style, and upload pattern from gaylon.photos. Plan a thin `src/lib/server/storage.ts` abstraction so the rest of the app doesn't care.
- **Google key management**: Add origins carefully; document in plan + gaylonphotos repo.
- **Nesting complexity**: Start with solid server helpers copied from birds stop-reordering logic. Test tree moves thoroughly.
- **Viewer mode leaks**: Copy birds hooks.server.ts logic exactly and test aggressively.
- **30 MB + photos**: Enforce everywhere; consider future thumbnail pipeline only after V1.

---

## 15. Later Phases (Explicitly Out of Scope for Initial Build)

- Two-way or one-way sync/export with gaylon.photos trips feature (user explicitly said "link or export... but as a later phase. No coding for now").
- Real-time collaboration.
- Advanced TREK features (full budget, bag tracking, journal with Immich, AI/MCP, route optimization with live Directions) — only if they become fun after core is solid.
- Email import, calendar sync, etc.

---

## 16. Immediate Next Actions (After Plan Review)

1. User reviews/approves this plan (and answers any remaining micro-questions).
2. Create `docs/cs.md` (lightweight version of birds, referencing this plan as authoritative design).
3. Initialize skeleton in the `/trips` workspace (Phase 0).
4. Set up separate PG cluster + first migration.
5. Get the first high-value slice (Phase 1 + 2) working quickly for the packing + places list experience.

---

**Appendix: Key TREK Ideas Adapted (for reference during implementation)**

- Drag & drop day plans with cross-day moves + reordering.
- Interactive map + place search (Google in our case).
- Reservations with status, confirmation numbers, **file attachments**.
- Packing lists with categories, templates, progress, assignment.
- Document manager (now DO object storage).
- Full trip PDF export with cover, images, notes.
- Day notes (timestamped, reorderable).
- PWA + offline shell.
- Overall "one place for the whole trip" mental model.

We keep the spirit and feature coverage while implementing in the birds-approved, fun-to-code SvelteKit + raw Postgres + Google Maps way.

---

*Plan saved as requested. Ready to start scaffolding when you give the word.*