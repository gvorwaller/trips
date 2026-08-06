# Implement the three new td tickets (2026-08-05 batch)

## Context

The tracker has three new owner-filed tickets, all born from real use on the Maine
trip. Same shipping workflow as the last batch: each ticket on its own branch from
fresh main, CODEX peer review + browser QA over the relay, ship on explicit go
(commit → ff-only merge → push → `td` close with attribution → deploy).

Proposed order: **A (td-036f71, P1) → B (td-9ae4dd) → C (td-947440)** — priority
first, then smallest-risk first.

---

## A. td-036f71 (P1): searchable anchor picker for day plans

**Problem:** both anchor pickers are native `<select>`s over every located place
(~90 options). The app already has `SearchableSelect`
(`src/lib/components/SearchableSelect.svelte`), built 2026-07-28 for exactly this
complaint and used 4× on the same page — the anchor selects were just never
converted.

**Change — all in `src/routes/trips/[id]/+page.svelte`:**

1. **Saved-plan card picker** (~:2110): replace the `<select>` with
   `SearchableSelect` using **one-way `selectedValue` + `onSelect`** (NOT
   `bind:` into the keyed `savedPlanAnchors[plan.id]` record — that exact
   `props_invalid_value` bug is documented in devlog 2026-07-28). `onSelect`
   calls the existing `setSavedPlanAnchor(plan.id, plan.optional_date, value, anchor)`.
2. **Builder picker** (~:2574): replace with `SearchableSelect`
   `bind:selectedValue={builderAnchor}` (plain state var — bind is safe here).
3. **`'' ↔ 'none'` mapping:** `SearchableSelect` clears to `''` on divergent
   typing; `anchorFromValue('')` already returns null (same effect as `'none'`),
   but map `'' → 'none'` in both handlers so the visible label stays "No anchor"
   and `savedPlanAnchors`/`builderAnchor` never hold `''`.
4. **Options:** feed `anchorOptions(...)` output directly as
   `{value, label}` — it already includes 'none', `res:` stays, `place:` entries,
   and the persisted-anchor fallback (load-bearing; see `dayplan-anchor.ts:1-20`).
   `maxResults={500}` like the other call sites.
5. **CSS:** the selects currently size via `.route-tools select {...}` (:5317).
   Add an equivalent `.route-tools :global(.searchable-select)` rule
   (flex 1 1 180px, max-width min(320px,100%)); the component brings its own
   44px/16px input.

**No server change** — the posted `anchor_source` values are identical.

**Verify:** `npm run check` + `build` + `npm run test`; browser QA (CODEX): type-to-
filter finds a place in both pickers; picking recalculates driving; "No anchor"
selectable; persisted anchor still appears when it's filtered out of options
(deleted/unlocated place case); Escape/blur restores label.

---

## B. td-9ae4dd (P2): Share text can't be dismissed on iOS

