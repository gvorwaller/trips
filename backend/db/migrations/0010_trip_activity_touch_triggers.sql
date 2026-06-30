-- Keep trips.updated_at aligned with the latest trip-owned save.
-- This makes the Trips list cheap: it can read trips.updated_at directly,
-- while writes to child rows touch the parent trip once.

CREATE OR REPLACE FUNCTION touch_trip_activity_direct()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    target_trip_id INTEGER;
BEGIN
    IF TG_OP = 'DELETE' THEN
        target_trip_id := OLD.trip_id;
        UPDATE trips SET updated_at = NOW() WHERE id = target_trip_id;
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' AND NEW.trip_id IS DISTINCT FROM OLD.trip_id THEN
        UPDATE trips SET updated_at = NOW() WHERE id = OLD.trip_id;
    END IF;

    target_trip_id := NEW.trip_id;
    UPDATE trips SET updated_at = NOW() WHERE id = target_trip_id;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION touch_trip_activity_from_packing_item()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    target_list_id INTEGER;
    target_trip_ids INTEGER[];
    target_trip_id INTEGER;
BEGIN
    IF TG_OP = 'DELETE' THEN
        target_list_id := OLD.list_id;
        SELECT ARRAY_AGG(DISTINCT trip_id) INTO target_trip_ids
          FROM packing_lists
         WHERE id = target_list_id;
    ELSE
        target_list_id := NEW.list_id;
        IF TG_OP = 'UPDATE' AND NEW.list_id IS DISTINCT FROM OLD.list_id THEN
            SELECT ARRAY_AGG(DISTINCT trip_id) INTO target_trip_ids
              FROM packing_lists
             WHERE id IN (OLD.list_id, NEW.list_id);
        ELSE
            SELECT ARRAY_AGG(DISTINCT trip_id) INTO target_trip_ids
              FROM packing_lists
             WHERE id = target_list_id;
        END IF;
    END IF;

    FOREACH target_trip_id IN ARRAY COALESCE(target_trip_ids, ARRAY[]::INTEGER[]) LOOP
        UPDATE trips SET updated_at = NOW() WHERE id = target_trip_id;
    END LOOP;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION touch_trip_activity_from_day_plan_stop()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    target_plan_id INTEGER;
    target_trip_ids INTEGER[];
    target_trip_id INTEGER;
BEGIN
    IF TG_OP = 'DELETE' THEN
        target_plan_id := OLD.day_plan_id;
        SELECT ARRAY_AGG(DISTINCT trip_id) INTO target_trip_ids
          FROM day_plans
         WHERE id = target_plan_id;
    ELSE
        target_plan_id := NEW.day_plan_id;
        IF TG_OP = 'UPDATE' AND NEW.day_plan_id IS DISTINCT FROM OLD.day_plan_id THEN
            SELECT ARRAY_AGG(DISTINCT trip_id) INTO target_trip_ids
              FROM day_plans
             WHERE id IN (OLD.day_plan_id, NEW.day_plan_id);
        ELSE
            SELECT ARRAY_AGG(DISTINCT trip_id) INTO target_trip_ids
              FROM day_plans
             WHERE id = target_plan_id;
        END IF;
    END IF;

    FOREACH target_trip_id IN ARRAY COALESCE(target_trip_ids, ARRAY[]::INTEGER[]) LOOP
        UPDATE trips SET updated_at = NOW() WHERE id = target_trip_id;
    END LOOP;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER itinerary_items_touch_trip_activity
AFTER INSERT OR UPDATE OR DELETE ON itinerary_items
FOR EACH ROW EXECUTE FUNCTION touch_trip_activity_direct();

CREATE TRIGGER packing_lists_touch_trip_activity
AFTER INSERT OR UPDATE OR DELETE ON packing_lists
FOR EACH ROW EXECUTE FUNCTION touch_trip_activity_direct();

CREATE TRIGGER reservations_touch_trip_activity
AFTER INSERT OR UPDATE OR DELETE ON reservations
FOR EACH ROW EXECUTE FUNCTION touch_trip_activity_direct();

CREATE TRIGGER attachments_touch_trip_activity
AFTER INSERT OR UPDATE OR DELETE ON attachments
FOR EACH ROW EXECUTE FUNCTION touch_trip_activity_direct();

CREATE TRIGGER expenses_touch_trip_activity
AFTER INSERT OR UPDATE OR DELETE ON expenses
FOR EACH ROW EXECUTE FUNCTION touch_trip_activity_direct();

CREATE TRIGGER day_plans_touch_trip_activity
AFTER INSERT OR UPDATE OR DELETE ON day_plans
FOR EACH ROW EXECUTE FUNCTION touch_trip_activity_direct();

CREATE TRIGGER packing_items_touch_trip_activity
AFTER INSERT OR UPDATE OR DELETE ON packing_items
FOR EACH ROW EXECUTE FUNCTION touch_trip_activity_from_packing_item();

CREATE TRIGGER day_plan_stops_touch_trip_activity
AFTER INSERT OR UPDATE OR DELETE ON day_plan_stops
FOR EACH ROW EXECUTE FUNCTION touch_trip_activity_from_day_plan_stop();

WITH latest_activity AS (
    SELECT
        t.id,
        GREATEST(
            t.updated_at,
            COALESCE(ii.updated_at, '-infinity'::timestamptz),
            COALESCE(pl.updated_at, '-infinity'::timestamptz),
            COALESCE(pi.updated_at, '-infinity'::timestamptz),
            COALESCE(r.updated_at, '-infinity'::timestamptz),
            COALESCE(a.uploaded_at, '-infinity'::timestamptz),
            COALESCE(e.updated_at, '-infinity'::timestamptz),
            COALESCE(dp.updated_at, '-infinity'::timestamptz)
        ) AS updated_at
    FROM trips t
    LEFT JOIN (
        SELECT trip_id, MAX(updated_at) AS updated_at
          FROM itinerary_items
         GROUP BY trip_id
    ) ii ON ii.trip_id = t.id
    LEFT JOIN (
        SELECT trip_id, MAX(updated_at) AS updated_at
          FROM packing_lists
         GROUP BY trip_id
    ) pl ON pl.trip_id = t.id
    LEFT JOIN (
        SELECT pl.trip_id, MAX(pi.updated_at) AS updated_at
          FROM packing_items pi
          JOIN packing_lists pl ON pl.id = pi.list_id
         GROUP BY pl.trip_id
    ) pi ON pi.trip_id = t.id
    LEFT JOIN (
        SELECT trip_id, MAX(updated_at) AS updated_at
          FROM reservations
         GROUP BY trip_id
    ) r ON r.trip_id = t.id
    LEFT JOIN (
        SELECT trip_id, MAX(uploaded_at) AS uploaded_at
          FROM attachments
         GROUP BY trip_id
    ) a ON a.trip_id = t.id
    LEFT JOIN (
        SELECT trip_id, MAX(updated_at) AS updated_at
          FROM expenses
         GROUP BY trip_id
    ) e ON e.trip_id = t.id
    LEFT JOIN (
        SELECT trip_id, MAX(updated_at) AS updated_at
          FROM day_plans
         GROUP BY trip_id
    ) dp ON dp.trip_id = t.id
)
UPDATE trips t
   SET updated_at = latest_activity.updated_at
  FROM latest_activity
 WHERE latest_activity.id = t.id
   AND latest_activity.updated_at > t.updated_at;
