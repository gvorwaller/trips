# Day Plan Feature — Comprehensive QA Test Script

## Context

The day plan feature has been finicky in Safari (form submission bugs, date picker issues) even after fixes applied on 2026-06-27. Some features work in Chrome but not Safari. The user wants a complete test script covering every permutation so both humans and Codex agents can systematically exercise every path and identify remaining issues across both browsers.

## Test Environment

- **Dev server**: `npm run dev:test` (port 5179). Keep API keys in `.env.test`; never paste secrets into this script or logs.
- **Test DB**: PostgreSQL port 15437, database `trips_test`
- **Login**: owner `gaylon` / `testpass1234`; viewer `madonna` / `testpass1234` (test DB only)
- **Test trip**: http://127.0.0.1:5179/trips/10 (`Maine 2026`, restored from production; current baseline is 51 places and 0 day plans)
- **Fallback/legacy fixture**: `/trips/2` is not present in the current restored test DB. Do not run this script against `/trips/2` unless a fresh fixture explicitly creates it.
- **Browsers**: in-app Browser/Chrome-equivalent for primary automation, Safari latest macOS for Safari-specific manual/automation checks, plus one mobile-sized viewport for core flows.
- **API keys**: Tests T17-T19/T21 need `PUBLIC_GOOGLE_MAPS_API_KEY`; T22-T23 need `ANTHROPIC_API_KEY`

## Preconditions (all tests)

Logged in as owner at `/trips/10`. Day Plans section expanded. Note starting plan count before beginning. After the full suite, confirm count returns to starting value.

Use a unique title prefix for every test-created plan, for example `QA 2026-06-28T1530 T01 Minimal`. Cleanup must only delete plans with that run prefix. Do not bulk-delete user or restored-prod plans.

Before the first UI test, record:

```sql
SELECT count(*) FROM day_plans WHERE trip_id = 10;
SELECT count(*) FROM day_plan_stops dps
LEFT JOIN day_plans dp ON dps.day_plan_id = dp.id
WHERE dp.id IS NULL;
```

After each group, re-query counts for the run prefix and clean up any test-created plans left behind. After the full suite, confirm the orphan query still returns `0`.

---

## Group A: Builder — Create Paths

### T01: Minimal save (title + 1 stop)
| # | Action | Expected |
|---|--------|----------|
| 1 | Click "Build day" | Builder form opens. Save button disabled, hint "(needs title)" |
| 2 | Type "Test Minimal" in Title | Save hint changes to "(add stops first)" |
| 3 | Select a place from dropdown, click "Add place" | Stop appears in step 3. Save button enabled |
| 4 | Click "Save day" | Builder closes. Plan card "Test Minimal" appears: 1 stop, 0/1 visited, no date |
| 5 | Expand stops details | Stop matches selected place. Visited unchecked. Google link present |

Cleanup: Delete plan. **Browsers: Chrome, Safari**

### T02: Full save (title + date + notes + 3 stops + per-stop note)
| # | Action | Expected |
|---|--------|----------|
| 1 | Click "Build day" | Builder opens |
| 2 | Set title "Full Day Test", date 2026-07-15, notes "Testing all fields" | All populated |
| 3 | Add 3 places individually via dropdown + "Add place" | Step 3 shows 3 stops with up/down/remove buttons |
| 4 | Type "First stop note" in stop 1's notes input | Notes input shows text |
| 5 | Click "Save day" | Card shows "Full Day Test", formatted date, 3 stops, notes. Route summary present if coords exist |
| 6 | Expand stops | All 3 in order. Stop 1 shows "First stop note". Directions link in header |

Cleanup: Delete plan. **Browsers: Chrome, Safari** — Safari: verify date picker works and date is submitted correctly

