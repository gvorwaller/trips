# Day Plans Enhancement Plan

## Context

The Day Plans feature currently offers basic manual stop selection from a dropdown of itinerary places, straight-line (haversine) distance estimates, and manual up/down reordering. The user wants it upgraded to a smart route planner with real driving distances, route optimization, weather awareness, AI-generated visit notes, place search, and intelligent suggestions -- modeled after the birds app's route-building features but adapted for trip planning.

The Maine 2026 trip (Jul 27 - Aug 7, Blue Hill ME) with ~30+ places is the immediate use case.

---

## Phase 0: Prod-to-Test DB Copy Script

**Why**: Need real trip data for testing all these features.

**Create** `scripts/copy-prod-to-test.sh`:
- Calls existing `scripts/backup-pg.sh` to pull a fresh `pg_dump -Fc` from prod (port 5437 on the DO droplet)
- Drops/recreates the test database on local test cluster (port 15437)
- Runs `pg_restore --no-owner --no-privileges` into the test DB
- Runs `scripts/test-db-migrate.sh` to apply any migrations newer than prod
- Reuses `scripts/lib/test-env.sh` safety guards (refuse to run against prod ports)

---

## Phase 1: Database Schema Migration

**Create** `backend/db/migrations/0007_dayplan_enhancements.sql`:

```sql
-- Generic TTL cache for weather forecasts and nearby-places lookups
CREATE TABLE api_cache (
    cache_key  TEXT PRIMARY KEY,
    payload    JSONB NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Driving distance/duration per stop (leg from previous stop to this one)
ALTER TABLE day_plan_stops
    ADD COLUMN drive_km  DOUBLE PRECISION,
    ADD COLUMN drive_min INTEGER;

-- Persisted AI-generated visit notes
ALTER TABLE day_plan_stops
    ADD COLUMN ai_notes TEXT;

GRANT SELECT, INSERT, UPDATE, DELETE ON api_cache TO trips_app;
```

---

## Phase 2: Place Search in Day Plan Builder

**Why**: Currently a flat dropdown of all itinerary places with no filtering.

**Modify** `src/routes/trips/[id]/+page.svelte` (builder section, lines ~1053-1073):
- Add `$state` variable `dayPlanSearch`
- Add `$derived` filtered list that matches on `title.toLowerCase()` (name search)
- Add `<input type="search">` above the `<select>` dropdown
- Replace `dayPlanPlaces` in the `<select>` options with the filtered list
- Apply the same filter pattern to the "Add a place" dropdown in saved plan cards

Client-side only, no server changes. Delivers immediately.

---

## Phase 3: Weather Integration

**Why**: Show forecast for day plan dates so users can plan around weather.

**Create** `src/lib/server/weather.ts`:
- Adapt from `birds/src/lib/server/weather.ts`
- Change UA to `trips.gaylon.photos trip planner (gaylon@vorwaller.net)`
- Change cache table from `ebird_cache` to `api_cache`
- Keep same two-hop NWS logic, `WeatherPeriod`/`WeatherResult` interfaces, 60-min TTL, stale fallback

**Modify** `src/routes/trips/[id]/+page.server.ts`:
- After loading day plans, compute weather for each plan that has stops with coordinates
- Use first stop's `snapshot_lat`/`snapshot_lon` as the weather location
- Match `optional_date` to forecast periods when possible
- Pass weather data alongside day plans via `Promise.allSettled` (never block page load)

**Modify** `src/routes/trips/[id]/+page.svelte`:
- Display weather card in each day plan: temp, forecast text, wind, precip %
- Show 2-3 periods (daytime focus)
- Mark stale cache with indicator
- Hide gracefully when null (non-US, no forecast yet, no date set)

---

## Phase 4: Actual Driving Distances

**Why**: Haversine straight-line distances are misleading ("There is no straight line in Maine").

