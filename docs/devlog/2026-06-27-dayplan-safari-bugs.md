# 2026-06-27 Day Plans: Safari Bugs, UX Overhaul, and Handoff to Codex

## Summary

Day Plans "Save day" does not work correctly in Safari. It was tested working in Chrome (both localhost and prod). In Safari, clicking Save Day either does nothing, or after multiple presses it saves a plan with the wrong title, erased date, and erased notes. The stops collapse toggle was also removed (intentionally but incorrectly). Multiple fix attempts were made without resolving the core Safari form submission issue. This document captures everything for Codex to pick up.

---

## The Bug: Save Day Fails in Safari

### Symptoms (user-reported, Safari on macOS)
1. Click "Save day" with a title, date, notes, and stops filled in.
2. The text fields clear (title, date, notes go blank) but no plan appears in the saved list.
3. After multiple button presses, a plan eventually saves but with the wrong title (appears to use whatever was in the title field at the moment of one of the retries), date is blank, notes are blank.
4. Works perfectly in Chrome (same actions, same data, same dev server).

### What the form does

The builder form is at `src/routes/trips/[id]/+page.svelte` around line 1638:

```svelte
<form
    method="POST"
    action="?/dayplan-create"
    class="dayplan-builder"
    use:enhance={({ formData }) => {
        formData.set('stops', builderStopsJson);
        return async ({ result, update }) => {
            if (result.type === 'success') {
                resetDayPlanBuilder();
                dayPlanBuilderOpen = false;
            }
            await update();
        };
    }}
>
    <input type="hidden" name="stops" value={builderStopsJson} />
    ...form fields (title, optional_date, notes, stops list)...
    <button type="submit" disabled={...}>Save day</button>
</form>
```

The server action is at `src/routes/trips/[id]/+page.server.ts` line 562:

```typescript
'dayplan-create': async ({ params, request, locals }) => {
    const { ownerId, tripId } = ctx(locals, params);
    await ownTrip(ownerId, tripId);
    const form = await request.formData();
    const title = (form.get('title') ?? '').toString().trim();
    if (!title) return fail(400, { error: 'Title is required.' });
    const stops = parseStopInputs(form.get('stops')?.toString());
    const planId = await createDayPlan(tripId, {
        title: title.slice(0, 300),
        notes: cleanText(form.get('notes')),
        optional_date: optDate(form.get('optional_date')),
        stops
    });
    return { ok: true, planId };
},
```

### What's confirmed working
- The server-side `dayplan-create` action creates plans correctly (verified via Chrome testing).
- The `builderStopsJson` `$derived` value correctly serializes stops to JSON.
- The `resetDayPlanBuilder()` function correctly clears all builder state.
- The `use:enhance` callback correctly calls `resetDayPlanBuilder()` on success and `await update()` to refresh page data.
- Chrome submits all form fields correctly every time.

### Key data flow
1. `builderStopsJson` is a Svelte 5 `$derived` value (line 827):
   ```typescript
   const builderStopsJson = $derived(
       JSON.stringify(dayPlanStops.map(s => ({
           itinerary_item_id: s.itinerary_item_id,
           notes: s.notes.trim() || null
       })))
   );
   ```
2. This feeds a hidden input: `<input type="hidden" name="stops" value={builderStopsJson} />`
3. The `use:enhance` callback ALSO explicitly sets `formData.set('stops', builderStopsJson)` as belt-and-suspenders.
4. The form fields `title`, `optional_date`, and `notes` are bound via `bind:value` to `$state` variables.

---

## Fix Attempts (all failed to resolve in Safari)

### Attempt 1: formData.set() in enhance callback
**Hypothesis**: The `$derived` value for `builderStopsJson` might not flush to the hidden input's DOM `value` attribute before Safari reads the form. SvelteKit's `use:enhance` intercepts the submit and serializes form data — if the hidden input's DOM value is stale, the stops JSON would be empty.

**Change**: Modified the `use:enhance` callback to explicitly set `formData.set('stops', builderStopsJson)` using the reactive variable directly (which is always current), bypassing the DOM hidden input entirely.

**Result**: Did not fix the issue. The stops might be submitting correctly now, but `title`, `optional_date`, and `notes` are still lost. The `formData.set()` approach only covers the stops field — the other fields are still read from the DOM by SvelteKit's form serialization.

### Attempt 2: Replace `<fieldset>` with `<div>`
**Hypothesis**: Safari has known quirks with `<fieldset>` elements and form serialization. All three builder sections were wrapped in `<fieldset class="builder-step">` with `<legend>` labels (e.g., "1. Name your day"). Safari might not serialize inputs inside fieldsets correctly in some cases, or the fieldset might interfere with how `use:enhance` reads form data.

**Change**: Replaced all three `<fieldset class="builder-step">` / `<legend>` pairs with `<div class="builder-step">` / `<div class="builder-step-label">`. Updated CSS from `legend` styles to `.builder-step-label` styles.

**Result**: User reports the save "eventually works after several presses" but with wrong data — title is garbled, date and notes are erased. This suggests the fieldset wasn't the root cause, or there's a deeper issue with how Safari handles SvelteKit's `use:enhance` form interception.

