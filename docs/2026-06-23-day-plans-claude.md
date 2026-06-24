# Day Plans Implementation Plan

## Context

The trips app organizes researched places in a nested outliner (`itinerary_items`). Users need a way to build focused "what are we doing today?" routes from those places without reparenting or duplicating them. The Grok synthesis doc (`docs/2026-06-23-day-plans-grok.md`) is the authoritative design. This plan implements the MVP scope defined there.

Day plans are a separate object (`day_plans` + `day_plan_stops`) that reference itinerary items by ID, with snapshots for robustness. They surface as lightweight cards in their own collapsible section above Places. The viewer (wife) can see plans and toggle `visited` checkboxes — same exception pattern as packing check-off.

**Decisions confirmed:**
- Rename "Directions for the day" → "Route this group"
- Viewer can toggle `visited` (new exception route)
- "Copy into itinerary" deferred to later
- Day Plans section: own collapsible section above Places

---

## 1. Migration: `backend/db/migrations/0006_day_plans.sql`

```sql
CREATE TABLE day_plans (
    id            SERIAL PRIMARY KEY,
    trip_id       INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    notes         TEXT,
    optional_date DATE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX day_plans_trip_idx ON day_plans(trip_id, optional_date, id);

CREATE TABLE day_plan_stops (
    id                SERIAL PRIMARY KEY,
    day_plan_id       INTEGER NOT NULL REFERENCES day_plans(id) ON DELETE CASCADE,
    itinerary_item_id INTEGER REFERENCES itinerary_items(id) ON DELETE SET NULL,
    sort_order        INTEGER NOT NULL DEFAULT 0,
    notes             TEXT,
    visited           BOOLEAN NOT NULL DEFAULT FALSE,
    snapshot_title    TEXT NOT NULL,
    snapshot_lat      DOUBLE PRECISION,
    snapshot_lon      DOUBLE PRECISION,
    snapshot_place_id TEXT
);
CREATE INDEX day_plan_stops_plan_idx ON day_plan_stops(day_plan_id, sort_order);

-- Grants for the app role
GRANT SELECT, INSERT, UPDATE, DELETE ON day_plans TO trips_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON day_plan_stops TO trips_app;
GRANT USAGE, SELECT ON SEQUENCE day_plans_id_seq TO trips_app;
GRANT USAGE, SELECT ON SEQUENCE day_plan_stops_id_seq TO trips_app;
```

**Design notes vs. Grok doc:**
- Use `id SERIAL PRIMARY KEY` on stops (not composite PK on `day_plan_id, sort_order`) — matches all other tables, gives stable reference for visited toggle API, simpler reordering.
- `snapshot_title` is NOT NULL — always captured at add time.
- Added `snapshot_place_id` for richer fallback map links.

---

## 2. New file: `src/lib/geo.ts`

Copy `haversineKm` and `formatKm` from `/Users/gaylonvorwaller/birds/src/lib/geo.ts`. Used for straight-line distance estimates on day plan cards.

---

## 3. New file: `src/lib/server/dayplans.ts`

Server module for day plan CRUD. Key exports:

```typescript
interface DayPlan { id, trip_id, title, notes, optional_date, created_at, updated_at }
interface DayPlanStop { id, day_plan_id, itinerary_item_id, sort_order, notes, visited, snapshot_title, snapshot_lat, snapshot_lon, snapshot_place_id }

listDayPlans(tripId): DayPlan[]
getDayPlan(tripId, planId): DayPlan | null
createDayPlan(tripId, { title, notes, optional_date, stops: StopInput[] }): number
updateDayPlan(tripId, planId, { title, notes, optional_date }): boolean
deleteDayPlan(tripId, planId): boolean
addStop(tripId, planId, { itinerary_item_id, notes }): number  // appends, captures snapshot
removeStop(tripId, stopId): boolean
reorderStops(tripId, planId, orderedStopIds: number[]): void  // sequential reindex in transaction
updateStopNotes(tripId, stopId, notes: string): boolean
setStopVisited(ownerId, stopId, visited: boolean): boolean  // viewer-safe (joins through trip ownership)
listStopsForTrip(tripId): DayPlanStop[]  // bulk load for page data
```