**Create** `src/lib/route.ts`:
- Adapt from `birds/src/lib/route.ts`
- New function `computeLegDistances(apiKey, stops[])`: calls `DirectionsService.route()` without optimization to get per-leg driving km and minutes
- Uses the `routes` library via `loadGoogleMaps(apiKey, ['routes'])`
- Client-side only (uses browser-restricted API key, no server Directions key needed)

**Add to** `src/lib/geo.ts`:
- `formatDuration(min)`: returns "2 h 40 min" or "45 min"

**Add to** `src/lib/server/dayplans.ts`:
- `bulkUpdateDriving(tripId, legs: {stopId, km, min}[])` -- persist to `drive_km`/`drive_min` columns

**Add action to** `src/routes/trips/[id]/+page.server.ts`:
- `dayplan-set-driving`: receives JSON leg data, calls `bulkUpdateDriving()`

**Modify** `src/routes/trips/[id]/+page.svelte`:
- Show per-leg driving distance/time between stops: "12.3 km, 18 min"
- Show total route distance and time in plan summary
- "Calculate distances" button triggers client-side computation, persists via action
- Fall back to haversine with "(straight-line)" label if Directions fails
- For saved plans, show persisted `drive_km`/`drive_min` on load

---

## Phase 5: Route Optimization ("Maximize Route")

**Why**: Manual up/down reordering is tedious for 5+ stops.

**Modify** `src/lib/route.ts`:
- Add `optimizeDrivingRoute(apiKey, opts)` adapted from birds
- Key difference: user-chosen anchor point (accommodation, any place, or none) instead of birds' "home" concept

**Add to** `src/lib/server/dayplans.ts`:
- `optimizeStopOrder(tripId, planId, originLat?, originLon?)` -- server-side greedy nearest-neighbor fallback using haversine

**Add actions to** `src/routes/trips/[id]/+page.server.ts`:
- `dayplan-set-order`: persist client-computed optimal order
- `dayplan-optimize-fallback`: run server-side nearest-neighbor

**Modify** `src/routes/trips/[id]/+page.svelte`:
- **Anchor picker**: dropdown to choose starting point -- accommodation reservations for that date, any itinerary place, or "no anchor" (uses first stop)
- "Optimize order" button (enabled when 3+ stops with coordinates)
- Tries client-side DirectionsService first, falls back to server action
- After optimization, auto-recalculates driving distances (Phase 4)
- Shows route summary: "Total: 87 km, 1 h 34 min"
- Available in both the builder and saved plan details

---

## Phase 6: AI Notes and Place Suggestions

### 6a. AI-Generated "Conditions and Notes"

**Create** `src/lib/server/ai-notes.ts`:
- Adapt from `birds/src/lib/server/ai-guidance.ts`
- System prompt: trip planning assistant giving short, practical, hedged suggestions per stop -- visit logistics, best time of day, seasonal tips, weather-aware advice
- Same direct-fetch Anthropic API pattern (claude-sonnet-4-6, 1500 max_tokens)
- Input: trip name, stop names/notes, weather data, date
- Output: `Record<number, string>` (stopId to note)

**Add action** `dayplan-ai-notes` to `+page.server.ts`:
- Load stops, weather, trip info
- Call `generateTripNotes()`
- Persist each to `day_plan_stops.ai_notes`

**UI**: "Get visit notes" button per plan, results displayed inline under each stop.

### 6b. Place Suggestions (Both Sources)

**Add** `placesNearby()` to `src/lib/server/geocode.ts`:
- Adapt from `birds/src/lib/server/geocode.ts`
- Google Places Nearby Search API, default 16km radius, `tourist_attraction` type
- Cache results in `api_cache` (60-min TTL)

**Add action** `dayplan-suggest` to `+page.server.ts`:
- **Layer 1 (internal)**: Query itinerary places for this trip that are geographically near the existing stops but not yet in this day plan
- **Layer 2 (external)**: Call `placesNearby()` at the route centroid for external discoveries
- Return both lists, deduplicated