### Things NOT yet tried

1. **Add `formData.set()` for ALL fields, not just stops**: The enhance callback currently only explicitly sets the `stops` field. If Safari's form serialization is the problem, ALL fields (title, optional_date, notes) should be explicitly set from their `$state` variables in the enhance callback:
   ```svelte
   use:enhance={({ formData }) => {
       formData.set('title', dayPlanTitle);
       formData.set('notes', dayPlanNotes);
       formData.set('optional_date', dayPlanDate);
       formData.set('stops', builderStopsJson);
       ...
   }}
   ```
   This is the most likely fix — it bypasses DOM serialization entirely for all fields.

2. **Remove `use:enhance` entirely and test native form submission**: This would confirm whether the issue is in SvelteKit's enhance interceptor or in Safari's native form handling. If native submission works, the bug is in how `use:enhance` reads form data in Safari.

3. **Add console logging in the enhance callback**: Log `formData` entries before submission to see exactly what Safari is sending:
   ```javascript
   for (const [key, val] of formData.entries()) console.log(key, val);
   ```

4. **Check if `$state` bind:value is working in Safari**: The `bind:value` directive in Svelte 5 should keep the DOM input value in sync, but there may be a Safari-specific timing issue where the DOM value hasn't updated by the time the form is serialized.

5. **Test with a minimal reproduction**: Create a simple form with `use:enhance` and `bind:value` inputs in Safari to isolate whether this is a Svelte 5 + Safari issue.

---

## Other Changes Made (June 25-27 sessions)

### UX overhaul of the day plan builder
All changes in `src/routes/trips/[id]/+page.svelte`:

1. **Numbered step sections**: Builder form reorganized into three labeled sections:
   - "1. Name your day" (title, date, notes)
   - "2. Add stops" (group chips, filter, dropdown)
   - "3. Review & reorder" (route tools, stop list, preview)
   - Currently using `<div class="builder-step">` with `<div class="builder-step-label">` (was `<fieldset>`/`<legend>`, changed per Attempt 2 above)

2. **Group chips moved above dropdown**: "Load an entire group at once:" label with prominent group chips, then "Or pick individual places:" label before the dropdown. `.group-chip` class added for visual prominence.

3. **Filter placeholder changed**: From "Filter places..." to "Type to filter the dropdown below..."

4. **Save button enlarged**: `.save-day-btn` class with `font-size: 1rem`, `padding: 8px 20px`, `min-height: 44px`. Shows disabled hint text "(needs title)" or "(add stops first)".

5. **Builder border**: Changed to `2px solid var(--link)` for visibility.

6. **Expandable help guide added**: `<details class="dayplan-help">` with "How day plans work" summary, containing four subsections:
   - "Building a day plan"
   - "After saving: stops, routes, and driving"
   - "AI tools and suggestions"
   - "Editing a saved plan"

### Stops display change (NEEDS REVIEW)
- **Changed**: Saved day plan stops were inside a `<details class="dayplan-details"><summary>Stops</summary>...</details>` toggle.
- **Changed to**: `<div class="dayplan-stops-section">` — stops are always visible, no toggle.
- **User feedback**: "There is no 'stops' dropdown button to collapse the trip stops." — the user WANTS a way to collapse stops on saved plans. The `<details>` toggle should be restored, or a different collapse mechanism added.

### Google Maps link fix
`src/lib/maplinks.ts`: Changed `googleMapsLink()` to prefer coordinates when a place has lat/lon but no place_id. Previously it fell through to a name-only search which often didn't find the right place.

```typescript
// Before: always used name search if no place_id
// After: uses coordinates when available
if (p.place_id) {
    return `${base}&query=${encodeURIComponent(p.name || 'place')}&query_place_id=${...}`;
}
if (hasCoords(p)) {
    return `${base}&query=${encodeURIComponent(coordStr(p))}`;
}
return `${base}&query=${encodeURIComponent(searchToken(p))}`;
```

Test updated in `src/lib/maplinks.test.ts` to match new behavior.

### Test data coordinates fixed
All 5 Provence test places (trip_id=2 in test DB, port 15437) had NULL lat/lon. Updated with real coordinates:

| Place | lat | lon |
|-------|-----|-----|
| Avignon | 43.9493 | 4.8055 |
| Arles | 43.6767 | 4.6278 |
| Palais des Papes | 43.9508 | 4.8075 |
| Pont d'Avignon | 43.9536 | 4.8033 |
| Les Halles market | 43.9485 | 4.8052 |

This was done via `psql UPDATE` directly on the test DB, not via migration. These are test-only values.

---

## Current State of Files

### Modified (uncommitted)
- `src/routes/trips/[id]/+page.svelte` — UX overhaul + Safari fix attempts (249 insertions, 113 deletions)
- `src/lib/maplinks.ts` — coordinate-based Google Maps links
- `src/lib/maplinks.test.ts` — updated test expectation

### Build status
- `npm run check`: 0 errors, 0 warnings
- `npm run build`: passes

