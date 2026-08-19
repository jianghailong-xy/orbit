#!/bin/sh
# archive_command for the deployment's Postgres: gzip one finished WAL segment into
# the archive, atomically and without ever overwriting a segment we already hold.
#
# Postgres calls this as `pg-archive-wal.sh %p %f` from inside PGDATA (%p is the
# segment's path relative to it, %f its file name). A non-zero exit keeps the segment
# in pg_wal and makes Postgres retry, so a full disk or an unmounted archive stalls
# archiving instead of silently losing WAL — watch the pgbackup log for that.
set -eu

src="$1"
name="$2"
dir="${ORBIT_ARCHIVE_DIR:-/archive}/wal"
dest="$dir/$name.gz"

# Re-archiving a segment (Postgres retries, e.g. after a crash) is fine while the
# contents match. Different contents under a name we already hold would corrupt the
# archive, so fail loudly and let an operator look.
if [ -f "$dest" ]; then
  if gzip -dc "$dest" | cmp -s - "$src"; then
    exit 0
  fi
  echo "pg-archive-wal: $name is already archived with different contents" >&2
  exit 1
fi

# Compress to a temp name and rename, so a crash mid-write can never leave a
# truncated segment looking like a complete one.
tmp="$dir/.$name.$$.tmp"
trap 'rm -f "$tmp"' EXIT
gzip -c "$src" > "$tmp"
mv "$tmp" "$dest"
