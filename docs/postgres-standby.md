# PostgreSQL standby, database proxy and archive generations

How production's PostgreSQL 16.14 moves from wikova to 10.66.0.4 (vmi3753066) with a short write stop and a way
back (project 34wyV15NQg1Aa6H3cr6SH). Task 34wyYvEa8eSNTYoO3aGuk set up three pieces on 2026-11-13:

- a streaming standby on 10.66.0.4, fed over WireGuard by wikova's `orbit-postgres`;
- `db-proxy`, a TCP proxy, as the database entry the apiserver will use there;
- a pgbackup on 10.66.0.4, created but not started, that will write a new archive generation on the backup host.

A single-host deployment uses none of this. Its `.env` names neither of the two Compose files below, and
`docker-compose.yml` does not change.

## Where things are

| Host | What | Where |
| --- | --- | --- |
| wikova (10.66.0.1) | The primary, `orbit-postgres` | `/root/orbit/data/postgres` |
| wikova | Role `replicator` (LOGIN REPLICATION), slot `standby_10_66_0_4`, `max_slot_wal_keep_size = 30GB`, two `pg_hba.conf` lines for 10.66.0.4 | In that cluster; `pg_hba.conf` as it was before is `/root/orbit-pg-replication/pg_hba.conf.before-20261113T175132Z` |
| wikova | The forward of 10.66.0.1:5432 on `wg1`, for 10.66.0.4 only | `/usr/local/sbin/orbit-pg-standby-forward`, `orbit-pg-standby-forward.service` and `.timer` in `/etc/systemd/system`; the same files are in `deploy/pg-standby-forward/` |
| wikova and 10.66.0.4 | The replication password | `/root/orbit-pg-replication/password` (mode 0600) |
| 10.66.0.4 | Compose project `orbit`: `docker-compose.yml`, the two Compose files under `deploy/`, the files its services mount, and `.env`. No source checkout | `/root/orbit` |
| 10.66.0.4 | The standby, `orbit-postgres` | `/root/orbit/data/postgres`, a bind mount |
| 10.66.0.4 | `orbit-db-proxy` | `deploy/db-proxy.yml`, `deploy/db-proxy/haproxy.cfg` |
| 10.66.0.4 | `orbit-pgbackup`, created and not started | Archive `/root/orbit/data/pg-archive`; ssh key and known hosts `/root/orbit-pgbackup-ssh` |
| Backup host (`workstation`, 10.66.0.3 on WireGuard, ssh port 1522) | Archive generation 1, wikova's | `/data/backup/orbit-pg-archive`, `/data/backup/orbit-pg-archive-files` |
| Backup host | Archive generation 2, 10.66.0.4's | `/data/backup/orbit-pg-archive-gen2/archive`, `/data/backup/orbit-pg-archive-gen2/archive-files` |

## The primary side

`replicator` may replicate from 10.66.0.4, and nothing else may connect from that address:

```text
host    replication     replicator      10.66.0.4/32            scram-sha-256
host    all             all             10.66.0.4/32            reject
```

The two lines sit just above the image's `host all all all scram-sha-256` line, and a reload applied them. The
server was given only the password's SCRAM verifier, never the password itself.

