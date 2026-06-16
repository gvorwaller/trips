> **SUPERSEDED by [`trip-planner-V3-FINAL-plan.md`](./trip-planner-V3-FINAL-plan.md) (2026-06-15).** Retained for history. V3 is authoritative.

# Codex Trip Planner - V2 Review and Revised Implementation Plan

**Project**: trips.gaylon.photos  
**Date**: 2026-06-15  
**Author**: Codex  
**Based on**: `docs/grok-trip-planner-V1-plan.md` plus narrow verification of the sibling `birds` and `gaylonphotos` repos  
**Status**: Review complete. This file is the recommended V2 implementation plan.

---

## 1. Review Verdict

The V1 plan has the right product center: a personal trip reference app focused on packing, places, maps, attachments, and exports. The strongest parts are the CarbonFin-style outliner goal, the decision to stay close to the birds stack, and the focus on a useful July 27-ready MVP.

The main weakness is that V1 treats several unverified or non-equivalent systems as if they can be copied directly. Birds is a good reference for SvelteKit, Postgres, auth, Google Maps, deployment, and read-only viewer behavior. It is not a reference for attachment uploads or server-rendered PDF. Gaylonphotos is the better reference for DO Spaces, upload validation, rollback cleanup, and adapter-node body-size limits.

V2 keeps the product goal, narrows the MVP, and makes infrastructure discovery and risk reduction explicit before implementation.

---

## 2. Verified Context

Current trips workspace:
- `/Users/gaylonvorwaller/trips` currently contains `AGENTS.md` and `docs/grok-trip-planner-V1-plan.md`.
- The workspace is not currently a Git repository, so implementation workflow must not assume `git status`, commits, branches, or tracked files until source control is initialized or confirmed.
- `AGENTS.md` requires `td usage --new-session` at conversation start and `td usage -q` for later task reads.

Birds repo facts verified from `/Users/gaylonvorwaller/birds`:
- Stack: SvelteKit 2, Svelte 5, adapter-node, TypeScript, `pg`, `argon2`, Prettier, Vitest.
- Direct Postgres helper exists in `src/lib/db.ts` with `query<T>()`, pooled `pg`, and `withTransaction()`.
- Auth/session pattern exists with 30-day strict cookies and viewer blocking in `src/hooks.server.ts`.
- Google Maps patterns exist in `src/lib/google-maps.ts`, `MapPicker.svelte`, and `/api/geocode`.
- Production pattern: PM2, nginx, shared droplet, birds app port `3003`, dev port `5178`, Postgres port `5436`, test Postgres port `15436`.
- Birds exports trip data as Markdown, not PDF.
- Birds explicitly has no upload/blob storage pipeline.

Gaylonphotos repo facts verified from `/Users/gaylonvorwaller/gaylonphotos`:
- DO Spaces is implemented with `@aws-sdk/client-s3`.
- Storage helper uses `S3Client`, `PutObjectCommand`, `DeleteObjectCommand`, prefix deletion, and CDN URL construction.
- Upload code validates file size, MIME type, and magic bytes.
- Upload processing cleans up partially uploaded objects on failure.
- Prior devlog documents an adapter-node upload limit issue: large multipart uploads require an explicit `BODY_SIZE_LIMIT` strategy, with nginx enforcing practical limits upstream.

---

## 3. What V1 Gets Right

- The app should stay personal, fast, and pragmatic: owner editing plus wife read-only viewing is enough for V1.
- Packing and places are the highest-value MVP features. They should ship before reservations, attachments, PDF, or advanced importers.
- The birds stack is the right baseline: SvelteKit, Svelte 5, raw SQL, direct `pg`, PM2, nginx, Cloudflare, and separate Postgres cluster.
- Google Maps should reuse the birds loader, map picker, and geocode pattern.
- The UI should be hand-written CSS, mobile-first, high contrast, no Tailwind, and no general utility framework.
- The data should live in Postgres, with JSONB used only where flexible metadata is actually useful.

---

## 4. Weaknesses in V1 and Required Corrections

### 4.1 "Copy birds exactly" is too broad

V1 repeatedly says to copy birds exactly. That is safe for auth, DB helpers, Maps, deployment shape, and UI conventions. It is not safe for uploads, object storage, full document management, or PDF rendering.

Correction:
- Treat birds as the app architecture reference.
- Treat gaylonphotos as the DO Spaces and upload-safety reference.
- Treat PDF export as new work with its own proof step.

### 4.2 Infrastructure discovery is pushed too late

V1 names likely ports and cluster numbers, but those must be verified before scaffolding.

Correction:
- Phase 0 must verify ports, PM2 names, nginx body-size rules, Postgres cluster availability, Maps key origins, and Spaces env variables.
- Do not hard-code guessed ports until confirmed.

### 4.3 Schema is under-constrained

