# Postgres backups: base backup + WAL archive

The deployment keeps two things on disk so any moment of the database can be reconstructed:

| What | Where | Cadence |
|---|---|---|
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
per container start; without that it says so and keeps backing up locally.

Restoring from the mirror is the same runbook — copy a base backup directory and the WAL back
(or point `restore_command` at a mount of the mirror):

```bash
rsync -a backup-host:/data/backup/orbit-pg-archive/ data/pg-archive/
```

## Restore

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
docker compose up -d              # bring the rest back
```

Postgres replays every segment it finds and promotes when the archive runs out (the
"could not restore file … No such file" line at the end is how recovery notices it is done, not
an error).

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
