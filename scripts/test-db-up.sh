#!/usr/bin/env bash
# One-shot: bring up the local PostgreSQL 17 test cluster and apply migrations.
#
#   - Cluster:  127.0.0.1:15437, database trips_test (PG17, matches prod).
#   - Idempotent: safe to run repeatedly. Inits the data dir on first run,
#     starts it if stopped, ensures the trips_owner/trips_app roles + database,
#     then runs any pending migrations.
#   - Reads .env.test for ports, passwords, and TRIPS_ENV=test safety guards.
#
# After this, run the app against the test DB:
#   npm run dev:test
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# test-db-migrate.sh starts the cluster (via test-db-start.sh) and then migrates.
"$SCRIPT_DIR/test-db-migrate.sh" "$@"

echo
echo "Local test DB ready: 127.0.0.1:15437 / trips_test (PostgreSQL 17)."
echo "Run the app in test mode:"
echo "  npm run dev:test"
