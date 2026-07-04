# 2026-07-04 - Birds Places API Import Plan

## Summary

Plan for the cross-app effort covering:

- Birds `td-0b9b6e`: serve an authenticated read-only places API for Trips.
- Trips `td-db3f61`: fetch Birds trip places and import them as Trips itinerary places.

Keep Birds as the provider of birding trip stops and Trips as the owner of travel itinerary data. The first implementation should import normalized Birds stops into Trips itinerary items after review. Do not build durable cross-app linking in this pass unless a concrete need appears during implementation.

Correction from schema review: the Trips destination is the existing `itinerary_items` table with `item_type='place'`. Do not add a standalone `saved_places` table for this work. `itinerary_items` is still trip-scoped (`trip_id NOT NULL`), so the import workflow needs an explicit destination trip and optional parent item; it should not assume the currently open trip is always the desired destination.

Birds follow-up `td-4ce4cb` was deleted after this plan was first drafted. The current P2 pair supersedes that reverse-direction idea.

CC6 hostile review update: the original plan missed a blocking Birds hook issue. Birds `src/hooks.server.ts` currently treats only exact `/login` and `/api/health` paths as public. A Trips server-to-server request carrying only a bearer token would be redirected or rejected before the new route handler could validate the token. The Birds implementation must explicitly allow the internal places endpoint through the hook first, then do bearer-token authorization inside the route.

## Current Source Context

Birds already has the data needed for export:

- `trips`: user-owned birding trips.
- `trip_stops`: `id`, `trip_id`, `sort_order`, `hotspot_id`, `custom_name`, `lat`, `lon`, `notes`, `target_count_at_save`.
- Later migrations add `trip_stops.google_place_id`, `field_tip`, and `field_tip_generated_at`.
- The app has strict viewer read-only behavior in `src/hooks.server.ts`.
- The same hook currently blocks unauthenticated API paths except `/api/health`; this is a required change for the server-to-server endpoint.
- The app currently exposes only `/api/health` and `/api/geocode`, so this is a new API surface.

Trips already has the right import machinery:

- `itinerary_items`: the existing Trips places/outliner table. It supports `item_type='place'`, `title`, `notes`, `lat`, `lon`, `place_id`, `external_url`, `google_maps_url`, `date`, and `meta JSONB`.
- `itinerary_items.trip_id` is `NOT NULL`, so every imported place must land inside a specific trip.
- `src/lib/server/itinerary-import.ts` validates candidates and inserts them transactionally. Its write-time duplicate filter is private to that module and currently title-based.
- `src/routes/trips/[id]/+page.server.ts` already has `itin-import-candidates`, plus a separate private preview-time `markDuplicates()` helper. The preview and write-time dedupe paths are distinct and both need changes if physical-place dedupe is added.
- `src/routes/trips/[id]/+page.svelte` already has review-before-import UI for text, Google Maps URL, Apple Maps URL, and photo sources.
- Multi-user work is complete locally: `locals.ownerId` scopes the current Trips account, and viewers are blocked from imports by the existing write guard.

## Design Choice

Use a server-to-server token, not Birds browser cookies.

Trips will call Birds from the Trips server process. A browser session cookie for `birds.gaylon.photos` is not available to `trips.gaylon.photos`, and coupling the import to browser auth would be brittle. Birds should expose a narrowly scoped internal read-only JSON endpoint protected by a shared bearer token.

This token should authorize the integration, not end-user writes. Birds still scopes exported rows to a configured owner/user, and Trips still imports only into a trip owned by the currently authenticated Trips account.

Call path choice:

- Dev default: Trips calls the configured `BIRDS_API_BASE_URL`, likely `http://127.0.0.1:5178` when both dev servers are local.
- Production options:
  - Public route: `https://birds.gaylon.photos/api/internal/trip-places`. This is simpler and parity-friendly, but sends the bearer token through the public hostname/Cloudflare path.
  - Internal route: `http://127.0.0.1:3003/api/internal/trip-places` on the shared droplet. This avoids the public edge for a same-host call, but production config differs from dev.
- Decide this before deploy and document the chosen production `BIRDS_API_BASE_URL` in the deployment notes.

## API Contract

Recommended endpoint:

`GET /api/internal/trip-places`

Headers:

- `Authorization: Bearer <BIRDS_TRIPS_API_TOKEN>`
- `Accept: application/json`

Query parameters:

- `username`: optional only if Birds is configured with a single allowed export username; otherwise required.
- `tripId`: optional, limits export to one Birds trip.
- `includeFieldTips`: optional boolean, default `true`.

Response shape:

