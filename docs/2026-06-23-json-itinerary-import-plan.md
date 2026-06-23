# Plan: Freeform Itinerary Import

## Context

The user is planning a trip to Blue Hill, ME and wants to import candidate places, notes, and itinerary structure without hand-typing each item. The original plan assumed Gemini would produce a strict JSON payload. That is too brittle for real use: users will paste rough text from Gemini, ChatGPT, email, web pages, notes, guidebooks, or mixed bullets.

The feature should accept unformatted text, like the existing reservation and expense extraction flows. An LLM extracts structured itinerary candidates from the pasted text. The app then shows a preview for human review before anything is inserted.

The codebase already has useful building blocks:

- `itinerary.ts`: item types, tree structure, `createItem()`, `bulkCreate()`, `setLocation()`
- `tree-sql.ts`: `nextSortOrder()`, transactional ordering patterns
- `geocode.ts`: `geocodePlace(query)` -> coordinates/place details
- `reservation-extract.ts`: pasted text/document -> structured fields, but never auto-save
- `expense-extract.ts`: pasted text/document -> multiple candidates with checkbox review
- Places UI: existing outliner controls, optional parent placement, map links

## Design Direction

Replace "Import JSON" with **Import itinerary from text**.

The flow should be:

1. User pastes rough itinerary/place text.
2. Server sends the text to the LLM with a forced structured tool schema.
3. LLM returns candidate itinerary items, including inferred place/address/location queries when available.
4. User reviews, edits, selects/deselects candidates, and optionally chooses a parent.
5. Server validates again and imports selected candidates.
6. Optional geocoding resolves location queries into coordinates.

The LLM must never write to the database directly. It only produces candidates.

## Design Decisions

- **Freeform input first**: support pasted prose, bullets, Markdown, copied web text, and model output. Do not require JSON from the user.
- **Structured tool output internally**: use the same Anthropic tool-call pattern as reservation/expense extraction. The app receives structured candidates, but the user never has to supply JSON.
- **Two-step flow**: extract -> preview/edit -> import. This keeps incorrect model output from silently entering the itinerary.
- **Multiple candidates**: mirror expense extraction more than reservation extraction. One paste can produce many stops.
- **Reviewable location inference**: LLM extracts location hints into fields such as `address`, `location_query`, and `external_url`; geocoding converts those hints to coordinates only after review/import.
- **No hallucinated coordinates**: prefer geocoding over model-supplied lat/lon. If the source explicitly contains coordinates, accept them only after validation.
- **Encourage importing under a parent**: allow import under an existing day/section/place and make that workflow prominent. Top-level import remains available, but the UI should nudge users toward choosing a day or section when one exists.
- **Default item type for V1**: focus on extracting mostly flat `place` and `note` candidates. Day/section hierarchy inference is useful, but defer it unless the source is trivially obvious.
- **Conservative flat extraction for V1**: prefer a flat candidate list over guessed hierarchy. Rich day/section inference can be a future enhancement.
- **Duplicate awareness**: flag possible duplicates against existing itinerary items in the preview before import.
- **UI location**: Places section, near "Paste many."

## Candidate Shape

This is the internal LLM/tool schema, not a user-facing input requirement.

```ts
interface ExtractedItineraryItem {
  item_type: 'section' | 'day' | 'place' | 'note';
  title: string;
  date: string | null;          // YYYY-MM-DD, mostly for day items
  notes: string | null;
  external_url: string | null;
  address: string | null;       // stated address, if present
  location_query: string | null;// best geocoding query, e.g. "Arborvine Restaurant, Blue Hill, ME"
  lat: number | null;           // only if explicitly present in source
  lon: number | null;           // only if explicitly present in source
  children: ExtractedItineraryItem[];
}
```

Field rules:

