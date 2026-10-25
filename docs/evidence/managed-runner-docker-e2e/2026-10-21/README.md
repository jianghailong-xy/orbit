# Docker backend end to end on the HPC host's own Docker (task D4, 2026-10-21)

Acceptance of project criterion 9 (task D4, `34hJ7RzpqTB13BmLR8uQv`), plus the real engine session D2 left to this
task: on the HPC host's real Docker (29.8.2, API 1.56, cgroup v2), new accounts signed in to an isolated test server
and got a managed runner. A runner is one container plus one local volume. Each account then got a heartbeat, a
default workspace bound to that runner and a first session answered through the owner's DeepSeek key. The run also
covered concurrent and repeated sign-ins, manager restarts compared against Docker, cross-account requests, and a
sleep and wake with the same engine session continuing. Run 23:15–23:37 UTC on 2026-10-20. No code changed; no
defect found.

## The test stack

Everything was built from one commit of the project line, `2b187b370` (`project/34ZteKCnYMpKY46f63Leb`, which then
held all of `main` plus T03's last commits, 198f6d6cc included). It ran from `kit/` ([`stack.sh`](kit/stack.sh),
[`build-images.sh`](kit/build-images.sh)). It was not a deployment: nothing of an existing Orbit deployment, the
production server or this host's firewall was touched, and nothing was pushed.

| Piece | How it ran | Listening on | Caps ([caps.txt](records/caps.txt)) |
| --- | --- | --- | --- |
| apiserver (the manager) | `node -r kit/loopback.cjs src/apiserver/dist/main.js`, built from the commit, in the transient unit `d4-apiserver.service`; `ORBIT_MANAGED_RUNNERS_ENABLED=true`, a Docker profile | 127.0.0.1:3714 only (`loopback.cjs` binds a port-only `listen` to 127.0.0.1) | MemoryMax 1.5 GiB, no swap, CPUQuota 200% |
| PostgreSQL | `postgres:16-alpine` container `d4-pg`, migrated from empty | 127.0.0.1:5714 only | 512 MiB, 1 CPU |
| Docker channel | `deploy/managed-runner/docker-channel` image (`sha256:a736336f…`), run as root Compose runs `docker-channel`: no network, `docker.sock`, the managed runners' directory, the disk probe volume | its unix socket | 256 MiB, 0.5 CPU, 256 PIDs |
| The runners' door | `kit/forward.mjs` in `d4-door.service`: passes connections to 127.0.0.1:3714. It plays the part of root Compose's gateway port, which runners reach at the gateway of their network | 172.18.0.1:2714 only, the gateway of the runners' network `d4-managed-runners` (bridge, inter-container traffic off, IPv4) | 128 MiB, 50% CPU |
| Runner containers | made by the manager through the channel from the managed runner image `orbit-managed-runner:d4-2b187b370` (`sha256:716c65e7…`, `deploy/managed-runner/image` at the commit, label `org.opencontainers.image.revision=2b187b370…`) | (none) | each 1 CPU, 1 GiB memory with no swap, 1024 PIDs, `/tmp` 512 MiB; volume limit 2 GiB |

- **Images.** Both were built in the memory-capped buildx builder `t03-capped`, which was stopped again afterwards
  ([images.txt](records/images.txt), [build-images.txt](records/stack-logs/build-images.txt)). The image carries
  198f6d6cc: each container's environment names `ORBIT_MANAGED_RUNNER_INSTANCE_FILE`, its
  `/run/orbit-bootstrap/instance.json` was root-owned and read-only, and every runner logged
  `managed runner instance identity read`.
- **Outside the runner's cgroup.** This session runs under `orbit-runner-root.service` (`OOMPolicy=stop`). Every
  piece above ran outside it: the two node processes in units of their own (`/system.slice/d4-*.service`), the
  containers in Docker's scopes. [caps.txt](records/caps.txt) shows each one's cgroup and `memory.max`.
- **Configuration.** The profile and `channel.json` follow `scripts/install-server.sh` field by field. The
  differences are smaller per-runner resources, 2 GiB volumes, a stated compute budget of 4 CPU / 4 GiB (four
  runners) instead of one derived from the host, and the channel's ceilings lowered to match (`maxContainers` 4).
  The lifecycle settings are the install's.