```json
{
  "places": [
    {
      "source": "birds",
      "source_id": "birds:trip_stop:123",
      "birds_trip_id": 7,
      "birds_trip_name": "Talbot Islands morning run",
      "birds_trip_start_date": "2026-06-14",
      "birds_trip_end_date": null,
      "stop_id": 123,
      "sort_order": 0,
      "name": "Huguenot Memorial Park",
      "lat": 30.457,
      "lon": -81.411,
      "google_place_id": "ChIJ...",
      "hotspot_id": "L123456",
      "notes": "drive-on beach...",
      "field_tip": "Scope the lagoon edge early...",
      "field_tip_generated_at": "2026-07-02T14:12:00.000Z",
      "target_count_at_save": 5
    }
  ]
}
```

Rules:

- Omit stops without a name or coordinates unless the user explicitly asks to import unlocated notes later.
- Do not synthesize coordinates, dates, IDs, or notes.
- Normalize `name` from `custom_name`; if Birds later has hotspot display names in another table/source, join that only when verified.
- Keep `lat` and `lon` numeric.
- Keep `google_place_id` nullable.
- Treat missing `google_place_id` as normal for older Birds stops; coordinate dedupe must not be optional.
- Never include eBird credentials, API keys, session tokens, encrypted credential blobs, or user password/session data.

## Birds Implementation Plan

1. Start the Birds task.
   - Run `td start td-0b9b6e`.
   - Log the intent with `td log`.

2. Add config.
   - Read from private env:
     - `BIRDS_TRIPS_API_TOKEN`
     - optionally `BIRDS_TRIPS_EXPORT_USERNAME`
   - Add `.env.example` entries with placeholder values only, if that file exists.
   - Missing token should make the endpoint return `503` with a plain configuration error. Invalid token returns `401`.
   - If `BIRDS_TRIPS_EXPORT_USERNAME` is used, validate that it resolves to a normal data-owning user/admin account, not a viewer account. A viewer export target should be an explicit configuration error, not a silent empty export.
   - This first pass intentionally supports one configured Birds export identity. Multi-owner Birds-to-Trips mapping is a non-goal unless the user asks for it.

3. Add server helper.
   - Suggested file: `src/lib/server/trip-places-export.ts`.
   - Query `trips` joined to `trip_stops` for the configured user.
   - Order by `COALESCE(trips.start_date, trips.created_at::date) DESC NULLS LAST`, then trip name/id, then stop `sort_order`, `id`.
   - Validate at the helper boundary:
     - finite lat/lon within valid ranges,
     - non-empty name,
     - max row limit, likely 500 or 1000, with explicit truncation metadata only if needed.
   - Do not hide missing data behind defaults.

4. Add hook carve-out and route.
   - Update Birds `src/hooks.server.ts` so this exact endpoint can reach its handler without a Birds browser session.
   - Keep the carve-out narrow. Prefer an exact path check for `/api/internal/trip-places`; do not make all `/api/internal/*` public unless there is a clear reason.
   - The hook carve-out is not authorization. It only lets the route run. The route must still require the bearer token before any data query.
   - Suggested file: `src/routes/api/internal/trip-places/+server.ts`.
   - Implement `GET`.
   - Check bearer token before any data query.
   - Return JSON only.
   - This route remains read-only and should not need to bypass the viewer write guard.

5. Add tests.
   - Unit test the helper mapping if the existing test suite can cover it without a DB.
   - Birds currently has no established `+server.ts` route-handler test pattern. If adding route tests would balloon the task, keep automated coverage at the helper/token validation layer and do route verification with `curl`.
   - If route tests are added, keep coverage focused:
     - missing token -> 503 or 401 depending on config state,
     - bad token -> 401,
     - valid token -> only normalized place rows.
     - no session cookie but valid bearer token -> route succeeds, proving the hook carve-out.
   - Do not seed real eBird credentials.

6. Verify Birds.
   - `npm run check`
   - `npm test`
   - `npm run build`
   - Manual `curl` against local dev or test dev server:
     - no session cookie and no token,
     - missing token,
     - bad token,
     - valid token.

## Trips Implementation Plan

1. Start the Trips task.
   - Run `td start td-db3f61`.
   - Log that Birds API is the provider boundary.

2. Add config.
   - Private env:
     - `BIRDS_API_BASE_URL`
     - `BIRDS_API_TOKEN`
     - optionally `BIRDS_API_USERNAME`
   - Missing config should produce an explicit disabled/unavailable message in the import UI, not a silent empty list.
   - Do not expose the token to client-side code.
   - For production, choose either the public Birds URL or same-host internal URL before deploy; see the design section above.

