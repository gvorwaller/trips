-- Day-plan enhancement foundations:
-- - generic TTL cache for weather and place lookups
-- - persisted driving leg metrics
-- - persisted AI visit notes

CREATE TABLE api_cache (
    cache_key  TEXT PRIMARY KEY,
    payload    JSONB NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE day_plan_stops
    ADD COLUMN drive_km DOUBLE PRECISION,
    ADD COLUMN drive_min INTEGER,
    ADD COLUMN ai_notes TEXT;

GRANT SELECT, INSERT, UPDATE, DELETE ON api_cache TO trips_app;
