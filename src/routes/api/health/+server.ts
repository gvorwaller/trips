import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { dbHealthCheck } from '$lib/db';

const VERSION = __GIT_SHA__;

export const GET: RequestHandler = async () => {
	const dbOk = await dbHealthCheck();
	const db = dbOk ? 'ok' : 'error';

	// Only db gates deploys.
	const status = db === 'ok' ? 200 : 503;

	return json({ db, version: VERSION }, { status });
};