3. Add Birds client.
   - Suggested file: `src/lib/server/birds-places.ts`.
   - Fetch from `${BIRDS_API_BASE_URL}/api/internal/trip-places`.
   - Follow local server-fetch style: prefer `AbortSignal.timeout(...)` as used by existing server HTTP helpers unless runtime support blocks it.
   - Validate the JSON response shape before mapping it.
   - Treat non-2xx as a user-visible fetch failure.
   - Never log token or full response bodies if they could include notes.

4. Map Birds places to existing import candidates.
   - Extend `ItineraryImportCandidate` and the prepared item path to support optional `meta`, then convert each Birds place to:
     - `item_type: 'place'`
     - `title: place.name`
     - `lat: place.lat`
     - `lon: place.lon`
     - `place_id: place.google_place_id`
     - `meta`: `{ source_app: 'birds', source_id, birds_trip_id, birds_stop_id, birds_hotspot_id }`
     - `notes`: combine useful source context without overstuffing:
       - Birds trip name/date,
       - Birds notes,
       - field tip when present,
       - hotspot id and target count when present.
   - Keep `external_url` null in the first pass unless Birds has a verified in-app URL format worth exposing.
   - Set `location_query` only if needed; with coordinates present, avoid unnecessary geocoding.
   - Use existing `itinerary_items.meta JSONB`; no DB migration is needed for source metadata. This is worth doing now because it gives future duplicate/re-sync logic a machine-readable link back to the Birds stop instead of relying on notes text.

5. Add a destination-aware Trips import path.
   - The destination is `itinerary_items`, not a new table.
   - Because `itinerary_items.trip_id` is required, the UI/action must choose a destination trip:
     - from an existing trip detail page, default to the current trip;
     - from any global import entry point, show a trip picker first;
     - for a future trip, create the trip first, then import into it.
   - Suggested implementation options:
     - **Smallest path:** add `itin-fetch-birds` to `src/routes/trips/[id]/+page.server.ts`, reusing the existing trip detail import flow and current trip as the destination.
     - **Better path:** add a global Birds import route such as `/trips/import/birds` that lists owner-scoped trips, lets the user choose the destination trip and optional parent day/section, then reuses the same candidate review/import machinery.
   - The action should:
     - verify the selected trip belongs to `locals.ownerId`,
     - reject viewer writes through the existing hook before action runs,
     - fetch Birds places,
     - return candidates marked for duplicate hints for that destination trip.
   - Existing preview-time `markDuplicates()` is private to `src/routes/trips/[id]/+page.server.ts` and title-based only. For this source, add physical duplicate hints there too:
     - same `place_id`,
     - same `meta.source_app/source_id`,
     - or coordinates within roughly 30 meters using the shared haversine helper, not naive lat/lon degree deltas.

6. Reuse the candidate review UI.
   - Add a compact “Import from Birds” control near the current itinerary import accordions when starting from a trip detail page.
   - If adding a global import route, reuse the same review component/state but prepend destination controls:
     - destination trip,
     - optional parent day/section/place within that trip,
     - optional geocode toggle, default off because Birds should provide coordinates.
   - On click, call `?/itin-fetch-birds`.
   - Fill the existing `itinCandidates` state.
   - Preserve existing review affordances:
     - select/deselect,
     - parent day/section selector,
     - import selected,
     - clear candidates after successful import.
   - Keep the UI mobile-first and in the existing style. No toast notifications.

7. Strengthen write-time duplicate protection.
   - Existing `importItineraryCandidates()` filters title duplicates inside the transaction. This is separate from preview `markDuplicates()`.
   - Extend the write-time import module independently, so duplicate prevention does not depend on client preview state.
   - Add duplicate protection for physical/source places:
     - same `place_id`,
     - same `meta.source_app/source_id`,
     - coordinates within 30 meters using `haversineKm`.
   - This is important because repeated imports or double-clicks should not create duplicate stops.
   - Keep the rule general if possible, because it also benefits Google/Apple/photo imports.

8. Add tests.
   - Unit test Birds response validation and mapping.
   - Unit test `ItineraryImportCandidate.meta` preservation through insert.
   - Unit or DB test import duplicate protection by `place_id` and close coordinates.
   - Add DB coverage for duplicate protection by `meta.source_app/source_id` if metadata is implemented.
   - If action tests are already easy in the repo, cover `itin-fetch-birds`; otherwise manual browser QA is acceptable after lower-level coverage.