**Root cause (confirmed):** both "Share text" controls are plain `<a href>` links
to export endpoints that return **inline `text/plain`**
(`src/routes/trips/[id]/export/+server.ts:85` and
`.../dayplan/[planId]/export/+server.ts:91`). The app is an installed PWA
(`display: standalone`, `apple-mobile-web-app-capable`), so the navigation
replaces the app shell with a chrome-less raw-text view — no address bar, no
Back, no way out. (`md`/`ics` are unaffected: they're `Content-Disposition:
attachment` → iOS share sheet with Done.)

**Fix — make Share text JS-driven; keep the endpoints unchanged:**

1. **Lift `isIosStandalone()`** from
   `src/lib/components/AttachmentDownloadButton.svelte:23-29` into a small
   `src/lib/share.ts` (or similar) and reuse it from both places; also export a
   `shareText(text, title)` helper: try `navigator.share({ text, title })`
   (swallow `AbortError` = user cancelled, like AttachmentDownloadButton does),
   return `'shared' | 'unavailable' | 'failed'`.
2. **Convert both `<a>`s to `<button>`s** in `src/routes/trips/[id]/+page.svelte`
   (trip header ~:1755, day-plan card ~:2042). Handler: `fetch` the same
   `…export?format=txt&units=…` URL, then:
   - `navigator.share` available → share sheet (covers iOS Safari + standalone,
     macOS Safari, Android).
   - Otherwise → open a **share-text modal** using the page's existing
     `.modal-overlay`/`.modal` pattern (state-driven, like `pendingDelete`):
     scrollable `<pre>`/readonly `<textarea>` with the text, a **Copy** button
     (`navigator.clipboard.writeText`, flip label to "Copied ✓"), and a
     **Close** button (44px+). Add backdrop-click close and wire into the
     existing `<svelte:window>` Escape handler (~:4446). The modal needs
     `max-height` + internal scroll for a whole-trip export.
3. One shared modal + `shareModal = $state<{title, text} | null>` serves both
   the trip-level and per-plan buttons.
4. **Viewer role:** GET fetch — allowed for viewers, no change needed.

Not touched: `md`/`ics` links, print routes, the export endpoint contract
(the "open in Safari, select-all" workflow still works by URL).

**Verify:** unit `check`/`build`/`test`; CODEX browser QA on desktop (modal
fallback if share unsupported, Copy works); owner QA on the actual iPhone PWA —
the one environment CODEX can't reach: share sheet opens and dismisses, app
shell intact afterwards.

---

## C. td-947440 (P2): multi-select "move under" in the places tree

**Foundation (already exists):** single-item reparent — `?/itin-reparent` action
(`+page.server.ts:721`, appends at end of new parent) → `runReparent`
(`tree-sql.ts:145`) → `computeReparent` (`tree.ts:154`) with cycle check and
dense 0..n-1 reindex. `applyChanges` (`tree-sql.ts:42`) prelocks all touched
rows id-ordered `FOR UPDATE` (deadlock fix td-36b55b) — **the bulk variant must
produce ONE combined `Change[]` and call `applyChanges` once in one
transaction**, never loop `runReparent`.

### Server

1. **`src/lib/server/tree.ts`** — pure
   `computeReparentMany(nodes, ids, newParentId): Change[]`:
   - Dedupe ids; normalize to **effective roots** (drop any id with a selected
     ancestor — it travels with the subtree; a natural checkbox gesture, not an
     error).
   - Reject (`[]`) on: empty/unknown ids, unknown parent, or union cycle —
     `roots.some(r => wouldCreateCycle(nodes, r, newParentId))` (covers
     target-is-selected and target-inside-selected-subtree).
   - Roots land under the target **in document (flattened-tree) order**,
     appended after the target's existing non-selected children; POST order of
     ids is irrelevant. An item already under the target is simply reindexed
     into the appended run (predictable "everything checked ends up at the
     bottom of the target").
   - Emit `reindex` for the target group plus each distinct old parent group
     (excluding the target; groups are provably disjoint).
2. **`src/lib/server/tree-sql.ts`** — thin
   `runReparentMany(table, containerId, ids, newParentId): Promise<boolean>`:
   one `withTransaction` + `loadNodes`; throw `'Item does not belong to this
   container'` if any id isn't in the container; exactly one `applyChanges`;
   `false` when the pure fn rejects.
3. **`src/routes/trips/[id]/+page.server.ts`** — action `itin-reparent-many`:
   `ctx`+`ownTrip`, `form.getAll('ids')` (positive ints), `optId(parent_id)`
   ('' = top level); empty → `fail(400, 'Select at least one item.')`;
   `runReparentMany` false → `fail(400, 'Cannot move items under something you
   selected.')`; catch container throw → `fail(400, 'Some items could not be
   moved. Nothing was changed.')` (all-or-nothing, mirroring `bulk-set-date` in
   `places/schedule/+page.server.ts:57-78`). No hooks/allow-list change —
   viewers already blocked.

### Client (`src/routes/trips/[id]/+page.svelte`)

- **State:** `placesSelectMode`, `placesSelected = $state<Record<number,
  boolean>>({})` (schedule-page precedent), `bulkMoveParent`, `bulkMoveError`,
  derived `placesSelectedIds`.
- **Select toggle** ("Select"/"Done") in the `tree-tools` row (:2728),
  `{#if !isViewer}` — NOT always-visible checkboxes: place rows already carry a
  visited checkbox and a second permanent one would be cramped/confusable.
  Note the `tree-tools` row is currently gated on `itinParents.size > 0` —
  relax so the toggle shows for flat lists too. In select mode add
  "Select all"/"Clear" linkbtns; with an active search, "Select all" selects
  only **direct matches** (`placesDirectMatchIds`), not context ancestors.
- **Per-row checkbox** in select mode for every row type, replacing the visited
  checkbox's slot (reuse the ≥44px `chk-hit` wrapper; distinct accent style);
  suppress `treeControls` and the `details.edit` block while selecting. No
  auto-check of descendants — checkbox meaning stays literal; the server
  normalizes. Selection survives fold/search (it's by id; the bar count is the
  truth).
- **Sticky bottom bulk bar** (only mounted in select mode): repeated `ids`
  hidden inputs, "N selected", target `SearchableSelect`
  (`bind:selectedValue={bulkMoveParent}`, options = `{'' → Top level}` +
  `itinImportParents` minus the union of selected subtrees via
  `isItinDescendant`; guard `bulkTargetInvalid` disables Move if the chosen
  target becomes excluded), **Move** (disabled at count 0) + **Clear**.
  `use:enhance`: failure → `bulkMoveError` shown as `field-error` (existing
  pattern); success → `update({reset:false})`, un-collapse the target
  (`toggleItin`), clear selection, exit select mode. 44px targets,
  flex-wrap for 360px width, hidden in print.

### Tests

- `tree.test.ts` `computeReparentMany`: two roots from different parents;
  document-order independence from POST order; ancestor+descendant selected;
  duplicate ids; target selected / inside selected subtree → `[]`; unknown
  id/parent/empty → `[]`; already-under-target reorders to end; move to top
  level; no id appears twice across the returned changes.
- db test (new `tree-sql-bulk.dbtest.ts` or a case in `isolation.dbtest.ts`):
  cross-trip id in the batch → throws AND nothing changed (rollback proof);
  one happy-path bulk commit.

---

## Workflow per ticket

1. Branch from fresh main (`feat/anchor-search`, `fix/share-text-ios`,
   `feat/places-multiselect-move`).
2. Implement + `npm run check` (0/0) + `npm run build` + `npm run test`
   (+ `test:db` for C).
3. CODEX relay review (code first, then browser QA) — background
   `relay-watch.js` polling, never trust `relay_wait` silence.
4. Fix findings, re-verify, then STOP for the owner's explicit go before
   commit/merge/deploy. B additionally needs owner iPhone QA post-deploy.
