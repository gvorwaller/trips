# Plan: day-plan suggestion ranking (P1) + place-date backfill (P1) + duplicate day plan (P2)

Covers td-65f48c, td-e00086, td-5e5e46.
Written 2026-07-30; **amended 2026-08-01** to add td-65f48c and reorder — see "Revision history".

## Context

Three open tracker items. They are independent of each other and all build on patterns that already
exist in the repo.

**td-65f48c (P1) — "Sort suggested places by proximity to other stops." Added 2026-08-01.**
The user is *on the trip now* and hit this live: "Suggest stops" returns dozens of places at varying
distances from the planned route, most irrelevant, in no useful order. In their words, what they want
to see is a place that **extends the line from base outward**, or sits **a short way off that line**,
or **fits the loop** — anything that doesn't mean driving all over the region on bad roads.

Those three cases are one metric: **how much driving does adding this place cost me?** Not "how far
is it from something." The right measure is cheapest-insertion detour cost — for a candidate C and
each consecutive route pair (Pᵢ, Pᵢ₊₁), `d(Pᵢ,C) + d(C,Pᵢ₊₁) − d(Pᵢ,Pᵢ₊₁)`, minimised over insertion
positions. A directional extension inserts cheaply on the final edge; a place that fits the loop costs
near zero; a sideways offset *h* from a leg of length *L* costs about **2h²/L** — so a small diversion
off a long drive is nearly free, and only becomes a true out-and-back when the leg is short. One
number, all three cases.

> Corrected during implementation: an earlier draft of this doc said a sideways offset "costs about
> twice the offset." That is wrong by ~5× for a typical leg (2 km off an 11 km leg costs 0.7 km, not
> 4 km) and only holds when *h* is comparable to *L*. The unit tests pin the real relationship.

Three defects in `'dayplan-suggest'` (`src/routes/trips/[id]/+page.server.ts:842-919`) stand in the way:

1. **Distance is measured to the centroid.** `centroidLat/centroidLon` (`:864-865`) is the plain
   average of the route points, and `km <= 30` (`:874`) is a circle around it. On a linear day that's
   the midpoint, so a place 2 km off the road near the start scores ~40 km while a place 30 km
   *perpendicular* off the midpoint scores 30 km and outranks it. The UI labels this "from route"
   (`+page.svelte:1913`, `:1931`) — a promise the math never kept.
2. **Nothing is ever sorted.** `internal` comes back in `listItinerary` order (`parent_id,
   sort_order`); `external` in whatever order Google returned. `distance_km` is computed and rendered
   but never used to order. This is the literal tracker complaint.
3. **The route is measured open, so the drive home is invisible.** `routePoints` (`:855-860`) is
   anchor + stops with no return leg — yet `optimizeDrivingRoute` (`route.ts:156-165`) already models
   an anchored day as a loop, `origin === destination === anchor`. Anything near the way home is
   scored as if that drive didn't exist.

Straight-line distance is also actively misleading in coastal Maine specifically: two points 5 km
apart across a bay are often 45 km by road. So the ranking must end in **real driving minutes**. The
app already consumes Google routing (`src/lib/route.ts`, client-side `DirectionsService`, for
`drive_km`/`drive_min` and route optimisation), but the new scoring runs **server-side against Routes
API v2** — see 1b for why, and for the follow-up that migrates the legacy client helpers separately.

### Measured against the real trip

Prod was cloned to the local test DB (2026-08-01) and pruned to Maine 2026 alone: **95 places, 94 with
coordinates, 7 day plans, all 7 anchored at Blue Hill**, spread over 43.8–45.8 °N / −68.8–−64.6 °E —
about 220 × 330 km, reaching into New Brunswick and Nova Scotia. Scoring every place against each
plan's closed loop gives hard numbers:

All detour figures below are **straight-line (Haversine)**, not road — they characterise the current
bug, they are not the proposed ranking. Counts exclude places already stops in the plan being scored,
matching the live action's `planStopItemIds` filter (`+page.server.ts:871`).

| plan | candidates | shown today (≤30 km of centroid) | of those, straight detour >10 km | cheap (≤10 km) |
|---|---|---|---|---|
| Blue Hill Thursday (11 stops) | 84 | 64 | **51** | 13 |
| Scenic loop (13 stops) | 81 | 56 | **25** | 31 |

Blue Hill Thursday offers **64 candidates of which 13 are worth seeing** — 80% noise. The worst thing
it currently suggests costs 53 km of straight-line detour. That is the "dozens of places, most
irrelevant" complaint, quantified.

Findings that shaped the design:

- **The failure is false positives, not hidden gems.** Zero genuinely-cheap places are excluded by
  today's centroid circle in either plan. The suggester isn't missing things — it's showing ~5× too
  many and not ordering them. So the fix is *suppression and ranking*, not wider coverage. An earlier
  draft proposed fanning `placesNearbyCached` out to 4 sample points along the route to widen the net;
  the data says that adds noise and Google spend for no benefit. **Dropped** — the single existing
  nearby call stays, and gets detour-filtered like everything else.
