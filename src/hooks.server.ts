import type { Handle } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import { SESSION_COOKIE_NAME, validateSession } from '$server/session';
import { getOwnerId } from '$server/auth';
import { dev } from '$app/environment';

export const SESSION_COOKIE_OPTS = {
	path: '/',
	httpOnly: true,
	sameSite: 'strict' as const,
	secure: !dev,
	maxAge: 60 * 60 * 24 * 30
};

const PUBLIC_PATHS = ['/login', '/api/health'];

function isPublic(path: string): boolean {
	return PUBLIC_PATHS.some((p) => path === p);
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Narrow writes a read-only viewer is permitted: toggling a packing item's
 * checked state, and marking a day-plan stop visited. Everything else is 403
 * for viewers. Each endpoint verifies that only the allowed boolean changes.
 */
function isViewerAllowedMutation(method: string, path: string): boolean {
	return (
		method === 'PATCH' &&
		(path === '/api/packing/check' || path === '/api/dayplan/visited')
	);
}

export const handle: Handle = async ({ event, resolve }) => {
	const token = event.cookies.get(SESSION_COOKIE_NAME);

	if (token) {
		const user = await validateSession(token);
		if (user) {
			event.locals.user = user;
			event.locals.ownerId = await getOwnerId();
		} else {
			event.cookies.delete(SESSION_COOKIE_NAME, { path: '/' });
		}
	}

	const path = event.url.pathname;
	const method = event.request.method;

	if (!isPublic(path) && !event.locals.user) {
		if (method === 'GET') {
			const returnTo = encodeURIComponent(path);
			throw redirect(303, `/login?returnTo=${returnTo}`);
		}
		return new Response(JSON.stringify({ error: 'Unauthorized' }), {
			status: 401,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	// Same-origin guard for all mutations (defense-in-depth beyond sameSite=strict).
	if (MUTATING_METHODS.has(method)) {
		const origin = event.request.headers.get('origin');
		if (origin && origin !== event.url.origin) {
			return new Response('Cross-origin request blocked.', { status: 403 });
		}
	}

	// Read-only viewer: no writes except the packing check-off exception, no settings.
	if (event.locals.user?.role === 'viewer') {
		if (
			MUTATING_METHODS.has(method) &&
			path !== '/login' &&
			!isViewerAllowedMutation(method, path)
		) {
			return new Response('Read-only viewer — this action is not allowed.', { status: 403 });
		}
		if (path.startsWith('/settings')) throw redirect(303, '/');
	}

	return resolve(event);
};
