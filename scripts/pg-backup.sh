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
# Before the mirror's --delete it reads the target, and leaves one it cannot read, or that holds another
# cluster's archive, alone. The files copy is pruned by name, of bytes the database says have gone.
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
# The database that names those files (POSTGRES_DB in docker-compose.yml); PGDATABASE here is postgres.
FILES_DB=orbit
# When the off-host files copy was last pruned: at most once per interval, since it lists the whole copy.
LAST_PRUNE=0
# Whether this round's mirror went through. The files copy is pruned only then, so never on behalf of a
# cluster that target refused.
MIRRORED=no
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
  # Where rsync's stderr goes while its stdout is read, for this round: the loop removes it.
  if ! rsync_stderr="$(mktemp)"; then
    log "ERROR: off-host sync to $SYNC_TARGET failed: could not make a temporary file"
    return 1
  fi
}

# What the last rsync said on stderr, on one line and short enough for a log line. Only a failure asks: ssh says what it likes
# there on the way, such as a warning about the server's key exchange, which is neither a name in a listing nor a change, and
# ends its lines in carriage returns, which on a terminal would write over the start of the log line.
rsync_said() { printf '%s' "$(cat "$rsync_stderr")" | tr -d '\r' | tr '\n' ' ' | tail -c 300; }

# One directory of the target, as `rsync --list-only` prints it on stdout: "<mode> <size> <date> <time> <name>".
# A listing that fails says why on the way out and answers non-zero, unless the path is not there at all, which is what a first
# install looks like and answers as an empty directory. Exit 23 cannot tell those apart, since a directory it may not read exits 23
# too, and the words for which it was are the backup host's. So rsync is asked again: with --ignore-missing-args, and with -R so
# that it looks up the whole path at once, it exits 0 and lists nothing only if that lookup says the path does not exist.
list_target() {
  if listing="$(rsync --list-only --timeout=600 -e "ssh $ssh_opts" "$@" 2>"$rsync_stderr")"; then
    printf '%s\n' "$listing"
    return 0
  fi
  if found="$(rsync --list-only -R --ignore-missing-args --timeout=600 -e "ssh $ssh_opts" "$@" 2>/dev/null)" && [ -z "$found" ]; then
    return 0
  fi
  rsync_said
  return 1
}

# The lines of a listing, or of bare names, that are finished WAL segments: 24 hex digits, the timeline
# first, so that their names sort in the order Postgres wrote them.
segment_lines() { grep -E '(^| )[0-9A-F]{24}\.gz$' || true; }

# The name of the newest segment in such lines.
newest_segment() { awk '{print $NF}' | LC_ALL=C sort | tail -n1; }

# The system identifier in a gzipped segment's first page (XLogLongPageHeaderData.xlp_sysid: 8 bytes
# at offset 24), printed as pg_control_system() prints it. initdb chooses one for a new cluster, and a
# restored cluster keeps it on every timeline, so it says whose a segment is with nothing written anywhere.
segment_system_id() { gzip -dc "$1" 2>/dev/null | head -c 32 | od -An -tu8 -j24 -N8 2>/dev/null | tr -d ' \n'; }

# What an operator can do about a refused target, for the end of a log line.
replace_target_advice() {
  printf '%s' "If this host replaces the old one, restore from the target first (docs/postgres-backup-restore.md, Restore on a replacement host). If that archive really is to go, move it aside on the backup host and the next poll syncs as a first install."
}

