// PM2 ecosystem config for trips on the shared DigitalOcean droplet.
// Port 3004 (gaylonphotos=3000, giftlist=3001, madonnahist=3002, birds=3003).
// See docs/trip-planner-V3-FINAL-plan.md "Confirmed infrastructure".
//
// Reboot survival on the droplet (one-time, as root):
//   pm2 startup systemd -u root --hp /root
//   pm2 start ecosystem.config.cjs
//   pm2 save
//
// Secrets (PGPASSWORD, MIGRATION_PGPASSWORD, AUTH_SECRET, SPACES_*) live in
// /opt/trips/.env, mode 600, owned root:root. Loaded into process.env at boot
// via Node's built-in --env-file flag (Node >= 20.6).

module.exports = {
	apps: [
		{
			name: 'trips',
			script: 'build/index.js',
			node_args: '--env-file=.env',
			cwd: '/opt/trips',

			instances: 1,
			exec_mode: 'fork',

			autorestart: true,
			restart_delay: 5000,
			max_restarts: 10,
			min_uptime: '30s',
			// Modest footprint on the shared droplet. Headless-PDF (if enabled
			// later) must be serialized and re-profiled before raising this.
			max_memory_restart: '600M',

			out_file: '/var/log/pm2/trips.out.log',
			error_file: '/var/log/pm2/trips.err.log',
			merge_logs: true,
			time: true,

			env: {
				NODE_ENV: 'production',
				HOST: '127.0.0.1',
				PORT: 3004,
				// adapter-node caps request bodies at 512KB by default, which breaks
				// 30MB attachment uploads. Disable here; nginx enforces the real
				// limit upstream via client_max_body_size. See gaylonphotos
				// devlog 2026-02-28 (BODY_SIZE_LIMIT=0 was the wrong fix).
				BODY_SIZE_LIMIT: 'Infinity'
			}
		}
	]
};
