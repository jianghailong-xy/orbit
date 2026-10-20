# Managed runners on Docker: backup, restore and failure handling

This runbook is for a deployment whose managed runners run on its own Docker: a new deployment that
`scripts/install-server.sh` installed, or one an administrator switched on with `--enable-managed-runners`
([Self-hosting](self-hosting.md#managed-runners)). Every account has a runner of its own: a container
`mr-<runner uuid>` and a data volume `mr-data-<runner uuid>` on this host's disk. The volume holds the account's
checkouts, sessions, uploads and engine sign-ins, and nothing else keeps a copy of it.

Run the commands as root, from the deployment's checkout (the directory with `docker-compose.yml` and `.env`). The
paths are those the install writes. Every procedure and number here was checked on 2026-10-17 on a default
deployment in an isolated Docker host, and on the HPC host's own Docker
([evidence](evidence/managed-runner-docker-security/2026-10-17/README.md)). The container cap, volume removal, the
disk the storage budget measures and the executable `/tmp` were checked later the same day, in an isolated Docker host
whose checkout and Docker data root are on different filesystems
([evidence](evidence/managed-runner-docker-hardening/2026-10-17/README.md)). The managed runners' host firewall was
checked on 2026-10-19 in an isolated Docker host
([evidence](evidence/managed-runner-docker-firewall/2026-10-19/README.md)). What the runners' volume syncs cost the
host's disk was measured on 2026-10-20 in an isolated Docker host on one spinning disk
([evidence](evidence/managed-runner-docker-volume-sync/2026-10-20/README.md)).

## What there is to keep

| What | Where | Kept by |
| --- | --- | --- |
| Each account's runner data: checkouts, sessions, uploads, engine sign-ins, the runner's own configuration and credential | Docker volume `mr-data-<runner uuid>` | Only this runbook's backups. The Postgres backups do not include it. |
| Which account has which runner, volume and generation, and in which state | Postgres table `managed_runner` | The [Postgres backups](postgres-backup-restore.md) |
| The Docker channel's token, `channel.json`, the apiserver's `profile.json`, and the channel's state directory (a credential until its container starts, the disk-limit records, fencing receipts) | `data/managed-runners` (mode 0700) | Copy it with the Postgres backups. It holds a secret: the channel's token. |
| A generation's bootstrap volume `mr-boot-<runner uuid>-g<generation>` | Docker volume | Nothing to keep: each generation gets a new one, removed with its container. |
| The channel's disk probe: an empty anonymous volume, mounted read-only in `docker-channel` at `/var/lib/orbit-docker-volumes` | Docker volume | Nothing to keep: Compose makes it with the channel's container and keeps it when it recreates the channel. Once the channel has been recreated, `docker compose down -v` leaves it behind, empty: `docker volume rm` it. |
| The managed runner image | Local image, named by its ID in `channel.json` and `profile.json` | Rebuild it from the commit (`docker build -f deploy/managed-runner/image/Dockerfile …`), or keep a `docker save` of it. |
| The managed runners' firewall: its `config.json` and the `status.json` its service keeps | `data/managed-runners/firewall` | `config.json` goes with the rest of `data/managed-runners`. `status.json` is nothing to keep: the service writes it every 10 seconds. |

A data volume backup holds what the account signed in with (engine credentials) and the runner's credential. Treat
it like the Postgres backups: private, and off this host.

## Find an account's runner

```bash
docker compose exec -T postgres psql -U orbit -d orbit -c "
  select u.email, m.id, m.management_state, m.desired_state, m.generation, m.attempt, m.pvc_name as volume,
         m.pvc_uid as volume_uid, m.pod_name as container, m.last_error->>'code' as reason, m.last_error->>'detail' as detail
    from managed_runner m join \"user\" u on u.id = m.owner_id order by u.email"
docker ps -a --filter label=orbit.managed-runner.kind=runner \
  --format '{{.Names}}\t{{.Status}}\tgeneration {{.Label "orbit.managed-runner.generation"}}'
docker volume ls --filter label=orbit.managed-runner.kind=data
```

`detail` is the operator's half of a reason: for example `container <uid> is exited (exit 137; OOM-killed)`.
Accounts see the reason's sentence, never the detail. Running out of memory has reasons of its own
(`POD_RESTARTING_OUT_OF_MEMORY`, `POD_OUT_OF_MEMORY`), so its owner sees that too.

The apiserver logs every stop of a runner's container, one warning each, with its exit code, whether it ran out of
memory, and what the manager does next:

```bash
docker compose logs apiserver | grep -E 'POD_TERMINATED|VOLUME_IN_USE|CONTAINER_LIMIT|PVC_MISSING|PVC_RESTORED'
```

```text
WARN [ManagedRunnerManager] managed runner <mapping id>: POD_TERMINATED: container <instance uid> of generation 2 stopped in READY with exit code 255, not out of memory; starting generation 3 on the same volume in 8 s (attempt 1 of 5)
```

(the power cut drill's line). `<mapping id>` is the query's `id`, and `attempt` counts the stops and failed starts in a
row.

The channel's own view, sizes included, without putting the token on a command line:

```bash
printf 'header = "Authorization: Bearer %s"\n' "$(cat data/managed-runners/token)" |
  curl -s --config - --unix-socket data/managed-runners/channel.sock http://channel/v1/resources
```

## Back up a runner's volume

Back up a volume while its runner sleeps. Then no container refers to it and nothing writes to it. A runner sleeps on
its own after an hour with nothing to do (`lifecycle.idleSeconds` in `profile.json`), and its owner can put an idle
one to sleep (`POST /api/managed-runner/sleep`). Never stop a runner's container with `docker stop` to back it up:
the manager takes the stop for a crash and starts the runner again at once, on the same volume.

```bash
V=mr-data-<runner uuid>
B=/var/backups/orbit-managed-runners/$(date -u +%Y%m%dT%H%M%SZ)
scripts/managed-runner/volume-backup.sh backup "$V" "$B"
```

The script refuses a volume that any container refers to. It writes into `$B`:

- `$V.tar.gz`: the volume, with numeric owners and modes;
- `$V.sha256`: every file's checksum;
- `$V.labels` and `$V.volume.json`: the volume's labels. A restore needs them exactly, because the manager accepts
  a volume only with the UID, owner and runner it recorded.

It reads the volume from a throwaway container of the managed runner image, with no network and the volume
mounted read-only.

While that container runs, the runner cannot start. A message or task that wakes it in that window waits: the
manager starts no container while another one refers to the volume. Its owner sees "Something else is using this
runner's data volume, such as a backup", the apiserver logs `VOLUME_IN_USE` once, and the runner starts by itself once
the backup's container is gone. No attempt is spent and its startup deadline does not run meanwhile. To keep a long
backup from delaying a wake, back up when the account is quiet.

Copy `$B` off this host, together with `data/managed-runners` and the Postgres backups.

## Check a backup

```bash
scripts/managed-runner/volume-backup.sh check "$V" "$B"
```

This unpacks the archive into a scratch volume and compares every file's checksum with `$V.sha256`. Then it
inspects the copy: `PRAGMA integrity_check` on every SQLite file and `git fsck` on every repository, as the runner's
own user (10001). Finally it removes the scratch volume. It touches nothing of the runner's, and it fails on a
checksum that differs or anything that is not `ok`.

The inspection runs on the unpacked copy, which the checksums prove identical to the volume at the backup. A SQLite
database in WAL mode cannot be opened on the read-only volume the backup reads.

## Restore a runner's volume

Restore only while the runner sleeps, and keep it asleep until the restore is done: a runner woken while its volume
is missing fails with `PVC_MISSING` (if that has happened already, see [After `PVC_MISSING`](#after-pvc_missing)). So:

1. **Hold the runner asleep.** Disable the account (**Admin → Users → Disable**): a disabled account's runner is
   never woken, and a running one is put to sleep. This also signs the account out. An administrator's own account
   cannot be disabled while it is the last administrator.
2. **Check that it sleeps.** Use the query above: `SLEEPING`, and no container refers to the volume
   (`docker ps -a --filter volume=$V` prints nothing).
3. **Restore.**

   ```bash
   docker volume rm "$V"     # only to roll an existing volume back: the restore never writes into a volume that exists
   scripts/managed-runner/volume-backup.sh restore "$V" "$B"
   ```

   The script recreates the volume with its labels, unpacks the archive into it, compares every checksum, and
   inspects it as `check` does. The inspection runs as the runner's user, so what SQLite creates beside a database
   is the runner's to write.
4. **Enable the account again.** The runner starts on the restored volume at its next message, task or wakeup, or
   its owner wakes it. It keeps its identity: the same runner, the same volume UID, the next generation.

In the drill, a sleeping runner's volume was backed up (163 files), checked, deleted and restored this way. The
runner then woke on it as its next generation. Every file had the checksum it had before the backup, the six SQLite
files and two repositories were `ok`, the rows and the dump digest were the same, and so were the repository's HEAD
and the runner's identity.

### After `PVC_MISSING`

A runner whose volume was lost (a `docker volume prune`, say) and that something woke anyway fails with `PVC_MISSING`:
"This runner's recorded data volume is gone". It cannot be retried while the volume is missing, and nothing is ever
created in its place. It has no container, and nothing starts one while it is failed, so restore the volume as in
step 3 above.

The manager looks for the recorded volume on each of its passes. Once it is back with its labels, so with the UID,
owner and runner the manager recorded, and the restore's own containers have gone, the reason becomes `PVC_RESTORED`
("This runner's data volume is back as it was recorded. A retry starts the runner on it.") within a few seconds, and
the apiserver logs `PVC_RESTORED`. Its owner's **Retry** then starts the runner on the restored volume, with the same
identity. While the restore's containers still hold the volume, the runner stays `PVC_MISSING` and the `detail` says
the volume is back and still held. Between the script's unpacking and its inspection there is a moment with no
container, and the manager may already say `PVC_RESTORED` then: the data is complete and its checksums compared by that
point, and a Retry that comes while the inspection runs waits for it (`VOLUME_IN_USE`). To keep the owner's Retry
for after the script's last check, disable the account for the restore, as in step 1 above, and enable it again
afterwards. A volume restored without its labels, or any other volume under that name, is not the recorded one: the
runner stays `PVC_MISSING`, and the `detail` says what is wrong with the volume there.

## Delete a runner's volume

Deleting a data volume deletes the account's checkouts, sessions, uploads and engine sign-ins for good, unless a
backup holds them. Nothing in Orbit does it: the manager never removes a data volume, and the channel refuses to
(`403 REMOVAL_REFUSED`) unless an operator turns removal on. Delete one only for an account that will not use its
runner again, and in this order:

1. **Hold the runner asleep.** Disable the account (**Admin → Users → Disable**), as for a restore.
2. **Check that it sleeps** and that nothing refers to the volume: the query above shows `SLEEPING`, and
   `docker ps -a --filter volume=$V` prints nothing. Note its `volume_uid`.
3. **Back it up** (above), unless the data is meant to go.
4. **Turn removal on.** Add `"allowVolumeRemoval": true` to `data/managed-runners/channel.json`, check the file, and
   start the channel on it:

   ```bash
   docker compose run --rm docker-channel check-config --config /var/lib/orbit-managed-runners/channel.json
   docker compose up -d --force-recreate docker-channel
   ```

5. **Remove the volume through the channel, by its UID.** The channel removes only this instance's data volume of
   that name and that UID, and only while no container refers to it.

   ```bash
   printf 'header = "Authorization: Bearer %s"\n' "$(cat data/managed-runners/token)" |
     curl -s -X DELETE -w 'HTTP %{http_code}\n' --config - --unix-socket data/managed-runners/channel.sock \
       "http://channel/v1/volumes/$V?uid=<volume_uid>"
   ```

   `HTTP 204` is done. `VOLUME_IN_USE`, `UID_MISMATCH` or `NOT_FOUND` mean that this is not the volume, or not yet:
   look again before anything else.
6. **Turn removal off again.** Remove the line, check the file and recreate `docker-channel` as in step 4.

The account stays disabled. Its runner's record still names the volume, so a wake would fail it with `PVC_MISSING`,
and only a restore of that volume from a backup makes it retryable again (After `PVC_MISSING`, above).
`docker volume rm` deletes a volume too, but it checks neither the labels nor the UID: the channel's removal cannot
take another volume of the same name.

## When something goes wrong

### A runner's volume is over its limit

Docker's local volumes have no size limit of their own. The channel enforces each volume's limit (`storage.capacity`
in `profile.json`, 20 GiB by default) by measuring:

- every `diskCheckSeconds` (`channel.json`, 120 s by default), it reads Docker's size of every volume;
- it stops (SIGTERM, then SIGKILL after `stopGraceSeconds`) the container of a volume over its limit;
- it refuses to start a container on that volume again.

It is a measurement, not a quota, so a runner can write past its limit until the next check. The overshoot is about
the write rate times the interval. Measured:

- a 64 MiB limit with checks every 10 s, written at about 16 MB/s, stopped at 192,940,181 bytes;
- a 256 MiB limit stopped at 346,105,301 bytes (task D2).

Each check makes Docker walk every volume on the host, so a short interval costs disk reads on a busy host.

What the account sees: the channel's stop is a stop like any other, so the manager starts the runner again, and the
channel refuses that container. The runner fails with `VOLUME_OVER_LIMIT` (its `detail`: `… holds … bytes, over its …-byte
limit`; the log's `POD_TERMINATED` line has the stop). It stays failed until one of these is done, and its owner then
presses Retry:

- **Raise its limit.** Add the volume to `volumeLimitOverrides` in `data/managed-runners/channel.json`, then restart
  only the channel (`docker compose up -d --force-recreate docker-channel`). Its owner presses Retry. A malformed
  entry stops the channel from starting at all, so check it with
  `docker compose run --rm docker-channel check-config --config /var/lib/orbit-managed-runners/channel.json`.

  ```json
  "volumeLimitOverrides": { "mr-data-<runner uuid>": 42949672960 }
  ```

- **Free space on it.** Use a throwaway container that mounts the volume while the runner is down. Remove that
  container before the Retry, and wait one disk check, since the channel judges a start by its last measurement.

Nothing is deleted to enforce a limit.

To change how often it measures, set `diskCheckSeconds` (10 to 86400) in `channel.json` and recreate
`docker-channel`. To change the limit of new volumes, change `storage.capacity` in `profile.json` and recreate the
apiserver.

### Runners wait though the host has room

The channel makes no more than `limits.maxContainers` containers in all, in any state. Unless `channel.json` sets it,
that is one per CPU and per GiB of this host's memory, whichever is fewer; `/v1/info` reports the number it applies
(`limits.maxContainers`). The manager plans for no more runners than that, so past it an account waits for its
runner as it does for any capacity, until another runner sleeps. With the default profile (2 CPUs and 4 GiB a
runner, a quarter of the host kept back) the budget runs out first: the cap binds only where runners are given less
than a CPU or less than 1 GiB each.

To change it, set `maxContainers` in `limits` in `channel.json`, then recreate the channel and, after it, the
apiserver, which reads the cap when it measures its pool:

```bash
docker compose up -d --force-recreate docker-channel
docker compose up -d --force-recreate apiserver
```

Whoever else holds the channel's token meets the same cap: a create past it is refused (`429 CONTAINER_LIMIT`) before
anything is made, and the containers already there go on as they were.

A runner can still meet the cap, when it was lowered while runners ran and the apiserver has not measured its pool
since, or when a container of this instance that no runner records holds a place. Its start then waits rather than
fails. Its owner sees `CONTAINER_LIMIT` ("The Docker host has as many runner containers as it allows, so this runner
is not started yet."), the apiserver logs `CONTAINER_LIMIT` once when the wait begins, and the manager asks again
every `lifecycle.capacityRetrySeconds`. The wait spends no attempt, so a runner that was being started again after a
stop keeps its count. It starts by itself once a container of this instance is removed, as when another runner
sleeps.

### The host's disk is full

What happens:

- Writes in the runners fail with "no space left on device", and so do sessions in them.
- Postgres and the apiserver fail too when their data is on the same disk.
- New accounts wait for their runner: `MANAGED_RUNNER_CAPACITY_UNAVAILABLE` "(storage pool space)".
- Nothing stops a running container because the disk is full. The per-volume limit above still stops a volume that
  is over its own limit, even when the disk under the channel's state directory is full (fixed on 2026-10-17; before
  that fix, a full disk stopped the check itself).

What to do:

1. Find what takes the space. `docker system df -v` gives each volume's size, and `/v1/resources` (above) gives the
   managed ones with their `usageBytes`.
2. Free space without touching the data volumes: `docker builder prune` and dangling images (`docker image prune`).
   **Never run `docker volume prune`.** A sleeping runner's volume has no container, so the prune deletes it. That
   runner then fails with `PVC_MISSING` at its next wake, and only a restore of the volume (above) can bring the data
   back; then its owner can retry it.
3. Restart the apiserver (`docker compose restart apiserver`). The manager measures the storage it may hand out once,
   when it starts, so new accounts keep waiting until it measures again. It measures the disk Docker's volumes live
   on, wherever the checkout is: the channel reads it on its probe volume, which Docker keeps beside the data volumes
   (`host.disk` in `/v1/info`, path `/var/lib/orbit-docker-volumes`). Its log says so at start-up if it ever measures
   another disk.
4. Retry the runners that failed (their owners press Retry).

### A container is over its memory limit

The limit (`runner.resources.memory` in `profile.json`, 4 GiB by default, and no swap beyond it) covers the
container's processes and its `/tmp`, a tmpfs counted in memory. `/tmp` is executable, so builds and `go test` run
what they write there; Docker keeps it `nosuid` and `nodev`, and an engine older than Docker 27 keeps it `noexec`
(the channel's log says so at start-up). At the limit, the kernel kills the container's
largest process, which is usually an engine or a build, and Docker marks the container `OOMKilled`. Measured on the
HPC host with a 512 MiB limit: the allocating process was killed at the limit (`memory.peak` = 536,870,912 bytes, one
`oom_kill` in `memory.events`), and the runner process went on.

- **The runner process survived** (the usual case). The container keeps running; the session that ran out of memory
  fails.
- **The runner process was the one killed.** The container exits 137 and Docker marks it OOM-killed. The manager logs
  `… with exit code 137, out of memory; starting generation …` and starts the runner again on the same volume. Until
  it is up, its owner reads "The runner ran out of memory and stopped, so it is being started again on the same data
  volume." If it keeps running out, `lifecycle.maxAttempts` stops in a row (5 by default), it fails with
  `POD_OUT_OF_MEMORY` ("The runner kept running out of memory …"), and its owner presses Retry once runners have more
  memory (below).

Docker keeps a container's OOM mark once any process in it was killed for memory. The manager says "out of memory"
only for a runner that itself ended killed (exit 137), so a container whose session process was killed earlier and
that stops at a host restart (exit 0 or 255) is not reported as out of memory; one killed (137) for another reason after
such a kill is.

To check it: the apiserver's log line, the reason or `detail` in the query above, `memory.events` of the container's
cgroup, or `docker inspect -f '{{.State.OOMKilled}} {{.State.ExitCode}}' mr-<runner uuid>` until the restart removes
the container.

To give runners more memory:

1. Raise `runner.resources.memory` in `profile.json`, and `limits.maxMemoryBytes` in `channel.json` if it is under the
   new amount.
2. Run `docker compose up -d --force-recreate docker-channel apiserver`.

A runner gets the new amount at its next start.

### The Docker channel is down

The apiserver cannot create, start, stop or remove anything:

- Running runners go on: they talk to the apiserver, not to the channel.
- A runner that is being started or woken retries on a backoff. After `lifecycle.maxAttempts` (5) failures in a row,
  it fails with `RETRY_EXHAUSTED`, and its owner presses Retry. That takes about a minute and a half with the
  defaults: in the drill, a 62 s outage used four of the five attempts. A runner being started again after a stop
  counts that stop as one of them.
- An apiserver started while the channel is down logs `managed runner pass failed` on every pass, until the channel
  is back.

To bring it back:

```bash
docker compose logs --tail 50 docker-channel
docker compose up -d docker-channel
```

A channel that will not start says why in its log: a configuration problem, a token file others can read, or a
missing image or network. It finishes any container create a previous run left half done before it serves again.

Rotate the channel's token only with both sides down. Write a new `data/managed-runners/token` (mode 0600), then run
`docker compose up -d --force-recreate docker-channel apiserver`: both read it only when they start.

### The apiserver (the manager) is down

Running runners keep running. Their heartbeats fail and are retried. Nothing is started, woken or put to sleep until
the apiserver is back.

When it starts, it picks up where the database says each runner is:

- a runner whose container exited meanwhile is started again, the next generation on the same volume;
- a runner that was draining goes to sleep.

Bring it back with `docker compose up -d apiserver`. Nothing else is needed.

### The host or its Docker restarts

The Compose services come back by their restart policy. Managed runner containers do not: their restart policy is
`no`, so that each generation starts only through the manager.

- **The firewall.** Docker's own restart leaves the managed runners' firewall rules where they are: Docker never
  flushes `DOCKER-USER` and never touches `INPUT`. A host restart takes them away, and `managed-runner-firewall`, which
  Docker starts again with the rest of the stack, writes them again within seconds. Until it reports them in force
  for this boot, the Docker channel refuses every runner container (`503 FIREWALL_NOT_ENFORCED`), and the manager waits
  without spending the runner's attempts, so no runner starts before its rules. Measured on 2026-10-19 (task D9) for both restarts, and with the
  firewall service stopped on purpose ([The managed runners' firewall](#the-managed-runners-firewall)).

- **A runner that was running** is started again by itself once the apiserver is back. The manager records Docker's
  own report of the old container's exit (its exit code and `FinishedAt`) as the proof that it stopped, and logs it
  (`POD_TERMINATED … with exit code 255, not out of memory; starting generation …`). After a short backoff it removes
  that container and starts the next generation on the same volume, with the same runner identity. Meanwhile its owner
  reads "The runner instance stopped, so it is being started again on the same data volume." Nobody presses Retry.
- **A runner that was asleep** stays asleep and wakes normally.
- **Compute.** Each runner's compute share stays reserved through its restart.
- **Data.** Each runner's data is as its last write left it.
- **A runner that keeps stopping** is not started again for ever. After `lifecycle.maxAttempts` stops in a row (5 by
  default, failed starts included) it fails with `POD_TERMINATED`, and its owner presses Retry. A runner that stayed up
  for twice `lifecycle.backoffMaxSeconds` (10 minutes by default) starts that count again, so a host restart is its
  first.

Measured in the drills (task D7), on an isolated Docker host: one runner ready with a SQLite writer running, one just
put to sleep, and two restarts (a restart of the Docker host, and a power cut of it). Nobody pressed Retry.

| | Graceful restart (`docker restart`) | Power cut (`docker kill`, then start) |
| --- | --- | --- |
| Docker's report of the running container | exited 0, `FinishedAt` at its stop | exited 255, `FinishedAt` when the daemon came back |
| What the manager did | `POD_TERMINATED … with exit code 0, not out of memory; starting generation 2 on the same volume in 10 s (attempt 1 of 5)`; that report recorded as the stop proof, the container removed, the next generation started | the same with exit code 255, `in 8 s (attempt 1 of 5)` |
| The runner READY again | 75 s after the restart began, 45 s after the API answered again | 69 s after the power cut, 47 s after the API answered again |
| Its identity | the same runner, volume and volume UID; the next generation | the same |
| What its owner read meanwhile | "The runner instance stopped, so it is being started again on the same data volume." | the same |
| The sleeping runner | woken afterwards on its volume, `READY` | the same |
| Containers per volume, sampled about every 0.6 s, and in Docker's events | never more than one | never more than one |
| Data | every committed row of the writer there (251), `integrity_check` `ok`, every file unchanged | every committed row there (768), `integrity_check` `ok`, every file unchanged |

The power cut's runner had been up for more than twice `backoffMaxSeconds`, so its restart was attempt 1 again, after
the graceful restart's attempt 1.

#### After a real power loss

The drills killed and restarted a Docker host while the HPC host's kernel and page cache stayed up. A real power loss
also loses what the kernel had not written to disk, and restarts the kernel itself. After one:

1. **Let the host check its filesystems.** Read the kernel log for ext4/xfs errors (`journalctl -k -b | grep -iE
   'ext4|xfs|I/O error'`). Do not start Docker on a filesystem that failed its check.
2. **Bring Docker up and look at it.** Run `systemctl status docker` and `docker info`, then
   `docker compose ps` (`unhealthy`?) and `docker compose logs postgres | tail` (PostgreSQL replays its WAL by
   itself; a corrupt cluster goes to the [Postgres runbook](postgres-backup-restore.md)).
3. **Hold the runners back, if you want to check their volumes first.** As soon as the apiserver is up, the manager
   starts every runner that was running again, within seconds. Nothing starts one while the apiserver is down, so stop
   it at once: `docker compose stop apiserver`. The runners' exited containers stay where they are.
4. **Check each data volume.** List the runners with the query above, then for each volume:

   ```bash
   scripts/managed-runner/volume-backup.sh verify "$V"
   ```

   This runs `PRAGMA integrity_check` on every SQLite file and `git fsck` on every repository in the volume, as the
   runner's user, where it is. The runner's exited container may still refer to the volume; a running one is refused.
5. **Start the apiserver again** (`docker compose start apiserver`). The runners that were running start again by
   themselves on their volumes, and sleeping runners need nothing. For a volume that failed its check, disable that
   account straight away (its runner then goes to sleep, or is put to sleep if it already started), restore the
   volume's last backup as [above](#restore-a-runners-volume), and enable the account again.

#### A runner's container vanished without Docker's report

This happens when someone removed the container by hand, outside the channel. The runner waits in `FENCING`
("Waiting for an operator"): the manager will not start another container on the volume without proof that the old
one is gone.

1. Check the host: `docker ps -a`, `ps` for the instance UID, and `fuser -m` on the volume's mount point.
2. Write the receipt that
   [the channel's README](../deploy/managed-runner/docker-channel/README.md#fencing-receipt) describes to
   `data/managed-runners/state/fencing/<runner uuid>.json`. Its predecessor fields must be the mapping's own values,
   or it is refused field by field. Write it whole, and check that it is valid JSON first: an unreadable receipt
   fails the runner.
3. The next generation then starts by itself. Delete the receipt afterwards.

## Volume syncs and the host's disk

A managed runner keeps what it reports through a power loss. Before it tells the server that a turn was answered or a
session ended, or that it made a checkout, a commit, a merge, a landing or a cleanup, it syncs its volume (`syncfs`),
and the report waits for the sync. On this backend a runner's volume is a directory of this host's filesystem, so the
sync writes back everything not yet written on that filesystem: every runner's volume, Postgres's data in
`data/postgres` when the checkout is on the same filesystem, Docker's logs. (A runner on Kubernetes also syncs behind
every tool its engine runs, in the background; on Docker it does not, because those syncs cost the others too much.)
Each runner says which at start:

```bash
docker logs mr-<runner uuid> 2>&1 | grep 'volume syncs:'
```

```text
volume syncs: before reports only; the volume is a directory of /dev/sdb (ext4), which it shares, so a sync behind every tool would write back the whole filesystem
```

What it costs, measured on one spinning disk holding Docker's data root and the checkout. Runners of 1 CPU and 1 GiB
each ran an engine's tool loop of edits, commits and builds at once, out of step with one another, and committed after
every turn. Each cell is with the syncs / without them (the same load on a runner that syncs nothing), from the rounds
that outside memory pressure on the test host left alone:

| Runners at work at once | 1 | 4 | 8 |
| --- | --- | --- | --- |
| Syncs a minute | 4 | 20 | 37 |
| The API's p99, as an account sees it | 33 / 34 ms | 54 / 49 ms | 95 / 52 ms |
| Postgres's commit p99 | 27 / 39 ms | 93 / 156 ms | 184 / 59 ms |
| Postgres commits over 100 ms, a minute | 0 / 0.5 | 2.7 / 3.5 | 12.8 / 0.2 |
| The runner's own commit, asked to done, p50 | 731 / 623 ms | 773 / 679 ms | 846 / 671 ms |

Up to four runners at work, the cost is within the bound the
[design record](managed-runner-design.md#implementation-record-volume-syncs-on-a-shared-docker-host) sets. With eight
at work on one spinning disk, Postgres's commits wait noticeably longer while those syncs run: every commit over 100 ms
in those rounds ran during one.

What a sync keeps: a commit, merge or checkout a runner reported, and a turn that was answered, survive this host's
power loss. What a tool writes in the middle of a turn waits for the next sync on the disk, this turn's end or any
runner's report, or for the kernel's own writeback about 30 s later. Measured: half of it was on the disk within
2 to 12 s, and nearly all within 9 to 30 s, the sooner the more runners are at work.

What an operator can change:

- **Postgres and the runners' volumes on different disks.** Docker's data root (`data-root` in
  `/etc/docker/daemon.json`, `/var/lib/docker` by default) holds the volumes, and the checkout's `data/postgres` holds
  Postgres. On separate disks a runner's sync writes back only runners' data, and Postgres's commits do not queue
  behind it. Decide it before the first runner exists: moving Docker's data root later moves every volume with it. Not
  measured.
- **An SSD.** A sync on a spinning disk pays its seeks. T02c timed a 200-file commit followed by a sync at 129 ms on the
  HPC host's spinning disk and 26 ms on its NVMe.
- **Fewer runners at work on one disk.** The runner's resources in `profile.json` decide how many runners the budget
  admits: with the default 2 CPUs and 4 GiB a runner, four need a host of about 11 CPUs and 22 GiB. `limits.maxContainers`
  in `channel.json` caps them whatever the budget ([Runners wait though the host has room](#runners-wait-though-the-host-has-room)).
- **The kernel's writeback.** `vm.dirty_expire_centisecs` (3000, 30 s, by default) is the longest a tool's work waits
  for the kernel. Lowering it shortens that window and writes more often. A setting of the whole host; not measured.
- **Not a setting: the syncs before reports.** They are what keeps reported work through a power loss, and nothing
  turns them off. A runner whose volume is a filesystem of its own, as a volume driver that gives each volume one would
  make it, syncs behind its tools again by itself, as on Kubernetes.

## Plain HTTP to the server: only on this host's container network

The runner's server address is `runner.serverUrl` in `profile.json`. Each runner sends its credential with every
request to it.

The image's entrypoint accepts plain `http://` for a managed runner container. That covers an address on this host's
container network, but also any private address (including a LAN's 192.168.x.x or 10.x.x.x), loopback, link-local,
and a single-label name. Over plain HTTP the credential crosses whatever network lies between the runner and that
address.

**Point `serverUrl` only at this host's own address on the managed runners' network: the gateway of
`orbit-managed-runners`, where the gateway's published port 2086 answers. Use `https://` for anything else.** The
install writes exactly that (`http://<gateway of orbit-managed-runners>:2086`), and it is the one address and port of
this host the managed runners' firewall leaves a runner (its `gateway` and `apiPort`). To check a deployment:

```bash
docker network inspect orbit-managed-runners -f '{{range .IPAM.Config}}{{.Gateway}} {{end}}'
grep '"serverUrl"' data/managed-runners/profile.json      # http://<that gateway>:2086, or an https:// URL
```

## What a managed runner can reach

Measured from inside runner containers, as the runner's user, on an isolated Docker host on 2026-10-19 (task D9,
[evidence](evidence/managed-runner-docker-firewall/2026-10-19/README.md)), with the firewall a new deployment has and
without it (`--no-managed-runner-firewall`, and every deployment installed before the firewall existed). D5's
measurements of 2026-10-17, on the HPC host's own Docker and in a default deployment, are the "without" column.

| From a runner | With the firewall | Without it |
| --- | --- | --- |
| The gateway's published port 2086 at the network's gateway (how it reaches this deployment) | reached | reached |
| The internet: public HTTPS (a Git host, a model's endpoint) and DNS | reached | reached |
| Every other port of this host, on any of its addresses: the network's gateway, docker0, other networks' gateways, its LAN address (sshd, rpcbind, a UDP service) | refused | **reached** |
| The private network behind this host: other machines' services (another host's sshd, a model endpoint) | refused, unless [allowed](#let-runners-reach-an-internal-model-endpoint) | **reached** |
| The cloud metadata address (169.254.169.254) and the rest of 169.254/16, 100.64/10, 10/8, 172.16/12, 192.168/16 | refused | where something answers, reached |
| Anything over IPv6 | refused (the network is IPv4-only, and IPv6 is off on the runner's interface) | none (the same) |
| Another account's runner (the network's inter-container traffic is off) | unreachable | unreachable |
| The stack's own containers (apiserver, Postgres, web; another network, and their names do not resolve) | unreachable | unreachable |
| The channel (it has no network at all), Docker's API (no socket inside, nothing on TCP 2375/2376) | unreachable | unreachable |
| This host's loopback-only services (the runner's 127.0.0.1 is its own) | unreachable | unreachable |

"Refused" is immediate: the connection fails with "No route to host" (`EHOSTUNREACH`), which is the firewall
answering. Everything here holds with Docker's userland proxy on or off, through Docker and host restarts, and on the
nft and the legacy iptables backends.

Every account can run code in its runner, and on a deployment open to sign-up that means anyone. Keep the firewall on,
or firewall the managed runners' network yourself: `INPUT` from its bridge except port 2086 at its gateway, and its
traffic to private ranges (`DOCKER-USER`). Keep host services bound to loopback either way.

## The managed runners' firewall

A new deployment firewalls its managed runners' network on this host (`managed-runner-firewall`,
[deploy/managed-runner/firewall](../deploy/managed-runner/firewall/README.md)): from that network a runner reaches the
gateway's published port at the network's gateway address, DNS, and public addresses. Every other port of this host,
on any of its addresses, and every private, shared, link-local and reserved address behind it is refused, the cloud
metadata address among them. The rules match only traffic from the network's bridge and nothing else on this host.
The service checks them every 10 seconds and writes again what changed, and the Docker channel starts no runner
container while it does not report them in force.

### See that it is in force

```bash
docker compose ps managed-runner-firewall                         # healthy: its status says the rules are in force
docker compose run --rm --no-deps managed-runner-firewall check   # {"enforced": true, ...}, exit 0
docker compose run --rm --no-deps managed-runner-firewall show    # the rules as they stand, IPv4 and IPv6
```

And from the network itself, without privilege, as the install checks it:

```bash
GW="$(docker network inspect orbit-managed-runners -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}')"
docker run --rm --network orbit-managed-runners --user 65534:65534 orbit-managed-runner-firewall:local \
  probe --reach "$GW:2086" --blocked "$GW:22" --blocked 169.254.169.254:80 --blocked 10.255.255.1:9 --resolve github.com
```

Every line says `"ok": true`. A refused connection reads `EHOSTUNREACH` ("No route to host"): the firewall answered.
`ECONNREFUSED` means the packet reached the host's own stack, and `CONNECTED` that it reached the service: either is
the firewall not in force. On the host, `iptables -S ORBIT-MR-INPUT`, `iptables -S ORBIT-MR-FORWARD`, and the first
rule of `iptables -S INPUT` and `iptables -S DOCKER-USER` show the same rules.

### Let runners reach an internal model endpoint

A model endpoint (or any service) on this host or on the private network behind it is refused until it is allowed.
Add it to `allow` in `data/managed-runners/firewall/config.json`, one entry per address (or network) and port:

```json
  "allow": [
    { "to": "192.168.1.12", "protocol": "tcp", "port": 8000 }
  ],
```

then `docker compose restart managed-runner-firewall`, and check as above (`--reach 192.168.1.12:8000`). Runners then
reach exactly that address and port; everything else private stays refused. A network (`"to": "10.20.0.0/16"`) allows
every address in it on that port, and nothing wider than a /8 is accepted. The account's model key names the same
address. A service of this host listening on 127.0.0.1 only stays out of a runner's reach whatever the firewall says:
loopback is the runner's own. Bind it to an address the runners can reach, such as this host's address on their
network (the gateway above), and allow that.

### Add it to a deployment that has managed runners without it

A deployment installed before the firewall existed, or with `--no-managed-runner-firewall`. Upgrade it first, then,
from its checkout:

```bash
scripts/install-server.sh --enable-managed-runner-firewall
```

It checks this host as an install does, writes the firewall's configuration, applies the rules once and checks them
from the network, adds `managed-runner-firewall` to `COMPOSE_PROFILES` in `.env` (every other line kept), and starts the
service. A runner already running is filtered from then on; a connection it had open before is not cut.

### Turn it off

Turning it off is the deployer's call: every account's runner can then reach every service this host listens to on
an address other than loopback, and the private networks behind it ([Isolation and its
limits](self-hosting.md#isolation-and-its-limits)).

```bash
docker compose --profile managed-runner-firewall rm -sf managed-runner-firewall   # stops it; its rules stay
mv data/managed-runners/firewall/config.json data/managed-runners/firewall/config.json.off   # the channel stops waiting for it
sed -i 's/^COMPOSE_PROFILES=managed-runners-docker,managed-runner-firewall$/COMPOSE_PROFILES=managed-runners-docker/' .env
```

The rules stay in force until they are removed (below) or the host restarts: nothing writes them again. To turn it on
again, `scripts/install-server.sh --enable-managed-runner-firewall`. That is also how a deployment takes a newer
firewall program after an upgrade, which never rebuilds or restarts it: off, then on again, from the upgraded checkout.

### Remove its rules

```bash
docker compose --profile managed-runner-firewall run --rm --no-deps managed-runner-firewall remove
```

Stop the service first ([Turn it off](#turn-it-off)), or it writes them again within 10 seconds. `remove` takes every
jump and chain of the firewall off both iptables backends and both address families, whatever bridge they name. On a
host without the image, by hand (or restart the host once the service is gone):

```bash
for t in iptables ip6tables; do
  $t -S | grep -E -- '-j ORBIT-MR-(INPUT|FORWARD)$' | sed 's/^-A /-D /' | while read -r rule; do $t $rule; done
  for chain in ORBIT-MR-INPUT ORBIT-MR-FORWARD; do $t -F "$chain" 2>/dev/null; $t -X "$chain" 2>/dev/null; done
done
```

### When it is not in force

Runners do not start, and wait: their owners read "The Docker host's firewall for managed runners is not in force, so
this runner is not started yet. It starts by itself once an operator has the firewall running again." The channel logs
`no runner container is started: the managed runners' host firewall is not in force (...)` (`docker compose logs
docker-channel`), the apiserver logs `FIREWALL_NOT_ENFORCED` once per runner, and `docker compose ps` shows
`managed-runner-firewall` unhealthy. A runner waiting there spends none of its attempts, and is asked again every
`lifecycle.capacityRetrySeconds` (60 seconds): once the firewall reports its rules in force, it starts by itself. The
firewall's log says what is wrong (`docker compose logs managed-runner-firewall`):

- **It is stopped:** `docker compose up -d managed-runner-firewall`.
- **"Docker's chains are in neither iptables backend":** Docker was switched to its nftables backend, or to
  `"iptables": false`. Switch it back, or turn the firewall off.
- **"the bridge … is not in this network namespace", or the channel's "its rules are for the bridge …, and network
  orbit-managed-runners has … now":** the network was removed and made again. Its gateway may have changed too, and with
  it `runner.serverUrl` ([Plain HTTP to the server](#plain-http-to-the-server-only-on-this-hosts-container-network)).
  Set `bridge` (`br-` and the first 12 characters of the network's ID) and `gateway` in `config.json` from
  `docker network inspect orbit-managed-runners -f '{{.Id}} {{json .IPAM.Config}}'`, then
  `docker compose restart managed-runner-firewall`.
- **Runners resolve no names after Docker's `dns` setting (daemon.json) changed:** read the servers Docker now forwards
  to from the network, `docker run --rm --network orbit-managed-runners orbit-managed-runner-firewall:local docker-dns`,
  into `dnsServers`, and restart the service. With the host's own resolv.conf the list is empty: Docker forwards those
  queries from the host's namespace, which the rules do not see.

## Where each setting lives

| Setting | File | Applies after |
| --- | --- | --- |
| Each runner's CPU, memory (with `/tmp`), processes, `/tmp` size | `profile.json` `runner.resources`, `runner.tmpSizeLimit` | `docker compose up -d --force-recreate apiserver`, at each runner's next start |
| The most any runner may be given | `channel.json` `limits` | `docker compose up -d --force-recreate docker-channel` |
| The most containers there may be | `channel.json` `limits.maxContainers` (by default one per CPU and per GiB of memory, whichever is fewer) | `docker-channel` recreated, then the apiserver |
| Whether the channel removes data volumes | `channel.json` `allowVolumeRemoval` (`false` unless set) | `docker-channel` recreated |
| A new volume's limit and storage share | `profile.json` `storage.capacity` | apiserver recreated; existing volumes keep theirs (use `volumeLimitOverrides`) |
| One volume's limit | `channel.json` `volumeLimitOverrides` | `docker-channel` recreated |
| How often volumes are measured | `channel.json` `diskCheckSeconds` | `docker-channel` recreated |
| How long a stop waits before SIGKILL | `channel.json` `stopGraceSeconds` | `docker-channel` recreated |
| When an idle runner sleeps; retries and backoff | `profile.json` `lifecycle` | apiserver recreated |
| Private destinations runners may reach (an internal model endpoint) | `firewall/config.json` `allow` | `docker compose restart managed-runner-firewall` |
| DNS servers reached from the runners' own namespace | `firewall/config.json` `dnsServers` | `docker compose restart managed-runner-firewall` |
| How often the firewall checks its rules | `firewall/config.json` `intervalSeconds` | `docker compose restart managed-runner-firewall` |
| Whether the firewall runs, and the channel waits for it | `.env` `COMPOSE_PROFILES` (`managed-runner-firewall`), and `firewall/config.json` being there | [Turn it off](#turn-it-off), [add it](#add-it-to-a-deployment-that-has-managed-runners-without-it) |
