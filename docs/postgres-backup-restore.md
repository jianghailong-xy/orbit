# Postgres backups: base backup + WAL archive

The deployment keeps two things on disk so any moment of the database can be reconstructed:

| What | Where | Cadence |
| --- | --- | --- |
| Continuous WAL archive | `./data/pg-archive/wal/<segment>.gz` | every finished segment; a written-to database closes one at least every 5 min (`archive_timeout=300`) |
| Base backups | `./data/pg-archive/base/<UTC stamp>/` | daily, newest 2 kept |

A base backup is the image the archived WAL is replayed onto; on their own neither restores
anything. Recovery point is therefore "the last archived segment" — within ~5 minutes of a
crash, and exactly a chosen timestamp when recovering from a bad write.

Who does what:

- `postgres` runs with `archive_mode=on` and `archive_command=scripts/pg-archive-wal.sh`, which
  gzips each finished segment into the archive, atomically, refusing to overwrite a segment it
  already holds.
- The `pgbackup` sidecar (`scripts/pg-backup.sh`) takes the base backups with `pg_basebackup`
  over the shared unix socket, drops backups past the retention count, and then trims WAL that
  no retained backup could replay onto.

Knobs (`.env`, all optional):

```bash
ORBIT_BASE_BACKUP_INTERVAL=86400   # seconds between base backups
ORBIT_BASE_BACKUP_KEEP=2           # base backups to retain
ORBIT_BACKUP_MIN_FREE_MB=2048      # free disk to leave; a backup that would eat into it is skipped
```

## Checking it works

```bash
docker logs --tail 20 orbit-pgbackup          # one line per backup, plus loud errors
ls -la data/pg-archive/base data/pg-archive/wal
docker exec orbit-postgres psql -U orbit -d orbit \
  -c "select archived_count, last_archived_wal, last_archived_time,
             failed_count, last_failed_wal, last_failed_time from pg_stat_archiver"
```

**If archiving is failing, fix it now.** Postgres keeps every unarchived segment in `pg_wal`
forever, so a broken `archive_command` ends as a full disk and a stopped database. The sidecar
logs `ERROR: WAL archiving is failing` while that is the case. Note that `archive_command` is
set on the server's command line in `docker-compose.yml`, so `ALTER SYSTEM` cannot change it —
edit compose and recreate the container.

## The off-host mirror

**The archive is on the same disk as the database.** It survives `DROP TABLE`, a bad migration
and corruption; it does not survive losing the disk. Set a target and the sidecar mirrors the
whole archive to another machine over ssh on every poll — within ~15 minutes of a segment being
archived, not a base backup later:

```bash
ORBIT_BACKUP_SYNC_TARGET="root@backup-host:/data/backup/orbit-pg-archive"
ORBIT_BACKUP_SYNC_SSH_PORT=1522        # default 22
ORBIT_BACKUP_SSH_DIR=/root/.ssh        # mounted read-only at /ssh; needs id_rsa + known_hosts
```

The mirror is `rsync -a --delete`, so it tracks retention instead of growing forever — **give it
a directory of its own**, because anything else living there is deleted. Backups still being
written (`.staging-*`) are excluded, host keys are checked against the mounted `known_hosts`, and
a failure is logged (`ERROR: off-host sync … failed`) without interrupting local backups. The
sidecar installs `rsync`/`openssh-client` at start, so it needs to reach an Alpine mirror once
per container start; without that it says so and keeps backing up locally. It refuses to mirror an
archive with no base backup or no finished WAL segment (`ERROR: refusing off-host sync …`), so an empty or
wrong mount cannot clear the target.

A target sharing a segment with this archive keeps it through `--delete`. One sharing none, on a first sync or fallen behind
past retention, is sent `wal/` first, on its own and deleting nothing, and only then gets that mirror. A target therefore
holds a finished segment before it holds a base backup, and keeps one from then on, so a sync cut short at any point is
carried on by the next poll with nobody acting.

`--delete` does not take the target's last base backup before another has landed. A target holding one of this archive's base
backups whole keeps that one through `--delete`, which can then make room first: at the default `ORBIT_BASE_BACKUP_KEEP=2`, a
target in step always holds one. A target holding base backups and none of those whole (`ORBIT_BASE_BACKUP_KEEP=1`, fallen behind
past retention, or the one it shares only partly there) is sent the whole archive first, deleting nothing, and `--delete` runs
only if that finished. **For that round its disk needs room for what it holds and the whole archive at once.** Without it the
sync fails with `No space left on device` on every poll, with a `WARN` beside it, and the old base backups stay. WAL keeps landing
until that fills the disk too. Free some room, or take the old base backups off that disk by hand, and the next poll carries on.

