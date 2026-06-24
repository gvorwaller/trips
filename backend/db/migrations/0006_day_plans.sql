CREATE TABLE day_plans (
    id            SERIAL PRIMARY KEY,
    trip_id       INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    notes         TEXT,
    optional_date DATE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX day_plans_trip_idx ON day_plans(trip_id, optional_date, id);

CREATE TABLE day_plan_stops (
    id                SERIAL PRIMARY KEY,
    day_plan_id       INTEGER NOT NULL REFERENCES day_plans(id) ON DELETE CASCADE,
    itinerary_item_id INTEGER REFERENCES itinerary_items(id) ON DELETE SET NULL,
    sort_order        INTEGER NOT NULL DEFAULT 0,
    notes             TEXT,
    visited           BOOLEAN NOT NULL DEFAULT FALSE,
    snapshot_title    TEXT NOT NULL,
    snapshot_lat      DOUBLE PRECISION,
    snapshot_lon      DOUBLE PRECISION,
    snapshot_place_id TEXT
);
CREATE INDEX day_plan_stops_plan_idx ON day_plan_stops(day_plan_id, sort_order);

GRANT SELECT, INSERT, UPDATE, DELETE ON day_plans TO trips_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON day_plan_stops TO trips_app;
GRANT USAGE, SELECT ON SEQUENCE day_plans_id_seq TO trips_app;
GRANT USAGE, SELECT ON SEQUENCE day_plan_stops_id_seq TO trips_app;
