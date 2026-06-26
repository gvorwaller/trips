#!/usr/bin/env bash
# Copy the latest production PostgreSQL snapshot into the isolated local test DB.
#
# Flow:
#   1. Pull a fresh prod dump with scripts/backup-pg.sh.
#   2. Drop/recreate the local test database using scripts/test-db-reset.sh.
#   3. Restore data with pg_restore --no-owner --no-privileges.
#   4. Repair runtime grants lost by the no-privileges dump.
#   5. Apply any migrations that are newer than production.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/test-env.sh
source "$SCRIPT_DIR/lib/test-env.sh"

ENV_ARG="$(parse_env_arg "$@")"
load_test_env "$ENV_ARG"
require_test_safety

PG_RESTORE_BIN="$(find_pg_bin pg_restore)"
PSQL_BIN="$(find_pg_bin psql)"
PROD_DUMP="$REPO_ROOT/data/backup/prod/trips.pgdump"

echo "Pulling fresh production dump..."
"$SCRIPT_DIR/backup-pg.sh"

if [[ ! -s "$PROD_DUMP" ]]; then
  echo "ERROR: expected production dump was not created: $PROD_DUMP" >&2
  exit 1
fi

echo "Resetting isolated test database..."
"$SCRIPT_DIR/test-db-reset.sh" --env "$TEST_ENV_FILE"

echo "Restoring production dump into $PGDATABASE on $PGHOST:$PGPORT..."
PGPASSWORD="$MIGRATION_PGPASSWORD" "$PG_RESTORE_BIN" \
  -h "$PGHOST" \
  -p "$PGPORT" \
  -U "$MIGRATION_PGUSER" \
  -d "$PGDATABASE" \
  --no-owner \
  --no-privileges \
  "$PROD_DUMP"

echo "Repairing test runtime grants..."
PGPASSWORD="$MIGRATION_PGPASSWORD" "$PSQL_BIN" \
  -h "$PGHOST" \
  -p "$PGPORT" \
  -U "$MIGRATION_PGUSER" \
  -d "$PGDATABASE" \
  -v ON_ERROR_STOP=1 <<SQL
GRANT USAGE ON SCHEMA public TO $PGUSER;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO $PGUSER;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO $PGUSER;

ALTER DEFAULT PRIVILEGES FOR ROLE $MIGRATION_PGUSER IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO $PGUSER;
ALTER DEFAULT PRIVILEGES FOR ROLE $MIGRATION_PGUSER IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO $PGUSER;
SQL

echo "Applying migrations newer than production..."
"$SCRIPT_DIR/test-db-migrate.sh" --env "$TEST_ENV_FILE"

echo
echo "Prod-to-test copy complete: $PGHOST:$PGPORT/$PGDATABASE"
