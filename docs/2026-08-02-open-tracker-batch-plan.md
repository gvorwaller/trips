# Trips — open tracker batch (2026-08-02)

## Context

**Reviewed by peer CODEX1 on 2026-08-02 (static, read-only).** It returned three
blockers, three high and four medium findings; all are folded in below and
attributed inline as `[CODEX1]`. Two were verified against the code before
acceptance: `setDayPlanAnchor` really does leave driving data stale, and `td`
really does list nine items, not eight.

Nine items are open in `td`. This is an **eight-item batch**; **td-b580a8**
(migrate `computeLegDistances`/`optimizeDrivingRoute` off the deprecated
`DirectionsService`) is deliberately deferred — but note it **collides with
branch A**, which rewrites `computeLegDistances`' request construction. A's new
`vi.mock('$lib/google-maps')` test harness is exactly what td-b580a8 needs, so
land A first and let td-b580a8 inherit the tests rather than writing them twice.

Two of the eight are P1 usability asks the owner filed while
actually using the app mid-trip (day plans collapsed by default; export a day
plan to share). One is a **live wrong number in production** (anchored day plans
understate driving by the drive home). The rest are smaller correctness and
ergonomics items, plus one deferred Phase-5 bucket that this batch partly closes.

Everything except the driving bug is additive. The driving bug is the only thing
users are currently being shown incorrectly, so it goes first — and it also
forces out a shared, testable driving module that the export item then consumes,
which is what keeps the two from drifting apart.

Product decisions settled with the owner:

- **Day Plans**: the section stays open; each *plan card* starts collapsed, state
  remembered per trip.
- **Return leg**: yes — an anchored day is a closed loop; the total includes the
  drive home.
- **Place visited**: the place is the single source of truth; writes propagate
  both ways between a place and its day-plan stops.
- **Export**: no arrival times in v1 (there is no time column and cs.md forbids
  fabricated data); `.ics` is one all-day event per plan.
- **Tap targets**: `cs.md:72`'s ≥48px rule is amended to ≥44px for secondary
  inline controls, ≥48px retained for primary and bottom-nav targets — see F.

---

## Sequence

Serial branches. Five of the six touch `src/routes/trips/[id]/+page.svelte`
(5322 lines) — running them in parallel is a merge-conflict machine.

| # | Branch | Items | Migration |
|---|---|---|---|
| A | `fix/dayplan-return-leg` | td-bf2909 | 0013 |
| B | `feat/dayplan-export` | td-24721a (+ td-b4ec6a export bullet) | — |
| C | `feat/dayplan-collapse` | td-1372a5 | — |
| D | `feat/place-visited` | td-430ffe | 0014 |
| E | `feat/birds-trip-picker` | td-428a1d + td-2092b7 | — |
| F | `chore/tap-target-audit` | td-3b3f5e (+ cs.md rule amendment) | — |

**Dependencies are A→B *and* A→C** — B imports the driving module A extracts, and
C's collapsed plan rows show the same driving summary. `[CODEX1]`

**A, B and C are not disjoint**: all three edit the day-plan card region. The
earlier claim that serial ordering makes the regions independent was wrong. Serial
delivery is still right, but only under an explicit rule: **each branch is cut (or
rebased) from `main` after its predecessor merges** — not six branches cut from
today's `main`. D and E are independent of each other and of A–C. `[CODEX1]`

---

## A — td-bf2909: the drive home (P2, do first)

**Root cause.** `computeLegDistances` (`src/lib/route.ts:100`) sets
`origin = anchor`, `destination = last stop` — an open path. `optimizeDrivingRoute`
(`route.ts:157`) sets `origin = destination = anchor` — a closed loop. The
persisted per-leg values come from the first, so every anchored day's total is
short by the drive home.

Two more paths have the same open-loop bug and must be fixed together, or the
accurate number gets fixed while the estimate stays wrong:
- `routePlaces()` (`+page.svelte:653`) prepends the anchor, never appends it —
  so `routeSummary()`'s straight-line fallback is also open.
- `dayPlanDirectionsLink()` (`src/lib/maplinks.ts:115`) — **leave open-loop**;
  the owner chose the base option, not the round-trip-directions variant. Flag
  this in the devlog as deliberate: the map link ends at the last stop.

**Migration** `backend/db/migrations/0013_dayplan_return_leg.sql`:

```sql
ALTER TABLE day_plans
    ADD COLUMN return_drive_km  DOUBLE PRECISION,
    ADD COLUMN return_drive_min INTEGER,
    ADD CONSTRAINT day_plans_return_leg_complete CHECK (
        (return_drive_km IS NULL AND return_drive_min IS NULL)
        OR (return_drive_km >= 0 AND return_drive_min >= 0 AND anchor_lat IS NOT NULL)
    );
```

