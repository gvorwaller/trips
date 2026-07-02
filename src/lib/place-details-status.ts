// Shared between +page.server.ts (refresh-details failures) and +page.svelte
// (initial load-time details status) so the two copies can't drift — this is
// a universal (non-$server) module since +page.svelte needs it client-side too.
export const PLACE_DETAILS_STATUS_MESSAGE: Record<string, string> = {
	not_configured: 'Google details are not configured for this app.',
	not_found: 'Google no longer recognizes this place — the location may need to be re-selected.',
	rate_limited: "Google's place details are temporarily rate-limited — try again shortly.",
	upstream_error: "Couldn't reach Google for place details right now — try again shortly."
};
