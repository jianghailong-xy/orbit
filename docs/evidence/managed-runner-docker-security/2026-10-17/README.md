# Docker backend: security and operations, 2026-10-17 (task D5)

Task D5 (34hJ7S9C3isVnzIDDfSHD) of project 34ZteKCnYMpKY46f63Leb, criterion 12. This is an independent check of the
boundary every account's managed runner sits behind: the restricted Docker channel, and the container it makes.
It also covers the backup, restore and failure runbook ([docs/managed-runner-docker-operations.md](../../../managed-runner-docker-operations.md))
and its drills. The design record is [docs/managed-runner-design.md](../../../managed-runner-design.md),
"Implementation record: Docker backend security and operations".

## Where it ran

- **`d5-dind`**, an isolated Docker host ([kit/dind-up.sh](kit/dind-up.sh)).
  - A `docker:29.8.2-dind` container on the HPC machine: privileged for its own dockerd, 6 GiB / 8 CPUs, outside
    the Orbit runner's cgroup, labelled `orbit.test=d5-34hJ7S9C3isVnzIDDfSHD`.
  - Its data root and work directory are under `/mnt/data/tmp/34hJ7S9C3isVnzIDDfSHD`. Its deployment's gateway is
    published on host 127.0.0.1:14086 only.
  - In it, a default deployment of this branch at c16d115b3: `scripts/install-server.sh` with no flags, exit 0 at
    13:08:08Z ([dind/install-fresh.log.gz](dind/install-fresh.log.gz)). "managed runners are enabled in orbit-e08a3eef".
  - At 13:30:51–13:35:22Z it was moved to the channel fix d44626483 with `.claude/skills/upgrade/upgrade.sh
    --no-pull` (exit 0; `docker-channel` and web recreated, [dind/upgrade-to-fix.log.gz](dind/upgrade-to-fix.log.gz)).
  - Every drill below ran at d44626483. Two accounts: `a` (the administrator) and `b`. Their runners' Codex was
    signed in with a placeholder key, as in D2 and D3; no model was used.
- **The HPC host's own Docker** (29.8.2, cgroup v2, AppArmor, seccomp), for what a Docker-in-Docker host cannot
  show: AppArmor, and the host's network.
  - A separately labelled channel instance `d5-host`, built from this branch's `channel.py` and run as Compose runs
    it: no network, the Docker socket, 256 MiB.
  - The same runner image, by ID, and its own ICC-off network `orbit-mr-d5`.
  - Two runner containers (`h1`, `h2`) through that channel, with a random credential and small limits.
  - [kit/host-up.sh](kit/host-up.sh), [kit/host_runner.py](kit/host_runner.py). Everything was removed through the
    channel by UID ([kit/host-down.sh](kit/host-down.sh), [host/host-channel.jsonl](host/host-channel.jsonl)); only
    `d5-dind` is left.
- Nothing of an existing deployment, and no other container, was touched. The HPC host's Docker daemon was never
  restarted.

## 1. The channel refuses what it must

[kit/channel_probe.py](kit/channel_probe.py) sent each request to the deployment's own channel over its socket.
Before and after each one it compared Docker's whole inventory (containers, volumes, networks, images) and the
channel's state directory. It records every request with its `Authorization` described, never given.

- **At c16d115b3** ([dind/refusals-1-at-c16d115b3/](dind/refusals-1-at-c16d115b3/channel-refusals-summary.json)):
  299 requests, 297 as expected.
  - Two were accepted: `PUT /v1/credentials/<uuid>%0A` wrote a credential file named `<uuid>\n.json`, and an
    `ownerId` of `<uuid>\n` labelled a new data volume.
  - The probe removed both through the channel.
  - Fixed in d44626483, with a test that was red first.
- **At d44626483, after `/upgrade`** ([dind/refusals-2-at-d44626483/](dind/refusals-2-at-d44626483/channel-refusals-summary.json)):
  267 refusal cases, every one refused with its expected status and code, with Docker's inventory and the channel's
  state unchanged.

