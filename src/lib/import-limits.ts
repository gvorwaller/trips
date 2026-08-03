/**
 * One import batch is capped at this many itinerary items (counting nested
 * children). The number lives outside $lib/server so the page can disable
 * the Import button at the same threshold the server enforces — the two
 * stating different limits is how silent partial imports happen
 * (peer CODEX, branch E round 1).
 */
export const MAX_IMPORT_ITEMS = 200;
