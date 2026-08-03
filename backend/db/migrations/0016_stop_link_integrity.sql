-- td-430ffe review round 3 (peer CODEX): the schema's independent FKs never
-- enforced that a stop's linked itinerary item belongs to the SAME trip as the
-- stop's plan. The visited fan-out now scopes through day_plans as defense in
-- depth, but the account partition should hold at the data layer too: a
-- cross-trip link must be impossible to create, not merely ignored.
-- (Verified before this migration: zero cross-trip links exist in prod data.)

CREATE FUNCTION assert_stop_link_same_trip() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.itinerary_item_id IS NOT NULL THEN
        PERFORM 1
           FROM itinerary_items i
           JOIN day_plans p ON p.id = NEW.day_plan_id
          WHERE i.id = NEW.itinerary_item_id
            AND i.trip_id = p.trip_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION
                'day_plan_stops link rejected: item % is not in the same trip as plan %',
                NEW.itinerary_item_id, NEW.day_plan_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER day_plan_stops_link_same_trip
    BEFORE INSERT OR UPDATE OF itinerary_item_id, day_plan_id
    ON day_plan_stops
    FOR EACH ROW
    EXECUTE FUNCTION assert_stop_link_same_trip();
