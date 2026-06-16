import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { search } from '$server/search';

export const load: PageServerLoad = async ({ url, locals }) => {
	if (!locals.ownerId) throw error(500, 'No owner configured');
	const q = (url.searchParams.get('q') ?? '').toString();
	const hits = q.trim().length >= 2 ? await search(locals.ownerId, q) : [];
	return { q, hits };
};
