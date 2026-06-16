-- trips initial schema (V3 FINAL plan).
-- Owner + read-only-ish viewer; hierarchical itinerary + packing outliners;
-- reservations; app-proxied private attachments; reusable packing templates.
-- Each migration is wrapped in BEGIN/COMMIT by migrate_pg.sh — do NOT add them here.

-- ---------------------------------------------------------------------------
-- Auth
-- ---------------------------------------------------------------------------
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'viewer')),
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

-- ---------------------------------------------------------------------------
-- Trips
-- ---------------------------------------------------------------------------
CREATE TABLE trips (
    id SERIAL PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    start_date DATE,
    end_date DATE,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX trips_owner_idx ON trips(owner_id);
CREATE INDEX trips_name_idx ON trips(lower(name));

-- ---------------------------------------------------------------------------
-- Itinerary / places outliner (CarbonFin nesting via parent_id + sort_order)
-- ---------------------------------------------------------------------------
CREATE TABLE itinerary_items (
    id SERIAL PRIMARY KEY,
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    parent_id INTEGER REFERENCES itinerary_items(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    item_type TEXT NOT NULL DEFAULT 'place'
        CHECK (item_type IN ('section', 'day', 'place', 'note')),
    title TEXT NOT NULL,
    notes TEXT,
    lat DOUBLE PRECISION,
    lon DOUBLE PRECISION,
    place_id TEXT,
    external_url TEXT,
    google_maps_url TEXT,
    date DATE,
    meta JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX itinerary_items_tree_idx ON itinerary_items(trip_id, parent_id, sort_order);
CREATE INDEX itinerary_items_title_idx ON itinerary_items(lower(title));

-- ---------------------------------------------------------------------------
-- Packing lists + items (nesting + check-off; viewer may toggle `checked`)
-- ---------------------------------------------------------------------------
CREATE TABLE packing_lists (
    id SERIAL PRIMARY KEY,
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT 'Packing List',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX packing_lists_trip_idx ON packing_lists(trip_id);

CREATE TABLE packing_items (
    id SERIAL PRIMARY KEY,
    list_id INTEGER NOT NULL REFERENCES packing_lists(id) ON DELETE CASCADE,
    parent_id INTEGER REFERENCES packing_items(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
    checked BOOLEAN NOT NULL DEFAULT FALSE,
    category TEXT,
    notes TEXT,
    weight_grams INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX packing_items_tree_idx ON packing_items(list_id, parent_id, sort_order);
CREATE INDEX packing_items_name_idx ON packing_items(lower(name));

-- ---------------------------------------------------------------------------
-- Reservations
-- ---------------------------------------------------------------------------
CREATE TABLE reservations (
    id SERIAL PRIMARY KEY,
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    reservation_type TEXT NOT NULL DEFAULT 'other'
        CHECK (reservation_type IN ('accommodation', 'flight', 'restaurant', 'transport', 'other')),
    title TEXT NOT NULL,
    confirmation_code TEXT,
    status TEXT,
    start_at TIMESTAMPTZ,
    end_at TIMESTAMPTZ,
    details JSONB,
    notes TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX reservations_trip_idx ON reservations(trip_id, sort_order);

-- ---------------------------------------------------------------------------
-- Attachments (private DO Spaces objects; app-proxied download).
-- 30 MB hard cap enforced here AND in client/route/nginx.
-- ---------------------------------------------------------------------------
CREATE TABLE attachments (
    id SERIAL PRIMARY KEY,
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    reservation_id INTEGER REFERENCES reservations(id) ON DELETE CASCADE,
    itinerary_item_id INTEGER REFERENCES itinerary_items(id) ON DELETE CASCADE,
    packing_item_id INTEGER REFERENCES packing_items(id) ON DELETE CASCADE,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 31457280),
    object_key TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'delete_pending')),
    meta JSONB,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX attachments_trip_idx ON attachments(trip_id);

-- ---------------------------------------------------------------------------
-- Reusable packing templates (owner-scoped; applied into a trip's list)
-- ---------------------------------------------------------------------------
CREATE TABLE packing_templates (
    id SERIAL PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX packing_templates_owner_idx ON packing_templates(owner_id);

CREATE TABLE packing_template_items (
    id SERIAL PRIMARY KEY,
    template_id INTEGER NOT NULL REFERENCES packing_templates(id) ON DELETE CASCADE,
    parent_id INTEGER REFERENCES packing_template_items(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    category TEXT,
    quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
    notes TEXT
);
CREATE INDEX packing_template_items_tree_idx
    ON packing_template_items(template_id, parent_id, sort_order);
