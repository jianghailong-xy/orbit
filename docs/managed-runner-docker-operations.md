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
([evidence](evidence/managed-runner-docker-hardening/2026-10-17/README.md)).

## What there is to keep

| What | Where | Kept by |
| --- | --- | --- |
| Each account's runner data: checkouts, sessions, uploads, engine sign-ins, the runner's own configuration and credential | Docker volume `mr-data-<runner uuid>` | Only this runbook's backups. The Postgres backups do not include it. |
| Which account has which runner, volume and generation, and in which state | Postgres table `managed_runner` | The [Postgres backups](postgres-backup-restore.md) |
| The Docker channel's token, `channel.json`, the apiserver's `profile.json`, and the channel's state directory (a credential until its container starts, the disk-limit records, fencing receipts) | `data/managed-runners` (mode 0700) | Copy it with the Postgres backups. It holds a secret: the channel's token. |
| A generation's bootstrap volume `mr-boot-<runner uuid>-g<generation>` | Docker volume | Nothing to keep: each generation gets a new one, removed with its container. |
| The channel's disk probe: an empty anonymous volume, mounted read-only in `docker-channel` at `/var/lib/orbit-docker-volumes` | Docker volume | Nothing to keep: Compose makes it with the channel's container. |
| The managed runner image | Local image, named by its ID in `channel.json` and `profile.json` | Rebuild it from the commit (`docker build -f deploy/managed-runner/image/Dockerfile …`), or keep a `docker save` of it. |

A data volume backup holds what the account signed in with (engine credentials) and the runner's credential. Treat
it like the Postgres backups: private, and off this host.

## Find an account's runner

```bash
docker compose exec -T postgres psql -U orbit -d orbit -c "
  select u.email, m.management_state, m.desired_state, m.generation, m.pvc_name as volume, m.pvc_uid as volume_uid,
         m.pod_name as container, m.last_error->>'code' as reason, m.last_error->>'detail' as detail
    from managed_runner m join \"user\" u on u.id = m.owner_id order by u.email"
docker ps -a --filter label=orbit.managed-runner.kind=runner \
  --format '{{.Names}}\t{{.Status}}\tgeneration {{.Label "orbit.managed-runner.generation"}}'
docker volume ls --filter label=orbit.managed-runner.kind=data
```

`detail` is the operator's half of a failure: for example `container <uid> is exited (exit 137; OOM-killed)`.
Accounts see the reason's sentence, never the detail, and the apiserver does not log a runner that failed.

The channel's own view, sizes included, without putting the token on a command line:

```bash
printf 'header = "Authorization: Bearer %s"\n' "$(cat data/managed-runners/token)" |
  curl -s --config - --unix-socket data/managed-runners/channel.sock http://channel/v1/resources
```

## Back up a runner's volume

Back up a volume while its runner sleeps. Then no container refers to it and nothing writes to it. A runner sleeps on
its own after an hour with nothing to do (`lifecycle.idleSeconds` in `profile.json`), and its owner can put an idle
one to sleep (`POST /api/managed-runner/sleep`). Never stop a runner's container with `docker stop` to back it up:
the manager takes the stop for a failure, and the owner has to press Retry.

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

While that container runs, the runner cannot start. A message or task that wakes it in that window fails it at once,
with `DOCKER_CHANNEL_REFUSED` (detail `HTTP 409 VOLUME_IN_USE`), and it stays failed until its owner presses Retry,
even after the backup has finished. The drill measured this: the wake failed 3 s after the request. To avoid it, back
up when the account is quiet. For a long backup, hold the runner asleep by disabling the account, as for a restore
(below).

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

Restore only while the runner sleeps, and keep it asleep until the restore is done. A runner woken while its volume is
missing fails with `PVC_MISSING`. Nothing moves a runner on from that state today, a Retry included, even once the
volume is back. So:

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
from which nothing moves it on today (as under the restore above). `docker volume rm` deletes a volume too, but it
checks neither the labels nor the UID: the channel's removal cannot take another volume of the same name.

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

What the account sees: the runner fails (`POD_TERMINATED`; the detail says `stopped: its volume held … bytes, over its
… limit`). Its owner's Retry then fails with `VOLUME_OVER_LIMIT` until one of these is done:

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
   back.
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
- **The runner process was the one killed.** The container exits 137, and the runner fails `POD_TERMINATED` with the
  detail `… (exit 137; OOM-killed)`. Its owner presses Retry.

To check it: `docker inspect -f '{{.State.OOMKilled}} {{.State.ExitCode}}' mr-<runner uuid>` (until a Retry removes
the container), the `detail` in the query above, or `memory.events` of the container's cgroup.

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
  defaults: in the drill, a 62 s outage used four of the five attempts.
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

- a runner whose container exited meanwhile fails `POD_TERMINATED` (its owner presses Retry);
- a runner that was draining goes to sleep.

Bring it back with `docker compose up -d apiserver`. Nothing else is needed.

### The host or its Docker restarts

