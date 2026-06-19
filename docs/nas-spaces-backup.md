# NAS Spaces Backup (trips attachment blobs)

Date: 2026-06-18
Status: **scripts written; NAS-side setup pending** (see Setup Runbook)

## Purpose

`pg_dump` (see `scripts/backup-pg.sh`) captures attachment *rows* — title, mime,
size, and the Spaces `object_key` — but NOT the file bytes. The uploaded blobs
live in the DigitalOcean Spaces bucket `gaylon-trips` (region `sfo3`). This
mirrors the madonnahist setup: the Synology NAS pulls the production Spaces
bucket directly to Volume 3 so there is a local copy of the actual files, with
no scheduled backup traffic routed through a Mac.

## Intended NAS Layout

```text
/volume3/gaylon-trips-spaces-backup
├── current/
│   └── trips/            # trips/{tripId}/{attachmentId}/{rand}/{safeName}
├── logs/
├── manifests/
└── restore-drills/
```

The dedicated share should be `gaylon-trips-spaces-backup` on Volume 3 with
`@administrators` read/write access (Btrfs, so snapshots work).

## Scripts

Repo copies (source of truth):

```text
scripts/nas/backup-spaces.sh
scripts/nas/snapshot-spaces-backup.sh
```

Deployed NAS copies (target):

```text
/volume3/gaylon-trips-spaces-backup/backup-spaces.sh
/volume3/gaylon-trips-spaces-backup/snapshot-spaces-backup.sh
```

The rclone config is intentionally not in git:

```text
/var/services/homes/NASADMIN/.config/rclone/rclone.conf
```

That file contains the DigitalOcean Spaces access key and secret.

## Credentials note (why trips needs its own rclone remote)

The NAS already has an rclone remote named `do-spaces` (type s3, DigitalOcean,
endpoint `https://sfo3.digitaloceanspaces.com`, region `sfo3`). However its
Spaces key is **bucket-scoped to madonnahist** — `rclone size do-spaces:gaylon-trips`
returns `403 AccessDenied`. The trips pull therefore needs a separate remote
(`do-trips`) built from the **trips** Spaces credentials (the same
`SPACES_KEY`/`SPACES_SECRET` the app uses, in `/opt/trips/.env`). The key used
must have List + Get on `gaylon-trips`.

The endpoint/region are identical (sfo3), so only the access key/secret differ.

## Setup Runbook (one-time, on the NAS)

These steps need DSM admin / sudo / the Spaces secret, so they are done by hand
(not by the repo tooling). SSH alias: `nas-git` (NASADMIN@192.168.22.74).

1. **Create the shared folder** in DSM: Control Panel → Shared Folder → Create
   `gaylon-trips-spaces-backup` on Volume 3, Btrfs, `@administrators` r/w.
2. **Add the `do-trips` rclone remote** with the trips Spaces key/secret:
   ```sh
   export PATH=/var/services/homes/NASADMIN/bin:$PATH
   rclone config create do-trips s3 \
     provider=DigitalOcean \
     endpoint=https://sfo3.digitaloceanspaces.com \
     region=sfo3 \
     acl=private \
     access_key_id=<TRIPS_SPACES_KEY> \
     secret_access_key=<TRIPS_SPACES_SECRET>
   # verify (should NOT 403):
   rclone size do-trips:gaylon-trips --json
   ```
3. **Deploy the scripts** from the repo to the share:
   ```sh
   # from the Mac, repo root:
   scp scripts/nas/backup-spaces.sh scripts/nas/snapshot-spaces-backup.sh \
       nas-git:/volume3/gaylon-trips-spaces-backup/
   ssh nas-git 'chmod +x /volume3/gaylon-trips-spaces-backup/*.sh'
   ```
4. **Dry-run, then first live pull:**
   ```sh
   ssh nas-git '/volume3/gaylon-trips-spaces-backup/backup-spaces.sh --dry-run'
   ssh nas-git '/volume3/gaylon-trips-spaces-backup/backup-spaces.sh'
   ```
5. **Schedule** (DSM Task Scheduler is preferred; or root crontab). Mirror the
   madonnahist cadence — pull daily, snapshot shortly after:
   ```cron
   # trips Spaces backup: NAS pulls DO Spaces to Volume 3 daily.
   30 3 * * * NASADMIN /volume3/gaylon-trips-spaces-backup/backup-spaces.sh >> /volume3/gaylon-trips-spaces-backup/logs/spaces-cron.log 2>&1
   30 4 * * * root /volume3/gaylon-trips-spaces-backup/snapshot-spaces-backup.sh
   ```
   (Offset 15 min from madonnahist's 03:15/04:15 so the two pulls don't overlap.)
6. **Restore drill:** pick one object, restore it, and compare SHA-256 against
   the same object pulled fresh from Spaces; record under `restore-drills/`.

## Backup Semantics

The pull script uses:

```sh
rclone copy do-trips:gaylon-trips /volume3/gaylon-trips-spaces-backup/current
```

It deliberately uses `copy`, not `sync`. Production deletes in DigitalOcean
Spaces do not propagate as deletes to the NAS backup.

The script writes (on success):

- `logs/spaces-rclone-*.log`
- `manifests/spaces-source-size-*.json`
- `manifests/spaces-rclone-manifest-*.json`
- `manifests/latest-spaces-rclone-manifest.json`
- `manifests/latest-spaces-source-size.json`
- `LAST_RUN_STATUS.json`
- `LAST_SUCCESS`
- `LATEST_LOG_PATH`

On live-run failure it writes `LAST_RUN_STATUS.json` + `LAST_FAILURE.json` and
sends a failure-only DSM notification via `/usr/syno/bin/synodsmnotify` to
`@administrators` (override with `TRIPS_DSM_NOTIFY_TARGET`).

Dry runs do not overwrite the live health files; they write
`LAST_DRY_RUN_STATUS.json` and `manifests/latest-dry-run-*`. Dry-run failures do
not notify unless `TRIPS_DSM_NOTIFY_ON_DRY_RUN_FAILURE=1`.

## Snapshot Policy

Ordinary Synology/Btrfs snapshots (not immutable/WORM). The snapshot script
keeps only the latest `2` by default (`TRIPS_SPACES_SNAPSHOT_KEEP=2`) — recent
rollback protection, not archival retention.

## Manual Commands

```sh
# latest live status
cat /volume3/gaylon-trips-spaces-backup/LAST_RUN_STATUS.json
cat /volume3/gaylon-trips-spaces-backup/LAST_SUCCESS
cat /volume3/gaylon-trips-spaces-backup/LATEST_LOG_PATH

# latest manifest / recent cron output
cat /volume3/gaylon-trips-spaces-backup/manifests/latest-spaces-rclone-manifest.json
tail -n 80 /volume3/gaylon-trips-spaces-backup/logs/spaces-cron.log

# dry-run / run / snapshot
/volume3/gaylon-trips-spaces-backup/backup-spaces.sh --dry-run
/volume3/gaylon-trips-spaces-backup/backup-spaces.sh
sudo /volume3/gaylon-trips-spaces-backup/snapshot-spaces-backup.sh
sudo /usr/syno/sbin/synosharesnapshot list gaylon-trips-spaces-backup

# NAS object totals
find /volume3/gaylon-trips-spaces-backup/current -type f -printf '%s\n' |
  awk '{s+=$1; c++} END {printf "objects=%d bytes=%d\n", c, s}'
```