| What the request tried | Cases |
| --- | --- |
| Privileged mode, seccomp or AppArmor off, a root user (top level, Docker-spelled, inside `HostConfig`, smuggled into `resources`, `runner`, `volume`) | 10 |
| Added capabilities, or not all dropped | 7 |
| Host directories: binds, bind mounts, `volumes`, `volumesFrom`, a tmpfs over `/run`; a host path, `..` or Docker's volume directory as the data volume | 17 |
| The Docker socket: bound, mounted, as the data volume, in `DOCKER_HOST`, as the runner's server URL, as a volume name | 13 |
| The host's network (and `container:`, the default bridge), PID, IPC, UTS, user and cgroup namespaces | 21 |
| Devices: host block devices, `/dev/kmsg`, `/dev/mem`, GPUs (`deviceRequests`, `gpus`), cgroup rules | 8 |
| Another image: by tag, another local image ID, the configured image's own tag, upper case, an appended digest, none | 11 |
| Every other Docker parameter the template fixes (entrypoint, command, labels, sysctls, restart policy, ports, extra hosts, links, OOM kill off, swap, groups, runtime, logging, ulimits, cgroup parent, `shmSize`, …) and malformed server URLs | 36 |
| Amounts over the ceilings, zero, negative, booleans, floats, strings, `/tmp` over memory | 31 |
| Another runner's name, volume, volume UID or owner; a generation nobody issued a credential for | 6 |
| Resources without this instance's label: a volume with the channel's naming and no label, another instance's, the wrong kind; containers likewise; the stack's containers and volumes; a volume held by an unlabelled container (`VOLUME_IN_USE`); a bootstrap volume someone else made (`NOT_MANAGED`) | 41 |
| Routes, queries and bodies: Docker's own API through the channel, encoded `..`, NUL, newline, upper case, Docker's `t`/`force`/`v` parameters, unknown methods, a chunked or over-64-KiB or non-JSON body | 25 |
| No token; a wrong one; the token less a character or with one more; `bearer`; `Basic`; empty; without scheme; a good one in a second header | 41 |

A positive control, the same base request with nothing added, was created (201), inspected, stopped and removed. It
shows that the inventory comparison sees a change, and that what the channel makes is its template: user
10001:10001, `CapDrop ALL`, `no-new-privileges`, read-only root, private IPC, the one network, three mounts and the
limits asked for.

**The channel's surface** ([dind/deployment-facts.txt](dind/deployment-facts.txt)):

- `docker-channel` has `network_mode: none`. Its network namespace has only `lo`, no TCP or UDP socket, and one
  listening unix socket, `channel.sock`, `srw------- root`, in `data/managed-runners` (`drwx------ root`).
- The token is 0600, and `.env` is 0600.
- No other container has the Docker socket. The apiserver mounts the directory read-only.
- [dind/channel-info.json](dind/channel-info.json) is the channel's `/v1/info` as the deployment sees it.

## 2. What a managed runner container can and cannot do

[kit/container_probe.py](kit/container_probe.py), run inside the container as its runner user, reported on two
containers:

- `h1` on the HPC host's Docker: [host/container-review-h1.json](host/container-review-h1.json);
- account `a`'s runner in the default deployment: [dind/container-review-a.json](dind/container-review-a.json).