# Whether the target is this cluster's to overwrite. The mirror's --delete removes whatever this archive
# does not hold, and a new cluster has a real base backup and real WAL of its own: one started by
# `docker compose up -d` before a restore would replace the only copy of the old cluster's history.
# Asked of what any mirror already holds, so it needs no marker there and works for one that predates it:
#   - nothing Postgres wrote: a first install;
#   - something in base/ and no segment: refused, whatever it is called, since nothing there says whose it is. This script
#     does not leave that (sync_archive);
#   - otherwise the system identifier in one of its segments, read every time, because a listing's name, size and time say
#     nothing of whose a file is. The smallest costs the least to fetch. A torn copy sorts there too and holds no
#     identifier, so the next is asked, three at most, rather than one bad file stopping the mirror for good.
# Every refusal is logged, and leaves the target as it was. Moving the old mirror aside on the backup host
# is how an operator replaces it on purpose: an empty target is a first install.
target_is_ours() {
  shared_segments=""
  if ! remote_wal="$(list_target "$SYNC_TARGET/wal/")"; then
    log "ERROR: off-host sync to $SYNC_TARGET failed: could not read the target: $remote_wal"
    return 1
  fi
  if ! remote_base="$(list_target -r "$SYNC_TARGET/base/")"; then
    log "ERROR: off-host sync to $SYNC_TARGET failed: could not read the target: $remote_base"
    return 1
  fi
  held="$(printf '%s\n' "$remote_base" | awk 'NF && $NF != "." {sub("/.*", "", $NF); print $NF}' | LC_ALL=C sort -u | tr '\n' ' ' | tail -c 200)"
  remote_segments="$(printf '%s\n' "$remote_wal" | segment_lines)"
  if [ -z "$remote_segments" ]; then
    if [ -n "$held" ]; then
      log "ERROR: refusing off-host sync to $SYNC_TARGET: it holds base backups and no WAL to tell whose they are (${held% }), and --delete would replace them. $(replace_target_advice)"
      return 1
    fi
    return 0
  fi

  if ! here="$(psql -Atc 'select system_identifier from pg_control_system()' 2>&1)"; then
    log "ERROR: off-host sync to $SYNC_TARGET skipped: could not read this cluster's system identifier: $(printf '%s' "$here" | tr '\n' ' ' | tail -c 200)"
    return 1
  fi
  local_segments="$(rsync --list-only "$WAL_DIR/" | segment_lines)"
  newest_here="$(printf '%s\n' "$local_segments" | newest_segment)"
  newest_there="$(printf '%s\n' "$remote_segments" | newest_segment)"
  # Old WAL copied back under a new cluster: its segments would pass as the target's own below.
  archived="$(segment_system_id "$WAL_DIR/$newest_here")"
  if [ "$archived" != "$here" ]; then
    log "ERROR: refusing off-host sync to $SYNC_TARGET: the newest WAL in $ARCHIVE_DIR ($newest_here) belongs to cluster ${archived:-unknown}, and this one is $here, and --delete would carry that to the target. $(replace_target_advice)"
    return 1
  fi

  scratch="$(mktemp -d)"
  there=""
  for segment in $(printf '%s\n' "$remote_segments" | tr -d , | sort -n -k2 | head -n 3 | awk '{print $NF}'); do
    rm -f "$scratch/segment"
    if ! rsync --timeout=600 -e "ssh $ssh_opts" "$SYNC_TARGET/wal/$segment" "$scratch/segment" >/dev/null 2>"$rsync_stderr"; then
      rm -rf "$scratch"
      log "ERROR: off-host sync to $SYNC_TARGET failed: could not read $segment from the target: $(rsync_said)"
      return 1
    fi
    there="$(segment_system_id "$scratch/segment")"
    [ -z "$there" ] || break
  done
  rm -rf "$scratch"
  if [ "$there" != "$here" ]; then
    log "ERROR: refusing off-host sync to $SYNC_TARGET: its archive belongs to cluster ${there:-unknown} (newest segment $newest_there) and this one is $here (newest segment $newest_here), and --delete would replace it. $(replace_target_advice)"
    return 1
  fi

  # This cluster's, and further on than this archive: a timeline or a segment this archive has never held.
  if [ "$(printf '%s\n%s\n' "$newest_here" "$newest_there" | LC_ALL=C sort | tail -n1)" != "$newest_here" ]; then
    log "ERROR: refusing off-host sync to $SYNC_TARGET: it holds WAL newer than $ARCHIVE_DIR (newest segment $newest_there there, $newest_here here), and --delete would remove it. $(replace_target_advice)"
    return 1
  fi
  shared_segments="$(printf '%s\n%s\n' "$remote_segments" "$local_segments" | awk '{print $NF}' | LC_ALL=C sort | uniq -d)"
}

# The base backups of this archive that the target holds whole: none of their files missing from its listing, or there with
# another size or time. rsync gives a file its name there only once all of it has arrived, so a backup a round was cut short
# in lacks one. A listing it cannot make here answers none, which only holds deletes back.
bases_whole_on_target() {
  here="$(rsync --list-only -r "$BASE_DIR/")" || return 0
  missing="$(printf '%s\n' "$here" | grep -v '^d' | grep -Fxv -e "$remote_base" | awk '{print $NF}' | cut -d/ -f1)"
  list_backups | grep -Fxv -e "$missing" || true
}