**When adding an external suggestion**: auto-create an `itinerary_item` (place type, with lat/lon/title from Google Places) and then add it as a `day_plan_stop` with snapshot.

### 6c. Enhanced Stop Deletion

**Modify** `dayplan-remove-stop` action:
- After removing, return nearby suggestions (both internal + external)
- UI shows confirmation dialog, then "Nearby alternatives" section with "Add" buttons

### 6d. "Suggest Stops" Button

- Available when 2+ stops exist
- Computes route centroid/bounding box
- Shows internal matches first (itinerary places near the route), then external
- Each suggestion shows name, type, distance from route
- "Add" button creates itinerary item + day plan stop

---

## Dependency Order

```
Phase 0 (DB copy)  ─┐
Phase 1 (Schema)   ─┼── can run in parallel
Phase 2 (Search)   ─┘
         │
Phase 3 (Weather)  ── depends on Phase 1 (api_cache table)
         │
Phase 4 (Driving)  ── depends on Phase 1 (drive_km/drive_min columns)
         │
Phase 5 (Optimize) ── depends on Phase 4 (route.ts module)
         │
Phase 6 (AI+Nearby)── depends on Phase 1 (ai_notes column) + Phase 3 (weather context)
```

**Recommended order**: 0 + 1 + 2 together, then 3, then 4, then 5, then 6.

---

## Key Files to Modify

| File | Changes |
|------|---------|
| `backend/db/migrations/0007_dayplan_enhancements.sql` | New migration (create) |
| `src/lib/server/weather.ts` | Weather module (create, adapt from birds) |
| `src/lib/server/ai-notes.ts` | AI notes module (create, adapt from birds) |
| `src/lib/route.ts` | Client-side driving distances + optimization (create, adapt from birds) |
| `src/lib/server/dayplans.ts` | Add driving persistence, AI notes persistence, optimize fallback |
| `src/lib/server/geocode.ts` | Add `placesNearby()` function |
| `src/lib/geo.ts` | Add `formatDuration()` |
| `src/routes/trips/[id]/+page.server.ts` | New actions: driving, optimize, AI notes, suggest |
| `src/routes/trips/[id]/+page.svelte` | Search filter, weather display, driving distances, optimize button + anchor picker, AI notes display, suggestions UI |
| `scripts/copy-prod-to-test.sh` | Prod-to-test copy script (create) |

## Reusable Code from Birds

| Feature | Birds file | Adaptation needed |
|---------|-----------|-------------------|
| Weather | `birds/src/lib/server/weather.ts` | Change UA, cache table name |
| AI notes | `birds/src/lib/server/ai-guidance.ts` | New system prompt for trips context |
| Route optimize | `birds/src/lib/route.ts` | User-chosen anchor instead of home |
| Nearby places | `birds/src/lib/server/geocode.ts` (`placesNearby`) | Same API, different default keywords |
| Duration format | `birds/src/lib/route.ts` line ~97 | Direct copy |

## Google API Requirements

Verify these are enabled in the gaylonphotos GCP project:
- **Directions API** -- needed for driving distances + route optimization (likely already enabled for birds)
- **Places API** -- needed for nearby suggestions (verify)
- Maps JavaScript API and Geocoding API are already confirmed working

## Verification Plan

1. Run `scripts/copy-prod-to-test.sh` to get real Maine 2026 data
2. Start dev server, open Maine 2026 trip
3. Test place search filter: type partial name, verify dropdown filters
4. Build a day plan with 4-5 stops, verify weather loads for plan date
5. Click "Calculate distances" -- verify real driving km/min appear (not straight-line)
6. Click "Optimize order" with an anchor point -- verify stops reorder, distances recalculate
7. Click "Get visit notes" -- verify AI notes appear per stop
8. Click "Suggest stops" -- verify internal itinerary matches appear first, then external Google Places results
9. Remove a stop -- verify nearby alternatives are shown
10. Add an external suggestion -- verify it creates an itinerary item AND a day plan stop
11. `npm run check` and `npm run build` pass with zero warnings
