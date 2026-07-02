import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

// Real-database integration tests (*.dbtest.ts) — run against the dedicated
// test cluster (15437) via `npm run test:db`. Unlike the mocked unit tests in
// vite.config.ts, these prove the actual SQL owner filters. The setup file
// loads .env.test and refuses to run unless TRIPS_ENV=test (same guard as the
// Safari QA helper).
export default defineConfig({
	plugins: [sveltekit()],
	define: {
		__GIT_SHA__: JSON.stringify('dbtest')
	},
	test: {
		environment: 'node',
		include: ['src/**/*.dbtest.ts'],
		setupFiles: ['src/dbtest-setup.ts'],
		// One file at a time: suites share the test database and self-provision
		// fixtures; parallel files could collide on usernames/cleanup.
		fileParallelism: false
	}
});