The Compose services come back by their restart policy. Managed runner containers do not: their restart policy is
`no`, so that each generation starts only through the manager.

- **A runner that was running** fails with `POD_TERMINATED` once the apiserver is back. The manager records Docker's
  own report (the exit code and `FinishedAt`) as the proof that the old container stopped. Its owner presses
  **Retry**: the next generation starts on the same volume, and the exited container is removed.
- **A runner that was asleep** stays asleep and wakes normally.
- **Compute.** The failed runner's compute share stays reserved until the Retry.
- **Data.** Each runner's data is as its last write left it.

Measured in the drills, on an isolated Docker host: one runner ready with a SQLite writer running, one just put to
sleep, and two restarts (a restart of the Docker host, and a power cut of it).

| | Graceful restart (`docker restart`) | Power cut (`docker kill`, then start) |
| --- | --- | --- |
| Docker's report of the running container | exited 0, `FinishedAt` at its stop | exited 255, `FinishedAt` when the daemon came back |
| What the manager did | `FAILED` `POD_TERMINATED`, that report recorded as the stop proof | the same |
| After the owner's Retry | the next generation on the same volume, `READY` | the same |
| The sleeping runner | woken afterwards on its volume, `READY` | the same |
| Containers per volume, sampled every 0.5 s, and in Docker's events | never more than one | never more than one |
| Data | every committed row of the writer there (763 rows), `integrity_check` `ok`, every file unchanged | every committed row there (1147), `integrity_check` `ok`, every file unchanged |

After a restart, every account whose runner was running has to press Retry. The manager does not do it for them,
and no operator route does it either.

#### After a real power loss

The drills killed and restarted a Docker host while the HPC host's kernel and page cache stayed up. A real power loss
also loses what the kernel had not written to disk, and restarts the kernel itself. After one:

1. **Let the host check its filesystems.** Read the kernel log for ext4/xfs errors (`journalctl -k -b | grep -iE
   'ext4|xfs|I/O error'`). Do not start Docker on a filesystem that failed its check.
2. **Bring Docker up and look at it.** Run `systemctl status docker` and `docker info`, then
   `docker compose ps` (`unhealthy`?) and `docker compose logs postgres | tail` (PostgreSQL replays its WAL by
   itself; a corrupt cluster goes to the [Postgres runbook](postgres-backup-restore.md)).
3. **List the runners** with the query above. Those that were running are `FAILED` `POD_TERMINATED`. Do not press
   Retry yet.
4. **Check each data volume before its runner starts.** While the runner is still down:

   ```bash
   scripts/managed-runner/volume-backup.sh verify "$V"
   ```

   This runs `PRAGMA integrity_check` on every SQLite file and `git fsck` on every repository in the volume, as the
   runner's user, where it is. The runner's exited container may still refer to the volume; a running one is refused.
   A volume that fails: restore its last backup (above) before its owner presses Retry.
5. **Then the owners press Retry.** Sleeping runners need nothing.

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

## Plain HTTP to the server: only on this host's container network

The runner's server address is `runner.serverUrl` in `profile.json`. Each runner sends its credential with every
request to it.

The image's entrypoint accepts plain `http://` for a managed runner container. That covers an address on this host's
container network, but also any private address (including a LAN's 192.168.x.x or 10.x.x.x), loopback, link-local,
and a single-label name. Over plain HTTP the credential crosses whatever network lies between the runner and that
address.

**Point `serverUrl` only at this host's own address on the managed runners' network: the gateway of
`orbit-managed-runners`, where the gateway's published port 2086 answers. Use `https://` for anything else.** The
install writes exactly that (`http://<gateway of orbit-managed-runners>:2086`). To check a deployment:

```bash
docker network inspect orbit-managed-runners -f '{{range .IPAM.Config}}{{.Gateway}} {{end}}'
grep '"serverUrl"' data/managed-runners/profile.json      # http://<that gateway>:2086, or an https:// URL
```

## What a managed runner can reach

Measured from inside runner containers, both on the HPC host's Docker and in a default deployment.

**Unreachable:**

- another account's runner (the network's inter-container traffic is off);
- the stack's own containers (apiserver, Postgres, web; a different network, and their names do not resolve);
- containers on other Docker networks;
- the channel (it has no network at all);
- Docker's API (no socket inside; nothing on TCP 2375/2376);
- the host's loopback-only services;
- the cloud metadata address.

**Reachable:**

- the internet, which a runner needs for its model and Git hosts;
- the gateway's published port, which is how it reaches the apiserver;
- **every service the host listens to on its other addresses**. On the HPC host that was sshd (22) and rpcbind (111)
  through the network's gateway, docker0 and the host's LAN address. Through the host's routing, the LAN behind it is
  reachable too.

Every account can run code in its runner. On a deployment open to sign-up, decide what a runner may reach:

- keep host services bound to loopback, or firewall them for the managed runners' bridge (`INPUT` from its
  interface, except port 2086);
- and drop its traffic to private ranges you do not want reached (`DOCKER-USER`).

Orbit does not change the host's firewall.

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