9. Verify Trips.
   - `npm run check`
   - `npm test`
   - `npm run test:db` if duplicate protection touches DB import behavior.
   - `npm run build`
   - Browser QA on `npm run dev:test`:
     - missing Birds config shows explicit disabled/error state,
     - valid Birds config loads candidates,
     - import under top level,
     - import under a day/section,
     - repeated import skips duplicates,
     - viewer cannot import.

## Deployment Plan

Deploy order should be Birds first, Trips second.

1. Add the shared token to Birds production env.
2. Deploy Birds via `./scripts/deploy-to-DO.sh`.
3. Verify `GET /api/health` and the new internal endpoint from the droplet or local machine with `curl`.
4. Add `BIRDS_API_BASE_URL` and token to Trips production env.
   - If using internal same-host routing, set `BIRDS_API_BASE_URL=http://127.0.0.1:3003`.
   - If using public routing, set `BIRDS_API_BASE_URL=https://birds.gaylon.photos`.
5. Deploy Trips via `./scripts/deploy-to-DO.sh`.
6. Verify live Trips import flow with a small known Birds trip.

Do not deploy manually; both repos require their deploy scripts.

## Open Decisions

1. Endpoint name:
   - Preferred: `/api/internal/trip-places`, because this is a private integration surface.
   - Alternative: `/api/trips/places`, if the user wants it to read like a product API.

2. Export scope:
   - Preferred: one configured Birds username for now.
   - Alternative: require `username` in the query and allow a small env allowlist.
   - Non-goal unless requested: mapping multiple Trips owners to different Birds accounts.

3. Import shape:
   - Preferred: flat list of places imported under the selected Trips parent.
   - Alternative: group candidates by Birds trip as section/day parents. This is more structure but may clutter Trips.

4. Durable source metadata:
   - Preferred: use existing `itinerary_items.meta JSONB` in this pass.
   - Store at least `source_app`, `source_id`, `birds_trip_id`, and `birds_stop_id`.
   - Alternative: add explicit source columns later only if querying/re-syncing by source becomes important.

5. Token lifecycle:
   - Initial implementation can use one static shared token in env.
   - Rotation is manual: update Birds token, update Trips token, restart/deploy both apps.
   - If this endpoint grows beyond personal same-owner use, add token identifiers, a revocation list, or a small integration-token table.

## Non-Goals For This Pass

- No two-way sync.
- No background polling.
- No automatic import without user review.
- No new standalone saved-places table.
- No new source-link migration; use existing `itinerary_items.meta JSONB` for the Birds source link.
- No multi-owner account mapping between Trips users and Birds users in this pass.
- No use of Birds eBird credentials or private eBird data beyond already-saved trip-stop context.
- No implementation of deleted Birds `td-4ce4cb`.

## Acceptance Criteria

Birds:

- Authenticated read-only endpoint returns normalized trip places.
- Missing/bad token handling is explicit.
- The endpoint is reachable without a Birds browser session when the bearer token is valid.
- A viewer account cannot be configured as the Birds export identity without an explicit error.
- No secrets or credential-bearing data are exposed.
- `npm run check`, `npm test`, and `npm run build` pass.

Trips:

- Owner/admin/user can fetch Birds places into the existing itinerary candidate review flow.
- Selected candidates import as itinerary `place` rows with coordinates and Google place IDs when present.
- Imported rows preserve Birds source metadata in `itinerary_items.meta`.
- Import works into a selected destination trip.
- Import works top-level and under a selected day/section/place within that destination trip.
- Duplicate physical/source stops are skipped or flagged consistently in both preview and write-time import.
- Viewer cannot import.
- Missing Birds config or API failure is visible and actionable.
- `npm run check`, relevant tests, and `npm run build` pass.

## Suggested Work Order

1. Birds endpoint and curl proof.
2. Birds hook carve-out proof: valid bearer token reaches route without session cookie.
3. Trips client and mapping tests, including `meta`.
4. Trips write-time import metadata and duplicate protection.
5. Trips action returning candidate preview.
6. Trips UI button/panel integration.
7. End-to-end local QA.
8. Devlog handoff in both repos and `td handoff` for both tasks.

## Implementation Status

Implemented first pass for Birds `td-0b9b6e` and Trips `td-db3f61`.

Birds now exposes `GET /api/internal/trip-places` as a narrow public-hook carve-out that performs its own bearer-token authorization before any data export. The route uses `BIRDS_TRIPS_API_TOKEN`, resolves the export identity from `username` or `BIRDS_TRIPS_EXPORT_USERNAME`, rejects viewer accounts, and returns normalized trip-stop places with source ids, trip context, coordinates, Google place id, notes, target count, and optional field tips.