Columns on `day_plans`, **not** a sentinel stop row — a sentinel would need
`snapshot_title NOT NULL` and would corrupt `sort_order`, `reorderStops`,
`planProgress`, the visited count, the duplicate-coordinate guard, clone, and
every export. The `anchor_lat IS NOT NULL` clause mirrors the discipline of
`day_plans_anchor_complete` in `0009`. Table-level grants in `0002_grants.sql`
use `ON ALL TABLES` + default privileges, so **new columns need no GRANT**.

**Code**

- `src/lib/route.ts` — `computeLegDistances` returns
  `{ legs: DrivingLeg[]; returnLeg: { km; min } | null }`. When anchored:
  `destination = anchor`, waypoints = **all** located stops (today the last stop
  is the destination). Google then returns `stops.length + 1` legs; legs
  `0..n-1` attribute to stops `0..n-1`, the final leg is the return. Unanchored
  behaviour unchanged, `returnLeg: null`. `assertNoDuplicateRoutePoints` already
  covers anchor-vs-stops.
- **Reject partial Directions responses before attributing any leg.** `[CODEX1]`
  Assert the leg count is **exactly** `n+1` (anchored) or `n-1` (unanchored) and
  throw otherwise. Do **not** `slice`/`pop` whatever Google returns: on a partial
  response that silently misattributes the last available leg as "drive home",
  which is a wrong number wearing the label of the fix. Tests must cover
  wrong-count and empty-legs responses, not just the happy canned one.
- **`setDayPlanAnchor` (`dayplans.ts:372`) must clear driving inside its own
  transaction.** `[CODEX1]` — verified: it updates the four anchor columns and
  never calls `clearDrivingForPlan`. So changing a plan's base from A to B leaves
  the old per-stop legs painted as if they belonged to B. **This is a live bug
  today**, independent of the return columns — the anchor→first-stop leg is
  already stale — and 0013 makes it worse by adding `return_drive_*` to the stale
  set. Add `clearDrivingForPlan` to the anchor transaction and test
  calculate → change anchor → every stop metric and both return columns are NULL.
- `src/lib/server/dayplans.ts:588` — `bulkUpdateDriving(tripId, planId, legs, returnLeg)`.
  Keep the strict `expectedLegStopIds` equality check; add `returnLeg != null`
  **iff** `hasAnchor`, else return false. `clearDrivingForPlan` must also null
  the two new columns. Write them in the same transaction. Add
  `return_drive_km/min` to the `DayPlan` type and to the `listDayPlans` (:195)
  and `getDayPlan` (:206) SELECTs.
- `duplicateDayPlan` (`dayplans.ts:246`) and `clone.ts:122` hand-enumerate
  columns and already drop per-stop `drive_km` / reset `visited`. They must
  **not** copy the return columns — otherwise a duplicated plan shows a
  return-drive total with no legs behind it. Assert in a dbtest.
- `+page.server.ts:790` (`'dayplan-set-driving'`) — parse and validate
  `return_leg` (finite, non-negative) before it reaches SQL.

**Extraction (this is what unblocks B).** Move `persistedDrivingSummary` (:757),
`legSummary` (:773), `routeSummary` (:767) and `routeDistanceKm` out of
`+page.svelte` into a pure `src/lib/dayplan-driving.ts` taking
`(plan, stops, unit)`. They become unit-testable for the first time, and the
export route imports the same functions the page renders.

**UI** — a `Drive home to {anchor.title}` row after the last `<li>` in
`<ol class="dayplan-stops">` (~:1885), styled like the existing `.drive-leg`,
falling back to a `~X straight-line` estimate the way `legSummary` already does
for the anchor→first-stop leg.

**Tests**
- `src/lib/route.test.ts` today only asserts duplicate-coordinate guards, because
  `directionsService()` reaches through `loadGoogleMaps`. Add
  `vi.mock('$lib/google-maps')` with a stub `routes.DirectionsService` that
  records the request and returns canned legs (same style as
  `src/lib/server/anthropic-client.test.ts`). Assert: anchored →
  origin === destination === anchor, waypoints = all stops, `legs.length === stops+1`,
  correct stop attribution, `returnLeg` set; unanchored → origin=first,
  destination=last, `returnLeg: null`.
- While that stub exists, also cover `optimizeDrivingRoute`'s waypoint remap
  (`keptPrefix` + `order.map` + unlocated append). It is untested and it is where
  both td-65f48c and td-bf2909 came from.
- `src/lib/dayplan-driving.test.ts` (new, pure) — totals with/without return,
  partial legs → null, unit formatting.