**Patterns to follow:**
- `withTransaction` for `createDayPlan` (plan row + stops) and `reorderStops`
- Sequential reindex (0..n) like `tree-sql.ts` `applyChanges`
- Snapshot capture: read `itinerary_items` row at insert time, copy title + lat + lon + place_id
- `setStopVisited` joins through `day_plans.trip_id → trips.owner_id` to verify ownership (same pattern as `setPackingItemChecked`)

---

## 4. Extend: `src/lib/maplinks.ts`

Add:

```typescript
// Leg-by-leg directions: returns array of {from, to, url} for consecutive pairs
export function googleLegByLegLinks(places: MapPlace[]): Array<{ from: string; to: string; url: string }> | null

// Day plan directions using snapshot data as fallback
export function dayPlanDirectionsLink(stops: DayPlanStop[]): string | null
// (Converts stops to MapPlace using snapshot fields, delegates to googleDayDirectionsLink)
```

These are pure functions, no new dependencies.

---

## 5. Modify: `src/routes/trips/[id]/+page.server.ts`

### Load function
Add to parallel data loading:
```typescript
listDayPlans(tripId)
listStopsForTrip(tripId)  // all stops for the trip, keyed by plan in the UI
```

Return `dayPlans` and `dayPlanStops` in the page data.

### Form actions (owner-only, all guarded by `if (isViewer) return fail(403, ...)`)

| Action | Purpose |
|--------|---------|
| `dayplan-create` | Title + notes + date + stop IDs → create plan with snapshots |
| `dayplan-edit` | Update title / notes / date |
| `dayplan-delete` | Delete plan (cascades stops) |
| `dayplan-add-stop` | Append a stop to existing plan |
| `dayplan-remove-stop` | Remove a stop |
| `dayplan-reorder` | Reorder stops (receives ordered ID array) |
| `dayplan-stop-notes` | Update per-stop notes |

---

## 6. New file: `src/routes/api/dayplan/visited/+server.ts`

PATCH endpoint for viewer-safe visited toggle. Same pattern as `/api/packing/check/+server.ts`:
- Accept `{ id: number, visited: boolean }`
- Call `setStopVisited(locals.ownerId, id, visited)`
- Return `{ id, visited }`

---

## 7. Modify: `src/hooks.server.ts`

Extend `isViewerAllowedMutation`:
```typescript
function isViewerAllowedMutation(method: string, path: string): boolean {
    if (method !== 'PATCH') return false;
    return path === '/api/packing/check' || path === '/api/dayplan/visited';
}
```

---

## 8. Modify: `src/routes/trips/[id]/+page.svelte`

### 8a. Day Plans section (new collapsible section above Places)

- Header: "Day Plans" with count badge + "Build day" button (owner only)
- Each saved plan renders as a card:
  - Title + optional date
  - Stop count + visited progress ("3/5 visited")
  - Prominent "Open directions" button (chained route link)
  - Expand to show: ordered stop list, per-stop notes, leg-by-leg links, visited checkboxes
  - Owner: edit, delete, reorder stops
  - Viewer: read + directions + visited toggle (fetch PATCH to `/api/dayplan/visited`)
- Collapsible, state persisted to localStorage (same pattern as itinerary/packing)

### 8b. Composer (owner only)

Opens when "Build day" is clicked or "Use these places" from a day/section. Either a `<details>` block or modal-like panel:

- Fields: Title (required), Optional date (DatePicker), Notes
- Place picker: All places from `data.itineraryRows` grouped by parent section. Tap to add. Already-selected items shown with check/de-emphasized.
- Selected stops list: drag/↑↓ reorder, per-stop notes input, remove button
- Live stats: "N stops • ~X km" (haversine sum of consecutive pairs with coords)
- Preview links: "Open as one route" + "Open leg by leg"
- Save button (form action `dayplan-create`)

### 8c. Quick-start from day/section

On day/section rows (owner only), add a small action: "→ Day plan" or a button. Pre-populates the composer with that node's direct child places in current order.

### 8d. Rename "Directions for the day"