- **Firewall.** The managed runners' firewall (D9) was not installed: it would change this host's firewall, which
  this task may not. The channel had no `firewall/config.json`, which is how a deployment turns the firewall off
  (`--no-managed-runner-firewall`), so it did not wait for one. What a runner can reach with and without the
  firewall was verified by D9 in an isolated Docker host
  ([evidence](../../managed-runner-docker-firewall/2026-10-19/README.md)) and is not repeated here.
- **Model.** The model was the owner's DeepSeek key, from `/mnt/data/managed-runner-lab/secrets/deepseek-api-key`.
  `d4.py key` read it from that file at the moment it sent it as the account's own provider (`POST /providers/mine`,
  preset `deepseek`, `https://api.deepseek.com/anthropic`), and the apiserver stores it encrypted. It was never
  printed. Engine: Claude Code 2.1.300 in the image, through DeepSeek's Anthropic endpoint, model `deepseek-flash`
  (the preset's default). One session, three turns.

The driver is [`kit/d4.py`](kit/d4.py). Every step's record is a line of [steps.jsonl](records/steps.jsonl). Docker's
own events of every runner container and volume are in [docker-events.jsonl](records/docker-events.jsonl) and
[docker-volume-events.jsonl](records/docker-volume-events.jsonl), tabulated in [lifecycle.md](records/lifecycle.md).

## 1. New account: sign-in, provisioning, heartbeat, workspace, first session

The account `alice@d4.test` was made by the administrator (`POST /admin/users`) and had no managed runner record
until it signed in. Times are UTC.

| Time | What happened | Record |
| --- | --- | --- |
| 23:19:23.463 | Account made; `managed_runner` rows for it: 0 | `account` |
| 23:19:23.514 | `POST /auth/login` 201 (42 ms). Right after: 1 mapping, 1 runner row, 1 workspace, and its data volume | `signin` |
| 23:19:23.584 / .644 | Docker: data volume `mr-data-01a15b9c-c69f-…` and generation 1's bootstrap volume created | lifecycle |
| 23:19:23.685 / .812 | Docker: container `mr-01a15b9c-c69f-…` generation 1 created, started | lifecycle |
| 23:19:25.189 | The runner's first heartbeat: `ONLINE`, version `managed-2b187b370…` | `watch`, `binding` |
| 23:19:29.084 | `STARTING` with reason `MODEL_UNAVAILABLE`: the runner is up and no model is there yet | `watch` |
| 23:19:32.978 | The default workspace `Default` (`/var/lib/orbit/home/orbit-repos/default`) has `runner_id` = the managed runner, in the API and the database | `binding` |
| 23:19:37.941 | The account's own DeepSeek key added: provider `deepseek`, runtime `claude`, engines claude, opencode, dsh | `key` |
| 23:19:39.160 | `READY`, usable, `initialProvider` `deepseek` | `watch` |
| 23:19:43.307 | `POST /sessions` in the default workspace with no provider or engine named: 201, provider `deepseek`, engine `claude`, assigned to the managed runner | `session` |
| 23:19:47.360 | Answered (`AWAITING_INPUT`, `turn_end` success). The engine ran one Bash call in the session's worktree on the volume: `/var/lib/orbit/home/.orbit/worktrees/01a15b9d-…`, uid `10001`, `D4-MARKER-7Q2K` written to `d4-first.txt`. Model `deepseek-flash`, engine session `6f8d5692-…` | `wait`, [events](records/sessions/34jRwvfOVVYVD5k4BkMuR.events.json) |

The administrator's own first sign-in (`POST /auth/bootstrap`) provisioned its runner the same way, with the
container started 0.5 s after the sign-in. The administrator added no key, so its runner stayed
`MODEL_UNAVAILABLE`.

## 2. Concurrent and repeated sign-ins; manager restarts; cross-account requests

**Sign-ins.** Every sign-in below answered 201 with a token of the right account, and no new resource appeared:

| Account | Sign-ins | Mappings, runner rows, workspaces after | Container creates in Docker's events |
| --- | --- | --- | --- |
| bob (new) | 8 at once, its first sign-ins (23:19:58.4); 4 more at once while STARTING (23:20:16.5); then 8 `POST /managed-runner/ensure` at once, all 202 with the same runner | 1, 1, 1; one data volume | 1 (23:19:58.645) |
| alice | 3 more, one after another, while READY | 1, 1, 1 | none: the same container (`8b0bd6e1ffdc`, started 23:19:23.704) before and after |

**Manager restarts.** After every restart, [`d4.py inventory`](kit/d4.py) compared the database's `managed_runner`
rows with Docker's containers and volumes of the instance. It checked that the volume exists and its UID label
equals `pvc_uid`, and that its owner and runner labels and the volume handle are the mapping's. It checked that a
READY or STARTING mapping has its container, with UID label equal to `pod_uid`, the mapping's generation and the
mapping's volume UID, running when READY, and that a SLEEPING one has none. It also checked that no data volume or
runner container is without a mapping, no volume is held by two containers, and each account has one mapping and
one runner row. Every comparison agreed:

| Inventory | Situation | Result |
| --- | --- | --- |
| [1](records/inventory/1-after-sign-ins.md) | after the sign-ins above | 3 mappings = 3 containers + 3 data volumes, agree |
| [2](records/inventory/2-alice-asleep.md), [3](records/inventory/3-alice-awake.md) | alice asleep, then woken (section 3) | agree; asleep: no container, volume kept |
| [4](records/inventory/4-after-graceful-restart.md) | manager stopped with SIGTERM (23:23:46), down 21 s, started again | the same three containers (same IDs and generations) before, during ([down](records/restart-4-graceful-down.txt)) and after; agree |
| [5](records/inventory/5-after-kill-in-steady-state.md) | manager killed with SIGKILL (23:24:54), down 46 s, two runners STARTING, one READY | the same containers throughout; agree |
| [6](records/inventory/6-after-kill-while-draining.md) | alice asked to sleep and DRAINING (23:32:00.8); manager killed 0.2 s later, down 51 s | her container kept running, unremoved, while the manager was down ([down](records/restart-6-kill-draining-down.txt)). After the restart: exit 0 at 23:33:09.0, removed 23:33:13.4, SLEEPING 23:33:13.9, volume kept; agree |
| [7](records/inventory/7-after-kill-mid-provisioning.md) | carol's first sign-in (23:33:26.747), manager killed 1 s later, mid-provisioning | at the kill, Docker had already created and started her container (23:33:27.173 / .387) while the database still had `CREATE_POD` `PENDING` with no `pod_uid` ([at kill](records/restart-7-kill-mid-provisioning-at-kill.txt)). After the restart (23:33:59) the manager recorded that same container (`4c35fb746a28`, UID `9725f650…`) and made nothing else: Docker's events have one create for carol. Her runner's heartbeats were refused `503 MANAGED_RUNNER_INSTANCE_PENDING` until then; it was ONLINE at 23:34:58 and `MODEL_UNAVAILABLE` at 23:35:00; agree |
| [8](records/inventory/8-before-cleanup.md) | the end: 4 accounts | 4 mappings = 4 containers + 4 data volumes, agree |

Bob's planned kill-while-draining became inventory 5: a STARTING runner is not put to sleep
(`409 MANAGED_RUNNER_TRANSITION_REFUSED`, "A STARTING managed runner is not put to sleep."). So that round is a SIGKILL
with runners up, and the draining case is inventory 6, with alice. In `steps.jsonl` that inventory still carries its
first label, `5-after-kill-while-draining`.

**Cross-account requests** (23:20:55–23:21:49). Bob had a managed runner of his own. He named alice's runner,
workspace, owner id and revision in every door an account has. Nothing of alice's was touched: her mapping,
container (ID, start time, generation, UID) and volume (UID, creation time) were the same after as before, and
Docker recorded no event for her runner in the window (`cross` in steps.jsonl).

| Request (as bob) | Answer |
| --- | --- |
| `GET /managed-runner` | 200, bob's own mapping |
| `POST /managed-runner/{wake,ensure}` with alice's ids in the body | 202, bob's own runner (`34jRxJPX…`): the body cannot address another mapping |
| `POST /managed-runner/{sleep,retry}` with alice's ids and revision | 409 `MANAGED_RUNNER_REVISION_CONFLICT`, against bob's own mapping |
| `POST /managed-runner/delete` | 409 `MANAGED_RUNNER_TRANSITION_REFUSED` |
| `GET`/`PATCH`/`DELETE /runners/<alice's>`, `GET`/`POST /runners/<alice's>/install`, `POST …/login`, `…/self-update`, `…/rotate-token` | 404 each |
| `GET`/`PATCH`/`DELETE /workspaces/<alice's>` | 404 each |
| `POST /workspaces` on alice's runner; `POST /sessions` in alice's workspace (it would wake her runner); `POST /sessions` assigned to alice's runner | 403 each |
| `POST /admin/managed-runners/<alice's>/volume-switch` | 403 (administrators only) |

The Docker channel, asked with the manager's own token (an account never has it), would not mix the two runners
either (`channel-cross`):

| Request | Answer |
| --- | --- |
| bob's runner on alice's volume (dry run) | 403 `VOLUME_REFUSED` |
| a container under alice's runner's name for bob (dry run) | 409 `SINGLE_CONTAINER_GUARD` |
| stop or remove alice's container with bob's instance UID | 409 `UID_MISMATCH` each |
| remove alice's data volume by its own UID | 403 `REMOVAL_REFUSED` (removal is off) |
| bob's runner on its own volume (dry run, the control) | 200 |

## 3. Sleep, wake, and the same engine session continuing

Before the sleep, `d4.py data seed` wrote to alice's volume through her running container, as the runner's user, in
`/var/lib/orbit/d4-data`. It wrote two random blobs (4 MiB, 64 KiB), a note, and a SQLite database in WAL mode with
5000 rows. It recorded every file's checksum, `PRAGMA integrity_check`, the row count and a digest of the dump. It
also recorded the engine's session file (`~/.claude/projects/…/6f8d5692-….jsonl`, 749,632 bytes) and `d4-first.txt`
in the session's worktree ([before-sleep](records/data/alice-before-sleep.json)).

| Time | What happened |
| --- | --- |
| 23:22:28.587 | `POST /managed-runner/sleep` (alice, revision 12): 202, `DRAINING` |
| 23:22:54.269 | Docker: generation 1 exited 0 |
| 23:22:58.865 | removed, with its bootstrap volume. The manager logged `asleep; generation 1 stopped (OBSERVED_STOP), compute released, volume kept`; `SLEEPING` at 23:22:59.8, no container, the data volume still there ([inventory 2](records/inventory/2-alice-asleep.md)) |
| 23:23:08.030 | The next message in the same session (`kit/prompts/resume.txt`: recall the marker without any tool). The manager logged `demand (turn) while SLEEPING`, `waking for demand (generation 2)` |
| 23:23:08.210 / .329 | Docker: generation 2 created and started on the same data volume (UID `13398645…`) |
| 23:23:13.580 | `READY`. The runner re-attached the session's worktree |
| 23:23:17.316 | Answered with no tool call: "The marker was `D4-MARKER-7Q2K`, written to `d4-first.txt` in `/var/lib/orbit/home/.orbit/worktrees/01a15b9d-…`." Same engine session id `6f8d5692-…` |

[After the wake](records/data/alice-after-wake.json), compared with before the sleep:

- every file had the same checksum;
- 5000 rows, the same dump digest, `integrity_check` `ok`, still WAL;
- the same volume UID and runtime session id;
- the engine's session file was the same file, grown to 755,927 bytes, with its first 749,632 bytes hashing to the
  whole file before the sleep, so the wake only appended to it;
- `d4-first.txt` was unchanged.

The second sleep was the one interrupted by the manager kill (inventory 6). A third message at 23:35:39.523 woke
generation 3, READY at 23:35:45.100. It was answered, again with no tool, with the marker and "you have asked me
about it once before this message". The same comparison held ([after-wake-2](records/data/alice-after-wake-2.json)).
Generation 3's log has the reclaimed session and its re-attached worktree
([runner log](records/runner-logs/mr-01a15b9c-c69f-718f-ba2a-90bd8a35230f-g3.txt)).

## 4. The key, and the cleanup

[`kit/key-scan.sh`](kit/key-scan.sh) counts lines that contain the key and prints nothing else. As controls it
counts 1 line in the key file itself and 0 in `/etc/hostname`. While the stack still ran
([key-scan-live.txt](records/key-scan-live.txt)), it found 0 in each of these:

- the stack's logs (6 files), records (35 files), kit and prompts;
- `docker logs` of PostgreSQL, the channel and the four runner containers;
- the journal of both units;
- a `pg_dump` of the test database (19,484 lines; the provider key is stored encrypted).

The other secrets of the stack (the PostgreSQL password, the channel token, `JWT_SECRET`, `PROVIDER_SECRET_KEY`, the
accounts' passwords and tokens) were in none of the records, logs or kit, and no JWT-shaped string was. The scan of
this directory before it was committed is [key-scan-evidence.txt](records/key-scan-evidence.txt).

[cleanup.txt](records/cleanup.txt) is the teardown, at 23:37:19 UTC. `stack.sh down` stopped the door, the apiserver
and the channel. It removed every container and volume of the instance `orbit-d4-e1a08e4f` (all four runners' data
volumes too: they held only test data) and the stack's own containers and volumes. It also removed the network and
both images. After it there were 0 containers, 0 volumes (and no `mr-*` volume on the host), no network, no image,
no unit, and nothing listening on 3714, 5714 or 2714. The secrets, the accounts' state, the channel's directory and
the source archive were then deleted from the work directory.

## Not shown here

- **The runners' network scope.** The managed runners' firewall (D9) was off, as above, so a runner here could reach
  this host's other ports on the network's gateway, as on any deployment without the firewall. D9's evidence covers
  the firewall.
- **Packaging.** The apiserver ran as a process on the host, with a loopback shim and a TCP forwarder, instead of
  root Compose's apiserver, gateway, web and wiki worker containers. `scripts/install-server.sh` was not run; D3 ran
  it in isolated Docker hosts. The channel ran from its own image as root Compose runs it.
- **Clients.** The web, macOS and iOS clients were not used: everything went through the API.
- **Engines.** Only Claude Code through DeepSeek's endpoint was used, not `dsh` or OpenCode. The `costUsd` in
  `turn_end` is Claude Code's own price table, not DeepSeek's billing.
- **Idle sleep.** The idle sleep (`lifecycle.idleSeconds`) was not waited for: the owner's sleep door was used. D2
  measured the idle sleep on this host's Docker.
- **Lost logs.** Alice's generations 1 and 2 kept their logs only until Docker removed their containers, so only
  generation 3's and the other runners' logs are here.
- **Restarts.** There was no Docker daemon restart or host reboot: this is a shared host. D7 did both in an
  isolated Docker host.
- **Display fix.** `steps.jsonl` has two `1-after-sign-ins` inventory records. The first was taken before a display
  fix in the driver's table (volume names were cut short), and the files here are the second.

## Re-running

```bash
export D4_DIR=/mnt/data/tmp/<task> D4_REPO=$PWD          # a checkout of the commit under test, its apiserver built
mkdir -p "$D4_DIR"/{kit,logs,records}; cp -r docs/evidence/managed-runner-docker-e2e/2026-10-21/kit/* "$D4_DIR/kit/"
bash "$D4_DIR/kit/build-images.sh" "$D4_REPO" "$D4_DIR/image"   # both images, in the capped builder
bash "$D4_DIR/kit/stack.sh" up
inst=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["instanceId"])' "$D4_DIR/mr/channel.json")
docker events --filter "label=orbit.managed-runner.instance=$inst" --format '{{json .}}' >> "$D4_DIR/records/docker-events.jsonl" &
docker events --filter type=volume --format '{{json .}}' | grep --line-buffered -E '"ID":"mr-(data|boot)-' >> "$D4_DIR/records/docker-volume-events.jsonl" &
python3 "$D4_DIR/kit/d4.py" admin; python3 "$D4_DIR/kit/d4.py" account alice; python3 "$D4_DIR/kit/d4.py" signin alice
python3 "$D4_DIR/kit/d4.py" watch alice --until STARTING:MODEL_UNAVAILABLE; python3 "$D4_DIR/kit/d4.py" key alice   # and so on, as in steps.jsonl
bash "$D4_DIR/kit/stack.sh" down; python3 "$D4_DIR/kit/lifecycle.py" "$D4_DIR/records" > "$D4_DIR/records/lifecycle.md"
```

`d4.py` and `stack.sh` default to this run's paths. The apiserver is built in `D4_REPO` first
(`scripts/worktree-overlay.sh`, then `npm run build -w @orbit/shared`, `npm run prisma:generate -w @orbit/apiserver`,
`npm run build -w @orbit/apiserver`).