**It also reads the target first, and leaves another cluster's archive alone.** A new cluster has a real
base backup and real WAL of its own, so one started before a restore would otherwise replace the only copy
of the old history. Each poll, before `--delete`, the sidecar lists the target's `wal/` and `base/`:

| What the target holds | What happens |
| --- | --- |
| Nothing in `base/` and no finished segment, or the directory is not there yet | A first install: it syncs |
| Anything in `base/` and no finished segment | Refused: nothing there says whose it is, whatever it is called |
| Segments whose smallest has this cluster's system identifier | The same cluster, restored or back after an outage too: it syncs |
| Segments with another system identifier | Refused |
| WAL further on than here, on a later timeline or a later segment | Refused: `--delete` would remove it |

It also refuses if the newest WAL here is not this running cluster's own, which is what a new cluster started
over an archive copied back looks like. A restored cluster keeps its system identifier on every timeline, so
it syncs as usual. The identifier is read from the segment's own first page, so this works on a mirror made
before this check, and writes no marker on the target. A new `initdb` is a new cluster however it comes about: moving to a
new major version by dump and restore or by `pg_upgrade` gives it a new identifier, and the old mirror has to be moved aside.

This script does not leave a base backup with no finished segment beside it. A sidecar older than this check could: it sent
`base/` first, and deleted old segments before new ones landed, so a sync it had cut short can look like that. Such a
target is refused like any other and has to be moved aside by hand, as below, because nothing there can say it is this
cluster's. A mirror whose last sync finished holds WAL, so it is not this case.

The read happens on every poll, before every `--delete`, because a listing's name, size and time say nothing of whose a file
is. It fetches that one segment whole: about 17 KB for a segment closed nearly empty, and around 12 MB for a full one, so at
most about 1 GB a day at one poll every 15 minutes. A torn copy sorts first and holds no identifier, so the next smallest is
read instead, three at most; if none of the three holds one the target is refused as `cluster unknown`.