- `src/lib/server/dayplans.dbtest.ts` — accepts a return leg on anchored plans,
  rejects it on unanchored, clears both on recalculation, duplicate/clone drop it.
- Manual: recalculate the real Seal Cove plan; diff the total against Google's own.

---

## B — td-24721a: export a day plan (P1)

One pure builder, three thin routes, so the web page and an iOS share sheet emit
byte-identical output.

**`src/lib/server/dayplan-export.ts`** (pure — no DB, no fetch):
`buildDayPlanMarkdown(data, opts)`, `buildDayPlanIcs(data, opts)`, plus inline
`slugify`/`fmtDate` adapted from
`/Users/gaylonvorwaller/birds/src/routes/trips/[id]/export/+server.ts` (trips has
no `slugify` today).

**Markdown and plain text are one artifact, not two.** Emit
`Apple: https://…` / `Google: https://…` as bare URLs on their own lines rather
than Markdown `[label](url)`. Rationale: bare URLs are the safest output for
Messages, which is the target surface. Note that "iMessage does not parse
Markdown" is an **empirical** claim — CODEX1 found no Apple contract guaranteeing
that behaviour either way `[CODEX1]` — so the real-iPhone acceptance test below
is what validates this, not the reasoning.

Per stop: index, `snapshot_title`, `notes`, `ai_notes`, the drive leg from
`drive_km`/`drive_min`, and `appleMapsLink` + `googleMapsLink` from
`src/lib/maplinks.ts`. Header: trip name, plan title, `optional_date`, anchor,
and the total driving **imported from `src/lib/dayplan-driving.ts`** so the export
can never disagree with the page.

Units live only in localStorage and are invisible to the server — accept
`?units=mi|km` on the link (the page knows), default `mi`.

