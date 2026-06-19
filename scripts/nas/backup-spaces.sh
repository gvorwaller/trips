#!/bin/sh
set -eu

# Pull the production DigitalOcean Spaces bucket (trips attachment blobs) to the
# Synology NAS.
#
# This intentionally uses `rclone copy`, not `rclone sync`, so objects deleted
# from production are not automatically deleted from the NAS backup.
#
# Runs ON the NAS (DSM). Mirrors madonnahist/scripts/nas/backup-spaces.sh.

PATH="${TRIPS_NAS_PATH:-/var/services/homes/NASADMIN/bin:/usr/bin:/bin:/usr/sbin:/sbin}"
export PATH

RCLONE_CONFIG="${RCLONE_CONFIG:-/var/services/homes/NASADMIN/.config/rclone/rclone.conf}"
export RCLONE_CONFIG

BASE="${TRIPS_SPACES_BACKUP_BASE:-/volume3/gaylon-trips-spaces-backup}"
SOURCE="${TRIPS_SPACES_SOURCE:-do-trips:gaylon-trips}"
DEST="$BASE/current"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG="$BASE/logs/spaces-rclone-$STAMP.log"
SOURCE_SIZE="$BASE/manifests/spaces-source-size-$STAMP.json"
MANIFEST="$BASE/manifests/spaces-rclone-manifest-$STAMP.json"
LATEST_MANIFEST="$BASE/manifests/latest-spaces-rclone-manifest.json"
LATEST_SOURCE_SIZE="$BASE/manifests/latest-spaces-source-size.json"
LATEST_DRY_RUN_MANIFEST="$BASE/manifests/latest-dry-run-spaces-rclone-manifest.json"
LATEST_DRY_RUN_SOURCE_SIZE="$BASE/manifests/latest-dry-run-spaces-source-size.json"
LAST_RUN_STATUS="$BASE/LAST_RUN_STATUS.json"
LAST_SUCCESS="$BASE/LAST_SUCCESS"
LAST_FAILURE="$BASE/LAST_FAILURE.json"
LAST_DRY_RUN_STATUS="$BASE/LAST_DRY_RUN_STATUS.json"
LATEST_LOG_PATH="$BASE/LATEST_LOG_PATH"
DRY_RUN=0
EXTRA_ARGS=""

DSM_NOTIFY_BIN="${TRIPS_DSM_NOTIFY_BIN:-/usr/syno/bin/synodsmnotify}"
DSM_NOTIFY_TARGET="${TRIPS_DSM_NOTIFY_TARGET:-@administrators}"
DSM_NOTIFY_ON_DRY_RUN_FAILURE="${TRIPS_DSM_NOTIFY_ON_DRY_RUN_FAILURE:-0}"

for arg in "$@"; do
	case "$arg" in
		--dry-run)
			DRY_RUN=1
			EXTRA_ARGS="$EXTRA_ARGS --dry-run"
			;;
		*)
			echo "Unknown argument: $arg" >&2
			exit 2
			;;
	esac
done

mkdir -p "$DEST" "$BASE/logs" "$BASE/manifests" "$BASE/restore-drills"

notify_failure() {
	rc="$1"
	[ -x "$DSM_NOTIFY_BIN" ] || return 0
	if [ "$DRY_RUN" -eq 1 ] && [ "$DSM_NOTIFY_ON_DRY_RUN_FAILURE" != "1" ]; then
		return 0
	fi

	"$DSM_NOTIFY_BIN" \
		-l error \
		"$DSM_NOTIFY_TARGET" \
		"Trips Spaces backup failed" \
		"NAS Spaces backup failed with rc=$rc. Check $LAST_RUN_STATUS and $LOG." \
		>/dev/null 2>&1 || true
}

write_failure_status() {
	rc="$1"
	status_file="$LAST_RUN_STATUS"
	[ "$DRY_RUN" -eq 1 ] && status_file="$LAST_DRY_RUN_STATUS"

	cat > "$status_file" <<JSON
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "status": "failure",
  "mode": "$(if [ "$DRY_RUN" -eq 1 ]; then echo dry-run; else echo live; fi)",
  "exitCode": $rc,
  "source": "$SOURCE",
  "destination": "$DEST",
  "sourceSizeJson": "$SOURCE_SIZE",
  "log": "$LOG"
}
JSON

	if [ "$DRY_RUN" -eq 0 ]; then
		cp -f "$status_file" "$LAST_FAILURE"
	fi
}

SUCCESS=0
on_exit() {
	rc="$?"
	if [ "$SUCCESS" -eq 1 ] || [ "$rc" -eq 0 ]; then
		return 0
	fi

	write_failure_status "$rc" || true
	notify_failure "$rc" || true
	exit "$rc"
}
trap on_exit EXIT

{
	echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] starting $SOURCE -> $DEST"
	if [ "$DRY_RUN" -eq 1 ]; then
		echo "mode=dry-run"
	else
		echo "mode=live"
	fi
} > "$LOG"

rclone size "$SOURCE" --json > "$SOURCE_SIZE" 2>> "$LOG"
# shellcheck disable=SC2086
rclone copy "$SOURCE" "$DEST" \
	--checksum \
	--fast-list \
	--transfers 4 \
	--checkers 8 \
	--log-level INFO \
	--log-file "$LOG" \
	$EXTRA_ARGS

# trips attachment blobs live under a single `trips/` key prefix, so count the
# whole destination tree rather than named subdirs.
object_count="$(find "$DEST" -type f 2>/dev/null | wc -l | tr -d ' ')"
total_bytes="$(find "$DEST" -type f -printf '%s\n' 2>/dev/null | awk '{s+=$1} END {print s+0}')"
mode="live"
if [ "$DRY_RUN" -eq 1 ]; then mode="dry-run"; fi

cat > "$MANIFEST" <<JSON
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "status": "success",
  "mode": "$mode",
  "source": "$SOURCE",
  "destination": "$DEST",
  "objectCountOnNas": $object_count,
  "totalBytesOnNas": $total_bytes,
  "sourceSizeJson": "$SOURCE_SIZE",
  "log": "$LOG"
}
JSON

if [ "$DRY_RUN" -eq 1 ]; then
	cp -f "$MANIFEST" "$LATEST_DRY_RUN_MANIFEST"
	cp -f "$SOURCE_SIZE" "$LATEST_DRY_RUN_SOURCE_SIZE"
	cp -f "$MANIFEST" "$LAST_DRY_RUN_STATUS"
else
	cp -f "$MANIFEST" "$LATEST_MANIFEST"
	cp -f "$SOURCE_SIZE" "$LATEST_SOURCE_SIZE"
	cp -f "$MANIFEST" "$LAST_RUN_STATUS"
	printf '%s\n' "$LOG" > "$LATEST_LOG_PATH"
	date -u +%Y-%m-%dT%H:%M:%SZ > "$LAST_SUCCESS"
fi

SUCCESS=1
echo "[nas-backup-spaces] $mode complete: objects=$object_count bytes=$total_bytes log=$LOG manifest=$MANIFEST"
