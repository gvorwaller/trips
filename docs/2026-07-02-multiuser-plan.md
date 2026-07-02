# Multi-user support plan (td-d3af9d)

**Task:** td-d3af9d — "Add multi-user support. Implement multi-user support following the birds app
pattern (argon2id password hashing, cookie sessions, owner_user_id scoping on all tables and
queries). Add user account for Caleb."

**User direction (2026-07-02):** mirror birds' user management for the admin — the admin-only
Users panel in `/settings` (list all accounts, create any account, reset any password), including
birds' three-role model. Per-user AI cap acknowledged as a useful follow-up if the app gains steam,
not V1.

**Also in this sprint:** td-22eaf9 — revise the in-app Help doc, tutorial-style, geared to new
users, with expandable sections; the **photos app's HelpScreen is the model**
(`gaylonphotos/src/lib/components/common/HelpScreen.svelte`). Sequenced after the multiuser phases
so the help text is written once against the new role model (Caleb is exactly the "new user" the
tutorial is for).

---

## 1. Where the app already is (verified against the code, 2026-07-02)

The good news: most of what td-d3af9d's description asks for **already exists**. Argon2id hashing,
cookie sessions, and owner scoping were built in Phase 1 (td-dad0b3) and are live:

- `users` table with `role IN ('owner','viewer')`, argon2id hashes (`src/lib/server/auth.ts`).
- `sessions` table + `validateSession()` join (`src/lib/server/session.ts`).
- Only two tables carry `owner_id` directly: `trips` and `packing_templates`. Every other table
  (itinerary_items, packing_*, reservations, attachments, expenses, day_plans, …) hangs off
  `trip_id`, and every route/action verifies ownership through `ownTrip()`/owner-filtered joins.
- Every server load/action consumes `event.locals.ownerId` (~70 call sites), never a hardcoded id.

**The single point that makes the app single-user** is `getOwnerId()` in `auth.ts`:

```ts
let cachedOwnerId: number | null = null;
// SELECT id FROM users WHERE role = 'owner' ORDER BY id LIMIT 1  — cached for process lifetime
```

`hooks.server.ts` sets `locals.ownerId = await getOwnerId()` for **every** logged-in user, so all
accounts share the first owner's data, and the viewer implicitly views that same first owner.

So the core change is small and surgical: **derive `locals.ownerId` from the session user instead
of a global singleton**, adopt birds' role model, port birds' admin Users panel, and run an
isolation audit. The ~70 `locals.ownerId` call sites don't change at all — that's the payoff of
the existing design. The `'owner'` role literal appears in 5 type declarations + the settings
guards on the server side, but also leaks into UI copy, the help page, and scripts
(`+layout.svelte`'s viewer tag, `help/+page.svelte`'s "Owner vs. viewer", `create-user.mjs`,
the Safari helper) — the rename is still small, but Phase 2 includes an explicit
`rg -n "owner|viewer" src scripts docs` sweep so no stale copy survives. *(Codex review finding.)*

## 2. Target model (birds parity)

Adopted directly from birds (`birds/src/routes/settings/+page.server.ts`, `birds/src/lib/server/auth.ts`):

- **Three roles:** `admin` | `user` | `viewer` (today: `owner` | `viewer`).
  - `admin` (Gaylon): a full data-owning account **plus** the Users panel in `/settings`.
  - `user` (Caleb): a full data-owning account — own trips, templates, AI features; no user
    management.
  - `viewer` (wife): read-only view of one chosen account's trips (packing check-off + day-plan
    visited exceptions unchanged), linked via **`views_user_id`** (birds' column name, adopted
    for cross-repo consistency).
- **Hard-partitioned data.** Each admin/user account sees only its own trips and packing
  templates. Caleb sees none of Gaylon's data and vice versa.
