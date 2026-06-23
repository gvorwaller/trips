# trips.gaylon.photos

A private, mobile-first trip planning web app for one owner and one read-only viewer. Built around CarbonFin-style nestable outliners for packing lists and itineraries, with Google Maps integration, document attachments, LLM-powered extraction, and expense tracking.

## Stack

- **SvelteKit 2** + Svelte 5 (runes) + TypeScript
- **PostgreSQL** via `pg` (node-postgres) — no ORM
- **DO Spaces** (S3-compatible) for attachment storage
- **Anthropic API** for itinerary, reservation, and expense extraction
- **Google Maps** for place search, geocoding, and map pins
- **argon2** password hashing + session cookies
- Component-scoped CSS (no utility frameworks)
- `@sveltejs/adapter-node` deployed with PM2

## Features

- **Itinerary** — nestable outliner with item types: place, day, section, note. Places get map pins and one-tap Google/Apple/directions links. Multi-stop day routes. Freeform text import extracts candidate places/notes for review before saving.
- **Packing** — nestable lists with check-off tracking, progress bars, templates, paste-many. Packing-only print.
- **Reservations** — accommodation, flight, restaurant, transport, other. LLM extraction from pasted confirmations or uploaded documents. Manual reorder.
- **Expenses** — manual entry or LLM extraction from bank statements / receipt screenshots. Category subtotals (lodging, food, transport, activities, other) and running total.
- **Documents** — upload PDFs/images (up to 30 MB), in-app viewer, iOS-safe download. Optional display names. Linkable from reservations and expenses.
- **Search** — global ILIKE across trips, places, packing, reservations, documents, expenses.
- **Clone** — duplicate a trip with all nested data.
- **Collapsible sections** — per-trip state persisted in localStorage.
- **Print** — full trip or packing-only, auto-expands collapsed sections.
- **Two roles** — `owner` (full access) and `viewer` (read-only, can toggle packing checkboxes).

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
    api/                  health, geocode, packing check endpoints
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
DATABASE_URL=postgresql://trips_app:...@127.0.0.1:5437/trips
TRIPS_SESSION_SECRET=<random-secret>
DO_SPACES_ENDPOINT=https://<region>.digitaloceanspaces.com
DO_SPACES_BUCKET=<bucket>
DO_SPACES_KEY=<key>
DO_SPACES_SECRET=<secret>
PUBLIC_GOOGLE_MAPS_API_KEY=<key>
PUBLIC_GOOGLE_MAPS_MAP_ID=<map-id>
GOOGLE_GEOCODING_KEY=<server-key>
ANTHROPIC_API_KEY=<key>
```

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
| trips | 3004 | 5437 |

Health endpoint: `GET /api/health` returns `{"db":"ok","version":"<git-sha>"}`.

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
