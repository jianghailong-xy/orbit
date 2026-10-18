# Docker backend: the channel and the default deployment hardened, 2026-10-17 (task D8)

Task D8 (34hXCWEWAgHqtrxZsMBOh) of project 34ZteKCnYMpKY46f63Leb, criterion 12. It takes up three of D5's findings
([D5's evidence](../../managed-runner-docker-security/2026-10-17/README.md), findings 5, 7 and 8 of its comment):

- the storage budget measured the disk under `data/managed-runners`, not the one Docker's volumes live on;
- the channel bounded each container but not their number, and served volume removal to the token's holder;
- a runner's `/tmp` was `noexec`, so a program run from it and `go test` failed.

What changed, and why each way was chosen over the others, is in
[docs/managed-runner-design.md](../../../managed-runner-design.md), "Implementation record: channel and template
hardening". The operator's side is in [the runbook](../../../managed-runner-docker-operations.md) and
[self-hosting](../../../self-hosting.md#managed-runners).

## Where it ran

`d8-dind`, an isolated Docker host on the HPC machine ([kit/dind-up.sh](kit/dind-up.sh)):

- A `docker:29.8.2-dind` container: privileged for its own dockerd, 6 GiB and 8 CPUs, `--oom-score-adj 1000`,
  outside the Orbit runner's cgroup, labelled `orbit.test=d8-34hXCWEWAgHqtrxZsMBOh`. Its gateway was published on
  host 127.0.0.1:14886 only.
- **Two filesystems.** Its Docker data root is `/mnt/data/tmp/34hXCWEWAgHqtrxZsMBOh/dind/docker`, on the host's
  `/mnt/data` (ext4, 14.4 TiB). The deployment's checkout `/work/orbit`, and with it `data/managed-runners`, is on a
  3 GiB tmpfs of the test host's own. This is the case finding 5 is about: the checkout and Docker's data root on
  different filesystems.
- The checkout reads its objects from a bare clone on `/mnt/data`, mounted read-only ([kit/repo-sync.sh](kit/repo-sync.sh),
  [kit/checkout.sh](kit/checkout.sh)), with `docs/evidence` left out of the working tree to keep the tmpfs small. The
  test host never saw the shared repository.
- Nothing of an existing deployment, and no other container, was touched. The HPC host's Docker daemon was not
  restarted, and its configuration was not changed.

The commits: the change is d90a81dba amended to 5d1c9b409 (code, tests, docs), merged with `origin/main` as
2d16d5f1e (the same tree). Scenarios A and B ran at 2d16d5f1e. Two message-only fixes followed (ddd7a5994,
b8186215e: the cap's refusal and the channel's start-up line read right for any count, and a runbook note), with
a test of the start-up lines (53f917b55). Scenario C ran at ddd7a5994, and the channel at b8186215e ran once more
on the test host's Docker (below).

## How Docker takes an executable `/tmp`

Before choosing, [kit/tmpfs_api_probe.py](kit/tmpfs_api_probe.py) asked the test host's Docker 29.8.2 (API 1.56) for
`/tmp` each way: the mount API's tmpfs with `TmpfsOptions.Options`, at API 1.44 (what the channel speaks) and 1.46,
and `HostConfig.Tmpfs`. It recorded the mount the kernel reports and whether a program copied to `/tmp` runs, as UID
10001 with every capability dropped and a read-only root ([dind/tmpfs-api-probe.json](dind/tmpfs-api-probe.json)).

| Asked for | `/tmp` as mounted | A program from `/tmp` |
| --- | --- | --- |
| Mount API tmpfs, no options (the template before this task) | `rw,nosuid,nodev,noexec` | exit 126 |
| Mount API tmpfs, `Options [["exec"]]`, API 1.44 or 1.46 | `rw,nosuid,nodev`, size kept (64 MiB) | exit 0 |
| `HostConfig.Tmpfs` `rw,exec,nosuid,nodev,…` | `rw,nosuid,nodev` | exit 0, but not in inspect's `Mounts` |
| `Options [["exec"], [x]]` with x `suid`, `dev`, `size` or `nr_inodes` | refused: `400 invalid option` | — |

So the template keeps the mount API and adds `Options [["exec"]]`. Docker keeps it `nosuid` and `nodev`, there is
no way to ask otherwise, and inspect still lists `/tmp` among the mounts, as `docker-backend.it.ts` checks.

## B. An install at the previous tip, then `/upgrade`

The project line's tip 1f5bc9cec, installed with `scripts/install-server.sh` and no flags, exit 0 at 17:08:36Z
([dind/install-base.txt.gz](dind/install-base.txt.gz)).

**At 1f5bc9cec the budget measured the checkout's tmpfs** ([dind/disk-facts-B1-base-installed.txt](dind/disk-facts-B1-base-installed.txt)):

| | Docker's data root | The checkout and the channel's state directory | What `/v1/info` measured |
| --- | --- | --- | --- |
| Filesystem | ext4, fsid `b035fd6ae24482e4` | tmpfs, fsid `11d28d787da4d6de` | `/var/lib/orbit-managed-runners/state` |
| Size | 15,873,633,447,936 bytes | 3,221,225,472 bytes | 3,221,225,472 bytes |
| Free | 15,287,051,149,312 bytes | 2,558,005,248 bytes | 2,558,005,248 bytes |

`docker-channel` mounted the Docker socket and the managed runners' directory, nothing else. The apiserver's pool took
`storage_usable_bytes` 2,558,226,432 and `storage_headroom_bytes` 322,122,548 (a tenth of the tmpfs) from it.

**So the first account got no runner.** The administrator, account `a`, signed in at 17:08:54. Its runner went
`WAITING_CAPACITY`: `MANAGED_RUNNER_CAPACITY_UNAVAILABLE`, `short: ["storage"]`, "(storage pool space)". A 20 GiB
volume does not fit in 2.2 GB, though Docker's own disk had 15.3 TB free. No container and no volume was made
([dind/inventory-B2-base-waiting.txt](dind/inventory-B2-base-waiting.txt), [dind/steps.jsonl](dind/steps.jsonl)).

**`/upgrade` to 2d16d5f1e** (`.claude/skills/upgrade/upgrade.sh`, no flags, 17:09:12–17:27:00Z, exit 0,
[dind/upgrade-B.txt.gz](dind/upgrade-B.txt.gz), its Docker calls in [dind/docker-calls-B-upgrade.txt](dind/docker-calls-B-upgrade.txt)):

- It built the images with `docker-channel` and the managed runner image (`sha256:26eefb81…`), named that ID in
  both files, and recreated the apiserver, then `docker-channel` last. No file in `data/managed-runners` gained a
  setting: the probe comes with the Compose file.
- The new apiserver's two passes before the channel came back stopped at the image mismatch (17:26:46, 17:26:51), as
  D6 designed. The channel served the new image at 17:26:55
  ([dind/apiserver-managed-lines-B3.txt](dind/apiserver-managed-lines-B3.txt)).

**After it, the budget measures Docker's disk** ([dind/disk-facts-B3-after-upgrade.txt](dind/disk-facts-B3-after-upgrade.txt)):

- `docker-channel` runs `serve … --disk-probe-path /var/lib/orbit-docker-volumes`. Its third mount is an anonymous
  volume (`com.docker.volume.anonymous`) at that path, `rw=false`. The volume is empty, its mount point is on the
  data root's filesystem (fsid `b035fd6ae24482e4`), and a write to it from inside the channel fails with "Read-only
  file system" (`/proc/mounts`: `ro`).
- `/v1/info`: `host.disk` is `/var/lib/orbit-docker-volumes`, 15,873,633,447,936 bytes, 15,284,347,031,552 free;
  `limits.maxContainers` 14, which the channel logged as derived; `allowVolumeRemoval` false.
- The pool was measured again at 17:26:56: `storage_usable_bytes` 15,284,347,346,944, `storage_headroom_bytes`
  1,587,363,344,794 (exactly a tenth of the disk, rounded up), and a's 20 GiB already reserved.
- a's runner, waiting since 17:08:54, was admitted. Its volume and container `mr-01a14ad6…` were made, generation 1,
  `STARTING` at 17:27:24 ([dind/inventory-B3-after-upgrade.txt](dind/inventory-B3-after-upgrade.txt)).

The deployment was then removed whole ([dind/teardown-B.txt](dind/teardown-B.txt)). The images stayed, which made
the next install fast.

## A. A fresh install at the tip

`scripts/install-server.sh`, no flags, at 2d16d5f1e: exit 0 at 17:30:25Z
([dind/install-fresh.txt.gz](dind/install-fresh.txt.gz)).

**The disk** ([dind/disk-facts-A1-fresh-installed.txt](dind/disk-facts-A1-fresh-installed.txt)). As after the upgrade:
the probe is an empty, read-only anonymous volume on the data root's filesystem. `/v1/info` measured
15,873,633,447,936 bytes, 15,283,189,526,528 free, and the pool took 15,283,189,055,488 usable and 1,587,363,344,794
headroom, while the checkout's tmpfs was 3 GiB. Accounts `a` (the administrator) and `b` signed in at 17:30:46, and
both runners had their containers at 17:30:50.

**`/tmp`** ([dind/runner-tmp-A3-a.txt](dind/runner-tmp-A3-a.txt), [kit/runner_tmp_check.sh](kit/runner_tmp_check.sh)),
inside a's runner container as its user, 10001:10001, with `TMPDIR` and `GOTMPDIR` unset:

| | Result |
| --- | --- |
| The mount | `tmpfs /tmp tmpfs rw,nosuid,nodev,relatime,size=1048576k` |
| A script written to `/tmp` and run | exit 0 |
| A program copied to `/tmp` and run | exit 0 |
| A Go binary built into `/tmp` and run | exit 0 |
| `go test` of a module in `/tmp`, the default temporary directory | `ok d8`, exit 0 |
| `go test` of the same module copied to the data volume, the default temporary directory | `ok d8`, exit 0 |
| `go run` | exit 0 |
| (D5, before this task: `go test` with the default temporary directory) | (exit 1) |
| 1100 MiB written to `/tmp` | `No space left on device` at 1,071,321,088 bytes; `/tmp` 1,073,741,824 bytes, 100% |

What Docker made of the template ([dind/runner-container-tmp-inspect-A3.txt](dind/runner-container-tmp-inspect-A3.txt)):
`/tmp` is `{"SizeBytes":1073741824,"Mode":1023,"Options":[["exec"]]}`, with no `HostConfig.Tmpfs`, and the rest as
before: user 10001:10001, read-only root, `CapDrop [ALL]`, memory 4,294,967,296 bytes.

**The container cap** ([dind/cap.jsonl](dind/cap.jsonl), [dind/channel-requests.jsonl](dind/channel-requests.jsonl),
[dind/status-transitions.jsonl](dind/status-transitions.jsonl)). This test host's Docker reports the HPC machine's
16 GB, so the default profile's 4 GiB runners already fit only two (`pods` 2). To show the cap, and not the memory,
holding a runner back, it was set below that, to 1:

1. 17:32:04: `limits.maxContainers` 1 in `channel.json`, checked with the channel's `check-config`; `docker-channel`
   recreated, then the apiserver. `/v1/info` reports 1. Two containers were there, and both were exactly as before:
   the same ID, state, start time and PID (a snapshot of every container, before and after).
2. 17:32:35: as the token's holder, a volume and a credential for a runner nobody has (200, 200), then its container:
   `429 CONTAINER_LIMIT`, "this instance has 2 containers, its limit (limits.maxContainers 1)…" (the wording of
   2d16d5f1e). Every container on the test host was unchanged, and nothing was made.
3. 17:32:44: account `c` signed in. Its runner waits, `WAITING_CAPACITY`. At that moment it is short of memory, runner
   slots, volume attachments and active users: the pool's `pods` is now 1, with 2 reserved.
4. b's runner was put to sleep, to free memory. Its owner's sleep was refused (`409`, "A STARTING managed runner is
   not put to sleep": no runtime is signed in on it), so the administrator disabled b at 17:43:13. Its runner was
   `SLEEPING` by 17:43:23, with its container removed and its volume kept.
5. 17:43:34: c still waits, now short only of runner slots, volume attachments and active users (`pods` 1, 1
   reserved). Memory had room for it (4 of 11.2 GiB reserved), so the cap alone held it back. a's container was
   unchanged (ID `197be8004309…`, started 17:30:47, PID 73836). The token holder's create, at 17:43:46 with one
   container there: `429 CONTAINER_LIMIT` again, nothing changed.
6. 17:44:14: the cap removed from `channel.json`; the channel and the apiserver recreated. `/v1/info` reports 14
   again, and c's runner had its container at 17:44:38, the first time it was looked at.

**Deleting a volume, by the runbook** ([dind/delete-volume-drill-A10.txt](dind/delete-volume-drill-A10.txt),
[kit/delete-volume-drill.sh](kit/delete-volume-drill.sh)): its "Delete a runner's volume", with its own commands, on
b's volume:

- b was disabled and its runner `SLEEPING`, and `docker ps -a --filter volume=…` printed nothing. A backup came first,
  of 8 files.
- With removal off, the channel refused: `403 REMOVAL_REFUSED`, and the volume stayed.
- `"allowVolumeRemoval": true` was added. `docker compose run --rm docker-channel check-config` said
  `{"ok": true, …}`, and `docker compose up -d --force-recreate docker-channel` brought the channel up healthy. The
  check left no volume behind.
- The runbook's `curl`: a wrong UID got `409 UID_MISMATCH`; the volume's own UID got `HTTP 204`. The probe runner's
  credential and volume from step 2 were removed the same way (204, 204).
- With the line removed again and the channel recreated, a removal was refused (403) once more.
- Afterwards b's volume is gone. Its mapping still names it (`SLEEPING`, the same `pvc_uid`), and b stays disabled, as
  the runbook says.

**What the teardown showed** ([dind/teardown-A.txt](dind/teardown-A.txt), [dind/anonymous-volumes-A10.txt](dind/anonymous-volumes-A10.txt)).
After the channel had been recreated, `docker compose down -v` left the probe volume behind, empty, since Compose
hands a recreated container its predecessor's anonymous volume by name. In B, where the channel was not recreated
after the probe was made, it went with the rest. The runbook now says so: the volume holds nothing and can be removed.
The other anonymous volume of a deployment is `pgbackup`'s own (the Postgres image's `VOLUME`), there before this task.

## C. A deployment without managed runners, upgraded

Installed by hand at 1f5bc9cec, as README's Quick Start says (`.env` from `.env.example` with its two secrets,
`docker compose up -d --build`), so its `.env` names no managed runner line: orbitd.io's kind
([dind/off-install-C.txt](dind/off-install-C.txt), [kit/off-install.sh](kit/off-install.sh)). Then `/upgrade` three
times, every `docker` call logged ([kit/docker-shim.sh](kit/docker-shim.sh)):

| Run | Script | Exit | Docker calls |
| --- | --- | --- | --- |
| C3 | 1f5bc9cec's `.claude/skills/upgrade/upgrade.sh` | 0 (146 s) | [dind/docker-calls-C3-base-claude.txt](dind/docker-calls-C3-base-claude.txt) |
| C4 | ddd7a5994's `.claude/skills/upgrade/upgrade.sh` | 0 (95 s) | [dind/docker-calls-C4-tip-claude.txt](dind/docker-calls-C4-tip-claude.txt): the same 7 calls in the same order as C3, the times and the serving web image's ID set aside |
| C5 | ddd7a5994's `.agents/skills/upgrade/scripts/upgrade.sh` | 0 (28 s) | [dind/docker-calls-C5-tip-agents.txt](dind/docker-calls-C5-tip-agents.txt): exactly the 6 calls `new_deployment_test.py` pins for this copy |

Neither copy of the script changed in this task (`git diff 1f5bc9cec` of both is empty). The Compose file did, and
with the profile off it lists the same six services and the same one named volume as before. After each run
([dind/off-state-C2-installed.txt](dind/off-state-C2-installed.txt) and the three after it):

- `.env` had the same checksum as installed;
- `data/` held `pg-archive` and `postgres` only;
- the same six services, the same volumes (`pg-socket` and `pgbackup`'s anonymous one, no probe), the same networks;
- no managed runner container, volume, channel or `orbit-managed-runners` network.

## The channel at b8186215e, once more on real Docker

The two message fixes came after A. [kit/standalone_channel.sh](kit/standalone_channel.sh) ran `channel.py` at
b8186215e by itself on the test host's Docker, as a host-level channel runs, with its own label, ICC-off network,
token and state directory, and `limits.maxContainers` 1 ([dind/standalone-channel-final.txt](dind/standalone-channel-final.txt)):

- The first container was made (201, running). The second was refused, `429 CONTAINER_LIMIT`, "containers of this
  instance: 1, at its limit (limits.maxContainers 1); …".
- The first container's `/tmp`: `rw,nosuid,nodev,…,size=65536k`; a program run from it exited 0, and `TmpfsOptions`
  was `{"SizeBytes":67108864,"Mode":1023,"Options":[["exec"]]}`.
- A volume removal was refused (`403 REMOVAL_REFUSED`); the start-up line read "containers of this instance: at most 1".
- Everything it made was removed by UID, and nothing was left on the test host.

## Tests

- `scripts/managed-runner/docker_channel_test.py`: 52 tests, 13 of them new and 6 extended for this task. They cover
  the cap (derived and configured, the refusal with nothing made and nothing touched, exited containers counted,
  other instances' not, concurrent creates at the cap's edge, a create answered once at the cap), volume removal
  (refused unless on, then by UID), `/tmp` (the template's exec option and size; a `/tmp` without a size or with
  another option caught, in the spec and in what Docker made, and an engine that drops the option allowed), the
  disk probe (measured where it says, a missing one stops the channel, the configuration's own wins over
  `--disk-probe-path`), and the start-up lines.
  - Against the channel of 1f5bc9cec: 11 failures and 14 errors
    ([unit/docker-channel-test-against-1f5bc9cec.txt](unit/docker-channel-test-against-1f5bc9cec.txt)).
  - Against this tree: all pass ([unit/docker-channel-test.txt](unit/docker-channel-test.txt)).
- `docker-backend.spec.ts`: the budget holds no more runners than the channel's reported cap, a stated pod count
  included, and ignores a missing or nonsensical cap.
- `test/compose-topology.test.mjs` (m): the amended `docker-channel` definition, pinned line by line.
- The project's merge check, the managed-runner Python suite, every managed runner pg spec and
  `tenant-isolation-runner` ran on the final tip. Their results are in the task's evidence.

## Not shown here

- **Docker older than 27.** Only Docker 29.8.2 was run. That an older engine ignores `TmpfsOptions.Options`, and
  keeps `/tmp` `noexec`, is the API's documented history; the channel's warning for it is unit-tested.
- **A host whose data root is not `/var/lib/docker`.** The test host's data root is a bind of `/mnt/data` at the
  default path, on its own filesystem; the probe does not depend on the path, but no host with `data-root` moved was
  run.
- **A real engine session.** None: the runners had no runtime signed in (`STARTING`, `MODEL_UNAVAILABLE`), which none
  of these checks needs. D4 runs them.
- **What a runner can reach** (D5's finding 6) waits for the owner's decision and is not part of this task.

Account passwords stayed in a 0600 file outside the evidence, deleted with each deployment. The channel's token was
read only by the kit's client inside the test host, and credentials are recorded by their length. Before committing,
every file here, the `.gz` ones included, was scanned for JWT- and base64-secret-shaped strings, bearer headers,
`.env` secret assignments and credential fields: no value matched.

`d8-dind` is stopped, with its data in `/mnt/data/tmp/34hXCWEWAgHqtrxZsMBOh` (19 GB, most of it images), to be
removed once the evidence is judged.