**`.ics`** — one all-day `VEVENT` on `optional_date`; `DESCRIPTION` = ordered
stops + links, `LOCATION` = anchor or first stop, `URL` = the directions link.
When `optional_date` is null, return a clear 400 ("Add a date to this day plan
before exporting to Calendar") rather than inventing today. The format details
are the highest-risk pure logic here and get their own test file. Verified
against RFC 5545 (https://www.rfc-editor.org/rfc/rfc5545.html) `[CODEX1]`: CRLF
content lines; fold lines over 75 **octets** with CRLF + one whitespace; TEXT
escapes `\`, `,`, `;` and newline; `DTEND` for a DATE value is **exclusive**, so
date + 1 is right; `VCALENDAR` requires `PRODID` + `VERSION`, `VEVENT` requires
`UID` + `DTSTAMP`. Two corrections to my draft:

- **Fold on UTF-8 byte boundaries without splitting a multi-byte code point**, and
  remember the continuation whitespace itself consumes an octet. Test with
  non-ASCII and emoji place names, not only long ASCII — Maine place names are
  ASCII but nothing enforces that.
- **`DTSTAMP` makes the builder nondeterministic**, which poisons its own unit
  tests. Inject a clock or derive it from `plan.updated_at` (as a UTC DATE-TIME)
  so `buildDayPlanIcs` stays pure. Keep `URL` as a URI property — do **not**
  TEXT-escape it.

Stable `UID = dayplan-{planId}@trips.gaylon.photos`.

**Routes** (each: `locals.ownerId` → `getTrip` → 404 → `getDayPlan` → 404):
- `src/routes/trips/[id]/dayplan/[planId]/export/+server.ts` — `GET ?format=md|txt|ics`.
  `md`/`ics` → `Content-Disposition: attachment`; `txt` → `text/plain; charset=utf-8`
  **inline**, which is the "open on iPhone, select all, paste into Messages" path.
- `src/routes/trips/[id]/dayplan/[planId]/print/{+page.server.ts,+page.svelte}` —
  mirrors `src/routes/trips/[id]/packing/print/` exactly, including its manual
  `🖨 Print` button (that page does not auto-print) and component-scoped
  `@media print`. **This is the PDF answer** — headless rendering stays rejected
  per td-b4ec6a's droplet-memory reasoning.

All three are GET, so `hooks.server.ts` needs no change and the read-only viewer
account gets export for free.

**Server data** — add `listStopsForPlan(tripId, planId)` to
`src/lib/server/dayplans.ts` (one query on `day_plan_stops_plan_idx`) instead of
filtering the whole-trip list.

**Addresses omitted in v1** (nothing persists `formatted_address` today).

**Waypoint cap — my "~9 waypoints" figure was wrong for the path that matters.**
`[CODEX1]` Google's Maps URLs docs give **3 waypoints in mobile browsers**, 9
elsewhere, plus a **2,048-character URL limit**
(https://developers.google.com/maps/documentation/urls/get-started). Since the
whole point of the text export is Safari → Messages on an iPhone, 9 is the wrong
threshold. Warn and fall back when intermediates exceed **3** (or the URL exceeds
2048 chars), and prefer **always** emitting the leg-by-leg links for long routes
rather than relying on unspecified silent truncation. The same correction applies
to the existing on-page `dayPlanDirectionsLink`.

**UI** — an Export control in the day-plan card actions (`+page.svelte` ~:1775,
beside "Open directions"): three plain links — Text / Print / Calendar. No toast.

**Trip-level export is split OUT of B.** `[CODEX1]` My "~80 lines of direct birds
adaptation" was scope creep hiding inside a P1 that asks for *one day's*
itinerary. Trips has nested itinerary and packing trees, day plans, reservations,
attachments and expenses — the draft named only some of them and specified no
hierarchy or visibility semantics. Ship day-plan export first; open a separate
ticket for trip-level export that states exactly which sections are included and
tests the omissions. **Do not close td-b4ec6a's export bullet on B alone.**

**Tests** — `dayplan-export.test.ts` (ordering, missing coords, notes with
newlines, zero-stop plan, units); `dayplan-ics.test.ts` (folding, CRLF, escaping,
UID stability, DTEND, missing-date rejection); two probes added to
`src/lib/server/isolation.dbtest.ts` — B cannot GET A's export, viewer V of A
can. This is a new downloadable data surface. Manual: real iPhone — open the
`txt` URL in Safari and share to Messages; open the `.ics` and confirm Calendar
imports it.

---

## C — td-1372a5: plan cards collapsed by default (P1)

**The representational problem.** `sectionsCollapsed` (`+page.svelte:1462-1484`)
is a `Set<string>` of collapsed names — empty means both "nothing collapsed" and
"nothing saved". "Collapsed by default, but this user expanded it" is
inexpressible. Storing expanded ids instead just inverts the problem.

**`src/lib/collapse-state.ts`** (new, pure) — an explicit tri-state map:
- `type CollapseMap = Record<string, boolean>` — present = the user's explicit
  choice, absent = the default applies
- `parseCollapseState(raw)` accepts the v2 `{v:2, state:{…}}` object **and** the
  legacy bare array (migrating each legacy entry to `true`), so no key rename and
  no stranded garbage
- `serializeCollapseState`, `isCollapsed(map, key, defaultCollapsed)`,
  `toggleCollapse(map, key, defaultCollapsed)`

**Apply to plan cards.** A map at `trips:${id}:dayplanCards` keyed by
`String(plan.id)`, default `true`. **Replace the native
`<details class="dayplan-details" open>` (:1812) with the page's own
`{#if !collapsed}` + toggle button.** Not cosmetic: `<details ontoggle>` fires
during hydration and during programmatic print expansion, so keeping it means
fighting spurious writes; the button pattern already exists six times on this
page and composes with print.

Collapsed rows should carry enough to choose from — title, date, stop count, and
the driving summary from `src/lib/dayplan-driving.ts` (branch A), plus
`planProgress` visited count.

The six `section-toggle` call sites (:1625, 2373, 2901, 3153, 3377, 3487) move to
`isCollapsed(sections, name, false)` in the same pass, so both layers share one
mechanism and flipping a section default later is a one-line change.

**SSR flash** — initialise state to the defaults so server and client hydrate
identically: the server renders plan cards collapsed, and the only post-mount
change is *expansion* for users who saved one. Content appearing, not vanishing —
the cheaper direction. Fully eliminating it needs server-side per-user prefs
(see Ideas).

**`printSheet()` (:1489) is the trap, and my first replacement was also wrong.**
`[CODEX1]` It works today by clearing all three sets, which under a map no longer
means "expanded" — print would silently lose the day plans. But the proposed
`printing` flag had three defects of its own:

1. **It covered only two of four fold systems.** Making the section and day-plan
   predicates `printing`-aware leaves `itinCollapsed` and `packCollapsed` on their
   own `Set` predicates, so collapsed **Places and Packing descendants stay out of
   the print DOM** — the exact regression, just moved. Every fold predicate must
   be printing-aware, or the two legacy `Set`s keep their temporary clearing.
2. **The polarity was ambiguous and dangerous.** Written as `printing || …` where
   the expression means *collapsed*, printing would collapse everything. It must
   be `!printing && isCollapsed(…)`.
3. **It does not fix the race it claimed to fix.** `try/finally` around
   `window.print()` is the same failure as today: if `print()` returns before the
   dialog closes or the snapshot is taken, `finally` re-hides the content
   mid-print. Reset on the **`afterprint` event** (with a guarded timeout
   fallback), not unconditionally in `finally`.

**Acceptance must include collapsed nested Places/Packing descendants**, not just
day-plan cards — that is the case the naive fix passes while still being broken.

**Tests** — `src/lib/collapse-state.test.ts`: legacy array migration, default
fallback, explicit-false round trip, junk JSON tolerance. Manual: a trip with
several plans opens as an index; expand one → reload → still expanded; **print
preview still contains the day plans** (that is the regression to watch).

---

## D — td-430ffe: check off a place from the Places section (P2)

**The first draft of this section did not actually deliver the single source of
truth it claimed.** `[CODEX1]` Two mechanisms broke it, and both are fixed below.

**1. The migration must reconcile, not just add a column.** A bare
`ADD COLUMN … DEFAULT FALSE` defaults every item to false while existing
`day_plan_stops.visited` rows keep their real values — disagreement on day one.
CODEX1 measured the current test DB: 6 visited linked stops vs 5 linked items, 21
itinerary items appearing in more than one plan, and **4 items that already have
conflicting true/false stop copies**. So:

`backend/db/migrations/0014_itinerary_visited.sql`:
```sql
ALTER TABLE itinerary_items ADD COLUMN visited BOOLEAN NOT NULL DEFAULT FALSE;

-- Reconcile: an item counts as visited if any linked stop was checked off.
UPDATE itinerary_items i
   SET visited = TRUE
  FROM day_plan_stops s
 WHERE s.itinerary_item_id = i.id AND s.visited;

-- Then normalise every linked stop to the canonical item value.
-- Orphan stops (itinerary_item_id IS NULL) are deliberately untouched.
UPDATE day_plan_stops s
   SET visited = i.visited
  FROM itinerary_items i
 WHERE s.itinerary_item_id = i.id AND s.visited <> i.visited;
```
`bool_or` semantics: visiting a place once means you visited it. The alternative
(clear on conflict) would silently discard real check-offs.

**2. Propagation must fan out to ALL copies, not just the clicked one.** The
draft said `setStopVisited` "additionally sets the linked item" — but every
*other* stop referencing that item stays stale, which is precisely the
disagreement the design exists to prevent. With 21 multi-plan items in the test
data this is not a corner case. One canonical transactional mutation:

- **Item click** — authorize the item, then update the item **and every**
  `day_plan_stops` row with that `itinerary_item_id`.
- **Stop click** — authorize the stop; if `itinerary_item_id IS NOT NULL`, update
  the item **and all** its stop copies; if orphan, update only that stop.

Stops with `NULL itinerary_item_id` (place deleted after the plan was built) keep
their own flag — no orphan special-casing, which is why this beats a derived
column.

**3. Both visited endpoints parse booleans unsafely.** `body.visited === true`
(`src/routes/api/dayplan/visited/+server.ts:18`) silently coerces `"true"`, `1`,
`null` and typos to **false** — a malformed client request reads as "un-visit"
rather than an error. Require `typeof body.visited === 'boolean'` and 400
otherwise, in the new endpoint **and** the existing dayplan one. `[CODEX1]`

**Server** — `src/lib/server/itinerary.ts`: add `visited` to `SELECT_COLS` (:25)
and the `ItineraryItem` interface, plus an update using the same
ownership-inside-the-UPDATE shape as `setStopVisited`:
```sql
UPDATE itinerary_items i SET visited = $3
  FROM trips t WHERE i.id = $1 AND i.trip_id = t.id AND t.owner_id = $2
```

**Endpoint** — `src/routes/api/itinerary/visited/+server.ts`, `PATCH { id, visited }`,
a near-copy of `src/routes/api/dayplan/visited/+server.ts`.

**Viewer allowlist** — `isViewerAllowedMutation` (`src/hooks.server.ts:27`) gains
the third path. Two doc updates that are binding and easy to miss: the function's
own comment, and cs.md's "Viewer write exceptions" bullet, which currently
enumerates exactly two.

**Client** — `toggleItemVisited(id, visited)` beside `toggleVisited`
(`+page.svelte:1190`); a checkbox on Places tree rows (~:2455) rendered only for
`node.item_type === 'place'` (sections/days/notes aren't visitable), reusing the
day-plan stop's `class:done` strikethrough. Surface it on
`src/routes/trips/[id]/place/[itemId]/+page.svelte` too, and add the new class to
the `@media print` block in `src/app.css:680` alongside `.chk`.

Add an **"X of Y places visited"** roll-up in the Places section header using the
existing `count-badge` pattern — it's the reason the feature exists.

`clone.ts` enumerates itinerary columns explicitly and omits `visited`, so cloned
trips start unvisited by construction. Assert that in a dbtest so a future
column-list edit can't silently break it.

**Tests** — `isolation.dbtest.ts`: clone the existing `setStopVisited` block for
`setItemVisited` (B cannot write A's item; viewer V of A can).
`dayplans.dbtest.ts`: propagation both directions **with the same place in 2+
plans** (assert every copy flips, not just the clicked one), `NULL
itinerary_item_id` stops unaffected, clone resets, malformed `visited` payloads
rejected with 400. Plus a **pre-migration fixture with conflicting true/false
stop copies** asserting the `bool_or` reconciliation resolves it. `[CODEX1]`

---

## E — td-428a1d birds trip picker + td-2092b7 place dates (P2/P3)

Batched: both live in the Places import/add region of `+page.svelte` and both are
about candidate metadata.

### Birds trip dropdown — derive it client-side, no birds change

Every place returned by `/api/internal/trip-places` **already carries**
`birds_trip_id`, `birds_trip_name`, `birds_trip_start_date`, `birds_trip_end_date`;
`birdsPlacesToItineraryCandidates` (`src/lib/server/birds-places.ts`) throws the
grouping away. Adding a `?mode=trips` endpoint on birds is tidier on the wire but
costs a birds deploy, a token/route test, and a version-skew window. Grouping
costs one pure function and zero coordination. Revisit only if payload size makes
the single fetch slow — the 10 s `AbortSignal.timeout` is the canary.

- `src/lib/server/birds-places.ts`: export
  `groupBirdsTrips(places): BirdsTripSummary[]` (`{ id, name, start_date, end_date, placeCount }`,
  sorted by start date desc); `fetchBirdsItineraryCandidates` returns
  `{ candidates, trips, truncated }`.
- `+page.server.ts:576` (`'itin-fetch-birds'`) returns `birdsTrips` alongside
  `candidates`; keep the existing `birds_trip_id` server param (still works,
  still under test).
- `+page.svelte:2697`: username → Fetch → `<select>` of trips (default "All
  trips") → filtered candidate list. Replaces the free-text trip-id input.

**The trap:** `selectedItin()` (:335) walks the entire `itinCandidates` array
regardless of what is rendered, and `withItinSelection` (:301) pre-selects
everything non-duplicate — so filtering *display* only would silently import
hidden rows. Keep the full payload in a separate raw variable and **rebuild**
`itinCandidates = withItinSelection(raw.filter(byTrip))` on every dropdown change.

**Truncation needs a correctness boundary, not a warning.** `[CODEX1]` My draft
said "surface the `truncated` flag", which still permits a partial import: birds
orders whole trips then truncates at the limit, so a truncated payload can omit
entire trips from the dropdown *and* cut one trip mid-list, giving a wrong place
count with no way to detect it client-side. Required:

- Request `limit=5000` (the cap) for the discovery fetch.
- If the response is still `truncated`, **do not allow an "All trips" import**.
  Instead refetch the selected trip scoped by `birds_trip_id` — already supported
  by the existing endpoint — before enabling import. Still no birds deploy.
- Test a truncation boundary that falls *inside* a single trip.

Also decide explicitly: rebuilding `itinCandidates` on every dropdown change
**discards any per-row edits and selections** made before switching trips. That is
probably acceptable for an import flow, but it should be a stated choice rather
than an emergent one. `[CODEX1]`

### td-2092b7 — sources that create undated places

`importItineraryCandidates` (`src/lib/server/itinerary-import.ts:235,246`) already
persists `candidate.date`, so the candidate-review date input is wired end to end.
The gap is purely that no source sets it:

1. **`itin-add`** — add `<input type="date" name="date">` to the add-row form
   (`+page.svelte:2577`), routed through `parsePlaceDate` into `createItem`,
   exactly as `itin-edit` already does (`+page.server.ts:630`). `createItem`
   already accepts `date`.
2. **`itin-paste`** — an optional date applied to all pasted lines:
   `bulkCreate(tripId, parentId, itemType, titles, date)`, one column added to
   the INSERT (`itinerary.ts:97`).
3. **Birds import** — in `birdsPlacesToItineraryCandidates`, set `date` to
   `birds_trip_start_date` **only when start === end** (a genuine single-day
   trip); leave null for ranges rather than guessing a day. Multi-day cases are
   already covered by the per-row date input in the review UI (~:1603).

AI extract paths already emit `date` when the source text has one — nothing to change.

**Tests** — extend `src/lib/server/birds-places.test.ts` (`groupBirdsTrips`
ordering/counts/missing dates; the new `{candidates, trips, truncated}` shape via
mocked fetch; single-day sets date, multi-day leaves null) and
`itinerary-dates.dbtest.ts` (`bulkCreate` with a date, `createItem` via the add path).

---

## F — td-3b3f5e: amend the rule to 44px, then automate the check

**Rule decision (mine to make, and I'm changing it).** `cs.md:72` says ≥48px tap
targets. 48 is Material's number; the authorities that matter for an
iPhone-first personal app both say 44: **WCAG 2.5.5 Target Size (Enhanced, AAA)
is 44×44 CSS px**, and Apple's HIG is 44×44 pt. Since cs.md's stated bar
elsewhere is "WCAG AAA", 48 was never required by the standard the document
claims to follow — I picked the stricter number without a reason, and it has
been generating a P3 ticket instead of accessibility.

Amend `cs.md:72` to:

> ≥44px tap targets (WCAG 2.5.5 AAA / Apple HIG); ≥48px for primary actions,
> bottom-nav items, and any standalone control that isn't inside a dense list row.

Also update the mirrored wording in `CLAUDE.md:26` and `docs/mockups/mockup.css`
so the three don't drift.

**`CLAUDE.md` needs more than the 48→44 tweak.** `[CODEX1]` It still opens with
"**Project status: PLANNING — no app code exists yet**" and "no SvelteKit app, no
`package.json`, no migrations, no source code", and directs agents to read
superseded V1 bootstrap material — for an app that has been live in production
since June. Editing only the tap-target number preserves binding misinformation
that every future session loads first. Either bring `CLAUDE.md` current in F, or
strip the stale status/bootstrap sections and point at `cs.md`, the V3 plan and
`docs/devlog/`.

**Measured evidence** (peer CODEX, browser QA at 390×844 on the day-plan card,
2026-08-02). Controls currently under 44px, all pre-existing:

| Control | Measured |
|---|---|
| Delete plan `✕` | 11 × 21.6 |
| Anchor `<select>` | 298 × 25.5 |
| Google link (`.chip-link`) | 64.3 × 28 |
| Apple link (`.chip-link`) | 55.4 × 28 |
| Move up/down arrows | 30 × 32 |
| Remove stop | 54.8 × 32 |
| Visited checkbox label | 27 or 54 tall (input 22 × 22) |

The 11px-wide delete `✕` is the worst offender and is a destructive action. The
checkbox row confirms the label/wrapper resolution problem: the input is 22px but
the real target is the label, which is sometimes 54 and sometimes 27. Passing:
bottom nav 97.5 × 64, primary actions ≥44.

**What that makes td-3b3f5e.** The ticket's own measurements — "Add" 59.25×44,
"Suggest stops" 134.99×44 — are now *compliant*. So this stops being an app-wide
restyle and becomes: sweep for anything genuinely **below 44px**, and raise the
handful of standalone controls to 48. Check `src/app.css` lines 97, 130, 166,
383 (`.btn.small`), 408 (`.chip`), 610, and the `.line` rows in Places/Packing.
Where a control is under 44 inside a dense row, grow the *hit area* — padding or
an `::after` overlay — not the row height, so long packing/places lists don't get
materially taller on a phone. The `@media print` block (`src/app.css:752`)
already overrides `.line { min-height: 0 !important }`, so print is unaffected.

**The half with lasting value** is `scripts/safari-audit-tap-targets.mjs`
alongside the existing `safari-smoke-place-workspace.mjs` — same
selenium/safaridriver harness, same `TRIPS_ENV=test` guard, same self-provisioned
throwaway fixtures — loading a seeded trip at 390px and printing every violation.

**But as drafted it would have measured the wrong things.** `[CODEX1]` Four
defects, all of which must be resolved in the script's spec *before* it is
written, or it reports failures on correctly-fixed controls and passes broken ones:

- **Label-wrapped checkboxes.** `input[type=checkbox].getBoundingClientRect()` is
  ~22px even when the wrapping `<label>` is the real 44px target — as in
  `.dayplan-visited`. Resolve each checkbox to its label/control wrapper.
- **`::after`-expanded hit areas are invisible to the element's own rect**, so the
  script fails a control immediately after the recommended fix. Either drop
  pseudo-element expansion as a technique, or audit real **hit-test points**
  (`document.elementFromPoint` at the target's corners) instead of DOM rects.
- **The selector misses real controls** — `.chip-link` anchors currently render
  28–32px, and other `a[href]` / `role="button"` elements aren't covered.
  Enumerate all visible buttons, links, inputs, selects and `role=button`, with an
  explicit exclusion list for legitimate inline prose links.
- **Overlapping expanded targets** can leave two controls each nominally 44px but
  ambiguous to tap. Add an overlap check.

That spec is what turns a subjective sweep into a repeatable check.

Still schedule it **last and alone** — global `app.css` edits conflict with every
other branch — but it's now a short branch, not a deferred one.

## td-b4ec6a close-out

After B: the **export** bullet is only *partly* satisfied — day-plan export plus
the print-to-PDF route ship, trip-level export is split to its own ticket, so the
bullet stays open until that lands. `[CODEX1]` Close **PWA offline** as won't-do (the owner's own
assessment; iOS Add-to-Home-Screen covers the install feel, and an offline write
queue with last-write-wins reconciliation is the highest-risk thing on the list).
Close **headless PDF** as won't-do (droplet memory; superseded by the print
route). Record both in `docs/devlog/`.

---

## Ideas worth taking that aren't on the tracker

Folded into the branches above at near-zero marginal cost:

- **Extraction-on-touch, not a page refactor.** `+page.svelte` is 5322 lines and
  most of this batch edits it. Resist a general component split mid-batch;
  extract exactly what these items force out — `dayplan-driving.ts` (A),
  `collapse-state.ts` (C), `dayplan-export.ts` (B). The three most bug-prone
  pieces of logic on the page become unit-testable, and the page shrinks anyway.
- **Test `optimizeDrivingRoute`'s waypoint remap** (A). Two routing bugs
  (td-65f48c, td-bf2909) have now come out of the same untested function.
- **Isolation probes on the new GET export routes** (B) — a new downloadable data
  surface deserves the same treatment the mutating paths get.
- **`printSheet()` → `printing` flag** (C) — required by the collapse change, and
  it removes existing fragility.
- **Waypoint-cap warning** (B) — ~10 lines; the page currently produces silently
  truncated Google Maps links for plans with more than ~9 waypoints.
- **`distanceUnit` is keyed per trip** (`trips:${id}:distanceUnit`, :1272) though
  it is plainly a *user* preference — miles on the phone, km on the laptop, and a
  new trip forgets. Re-key to `trips:distanceUnit`; 5 lines, one-time reset.
- **Visited roll-up in the Places header** (D).

Conditional, not recommended yet:

- **Server-side per-user UI prefs** (`users.prefs JSONB` + a small PATCH). The
  only true fix for the SSR collapse flash, and it would make distance units
  follow the user across devices. ~half a day — do it only if the flash actually
  annoys you once C ships.
- **Persist `formatted_address` on `itinerary_items`.** Google returns it today
  via `place-details.ts` and nothing stores it. It would give `.ics` a real
  `LOCATION` (which is what makes Calendar's Directions button work) and remove a
  round-trip from every place render. Worth it only if you want addresses in
  exports.

Explicitly skipped: `api_cache` eviction (measure first —
`SELECT count(*), pg_size_pretty(pg_total_relation_size('api_cache'))`; likely
imaginary work), and any general CSS/component/ORM refactor.

---

## Verification

Per branch, before every commit (cs.md): `npm run check` (0-warning baseline) and
`npm run build`.

- **A**: `npm run test` (route + dayplan-driving units), `npm run test:db`
  (dayplans dbtest). Then recalculate the real Seal Cove plan in the browser and
  diff the total against Google Maps' own route — the number must now match, and
  the "Drive home" row must appear.
- **B**: unit suites for markdown and ics; `npm run test:db` for the isolation
  probes. Manual on a real iPhone: open `…/export?format=txt` in Safari → share to
  Messages → confirm both map links are tappable; open `…?format=ics` → confirm
  Calendar imports one all-day event. Open the print sub-route → browser print
  preview → save as PDF.
- **C**: `npm run test` (collapse-state). Browser: new trip opens with plan cards
  collapsed; expand one, reload, still expanded; a user with legacy
  `trips:N:sections` data keeps their section state. **Print preview must show the
  day plans AND collapsed nested Places/Packing descendants** — that second half
  is the case a naive fix passes while still being broken.
- **D**: `npm run test:db` (isolation + propagation + the conflicting-copies
  migration fixture). Browser: check a place that sits in **two or more** day
  plans in Places → confirm every copy flips, and back; log in as the viewer
  account and confirm the checkbox works there but nothing else does.
- **E**: `npm run test` + `npm run test:db`. Manual against the live birds
  instance: enter the username, confirm the trip dropdown lists real trips with
  correct counts, pick one, confirm only that trip's places import.
- **F**: `npm run test:safari:tap-targets` (new) must report zero violations, run
  twice in a row to confirm idempotency before it's trusted. Then eyeball the
  Places and Packing lists at 390px to confirm row heights did not grow.

Migrations apply **only** via `backend/db/migrate_pg.sh` — never inline DDL,
never `psql -f`. Test DB first (`npm run test:db:migrate`), then prod as a
separate, explicitly-confirmed step.