- **Straight-line detour cannot rank the dense cluster.** For Scenic loop, *every candidate from rank
  5 to rank 27* scores under 1 km. Those differences (0.02 km vs 0.93 km) are below the method's own
  error: the straight chord between two stops is not the road, so a place can be "off the chord" while
  sitting exactly *on* the road. Ordering by that band, then cutting it, is arbitrary. Concretely, a
  12-item shortlist would discard Blue Hill Books (rank 13), Humblebee Cafe (15), Brooklin Village
  (16), Hatch Cove Preserve (17), **Blue Hill Farmers Market (23)**, and Southern Bay Rd (26) — while
  keeping three cemeteries. This is why the two-stage "straight-line shortlist → road refinement"
  design was **abandoned**; see 1a.
- **Loop closure matters, but only for plans that don't already end at base.** Blue Hill Thursday's
  last stop *is* Blue Hill, so closing the loop changes nothing (0 places improve). Scenic loop
  (20 km home leg) improves 17 places and Seal Cove (32 km home leg) improves 21 — several
  dramatically, e.g. Downeast Scenic Railroad 32.8 → 17.7 km straight-line. Worth doing, correct in
  principle, not the headline fix.
- **Cost produces enormous ties.** 22–34 places per plan sit at ~0 detour, because base is Blue Hill
  village and everything in town is free to add. A tiebreak is required — see 1d.

**td-e00086 (P1) — "Add dates to Places created before dates UI upgrade."**
A place's date is a nullable `itinerary_items.date DATE` column (`item_type = 'place'`). Every place
created before commit `e31192f` — and every place created by `itin-add`, paste, or the Birds import,
which *still* never set a date — is undated, so it never appears on the Places schedule report at
`/trips/[id]/places/schedule`. The only way to date a place today is to expand the collapsed
`<details class="edit">` disclosure on the trip outline, one row at a time. The schedule page already
computes and displays the undated backlog but is entirely read-only, so the user has to bounce back
to the outline for each place. The outcome we want: date (and re-date, and clear) places directly
from the schedule page, one at a time or in bulk.

*Confirmed with the user:* the date stays **optional** — nothing requires a place to have a date.
Out-of-trip-range dates are **warned about, not blocked** (matches the existing "Before trip"/"After
trip" badges and `outsideTripCount`; hard-blocking would break legitimate travel-day entries and
reject rows `duplicateTrip` already copies verbatim).

*What dates are actually for (user, 2026-08-01, mid-trip):* days often get planned the morning of, so
a date on a place is mostly **not** how planning happens. Dates matter for the small set of
**time-anchored commitments** — a farmers' market that only runs Saturday, a Monday-night concert, a
booked dinner. That reframes this task: the bulk assigner is a convenience for tidying the backlog,
but the feature that earns its keep is making a *handful* of fixed-date items impossible to miss. Two
consequences worth weighing before building: the 85-undated backlog is **not** a problem to be
"solved" by dating everything, and a place with a date is closer to a lightweight event than to a
scheduled itinerary row. Ranking this **below task 1** is the right call, and if effort has to be cut,
cut the bulk assigner before the per-place date control.

**td-5e5e46 (P2) — "Copy existing day plan to a new plan."**
Duplicating a day plan under a new name so it can serve as a base to edit. `duplicateTrip` in
`src/lib/server/clone.ts:115-167` already deep-copies day plans + stops as part of a whole-trip
clone; this exposes the same copy for a single plan within one trip.

---

## Task 1 — Rank suggestions by added driving time (td-65f48c)

**Rank by real road time across every insertion point.** The straight-line pass is a coarse
*candidate* filter only — it never orders the shortlist and never picks the insertion edge.

### 1a. Why not "straight-line shortlist → refine top N"

An earlier draft scored candidates straight-line, kept 12, then refined those with per-candidate
Directions calls inserted at the straight-line-chosen edge. Peer review (CODEX1) refuted it against
this trip's real road data, and the repo data confirms it:

- **It refines the wrong edge.** Straight-line puts Southern Bay Rd on the `Sandy Point → base`
  closing edge; by road it belongs between Caterpillar Hill Overlook and Compass Rose Books. Fixing
  the edge from straight-line means the "real driving" stage never computes cheapest road insertion at
  all — it prices one arbitrary slot.
- **It cuts the wrong candidates.** Southern Bay Rd is straight-line rank 26 (0.933 km) yet costs
  **0.0 min by road**. Blue Hill Books, Humblebee Cafe, Brooklin Village and Hatch Cove Preserve are
  all road-cheap and all fall outside a 12-item straight-line shortlist.
- So the refinement stage cannot deliver the coastal-correctness the design claims. Prefiltering on
  the metric we've established is unreliable, then declaring the result road-accurate, is
  self-defeating.

**Therefore: road-score all candidates against all edges before any cap.** If API budget ever forces a
prefilter, it must be labelled a lossy heuristic and set far wider (≥30), never presented as exact.

### 1b. Road scoring via Route Matrix — server-side REST, not the browser

Cheapest road insertion needs, for every candidate C and every route vertex pair (Pᵢ, Pᵢ₊₁):
`t(Pᵢ→C)`, `t(C→Pᵢ₊₁)`, and the baseline `t(Pᵢ→Pᵢ₊₁)`. Driving cost is **directed**, so both
rectangular matrices are required, plus the vertex-to-vertex baseline.

**Do this on the server via the Routes API v2 REST endpoint**, not in the browser via the Maps JS
class. This is a change from the earlier draft (which put refinement on the client) and it is the
lower-risk, cheaper, simpler option on every axis:

- **It is the empirically verified path.** CODEX1 executed it against this trip with the repo's
  existing `GOOGLE_GEOCODING_KEY` — the same server key `geocode.ts` already uses — and confirmed the
  key has Routes API access. The JS `RouteMatrix` class is *documentation-verified only*; nobody has
  run it here. Putting an unexecuted API surface on the critical path of an urgent P1 is not worth it.
- **It unlocks `api_cache`.** Matrix results can cache exactly like `placesNearbyCached`
  (`geocode.ts:220-244`). Because `TRAFFIC_UNAWARE` durations are deterministic, the TTL can be long
  (24 h+, not the 1 h used for places) — so re-clicking "Suggest stops" on an unchanged plan costs
  **zero** Google elements. Key on a hash of (ordered route coords, sorted candidate coords,
  travelMode); adding or reordering a stop naturally invalidates it.
- **It removes an entire class of UI complexity.** No async refinement, so no generation guard for
  stale responses, no per-candidate partial-failure states — the action returns one fully-ranked list.
- **Progressive rendering would actively mislead here.** Showing straight-line order first and
  re-sorting on arrival sounds responsive, but §1a established that straight-line ordering in the
  dense band is *noise*. That would shuffle the list under the user's finger and show a wrong answer
  first. Better to wait ~1–2 s and be right once.

Verified request shape (executed against trip 10, 2026-08-01):

```
POST https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix
X-Goog-Api-Key: <GOOGLE_GEOCODING_KEY>
X-Goog-FieldMask: originIndex,destinationIndex,duration,distanceMeters,condition,status
{ origins:      [{waypoint:{location:{latLng:{latitude,longitude}}}}, …],
  destinations: [ …same… ],
  travelMode: "DRIVE", routingPreference: "TRAFFIC_UNAWARE" }
```

Three calls per uncached scoring pass; measured for Scenic loop (R=14 vertices, C=31 candidates):

| call | shape | elements |
|---|---|---|
| vertices → candidates | 14 × 31 | 434 |
| candidates → vertices | 31 × 14 | 434 |
| vertices → vertices (baseline) | 14 × 14 | 196 |
| | **total** | **1064** |

Billing is **per element**, not per request — so don't "optimise" by merging calls. The lever is
keeping C small via the pre-road geographic filter, and the `api_cache` hit rate. `TRAFFIC_UNAWARE`
stays in the cheaper tier and avoids the tighter optimal-traffic element cap.

Compute `addedMin = min over edges of (t(Pᵢ→C) + t(C→Pᵢ₊₁) − t(Pᵢ→Pᵢ₊₁))`, keeping the **argmin edge**
— that, not the straight-line edge, is what the UI labels "between X and Y". This is precisely the
computation that relocated Southern Bay Rd from the `Sandy Point → base` edge to
`Caterpillar Hill → Compass Rose`.

> **Status of the JS alternative:** `google.maps.routes.RouteMatrix.computeRouteMatrix()` (from
> `loadGoogleMaps(key, ['routes'])`) is confirmed against current official Google docs but **not
> executed in this repo**. Recorded here only as the fallback if a server-side call proves
> unacceptable; it would require an implementation spike first.

**Legacy API generations — deliberately not touched.** `DirectionsService` is deprecated (2026-02-25)
but not scheduled for discontinuation, still receives major-regression fixes, and carries a 12-month
notice commitment. That is runway for a deliberate migration, not grounds to widen this P1. New
suggestion code uses Routes v2 and adds no new `DirectionsService` dependency; `computeLegDistances`
and `optimizeDrivingRoute` stay behind their existing `route.ts` interface. See "Follow-ups" for the
migration ticket and the return-leg defect it must resolve.

### 1c. Rewire `'dayplan-suggest'`

In `src/routes/trips/[id]/+page.server.ts:842-919`:

- Build the polyline with `buildRoutePolyline(anchor, locatedStops)` — anchor first, and **closed back
  to the anchor** when an anchor exists, mirroring `optimizeDrivingRoute` (`route.ts:156-165`). All 7
  of this trip's plans are anchored, so the closed form is the norm, not the exception.
- Keep the existing `fail(400, …)` guard for fewer than two located route points.
- Delete the centroid. Geographic prefilter is a wide corridor whose only job is bounding matrix size.
- `external`: keep the **single** `placesNearbyCached` call. Dedupe by `place_id`, keep the existing
  name-dedupe against `internal` + itinerary titles, then score identically to `internal`. External
  results are currently only distance-filtered, which is why "nearby discoveries" is the noisiest part
  of the panel.
- **Detour budget conversion — the earlier draft was wrong.** `addedKm` is already *net* added
  distance (`d(P,C)+d(C,Q)−d(P,Q)`), so at ~60 km/h a 30-minute budget is ~30 added km, **not 15**.
  The previous "× 60 ÷ 2" halved the bound and created false negatives before scoring. Once road
  minutes exist the budget is enforced directly in minutes; the km bound is only the coarse pre-road
  corridor and should be generous.
- Return per candidate: `addedMin`, the argmin edge's neighbouring stop titles, `scheduledIn` (the
  title of another day plan that already contains it, if any), and whether its `date` matches the
  plan's `optional_date`.

### 1d. Ranking and tiebreaks

Primary key is `addedMin`. Because a large cluster ties near zero:

