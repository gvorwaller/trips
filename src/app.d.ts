// See https://svelte.dev/docs/kit/types#app
declare global {
	namespace App {
		interface Locals {
			user?: {
				id: number;
				username: string;
				role: 'admin' | 'user' | 'viewer';
				display_name: string;
				views_user_id: number | null;
			};
			// The account whose trips this session reads: self for admin/user,
			// the linked account (views_user_id) for viewers, who see it
			// read-only (except packing check-off / day-plan visited).
			ownerId?: number;
		}
	}

	// Injected by Vite `define` at build time (commit SHA, or 'dev' locally).
	const __GIT_SHA__: string;
}

export {};
