# trips.gaylon.photos

A private, mobile-first trip planning web app for one owner and one read-only viewer. Built around CarbonFin-style nestable outliners for packing lists and itineraries, with Google Maps integration, document attachments, LLM-powered extraction, and expense tracking.

## Stack

- **SvelteKit 2** + Svelte 5 (runes) + TypeScript
- **PostgreSQL** via `pg` (node-postgres) — no ORM
- **DO Spaces** (S3-compatible) for attachment storage
- **Anthropic API** for itinerary, reservation, and expense extraction
- **Google Maps** for place search, geocoding, and map pins; **Routes API v2** (server-side) for day-plan driving legs and route optimization
- **argon2** password hashing + session cookies
- Component-scoped CSS (no utility frameworks)
- `@sveltejs/adapter-node` deployed with PM2

## Features

- **Itinerary** — nestable outliner with item types: place, day, section, note. Places get map pins, one-tap Google/Apple/directions links, optional dates (with a per-trip Schedule page), and visited check-off with an "X / Y visited" roll-up. Multi-stop day routes. Freeform text, Maps URL, photo, and Birds imports (with a per-trip picker) extract candidate places/notes for review before saving.
- **Day plans** — ordered driving routes through itinerary places, with a lodging anchor (closed-loop totals include the drive home), server-side leg distances and route optimization (cached; deterministic), per-stop weather, AI visit notes and nearby-stop suggestions, duplication, and per-plan export (text for Messages, print/PDF, `.ics` calendar event). Plan cards start collapsed and remember their fold state per trip.
- **Packing** — nestable lists with check-off tracking, progress bars, templates, paste-many. Packing-only print.
- **Reservations** — accommodation, flight, restaurant, transport, other. LLM extraction from pasted confirmations or uploaded documents. Manual reorder.
- **Expenses** — manual entry or LLM extraction from bank statements / receipt screenshots. Category subtotals (lodging, food, transport, activities, other) and running total.
- **Documents** — upload PDFs/images (up to 30 MB), in-app viewer, iOS-safe download. Optional display names. Linkable from reservations and expenses.
- **Search** — global ILIKE across trips, places, packing, reservations, documents, expenses; hits from archived trips are badged.
- **Clone** — duplicate a trip with all nested data (checked/visited state reset).
- **Archive** — move a finished trip into a collapsed Archived section; still fully readable, editable, and searchable.
- **Export** — whole-trip text/Markdown (places, day plans, reservations, packing; expenses and attachment contents deliberately omitted) plus the per-day-plan exports above.
- **Collapsible sections** — per-trip state persisted in localStorage.
- **Print** — full trip or packing-only, auto-expands collapsed sections.
- **Three roles** — `admin` (own data + user management), `user` (own data), `viewer` (read-only view of one account; can toggle packing checkboxes and visited flags, and use every export).
- **Accessibility** — ≥44px tap targets app-wide (WCAG 2.5.5 AAA / Apple HIG), enforced by a Safari-driven audit script (`npm run test:safari:tap-targets`).

## Project structure

```
backend/db/migrations/    Raw SQL migrations (applied via migrate_pg.sh)
scripts/                  Deploy, backup, test DB lifecycle
src/
  lib/
    components/           Svelte components (MapPicker, DatePicker, etc.)
    server/               Server-only modules (CRUD, auth, storage, extraction)
    db.ts                 Pool + query<T>() + withTransaction
    filevalidate.ts       Magic-byte file type detection
    google-maps.ts        Maps API lazy loader
  routes/
    api/                  health, geocode, check-off, route-directions endpoints
    help/                 In-app help page
    login/                Auth
    search/               Global search
    settings/             User/password management
    trips/                Trip CRUD, itinerary, packing, attachments, expenses
```

## Setup

### Prerequisites

- Node.js 20+
- PostgreSQL 16+ (dedicated cluster recommended)
- DO Spaces bucket (or S3-compatible)
- Google Maps API key (with Geocoding + Maps JavaScript API)
- Anthropic API key (for LLM extraction features)

### Environment

Copy `.env.example` (or create `.env`) with:

