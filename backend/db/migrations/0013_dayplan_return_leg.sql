-- Persist the drive home for anchored day plans (td-bf2909).
--
-- An anchored day is a closed loop: you leave lodging and return to it.
-- optimizeDrivingRoute already modelled it that way, but computeLegDistances
-- routed anchor -> stops -> last stop with no return, and the per-leg values it
-- produces are what get persisted. So every anchored plan's saved driving total
-- understated the real distance by the length of the drive home.
--
-- The return leg has no destination stop to hang drive_km/drive_min on, so it
-- lives on the plan. A sentinel day_plan_stops row was rejected: snapshot_title
-- is NOT NULL, and a fake stop would corrupt sort_order, reorderStops,
-- planProgress, the visited count, the duplicate-location guard, clone,
-- duplicate and every export.
--
-- The anchor_lat guard mirrors day_plans_anchor_complete (0009): a return leg
-- without an anchor is unrepresentable, because an unanchored plan is an open
-- path with nowhere to return to.
--
-- Table-level grants (0002) use ON ALL TABLES plus default privileges, so new
-- columns need no GRANT.

ALTER TABLE day_plans
    ADD COLUMN return_drive_km DOUBLE PRECISION,
    ADD COLUMN return_drive_min INTEGER,
    ADD CONSTRAINT day_plans_return_leg_complete CHECK (
        (return_drive_km IS NULL AND return_drive_min IS NULL)
        OR
        (
            return_drive_km IS NOT NULL
            AND return_drive_min IS NOT NULL
            AND return_drive_km >= 0
            AND return_drive_min >= 0
            AND anchor_lat IS NOT NULL
        )
    );