### T03: Group chip loading
| # | Action | Expected |
|---|--------|----------|
| 1 | Click "Build day" | Group chips visible in step 2 |
| 2 | Click a group chip (note group name + child count) | Title auto-fills with group name. Date fills if group has one. All child places appear as stops |
| 3 | Verify stop count matches group's child count | Counts match |
| 4 | Click "Save day" | Plan saves with group title and correct stop count |

Cleanup: Delete plan. **Browsers: Chrome, Safari**

### T04: Group chip + add individual stop
| # | Action | Expected |
|---|--------|----------|
| 1 | Click "Build day", click a group chip | Group places loaded |
| 2 | Select a place NOT in the group from dropdown, click "Add place" | New stop appended. Count increments |
| 3 | Verify already-added places are disabled in dropdown | Disabled options for existing stops |
| 4 | Save day | Plan saves with total = group children + 1 |

Cleanup: Delete plan. **Browsers: Chrome**

### T05: Duplicate place prevention
| # | Action | Expected |
|---|--------|----------|
| 1 | Builder open with 1+ stops. Note which place is added | Confirmed |
| 2 | Try selecting the same place from dropdown | Option is disabled in dropdown |
| 3 | Click "Add place" with the disabled selection | Nothing happens. Stop list unchanged |

**Browsers: Chrome**

### T06: Reorder stops in builder (up/down)
| # | Action | Expected |
|---|--------|----------|
| 1 | Builder with 3 stops: note order A, B, C | Order confirmed |
| 2 | Click down-arrow on stop A | Order: B, A, C |
| 3 | Click up-arrow on stop C | Order: B, C, A |
| 4 | Verify first stop's up disabled, last stop's down disabled | Boundary buttons disabled |
| 5 | Save day, expand stops | Saved in reordered sequence B, C, A |

Cleanup: Delete plan. **Browsers: Chrome, Safari**

### T07: Remove stops in builder
| # | Action | Expected |
|---|--------|----------|
| 1 | Builder with 3 stops. Click "Remove" on middle stop | 2 stops remain. Count updates |
| 2 | Remove all remaining stops | Step 3 disappears. Save disabled "(add stops first)" |
| 3 | Add 1 stop back, save | Plan saves with 1 stop |

Cleanup: Delete plan. **Browsers: Chrome**

### T08: Filter places search
| # | Action | Expected |
|---|--------|----------|
| 1 | Type part of a known place name in filter field | Dropdown filters to matches only |
| 2 | Clear filter text | All places reappear |
| 3 | Type "zzzxxx" (matches nothing) | Dropdown shows only default "Choose a place..." |

**Browsers: Chrome, Safari**

### T09: Cancel resets state
| # | Action | Expected |
|---|--------|----------|
| 1 | Click "Build day". Fill title, date, notes, add 2 stops | Builder populated |
| 2 | Click "Cancel" | Builder closes. No plan created |
| 3 | Click "Build day" again | Builder opens with all fields empty |

**Browsers: Chrome, Safari**

### T10: Validation — empty title, no stops
| # | Action | Expected |
|---|--------|----------|
| 1 | Leave title empty, add 1 stop | Save disabled: "(needs title)" |
| 2 | Type a title, remove all stops | Save disabled: "(add stops first)" |
| 3 | Set title to spaces only "   ", add 1 stop, click Save | Rejected: HTML5 required or server 400 "Title is required" |

**Browsers: Chrome, Safari**

### T11: Builder optimize route before save
| # | Action | Expected |
|---|--------|----------|
| 1 | Builder with 3+ geocoded stops. Select anchor from dropdown | Anchor selected |
| 2 | Click "Optimize order" | "Working..." shown. Stops reorder. Route summary shows distance/time (API) or straight-line |
| 3 | Save day | Plan saves in optimized order |

Cleanup: Delete plan. **Browsers: Chrome**

---

## Group B: Saved Plan Management

