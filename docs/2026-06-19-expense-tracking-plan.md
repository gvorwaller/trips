# Plan: Expense Tracking Section (td-627abc)

## Context

The trips app needs a way to track rough trip costs — before, during, or after a trip. This isn't a full accounting system; it's meant to give a close idea of total spend. Users should be able to manually enter expenses (date, description, amount) and optionally extract multiple transactions from pasted bank statement text or uploaded document screenshots via LLM. Expenses can optionally reference an already-uploaded document (receipt, statement).

**Mockup**: `docs/mockups/expenses.html` — open in browser to review 5 UI states (populated, collapsed, add form, extraction candidates, viewer mode).

## Implementation

### 1. Migration: `backend/db/migrations/0005_expenses.sql`

```sql
CREATE TABLE expenses (
    id            SERIAL PRIMARY KEY,
    trip_id       INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    expense_date  DATE,
    description   TEXT NOT NULL,
    amount_cents  INTEGER NOT NULL CHECK (amount_cents >= 0),
    category      TEXT NOT NULL DEFAULT 'other'
                    CHECK (category IN ('lodging','food','transport','activities','other')),
    attachment_id INTEGER REFERENCES attachments(id) ON DELETE SET NULL,
    notes         TEXT,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX expenses_trip_idx ON expenses(trip_id, sort_order);
```

**Key decisions:**
- `amount_cents INTEGER` avoids the pg NUMERIC-returns-string gotcha. Format at the edge.
- `attachment_id` FK on expense (not expense_id on attachments) — expense *references* a doc, doesn't own it. `ON DELETE SET NULL` so deleting a doc just clears the link.
- Categories: `lodging`, `food`, `transport`, `activities`, `other` — enables subtotals.
- USD only — no currency column.
- Category subtotals shown above grand total (compact badge row).
- "Save pasted text as document" checkbox offered but defaults unchecked.

### 2. Server module: `src/lib/server/expenses.ts` (new)

Pattern: mirror `reservations.ts`. Functions:

| Function | Purpose |
|---|---|
| `listExpenses(tripId)` | SELECT ordered by `sort_order, id` |
| `createExpense(tripId, input)` | withTransaction: MAX(sort_order)+1, INSERT |
| `updateExpense(tripId, id, input)` | UPDATE with updated_at |
| `deleteExpense(tripId, id)` | DELETE |
| `moveExpense(tripId, id, direction)` | Swap sort_order with neighbor (same as `moveReservation`) |
| `bulkCreateExpenses(tripId, inputs[])` | withTransaction: sequential INSERTs for extraction results |
| `parseExpenseForm(form)` | Validate description (required), parse amount, validate category |
| `parseAmount(raw)` / `formatAmount(cents)` | Strip `$,` → cents; cents → `$X.XX` |

Types: `Expense`, `ExpenseInput`, `ExpenseCategory`, `EXPENSE_CATEGORIES`

### 3. Server module: `src/lib/server/expense-extract.ts` (new)

Pattern: mirror `reservation-extract.ts` but return an **array**.

- Model: `ANTHROPIC_EXPENSE_MODEL ?? 'claude-sonnet-4-20250514'` (cheaper for tabular parsing)
- `max_tokens: 4096` (bank statements can have many rows)
- Tool: `submit_expenses` with `expenses: Array<{ expense_date, description, amount, category, notes }>`
- System prompt instructs: extract debits/charges, YYYY-MM-DD dates, clean merchant names, infer category, order by date
- Two entry points: `extractExpensesFromText(text)` and `extractExpensesFromDocument(ownerId, attachmentId)`
- Returns `ExtractedExpense[] | null` (null = API key missing or call failed)

### 4. Server actions in `+page.server.ts`

Add to imports and `Promise.all` in `load`, return `expenses` in load data.

| Action | Behavior |
|---|---|
| `exp-add` | Parse form → `createExpense` |
| `exp-edit` | Parse form → `updateExpense` |
| `exp-delete` | `deleteExpense` |
| `exp-move` | Parse direction → `moveExpense` |
| `exp-extract` | source=text or source=document → returns `{ ok, candidates[] }` |
| `exp-bulk-add` | JSON array from form → `bulkCreateExpenses` |

### 5. UI in `+page.svelte`

New section after Documents, before Trip actions.

**State variables:**
- `expenseTotal` — `$derived` sum of `data.expenses` amount_cents
- `expDraft` — form state for manual add
- `expCandidates` — `$state<Array<ExtractedExpense & { selected: boolean }>>([])`
- `expExtracting`, `expExtractMsg`, `expExtractText`, `expExtractDocId`

**Section structure:**
- Collapsible header with total always visible: `toggleSection('expenses')`, total in `<span class="expense-total">`
- Expense list: category badge + description + date/notes + linked doc chip + amount (right-aligned) + ↑↓✕ controls (owner only)
- Category subtotals row + total row at bottom
- `<details>` Add expense (owner only):
  - Extract from text block (textarea + "Also save as document" checkbox, defaults unchecked)
  - Extract from document block (select dropdown of extractable attachments)
  - Candidate review area (checkboxes, editable category, select all/none, "Add N expenses" button)
  - Manual entry form (date, category, description, amount, link-document dropdown, notes)
- Viewer mode: list + total only, no controls

### 6. Supporting changes

**`src/lib/server/clone.ts`** — Add expenses duplication in `duplicateTrip`. Flat copy of description/amount/category/notes/sort_order. Don't copy `attachment_id` (docs aren't cloned).

**`src/lib/server/search.ts`** — Add `'expense'` to `HitKind`, add `UNION ALL` searching `expenses.description`.

**`src/routes/help/+page.svelte`** — Add Expenses section to help doc.

### 7. Implementation order

1. Migration (`0005_expenses.sql`)
2. `expenses.ts` (CRUD + helpers)
3. `expense-extract.ts` (LLM)
4. `+page.server.ts` (load + 6 actions)
5. `+page.svelte` (section UI + state + extraction flow)
6. `clone.ts`, `search.ts`, help page

## Verification

- `npm run check` — zero errors/warnings
- `npm run build` — clean build
- Run migration locally, test CRUD via browser
- Test extraction with pasted bank statement text
- Test extraction from uploaded screenshot
- Verify viewer mode has no controls
- Verify collapse/expand persists, total shows when collapsed
- Verify print expands expenses section
- Verify duplicate trip copies expenses
- Verify search finds expense descriptions
- Deploy via `./scripts/deploy-to-DO.sh`, check `/api/health`
