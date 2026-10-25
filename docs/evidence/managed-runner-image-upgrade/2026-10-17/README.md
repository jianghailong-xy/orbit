# An upgrade rebuilds the managed runner image and moves each runner to it at its next wake (2026-10-17)

Task D6 (34hTEJMR1drqjLq8TqKM3) of project 34ZteKCnYMpKY46f63Leb. The design record is
[docs/managed-runner-design.md](../../../managed-runner-design.md), "Implementation record: image upgrades"; the
operator's side is [docs/self-hosting.md](../../../self-hosting.md), "What an upgrade does".

## Where it ran

- Two isolated Docker hosts on the HPC machine, `d6-on-dind` and `d6-off-dind`: `docker:29.8.2-dind` containers, each
  with its own Docker daemon (29.8.2, Compose v5.6.0, the containerd image store) and data root under /mnt/data,
  capped at 6 GiB of memory and 8 CPUs with OOM score 1000, outside the Orbit runner's cgroup, their gateways
  published on host loopback only (127.0.0.1:16086 and 127.0.0.1:15086) ([kit/dind-up.sh](kit/dind-up.sh)). Two more,
  smaller ones ran [kit/store-experiment.sh](kit/store-experiment.sh) and were removed. All are labelled
  `orbit.test=d6-34hTEJMR1drqjLq8TqKM3`; the host's own Docker gained nothing else, and nothing here touched an Orbit
  deployment of the host or orbitd.io. No image was pushed.
- Each host's checkout is a clone of the repository at the project line's tip c16d115b3. Every upgrade below checks
  out its commit on a local branch and commits one line to `src/runner-go/main.go` there, never pushed
  ([kit/upgrade.sh](kit/upgrade.sh)), then runs `.claude/skills/upgrade/upgrade.sh` as the default path does: no
  flags, the branch not main, so no pull. A shim before the real `docker` logged every `docker` call each script
  made ([kit/docker-shim.sh](kit/docker-shim.sh)): `docker-calls-*.txt`. Plain-text logs are kept here as `.txt`,
  since the repository ignores `*.log`.
- No model: the owner's key file `/mnt/data/managed-runner-lab/secrets/deepseek-api-key` does not exist (the
  directory is empty). As in D2 and D3, an operator signed Codex in inside the runner's container with a placeholder
  key, which READY needs, and nothing here is evidence of an engine session. The work that ran through the upgrade
  was a process in the runner's container writing a timestamp every second ([kit/verify.py](kit/verify.py), `mark`).
- [kit/verify.py](kit/verify.py) drove each step through the deployment's own API and read Docker and PostgreSQL
  inside the host; [kit/sampler.py](kit/sampler.py) listed every 250 ms the containers that refer to the runner's
  volume and kept Docker's own container events beside it. A scan of every file here, the compressed ones included,
  for both deployments' secrets, the channel token, the runner credential and the account password found none.

## A new deployment: the image switch (`on/`)