| Field | Required | Rules |
|-------|----------|-------|
| `item_type` | Yes | `section`, `day`, `place`, or `note`; normalize invalid/unclear to `place` or `note` |
| `title` | Yes | Non-empty, max 500 chars |
| `date` | No | `YYYY-MM-DD`; null if unclear |
| `notes` | No | Max 5000 chars after normalization |
| `external_url` | No | Max 2000 chars; valid URL only |
| `address` | No | Stored in notes or used to build `location_query`; not currently a DB column |
| `location_query` | No | Used for geocoding; should include place name + town/state when possible |
| `lat` / `lon` | No | Only accept finite coordinates in valid ranges |
| `children` | No | Recursive array, max depth 3 |

Limits:

- Max pasted text: 50,000 chars, matching other extractors.
- Max extracted/imported items: 200 total.
- Max depth: 3.
- Empty or duplicate-looking candidates should be easy to deselect in preview.

## LLM Extraction Rules

Create a new server module, likely `src/lib/server/itinerary-extract.ts`.

Pattern:

- Raw `fetch()` to Anthropic Messages API, matching `reservation-extract.ts` / `expense-extract.ts`.
- Env-controlled model, e.g. `ANTHROPIC_ITINERARY_MODEL`, with a sensible default.
- Forced tool call, e.g. `submit_itinerary_candidates`.
- Return `ExtractedItineraryItem[] | null`.
- Graceful failure: log and return null; UI lets user fall back to manual entry.

Prompt requirements:

- Extract travel itinerary places, day headings, sections, and notes from rough text.
- Do not invent facts that are not supported by the source.
- If a place is named but address is absent, create a `location_query` from the name plus trip context if available.
- For the Blue Hill example, queries should include town/state when available, e.g. `Blue Hill, ME`, `Bar Harbor, ME`.
- Use `day` only when the source clearly indicates a day/date grouping.
- Use `section` for headings such as "Restaurants", "Museums", "Possible hikes".
- Use `note` for useful non-location remarks.
- Preserve source order.
- For V1, return a flat list unless the hierarchy is explicit and trivial. Do not aggressively infer day/section nesting.
- Include brief useful descriptive text in `notes` when present or inferable from the source, e.g. "Home base for the trip", "Anniversary dinner option", "Interest-only day trip candidate". Keep it short and source-grounded.
- Return an empty array if no itinerary candidates are present.

## Import / Insert Design

Create a new server module, likely `src/lib/server/itinerary-import.ts`.

Responsibilities:

- Normalize and validate candidates from the client.
- Enforce item count/depth limits.
- Assert optional parent belongs to trip.
- Insert selected candidates transactionally.
- Preserve hierarchy and sibling order.
- Resolve geocoding when enabled.

Important implementation detail:

- `createItem()` currently inserts title/type/notes/url/date but not coordinates.
- For imports with geocoding, either:
  - implement a dedicated transactional import function that inserts lat/lon/place_id directly, or
  - insert each item then call `setLocation()` for geocoded places.
- A dedicated import function is probably cleaner because it can preserve order and avoid many independent transactions.

Geocoding behavior:

- Checkbox: "Geocode places" default ON.
- Geocode only candidates with `item_type === 'place'`.
- Prefer explicit valid `lat`/`lon` if present in the source.
- Otherwise geocode `location_query` first, then `address`, then `title + trip destination context`.
- Store coordinates/place_id on successful geocode.
- If geocoding fails, still import the item without coordinates and include the address/query in notes so it is not lost.

Address preservation:

- Since `itinerary_items` has no address column, append source address/location query to notes only when geocoding fails, e.g. `Address: ...`.
- Do not duplicate the address if it is already present in notes.
- Always keep brief descriptive text from the source in notes when useful. Address preservation is conditional; descriptive notes are part of the candidate.

Duplicate detection:

- Before preview/import, compare candidates against existing itinerary items for the trip.
- Use simple normalization for V1: lowercase, trim punctuation/extra whitespace, compare title equality and strong substring matches.
- Also consider location query/address overlap when available.
- Flag likely duplicates in the preview with a warning and leave them selected or unselected by product choice; conservative default should probably be unselected.
- Do not block duplicates outright. The user should be able to import anyway.

## Server Actions

