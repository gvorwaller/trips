# NAS Spaces Backup (trips attachment blobs)

Date: 2026-06-18
Status: **active on NAS as of 2026-06-23**.

## Purpose

`pg_dump` (see `scripts/backup-pg.sh`) captures attachment *rows* — title, mime,
size, and the Spaces `object_key` — but NOT the file bytes. The uploaded blobs
live in the DigitalOcean Spaces bucket `gaylon-trips` (region `sfo3`). This
mirrors the madonnahist setup: the Synology NAS pulls the production Spaces
bucket directly to Volume 3 so there is a local copy of the actual files, with
no scheduled backup traffic routed through a Mac.

## NAS Layout

```text
/volume3/gaylon-trips-spaces-backup
├── current/
│   └── trips/            # trips/{tripId}/{attachmentId}/{rand}/{safeName}
├── logs/
├── manifests/
└── restore-drills/
```

The dedicated share is `gaylon-trips-spaces-backup` on Volume 3 with
`@administrators` read/write access (Btrfs, so snapshots work).

## Scripts

Repo copies (source of truth):

```text
scripts/nas/backup-spaces.sh
scripts/nas/snapshot-spaces-backup.sh
```

Deployed NAS copies:

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

## Setup Record

Completed 2026-06-23. SSH path used the `sshNAS` alias expansion:
`NASADMIN@192.168.22.74` with `~/.ssh/git_nas_key`.

1. Shared folder created in DSM: Control Panel -> Shared Folder -> Create
   `gaylon-trips-spaces-backup` on Volume 3, Btrfs, `@administrators` r/w.
2. Added `do-trips` rclone remote with the trips Spaces key/secret from
   `/opt/trips/.env` on the DigitalOcean droplet:
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
   Initial verification returned:
   ```json
   {"count":3,"bytes":904589,"sizeless":0}
   ```
3. Deployed the scripts from the repo to the share:
   ```sh
   # scp subsystem is disabled on this NAS, so deploy via ssh stdin:
   sshNAS 'cat > /volume3/gaylon-trips-spaces-backup/backup-spaces.sh' \
     < scripts/nas/backup-spaces.sh
   sshNAS 'cat > /volume3/gaylon-trips-spaces-backup/snapshot-spaces-backup.sh' \
     < scripts/nas/snapshot-spaces-backup.sh
   sshNAS 'chmod +x /volume3/gaylon-trips-spaces-backup/*.sh'
   ```
4. Dry-run, then first live pull:
   ```sh
   sshNAS '/volume3/gaylon-trips-spaces-backup/backup-spaces.sh --dry-run'
   sshNAS '/volume3/gaylon-trips-spaces-backup/backup-spaces.sh'
   ```
   First live pull:
   ```text
   objects=3 bytes=904589
   log=/volume3/gaylon-trips-spaces-backup/logs/spaces-rclone-20260623T161436Z.log
   manifest=/volume3/gaylon-trips-spaces-backup/manifests/spaces-rclone-manifest-20260623T161436Z.json
   ```
5. Scheduled in `/etc/crontab`, offset from madonnahist's 03:15/04:15 jobs:
   ```cron
   # trips Spaces backup: NAS pulls DO Spaces to Volume 3 daily.
   30 3 * * * NASADMIN /volume3/gaylon-trips-spaces-backup/backup-spaces.sh >> /volume3/gaylon-trips-spaces-backup/logs/spaces-cron.log 2>&1
   30 4 * * * root /volume3/gaylon-trips-spaces-backup/snapshot-spaces-backup.sh
   ```
6. Snapshot created successfully; `synosharesnapshot list gaylon-trips-spaces-backup`
   reported:
   ```text
   GMT-05-2026.06.23-11.15.01
   ```
7. Restore drill completed and recorded under:
   ```text
   /volume3/gaylon-trips-spaces-backup/restore-drills/20260623T161637Z/restore-drill.json
   ```
   Restored object:
   ```text
   trips/1/8ca5bd847e56e01f/PDF_document.pdf
   ```
   SHA-256 matched Spaces:
   ```text
   c930c30779c4f387ed077e36f2a4fd98e5b88068320eb57d1bc25bde8ea6c205
   ```

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