```
PGHOST=127.0.0.1
PGPORT=5437
PGDATABASE=trips
PGUSER=trips_app
PGPASSWORD=<runtime-db-password>
MIGRATION_PGUSER=trips_owner
MIGRATION_PGPASSWORD=<migration-db-password>
AUTH_SECRET=<random-secret>
PUBLIC_GOOGLE_MAPS_API_KEY=<key>
PUBLIC_GOOGLE_MAPS_MAP_ID=<map-id>
GOOGLE_GEOCODING_KEY=<server-key>
SPACES_KEY=<key>
SPACES_SECRET=<secret>
SPACES_BUCKET=<bucket>
SPACES_REGION=sfo3
SPACES_ENDPOINT=https://sfo3.digitaloceanspaces.com
ANTHROPIC_API_KEY=<key>
BIRDS_API_BASE_URL=<http://127.0.0.1:5178 for local test, http://127.0.0.1:3003 in prod>
BIRDS_API_TOKEN=<shared-token-matching-Birds>
BIRDS_API_USERNAME=<optional-default-birds-username>
```

`BIRDS_API_TOKEN` must match `BIRDS_TRIPS_API_TOKEN` in the Birds app. Production uses loopback routing (`http://127.0.0.1:3003`) because both apps run on the same droplet; use the public Birds URL only if the apps are no longer co-located.

### Database

```bash
# Create the cluster and database, then run migrations:
./backend/db/migrate_pg.sh

# Create the owner user:
node scripts/create-user.mjs
```

### Development

```bash
npm install
npm run dev          # http://localhost:5179
```

For the isolated test stack:

```bash
npm run test:db:up
npm run dev:test     # http://127.0.0.1:5179, reads .env.test
```

### Build and deploy

```bash
npm run check        # svelte-check (0 errors, 0 warnings)
npm run build        # production build
./scripts/deploy-to-DO.sh   # push, build, migrate, PM2 reload, health check
```

## Infrastructure

Runs on a shared DO droplet alongside sibling apps:

| App | Port | PG Port |
|-----|------|---------|
| birds | 3003 | 5436 |
| trips | 3004 | 5437 |

Health endpoint: `GET /api/health` returns `{"db":"ok","version":"<git-sha>"}`.

### Birds import

Trips can fetch birding trip stops from the sibling Birds app into the itinerary import review flow. The import writes selected rows to the existing `itinerary_items` table with `item_type='place'`; Birds provenance is stored in `itinerary_items.meta`.

The Trips server calls:

```
GET ${BIRDS_API_BASE_URL}/api/internal/trip-places
Authorization: Bearer ${BIRDS_API_TOKEN}
```

Duplicate detection runs in preview and again at write time. It checks fuzzy title, Google place id, Birds source id stored in `meta`, and coordinates within 30 meters.

### Operational logs

PM2 captures app stdout/stderr:

```bash
ssh root@134.199.211.199 'pm2 logs trips --lines 200 --nostream'
ssh root@134.199.211.199 'grep "\[birds-places-import\]" /var/log/pm2/trips.*.log | tail -100'
```

Birds import attempts emit token-free structured JSON lines with prefix `[birds-places-import]`. Each attempt has a `request_id`; Birds logs the same id under `[trip-places-export]`, so cross-app failures can be correlated:

```bash
ssh root@134.199.211.199 'grep "REQUEST_ID_HERE" /var/log/pm2/trips.*.log /var/log/pm2/birds.*.log'
```

### Backups

- `scripts/backup-pg.sh` captures local/prod PostgreSQL snapshots, including attachment metadata and Spaces object keys.
- Attachment bytes live in the private `gaylon-trips` DO Spaces bucket.
- The Synology NAS pulls that bucket directly via rclone remote `do-trips` to `/volume3/gaylon-trips-spaces-backup/current`.
- NAS schedule: daily pull at `03:30`, daily Btrfs snapshot at `04:30`.
- Operational details, status files, and restore-drill notes live in `docs/nas-spaces-backup.md`.

## Migrations

Raw SQL files in `backend/db/migrations/`, applied in order by `migrate_pg.sh`. Tracked in `admin.schema_migrations`. Never use inline DDL or raw `psql -f`.

## License

Private.