### T12: Toggle visited checkbox
| # | Action | Expected |
|---|--------|----------|
| 1 | Plan with 3 stops, none visited. View card header | "0/3 visited" |
| 2 | Check visited on first stop | Progress: "1/3 visited". Strikethrough on label. No full page reload (PATCH fetch) |
| 3 | Uncheck it | Reverts to "0/3 visited" |
| 4 | Check 2 stops, collapse details | Summary shows "2/3 visited" |
| 5 | Re-expand | 2 stops still checked (server-persisted) |

**Browsers: Chrome, Safari**

### T13: Reorder saved stops
| # | Action | Expected |
|---|--------|----------|
| 1 | Plan with 3 stops: A, B, C. Click down on A | Order: B, A, C. If driving data existed, it's cleared |
| 2 | Click up on C (now last) | Order: B, C, A |
| 3 | Verify boundary buttons disabled | First stop up disabled, last stop down disabled |

**Browsers: Chrome, Safari**

### T14: Remove saved stop
| # | Action | Expected |
|---|--------|----------|
| 1 | Plan with 3 stops. Remove middle stop | 2 stops remain. Count updates |
| 2 | Remove another | 1 stop. "Open directions" link replaced by "Open map" |

**Browsers: Chrome**

### T15: Edit per-stop notes
| # | Action | Expected |
|---|--------|----------|
| 1 | Type "Visit before noon" in stop notes input, click Save | Note text appears as meta div. Input retains text |
| 2 | Clear notes input, click Save | Note text disappears |

**Browsers: Chrome, Safari**

### T16: Delete plan with confirmation modal
| # | Action | Expected |
|---|--------|----------|
| 1 | Click X on plan card | Modal: "Delete this day plan?" with Cancel and Delete |
| 2 | Click "Cancel" | Modal closes, plan still exists |
| 3 | Click X again, press Escape | Modal closes, plan still exists |
| 4 | Click X again, click "Delete" | Plan removed. Count decrements |

**Browsers: Chrome, Safari**

### T17: Directions and map links
| # | Action | Expected |
|---|--------|----------|
| 1 | Plan with 3+ geocoded stops. Click "Open directions" | New tab: Google Maps multi-stop route |
| 2 | Click "Google" on a stop that has `place_id` | New tab: Google Maps opens with a Google place id or place-specific URL, not a bare lat/lng-only coordinate search |
| 3 | Click a "Leg N" link | New tab: Google Maps directions for that segment |
| 4 | Click "Apple" on the same stop | Apple Maps opens the specific place when app/browser handling supports it; URL contains the title/query plus coordinates/place metadata rather than only anonymous coordinates |

**Browsers: Chrome, Safari**

---

## Group C: Route and Distance

### T18: Calculate driving distances (needs Maps API key)
| # | Action | Expected |
|---|--------|----------|
| 1 | Plan with 3+ geocoded stops. Verify straight-line summary | Shows "~X km straight-line" |
| 2 | Click "Calculate distances" | "Working..." state, button disabled |
| 3 | Wait for completion | "Driving distances updated." Real distance/time shown. Per-leg drives between stops |
| 4 | Reorder a stop | Driving data cleared. Reverts to straight-line |

No API key: Step 2 shows "Google Maps key is not configured." **Browsers: Chrome**

### T19: Optimize route (with Maps API key)
| # | Action | Expected |
|---|--------|----------|
| 1 | Plan with 3+ geocoded stops. Note order. Leave anchor "No anchor" | Order noted |
| 2 | Click "Optimize order" | "Working..." -> stops reorder -> "Route optimized and distances updated." Legs populated |

**Browsers: Chrome**

### T20: Optimize route with anchor
| # | Action | Expected |
|---|--------|----------|
| 1 | Open anchor dropdown | Shows "No anchor", accommodation matches (if any), all places |
| 2 | Select an anchor, click "Optimize order" | Optimizes as round-trip from anchor. Order differs from no-anchor optimization |

**Browsers: Chrome**

### T21: Optimize route — fallback (no API key)
| # | Action | Expected |
|---|--------|----------|
| 1 | No Maps API key configured. Click "Optimize order" | Uses server nearest-neighbor fallback |
| 2 | After completion | "Route optimized using straight-line fallback." No driving distances populated |