### Test environment
- Dev server: `npm run dev:test` on port 5179
- Test DB: PostgreSQL port 15437, database `trips_test`
- Test credentials: username `owner`, password `testpass1234`
- Test trip: http://localhost:5179/trips/2 (Provence trip, 5 places with coordinates)

---

## Priority Fix List for Codex

1. **CRITICAL: Fix Save Day in Safari** — The most likely fix is to explicitly set ALL form fields from `$state` variables in the `use:enhance` callback (see "Things NOT yet tried" #1 above). Test by building a day plan in Safari, clicking Save once, and verifying the plan appears with correct title, date, notes, and stops.

2. **Restore stops collapse toggle** — The `<details>` toggle for saved plan stops was removed. User wants it back. Either restore `<details class="dayplan-details"><summary>Stops</summary>...</details>` or add a button-driven collapse.

3. **Verify Optimize Order works** — Now that test places have coordinates, Optimize Order should work. Needs Safari testing.

4. **Verify date picker works in Safari** — User reported calendar popup didn't work initially, then it did. Intermittent Safari issue.

---

## Codex Fix Applied (2026-06-27)

### Code changes
- `src/routes/trips/[id]/+page.svelte`: `dayplan-create` `use:enhance` now explicitly sets `title`, `optional_date`, `notes`, and `stops` from Svelte state before submit. This avoids relying on Safari/SvelteKit DOM form serialization timing for any builder field.
- The success handler now calls `await update({ reset: false })` before clearing builder state and closing the builder. Failures leave the user's builder fields intact.
- Saved day plan stops are back inside `<details class="dayplan-details" open><summary>Stops (...)</summary>...</details>`, so saved stops are visible by default but collapsible.

### Safari QA
- Browser: macOS Safari via `safaridriver -p 4444`.
- URL: `http://127.0.0.1:5179/trips/2`.
- Test row created by Safari: `Safari QA patched 1782587900642`.
- DB verification:
  - `title`: `Safari QA patched 1782587900642`
  - `optional_date`: `2026-07-30`
  - `notes`: `patched safari notes`
  - stops: `3`
- UI verification:
  - Saved plan appeared after one Save click.
  - Builder closed after success.
  - `Stops (0/3 visited)` disclosure rendered open by default and toggled open/closed.
  - `Optimize order` was enabled for the three-stop plan and completed with `Route optimized and distances updated.`
  - Saved card showed `3.9 km, 13 min` after optimization.
- Screenshots:
  - `/tmp/dayplan-safari-saved.png`
  - `/tmp/dayplan-safari-optimized.png`

### Command verification
- `npm run check`: pass, 0 errors/warnings.
- `npm run test`: pass, 4 files / 46 tests.
- `git diff --check`: pass.
- `npm run build`: pass.

---

## Codex Follow-up: Google Place IDs (2026-06-27)

### Problem
Google links for saved locations without `place_id` opened coordinate-only Google Maps panels. Those are precise pins, but they do not show the actual place details. Name-only search is not acceptable because it can choose the wrong place far away.

### Root cause
The schema and map link builder supported `place_id`, and Day Plan stops already snapshot `itinerary_items.place_id`, but most save paths never populated it:
- `/api/geocode` returned only `lat`, `lng`, `name`, and `bounds`.
- `MapPicker` selected only `{ lat, lng, label }`.
- manual location save had a hidden `place_id` read on the server, but no form field sent it.
- import geocoding explicitly left `placeId = null`.
- Day Plan external suggestions created itinerary places with `setLocation(..., null)`.

### Fix
- Google place search now prefers Places Text Search and falls back to Geocoding, preserving `place_id`.
- Forward and reverse geocode API responses include `place_id`.
- `MapPicker` carries `place_id` through search, map tap, and marker drag.
- manual location save submits `place_id` and refuses coordinate-only saves with a clear error.
- itinerary imports preserve incoming `place_id` and use coordinate-biased lookup to fill missing IDs.
- Google Maps URL extraction tries a coordinate-biased place lookup when URL parsing yields name + coordinates but no ID.
- Day Plan external suggestions carry Nearby Places `place_id`; adding an external suggestion requires it.
- Day Plan stop propagation relies on the existing snapshot path: `addStop` copies `itinerary_items.place_id` into `day_plan_stops.snapshot_place_id`.

### Live verification
- Authenticated `/api/geocode` for `Abbaye Saint-Roman, Beaucaire, France` returned `place_id=ChIJNwwgoCPbtRIRi5yEtp6wOBU`.
- Created a temp place through app actions, saved location with that ID, created a Day Plan with that place, and confirmed DB propagation:
  - `itinerary_items.place_id = ChIJNwwgoCPbtRIRi5yEtp6wOBU`
  - `day_plan_stops.snapshot_place_id = ChIJNwwgoCPbtRIRi5yEtp6wOBU`
- Tried a coordinate-only save with no `place_id`; action returned failure `400` and left DB `lat/lon/place_id` empty.

### Command verification
- `npm run check`: pass, 0 errors/warnings.
- `npm run test`: pass, 4 files / 46 tests.
- `git diff --check`: pass.
- `npm run build`: pass.