Line 744: Change `>Directions for the day</a>` → `>Route this group</a>`
Line 26 of help page: Update the matching description.

---

## 9. Modify: `src/lib/server/clone.ts`

Extend `duplicateTrip` inside the existing transaction:

```typescript
// Day plans + stops
const plans = await client.query(
    `SELECT id, title, notes, optional_date FROM day_plans WHERE trip_id = $1`, [tripId]
);
for (const plan of plans.rows) {
    const newPlan = await client.query<{ id: number }>(
        `INSERT INTO day_plans (trip_id, title, notes, optional_date) VALUES ($1,$2,$3,$4) RETURNING id`,
        [newTripId, plan.title, plan.notes, plan.optional_date]
    );
    const stops = await client.query(
        `SELECT itinerary_item_id, sort_order, notes, snapshot_title, snapshot_lat, snapshot_lon, snapshot_place_id
         FROM day_plan_stops WHERE day_plan_id = $1 ORDER BY sort_order`, [plan.id]
    );
    for (const s of stops.rows) {
        const remappedItemId = s.itinerary_item_id ? (itinMap.get(s.itinerary_item_id) ?? null) : null;
        await client.query(
            `INSERT INTO day_plan_stops (day_plan_id, itinerary_item_id, sort_order, notes, snapshot_title, snapshot_lat, snapshot_lon, snapshot_place_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [newPlan.rows[0].id, remappedItemId, s.sort_order, s.notes, s.snapshot_title, s.snapshot_lat, s.snapshot_lon, s.snapshot_place_id]
        );
    }
}
```

Reset `visited` to FALSE on clone (same as packing `checked`).

---

## 10. Modify: `src/routes/help/+page.svelte`

Add a "Day Plans" section explaining:
- What they are (a saved route through places you've already added)
- How to create (Build day button, or quick-start from a section)
- Per-stop notes and visited tracking
- Directions: one-route vs leg-by-leg
- Viewer access (can see plans + toggle visited)

---

## 11. Print support

In the `@media print` section and the print-expand logic, include day plan cards:
- Title + date + ordered stop list + per-stop notes
- Suppress interactive elements (buttons, checkboxes)
- Compact layout matching existing print density

---

## Implementation Order

1. **Migration + grants** (0006_day_plans.sql) — run via `migrate_pg.sh`
2. **`src/lib/geo.ts`** — haversine utility (copy from birds)
3. **`src/lib/server/dayplans.ts`** — full server module
4. **`src/lib/maplinks.ts`** — add leg-by-leg + day plan helpers
5. **`src/hooks.server.ts`** — viewer exception
6. **`src/routes/api/dayplan/visited/+server.ts`** — PATCH endpoint
7. **`src/routes/trips/[id]/+page.server.ts`** — load + actions
8. **`src/routes/trips/[id]/+page.svelte`** — UI (cards, composer, rename, quick-start)
9. **`src/lib/server/clone.ts`** — extend for day plans
10. **`src/routes/help/+page.svelte`** — docs
11. **Verify** end-to-end

---

## Verification

1. `npm run check` — zero warnings
2. `npm run build` — clean build
3. Run migration on test DB, verify tables + grants with `psql`
4. Browser test (owner):
   - Create a day plan from scratch (Build day → pick places → save)
   - Quick-start from an existing section
   - Verify directions links open correct multi-stop route
   - Verify leg-by-leg links
   - Edit title/notes/date, reorder stops, add/remove stops
   - Delete a day plan
   - Check visited toggles work
   - Verify distance estimate shows for stops with coords
   - Clone trip → verify day plans copied with remapped item IDs
   - Print → verify day plans appear
5. Browser test (viewer):
   - See day plan cards with directions links
   - Toggle visited checkboxes (PATCH succeeds)
   - Cannot create/edit/delete plans (all mutations 403)
6. Edge cases:
   - Day plan survives when a referenced place is deleted (snapshot_title shows, item_id becomes NULL)
   - Plan with 0 coord-bearing stops: no distance shown, directions link uses names
   - Plan with 1 stop: no "Open directions" (needs ≥2), show single-place Google link instead