The slot keeps every WAL segment the standby has not yet received. Production writes about 10–13 GB of WAL a
day, and wikova's disk also holds the archive and QA. `max_slot_wal_keep_size = 30GB` (set with `ALTER SYSTEM`,
applied by a reload) bounds what a lost standby can hold there to two or three days. Past that, PostgreSQL
invalidates the slot (`wal_status = lost`) and the primary keeps running; the standby then has to be
[built again](#building-it-again).

### The forward

The production container publishes no port, and publishing one means recreating it, which restarts the database.
`orbit-pg-standby-forward` does what Docker's own port publishing would. It adds a DNAT in `nat/PREROUTING`, which
sends connections arriving on `wg1` from 10.66.0.4 for 10.66.0.1:5432 to the container's address. It also adds an
accept for them in `DOCKER-USER`, which Docker never flushes. The connection keeps 10.66.0.4 as its source address,
which is why `pg_hba.conf` can name it. The timer runs the script every minute. The script rewrites a rule only when
the container's address has changed, as it does when the container is recreated.

```sh
iptables -t nat -S ORBIT-PG-STANDBY; iptables -S ORBIT-PG-STANDBY
systemctl list-timers orbit-pg-standby-forward.timer
```

## The standby

The standby was built on 10.66.0.4, into an empty `/root/orbit/data/postgres` (owner 70:70, mode 0700):

```sh
docker run --rm --network host \
  -v /root/orbit/data/postgres:/var/lib/postgresql/data \
  -v /root/orbit-pg-replication/password:/run/orbit-replication-password:ro \
  --entrypoint sh 10.66.0.1:5000/library/postgres@sha256:d845e7f0ac8517b9d9868b6d20379f9688ba3676595e50ca7c0b664964b2a760 -c '
    export PGPASSWORD="$(cat /run/orbit-replication-password)"
    exec su-exec postgres pg_basebackup -h 10.66.0.1 -p 5432 -U replicator -D /var/lib/postgresql/data \
      -X stream -S standby_10_66_0_4 -R --checkpoint=spread --max-rate=40M -v -P'
printf '%s\n' "wal_level = 'logical'" >> /root/orbit/data/postgres/postgresql.auto.conf
```

`-R` writes `standby.signal`. It also adds `primary_conninfo`, which carries the password, and `primary_slot_name`
to `postgresql.auto.conf`. That file already holds the primary's `ALTER SYSTEM` settings: `shared_buffers = 4GB`,
`effective_cache_size = 12GB`, `log_lock_waits` and `max_slot_wal_keep_size`. Every other setting comes from the
postgres command in `docker-compose.yml`, the same as production's.

`wal_level = 'logical'` is the standby's own setting. PostgreSQL allows it on a standby, where it changes nothing,
and applies it once the server is promoted. The PG18 upgrade needs it for logical replication (project
34ERyUXgvyZT1hi1lxu9p). A standby built again from wikova gets wikova's `postgresql.auto.conf` and needs the line
again.

Start and stop the standby from `/root/orbit`. Until the deploy stage puts production's `.env` there, Compose
refuses to render anything without the apiserver's three required secrets. Name placeholders for them on the command
line: the postgres service reads none of them, and its config hash does not depend on them.

```sh
cd /root/orbit
JWT_SECRET=unused PROVIDER_SECRET_KEY=unused RUNNER_LINK_SIGNING_KEY=unused docker compose up -d --no-deps postgres
```

### Checking it

On 10.66.0.4:

```sh
docker exec orbit-postgres psql -U orbit -d orbit -c "select server_version, pg_is_in_recovery(), current_setting('wal_level')"
docker exec orbit-postgres psql -U orbit -d orbit -c "select status, sender_host, slot_name, latest_end_lsn, latest_end_time from pg_stat_wal_receiver"
```

On wikova:

```sh
docker exec orbit-postgres psql -U orbit -d postgres -c "select client_addr, state, replay_lag, pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) as bytes_behind from pg_stat_replication"
docker exec orbit-postgres psql -U orbit -d postgres -c "select slot_name, active, wal_status, safe_wal_size from pg_replication_slots"
```

### Building it again

Do this if the slot was lost or the data directory is suspect:

1. Stop the standby: `docker compose stop postgres`.
2. Move `/root/orbit/data/postgres` aside on 10.66.0.4. Never touch wikova's data directory.
3. If the slot is lost, re-create it on wikova:
   `select pg_drop_replication_slot('standby_10_66_0_4'); select pg_create_physical_replication_slot('standby_10_66_0_4', true);`
4. Run the commands in [The standby](#the-standby) again.

## Database proxy

`deploy/db-proxy.yml` adds `db-proxy` (HAProxy 3.4.7, pinned by digest) and points the `DATABASE_URL` of apiserver
and wiki-worker at `db-proxy:5432`. Turn it on with `COMPOSE_FILE`
([configuration reference](configuration.md#optional-compose-files)). The proxy is plain TCP: one server connection
per client connection. `LISTEN/NOTIFY` and session-level advisory locks therefore behave as they do without it.
pgbouncer in transaction mode would break both.

`deploy/db-proxy/haproxy.cfg` works like this:

- The target is `ORBIT_DB_PROXY_TARGET`, `postgres:5432` by default. It is resolved through Docker's DNS every few
  seconds, so a recreated postgres container is followed to its new address.
- The proxy never ends an idle connection (24 h timeouts), because the apiserver's `LISTEN` connection can stay quiet
  for a long time. Keepalives find a peer that vanished without closing, on the apiserver's own timings: 10 s idle,
  then 3 probes 5 s apart.
- The container is healthy only while the target passes a TCP check, so the apiserver starts once it can reach the
  database. The check opens and closes a connection, which PostgreSQL does not log.
- PostgreSQL sees every connection as coming from the proxy, so `pg_stat_activity.client_addr` shows the proxy's
  address. `application_name` still tells the processes apart.

### Switching the target

You can switch it at runtime without restarting anything. The runtime API listens on 127.0.0.1:9999 inside the
container only.

```sh
# Where it points now
docker exec orbit-db-proxy sh -c 'echo "show servers state postgres" | nc 127.0.0.1 9999'
# Send new connections to another container or service on the project's network...
docker exec orbit-db-proxy sh -c 'echo "set server postgres/primary fqdn <name>" | nc 127.0.0.1 9999'
# ...then end the ones still open on the old target; their clients reconnect
docker exec orbit-db-proxy sh -c 'echo "shutdown sessions server postgres/primary" | nc 127.0.0.1 9999'
```

A runtime switch lasts until the proxy restarts or reloads. To keep it, set `ORBIT_DB_PROXY_TARGET=<name>:5432` in
`.env` too, so the proxy starts on the same target the next time it is created.

To switch in one step instead, set `ORBIT_DB_PROXY_TARGET` in `.env` and run
`docker compose up -d --no-deps db-proxy`. The proxy is recreated, leaving a second or two with no listener, and
every database connection ends once.

Neither way restarts the apiserver. Its pool, its `LISTEN` connection and its leader lock reconnect on their own.
The rehearsal (task 34wyYvRRnXJJMJrrDDYfW) checks that recovery.

## pgbackup on 10.66.0.4: archive generation 2

The standby is a copy of wikova's cluster, so it has the same system identifier, 7651470862549594147. Once
promoted, it writes on timeline 2, whose segment names sort after timeline 1's. `scripts/pg-backup.sh` checks that a
mirror belongs to its cluster and is not ahead of it, and generation 1 passes both checks. The mirror then runs
`rsync --delete`, which would remove everything there that 10.66.0.4's new archive lacks: all of wikova's base
backups and WAL. That is why 10.66.0.4 mirrors to a directory of its own.

Its key cannot reach generation 1. The key is in `/root/orbit-pgbackup-ssh` on 10.66.0.4, as `id_ed25519`, with
`id_rsa` linking to it because `pg-backup.sh` reads `/ssh/id_rsa`; `known_hosts` there holds `[10.66.0.3]:1522`.
The backup host authorizes it as:

```text
restrict,from="10.66.0.4",command="/usr/bin/rrsync /data/backup/orbit-pg-archive-gen2" ssh-ed25519 ... orbit-pgbackup@vmi3753066 gen2
```

rrsync runs only rsync, and only below that directory. `ORBIT_BACKUP_SYNC_TARGET=root@10.66.0.3:/archive` is
therefore `/data/backup/orbit-pg-archive-gen2/archive`, and its files copy is `.../archive-files`. A path naming
generation 1 also lands inside generation 2. Every rsync form `pg-backup.sh` uses was tried through it on
2026-11-13. Do not give 10.66.0.4 wikova's backup key, and do not point it at `/data/backup/orbit-pg-archive`.

Until the cutover, `orbit-pgbackup` exists on 10.66.0.4 but is not started. A standby archives nothing with
`archive_mode = on`, so pgbackup would only take base backups of the standby. Its settings are in
`/root/orbit/.env`:

```dotenv
ORBIT_BACKUP_SYNC_TARGET=root@10.66.0.3:/archive
ORBIT_BACKUP_SYNC_SSH_PORT=1522
ORBIT_BACKUP_SSH_DIR=/root/orbit-pgbackup-ssh
```

### Switching it on at the cutover

Do this after 10.66.0.4 is promoted, and after `./data/files` has been copied there (the files copy mirrors that
directory):

1. Check the target. This must print `ORBIT_BACKUP_SYNC_TARGET=root@10.66.0.3:/archive`:
   `docker inspect orbit-pgbackup --format '{{range .Config.Env}}{{println .}}{{end}}' | grep ORBIT_BACKUP_SYNC_TARGET`
2. Start it: `cd /root/orbit && docker compose up -d --no-deps pgbackup`.
3. Watch `docker logs -f orbit-pgbackup`. It takes a first base backup (about ten minutes), then logs
   `mirrored N change(s) to root@10.66.0.3:/archive` and the same for `/archive-files`.
4. Confirm archiving on 10.66.0.4 with `select archived_count, failed_count, last_archived_wal from pg_stat_archiver`:
   `archived_count` grows and `failed_count` stays where it was. On the backup host,
   `/data/backup/orbit-pg-archive-gen2/archive/wal` holds timeline-2 segments (`00000002…`).

Generation 1 stays as it is, and is kept for at least 14 days after the cutover. wikova's own pgbackup keeps
mirroring into it while it runs, so stop `orbit-pgbackup` on wikova at the cutover.

## What the cutover undoes

- The forward and the two `pg_hba.conf` lines serve only this direction. Once wikova's PG16 has become 10.66.0.4's
  standby, remove the forward:
  `systemctl disable --now orbit-pg-standby-forward.timer && /usr/local/sbin/orbit-pg-standby-forward --remove`.
  If the old primary keeps running, drop its slot `standby_10_66_0_4` too.
- The other direction needs the same on 10.66.0.4: a `pg_hba.conf` line for 10.66.0.1, a slot for wikova, and a
  way in, because 10.66.0.4's `orbit-postgres` publishes no port either. The two 10.66.0.4 lines in its copy of
  `pg_hba.conf` are harmless there, because no client reaches that server from 10.66.0.4: the proxy connects from
  its container's address.
