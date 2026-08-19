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
set -eu

ARCHIVE_DIR="${ORBIT_ARCHIVE_DIR:-/archive}"
BASE_DIR="$ARCHIVE_DIR/base"
WAL_DIR="$ARCHIVE_DIR/wal"
INTERVAL="${ORBIT_BASE_BACKUP_INTERVAL:-86400}"
KEEP="${ORBIT_BASE_BACKUP_KEEP:-2}"
MIN_FREE_MB="${ORBIT_BACKUP_MIN_FREE_MB:-2048}"
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
log "watching: base backup every ${INTERVAL}s, keeping $KEEP, ${MIN_FREE_MB}MB headroom on $ARCHIVE_DIR"
while :; do
  if backup_due; then
    take_backup || true
  fi
  check_archiver
  sleep "$POLL"
done
