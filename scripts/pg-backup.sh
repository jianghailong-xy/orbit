#!/bin/sh
# Periodic Postgres base backup + WAL-archive housekeeping (the `pgbackup` sidecar).
#
# Together with archive_mode/archive_command on the server this is what makes
# point-in-time recovery possible: a base backup is the starting image, the archived
# WAL rolls it forward to any moment after it. Restore runbook:
# docs/postgres-backup-restore.md.
#
# Connects over the socket the postgres container shares with this one, which pg_hba
# trusts (`local replication all trust`), so no password lives in this container.
# Layout, all under the bind mount both containers see:
#   /archive/wal/<segment>.gz     continuously archived WAL
#   /archive/base/<UTC stamp>/    base.tar.gz + pg_wal.tar.gz + start-wal
#
# That bind mount is on the same disk as the database, so with ORBIT_BACKUP_SYNC_TARGET
# set the loop also mirrors it to another machine over ssh — the only copy that survives
# losing this disk. The attachment files go with it: Postgres only names their bytes, which
# are in the files directory (docs/orbit-files-design.md §2.10), mounted here read-only.
set -eu

ARCHIVE_DIR="${ORBIT_ARCHIVE_DIR:-/archive}"
BASE_DIR="$ARCHIVE_DIR/base"
WAL_DIR="$ARCHIVE_DIR/wal"
INTERVAL="${ORBIT_BASE_BACKUP_INTERVAL:-86400}"
KEEP="${ORBIT_BASE_BACKUP_KEEP:-2}"
MIN_FREE_MB="${ORBIT_BACKUP_MIN_FREE_MB:-2048}"
# Off-host copy: empty disables it. The target is an rsync destination this container can
# reach over ssh, e.g. root@backup-host:/data/backup/orbit-pg-archive — give it a directory
# of its own, since the mirror deletes whatever is there and is not part of the archive.
SYNC_TARGET="${ORBIT_BACKUP_SYNC_TARGET:-}"
SYNC_SSH_PORT="${ORBIT_BACKUP_SYNC_SSH_PORT:-22}"
SYNC_SSH_KEY="${ORBIT_BACKUP_SYNC_SSH_KEY:-/ssh/id_rsa}"
SYNC_KNOWN_HOSTS="${ORBIT_BACKUP_SYNC_KNOWN_HOSTS:-/ssh/known_hosts}"
# The attachment files, and where they go: beside the target, never under it, where the
# archive mirror's --delete would remove them.
FILES_DIR="${ORBIT_FILES_DIR:-/var/lib/orbit/files}"
FILES_SYNC_TARGET="${SYNC_TARGET%/}-files"
# Backups are due on the interval; the loop wakes at least every 15 minutes so a run
# skipped for disk space retries without waiting a whole day.
if [ "$INTERVAL" -lt 900 ]; then POLL="$INTERVAL"; else POLL=900; fi

log() { echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') pg-backup: $*"; }

# Completed backups only: a run in progress lives under .staging-<stamp> and is
# renamed into place, so this list never contains a half-written backup.
list_backups() { ls -1 "$BASE_DIR" 2>/dev/null | grep -E '^[0-9]{8}T[0-9]{6}Z$' | sort; }

free_mb() { df -Pm "$ARCHIVE_DIR" | awk 'NR==2 {print $4}'; }

# What the next backup will roughly cost: the last one's size, or a third of the
# cluster (compressed base backups of this data land near that) before there is one.
estimate_mb() {
  last="$(list_backups | tail -n1)"
  if [ -n "$last" ]; then
    du -sm "$BASE_DIR/$last" | awk '{print $1}'
    return
  fi
  psql -Atc "select ceil(sum(pg_database_size(datname)) / 1024 / 1024 / 3) from pg_database" 2>/dev/null || echo 0
}

# Drop the oldest backups until at most $1 remain.
prune_bases() {
  keep="$1"
  total="$(list_backups | wc -l)"
  [ "$total" -gt "$keep" ] || return 0
  for b in $(list_backups | head -n "$((total - keep))"); do
    log "pruning base backup $b"
    rm -rf "${BASE_DIR:?}/$b"
  done
}

# WAL older than the oldest backup we still keep can never be replayed onto any of
# them, so it is pure disk cost.
trim_wal() {
  oldest="$(list_backups | head -n1)"
  [ -n "$oldest" ] || return 0
  start_wal="$(cat "$BASE_DIR/$oldest/start-wal" 2>/dev/null || true)"
  if [ -z "$start_wal" ]; then
    log "WARN: base backup $oldest has no start-wal marker; keeping all WAL"
    return 0
  fi
  pg_archivecleanup -x .gz "$WAL_DIR" "$start_wal"
}

# What both off-host copies need. False with no target, or with no way to reach one.
sync_ready() {
  [ -n "$SYNC_TARGET" ] || return 1
  # postgres:16-alpine ships neither rsync nor an ssh client; pull them in once per
  # container start, and keep taking local backups if that is not possible.
  if ! command -v rsync >/dev/null 2>&1 || ! command -v ssh >/dev/null 2>&1; then
    if ! apk add --no-cache rsync openssh-client >/dev/null 2>&1; then
      log "ERROR: cannot install rsync/openssh-client, skipping off-host sync to $SYNC_TARGET"
      return 1
    fi
  fi
  ssh_opts="-p $SYNC_SSH_PORT -i $SYNC_SSH_KEY -o BatchMode=yes -o ConnectTimeout=15"
  # Trust the same host keys the operator already trusts; without that file this would be
  # trust-on-first-use inside a container that forgets it on every recreate.
  if [ -f "$SYNC_KNOWN_HOSTS" ]; then
    ssh_opts="$ssh_opts -o UserKnownHostsFile=$SYNC_KNOWN_HOSTS -o StrictHostKeyChecking=yes"
  fi
}

# Mirror the archive to another machine. Runs every poll rather than only after a base
# backup, so the off-host copy trails the live one by minutes instead of a whole day of WAL.
sync_archive() {
  # A real archive holds a base backup and the WAL Postgres writes to it. Anything less is an
  # empty or wrong mount, say a recreate from another checkout, and --delete would clear the only
  # off-host copy. WAL too because this loop has already taken a base backup by now, even there.
  if [ -z "$(list_backups)" ] || [ -z "$(ls -A "$WAL_DIR")" ]; then
    log "ERROR: refusing off-host sync to $SYNC_TARGET: $ARCHIVE_DIR holds no base backup or no WAL, and --delete would empty the target"
    return 1
  fi
  # --delete so the copy mirrors retention instead of growing forever; --timeout so a
  # stalled transfer cannot wedge the loop and stop base backups; .staging-* is a backup
  # still being written, so it never ships.
  if ! out="$(rsync -a --delete --timeout=600 --itemize-changes --exclude '.staging-*' \
       -e "ssh $ssh_opts" "$ARCHIVE_DIR/" "$SYNC_TARGET/" 2>&1)"; then
    log "ERROR: off-host sync to $SYNC_TARGET failed: $(printf '%s' "$out" | tr '\n' ' ' | tail -c 300)"
    return 1
  fi
  changed="$(printf '%s\n' "$out" | grep -c . || true)"
  [ "$changed" -eq 0 ] || log "mirrored $changed change(s) to $SYNC_TARGET"
}

# Copy the attachment files to the same machine. A name is a sha256 and never changes its
# bytes, so each poll carries only what is new.
sync_files() {
  # Nothing but tmp/: the bytes are in a bucket (ORBIT_FILES_BACKEND=s3), or nothing has been
  # uploaded yet. Asked of the directory, not the setting: a deployment that moved to a bucket
  # still has its older bytes here. A directory that is not there at all is not this case: it
  # is a container not recreated since the mount was added, which rsync then reports below.
  if [ -d "$FILES_DIR" ] && [ -z "$(ls -A "$FILES_DIR" | grep -vx tmp)" ]; then
    return 0
  fi
  # No --delete: a Postgres backup still retained may name bytes the live database has let go
  # of, so this copy only ever grows (docs/postgres-backup-restore.md). tmp/ is uploads still
  # arriving.
  if ! out="$(rsync -a --timeout=600 --itemize-changes --exclude '/tmp/' \
       -e "ssh $ssh_opts" "$FILES_DIR/" "$FILES_SYNC_TARGET/" 2>&1)"; then
    log "ERROR: off-host sync to $FILES_SYNC_TARGET failed: $(printf '%s' "$out" | tr '\n' ' ' | tail -c 300)"
    return 1
  fi
  changed="$(printf '%s\n' "$out" | grep -c . || true)"
  [ "$changed" -eq 0 ] || log "mirrored $changed change(s) to $FILES_SYNC_TARGET"
}

take_backup() {
  stamp="$(date -u '+%Y%m%dT%H%M%SZ')"
  need="$(estimate_mb)"
  free="$(free_mb)"
  # Make room from our own retention first; only give up if that is not enough.
  if [ "$free" -lt "$((need + MIN_FREE_MB))" ]; then
    keep_min="$((KEEP - 1))"
    [ "$keep_min" -ge 1 ] || keep_min=1
    prune_bases "$keep_min"
    trim_wal
    free="$(free_mb)"
  fi
  if [ "$free" -lt "$((need + MIN_FREE_MB))" ]; then
    log "ERROR: skipping base backup — ${free}MB free on $ARCHIVE_DIR, need ~$((need + MIN_FREE_MB))MB (backup ~${need}MB + ${MIN_FREE_MB}MB headroom). Free disk or lower ORBIT_BASE_BACKUP_KEEP."
    return 1
  fi

  # Captured before the backup starts, so it is at or before the segment the backup
  # actually needs: trimming WAL from here can only ever keep too much, never too little.
  start_wal="$(psql -Atc 'select pg_walfile_name(pg_current_wal_lsn())')"
  staging="$BASE_DIR/.staging-$stamp"
  rm -rf "$staging"
  log "starting base backup $stamp (~${need}MB expected, ${free}MB free)"
  if ! pg_basebackup --pgdata="$staging" --format=tar --gzip --wal-method=stream \
       --checkpoint=fast --label="orbit-$stamp"; then
    log "ERROR: pg_basebackup failed; leaving previous backups untouched"
    rm -rf "$staging"
    return 1
  fi
  echo "$start_wal" > "$staging/start-wal"
  mv "$staging" "$BASE_DIR/$stamp"
  log "completed base backup $stamp ($(du -sh "$BASE_DIR/$stamp" | awk '{print $1}'), WAL from $start_wal)"

  prune_bases "$KEEP"
  trim_wal
  log "retained $(list_backups | tr '\n' ' ')— archive $(du -sh "$ARCHIVE_DIR" | awk '{print $1}'), $(free_mb)MB free"
}

backup_due() {
  last="$(list_backups | tail -n1)"
  [ -n "$last" ] || return 0
  age="$(( $(date -u +%s) - $(stat -c %Y "$BASE_DIR/$last") ))"
  [ "$age" -ge "$INTERVAL" ]
}

# Archiving that has started failing is the silent killer here: WAL piles up in
# pg_wal until the disk is full and Postgres stops. Say so on every poll while it lasts.
check_archiver() {
  row="$(psql -Atc "select coalesce(last_failed_time > last_archived_time, last_failed_wal is not null), coalesce(last_failed_wal, '-'), failed_count from pg_stat_archiver" 2>/dev/null || true)"
  [ -n "$row" ] || return 0
  case "$row" in
    t\|*) log "ERROR: WAL archiving is failing (last failed segment $(echo "$row" | cut -d'|' -f2), $(echo "$row" | cut -d'|' -f3) failures). pg_wal will grow until this is fixed." ;;
  esac
}

mkdir -p "$BASE_DIR" "$WAL_DIR"
# A base backup cut short when this container stopped: an upgrade recreates it when this script
# changes. Nothing is running yet, and no later run would come back for this one's disk space.
rm -rf "$BASE_DIR"/.staging-*
log "watching: base backup every ${INTERVAL}s, keeping $KEEP, ${MIN_FREE_MB}MB headroom on $ARCHIVE_DIR${SYNC_TARGET:+, mirroring to $SYNC_TARGET and $FILES_SYNC_TARGET}"
while :; do
  if backup_due; then
    take_backup || true
  fi
  check_archiver
  # The archive first: bytes reach the files directory before the row naming them commits, so
  # a round that finishes leaves the mirror with the bytes of every row in its WAL. Neither
  # copy failing stops the other.
  if sync_ready; then
    sync_archive || true
    sync_files || true
  fi
  sleep "$POLL"
done
