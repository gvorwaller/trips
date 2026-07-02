// Shared between src/lib/server/place-ai.ts (server-side validation) and
// +page.svelte (textarea maxlength) — a universal (non-$server) module since
// the component needs this client-side too and can't import $server modules.
export const MAX_QUESTION_LENGTH = 500;
