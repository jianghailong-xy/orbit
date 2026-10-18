# Managed runners recover by themselves, say why they stopped, wait for a held volume, retry a restored one (2026-10-17)

Task D7 (34hXCW6iauoWaquGQj7DO) of project 34ZteKCnYMpKY46f63Leb, criterion 12. It fixes the four manager findings
D5 left (task 34hJ7S9C3isVnzIDDfSHD, comment 34hWz8rMyOKjy5FPziROS, items 1–4;
[D5's evidence](../../managed-runner-docker-security/2026-10-17/README.md)). The design record is
[docs/managed-runner-design.md](../../../managed-runner-design.md), "Implementation record: failure recovery and
visibility"; the operator's side is [the runbook](../../../managed-runner-docker-operations.md).

## What changed

All in the state machine both run backends share (`src/apiserver/src/managed-runners/managed-runner-manager.ts`), with
two small backend additions (`exit` on an observed instance; Docker's `VOLUME_IN_USE` create refusal read as
`ManagedVolumeHeld`):

| D5 finding | Now |
| --- | --- |
| 1. A host or Docker restart leaves every running runner `FAILED POD_TERMINATED` until its owner presses Retry | A stop with the host's report is followed by the restart an owner's retry would have made: after the backoff of its attempt, the stopped instance removed by UID, the volume released, the next generation on the same volume and runner. Each stop spends one of `maxAttempts`; a crash loop still ends `FAILED`. A runner up for twice `backoffMaxSeconds` starts its count again. A stop nobody reported still fences. |
| 2. Failures are silent; OOM only in the database | One warn line per stop with the exit code and whether it ran out of memory. Owner reasons `POD_RESTARTING` / `POD_RESTARTING_OUT_OF_MEMORY` while it restarts, `POD_TERMINATED` / `POD_OUT_OF_MEMORY` once the budget is spent. |
| 3. A wake while another container refers to the volume fails at once (`DOCKER_CHANNEL_REFUSED`, `VOLUME_IN_USE`) | No instance is created on a held volume: STARTING waits (`VOLUME_IN_USE`), nothing spent, no startup deadline, and goes on by itself once it is free. |
| 4. `PVC_MISSING` has no way back | The manager looks for the recorded volume each pass; restored as recorded it becomes `PVC_RESTORED`, retryable, and the retry starts the runner on it. |

After the send-back, a start refused at D8's cap on containers waits as well ([below](#after-the-send-back-d8s-merge-and-the-container-cap)).

## Where it ran

- **`d7-dind`**, an isolated Docker host ([kit/dind-up.sh](kit/dind-up.sh)), as D5 ran one: a `docker:29.8.2-dind`
  container on the HPC machine with its own dockerd (29.8.2, Compose v5.6.0), privileged for that dockerd, capped at
  6 GiB and 8 CPUs with OOM score 1000, outside the Orbit runner's cgroup, `/run` a tmpfs as a host's is, labelled
  `orbit.test=d7-34hXCW6iauoWaquGQj7DO`, its data root and work directory under `/mnt/data/tmp/34hXCW6iauoWaquGQj7DO`,
  its deployment's gateway published on host 127.0.0.1:17086 only. Restarting it restarts its dockerd and everything
  in it, and nothing else: the HPC host and its Docker daemon were never restarted.
- In it, a default deployment from a clone of this branch: `scripts/install-server.sh` with no flags at the project
  line's tip 1f5bc9cec (17 minutes, "managed runners are enabled in orbit-5260bc6c"), then `/upgrade` as the default
  path runs it (`.claude/skills/upgrade/upgrade.sh --no-pull`, the checkout detached at the commit) to fb93b9403, the
  D7 manager and its tests ([deployment-after-upgrade.txt](dind/deployment-after-upgrade.txt): the apiserver build
  carries the new reasons, the runner image `sha256:f0600d1a…` was built from fb93b9403, the default lifecycle is 5
  attempts and a 10–300 s backoff). It took 42 minutes on a disk another task's test host was busy with. The restore
  drill ran again after a second `/upgrade` to e51574350 (below).
- Two accounts, `a` (the administrator) and `b`, each with its managed runner READY at generation 1. No model: the
  owner's key file `/mnt/data/managed-runner-lab/secrets/deepseek-api-key` does not exist (the directory is empty), so,
  as in D2–D6, an operator signed Codex in inside each runner's container with a placeholder key, which READY needs.
- [kit/drill.py](kit/drill.py) drove everything through the deployment's own API and read Docker and PostgreSQL
  inside the test host; `drill.py sample` listed every container and the data volumes it refers to about every
  0.6 s throughout ([dind/volume-samples.jsonl.gz](dind/volume-samples.jsonl.gz)), and a recorder kept Docker's own
  events ([dind/docker-events.jsonl.gz](dind/docker-events.jsonl.gz)).

## The same rules on both backends: `managed-runner-recovery.pg.spec.ts`

Each case runs twice, with the same manager, owner service and assertions: on Kubernetes (the in-memory namespace of
`test-support/fake-kube-client.ts`, the single-Pod admission guard installed) and on Docker (`DockerBackend` over
`test-support/fake-docker-channel.ts`), against a real PostgreSQL migrated from empty.

| Case | What it holds |
| --- | --- |
| (1) restart | A READY runner's instance stops with its host's report (exit 255): `BACKOFF` with the stop proof recorded, `REQUESTED`, the stopped instance kept through the backoff; one `POD_TERMINATED` warning with `exit code 255, not out of memory`; the owner's display "waking" with the restart's sentence, no Retry offered. Then, with nobody asking: READY as generation 2 on the same runner, workspace, volume UID and handle, the stopped instance removed once, the volume never made again, generation 1's credential dead, `lastRequestKey` unchanged. After every pass: never more than one instance on the volume, exactly one compute share reserved. A stop nobody reported (the instance gone) still fences. |
| (2) crash loop | Stops in READY, then twice in STARTING before the instance ever reports in: two restarts, then `FAILED POD_TERMINATED` at attempt 3 of 3, retryable, the stopped instance and its compute kept; the owner's retry starts afresh (attempt 0, generation 4). Two quick stops leave READY at attempt 2; up for twice `backoffMaxSeconds`, the next stop is attempt 1 and restarts. |
| (3) out of memory | Exit 137 with the host's OOM mark: `POD_RESTARTING_OUT_OF_MEMORY`, said through the whole restart until READY, logged `exit code 137, out of memory`; again and again: `FAILED POD_OUT_OF_MEMORY` with its own sentence. The mark on an exit 255 is not out of memory. |
| (4) asked to sleep | An instance that stops after its owner asked for sleep goes to sleep: SLEEPING, generation 2, the instance removed, compute back to 0. |
| (5) held volume | A wake while another node's attachment (Kubernetes) or another container (Docker) holds the volume: STARTING, `VOLUME_IN_USE`, no instance, attempt 0, no deadline; five passes past the startup deadline write nothing and fail nothing; one warning. Freed, it starts by itself with a deadline from then. Docker: a holder between the look and the create (the channel's `VOLUME_IN_USE`) is the same wait, the create settled. |
| (6) restored volume | A volume lost while asleep fails the wake `PVC_MISSING`, not retryable (the retry answers 409), looked at each pass with nothing written; another volume under its name stays `PVC_MISSING` with the detail saying so; restored as recorded but still held (as by the restore's own container), still `PVC_MISSING`, the detail "back as recorded, and still held", no Retry offered; free: `PVC_RESTORED`, Retry offered, no longer looked for; the retry starts the runner on the same volume UID and handle, the volume never made again. |

On the previous manager and backends (the four source files of 1f5bc9cec, everything else of this branch), all 12
cases fail ([pg-spec-control/](pg-spec-control/recovery-spec-on-the-previous-manager.txt)): (1)–(3) `FAILED` where a
restart was due; (4) `FAILED` for a runner asked to sleep; (5) Kubernetes created the Pod while another node's
attachment held the volume (READY), Docker failed `DOCKER_CHANNEL_REFUSED`; (6) the failed mapping was never looked
at again. The only compile error there is the test backend's new `exit` field, which the old interface lacks.

## On real Docker: D2's integration test, with the new expectations

`scripts/managed-runner/docker-backend-it.py --build-image` ran `src/apiserver/src/managed-runners/docker-backend.it.ts`
on the HPC host's own Docker (29.8.2), as D2 ran it: the whole apiserver in one process, the real channel as its child,
the managed runner image built from this branch at 6d52998e3 (`sha256:eacfd7e4…`, [image.txt](real-docker-it/image.txt)),
its real runner in every container, a disposable PostgreSQL, everything labelled `orbit.test=d2-it-10171655c27a`
inside a `systemd-run --scope -p MemoryMax=6G` outside the Orbit runner's cgroup. **14 of 14 passed in 1101 s**
([it.tap](real-docker-it/it.tap), [steps.jsonl](real-docker-it/steps.jsonl)). Everything it made was removed
([cleanup.txt](real-docker-it/cleanup.txt): 2 containers, 4 volumes and the network; nothing left), and so was the
image afterwards. The three cases this task changed:

| Case | Before (D2) | Now |
| --- | --- | --- |
| (1) the runner container killed (`SIGKILL`) | `FAILED POD_TERMINATED`; the owner's retry made generation 2 | Killed at 16:57:34.93 (Docker: exit 137); READY again as generation 2 on the same volume, runner and workspace by 16:58:07, with nobody asking; the retired proof says exit 137; attempt 1; the pool held 2 compute shares (this runner's and the other one's) once it was READY |
| (7) a "host restart": the runner killed mid-write, the channel killed, the manager stopped, all back | `FAILED`, then the owner's retry | Everything stopped at 17:03:44.9; READY as the next generation (7) by 17:04:17.6 by itself; SQLite `integrity_check` `ok`, the rows kept (5252), the files as they were |
| (11) a volume written past its disk limit | `FAILED POD_TERMINATED`, then the retry refused `VOLUME_OVER_LIMIT` | The channel's disk check stopped the container (exit 0 at 17:13:51); the restart that followed was refused, and the runner is `FAILED VOLUME_OVER_LIMIT` with no retry pressed and no container on the volume |

The rest (refusals, the template, sleep and wake by message, task and schedule, eight racing wakes, the manager
restarted mid-wake, the channel down mid-wake, capacity) passed unchanged, and the sampler saw at most one container
per volume ([final-inventory.json](real-docker-it/final-inventory.json)).

## In the isolated Docker host: restarts, a held volume, a restored one, out of memory

Every drill below ran at fb93b9403 ([dind/](dind/)). Nobody pressed Retry, except in the restore drill, where Retry is
what the owner is told to do. Times are UTC, 2026-10-17.

| Drill | What happened |
| --- | --- |
| Graceful restart of the test host, `docker restart -t 300 d7-dind` at 17:29:13 ([kit/restart-drill.sh](kit/restart-drill.sh) `graceful`) | a READY at generation 1 with a SQLite writer running in its container (commit, then log the committed id, fsync); b put to sleep just before. Docker: a's container exited 0, `FinishedAt` 17:29:13.60. The test host's dockerd answered 22 s later, the API 30 s later. 17:29:41, the apiserver: `POD_TERMINATED: container a7b344fa… of generation 1 stopped in READY with exit code 0, not out of memory; starting generation 2 on the same volume in 10 s (attempt 1 of 5)`; 17:29:51, `generation 1 retired (OBSERVED_STOP); generation 2 reserved`. a's owner read `POD_RESTARTING` ("The runner instance stopped, so it is being started again on the same data volume. …") in REQUESTED and STARTING. READY at generation 2 at 17:30:28, 75 s after the restart began: the same runner `01a14ade-533c…`, the same volume and volume UID `0352e340…`, `lastRequestKey` unchanged (no request of the owner's). The pool held one compute share (a's) before the restart and when a was READY again; b's came back with its wake. Every file's checksum, the repository's HEAD, `integrity_check` `ok` with the 5000 rows and the same dump digest, and the runner identity in `config.json` as before; the writer had logged 250 and the database held 251 rows. b, woken afterwards, READY on its volume with its data the same ([dind/restarts.jsonl](dind/restarts.jsonl), [dind/status-transitions.jsonl](dind/status-transitions.jsonl), [dind/data.jsonl](dind/data.jsonl), [dind/docker-reports.jsonl](dind/docker-reports.jsonl)). |
| Power cut of the test host, `docker kill d7-dind` then `docker start` at 17:41:03 (`powercut`) | a READY at generation 2 since 17:30:28, more than twice `backoffMaxSeconds` (600 s), with the writer; b asleep. Docker: exited 255, `FinishedAt` 17:41:04.31, the inner daemon's restore. dockerd 7 s, the API 22 s. 17:41:24: `… of generation 2 stopped in READY with exit code 255, not out of memory; starting generation 3 on the same volume in 8 s (attempt 1 of 5)`: attempt 1 again, the count started over. READY at generation 3 at 17:42:12, 69 s after the cut, the same identity, no request of the owner's; the writer had logged 768 and 768 rows were there; every file, the repository and SQLite as before. b woken afterwards, READY. |
| A backup holds the volume during a wake, 17:32 ([kit/held-wake.sh](kit/held-wake.sh)) | b asleep (its runner exited 0 at 17:32:30.88 and was removed at 17:32:33.08). The runbook's `scripts/managed-runner/volume-backup.sh backup` started at 17:32:35; its helper container referred to the volume from 17:32:36.06. The owner's wake at 17:32:36: STARTING with `VOLUME_IN_USE` ("Something else is using this runner's data volume, such as a backup, …") 1.6 s later, attempt 0, and one warning: `VOLUME_IN_USE: volume mr-data-01a14ade-543d… is held by a container outside this instance; nothing is started on it until it is free`. The backup finished ("archived 123 files", 1.08 GB) and its helper exited at 17:33:00.40; b's container was created at 17:33:02.56, and b was READY at generation 3 at 17:33:33 on the same volume UID, with nothing more asked of the owner than the wake ([dind/held-wake.jsonl](dind/held-wake.jsonl)). The driver's own "backup finished" mark stayed empty (its `pgrep` matched its own shell; fixed in the kit), so the end of the backup is Docker's event. |
| A volume lost while asleep, restored by the runbook, 17:35 ([kit/lost-volume.sh](kit/lost-volume.sh)) | b asleep; a backup (125 files); `docker volume rm`; the owner's wake: FAILED `PVC_MISSING` within a second, not retryable, and the owner's Retry answered 409. `volume-backup.sh restore` from 17:35:39 to 17:35:53: recreated with its labels, all 125 checksums equal, six SQLite files and the repository `ok`. **Found here:** the apiserver said `PVC_RESTORED` at 17:35:44, nine seconds before the script had finished, because the script makes the volume, labels and all, before it unpacks into it. A Retry in those seconds would have waited (`VOLUME_IN_USE`, the restore's helper held the volume), but the sentence invited it too early. Fixed in e51574350: `PVC_RESTORED` only once nothing holds the restored volume (the recovery spec's case (6) holds it); the drill ran again on that build (below). The owner's Retry after the script (202): READY at generation 4 on the same volume UID `d71b9de8…`, the same runner, every file, the repository and SQLite as before ([dind/lost-volume.jsonl](dind/lost-volume.jsonl)). |
| Out of memory, 17:43–17:45 ([kit/oom-drill.sh](kit/oom-drill.sh)) | a READY at generation 3. Its container's memory limit lowered with `docker update` (an operator's test action standing for a runner that outgrows its limit): at 24 MiB the kernel reclaimed cache and the runner went on (no kill); at 8 MiB, at 17:44:51.57, the kernel killed the runner: Docker exit 137, `OOMKilled` true. 17:44:55: `… of generation 3 stopped in READY with exit code 137, out of memory; starting generation 4 on the same volume in 20 s (attempt 2 of 5)`. The owner read `POD_RESTARTING_OUT_OF_MEMORY` ("The runner ran out of memory and stopped, so it is being started again on the same data volume. …") through STARTING; READY at generation 4 at 17:45:54, its container on the profile's own 4 GiB again, the same volume and identity, its data as before ([dind/oom.jsonl](dind/oom.jsonl)). |

### Again on the final build (e51574350)

The second `/upgrade` ([dind/upgrade-to-e51574350.txt.gz](dind/upgrade-to-e51574350.txt.gz),
[dind/deployment-after-second-upgrade.txt](dind/deployment-after-second-upgrade.txt)) put the restore fix and a runner
image built from it (`sha256:980c4679…`) in place; both runners stayed READY through it.

| Drill | What happened |
| --- | --- |
| The volume lost and restored again, 18:04 | b asleep, a backup (131 files), `docker volume rm`, the wake: FAILED `PVC_MISSING`, Retry 409. The restore now ran in the background while the driver read the owner's status and what held the volume every second: the restore's helper held it from +1.3 s; at 18:04:21 the apiserver said `PVC_MISSING: volume … is back as recorded, and still held by a container outside this instance`, and the owner was still offered no Retry; the script ended at +10.5 s (all 131 checksums equal, six SQLite files and the repository `ok`, exit 0); `PVC_RESTORED` came at 18:04:31, after it. The owner's Retry (202): READY at generation 6 on the same volume UID and runner. Between the script's two containers there was a moment with neither (the +9.4 s reading): a pass there could have said `PVC_RESTORED` before the inspection, which is why the runbook has the account disabled for a restore. |
| Graceful restart again, 18:06:42 | a READY at generation 4, up for more than ten minutes, with the writer; b asleep. Back by itself at generation 5 at 18:07:50 (68 s), attempt 1, the same identity, no request of the owner's; the writer's 978 logged rows all there; b woken afterwards. |

**One container per volume.** From 17:17:22 to 18:08:58 the sampler took 5217 samples (44 while the test host was
down): no data volume ever had more than one container referring to it, a backup's or a restore's helper included
([dind/one-container-per-volume.json](dind/one-container-per-volume.json)). Docker's lifecycle events show each runner's
containers one after another, each destroyed before the next was created, e.g. a's generation 1 destroyed at
17:29:51.645 and generation 2 created at 17:29:52.119.

The runtime code of the final tip differs from the build most drills ran on (fb93b9403) only in `volumeBack` and its
spec case: `git diff --stat fb93b9403 23595f817 -- src/` lists `managed-runner-manager.ts` and
`managed-runner-recovery.pg.spec.ts` alone.

## After the send-back: D8's merge and the container cap

The coordinator sent revision 1 back for its merge order alone. D8 (task 34hXCWEWAgHqtrxZsMBOh, tip b972c381d) had
landed on the project line first, as 7a82e65ed, and both tasks had changed the same two documents.

- **The merge.** 737f18416 merges 7a82e65ed. The two documents conflicted only where both tasks added a section in
  the same place, and both sections are kept whole. In the design record D7's "failure recovery and visibility" comes
  first, then D8's "channel and template hardening". In the runbook D7's "After `PVC_MISSING`" comes first, then D8's
  "Delete a runner's volume". `git show --remerge-diff 737f18416` shows only those two places. The code
  (`docker-backend.ts`, its spec and integration test, `fake-docker-channel.ts`) merged by itself.
- **D8's `429 CONTAINER_LIMIT` in D7's state machine.** D8's channel counts every container of its instance, in any
  state, and refuses a create past `limits.maxContainers`. The pool's budget holds its pods to the cap that `/v1/info`
  reports, and a runner gives its compute back only once its container is gone. So the manager meets the refusal only
  in two cases: the cap was lowered under running runners before the apiserver measured its pool again, or a container
  of the instance that no runner records holds a place. Until now the Docker backend took the 429 for a transient
  failure, and each one spent an attempt from the count D7's restarts spend too: a runner restarting after a crash
  was FAILED `RETRY_EXHAUSTED` after two refusals. Now it waits, as for a held volume:
  - the backend reads the refusal as `ManagedInstanceLimit`;
  - STARTING waits with `CONTAINER_LIMIT`, with no attempt spent and no startup deadline running;
  - the apiserver logs one warning when the wait begins, and the manager looks again every `capacityRetrySeconds`;
  - the startup deadline is set afresh once the instance is made.

  The design record's table describes it, and the runbook's "Runners wait though the host has room" section gives
  the operator's side. The fake channel now keeps D8's cap as the real one does, and the shared fixture gains the
  waiting state (33 in all).
- **Tests.**
  - The Docker backend's unit spec runs two runners at a cap of one. An exited container still counts, the refusal
    is a `ManagedInstanceLimit` in the channel's words, and nothing is made. Once that container is removed, the same
    create goes through.
  - `managed-runner-recovery.pg.spec.ts` case (7) runs on Docker alone, since the cap is the channel's. Two runners
    are READY, the cap is lowered to one, and one of them crashes. Its restart waits with `CONTAINER_LIMIT` at
    attempt 1, generation 2, through nine more passes past the attempt budget and the startup deadline. The wait is
    logged once, and the runner keeps its compute. When the other runner sleeps it starts by itself, its startup
    deadline counted from then, and is READY on the same runner and volume.
  - With the backend's reading of the refusal switched off ([kit/cap-control.sh](kit/cap-control.sh)), case (7)
    fails `BACKOFF → BACKOFF → FAILED` and the other 12 pass
    ([pg-spec-control/cap-wait-switched-off.txt](pg-spec-control/cap-wait-switched-off.txt)).
- **The isolated host's drills were not repeated.** They ran before D8's merge, on fb93b9403 and, for the last
  restore and restart, on e51574350, as recorded above. The runtime code that has changed since is D8's channel,
  template and budget, which came in with the merge, and the cap's wait.

## Checks

### Revision 2

The branch ends in the merge of the project line with D8 (737f18416) and the cap's wait on top of it. If origin/main
has moved by then, a `git merge --no-ff` of it follows. The evidence submission names the final tip and its
`git merge-tree --write-tree` results against origin/main and the project line, and cites these checks run on that
tip:

- the project merge check;
- the managed-runner Python tests;
- every managed runner pg spec with `tenant-isolation-runner`;
- OrbitKit's `swift test`, for the fixture's new state;
- D2's real-Docker integration test (`scripts/managed-runner/docker-backend-it.py --build-image`), whose removal and
  `/tmp` expectations D8 changed.

### Revision 1

Revision 1's branch ended in `git merge --no-ff origin/main` (991f9493c, as 78672ac6b). `git merge --no-ff
origin/project/34ZteKCnYMpKY46f63Leb` answered "Already up to date": the project line was still 1f5bc9cec, this
branch's base, and origin/main 991f9493c is main's merge of that tip with the same tree, so merging it changed no file
and `git merge-tree --write-tree` against either tip answered the branch's own tree, no conflict.

These checks ran on 23595f817, an earlier such merge of exactly that code (it lacked only this directory's last
records of revision 1, the README's last sections and three doc paragraphs) ([checks/summary.txt](checks/summary.txt));
revision 1's submission cited the same checks run again on 78672ac6b.

| Check | Result on 23595f817 |
| --- | --- |
| The project merge check: `npm run test:compose-topology && npm run prisma:generate && npm run build && npm test -w @orbit/shared && npm test -w @orbit/apiserver && npm test -w @orbit/web` | exit 0: compose topology 14/14, shared 490/490, apiserver 5316/5316, web 5371/5371 (414 files) |
| `python3 -B -m unittest discover -s scripts/managed-runner -p '*test*.py'` | 132 tests, OK |
| `scripts/run-pg-spec.sh` with every managed runner pg spec and `tenant-isolation-runner` | "OK: 13 spec(s) witnessed against PostgreSQL 16.15, no skips": recovery 13, docker-backend 13, account-disabled 5, backend 7, boot 5, capacity 7, existing 3, fencing 16, manager 14, sign-in 12, sleep 10, wake 10, tenant-isolation-runner 725 |
| OrbitKit `swift test` in `swift:6.1` (the shared fixture's new states) | 3870 tests, 5 skipped (the Linux perf baselines), 0 failures |

## Not shown here

- **Kubernetes on a real cluster.** The Kubernetes half of every rule ran against the fake cluster only. Whether a real
  node's reboot leaves the kubelet's report of the Pod's stop (a restart) or a Pod that PodGC made terminal (a fence,
  as before), and the real VolumeAttachment timings of a restart, are for the real-environment tasks (T04, T06).
- **A real engine session.** The owner's DeepSeek key file was not there; READY came from a placeholder Codex sign-in.
- **A real power loss.** The power cut killed the test host's Docker while the HPC host's kernel and page cache stayed
  up, as in D5. The runbook's steps after a real one (hold the runners back, verify the volumes) were not run against
  a real one.
- **Running out of memory by itself.** The drill's OOM kill came from lowering a running container's limit with
  `docker update`; no runner outgrew its limit. Docker keeps a container's OOM mark once any process in it was killed
  for memory, so a runner SIGKILLed (137) for another reason after a session process was OOM-killed would be reported
  as out of memory.
- **A crash loop on real Docker.** The budget running out (`FAILED POD_TERMINATED`/`POD_OUT_OF_MEMORY`) is shown by
  the pg spec on both backends, not on real Docker.
- **An administrator's retry for another account**, D5's other proposal, was not added: a restart needs no retry now,
  and a spent budget or a restored volume is still the owner's Retry.
- D5's other findings (5–8: the storage budget's disk in Compose, the host's services, the channel's caps, `/tmp`
  `noexec`) are not this task's. D8 took up 5, 7 and 8, and its work is merged here; 6 waits for the owner.
- **The container cap on real Docker.** No runner met the real channel's cap, either in the integration test or in
  the isolated host. The wait is shown against the fake channel, which now counts containers as the real one does.
- **A Kubernetes quota.** A namespace quota on Pods below the budget still fails the runner (`KUBERNETES_FORBIDDEN`),
  as before: Kubernetes has no counterpart of the channel's cap in this backend.
- `d7-dind` is stopped, with its data in `/mnt/data/tmp/34hXCW6iauoWaquGQj7DO`; it is to be deleted once this evidence
  is judged. The real-Docker IT's resources and image were removed. Nothing of an existing deployment and no other
  container was touched, and the HPC host and its Docker daemon were never restarted.

Account passwords stayed in a 0600 file outside these files. Before committing, every file here, the compressed ones
included, was scanned for the test deployment's `.env` secrets, the channel tokens of both runs, the runner
credentials and the account passwords: none is here, and nothing JWT-shaped. The kit holds only its placeholder key.
