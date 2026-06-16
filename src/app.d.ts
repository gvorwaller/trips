// See https://svelte.dev/docs/kit/types#app
declare global {
	namespace App {
		interface Locals {
			user?: {
				id: number;
				username: string;
				role: 'owner' | 'viewer';
				display_name: string;
			};
			// The owner whose trips every page reads. For the owner this is their
			// own id; for a viewer it points at the owner so they see the owner's
			// trips read-only (except packing check-off).
			ownerId?: number;
		}
	}

	// Injected by Vite `define` at build time (commit SHA, or 'dev' locally).
	const __GIT_SHA__: string;
}

export {};