# The end of the line a failed round logs while deletes are held back, if what stopped it is the target running out of room.
# That state lasts until a person acts, so the line that repeats every poll has to say so. Given what rsync said.
no_room_advice() {
  [ "$hold_deletes" = yes ] || return 0
  case "$1" in
    *'No space left on device'*|*'Disk quota exceeded'*) ;;
    *) return 0 ;;
  esac
  printf '%s' " Nothing was deleted: the target cannot hold its old base backups and this archive at once, and the old ones stay until the new ones have landed. Free room on the backup host, or take the old ones off that disk by hand, and the next poll carries on."
}

# Mirror the archive to another machine. Runs every poll rather than only after a base
# backup, so the off-host copy trails the live one by minutes instead of a whole day of WAL.
sync_archive() {
  MIRRORED=no
  # A real archive holds a base backup and the WAL Postgres writes to it. Anything less is an
  # empty or wrong mount, say a recreate from another checkout, and --delete would clear the only
  # off-host copy. WAL too because this loop has already taken a base backup by now, even there, and a
  # finished segment because that directory also holds temporary files and backup history files.
  if [ -z "$(list_backups)" ] || [ -z "$(ls -A "$WAL_DIR" | segment_lines)" ]; then
    log "ERROR: refusing off-host sync to $SYNC_TARGET: $ARCHIVE_DIR holds no base backup or no WAL, and --delete would empty the target"
    return 1
  fi
  target_is_ours || return 1
  # A target holding one of this archive's base backups whole keeps it through --delete, wherever a round stops, so --delete
  # can go first and make room on a nearly full disk. One holding base backups and none of those (ORBIT_BASE_BACKUP_KEEP=1,
  # fallen behind past retention, or a base backup only partly there) would lose them on the way through, and with no room
  # for the new one would be left with none. So it is sent the whole archive first, deleting nothing, and --delete runs only
  # if that finished, which takes room for both at once. --delete-after would not do: when rsync cannot make a directory or a
  # temporary file it says so, carries on, and deletes all the same.
  hold_deletes=no
  if [ -n "$held" ] && [ -z "$(bases_whole_on_target)" ]; then hold_deletes=yes; fi
  # A target sharing a segment with this archive keeps it through --delete. One sharing none, on a first sync or
  # fallen behind past retention, is sent WAL first, on its own and deleting nothing: --delete alone would reach base/
  # first, and clear its old segments before new ones landed. So a target holds a finished segment before it holds a
  # base backup and keeps one from then on, wherever a round is cut short, and the next poll can read whose it is.
  # WAL goes first while deletes are held back too, so that it keeps landing when the base backup does not fit.
  # Then --delete so the copy mirrors retention instead of growing forever; --timeout so a
  # stalled transfer cannot wedge the loop and stop base backups; .staging-* is a backup
  # still being written, so it never ships.
  if ! sent="$( { { [ "$hold_deletes" = no ] && [ -n "$shared_segments" ]; } || rsync -a --timeout=600 --itemize-changes -e "ssh $ssh_opts" "$WAL_DIR" "$SYNC_TARGET/" 2>"$rsync_stderr"; } \
       && { [ "$hold_deletes" = no ] || rsync -a --timeout=600 --itemize-changes --exclude '.staging-*' -e "ssh $ssh_opts" "$ARCHIVE_DIR/" "$SYNC_TARGET/" 2>"$rsync_stderr"; })"; then
    log "ERROR: off-host sync to $SYNC_TARGET failed: $(rsync_said)$(no_room_advice "$(cat "$rsync_stderr")")"
    return 1
  fi
  if ! out="$(rsync -a --delete --timeout=600 --itemize-changes --exclude '.staging-*' \
       -e "ssh $ssh_opts" "$ARCHIVE_DIR/" "$SYNC_TARGET/" 2>"$rsync_stderr")"; then
    log "ERROR: off-host sync to $SYNC_TARGET failed: $(rsync_said)"
    return 1
  fi
  MIRRORED=yes
  changed="$(printf '%s\n%s\n' "$sent" "$out" | grep -c . || true)"
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
  # of, so what goes from this copy goes by name, in prune_files (docs/postgres-backup-restore.md).
  # tmp/ is uploads still arriving.
  if ! out="$(rsync -a --timeout=600 --itemize-changes --exclude '/tmp/' \
       -e "ssh $ssh_opts" "$FILES_DIR/" "$FILES_SYNC_TARGET/" 2>"$rsync_stderr")"; then
    log "ERROR: off-host sync to $FILES_SYNC_TARGET failed: $(rsync_said)"
    return 1
  fi
  changed="$(printf '%s\n' "$out" | grep -c . || true)"
  [ "$changed" -eq 0 ] || log "mirrored $changed change(s) to $FILES_SYNC_TARGET"
}