1. **Bucket `addedMin` to ~3 minutes.** (Not 0.5 km — km buckets are meaningless once minutes exist.)
2. **Date relevance first within a bucket.** A place whose `date` equals the plan's `optional_date`
   outranks undated candidates. This is the case the user actually cares about — Blue Hill Farmers
   Market is straight-line rank 23 today and would be dropped by any shortlist, yet on a Saturday plan
   it is the single most relevant suggestion on the list. This is where td-e00086's dates earn their
   keep, and it is the concrete link between the two tasks.
3. **Already scheduled in another day plan → stays inline, with an "in <plan>" badge.** No demotion,
   no separate section. CODEX1 recommended segregating these to protect scarce slots; the trip data
   overrules it. Cross-plan reuse is this user's *normal* behaviour: Early Settlers Cemetery is a stop
   in 3 plans, and six more places are in 2 each. Only 29 of 95 places are in any plan, yet 27 of 93
   candidates for Blue Hill Friday are already in another — so segregating would relegate ~29% of the
   list, and specifically the zero-detour Blue Hill village staples that are the most reusable things
   in the trip. Plans also get built the morning of and abandoned, so membership in a stale plan
   ("Nova Scotia") is not evidence of anything. Show the badge as information; let the user decide.

   *User confirmation (2026-08-01):* "I will build a new [day plan] for a new day, but don't want the
   admin overhead of removing it from another. And who knows, maybe we'll go to the same place twice."
   So cross-plan duplication is **intentional**, not mess to be tidied. Verified this already works:
   `assertLocationIsNewToPlan` (`dayplans.ts:114`) is scoped to a single `planId`, and prod data
   confirms it — Early Settlers Cemetery is live in 3 plans. No change needed to the guard; the
   suggester simply must stop hiding what the data model already permits.

   *Scope of that decision — deliberate, do not "fix":* the same place **twice within one plan** stays
   **blocked**, per the user (2026-08-01, asked directly). `assertLocationIsNewToPlan` rejects a repeat
   by itinerary item id, Google place id, or within `DUPLICATE_COORD_KM` (30 m) — that is intended
   behaviour, not an oversight. Cross-plan repeats allowed, in-plan repeats refused. Anyone tempted to
   relax the guard to permit non-adjacent repeats (e.g. a café visited morning and afternoon) should
   raise it as a product question first; it was considered and declined.
4. Nearest-stop straight-line distance — a late, stable tiebreak only. It is largely redundant after
   road insertion and biases toward dense Blue Hill duplicates.
5. Title, for deterministic output.

Do **not** drop candidates within 30 m of a route point on account of
`assertNoDuplicateRoutePoints` (`route.ts:41-52`) — that guard exists for Directions waypoints, and
Route Matrix has no such restriction. Dedupe by itinerary item / place id instead, consistent with
`addStop`'s `sameRouteLocation` logic (`dayplans.ts:92`).

### 1e. UI

`src/routes/trips/[id]/+page.svelte`:

- **Detour budget** `<select>` — "adds under 15 / 30 / 60 min" — beside "Suggest stops"
  (`:1891-1898`), posted as `detour_budget_min` on the `FormData` `fetchSuggestions` (`:960`) already
  builds.
- Rows read `Name — +18 min · between Bass Harbor and base`, from the **road** argmin edge. The
  misleading "from route" label (`:1913`, `:1931`) goes.
- **In-flight guard**: scoring is now a single server round trip, so the elaborate generation-token
  scheme the earlier draft needed is gone. Still discard a response whose plan id or budget no longer
  matches current state, so a double-click or mid-flight budget change can't paint a stale list.
- **Expect ~1–2 s** on an uncached scoring pass (three matrix calls). Disable the button and show a
  busy state; do **not** render a provisional straight-line list underneath, for the reason in 1b.
- **Failure**: if the matrix call fails or the key lacks Routes access, the action returns candidates
  ranked straight-line with an explicit `approximate: true` flag, and the panel says "approx — road
  times unavailable". A per-element `condition`/`status` that comes back unroutable degrades that one
  row to "drive time unavailable" rather than dropping it silently.
- Trimmed lists show "showing best N of M".

### 1f. Tests

New `src/lib/route-detour.test.ts` (vitest, pure — colocated per the `place-schedule.ts` /
`place-schedule.test.ts` precedent):
- a point on an edge → `addedKm` ≈ 0
- a point perpendicular off an edge midpoint → ≈ 2h²/L (cheap on a long leg), rising toward a 2×
  out-and-back only as the leg shortens
- a point just beyond the last stop on the same bearing → cheap, and the argmin edge is the final edge
- `buildRoutePolyline` closes the loop when an anchor exists; a candidate near the return leg scores
  cheap closed and expensive open. Fixture from measured data: Downeast Scenic Railroad, 32.8 km open
  → 17.7 km closed (Seal Cove)
- degenerate route (single point, identical points) → finite, no NaN
- the tiebreak chain is deterministic: equal-minute candidates order by date-match, then unscheduled,
  then nearest-stop, then title — never by input order

The Route Matrix layer is covered by the browser pass, consistent with how `computeLegDistances` is
treated in `route.test.ts`.


## Task 2 — Place-date backfill (td-e00086)

### 2a. Server: a date-only write path

`updateItem` (`src/lib/server/itinerary.ts:118`) is a **full overwrite despite its name** — it sets
`notes`, `external_url`, and `date` unconditionally, so calling it to change only a date would wipe
notes and links. Add dedicated functions in `src/lib/server/itinerary.ts`:

```ts
export async function setItemDate(tripId: number, id: number, date: string | null): Promise<boolean>
// UPDATE itinerary_items SET date = $3, updated_at = NOW()
//  WHERE id = $1 AND trip_id = $2 AND item_type = 'place'

export async function setItemDates(
  tripId: number, ids: number[], date: string | null
): Promise<number[]>   // returns the ids actually updated
```

**Atomicity — the earlier draft's claim was unfounded.** "`withTransaction` + per-row `UPDATE`" does
*not* roll back on a bad id: a cross-trip or non-existent id simply matches zero rows and the good
rows still commit. Use a single statement and verify the result set:

```sql
UPDATE itinerary_items SET date = $3, updated_at = NOW()
 WHERE id = ANY($1::int[]) AND trip_id = $2 AND item_type = 'place'
 RETURNING id
```

Dedupe the requested ids first, then compare the returned set against the request. On mismatch,
throw so the transaction rolls back — a partial bulk assign that reports success is worse than a
failure. The single-item `setItemDate` must likewise have its `false` return checked by the action
rather than assumed.

Both re-scope with `AND trip_id = $2` per the module convention (child modules never see `ownerId`;
the route gates first). The `item_type = 'place'` guard keeps section/day/note rows out of a bulk
form's reach.

### 2b. Shared date helpers — must live in `$lib`, not `$server`

`src/lib/server/place-schedule.ts` has the exact range classifier as a private function (`dateStatus`,
line 49). An earlier draft said to export it and call it from the schedule page's `.svelte` for a
live warning — **that would not build.** SvelteKit hard-blocks `$lib/server/*` imports from client
code; the page would fail at build time, not at runtime.

So: create a client-safe **`src/lib/place-date.ts`** holding the pure logic —

- `dateStatus(date, tripStart, tripEnd)` — moved out of `place-schedule.ts`
- `YMD_RE` and `parsePlaceDate(raw): { date: string | null } | { error: string }` — empty string means
  "clear the date" (valid), garbage is an error

— and have `src/lib/server/place-schedule.ts` import `dateStatus` from it rather than defining its
own. Colocate `src/lib/place-date.test.ts`; leave the existing `place-schedule.test.ts` covering the
grouping behaviour it already tests.

This is the same boundary the rest of the repo respects (`$lib/geo`, `$lib/route`, `$lib/maplinks` are
all client-safe; `$server/*` is never imported by a component).

### 2c. Schedule page becomes editable

`src/routes/trips/[id]/places/schedule/+page.server.ts` currently has only a `load`. Add form actions
(the existing `getTrip(locals.ownerId, tripId)` + 404 already performs the ownership check):

| action | fields | behavior |
|---|---|---|
| `set-date` | `id`, `date` | one place; empty `date` clears it |
| `bulk-set-date` | `date`, repeated `ids` | one date applied to many places via `setItemDates` |

Return `fail(400, { error })` on a malformed date, matching the trip page's `fail` convention. No
range check — out-of-range saves succeed. **Both actions must check the helper's result** — `false`
from `setItemDate`, or a returned-id set that doesn't match the request from `setItemDates` — and
surface a failure. Reporting success on a write that silently matched zero rows is the failure mode
this task exists to avoid.

`src/routes/trips/[id]/places/schedule/+page.svelte`:

- Derive `const isViewer = $derived(data.user?.role === 'viewer')` — same one-liner as
  `src/routes/trips/[id]/+page.svelte:37`; `user` already merges in from the layout load. Wrap every
  new control in `{#if !isViewer}`.
- **Per-place inline date form** on rows in *both* `dateGroups` and `undatedGroups`: an
  `<input type="date">` seeded from `place.date` + Save, plus a Clear button on dated rows. Uses
  `use:enhance` and `invalidateAll()` so the groups re-sort, like the day-plan forms on the trip page.
- **Live range warning**: on input change, call `dateStatus(value, trip.start_date, trip.end_date)`
  imported from **`$lib/place-date`** (not `$server` — see 2b) and render a
  `<span class="range-warning">Before trip</span>` inline, reusing the class and wording already in
  this file (`:22-26`, `:94-96`). Advisory only; the save proceeds.
- **Bulk assigner** in the "Unscheduled places" `<details class="backlog">` (`:128`): a checkbox per
  place, a per-group "select all", one shared date input, and an "Assign date to selected" submit
  posting `bulk-set-date`. Disable the submit until at least one box is checked and a date is set.
- Errors render as `<p class="field-error" role="alert">` — the established no-toast pattern
  (`+page.svelte:2007`). No modal: these are non-destructive edits.
- Add the new controls to the page's existing `@media print` block so the printed schedule stays
  clean, mirroring `.places-schedule-btn` in `src/app.css:694`.

### 2d. Two small gaps closed on the way

- **`/trips/[id]/place/[itemId]` (the dedicated place workspace) has no date control at all.** The
  tracker item asks for "a date picker in the place edit view"; the trip-page disclosure has one but
  the workspace doesn't. Add a date field + save action there wired to `setItemDate`.
- **The `itin-edit` action (`src/routes/trips/[id]/+page.server.ts:607-628`) doesn't validate the
  date** — it passes the raw string through and relies on Postgres to reject garbage, unlike the
  day-plan actions which use `optDate()`. Route it through the new `parsePlaceDate` so a bad value
  returns a clean `fail` instead of a 500.