**Browsers: Chrome**

---

## Group D: AI and Suggestions

### T22: Get visit notes (needs Anthropic API key)
| # | Action | Expected |
|---|--------|----------|
| 1 | Plan with 2+ stops. Click "Get visit notes" | "Generating..." shown |
| 2 | Wait for completion | Each stop shows AI note (1-3 sentences). Persists on reload |
| 3 | Click "Get visit notes" again | Notes regenerated (replaced) |

No API key: Shows error "AI notes are not configured." **Browsers: Chrome**

### T23: Suggest stops + add suggestion
| # | Action | Expected |
|---|--------|----------|
| 1 | Plan with 2+ geocoded stops. Click "Suggest stops" | "Loading..." shown |
| 2 | Wait for completion | Suggestions panel: "From your itinerary" (internal) + "Nearby discoveries" (external). Each shows name, distance, Add button |
| 3 | Click "Add" on internal suggestion | Suggestion disappears. Stop added referencing existing itinerary item. Count increments |
| 4 | Click "Add" on external suggestion | Suggestion disappears. New itinerary place created. Stop added |

**Browsers: Chrome**

### T24: Suggest stops — insufficient data
| # | Action | Expected |
|---|--------|----------|
| 1 | Plan with 0-1 geocoded stops. Observe "Suggest stops" button | Button disabled |

**Browsers: Chrome**

---

## Group E: Edit Saved Plan

### T25: Edit plan metadata
| # | Action | Expected |
|---|--------|----------|
| 1 | Click "edit plan" details on saved plan | Form expands with current title, date, notes |
| 2 | Change title to "Updated", change date, update notes. Click Save | Card shows updated title, new date, updated notes |
| 3 | Clear date and notes, save | Date and notes removed from card |
| 4 | Clear title, click Save | Rejected: required validation |

**Browsers: Chrome, Safari** — Safari: verify date clears correctly

### T26: Add stop to saved plan
| # | Action | Expected |
|---|--------|----------|
| 1 | Scroll to "Add a place" form below stops | Filter input, place dropdown, notes input, "Add stop" button |
| 2 | Filter, select a place, add notes, click "Add stop" | Stop appended to end. Count increments. Driving data cleared |
| 3 | Try submitting with no place selected | HTML5 required prevents submission |

**Browsers: Chrome, Safari**

---

## Group F: Viewer Role

### T27: Viewer — visited toggle only, all else blocked
| # | Action | Expected |
|---|--------|----------|
| 1 | Log in as viewer `madonna`, navigate to `/trips/10` | No "Build day" button |
| 2 | View plan card | No X, no "edit plan", no "Add a place", no Remove, no up/down, no route tools, no AI tools |
| 3 | Check a stop's visited checkbox | Works. Progress updates |
| 4 | Uncheck it | Reverts |
| 5 | (DevTools) POST to `?/dayplan-create` | 403 forbidden |
| 6 | (DevTools) POST to `?/dayplan-delete` | 403 forbidden |

Cleanup: Log back in as owner. **Browsers: Chrome**

---

## Group G: Edge Cases

### T28: Empty state — no plans
| # | Action | Expected |
|---|--------|----------|
| 1 | Delete all plans. View section | "No day plans yet." Badge shows 0. Build day visible |
| 2 | Create a plan | Empty message disappears. Badge: 1 |

**Browsers: Chrome**

### T29: Single-stop plan behaviors
| # | Action | Expected |
|---|--------|----------|
| 1 | Create plan with exactly 1 stop | "Open map" (not directions). 1 stop, 0/1 visited |
| 2 | Click "Open map" | Google Maps for that location |
| 3 | View stops | No up/down arrows. No leg links. Calculate disabled (needs 2+). Optimize disabled (needs 3+) |

