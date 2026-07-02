# Place Details + Ask AI About This Place (revised)

Date: 2026-07-01
Task: `td-80cf30` — Add AI interaction for places
Status: implementation plan — revision of `docs/2026-07-01-place-ai-interaction-plan.md`, after review against current codebase state

This revision keeps the original's scope and structure but fixes several mismatches found by checking it against the actual `api_cache` table, the actual Google Places usage in `src/lib/server/geocode.ts`, the actual `itinerary_items` schema, the actual place-page route, and the actual itinerary-row UI. See "Changes from the original plan" at the bottom for a summary of what moved and why.

## Summary

Implement `td-80cf30` as a thin, source-grounded place assistant:

- Fetch factual place details from Google Places by existing itinerary `place_id`.
- Cache those details in the existing `api_cache` table.
- Let the owner ask free-form questions that the AI answers from known app data plus cached place facts.
- Do not add broad web browsing in V1. Schedules, hours, prices, tickets, ferries, trains, and seasonal closures must come from known structured facts or be explicitly marked as needing official-source verification.

Useful Google references:

- [Place Details (New)](https://developers.google.com/maps/documentation/places/web-service/place-details)
- [Place Data Fields (New)](https://developers.google.com/maps/documentation/places/web-service/data-fields)
- [AI-powered place summaries](https://developers.google.com/maps/documentation/places/web-service/place-summaries)

## Phase 0: Verify Places API (New) access (new — do this before writing any code)

The existing server-side Google integration (`src/lib/server/geocode.ts`) only ever calls the **legacy** Places API: `maps.googleapis.com/maps/api/place/{textsearch,nearbysearch}/json`, key passed as a `?key=` query param, status reported as `status: 'OK' | 'ZERO_RESULTS' | 'OVER_QUERY_LIMIT'` in the JSON body. **Places API (New)** — required for Phase 1's Place Details + field mask — is a distinct GCP product that:

- Must be individually enabled in Google Cloud Console; enabling the legacy Places API does not enable it.
- Authenticates with an `X-Goog-Api-Key` header (not a query param) and requires an `X-Goog-FieldMask` header (not a query param) to select fields.
- Returns a different error shape entirely (HTTP status + `error.status`/`error.message` JSON body, not the legacy `status` field).

Before Phase 1: run a single manual check against both the dev and prod `GOOGLE_GEOCODING_KEY` values, e.g.:

```sh
curl -s "https://places.googleapis.com/v1/places/PLACE_ID_HERE" \
  -H "X-Goog-Api-Key: $GOOGLE_GEOCODING_KEY" \
  -H "X-Goog-FieldMask: id,displayName,formattedAddress"
```

If this fails (product not enabled, key restricted, billing not set up for the new SKU), treat it as a blocker for Phase 1 — this is a GCP Console change, not something the app can route around with an error status. Do not proceed past Phase 0 until both keys succeed.

## Phase 1: Place Details Fact Layer

Add a server helper for Google Places API New Place Details. Do not model this helper's conventions on `placesNearby()`/`placesTextSearch()` in `geocode.ts` — those are a different API with different auth and a different response shape; this is a fresh integration that happens to share an API key.

Implementation notes:

- Use the existing `GOOGLE_GEOCODING_KEY`.
- Accept a Google `place_id` from `itinerary_items.place_id`.
- Store responses in `api_cache`; no new table for V1.
- Use cache keys like `place-details:{place_id}:v1`.
- Use a 12-24 hour TTL for place facts.
- Do not attempt to cache a separately-refreshed "open now" boolean at a shorter TTL in V1 — see "Open/closed status" below. That complexity isn't worth it for a personal trip app.
- Keep the existing geocode and nearby-place helpers unchanged.

Request a conservative field mask:

- `id`
- `displayName`
- `formattedAddress`
- `location`
- `googleMapsUri`
- `websiteUri`
- `nationalPhoneNumber`
- `businessStatus`
- `types`
- `rating`
- `userRatingCount`
- `currentOpeningHours`
- `regularOpeningHours`

Cost note: Places API (New) bills by SKU tier (Essentials / Pro / Enterprise+Atmosphere), and a request touching any higher-tier field (`rating`, `userRatingCount`, `currentOpeningHours` are Enterprise+Atmosphere-tier) bills the *entire* request at that tier, not just those fields. Fine for this app's volume with a 12-24h cache, but it's a conscious choice — don't add more Enterprise-tier fields later without checking current pricing.

Open/closed status: **show only the hours schedule (`regularOpeningHours`/`currentOpeningHours`) plus the existing cache-age label — do not surface a live "open now" boolean.** A boolean that can be up to 24 hours stale is actively misleading in a way a schedule-plus-age label isn't. If real-time open/closed status is wanted later, that's a separate uncached lookup, not a shorter TTL on this cache entry.

Return explicit statuses:

- `ok`
- `missing_place_id`
- `not_configured`
- `not_found`
- `rate_limited`
- `upstream_error`

Do not fabricate missing fields. A missing website, phone, rating, or hours block should remain absent in the UI.

## Phase 2: Place Workspace UI

Extend the existing place page at `/trips/[id]/place/[itemId]` from a location editor into a small place workspace.

Behavior:

- Keep the existing map/location editor.
- Add a read-only "Known Details" panel for fetched or cached facts.
- Show address, hours summary (schedule only, no live open/closed boolean — see Phase 1), website, phone, Google Maps link, rating count, and cache age.
- Keep the page owner-only, matching the current route behavior.

Location-state handling (replaces the original's single "no place_id → re-select" fallback): `itinerary_items` has three distinct location states, not two — `place_id` (Google), a separate `apple_maps_place_id` (added in migration `0008_apple_maps_place_id.sql`, actively used since 2026-06-28 for Apple Maps URL imports), and raw `lat`/`lon`. Handle them as:

- **Has Google `place_id`** → full fact fetch as described above.
- **Has coordinates (`lat`/`lon`) but no Google `place_id`** (e.g. an Apple Maps import, or a manually dropped pin) → attempt to resolve a Google `place_id` via the existing reverse-geocode/nearby helpers in `geocode.ts`; if that doesn't confidently resolve, fall back to the Phase 3 "limited" AI-notes-only mode. Do **not** tell the owner to re-select the location — they already have a valid pin, just not a Google id for it.
- **No coordinates at all** → this is the real re-select case; show the prompt to pick a location before place facts or AI answers can be reliable.

Main trip page:

- Reuse the existing `📍 location` / `＋ location` chip-link on itinerary place rows (`src/routes/trips/[id]/+page.svelte`) as the entry point into the workspace — do **not** add a second, distinct "Details"/"Ask" button. Owner-view place rows already carry ~9 inline controls (Google/Apple/Directions links, the location link, indent/outdent/move/delete) at mobile widths under this app's 48px tap-target convention (`docs/mockups/mockup.css`); one more always-visible control makes an already-dense row worse for no benefit, since the existing link already goes to the right page.
- Do not embed the full Q&A surface in the main itinerary list.
- Day-plan stops that reference an itinerary item should link to the same place workspace.
- Day-plan external suggestion snapshots (`day_plan_stops` rows with `itinerary_item_id IS NULL`) do not get a Q&A page in V1. **Note this is a deliberate scope cut, not an oversight**: these snapshots already carry a real Google `snapshot_place_id` straight from `placesNearby()`'s own results, which arguably makes them *easier* to support than committed itinerary items (no id-resolution needed) — a reasonable first follow-up after V1 ships.

## Phase 3: Ask AI About This Place

Add an owner-only question form on the place workspace.

Create a dedicated server helper instead of overloading `ai-notes.ts` — the prompt purpose is different enough to deserve its own system prompt and response format. However, do **not** duplicate the low-level Anthropic plumbing that already exists in `src/lib/server/ai-notes.ts` (model constant, `AiNotesError`-style error class, the fetch/30s-timeout/401/429/generic-error mapping at `ai-notes.ts` lines 61-84). Factor that shared plumbing into a small helper (e.g. `src/lib/server/anthropic-client.ts`) that both `ai-notes.ts` and the new place-ai helper call, and reuse `ai-notes.ts`'s model constant rather than picking a new one. The new helper should own only its distinct prompt-building and response-parsing.

Inputs to the model:

- Trip name, dates, and notes.
- Itinerary item title, notes, date, coordinates, and provider IDs.
- Cached Google place details from Phase 1.
- The user's question.

Prompt rules:

- Answer briefly and practically.
- Identify when the answer is based on known place details versus app notes.
- Hedge uncertain claims.
- Never invent exact hours, prices, ticket requirements, ferry schedules, train schedules, or closure information.
- If the known facts do not answer the question, say what needs official-source verification.

Input limits (new): cap the question at a reasonable length (e.g. 500 characters), validated server-side, and disable the submit button while the form action is pending. This is a single-owner, low-traffic feature, but there's no reason to leave the door open to an accidental double-submit or a pasted wall of text costing real Anthropic tokens for no benefit.

V1 persistence:

- Do not persist Q&A history.
- Render only the latest answer from the form action response.
- Do not write answers into itinerary notes automatically.

Error states:

- Missing `ANTHROPIC_API_KEY`: show an explicit "AI is not configured" error.
- AI rate limit or upstream error: show a retryable error.
- Missing place facts: still allow a general answer from trip/item notes, but label it as limited.

## Phase 4: Refresh and Hardening

Add a "Refresh details" action.

Behavior:

- Owner-only.
- **Bypass the cache-hit check and re-fetch-and-upsert** the `place-details:{place_id}:v1` entry — do not add a separate DELETE code path. (`api_cache` does have `DELETE` granted per migration `0007`, so a delete-then-refetch would work, but every existing caller — `weather.ts`, `geocode.ts` — only ever does insert-on-conflict-update; a bypass-and-upsert keeps this feature consistent with that one existing pattern instead of introducing a second one.)
- Refetches details and re-renders the workspace.
- Shows explicit upstream/key/rate-limit failures.

Security and reliability:

- Do not add arbitrary URL fetching in this task.
- Do not use a place website URL as server-side fetch input.
- Do not log API keys, full upstream responses, session tokens, or user questions that might contain private trip details.
- Keep all mutating actions behind existing same-origin and owner checks.

Optional follow-up:

- Add Google AI-powered place summaries if the shared Maps key and billing tier support the field.
- Treat Google summaries as display/helpful context, not as the only factual source.

## Test Plan

Automated:

- Unit-test the place-details helper with mocked fetch responses:
  - success
  - missing `place_id`
  - missing Google key
  - not found
  - rate limited
  - upstream error
  - malformed payload
- Test `api_cache` read/write behavior against the local test DB.
- Test the AI helper prompt/response parser with a mocked Anthropic response.

Manual/browser:

- Start with `npm run test:db:up` and `npm run dev:test`.
- **Known gotcha**: if the dev server is started from Claude Code's own Bash tool, `~/.claude/settings.json` blanks `ANTHROPIC_API_KEY` for that subprocess (see `docs/devlog/2026-06-25-claude-in-chrome-debugging.md`), and the Ask-AI feature will falsely report "AI is not configured." Either prefix the command with the real key (`ANTHROPIC_API_KEY=sk-ant-... npm run dev:test`) or start the dev server from your own terminal.
- Use an itinerary place with a real Google `place_id`.
- Verify the place page shows known details and cache age.
- Use an itinerary place with coordinates but only an `apple_maps_place_id` (no Google `place_id`) and verify it resolves a Google id or degrades to limited AI-only mode — not a re-select prompt.
- Verify a place with no coordinates at all shows the re-select prompt.
- Ask a normal question such as "What should I know before visiting?" and verify the answer is grounded and hedged.
- Ask a schedule-sensitive question such as "What are the exact hours on July 30?" and verify the answer refuses to invent facts unless Google current/regular hours are available.
- Verify missing AI key and missing Google key states are explicit, not silent.

Required pre-commit checks:

- `npm run check`
- `npm test`
- `git diff --check`
- `npm run build`

## Acceptance Criteria

- Owner can open a place workspace and see factual details for places with `place_id`.
- Owner can ask a question about a place and receive a concise, grounded answer.
- Places without any location data fail gracefully with a clear next step; places with coordinates but no Google `place_id` do not get a spurious re-select prompt.
- The feature does not crawl arbitrary websites or fabricate schedules.
- Existing map/location save behavior still works.
- Existing day-plan AI notes and suggestions continue to work.

## Assumptions

- V1 uses existing `api_cache`; no migration is required unless implementation discovers the current cache shape is insufficient.
- `GOOGLE_GEOCODING_KEY` can call Places API New Place Details in dev and prod — **verified in Phase 0 before implementation starts**, not discovered mid-build.
- `ANTHROPIC_API_KEY` remains the AI provider for this app, using the same model as `ai-notes.ts`.
- Viewer access remains read-only and does not include the owner-only place workspace in V1.

## Changes from the original plan

- Added Phase 0 to verify Places API (New) access up front — the original treated "the key might not work with the new API" as an assumption to discover during implementation, but this is a different GCP product from what the app calls today and deserves a go/no-go check first.
- Split the original's single "no place_id → re-select" case into three location states, since `itinerary_items` also has `apple_maps_place_id` and raw coordinates that the original didn't account for.
- Decided the open/closed staleness question the original left open: show only the hours schedule + cache age, not a live open/closed boolean.
- Replaced "add a new Details/Ask entry point" with "reuse the existing `📍 location` chip-link," since that entry point already exists and place rows are already control-dense.
- Specified reusing `ai-notes.ts`'s model and factoring out its Anthropic HTTP/error plumbing, instead of leaving Phase 3 to duplicate it.
- Replaced "deletes or bypasses" the cache with one concrete behavior (bypass + upsert), matching this app's only existing `api_cache` write pattern.
- Added a question-length cap and pending-state submit guard to Phase 3.
- Added the `ANTHROPIC_API_KEY` env-blanking gotcha and `git diff --check` to the Test Plan, both already established conventions/incidents in this repo.
- Noted the day-plan external-suggestion Q&A exclusion is a deliberate, easy first follow-up rather than a silent gap.
