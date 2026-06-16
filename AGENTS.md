# AGENTS — trips

## Start here
1. Read **`cs.md`** — hard rules (infra, DB, auth, attachments, CSS) that override defaults.
2. Read **`docs/trip-planner-V3-FINAL-plan.md`** — the authoritative design and phased roadmap (V1/V2 docs are superseded).
3. Review `docs/mockups/` and recent `docs/devlog/` entries.

## MANDATORY: Use `td` for task management
Run `td usage --new-session` at conversation start (or after `/clear`) to see current work.
Use `td usage -q` for subsequent reads.

## Quick reference
- Dev: `npm run dev` (port 5179). Test DB + app: `npm run test:db:up` then `npm run dev:test`.
- Before commit: `npm run check` && `npm run build`. Only commit when asked.
- Migrations: add `backend/db/migrations/NNNN_*.sql`, apply with `npm run migrate`. Never inline DDL.
- Verify against real `psql` (prod 5437 / test 15437), browser devtools, and `curl /api/health`.