- **User management is admin-only, in-app** (birds pattern: "provision family accounts"):
  list all users, create any account (viewer creation picks which account it views, defaulting to
  the creating admin), reset any password. No self-signup. Multiple viewers per account allowed
  (birds doesn't restrict it; no artificial unique index).
- `scripts/create-user.mjs` stays as the break-glass/bootstrap path but the panel is the normal way.

**Admin trust model (explicit, per Codex review):** the admin is a global superuser. "Reset any
password" is impersonation capability — an admin can log in as anyone by resetting their password.
That is the intended trust level for family provisioning (and matches birds), but it's a property
of the design, not an accident: state it in the plan (here), in the Users panel UI copy, and in
the help doc's Accounts section.

**Explicit non-goals (possible follow-ups, not V1):** sharing a trip between accounts, email-based
password reset, per-user AI/API budgets (revisit if the app gains steam), account deletion UI.

## 3. Phases

### Phase 1 — Schema: roles + viewer link (`0011_multi_user.sql`)

One migration, applied via `backend/db/migrate_pg.sh` as always (wrapped in a transaction):

1. `ALTER TABLE users ADD COLUMN views_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;`
2. Role migration: drop the old CHECK; `UPDATE users SET role = 'admin' WHERE role = 'owner'`
   (today there is exactly one owner — Gaylon; any future data-owning accounts are created as
   `user`); add `CHECK (role IN ('admin', 'user', 'viewer'))`.
3. Backfill: point every existing `role='viewer'` row at the admin
   (`UPDATE users SET views_user_id = (SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1) WHERE role='viewer';`).
4. Integrity: `ALTER TABLE users ADD CONSTRAINT users_views_matches_role CHECK ((role = 'viewer') = (views_user_id IS NOT NULL));`
   — only and always viewers have it. (Order matters: constraint after backfill.)
5. **Cross-row integrity trigger** *(Codex review finding: the CHECK alone allows viewer→viewer,
   viewer→self, and role edits that orphan data)*. A CHECK can't reference other rows, so add a
   `BEFORE INSERT OR UPDATE ON users` trigger (precedent: migration `0010`'s touch triggers):
   - `views_user_id` must reference a row whose role is `admin` or `user`, and must not equal
     `NEW.id`.
   - Block changing an account's role **to** `viewer` while it owns rows in `trips` /
     `packing_templates` or is the target of any `views_user_id` — the only path to
     "trips owned by a viewer" is a manual role edit, and this closes it at the DB layer, not
     just in app code (the Users panel doesn't offer role editing at all).
   The same rules are re-checked in the `users-create` action and `create-user.mjs` for friendly
   error messages; the trigger is the backstop. Tests insert each invalid shape via raw SQL and
   assert the trigger rejects it.

No changes to any other table — `trips.owner_id` / `packing_templates.owner_id` already exist with
indexes and stay named as-is (they point at the owning admin/user account).

### Phase 2 — Auth core: kill the singleton

- **Delete `getOwnerId()` and its module-level cache** from `auth.ts`. With multiple data-owning
  accounts a process-lifetime cached "the owner" is not just obsolete, it's a bug.
- Role type unions (`app.d.ts`, `auth.ts`, `session.ts`, `users.ts`) become
  `'admin' | 'user' | 'viewer'`.
- `validateSession()` additionally selects `u.views_user_id` so the hook needs no second query.
- `hooks.server.ts`:
  ```ts
  locals.ownerId = user.role === 'viewer' ? user.views_user_id : user.id;
  ```
  The viewer read-only gating already keys off `role === 'viewer'` and is unchanged. A viewer with
  `views_user_id = NULL` can't exist post-constraint, but guard with a 500 anyway.
- `app.d.ts`: update the `ownerId` doc comment ("the account whose trips this session reads: self
  for admin/user, the linked account for viewers"). The property name stays `ownerId`, so **zero**
  route/lib call sites change.
- The `if (!locals.ownerId) throw error(500, 'No owner configured')` guards in routes stay as-is —
  same semantics, now per-session.
- **Rename sweep:** `rg -n "owner|viewer" src scripts docs` and reconcile every hit — server
  types/guards, `+layout.svelte`'s viewer tag, help copy, `create-user.mjs`, the Safari helper —
  so no UI string or script still says "owner" for a concept that is now admin/user.

### Phase 3 — Settings: birds-style admin Users panel

Port the birds pattern (`create_user` / `set_user_password` actions + user list in load) into
trips' settings conventions (component-scoped CSS, modal confirms, section-keyed `fail()` shapes):

- **Load:** everyone non-viewer gets their existing profile + own-password sections. If
  `role === 'admin'`, additionally return all users
  (`id, username, display_name, role, views_user_id, last_login_at ORDER BY id`).
- **`users-create` action (admin-only):** username (same `[a-z0-9._-]{2,60}` rule already used),
  display name, role picker (admin/user/viewer), password + confirm (existing 8–200 rule). For
  viewers, a "views whose trips" picker over admin/user accounts, defaulting to the creating
  admin. Uniqueness via the existing `usernameTaken()`.
- **`users-set-password` action (admin-only):** pick user, new password + confirm; no current
  password required (admin reset); `destroyUserSessions(targetId)` afterward — an improvement over
  birds, which doesn't invalidate sessions on admin reset, and consistent with trips' existing
  viewer-password action.
- **Retire the old `viewer-*` actions and section** — superseded by the panel (they only worked
  for the single global viewer anyway). `users.ts` keeps profile/password helpers; `getViewer()` /
  `createViewer()` are replaced by the panel's queries.
- **Hooks note:** `/settings` stays blocked for viewers (already the case); admin/user both reach
  it, only admin sees the Users section (guarded in load *and* per-action, as today).
- `scripts/create-user.mjs`: update roles to admin/user/viewer; viewer role requires
  `--views <username>` (fail loudly if omitted or target isn't admin/user). Keep idempotent upsert.

### Phase 4 — Isolation audit + tests (the real work)

The scoping design is sound, but this phase assumes nothing and verifies every path with a
three-account fixture (admin A, user B, viewer of A):

- **Real-DB integration tests, not mocks** *(Codex review finding: existing tests all mock
  `$lib/db`, which proves nothing about SQL owner filters)*. Isolation tests run against the real
  test cluster (15437): a new `*.dbtest.ts` convention with its own vitest config and npm script
  (e.g. `npm run test:db`), guarded by `TRIPS_ENV=test` exactly like the Safari helper — refuses
  to run otherwise. Fixtures self-provision the three accounts + a trip each and clean up in
  `afterAll`. The existing mocked unit tests stay as-is for logic coverage.
- **Coverage:** each server module's owner filter — `getTrip`, `listTrips`, template list/apply,
  search, clone/duplicate, attachments lookup, day-plan and packing PATCH helpers, expenses, and
  the place-workspace actions (`save`/`clear`/`link-place`/`ask-ai`/`refresh-details`). Every test
  asserts account B gets a miss/404/false for A's ids, and that viewer-of-A resolves A's data
  (not B's). Plus settings-panel authorization tests (user B calling `users-create` /
  `users-set-password` → 403) and the Phase 1 trigger rejection cases.
- **Manual/route-level:** logged in as B, enumerate **every** route under `/trips/[id]/**` with
  A's ids and confirm 404/403. Named explicitly so none get skipped: the trip page, edit, the
  place workspace, the attachment download proxy **and the attachment view page**
  (`attachments/[attId]/view`), the **packing print page** (`packing/print`), day plans, and the
  two viewer-exception PATCH endpoints (`/api/packing/check`, `/api/dayplan/visited`) — the
  raw-id-reachable GET surfaces are the highest-risk leaks, and the view/print pages are the ones
  a casual sweep misses *(Codex review finding)*.
- **Cache-key privacy fix** *(Codex review finding: the plan's "api_cache holds no per-user data"
  claim was wrong)*. `placesTextSearchCached()` embeds the raw query — a trip item title — in
  `cache_key` (`place-text:…:{query}`, `geocode.ts:105`). All other keys are id- or
  coordinate-based and genuinely non-personal (`place-details:{place_id}`, `weather:{lat}:{lng}`,
  `places:{lat}:{lng}:…`). Fix: hash the query portion of text-derived keys
  (`sha256(query).slice(0, 16)`) — plaintext trip titles stay out of the table while identical
  queries still share one cache row across users. Payloads are Google's own place results, not
  user data, so shared payloads remain fine.
- **Safari QA helper** (`scripts/safari-smoke-place-workspace.mjs`): remove the canonical-owner
  workaround — the multiuser change is exactly what fixes the 404 it works around (the `safari_qa`
  account's trips become visible to itself). The script gets simpler; verify it still passes twice
  in a row (idempotency), per its own convention.
- With the cache-key fix above, `api_cache` stays shared across users **deliberately**: payloads
  are Google/weather responses keyed by place-id/coords/hashed-query, and sharing is an efficiency
  win. Note it in code so a future audit doesn't "fix" it.

### Phase 5 — Help revamp (td-22eaf9, photos-app model)

What the photos model actually is (read from `HelpScreen.svelte`): an **accordion tutorial** —
one section open at a time, each toggle a full-width button with an icon, title, and ▸/▾ chevron;
a friendly welcome intro up top; tutorial voice throughout ("Tap any collection card to open it");
big features get `h4`-structured walkthroughs and small per-concept cards inside their section.

Adaptation for trips (keep the `/help` **route** — deep-linkable, already wired into the hamburger
menu and printable — rather than photos' modal overlay; the accordion pattern ports directly):

- **Structure:** welcome intro, then accordion sections. Planned set:
  1. **Getting started** (new — the tutorial spine: create a trip → add a day → add places →
     indent them under the day → set locations → build a packing list; written as a first-run
     walkthrough, not reference prose)
  2. Trips & dates
  3. Places / itinerary (absorbs Paste many, text import, Apple Maps import, collapsing)
  4. The place workspace (new — Known Details, link-a-Google-match, Refresh, AI summary,
     **Ask AI** and what it will/won't answer — none of this is in help today)
  5. Day Plans
  6. Packing & templates
  7. Reservations, Documents & Expenses
  8. Printing
  9. **Accounts & roles** (rewritten for the new model: admin/user/viewer, who sees whose trips,
     what viewers can still do, where the Users panel lives)
- **Mechanics:** single `openSection` state like photos; support `#section` hash deep-links (open
  that section on load) so other pages can link straight to e.g. `/help#place-workspace`.
  All sections force-expanded under `@media print`, matching the app's print convention.
- **Conventions kept:** component-scoped CSS (adapt photos' accordion styles to trips'
  `mockup.css` variables), ≥48px toggle tap targets, ≥16px text, AAA contrast, no new deps.
- **Content audit while rewriting:** the current help predates the place workspace, Ask AI,
  Apple Maps import, and search — reconcile every section against the live UI rather than
  editing the old text in place.
- **Repo-doc reconciliation** *(Codex review finding: future agents follow the "hard rules" in
  these files, and after this sprint the rules lie)*:
  - `CLAUDE.md` — the Locked-stack auth line ("Two roles: `owner` (full access) and `viewer`")
    becomes the three-role model with a pointer to this plan.
  - `docs/trip-planner-V3-FINAL-plan.md` — V3 is a historical locked plan, so don't rewrite it;
    add a short dated **amendment note** at the top: roles are now admin/user/viewer, multi-user
    is in scope as of td-d3af9d, superseding the "owner + viewer" framing and the V1 non-goals
    line. (`docs/cs.md` doesn't exist yet, so there's nothing to fix there — verified.)

### Phase 6 — Prod rollout (Caleb)

Sequenced per the confirm-before-prod-writes convention — each prod step shown, then explicit OK:

1. `scripts/backup-pg.sh` on the droplet (pre-migration snapshot).
2. Apply `0011` on prod via `migrate_pg.sh`; verify Gaylon's row is `admin` and the wife's viewer
   row got `views_user_id = <gaylon-id>`.
3. Deploy (`deploy-to-DO.sh`), health check.
4. Create Caleb from the settings Users panel (role `user`) — dogfoods the new panel instead of
   the script.
5. Live verification: log in as Caleb → empty trips list; fetch one of Gaylon's trip URLs → 404;
   Gaylon's login unchanged (now admin, sees Users panel); wife's login still shows Gaylon's trips.

**Cost note (accepted, not blocking):** Caleb's use of Ask-AI, place details, and geocoding bills
the shared Anthropic + Google keys. Current per-call guards (500-char question cap,
disable-while-pending, 18h/60min caches) are the only throttle — fine at family scale. A per-user
daily AI cap is the agreed follow-up if the app gains steam.

## 4. Verification checklist (pre-commit, per repo convention)

- `npm run check` (0 warnings), `npm test` (85 existing + new isolation suite), `npm run build`,
  `git diff --check`.
- Migration applied on the test cluster (15437) via `migrate_pg.sh`; constraints **and trigger**
  verified with real `psql` (`\d users`; viewer without `views_user_id` → fail; `user` with one →
  fail; old `owner` role rejected; viewer→viewer link → fail; viewer→self → fail; role edit to
  `viewer` on an account that owns trips or is viewed → fail).
- `npm run test:db` (new real-DB isolation suite) green against the test cluster.
- `rg -n "owner|viewer" src scripts docs` sweep re-run at the end — every remaining hit is
  intentional (e.g. `trips.owner_id` column references).
- Manual browser QA in Chrome + Safari with three accounts (admin A, user B, viewer of A),
  including the Users panel create/reset flows with modal confirms.
- Help page QA at mobile width (<640px): accordion toggles ≥48px, hash deep-links open the right
  section, print preview shows all sections expanded, content spot-checked against the live UI.
- Dev-server gotcha reminder: `ANTHROPIC_API_KEY` is blanked in Claude-Code-spawned shells; prefix
  the key explicitly when QA-ing Ask-AI.

## 5. Effort estimate

| Phase | Size |
|---|---|
| 1 — migration | small-medium (~25 lines of SQL + the integrity trigger) |
| 2 — auth core | small (5 files touched + rename sweep, net negative LOC) |
| 3 — settings Users panel | medium (new section UI + 2 actions, ported from birds) |
| 4 — audit + tests | **the bulk** — medium-large (real-DB test harness + ~25 tests + cache-key fix + manual sweep) |
| 5 — help revamp (td-22eaf9) | medium (mostly writing; accordion component is a straight port) |
| 6 — prod rollout | small, gated on explicit per-step confirmation |

Phases 1–5 land as one reviewable branch (multiuser closes td-d3af9d, help closes td-22eaf9);
Phase 6 is operational.
