-- td-430ffe: a place is checkable as visited directly from the Places tree,
-- with the itinerary item as the single source of truth. Day-plan stops keep
-- their own flag only as a denormalized copy (and as the sole flag for orphan
-- stops whose place was deleted after the plan was built).
--
-- DEPLOY PRECONDITION (peer CODEX, review round 3): the reconciliation below
-- joins stops to items by itinerary_item_id without scoping through
-- day_plans.trip_id, so it assumes no cross-trip links exist. Verify first:
--   SELECT count(*) FROM day_plan_stops s
--     JOIN day_plans p ON p.id = s.day_plan_id
--     JOIN itinerary_items i ON i.id = s.itinerary_item_id
--    WHERE i.trip_id <> p.trip_id;
-- Must be 0 (it was 0 in the 2026-08-02 prod copy). 0016 then makes such
-- links impossible going forward.

ALTER TABLE itinerary_items ADD COLUMN visited BOOLEAN NOT NULL DEFAULT FALSE;

-- Reconcile: an item counts as visited if ANY linked stop was checked off
-- (bool_or semantics — visiting a place once means you visited it; clearing
-- on conflict would silently discard real check-offs).
UPDATE itinerary_items i
   SET visited = TRUE
  FROM day_plan_stops s
 WHERE s.itinerary_item_id = i.id AND s.visited;

-- Then normalise every linked stop to the canonical item value, so no stop
-- copy disagrees with its item on day one. Orphan stops
-- (itinerary_item_id IS NULL) are deliberately untouched.
UPDATE day_plan_stops s
   SET visited = i.visited
  FROM itinerary_items i
 WHERE s.itinerary_item_id = i.id AND s.visited <> i.visited;
