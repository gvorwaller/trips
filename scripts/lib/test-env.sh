#!/usr/bin/env bash
# Shared helpers for the isolated local test environment (trips).
# Test cluster: 127.0.0.1:15437, database trips_test.
# Reserved ports (NEVER): 5433=BTC, 5434=madonnahist, 5435=prod tunnel, 5436=birds.

find_repo_root() {
  local dir
  dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  printf '%s\n' "$dir"
}

resolve_env_file() {
  local repo_root="$1"
  local env_file="${2:-$repo_root/.env.test}"
  if [[ "$env_file" != /* ]]; then
    env_file="$repo_root/$env_file"
  fi
  printf '%s\n' "$env_file"
}

load_test_env() {
  REPO_ROOT="$(find_repo_root)"
  TEST_ENV_FILE="$(resolve_env_file "$REPO_ROOT" "${1:-}")"

  if [[ ! -f "$TEST_ENV_FILE" ]]; then
    echo "ERROR: test env file not found: $TEST_ENV_FILE" >&2
    echo "Copy .env.test.example to .env.test and adjust local-only values." >&2
    exit 1
  fi

  set -a
  # shellcheck disable=SC1090
  source "$TEST_ENV_FILE"
  set +a

  PGHOST="${PGHOST:-127.0.0.1}"
  PGPORT="${PGPORT:-15437}"
  PGDATABASE="${PGDATABASE:-trips_test}"
  PGUSER="${PGUSER:-trips_app}"
  PGPASSWORD="${PGPASSWORD:-}"
  MIGRATION_PGUSER="${MIGRATION_PGUSER:-trips_owner}"
  MIGRATION_PGPASSWORD="${MIGRATION_PGPASSWORD:-}"
  TRIPS_TEST_PGDATA="${TRIPS_TEST_PGDATA:-$REPO_ROOT/.local/postgres-test}"
  TRIPS_TEST_PGLOG="${TRIPS_TEST_PGLOG:-$REPO_ROOT/.local/postgres-test.log}"
}

require_test_safety() {
  if [[ "${TRIPS_ENV:-}" != "test" ]]; then
    echo "ERROR: TRIPS_ENV must be 'test' for local test DB commands." >&2
    exit 1
  fi

  if [[ "$PGPORT" == "5433" || "$PGPORT" == "5434" || "$PGPORT" == "5435" || "$PGPORT" == "5436" ]]; then
    echo "ERROR: refusing reserved port $PGPORT (5433=BTC, 5434=madonnahist, 5435=prod tunnel, 5436=birds)." >&2
    exit 1
  fi

  if [[ "$PGDATABASE" == "trips" ]]; then
    echo "ERROR: refusing production database name 'trips' for local tests." >&2
    exit 1
  fi

  if [[ "$PGUSER" != "trips_app" || "$MIGRATION_PGUSER" != "trips_owner" ]]; then
    echo "ERROR: migrations hard-code canonical role names; isolated tests must use:" >&2
    echo "  PGUSER=trips_app" >&2
    echo "  MIGRATION_PGUSER=trips_owner" >&2
    exit 1
  fi

  if [[ -z "$PGPASSWORD" || -z "$MIGRATION_PGPASSWORD" ]]; then
    echo "ERROR: test DB role passwords must be set in $TEST_ENV_FILE." >&2
    exit 1
  fi
}

parse_env_arg() {
  local env_file=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --env)
        if [[ -z "${2:-}" ]]; then
          echo "ERROR: --env requires a file path" >&2
          exit 1
        fi
        env_file="$2"
        shift 2
        ;;
      *)
        echo "ERROR: unknown argument: $1" >&2
        exit 1
        ;;
    esac
  done
  printf '%s\n' "$env_file"
}

find_pg_bin() {
  # The local test cluster and prod are BOTH PostgreSQL 17. Require PG17 binaries.
  local name="$1" candidate
  for candidate in \
    "/opt/homebrew/opt/postgresql@17/bin/$name" \
    /opt/homebrew/Cellar/postgresql@17/*/bin/"$name"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  if command -v "$name" >/dev/null 2>&1; then
    command -v "$name"
    return 0
  fi
  echo "ERROR: $name (PostgreSQL 17) not found. Install with: brew install postgresql@17" >&2
  exit 1
}