The draft schema is a useful sketch, but it leaves too much integrity to application convention.

Correction:
- Add `updated_at` to mutable tables.
- Add `CHECK` constraints for roles, item types, reservation types, attachment status, and file size.
- Add indexes for `(trip_id, parent_id, sort_order)`, search fields, and attachment ownership.
- Enforce no cross-trip parent/child relationships in server mutation helpers and tests.
- Prevent nested item cycles in server logic before writes.
- Do not use placeholder `CREATE TABLE ... (...)` in the authoritative migration plan.

### 4.4 Attachment model needs explicit safety

V1 says "server proxy or presigned" and "public or private" but leaves the implementer to decide.

Correction for V1 implementation:
- Use authenticated server-proxy uploads first. It is simpler and safer for a personal app.
- Use private object keys if the existing bucket supports it cleanly. If the bucket is public-CDN-only, store unguessable object keys and document the tradeoff.
- Enforce 30 MB in client, SvelteKit route, nginx, and DB constraint.
- Validate magic bytes for supported files. Do not trust browser MIME alone.
- Roll back Spaces objects if DB insert fails.
- Delete object first or mark delete-pending if Spaces deletion fails, so metadata does not lie.

### 4.5 PDF export is overscoped for early V1

Puppeteer on a shared droplet can be memory-heavy. V1 identifies this risk but still places PDF as a core expectation.

Correction:
- First ship print CSS plus Markdown/HTML export.
- Add headless browser PDF only after memory testing locally and on the droplet.
- Keep PDF rendering serialized or rate-limited if enabled in production.

### 4.6 Viewer protection should include CSRF/origin checks

Birds blocks viewer mutations by method and path. Gaylonphotos also checks mutation origins.

Correction:
- Implement both: role-based mutation blocking and same-origin checks for POST/PUT/PATCH/DELETE.
- Viewer should be able to logout, view trips, download safe exports, and open signed attachment links.
- Viewer must not upload, delete, edit, reorder, create, or access settings.

### 4.7 MVP order should be tighter

V1 starts with a broad skeleton, then places, then packing. Since packing is one of the highest-value features, it should not wait behind all Maps polish.

Correction:
- Build trip shell, auth, places outliner, and packing outliner before attachments and PDF.
- Keyboard move/indent/outdent can ship before drag-and-drop.
- Drag-and-drop is polish unless it is quick to implement safely.

---

## 5. V2 Product Scope

### MVP

The MVP is a private trip reference app with:
- Owner login and read-only viewer login.
- Trip list and trip detail.
- Places outliner with sections, nested items, notes, links, dates, and Google Maps links.
- Packing outliner with categories, nested items, quantity, notes, checked state, and progress.
- Fast add and paste flows for plain text, URLs, and multi-line packing input.
- Mobile-first UI with bottom navigation and large tap targets.
- Basic export: print view and Markdown or HTML download.

### Post-MVP but still V1

- Interactive Google map with pins from place coordinates.
- Reservations for accommodation, flights, restaurants, and other confirmations.
- Attachments up to 30 MB in DO Spaces.
- Search across trips, places, packing, reservations, and notes.
- Headless-browser PDF after memory proof.
- PWA shell for fast repeat access.

### Explicitly deferred

- Realtime multi-user editing.
- Public share links.
- Full budget tracking.
- Calendar/email import.
- Advanced AI generation.
- Two-way sync with gaylon.photos.
- Route optimization beyond simple Google Maps links.

---

## 6. Recommended Architecture

### App stack

- SvelteKit 2, Svelte 5, TypeScript, adapter-node.
- Direct `pg` with a copied/adapted `query<T>()`, `withTransaction()`, and health check.
- Raw SQL migrations in `backend/db/migrations`.
- Component-scoped CSS only, using birds mockups as the visual reference.
- No ORM, Tailwind, shadcn, or realtime server in V1.

### Project layout

Use the birds layout:
- `src/routes`
- `src/lib`
- `src/lib/server`
- `src/lib/components`
- `backend/db/migrations`
- `scripts`
- `static`
- `deploy`
- `docs/devlog`
- `docs/mockups`

Route recommendation:
- Use root app routes for the main product: `/`, `/trips`, `/trips/[id]`.
- Use nested route groups for trip subsections only if the UI becomes too large.
- Keep API routes under `/api/*` for health, geocode, uploads, and exports.

### Data access

- All multi-statement writes use `withTransaction()`.
- All mutations check ownership or viewer role before writing.
- Server modules own SQL. Route files should validate inputs, call server modules, and format responses.
- No synthetic fallback data. Empty or missing data should be shown as empty states.

---

## 7. Data Model V2

The first migration should create complete, concrete tables. Avoid placeholder SQL in migrations.

Core tables:
- `users`
- `sessions`
- `trips`
- `itinerary_items`
- `packing_lists`
- `packing_items`
- `reservations`
- `attachments`