Trips now has a server-only Birds API client and mapper, a trip-page action named `itin-fetch-birds`, and a small review panel under the existing itinerary import UI. Imported Birds rows are still written to the existing `itinerary_items` table with `item_type='place'`; Birds provenance is stored in `itinerary_items.meta`, not in a new table. Preview-time and write-time duplicate handling now both check fuzzy title, Google place id, Birds source key, and coordinates within 30 meters.

Verification:

- Birds: `npm test -- --run src/lib/server/trip-places-export.test.ts` - passed.
- Birds: `npm run check` - passed, 0 errors/warnings.
- Birds: `npm test` - passed, 10 files / 29 tests.
- Birds: `npm run build` - passed.
- Birds: `git diff --check` - passed.
- Birds route proof on `npm run dev:test` with `BIRDS_TRIPS_API_TOKEN=test-token`:
  - No token: `401 {"error":"Unauthorized"}`.
  - Valid token with no export username: `503 {"error":"Birds export username is required."}`.
- Trips: `npm test -- --run src/lib/server/birds-places.test.ts` - passed.
- Trips: `npm run check` - passed, 0 errors/warnings.
- Trips: `npm run test:db -- --run src/lib/server/itinerary-import.dbtest.ts` - passed, 2 tests.
- Trips: `npm run test:db` - passed, 3 files / 34 tests.
- Trips: `npm test` - passed, 12 files / 88 tests.
- Trips: `npm run build` - passed.
- Trips: `git diff --check` - passed.

Remaining before deploy:

- Add real shared token and export username to Birds env.
- Add real `BIRDS_API_BASE_URL`, token, and optional username to Trips env.
- Decide production base URL: public Birds hostname or same-host loopback.
- Run both deploy scripts and verify the live import with one small Birds trip.

## Env Setup

Configured non-committed integration env values for local test and production without recording token values.

Local test:

- Birds `.env.test`: `BIRDS_TRIPS_API_TOKEN` and `BIRDS_TRIPS_EXPORT_USERNAME=gaylon`.
- Trips `.env.test`: `BIRDS_API_BASE_URL=http://127.0.0.1:5178`, matching `BIRDS_API_TOKEN`, and `BIRDS_API_USERNAME=gaylon`.
- Smoke proof: Birds `npm run dev:test`, then `GET /api/internal/trip-places` with the configured bearer token returned 18 exportable places from `birds_test`.

Production:

- Birds `/opt/birds/.env`: `BIRDS_TRIPS_API_TOKEN` and `BIRDS_TRIPS_EXPORT_USERNAME=gaylon`.
- Trips `/opt/trips/.env`: `BIRDS_API_BASE_URL=http://127.0.0.1:3003`, matching `BIRDS_API_TOKEN`, and `BIRDS_API_USERNAME=gaylon`.
- Chose loopback production routing because both PM2 apps run on the same droplet. Trips will call Birds directly on the droplet instead of routing through Cloudflare/nginx via `https://birds.gaylon.photos`.
- These env changes take effect after the deploy scripts restart/reload the PM2 apps with updated env.

## Exchange Logging

Added token-free structured stdout logging for the data exchange. PM2 captures these lines in the normal Trips and Birds logs.

Trips emits `[birds-places-import]` JSON lines from `src/lib/server/birds-places.ts`:

- `config_error`
- `fetch_start`
- `fetch_error`
- `fetch_failure`
- `invalid_json`
- `invalid_payload`
- `fetch_success`

Birds emits `[trip-places-export]` JSON lines from `src/routes/api/internal/trip-places/+server.ts`:

- `config_error`
- `unauthorized`
- `export_start`
- `export_success`
- `export_config_error`
- `export_error`

Trips generates a `request_id` and sends it as `x-trips-import-request-id`; Birds logs the same id so a single import attempt can be correlated across both PM2 log files.

Local smoke proof:

- Trips logged `fetch_start` and `fetch_success` with `raw_places=18`, `accepted_places=18`, `candidates=18`, `dropped_places=0`.
- Birds logged `export_start` and `export_success` with the same `request_id`, `places=18`, `truncated=false`.

Useful production queries after deploy:

```bash
ssh root@134.199.211.199 'grep "\\[birds-places-import\\]" /var/log/pm2/trips.*.log | tail -100'
ssh root@134.199.211.199 'grep "\\[trip-places-export\\]" /var/log/pm2/birds.*.log | tail -100'
ssh root@134.199.211.199 'grep "REQUEST_ID_HERE" /var/log/pm2/trips.*.log /var/log/pm2/birds.*.log'
```
