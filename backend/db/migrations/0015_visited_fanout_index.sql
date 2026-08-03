-- td-430ffe review follow-up (peer CODEX): the visited fan-out updates every
-- day_plan_stops row matching an itinerary_item_id, and PostgreSQL does not
-- auto-index FK referencing columns — so each toggle was a sequential scan.
-- Partial: orphan stops (NULL link) are never looked up by this column.
CREATE INDEX day_plan_stops_item_idx
    ON day_plan_stops (itinerary_item_id)
 WHERE itinerary_item_id IS NOT NULL;