# Remove from the files copy the bytes the database says went from here a grace period ago, by name
# (file_blob.off_host_prune_at, which the apiserver's retention sweep writes one grace period after it
# deleted them, so that no database a retained backup can restore still expects them there). Nothing
# here depends on what the files directory holds, so an empty or unmounted one cannot empty the copy: the
# names come from the database, each is removed only if it is on the target and not back here (an upload
# of the same content), and an empty directory stops it anyway, since something is wrong with this host.
# At most once per base backup interval, because it lists the whole copy.
prune_files() {
  [ "$MIRRORED" = yes ] || return 0
  now="$(date -u +%s)"
  [ "$((now - LAST_PRUNE))" -ge "$INTERVAL" ] || return 0
  if ! due="$(psql -d "$FILES_DB" -Atc "select sha256 from file_blob where off_host_prune_at <= now() at time zone 'utc'" 2>&1)"; then
    log "WARN: not pruning $FILES_SYNC_TARGET: could not read which files have gone: $(printf '%s' "$due" | tr '\n' ' ' | tail -c 200)"
    return 1
  fi
  LAST_PRUNE="$now"
  due="$(printf '%s\n' "$due" | grep -E '^[0-9a-f]{64}$' || true)"
  [ -n "$due" ] || return 0
  if [ ! -d "$FILES_DIR" ] || [ -z "$(ls -A "$FILES_DIR" | grep -vx tmp)" ]; then
    log "ERROR: refusing to prune $FILES_SYNC_TARGET: $FILES_DIR is empty or not mounted"
    return 1
  fi
  # No copy there yet lists as empty, and so leaves nothing to prune.
  if ! listed="$(list_target -r "$FILES_SYNC_TARGET/")"; then
    log "ERROR: pruning $FILES_SYNC_TARGET failed: could not list it: $listed"
    return 1
  fi
  scratch="$(mktemp -d)"
  mkdir "$scratch/none"
  printf '%s\n' "$listed" | awk '{print $NF}' | LC_ALL=C sort > "$scratch/there"
  printf '%s\n' "$due" | awk '{print substr($0, 1, 2) "/" $0}' | LC_ALL=C sort > "$scratch/due"
  count=0
  # The database keeps naming what has gone, so most of these are long gone from the copy too.
  for file in $(LC_ALL=C comm -12 "$scratch/due" "$scratch/there"); do
    [ ! -e "$FILES_DIR/$file" ] || continue
    mkdir -p "$scratch/none/${file%/*}"
    printf '+ /%s/\n+ /%s\n' "${file%/*}" "$file" >> "$scratch/rules"
    count=$((count + 1))
  done
  if [ "$count" -eq 0 ]; then
    rm -rf "$scratch"
    return 0
  fi
  # A source holding only the empty directories of these names, so that --delete looks inside those and
  # keeps them. Every other name is excluded, which --delete leaves alone, and --max-delete says how many
  # this can be whatever the rules turn out to match.
  echo '- *' >> "$scratch/rules"
  if ! rsync -r --delete --max-delete="$count" --filter="merge $scratch/rules" --timeout=600 \
       -e "ssh $ssh_opts" "$scratch/none/" "$FILES_SYNC_TARGET/" >/dev/null 2>"$rsync_stderr"; then
    rm -rf "$scratch"
    log "ERROR: pruning $FILES_SYNC_TARGET failed: $(rsync_said)"
    return 1
  fi
  rm -rf "$scratch"
  log "pruned $count file(s) from $FILES_SYNC_TARGET"
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
    prune_files || true
    rm -f "$rsync_stderr"
  fi
  sleep "$POLL"
done