| | Result |
| --- | --- |
| User | 10001:10001, groups 10001 |
| Capabilities | `CapEff`, `CapPrm`, `CapBnd`, `CapAmb` all 0, for tini, `orbit run` and anything started in the container |
| `no-new-privileges` and seccomp | `NoNewPrivs` 1; seccomp mode 2 (filter). Setuid `mount`, `su` and `newgrp` give nothing ([host/setuid-check-h1.txt](host/setuid-check-h1.txt)). `unshare` (user and mount namespaces), `mount`, `setuid(0)`, `chroot`, `keyctl`, `bpf`, `perf_event_open` and `open_by_handle_at` get EPERM. |
| AppArmor | `docker-default (enforce)` on the HPC host. In `d5-dind` it is `unconfined`: that test host has no `apparmor_parser` and cannot load profiles, while Docker still records `docker-default` ([host/inspect-h1.json](host/inspect-h1.json)). |
| Filesystem | Read-only root (`/`, `/etc`, `/opt`, `/usr/local/bin`, `/run`: EROFS; `/root`: EACCES). It can write only to the data volume `/var/lib/orbit`, `/tmp` and `/dev/shm`. `/proc/sys`, `/proc/sysrq-trigger`, `/sys/fs/cgroup` and `/sys/kernel` are read-only; `/proc/kcore`, `/proc/keys` and `/sys/firmware` are masked. |
| The bootstrap files (T03's point) | `token`, `generation` and `instance.json` are `0:0` mode 0444, in a `0:0` 0755 directory. As the runner user: append, overwrite, truncate, unlink and rename get EACCES; chmod, chown and utime get EPERM; a new file, symlink or directory there gets EACCES. The contents were unchanged after every attempt. |
| Docker control | No Docker binary. No unix socket anywhere on its filesystems. No `docker.sock` or `containerd.sock` path, no `data/managed-runners`, nothing on TCP 2375/2376 (on the HPC host). |
| Host directories and devices | No host path (`/host`, `/var/lib/docker`, `/mnt/data`, `/root/.orbit`, …). Devices: `null`, `zero`, `full`, `random`, `urandom`, `tty` and no block device. The only binds are Docker's own `hosts`, `hostname` and `resolv.conf`, read-only. |
| Host credentials | The environment holds the runner's six keys and the image's own (names only were read). No `/run/secrets` or service account token; `/etc/shadow` and `/root/.docker` get EACCES. The runner's own credential is readable by its user, by design: it is that account's runner. |

**Limits, measured** ([kit/limits.sh](kit/limits.sh)):

| | On the HPC host (h1: 1 CPU, 512 MiB, 256 PIDs, 64 MiB `/tmp`, a 64 MiB volume checked every 10 s) | In the default deployment (a: 2 CPUs, 4 GiB, 4096 PIDs, 1 GiB `/tmp`) |
| --- | --- | --- |
| CPU | 4 busy processes got 1.01 CPUs; throttled in 100 of 100 periods ([host/limits-cpu-h1.txt](host/limits-cpu-h1.txt)) | 1.99 CPUs ([dind/limits-cpu-a.txt](dind/limits-cpu-a.txt)) |
| PIDs | refused at `pids.current` 256 = `pids.max` ([host/limits-pids-h1.txt](host/limits-pids-h1.txt)) | refused at 4096 ([dind/limits-pids-a.txt](dind/limits-pids-a.txt)) |
| `/tmp` | full at 67,092,480 bytes, counted in memory ([host/limits-tmp-h1.txt](host/limits-tmp-h1.txt)) | full at 1,073,725,440 bytes ([dind/limits-tmp-a.txt](dind/limits-tmp-a.txt)) |
| Memory | the allocating process was OOM-killed at the limit: `memory.peak` 536,870,912, one `oom_kill`, no swap; `orbit run` went on, the container kept running, and Docker marked it `OOMKilled` ([host/limits-memory-h1.txt](host/limits-memory-h1.txt)) | `memory.max` 4294967296 and `memory.swap.max` 0 read in the container; not filled, so as not to press the 6 GiB test host |
| Disk | written at about 16 MB/s, past 64 MiB at about 13:25:04. The check at 13:25:12 found 192,940,181 bytes and stopped the container; the next generation was refused `VOLUME_OVER_LIMIT`; with `volumeLimitOverrides` at 256 MiB and the channel restarted, it started ([host/limits-disk-h1.txt](host/limits-disk-h1.txt), [host/volume-limit-override-h1.txt](host/volume-limit-override-h1.txt)) | the profile's 20 GiB volume, checked every 120 s: not filled |

**Network reach** (TCP connects from inside; `blocked` means a timeout or refusal):

| Target | HPC host (h1) | Default deployment (a) |
| --- | --- | --- |
| Another runner on the same network | blocked (ICC off) | blocked |
| The stack's containers (apiserver 3000, Postgres 5432, web, gateway), directly | — | blocked; their names do not resolve |
| A container on another Docker network | blocked | — |
| The gateway's published port (`runner.serverUrl`) | — | reached (the designed path) |
| Docker's API on TCP 2375/2376 | refused | 2376 answered: the test host's own TLS dockerd, which needs a client certificate (a dind artifact) |
| Host services on all interfaces: sshd 22, rpcbind 111, via the network's gateway, docker0 and the LAN address | **reached** | (none in the test host) |
| A host service on loopback only | refused | — |
| 169.254.169.254 | blocked | blocked |
| The internet (api.deepseek.com:443) | reached | reached |

**`serverUrl` (T03's other point).** The default deployment's `profile.json` names `http://172.19.0.1:2086`, the
gateway of `orbit-managed-runners`: this host's own address on the runners' network
([dind/deployment-facts.txt](dind/deployment-facts.txt)). Self-hosting and the runbook now say that plain HTTP goes
nowhere else.

**`/tmp` is `noexec`** ([dind/tmp-noexec-b.txt](dind/tmp-noexec-b.txt)). A script there fails with exit 126, and
`go test` with its default temporary directory exits 1. Both work from the data volume, or with `GOTMPDIR` on it.
This is a functional limit, not a security gap; it is listed below.

## 3. Backup and restore, by the runbook

The final run ([kit/backup-drill-3.sh](kit/backup-drill-3.sh), [dind/backup-restore.jsonl](dind/backup-restore.jsonl),
[dind/data.jsonl](dind/data.jsonl), 14:27Z) used [scripts/managed-runner/volume-backup.sh](../../../../scripts/managed-runner/volume-backup.sh)
as committed (sha256 `da007e04…`, the same bytes):

1. Seeded b's volume: two random 8 MiB files, a note, SQLite in WAL with 5000 rows, and a Git repository. Put b to
   sleep: SLEEPING within seconds, its compute released.
2. `backup`: "archived 163 files", with the labels
   ([dind/backup/](dind/backup/mr-data-01a14a02-f987-712b-8893-d9440d0d9c09.labels)).
3. `check`, in a scratch volume: "checksums: all 163 files match the backup". Inspected as the runner's user: the six
   SQLite files and the two repositories `ok`, the volume root `10001:10001` 0700. The scratch volume was removed.
4. Disabled account b, then `restore`: it refused while the volume existed. After `docker volume rm` it recreated the
   volume with identical labels: all 163 files match; the six SQLite files and two repositories `ok`; no file on
   the volume owned by anyone but 10001.
5. Enabled b and woke it: READY at generation 12 on the restored volume (same volume UID). Against the seeded state,
   every file had its checksum, `integrity_check` was `ok`, the rows (5000) and the dump digest were the same, and so
   were the repository's HEAD and the runner identity (`runnerId`, `serverUrl`, `workDir`). The only extra files were
   SQLite's `-shm` and an empty `-wal`, which the verification's own reads had left before the backup took them, and
   the restore reproduced byte for byte.

`verify` ([kit/verify-drill.sh](kit/verify-drill.sh), [dind/verify-drill.txt](dind/verify-drill.txt)):

- refused a's volume while a's container ran (exit 1);
- passed on b's volume while b slept (six SQLite files and two repositories `ok`);
- failed (exit 5) on a scratch volume holding a file that is not a SQLite database.

Earlier runs had the same outcome with earlier versions of the script:

- **Run 1** (13:37:48, 120 files, [kit/backup-drill.sh](kit/backup-drill.sh)). That version checked SQLite at the
  backup, on the read-only volume, where a WAL database with its `-shm` does not open. It printed "unable to open
  database file" for `drill.sqlite` and a summary that miscounted it as "5 of 5 ok".
- **Run 2** (14:17:36, 158 files, [kit/backup-drill-2.sh](kit/backup-drill-2.sh)). That version inspected the
  unpacked copy as root, which could leave a root-owned `-shm` beside a database the runner then cannot write; none
  did.

The final script inspects only the unpacked copy, as the runner's user, one line per item, and fails on anything but
`ok`. Its test changed with it.

A wake while another container refers to the volume (as a backup's helper does,
[kit/held-wake.sh](kit/held-wake.sh)): b failed 3 s after the wake, with `DOCKER_CHANNEL_REFUSED` (detail
`HTTP 409 VOLUME_IN_USE`). It stayed failed after the helper was removed; its owner's Retry made it READY at
generation 3 on the same volume. The runbook says so, and it is listed below.

## 4. Host restarts (the coordinator's conditions of 2026-10-17)

`d5-dind` restarted with its own dockerd and everything in it. Each time:

- account a was READY, with a SQLite writer running in its container. The writer committed, then logged the
  committed id and fsynced ([kit/drill.py](kit/drill.py) `writer`);
- account b had just been put to sleep.

[kit/restart-drill.sh](kit/restart-drill.sh) drove it; [dind/restarts.jsonl](dind/restarts.jsonl),
[dind/docker-reports.jsonl](dind/docker-reports.jsonl), [dind/pool.jsonl](dind/pool.jsonl) and
[dind/data.jsonl](dind/data.jsonl) record it.

| Run (UTC) | Docker's report of a's container | The manager | Compute | After | Data |
| --- | --- | --- | --- | --- | --- |
| Graceful, `docker restart -t 300 d5-dind` (13:43:55) | exited 0, `FinishedAt` 13:43:56.38 | `FAILED` `POD_TERMINATED` "exited (exit 0)", that report recorded as `OBSERVED_STOP` | a's 2000m held while failed | Retry: generation 2 on the same volume, READY; b woken (generation 4) | writer 119 logged = 119 rows, `ok`; all files the same |
| Power cut, `docker kill` + `docker start` (13:59:06) | exited 255, `FinishedAt` 13:59:08.65, the inner daemon's restore | `FAILED` `POD_TERMINATED` "exited (exit 255)", `OBSERVED_STOP` 255 | held while failed | Retry: generation 5, READY; b woken (generation 5) | writer 388 logged, 389 rows (the last commit before its log line), `ok`; all files the same |
| Graceful, observed (14:06:41) | exited 0, `FinishedAt` 14:06:41.26 | as above | held while failed; 4000m with both up | generation 6; b generation 7 | writer 762 logged, 763 rows, `ok`; same |
| Power cut, observed (14:09:00) | exited 255, `FinishedAt` 14:09:01.30 | as above | as above | generation 7; b generation 8 | writer 1147 = 1147 rows, `ok`; same |

**One container per volume.** Through the two observed runs (14:06:06–14:12:55,
[dind/one-container-per-volume.json](dind/one-container-per-volume.json)):

- Every container on the test host was sampled every 0.5 s (672 samples; 22 were taken while the test host was
  down, [dind/volume-samples.jsonl.gz](dind/volume-samples.jsonl.gz)). No data volume ever had more than one
  container referring to it, running or not.
- Docker's own events ([dind/docker-events.jsonl](dind/docker-events.jsonl)) show each runner's containers one
  after another: each destroyed before the next was created.

**Runs that do not count.**

- **Power-cut run 1 (13:48:43).** The driver stopped at its first database read after the restart, while Postgres
  was still starting. The driver now waits for Postgres, and the run's records are kept outside these files.
- **Power-cut run 2 (13:51:38).** The test host did not come back by itself: its dockerd took a new process for
  the killed containerd, whose pid file had survived in the container's own `/run`, and gave up. A real host's `/run`
  is a tmpfs that a reboot clears, so `d5-dind` was recreated with the same data and a tmpfs `/run`. Its runner then
  failed with exit 255 like the others, its Retry made generation 4, and no row or file was lost (`data.jsonl`,
  "power-cut run 2 aftermath").
- **The first two restarts' sampling.** The sampler ended at the first restart (an unhandled timeout), and its
  truncated volume names merged two volumes. The events recorder never started: its `pkill -f` matched the shell
  starting it. Both were fixed, and both restarts were run again as the "observed" rows above.
- **The accounts step at 13:17:51.** It was interrupted when the runner went offline at 13:18:12Z, and run again.

## 5. The channel and the apiserver down

[kit/outage-drill.sh](kit/outage-drill.sh); the records are in [dind/steps.jsonl.gz](dind/steps.jsonl.gz).

- **`docker stop orbit-docker-channel`, 14:01:53–14:02:55.**
  - a stayed READY and usable. The apiserver logged "READY, and the docker backend did not answer: … connect ENOENT
    …/channel.sock; looking again next pass".
  - b's wake backed off `TRANSIENT`, attempts 1 to 4. With the channel back it was STARTING at 14:04:02 and READY
    at 14:04:32. A fifth failed attempt would have made it `RETRY_EXHAUSTED`.
- **`docker stop orbit-apiserver` for 60 s.** a's container ran on, the same container since 14:00:05. a was READY
  6 s after the apiserver started.

## What was found, and what became of it

| | Finding | Done |
| --- | --- | --- |
| 1 | The channel took `<uuid>\n` as a runner id (a credential file) or an owner id (a volume label) | Fixed in d44626483 (`\Z` anchors) with a test; refusal suite clean on the deployed fix |
| 2 | A full disk under the channel's state directory stopped the disk check before it stopped anything | Fixed in d44626483 (the stop does not wait for the record) with a test |
| 3 | No backup, restore or failure runbook; the `serverUrl` rule and runners' network reach not written down | `docs/managed-runner-docker-operations.md`, `scripts/managed-runner/volume-backup.sh` (and its test), self-hosting |
| 4 | After a host or Docker restart every running runner needs its owner's Retry | To the coordinator |
| 5 | A failed runner is not logged by the apiserver; `OOM-killed` and other details reach no client | To the coordinator |
| 6 | A wake that finds another container on the volume fails at once, and stays failed (`VOLUME_IN_USE`) | To the coordinator |
| 7 | `PVC_MISSING` has no way back, even after the volume is restored | To the coordinator |
| 8 | In Compose the storage budget measures the disk under `data/managed-runners`, not Docker's data root | To the coordinator; the runbook says how to keep them together |
| 9 | Runners reach the host's services on non-loopback addresses and, through the host, its LAN | To the coordinator (an owner's decision); the runbook recommends firewalling |
| 10 | The channel caps each container but not their number, and offers volume deletion the manager never uses | To the coordinator (defence in depth) |
| 11 | `/tmp` is `noexec`: `go test` and anything run from `/tmp` fail | To the coordinator |

## Not shown here

- **A real power loss.** In the test host's power cut, the HPC host's kernel and page cache stayed up. So what a
  real power loss does to writes not yet on disk, and a kernel reboot itself, were not tested. The runbook gives
  the checks and recovery steps after a real one.
- **AppArmor in the default deployment.** AppArmor was measured on the HPC host's Docker; inside `d5-dind` no
  profile can be loaded. Hosts with SELinux instead of AppArmor were not checked.
- **The default limits.** Memory and disk were filled only at small limits on the HPC host. The default deployment's
  4 GiB and 20 GiB were read from the cgroup and the profile, not filled.
- **The LAN.** Its reach was not probed: only the host's own LAN address was. The rest follows from the runner's
  default route through the host.
- **A real engine session.** None (D4); the runners' Codex had a placeholder key.
- **A compromised token holder.** The channel bounds what each request can do, not what someone with its token
  can do in sum (findings 10, 7).

Account passwords stayed in a 0600 file outside these files. Before committing, every file here, the `.gz` ones
included, was scanned for both channels' tokens, the deployment's `.env` secrets, the account passwords and every
runner credential the runs used: no match, and no JWT-shaped string.
