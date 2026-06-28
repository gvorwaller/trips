-- Store Apple Maps Server API place identifiers separately from Google place_id.

ALTER TABLE itinerary_items
    ADD COLUMN apple_maps_place_id TEXT;