Out of scope for this task: giving `itin-add` / paste / import a date field. But note the tension
CODEX1 raised — those paths *still* create undated places, so a pure backfill leaves the source of the
problem open. Since the user's actual need is a handful of time-anchored items rather than universal
coverage, that's an acceptable split, but **open a follow-up tracker item** rather than leaving it
implicit.

---

## Task 3 — Duplicate a day plan (td-5e5e46)

### 3a. Server

New function in `src/lib/server/dayplans.ts`, directly modeled on `clone.ts:115-167`:

```ts
export async function duplicateDayPlan(
  tripId: number, planId: number, title: string
): Promise<number | null>
```

Inside one `withTransaction`:
1. `SELECT title, notes, optional_date, anchor_source, anchor_title, anchor_lat, anchor_lon
   FROM day_plans WHERE id = $1 AND trip_id = $2` → return `null` if no row (mirrors the
   `assertPlanInTrip` scoping at `dayplans.ts:214` and `duplicateTrip`'s null-on-not-owned contract).
2. `INSERT INTO day_plans (...) RETURNING id` with the caller's `title` and the source's `notes`,
   `optional_date`, and **all four anchor columns together** — the `day_plans_anchor_complete` CHECK
   (`0009_day_plan_anchor.sql:10`) is all-or-nothing. Anchor ids (`place:<id>` / `res:<id>`) stay
   valid because this is the same trip.
3. One `INSERT … SELECT` for the stops:
   ```sql
   INSERT INTO day_plan_stops (day_plan_id, itinerary_item_id, sort_order, notes, visited,
                               snapshot_title, snapshot_lat, snapshot_lon, snapshot_place_id)
   SELECT $1, itinerary_item_id, sort_order, notes, FALSE,
          snapshot_title, snapshot_lat, snapshot_lon, snapshot_place_id
     FROM day_plan_stops WHERE day_plan_id = $2 ORDER BY sort_order, id
   ```
   `itinerary_item_id` copies verbatim — no remapping, unlike `clone.ts`, which only needs `itinMap`
   because it also rebuilds the itinerary in a new trip.

Per the user's decision and `clone.ts`'s existing policy: **`visited` resets to FALSE, and
`drive_km` / `drive_min` / `ai_notes` are deliberately not copied** (drive legs get recomputed, AI
notes regenerated). Copying rows directly deliberately bypasses `insertStop`/`addStop` so the
`DuplicateDayPlanStopError` proximity guard (`dayplans.ts:114`) doesn't re-fire — the source plan is
already valid, same as `clone.ts`.

### 3b. Route action

`src/routes/trips/[id]/+page.server.ts`, new `'dayplan-duplicate'` immediately after `dayplan-edit`
(`:694`), copying that action's shape exactly: `ctx` + `ownTrip`, require a non-empty title,
`.slice(0, 300)` like `dayplan-edit` does, `fail(400, { error: 'Title is required.' })`,
`throw error(404)` when `duplicateDayPlan` returns `null`.

### 3c. UI

`src/routes/trips/[id]/+page.svelte`:

- A `⧉ Duplicate` button in `.dayplan-actions` (`:1690`, next to the existing `✕`), inside the
  existing `{#if !isViewer}`.
- It sets `let pendingDuplicatePlan = $state<{ id: number; title: string } | null>(null)`, which
  opens a small modal reusing the existing `.modal-overlay` / `role="dialog" aria-modal="true"`
  markup and styles at `:3697-3722` and the Escape handler at `:3725`. The existing `pendingDelete`
  modal can't be reused as-is (it hardcodes `class="btn danger"` and has no text input), so this is a
  sibling block, not a refactor of it.
- The modal contains one text input prefilled with `` `${plan.title} (copy)` `` (auto-selected on
  open so typing replaces it) and a Duplicate submit posting `?/dayplan-duplicate` with hidden `id`.
  Not reusing `duplicateTripName` from `src/lib/duplicate-name.ts` — its
  `"Name (copy) 2026-07-30 14:22"` stamp exists to disambiguate unattended trip clones, and here the
  user is naming it themselves.
- `use:enhance` + `invalidateAll()`; failure renders into the modal as
  `<p class="field-error" role="alert">`.
- Return the new plan id from the action so the UI can scroll to and focus the copy — with 7 plans on
  the page a silent insert below the fold reads as "nothing happened.

---

## Verification

**Static (required before every commit, per CLAUDE.md):**
- `npm run check` — svelte-check, 0-warning baseline
- `npm run build`

**Unit (`npm run test`):**
- New `src/lib/route-detour.test.ts` (cases listed in 1e).
- Extended `src/lib/server/place-schedule.test.ts` (exported `dateStatus`, `parsePlaceDate` incl. the
  empty-string-clears case).

**Real DB (`npm run test:db`, `TRIPS_ENV=test`, cluster 15437):**
- New cases in `src/lib/server/dayplans.dbtest.ts`: duplicate preserves stop order; `visited` resets
  to FALSE; `drive_km`/`drive_min`/`ai_notes` come back NULL; all four anchor columns copy together;
  `duplicateDayPlan` returns `null` for a `planId` belonging to another trip.
- New `src/lib/server/itinerary.dbtest.ts` (no such file exists yet): `setItemDate` does **not**
  clobber `notes`/`external_url`; it refuses a `day`/`section`/`note` row; it refuses an id from
  another trip. For `setItemDates`, assert the *specific* failure CODEX1 identified: a batch mixing
  valid ids with one cross-trip id must leave **every** row unchanged, not commit the valid subset.
- New cases in `src/lib/server/isolation.dbtest.ts` mirroring the cross-account refusal at `:182`,
  for both `duplicateDayPlan` and `setItemDate`/`setItemDates`.

**Browser (dev server on 5179 — must be started from the user's own terminal or with an explicit
`ANTHROPIC_API_KEY=` prefix; Claude Code's Bash blanks the key):**
1. **The real test, on a real anchored Maine day plan** (this is the acceptance criterion): hit
   "Suggest stops" and confirm the top results are things you'd actually drive to — a place further
   along the same road out from base, a place a few minutes off it, a place that fits the way home —
   and that the cross-bay places that *look* close on a map but are 45 min around by road have sunk.
   Check the "+N min · between X and Y" line names a slot that makes sense.
2. Set the detour budget to "adds under 15 min" and confirm the list tightens to genuinely on-the-way
   options; widen to 60 and confirm it opens up without reordering the cheap ones.
3. Confirm the loop is being measured: on a plan *with* an anchor, a place near the return leg should
   rank cheap. Temporarily clear the anchor and re-run — it should get noticeably more expensive.
   That difference is `buildRoutePolyline` closing the loop.
4. **Regression fixture from the review**: on Scenic loop, confirm Southern Bay Rd, Blue Hill Books,
   Humblebee Cafe, Brooklin Village and Hatch Cove Preserve all appear — every one is road-cheap and
   every one was discarded by the abandoned straight-line shortlist. If any is missing, the prefilter
   is still too tight.
5. On a Saturday plan, confirm **Blue Hill Farmers Market** ranks above equal-cost undated
   alternatives — that's the date-relevance tiebreak (1d) doing its job, and the whole reason
   td-e00086's dates matter.
6. First click on a plan: confirm three `computeRouteMatrix` calls server-side. **Click again with
   nothing changed: confirm zero Google calls** (`api_cache` hit). Add a stop, click again: confirm
   the cache key changed and calls resume. Track **billable elements**, not request count.
7. Double-click "Suggest stops", then immediately change the budget — confirm no stale list paints.
8. Revoke Routes access on the key (or block the host) — confirm the panel falls back to
   straight-line order explicitly labelled "approx — road times unavailable" rather than emptying.
9. On a trip with known-undated legacy places, open `/trips/[id]/places/schedule` — bulk-check
   several backlog places, assign one date, confirm they move into the correct date group and the
   Dated/Unscheduled counters update.
10. Set a date deliberately outside the trip range — confirm the inline warning appears **and the save
   still succeeds**, landing in a group badged "Before trip"/"After trip".
11. Clear a date on a dated place — confirm it returns to the backlog.
12. Print-preview the schedule page — confirm no edit controls render.
13. Log in as the `viewer` role — confirm every new control is absent and a hand-rolled POST to
   `?/set-date` is rejected by `hooks.server.ts`.
14. Duplicate a day plan that has an anchor, notes, several ordered stops, some marked visited, and
   computed drive legs — confirm the copy has the new name, same stop order, all stops unvisited, no
   drive times, and the anchor intact; confirm the original is untouched.

**Tracker:** `td start` each id before working it; `td review` on completion.

## Order

1. **td-65f48c** — the user is on the trip and blocked on it now. Self-contained: one new pure module
   plus a rewrite of a single action, no schema change, no migration. Ship and deploy this first.
2. **td-5e5e46** — small, with a directly reusable precedent in `clone.ts`.
3. **td-e00086** — largest surface (server helpers + a page converted from read-only to editable +
   two side gaps).

Task 1 and task 3 both touch `+page.server.ts` and `+page.svelte`, but in different regions
(`dayplan-suggest` / `.dayplan-ai-tools` vs. `dayplan-edit` / `.dayplan-actions`), so sequencing them
back to back is low-conflict.

## Revision history

- **2026-07-30** — original: td-e00086 + td-5e5e46.
- **2026-08-01** — added td-65f48c as task 1 and moved it to the front of the order; renumbered the
  original tasks 2 and 3. No change to their content.
- **2026-08-01 (ranking decision)** — resolved the open question in 1d against the trip data:
  already-scheduled-elsewhere places stay **inline with a badge**, not segregated. Overrules CODEX1's
  recommendation; cross-plan reuse is routine here (one place in 3 plans, six in 2) and segregation
  would relegate ~29% of candidates including the zero-detour village staples.
- **2026-08-01 (peer review round 2)** — CODEX1 clarified what it had actually executed: the **REST**
  Routes v2 `computeRouteMatrix` surface, verified live against trip 10 with the repo's existing
  `GOOGLE_GEOCODING_KEY` (3 calls / 1064 elements for Scenic loop); the **JS** `RouteMatrix` class is
  documentation-verified only and has never been run here. On that evidence, road scoring **moved from
  the client to the server** — it is the verified path, it unlocks `api_cache` with a long TTL because
  `TRAFFIC_UNAWARE` is deterministic, and it deletes the generation-guard / partial-failure UI
  complexity the client design needed. Also confirmed: do *not* migrate the legacy `DirectionsService`
  helpers in this patch. Logged two new follow-ups, including a verified pre-existing defect — the
  saved driving total omits the return-to-anchor leg.
- **2026-08-01 (peer review, CODEX1)** — external review against the cloned trip data. **Task 1
  rewritten**: the "straight-line shortlist → refine top 8" design was refuted (it priced each
  candidate at the straight-line-chosen edge, so it never computed cheapest *road* insertion, and it
  cut road-cheap candidates — Southern Bay Rd is straight rank 26 but 0.0 min by road). Now scores all
  candidates against all edges via Route Matrix. Corrected the detour-budget conversion (the "÷ 2" was
  double-counting). Corrected the measured table to exclude existing plan stops (verified: 64/84 and
  56/81, cheap 13 and 31, not 23 and 44). Added generation guards and per-candidate failure isolation.
  **Task 2**: `dateStatus` moved to client-safe `$lib/place-date.ts` — the planned `$server` import
  from a `.svelte` would not have built; bulk update reworked to a single `WHERE id = ANY(...)
  RETURNING` with set comparison, because the claimed atomicity did not hold. **Task 3** approved as
  written, plus returning the new plan id. Rejected: adding a bearing/alignment term to ranking
  (brittle on winding roads, ill-defined on a loop — pure road cost stays primary).
- **2026-08-01 (data pass)** — cloned prod → local test DB, pruned to Maine 2026 (95 places, 7 day
  plans), and scored the real trip. Added the measured baseline table; **dropped** the 4-point
  `placesNearbyCached` fan-out (zero good options are being hidden, so widening was wrong); added the
  tiebreak chain for the ~25 places per plan at 0 km detour; downgraded loop-closure from "biggest
  reason" to "matters on plans that don't already end at base." Task-1 external results now get
  detour-filtered, which they never were.
- **2026-08-01 (later)** — reworked task 1 after the user clarified the goal: rank by *added driving
  time*, not proximity to a line. Closes the route loop back to the anchor, switches the metric to
  cheapest-insertion detour cost, and adds a real-Directions second stage so coastal Maine road
  geometry is reflected. Module renamed `route-proximity` → `route-detour`; corridor-width control
  became a detour-minutes budget.

## Implementation outcome (td-65f48c, 2026-08-01)

Built and browser-QA'd by peer CODEX against the cloned trip. **Approved.** Notes worth keeping:

- **Live API shape differed from the docs in three ways** that would have broken a naive
  implementation: matrix elements arrive **out of order** (index by `originIndex`/`destinationIndex`);
  `distanceMeters` is **omitted when zero** rather than sent as 0; `duration` is a string (`"1244s"`).
  Costs are genuinely asymmetric (A→B 1244 s vs B→A 1234 s), confirming both rectangular matrices are
  required rather than merely prudent.
- **Two defects found only in the browser**, neither visible to static review or the scripted harness:
  anchor exclusion by route-proximity missed lodging on plans anchored elsewhere (now excludes every
  `place:<id>` anchor trip-wide); and a budget change dropped the in-flight response but left stale
  rows painted under the new label (now clears and refetches).
- **Zero-cost rows read "on the way", not "+0 min"** — deliberate, confirmed by peer review.
- **Internal and external suggestions are separately sorted sections**, so a +1 discovery can sit below
  a +2 saved place. Deliberate: user-curated places take precedence, and the section labels make the
  ranking reset legible. Do not "fix" this into one merged list without a product decision.
- **Measured cost distribution** (Blue Hill Thursday): on-the-way ×5, +1 ×2, +2 ×2, then nothing until
  +19 and up. The trip is a tight village cluster plus a distant tier, which is why the 15/30/60
  budget steps land usefully — 15 min yields 9 candidates, 30 min yields 19.
- Changing only the budget re-fetches two of three matrices; the vertex-to-vertex baseline stays
  cached because the route is unchanged. Unplanned, but a real efficiency win.

## Follow-ups to open as tracker items

1. **Migrate `computeLegDistances` + `optimizeDrivingRoute` off `DirectionsService`** to Routes v2,
   together. Deliberately excluded from this P1 — the new `Route` class has parity (intermediates
   create legs; `optimizeWaypointOrder` returns `optimizedIntermediateWaypointIndices`), but changing
   two live production flows inside an urgent patch expands regression scope badly. The ticket must
   test: saved leg → `stopId` mapping; loop origin/destination behaviour; waypoint-optimisation index
   mapping; duplicate-point and unlocated-stop handling; billing category for 11+ intermediates;
   browser failure fallback.
2. **The saved driving total omits the drive home.** Verified in this repo:
   `computeLegDistances` (`route.ts:100-101`) sets `origin = anchor`, `destination = last stop` — no
   return leg — while `optimizeDrivingRoute` (`route.ts:157-158`) models an anchored day as
   `anchor → stops → anchor`. So the two disagree, and the driving summary the user reads understates
   every anchored day by the length of the drive home. On this trip that's up to 32 km (Seal Cove).
   This is the same open-vs-closed-loop confusion task 1 fixes in the suggester, and it should be a
   deliberate product decision with tests — not an incidental refactor folded into item 1.
3. **`itin-add` / paste / import still create undated places.** td-e00086 backfills existing rows but
   leaves the source open. Low priority given dates matter only for time-anchored items, but it should
   be explicit rather than implicit.

## Not covered

**td-24721a "Export a day plan" (P1)** was also opened and is *not* in this plan. It overlaps the
Markdown/HTML export piece already described in td-b4ec6a (Phase 5 remainder), which points at
birds' `src/routes/trips/[id]/export/+server.ts` as the model. Worth deciding whether to fold the
day-plan export into that same export route rather than building it standalone.