| Step (UTC) | What happened |
| --- | --- |
| Fresh install (13:23:48–14:00:06) | `scripts/install-server.sh` at c16d115b3, no flags: it built the managed runner image (`sha256:efa7b75f9ac0…`, 19.5 minutes cold on this disk), applied the migrations and started all seven services healthy; "managed runners are enabled in orbit-6742fb0e" ([install.log.gz](on/install.log.gz), [config-0-after-install.txt](on/config-0-after-install.txt)). |
| First account (14:00:22–14:05:59) | `/setup`'s bootstrap: STARTING 3 s later, the runner online at 14:00:55, MODEL_UNAVAILABLE, the placeholder sign-in, READY and usable at 14:05:59. Container `mr-01a14a29-…` (`83d5ead3…`), generation 1, instance `ddb1e849…`, volume `mr-data-01a14a29-…` UID `b86fc995…`, runner `managed-c16d115b3…` ([status-transitions.jsonl](on/status-transitions.jsonl), [steps.jsonl](on/steps.jsonl)). |
| Its data (14:09:19) | 1 MiB of random bytes (sha256 `0950da1d…`) and a 1000-row SQLite database on its volume, and a writer appending the time every second. |
| `/upgrade` (14:09:46–14:27:58, 1092 s) | d051db3d8 plus the runner change (f899e5fe6): Compose built the four images (7 min), then the managed runner image, `sha256:09a872d9ce72…` (10 min: the package and `chown` steps after `ARG ORBIT_SOURCE_SHA` ran again); at 14:27:18 both files named it, nothing else in them changed and their mode stayed 0600; the other services (web recreated, the apiserver's image unchanged), then the apiserver forced (14:27:29), then the channel (14:27:51) ([upgrade-on-d6.log.gz](on/upgrade-on-d6.log.gz), [docker-calls-on-d6.log](on/docker-calls-on-d6.txt), the files before and after in [config-2-before-upgrade.txt](on/config-2-before-upgrade.txt) and [config-3-after-upgrade.txt](on/config-3-after-upgrade.txt)). |
| The switch window | The new apiserver's passes at 14:27:46 and 14:27:51 stopped at "the channel serves … image sha256:efa7…; this profile names … sha256:09a8…" and touched no mapping; the channel served `09a8…` at 14:27:53 and the manager read the runner again at 14:27:56 ([switch-window-first-upgrade.txt](on/switch-window-first-upgrade.txt)). |
| The runner through it | Docker recorded no event for its container during the upgrade. The same container, started at 14:00:23.82, same PID, kept running on `efa7…`; the mapping READY at revision 12, as before; heartbeats went on; the writer's 1232 seconds, 14:09:19–14:29:55, have no gap over 2 s; the data unchanged ([steps.jsonl](on/steps.jsonl), "right after the upgrade"). |
| The previous image | The containerd store dropped `efa7…`'s record when the tag moved: `docker image ls` no longer listed it and `docker image rm` answered "No such image", while the container ran on it ([previous-image-in-use.txt](on/previous-image-in-use.txt)). |
| Sleep (14:29:52–14:29:58) | The owner's sleep request: DRAINING; the runner exited by itself, exit 0, at 14:29:55.458; the channel removed the container at 14:29:57.766; SLEEPING at 14:29:58, generation 2 reserved, compute released, storage kept. The host's snapshots shrank from 17572 to 16443 MiB (264 to 252) with that container gone ([storage-before-sleep.txt](on/storage-before-sleep.txt), [storage-asleep.txt](on/storage-asleep.txt)). |
| Wake (14:31:14–14:31:50) | The owner's wake: generation 2's container `cc5badd2…`, made from `09a8…`, running at 14:31:15; READY at 14:31:50; the same runner ID, mapping, volume and UID; the file's hash and the 1000 rows as written (`integrity_check` ok); the runner `managed-f899e5fe6…` ([inventory-5-awake.txt](on/inventory-5-awake.txt)). |
| One container per volume | 5223 samples, 14:09:29–14:32:30: never more than one container referred to the volume ([volume-holders.tsv](on/volume-holders.tsv), Docker's events in [volume-holders.tsv.events.gz](on/volume-holders.tsv.events.gz)). |
| Re-run (14:32:46–14:33:19, 33 s) | `/upgrade` again at the same commit: the managed runner image built from cache with the same ID, "unchanged"; nothing forced; both files' times, and the runner's, apiserver's and channel's containers as before ([upgrade-on-rerun.log](on/upgrade-on-rerun.txt), [rerun-before.txt](on/rerun-before.txt), [rerun-after.txt](on/rerun-after.txt)). Compose still recreated web, as the script from before this task does on every run too (the off host's baseline below). |
| At the final code tip (14:36:21–14:50:31) | 6fcdaa8d6 plus the runner change (c6405a56a): the same sequence, 789 s, the image `sha256:8a3c127f2568…`; the new apiserver's passes at 14:49:18 and 14:49:23 stopped at the mismatch and the channel served the image at 14:49:25. Then the owner's sleep (generation 2's container exited at 14:49:45 and was removed by 14:49:50) and wake: generation 3 from `8a3c…`, READY at 14:50:31, the same runner, volume and data, the runner `managed-c6405a56a…`; 3248 samples, never two containers on the volume ([upgrade-on-final.log](on/upgrade-on-final.txt), [docker-calls-on-final.log](on/docker-calls-on-final.txt), [switch-window-final-upgrade.txt](on/switch-window-final-upgrade.txt), [volume-holders-final.tsv](on/volume-holders-final.tsv)). |
| A restart of the test host (14:54–15:05:43) | The host was stopped for the project's checks and started again. As D5 recorded, Docker reported the running container exited, the manager recorded that as its stop proof and failed the runner `POD_TERMINATED`, compute still held; the owner's retry made generation 4 from `8a3c…` on the same volume and runner, READY at 15:05:43 ([steps.jsonl](on/steps.jsonl), "after the retry"). |
| At the merged final tip (15:06:06–15:18:19) | d431d1021, which also carries D5's channel fixes, plus the runner change (438cc2ef8): 664 s, the image `sha256:8284db3f7c45…`; generation 4's container ran on through it, READY at the same revision; the new apiserver's pass at 15:17:04 stopped at the mismatch and the channel served the image at 15:17:06. Then the owner's sleep (generation 4's container removed by 15:17:39) and wake: generation 5 from `8284…`, running at 15:17:41, READY at 15:18:19, the same runner, volume and data, the runner `managed-438cc2ef8…`; 2769 samples, never two containers on the volume ([upgrade-on-last.txt](on/upgrade-on-last.txt), [docker-calls-on-last.txt](on/docker-calls-on-last.txt), [switch-window-last-upgrade.txt](on/switch-window-last-upgrade.txt), [volume-holders-last.tsv](on/volume-holders-last.tsv)). |

## A deployment without managed runners: unchanged (`off/`)

| Step (UTC) | What happened |
| --- | --- |
| Install by hand (13:26:35–13:59:22) | At c16d115b3, as README's Quick Start says to install by hand: `.env` from `.env.example` with two generated secrets and no managed runner line at all, as orbitd.io's, then `docker compose up -d --build`. Its first boot's migrations outlasted the apiserver's health check on this disk (known, D3), and [kit/off-install.sh](kit/off-install.sh) ran `up` again once it was healthy ([install.log.gz](off/install.log.gz)). |
| Baseline (14:00:33–14:01:47) | c16d115b3's own `/upgrade`, from before this task, to c16d115b3 plus the runner change: [docker-calls-off-baseline.log](off/docker-calls-off-baseline.txt); web recreated. |
| D6 (14:09:00–14:17:15) | d051db3d8's `/upgrade` to it plus the runner change: the same Docker calls, in the same order, as the baseline (the serving web image's ID aside), and the same container recreated ([docker-calls-off-d6.log](off/docker-calls-off-d6.txt), [upgrade-off-d6.log](off/upgrade-off-d6.txt)). |
| At the final code tip (14:36:14–14:38:03) | 6fcdaa8d6's `/upgrade`: again the baseline's calls. `.env` byte for byte as installed (sha256 `53deab4b…` at install, after the baseline, after D6 and after this), the entries of `data/` the same, and no file under `.env` or `data/` written since the upgrade started but Postgres's own (`find -newer`, [written-during-final-upgrade.txt](off/written-during-final-upgrade.txt)). No `data/managed-runners`, no channel, network, managed runner image, container or volume ([inventory-4-after-final.txt](off/inventory-4-after-final.txt), [config-4-after-final.txt](off/config-4-after-final.txt)). |
| At the merged final tip (15:06:00–15:07:48) | d431d1021's `/upgrade`, with D5's merge: the baseline's calls once more, `.env` `53deab4b…` as installed, the `data/` entries the same and nothing written under `.env` or `data/` but by Postgres ([docker-calls-off-last.txt](off/docker-calls-off-last.txt), [written-during-last-upgrade.txt](off/written-during-last-upgrade.txt), [inventory-6-after-last.txt](off/inventory-6-after-last.txt)). |

## What each image store does with the previous image ([store-experiment.txt](store-experiment.txt))

The same steps in a throwaway host of each store: build an image, run a container from it, build a new one under
the same tag, try to remove and prune the previous one, then remove the container and prune again.

- Containerd image store (Docker 29's default): the previous image is gone from the list as soon as the tag moves
  (no dangling record; `ancestor` filters and `docker image rm` no longer find it), while the container runs on it.
- Classic store (`containerd-snapshotter` off): it stays as `<none>`; `docker image rm` is refused while the
  container uses it and `docker image prune -f` keeps it; once the container is removed, the prune deletes it.

## Not shown here

- No engine session (no key file): the work that crossed the upgrade was a process in the container, not a turn.
- A runner that never sleeps keeps the previous image; nothing here moves every runner at once.
- Every new commit rebuilds the image's last stage, 10 minutes on this disk, with network access for its packages:
  `ARG ORBIT_SOURCE_SHA` precedes those steps in `deploy/managed-runner/image/Dockerfile`, which this task left as T03
  made it.
- The apiserver forced to restart for the profile did not stop within Compose's 10 s stop grace and was killed
  (exit 137, Docker's events at 14:27:30 and 14:27:40); its manager's leases and compare-and-set writes are what a
  killed replica resumes from.
- A restart of the host leaves every runner that was running `FAILED` until its owner's retry (D5's finding, seen
  again here when the test host was stopped for the checks).
- The two test hosts `d6-on-dind` and `d6-off-dind` are stopped, their data under /mnt/data/tmp/34hTEJMR1drqjLq8TqKM3;
  `docker start` brings them back, and they can be removed once this evidence is decided.