Cleanup: Delete plan. **Browsers: Chrome, Safari**

### T30: Stops without coordinates
| # | Action | Expected |
|---|--------|----------|
| 1 | Create plan with 2 geocoded + 1 non-geocoded stop | Straight-line calculated only between geocoded stops |
| 2 | Click "Calculate distances" | Error about missing coordinates |
| 3 | Click "Google" on non-geocoded stop | Name-based Google Maps search opens |

Cleanup: Delete plan. **Browsers: Chrome**

### T31: Multiple plans — ordering
| # | Action | Expected |
|---|--------|----------|
| 1 | Create plans: date 2026-07-10, date 2026-07-12, no date | Order: Jul 10, Jul 12, undated (NULLS LAST) |

Cleanup: Delete all. **Browsers: Chrome**

### T32: Safari form submission regression
| # | Action | Expected |
|---|--------|----------|
| 1 | Safari only. Fill title, date, notes, add 2 stops with per-stop notes | All populated |
| 2 | Click "Save day" (ONE click only) | Plan created with correct title, date, notes, all stops with their notes. Builder closes. This verifies the `formData.set()` fix |
| 3 | Edit the plan's title via "edit plan" form | Edit saves correctly in Safari |

**Browsers: Safari only**

### T33: Section collapse/expand
| # | Action | Expected |
|---|--------|----------|
| 1 | Click Day Plans section header toggle | Section collapses. Caret flips |
| 2 | Click again | Section expands. Plans and Build day reappear |

**Browsers: Chrome, Safari**

---

## Execution Order

1. **Groups A + B first** (core CRUD, both browsers)
2. **Group C** (route — needs Maps API key for T18-T20)
3. **Group D** (AI — needs Anthropic key for T22-T23)
4. **Group E** (edit flows)
5. **Group F** (viewer role — needs viewer account)
6. **Group G** (edge cases, Safari regression)

## Verification

After running the full suite, confirm:
- Plan count for trip 10 returns to its starting value, except for any intentionally retained user-approved diagnostic plans
- No orphaned stops in DB: `SELECT count(*) FROM day_plan_stops dps LEFT JOIN day_plans dp ON dps.day_plan_id = dp.id WHERE dp.id IS NULL` returns 0
- No test-run leftovers: `SELECT id, title FROM day_plans WHERE trip_id = 10 AND title LIKE 'QA <run-prefix>%';` returns no rows after cleanup
- `npm run check` and `npm run build` still pass

## Codex Execution Notes

- Start from a prod-like restored `trips_test` DB. If the DB was restored during the session, log in again; old session cookies may redirect to `/login`.
- Use browser evidence for page identity, nonblank render, framework overlay absence, console health, screenshot, and at least one state-changing interaction per group.
- Use DB evidence to verify persisted titles, dates, stop order, visited state, stop notes, driving fields, and orphan cleanup.
- Treat Maps and AI tests as conditional. If keys are configured, verify the success path. If keys are absent or rejected, verify the explicit error state without treating that as an app regression.
- Prefer stable existing Maine places with coordinates and Google `place_id` for link tests, such as Blue Hill, Bar Harbor, Cadillac Mountain Summit, Harriman Point Preserve, or Caterpillar Hill Overlook.

## Critical Files
- `src/routes/trips/[id]/+page.svelte` — all UI, builder, saved plan interactions
- `src/routes/trips/[id]/+page.server.ts` — all form actions (dayplan-*)
- `src/lib/server/dayplans.ts` — CRUD, reorder, optimize, bulk updates
- `src/routes/api/dayplan/visited/+server.ts` — visited toggle endpoint
- `src/hooks.server.ts` — viewer role enforcement
- `src/lib/route.ts` — Google Maps route optimization and driving distances
- `src/lib/maplinks.ts` — Google Maps link generation
- `src/lib/server/ai-notes.ts` — AI visit note generation
- `src/lib/server/geocode.ts` — Google Places Nearby for suggestions
