-- Persist an optional day-plan route anchor, such as lodging or a town center.
-- The anchor is not a mutable visited stop, but it is rendered before saved
-- stops and used as the route origin for directions and driving legs.

ALTER TABLE day_plans
    ADD COLUMN anchor_source TEXT,
    ADD COLUMN anchor_title TEXT,
    ADD COLUMN anchor_lat DOUBLE PRECISION,
    ADD COLUMN anchor_lon DOUBLE PRECISION,
    ADD CONSTRAINT day_plans_anchor_complete CHECK (
        (anchor_source IS NULL AND anchor_title IS NULL AND anchor_lat IS NULL AND anchor_lon IS NULL)
        OR
        (
            anchor_source IS NOT NULL
            AND anchor_title IS NOT NULL
            AND anchor_lat IS NOT NULL
            AND anchor_lon IS NOT NULL
            AND anchor_lat BETWEEN -90 AND 90
            AND anchor_lon BETWEEN -180 AND 180
        )
    );