Add two actions in `src/routes/trips/[id]/+page.server.ts`:

### `itin-extract`

Input:

- `text`

Output:

- `{ ok: true, candidates }` or failure with message.

Behavior:

- Require owner role through existing mutation guard.
- Call `extractItineraryFromText(text)`.
- Compare extracted candidates against existing itinerary items and return duplicate flags.
- Return candidates only; no DB writes.

### `itin-import-candidates`

Input:

- selected candidate payload from preview
- optional `parent_id`
- `geocode` boolean

Output:

- `{ ok: true, imported: n }` or validation failure.

Behavior:

- Re-validate all selected candidates server-side.
- Assert parent belongs to trip when provided.
- Import transactionally.
- Invalidate/reload on success.

## Client UI

In the Places section, add a new `<details>` block near "Paste many":

### Input State

- Label: "Import itinerary from text"
- Textarea for pasted rough itinerary/place text.
- Optional helper text: "Paste AI output, notes, web text, or bullets. You'll review before importing."
- Button: "Extract places"
- V1 source: pasted text only.

### Candidate Preview

After extraction:

- Show candidate count.
- Show an indented preview tree.
- Each row has:
  - checkbox include/exclude
  - editable `item_type`
  - editable title
  - editable date when relevant
  - editable notes
  - editable location query/address
  - external URL field when present
  - duplicate warning when the candidate resembles an existing itinerary item
- Controls:
  - Select all / none
  - Import under dropdown, visually encouraged when day/section parents exist
  - Geocode places checkbox, default ON
  - "Import N items"

Candidate preview should be editable enough that a model mistake does not require starting over.

### UX Notes

- Keep the existing simple "Paste many" flow. It is still useful for quick same-type item entry.
- The LLM import is for richer freeform material, not a replacement for quick add.
- Use "Extract" language before DB writes and "Import" only for the final save.
- Surface failures gently: "Could not extract itinerary candidates. Try simplifying the text or add places manually."

## Help Page Update

Update `src/routes/help/+page.svelte`:

- Add a short "Import itinerary from text" subsection under Places.
- Explain that rough pasted text is accepted.
- Explain review-before-import.
- Explain that V1 extracts a mostly flat list and users can import under a day/section.
- Explain that geocoding is best-effort and can be corrected via each place's location editor.
- Do not document a JSON schema as the primary workflow.

## Verification

- `npm run check`
- `npm run build`
- Extract from rough Gemini/ChatGPT prose.
- Extract from bullets.
- Extract from Markdown headings and nested bullets.
- Extract from messy copied web text.
- Test no candidates / bad text.
- Test import top-level and under an existing day/section.
- Test geocoding on/off.
- Test failed geocode still imports item.
- Test failed geocode appends address/location query to notes.
- Test descriptive source text appears in notes.
- Test duplicate-ish candidates are flagged and can be deselected before import.
- Verify viewer cannot extract/import.
- Deploy + health check.

## Resolved V1 Decisions

1. The task should be treated as "Freeform itinerary import with preview + geocoding," not JSON import.
2. V1 supports pasted text only. Importing from existing documents is deferred.
3. V1 uses conservative flat extraction. Day/section hierarchy inference is deferred except for trivial, explicit structure.
4. The UI should encourage importing under an existing day/section, while still allowing top-level import.
5. Possible duplicates should be flagged in preview.
6. Extracted addresses/location queries should be appended to notes only when geocoding fails.
7. Brief descriptive source text should be included in notes when useful.
8. Do not ask the LLM for final coordinates unless the source explicitly provides them. Let geocoding own coordinates.
9. Include trip context in the extractor call, e.g. trip name + dates + notes, so a place like "Arborvine" can become "Arborvine, Blue Hill, ME" without the user typing the town repeatedly.

## Future Tasks

1. Add extraction from already-uploaded text/PDF/image documents using the attachment-source pattern from reservations/expenses.
2. Add richer day/section hierarchy inference once flat extraction is solid.
3. Add stronger duplicate matching using coordinates/place IDs after geocoding.