A refusal is `ERROR: refusing off-host sync …`, every poll until it is dealt with, and says why. It costs nothing
else: base backups carry on, and so does the [files copy](#attachment-files), which deletes nothing that way. To deal
with one:

- **This host replaces the old one:** restore from the target first ([Restore on a replacement host](#restore-on-a-replacement-host)).
- **That archive really is to go:** move it aside on the backup host. An empty target is a first install, so the next
  poll syncs, and nothing is deleted until you delete what you moved.

  ```bash
  ssh backup-host mv /data/backup/orbit-pg-archive /data/backup/orbit-pg-archive.old
  ```

The sidecar runs the script it started with, so a newer `scripts/pg-backup.sh` does nothing until the container is
recreated. `/upgrade` does that when the two differ; by hand it is `docker compose up -d --no-deps --force-recreate
pgbackup`. A target already in use goes on syncing as before.

### Attachment files

Postgres only names an attachment's bytes. They are in `./data/files`, which neither the WAL archive
nor a base backup contains, so a restored database needs that directory back as well. With a target
set, the sidecar copies it on every poll, right after the archive, to the directory beside the target
with `-files` added to its name:

| `ORBIT_BACKUP_SYNC_TARGET` | Where `./data/files` goes |
| --- | --- |
| `root@backup-host:/data/backup/orbit-pg-archive` | `root@backup-host:/data/backup/orbit-pg-archive-files` |

It goes beside the target and not under it because the mirror's `--delete` would remove it there. There
is nothing more to set, but the ssh user has to be able to create that directory: if it cannot write to
the target's parent, create the directory by hand once.

The copy is `rsync -a` with no `--delete`, because a Postgres backup still retained may name bytes the
live database has let go of. Uploads still arriving (`tmp/`) are excluded. A failure is logged
like the mirror's (`ERROR: off-host sync … failed`), does not touch base backups or the mirror, and is
retried on the next poll. The archive goes first, because bytes are stored before the row naming them
commits: a round that finishes leaves the copy with the bytes of every row in the mirrored WAL.

#### How the copy is pruned

Files agents upload expire, and their bytes then go in steps, each a grace period after the last. The grace period is
max(7 days, `ORBIT_BASE_BACKUP_INTERVAL` × (`ORBIT_BASE_BACKUP_KEEP` + 1)), so at least as long as a retained backup reaches
back: a backup stays until `ORBIT_BASE_BACKUP_KEEP` newer ones have finished, and each round takes a little longer than the
interval, which the one more covers. Base backups that stop being taken, for lack of disk or with the sidecar down, keep the
old ones longer than that. Restoring one of those can find rows without their bytes, which the
[check below](#restore-the-attachment-files) lists.

| When | What happens |
| --- | --- |
| The file's date | A tombstone on its row (`expired_at`). Name, size, sha256 and test summary stay, and so do the bytes, here and in the copy |
| One grace period after the last row naming those bytes got its tombstone | The bytes go from `./data/files` (`file_blob.bytes_deleted_at`) |
| One grace period after that | The bytes go from the off-host copy (`file_blob.off_host_prune_at`) |

The sidecar prunes at most once per base backup interval, and only in a round where the mirror took this archive. It
asks the database which names are due, lists the copy, and removes those names and nothing else: `pruned N file(s) from …`.
It is not a `--delete` of what `./data/files` lacks, so an empty or unmounted directory cannot empty the copy. If
`./data/files` is empty or not mounted it refuses even those names (`ERROR: refusing to prune …`), and it skips a name whose
bytes are back here because the same content was uploaded again.

That order is what makes a restore safe. A database restored to any moment a retained backup reaches expects the bytes that
had not gone by that moment, and the copy keeps them a whole grace period longer, which is at least as far back as any backup
reaches. Without an off-host target, `./data/files` alone still holds the bytes of every file that had no tombstone at that
moment. With `ORBIT_FILES_BACKEND=s3` the bytes go from the bucket and nothing is pruned from the copy: use the bucket's own
versioning or lifecycle rules for anything older. Neither attachment rows nor `file_blob` rows are deleted by any of this.

- **With no target,** `./data/files` is the only copy of those bytes. Postgres does not hold them and no
  local backup does, so they are lost with the disk.
- **With `ORBIT_FILES_BACKEND=s3`,** keeping the bytes is the bucket's job: use its versioning or
  replication. Uploads only pass through `./data/files/tmp`, so the sidecar has nothing to copy, and that
  is not an error. Bytes left in the directory from before a move to a bucket are still copied.

The sidecar gets its read-only mount of `./data/files` when its container is recreated, and until then
it copies no files. `docker compose up -d --build` recreates it, and so does `/upgrade`, which runs only
in the checkout the deployment runs from.
`docker logs orbit-pgbackup | grep watching` then names both directories.

### Restore on a replacement host

Restoring from the mirror is the same runbook with the archive copied back first (or `restore_command`
pointed at a mount of the mirror). Follow these steps in order:

1. Put `.env` back **without `ORBIT_BACKUP_SYNC_TARGET`**. With it unset the sidecar makes no off-host
   copy, so nothing on this host can touch the mirror until the restore is done.
2. Copy the archive back **before the first `docker compose up -d`**. A new cluster has a real archive
   of its own, and starting one first gives you a database and a `data/pg-archive` you have to move aside
   again. The sidecar [refuses to mirror it](#the-off-host-mirror) over the old archive even with a target
   set, but that is a guard, not a step to rely on.

   ```bash
   mkdir -p data
   rsync -a backup-host:/data/backup/orbit-pg-archive/ data/pg-archive/
   ```

3. Follow [Restore to the newest state](#restore-to-the-newest-state-diskcorruption-loss), then
   [Restore the attachment files](#restore-the-attachment-files).
4. Put `ORBIT_BACKUP_SYNC_TARGET` back in `.env` and recreate the sidecar:

   ```bash
   docker compose up -d --no-deps pgbackup
   ```

## Restore

On a replacement host, where nothing survived, start at
[Restore on a replacement host](#restore-on-a-replacement-host).

Both paths below replace the live database. Take the deployment down first and keep the damaged
copy — it is evidence, and a second attempt may need it:

```bash
docker compose stop gateway web apiserver pgbackup postgres
mv data/postgres data/postgres.broken-$(date -u +%Y%m%dT%H%M%SZ)
```

### Restore to the newest state (disk/corruption loss)

```bash
BASE=data/pg-archive/base/$(ls -1 data/pg-archive/base | tail -1)
mkdir -p data/postgres
tar xzf "$BASE/base.tar.gz"   -C data/postgres
tar xzf "$BASE/pg_wal.tar.gz" -C data/postgres/pg_wal

cat >> data/postgres/postgresql.auto.conf <<'EOF'
restore_command = 'gzip -dc /archive/wal/%f.gz > %p'
recovery_target_action = 'promote'
EOF
touch data/postgres/recovery.signal
chown -R 70:70 data/postgres && chmod 700 data/postgres

docker compose up -d postgres
docker logs -f orbit-postgres     # wait for "archive recovery complete"
```

Postgres replays every segment it finds and promotes when the archive runs out (the
"could not restore file … No such file" line at the end is how recovery notices it is done, not
an error). Then [restore the attachment files](#restore-the-attachment-files), which brings back the
rest of the stack.

### Restore to a point in time (bad write, wrong migration)

Same as above, plus a target — pick a timestamp *before* the damage, with an explicit offset:

```bash
cat >> data/postgres/postgresql.auto.conf <<'EOF'
restore_command = 'gzip -dc /archive/wal/%f.gz > %p'
recovery_target_time = '2026-08-19 04:30:00+00'
recovery_target_action = 'promote'
EOF
```

Recovery stops before the first transaction that committed after that time and logs
`recovery stopping before commit of transaction …`. If you overshot, restore again from the same
base backup with an earlier target — the base backup and the archive are untouched by a failed
attempt, which is why the first step keeps the broken data directory instead of deleting it.

Both paths need the base backup to be *older* than the target time; `data/pg-archive/base/<stamp>/start-wal`
records the first WAL segment each backup needs, and segments older than the oldest retained
backup are pruned, so a target older than the oldest base backup is not recoverable here.

### Restore the attachment files

Both paths above continue here: **Postgres first, then the files, and only then the apiserver.** The
restored database says which bytes have to exist, and nothing should serve its rows until they do.

If `./data/files` was lost, copy it back from the [off-host copy](#attachment-files). If it survived,
keep it: bytes no row names any more do no harm, and a row needs its bytes to stay readable.

```bash
rsync -a backup-host:/data/backup/orbit-pg-archive-files/ data/files/
```

Either way, check that every row finds its bytes. Nothing printed means they all do; a `missing` line
is an attachment that was uploaded too shortly before the loss to reach the copy, and it cannot be
read. Bytes the database says have gone (`bytes_deleted_at`, an expired file past its grace period) are left out, since
nothing expects them. Then bring back the rest:

```bash
docker exec orbit-postgres psql -U orbit -d orbit -Atc "select sha256 from file_blob where storage = 'local' and bytes_deleted_at is null" |
  while read -r sha; do [ -f "data/files/${sha:0:2}/$sha" ] || echo "missing $sha"; done
docker compose up -d              # bring the rest back
```

A point-in-time restore can bring back a row with a tombstone whose bytes went after the moment you restored to. If
`./data/files` survived, copy the off-host copy over it as above: it keeps those bytes for a grace period, and the copy
adds them without touching anything else. Such a file already read as expired at that moment, so nothing that was live
depends on them.

The copy has no `tmp/`, and the apiserver makes it again at the next upload. With
`ORBIT_FILES_BACKEND=s3` there is nothing to copy back: start the deployment on the same bucket, whose
own versioning or replication is what brings back any object that was lost.

### Verify a backup without touching production

Restore into a scratch directory and start a throwaway server on it; mount the archive
read-only so the drill cannot damage it:

```bash
BASE=$PWD/data/pg-archive/base/$(ls -1 data/pg-archive/base | tail -1)
rm -rf /tmp/pgverify && mkdir -p /tmp/pgverify/pgdata
tar xzf "$BASE/base.tar.gz"   -C /tmp/pgverify/pgdata
tar xzf "$BASE/pg_wal.tar.gz" -C /tmp/pgverify/pgdata/pg_wal
cat >> /tmp/pgverify/pgdata/postgresql.auto.conf <<'EOF'
restore_command = 'gzip -dc /archive/wal/%f.gz > %p'
recovery_target_action = 'promote'
EOF
touch /tmp/pgverify/pgdata/recovery.signal
chown -R 70:70 /tmp/pgverify/pgdata && chmod 700 /tmp/pgverify/pgdata

docker run -d --name pgverify \
  -v /tmp/pgverify/pgdata:/var/lib/postgresql/data \
  -v "$PWD/data/pg-archive:/archive:ro" \
  -e POSTGRES_PASSWORD=x postgres:16-alpine
docker exec pgverify psql -U orbit -d orbit -c "select count(*) from session"
docker rm -f pgverify && rm -rf /tmp/pgverify
```

## Disk

A base backup is a compressed copy of the **whole cluster**, every database in it, so leftover
`orbit_*` copies from a past recovery are paid for in every backup — drop them when the recovery
that made them is closed. Budget roughly `ORBIT_BASE_BACKUP_KEEP × (cluster size ÷ 3)` for the
base backups plus the WAL written since the oldest of them. When the free space left would drop
below `ORBIT_BACKUP_MIN_FREE_MB`, the sidecar prunes down to one older backup, and if that is
still not enough it skips the run with an error rather than filling the disk under Postgres.
