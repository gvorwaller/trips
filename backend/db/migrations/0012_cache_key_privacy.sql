-- Cache-key privacy (td-d3af9d Phase 4): place-text cache keys used to embed
-- the raw search query (a trip item title). The app now hashes the query
-- portion; purge every old-format row so no plaintext titles remain. Rows
-- repopulate on demand (60min TTL anyway).
DELETE FROM api_cache WHERE cache_key LIKE 'place-text:%';