Recommended fields and constraints:
- `users.role CHECK (role IN ('owner', 'viewer'))`
- `trips.updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `itinerary_items.item_type CHECK (item_type IN ('section', 'day', 'place', 'note'))`
- `packing_items.checked BOOLEAN NOT NULL DEFAULT FALSE`
- `packing_items.quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0)`
- `reservations.reservation_type CHECK (reservation_type IN ('accommodation', 'flight', 'restaurant', 'transport', 'other'))`
- `attachments.size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 31457280)`
- `attachments.object_key TEXT UNIQUE NOT NULL`
- `attachments.status CHECK (status IN ('active', 'delete_pending'))`

Hierarchy rules:
- `itinerary_items.parent_id` references `itinerary_items(id) ON DELETE CASCADE`.
- `packing_items.parent_id` references `packing_items(id) ON DELETE CASCADE`.
- Server code must reject a parent from a different trip/list.
- Server code must reject moving an item under itself or under its own descendant.
- Reorder operations should reindex siblings in one transaction.

Attachment ownership:
- Store `trip_id` on every attachment for simple ownership checks.
- Optional parent columns may link to a reservation, itinerary item, or packing item.
- Server code must verify the linked parent belongs to the same trip.
- Prefer exactly one specific parent target for item-level attachments. Trip-level attachments have only `trip_id`.

Search:
- Add simple indexes first: lower title/name fields and trip/date indexes.
- Use Postgres full-text search later only if plain search feels weak.

---

## 8. Core Workflows

### Owner

- Login.
- Create trip with name, dates, and notes.
- Add places, notes, days, and sections to an outliner.
- Move items up/down, indent/outdent, and reorder siblings.
- Add packing lists and packing items.
- Paste multi-line packing text into a list.
- Check and uncheck packing items.
- Add Google Maps links or coordinates to place items.
- Export or print a trip.
- Later: add reservations and attachments.

### Viewer

- Login with viewer account.
- View all trips the owner shares by default.
- Open maps and reference links.
- View packing and itinerary state.
- Print or download safe exports.
- Cannot mutate any data.

### Mobile

- Bottom nav: Overview, Places, Packing, Reservations, More.
- Minimum 48px tap targets.
- Inputs at least 16px to avoid iOS zoom.
- No hover-only controls.
- Drag handles are optional; keyboard/button controls must exist.

---

## 9. Upload and Object Storage Plan

Use gaylonphotos as the reference, but simplify:
- Add `@aws-sdk/client-s3`.
- Create `src/lib/server/storage.ts` with `putObject`, `deleteObject`, `getObjectUrl` or signed URL support.
- Object key format: `trips/{tripId}/{attachmentId-or-random}/{safe-filename}`.
- Generate random object-key segments server-side. Do not trust original filenames for uniqueness.
- Keep original filename only as display metadata.

Upload endpoint:
- Auth required.
- Same-origin mutation check required.
- Owner role required.
- `multipart/form-data` only.
- Validate trip ownership before reading or storing the file.
- Enforce 30 MB before upload.
- Validate MIME and magic bytes for allowed categories:
  - PDF
  - JPEG
  - PNG
  - WebP
  - HEIC/HEIF if practical
  - plain text or common office docs only if explicitly wanted
- Insert metadata only after successful object upload.
- If DB insert fails after object upload, delete the object before returning an error.

Deployment requirements:
- Set adapter-node body-size strategy for 30 MB uploads.
- Set nginx `client_max_body_size` slightly above 30 MB for this app only.
- Confirm whether the existing Spaces bucket is private or public-CDN oriented before choosing signed GET URLs.

---

## 10. Maps Plan

Start with reliable links before complex map editing:
- Store `lat`, `lon`, `place_id`, `google_maps_url`, and `external_url` where available.
- Generate Google Maps search/place links for place items even without coordinates.
- Reuse birds loader and MapPicker once keys and origins are confirmed.
- Add interactive map after the places outliner works.
- Do not make live Directions or route optimization required for V1.

Required setup:
- Add `trips.gaylon.photos` to Maps key restrictions.
- Add local dev origin after the dev port is chosen.
- Keep server geocode behind `GOOGLE_GEOCODING_KEY`.

---

## 11. Export and PDF Plan

Phase 1 export:
- Add print CSS for the trip detail page.
- Add `/trips/[id]/export.md` or `/trips/[id]/export` returning Markdown or HTML.
- Include trip overview, places, packing, reservations if present, and links.

Phase 2 export:
- Add dedicated print view route with clean layout.
- Add server-rendered PDF only after testing memory and install footprint.
- If using Puppeteer or Playwright, serialize PDF requests and set PM2 memory limits conservatively.
- If headless PDF is too heavy, keep print CSS plus HTML export as the production-safe option.

---

## 12. Security and Auth

Use birds auth as the baseline:
- `argon2` password hashes.
- `sessions` table.
- 30-day httpOnly strict cookies.
- `secure: true` in production.
- `locals.user` and `locals.ownerId`.

Add these V2 requirements:
- Same-origin check for all mutating requests.
- Role guard in hooks plus server-module ownership checks.
- No settings access for viewer.
- No upload/download bypass by guessing object keys.
- No logging of secrets, session tokens, Spaces keys, Maps keys, or uploaded object keys in error traces.
- Return explicit 403 for viewer writes.

---

## 13. Revised Phased Roadmap

### Phase 0 - Verification and Foundation

- Confirm whether this workspace should be initialized as a Git repo.
- Create `cs.md`, `CLAUDE.md`, and expanded `AGENTS.md` for trips.
- Confirm dev port, production port, Postgres port, PM2 name, nginx config path, Maps origins, and Spaces policy.
- Scaffold SvelteKit using birds package patterns.
- Add health route, DB helper, migration runner, test DB scripts, and deploy skeleton.
- Create first concrete migration.

Acceptance:
- `npm run check` and `npm run build` pass.
- `/api/health` returns DB ok.
- Test DB scripts refuse production settings.

### Phase 1 - Auth and Trip Shell

- Owner and viewer users.
- Login/logout.
- Hook protection.
- Trip list, create, edit, delete.
- Basic responsive layout and navigation.

Acceptance:
- Owner can manage trips.
- Viewer can view but cannot POST, PUT, PATCH, or DELETE.
- Same-origin mutation guard rejects bad origins.

### Phase 2 - Places and Packing MVP

- Itinerary/places outliner with sections, days, places, and notes.
- Packing lists and packing items.
- Add, edit, delete, check, move up/down, indent, outdent.
- Multi-line paste for packing.
- Simple URL capture for places.

Acceptance:
- A 10-item nested itinerary survives reload.
- A nested packing list can be pasted, checked, reordered, and reloaded.
- Cycle and cross-parent moves are rejected.
- Viewer cannot mutate outliners.

### Phase 3 - Maps and Link Polish

- Google Maps links on every place.
- MapPicker integration for coordinates.
- Interactive map with pins and item selection.
- Reference links on itinerary items.

Acceptance:
- Place links open correctly.
- Map renders on local and production origins.
- Missing Maps keys fail visibly without breaking the page.

### Phase 4 - Reservations and Attachments

- Reservation CRUD.
- Attachment upload/download/delete.
- DO Spaces integration.
- 30 MB enforcement.
- Attachment list on trip, reservation, and item views.

Acceptance:
- Valid PDF/image upload succeeds.
- Oversized file is rejected.
- Disguised unsupported file is rejected.
- DB insert failure cleans up uploaded object.
- Spaces delete failure leaves metadata in a retryable state.

### Phase 5 - Export, PWA, Deploy

- Print view.
- Markdown or HTML export.
- PWA manifest and icons.
- Headless PDF only if memory proof passes.
- Deploy to `trips.gaylon.photos`.

Acceptance:
- Print output is readable on desktop and mobile.
- Export includes links and current checked states.
- Production health gate checks DB.
- Owner and viewer flows work after deploy.

---

## 14. Test Plan

Automated:
- `npm run check`
- `npm run build`
- Vitest for hierarchy move helpers.
- Vitest for cycle prevention.
- Vitest for viewer mutation blocking.
- Server tests for upload validation where practical.

Manual:
- Browser smoke test for owner.
- Browser smoke test for viewer.
- Mobile viewport check.
- Real `psql` verification after migrations.
- Upload a real small PDF/image.
- Attempt an oversized upload.
- Attempt unsupported file contents.
- Print/export a real sample trip.

Deployment:
- Verify PM2 process name and port.
- Verify nginx body-size limit.
- Verify Cloudflare/domain routing.
- Verify `/api/health`.
- Verify no secrets in logs.

---

## 15. Immediate Next Actions

1. Create trips project control docs: `cs.md`, `CLAUDE.md`, and fuller `AGENTS.md`.
2. Decide or initialize source control for `/Users/gaylonvorwaller/trips`.
3. Verify infrastructure ports and env before hard-coding them.
4. Scaffold the SvelteKit app from birds patterns.
5. Implement Phase 1 and Phase 2 before attachments and PDF.

---

## 16. Assumptions

- The first useful release should prioritize July 27 practical use over completing every TREK-inspired feature.
- The owner and wife viewer model is enough for V1.
- The trips app should be its own app and database, not a feature inside birds or gaylonphotos.
- DO Spaces can be reused, but the exact bucket/privacy policy must be verified before implementation.
- Server-rendered PDF is desired, but production safety on the shared droplet is more important than forcing Puppeteer into the first release.

