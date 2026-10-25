# Wake, sleep and capacity against the lab's real k3s (2026-10-18)

This is task T06 (34ZtjTzBLwabNMA5OHjvR) of project 34ZteKCnYMpKY46f63Leb, for criterion 6. It checks, on the lab's real k3s, that a
managed runner:

- is woken by a new message, by an executable task (Run Now, and a task's run time) and by scheduled work (a wakeup the server holds);
- sleeps only when its sessions and background jobs are idle, scales to zero, and starts again with the same identity and volume;
- waits for capacity on a small budget, and recovers from a start that fails, by itself or through a retry;
- leaves background work neither waiting forever at the offline gate nor failed by the sleep;
- with the switch unset or `false`, does none of this for messages, tasks, scheduled work and retries, while a self-managed runner's
  dispatch works as before.

It also covers the coordinator's request of 2026-10-08 (task comment 34c3lI4pbo4GDWUmTdkKu): disabled accounts.

The lab is the single-machine one ([docs/managed-runner-lab.md](../../../managed-runner-lab.md)): one node and one failure domain.
Times are UTC, 2026-10-18. The apiserver logs print local time (UTC+8), so `9:56:35 AM` is 01:56:35.

**No model was used.** The owner's DeepSeek key file (`/mnt/data/managed-runner-lab/secrets/deepseek-api-key`) does not exist (task
comment 34hlRflEeGRanB84tfNEe). Every session ran on a DeepSeek-preset model key of the owner's, whose endpoint is the lab's
[fake-model.py](../../../../scripts/managed-runner/lab/fake-model.py): T05's way to READY, and the real key's code path, but not a model.
The real DeepSeek wake and continuation are left to T03, D4 and T08.

## Where it ran

| Part | Value |
| --- | --- |
| Lab | VM `orbit-mr-lab` as L0 built it (k3s v1.36.5+k3s1, Ceph 20.2.4, Ceph-CSI v3.18.0, StorageClass `runner-data`, namespace `orbit-mr-test`). Booted 00:36:32, healthy 00:38:08 ([records/00-vm-start.txt](records/00-vm-start.txt)); off at 02:34:18 after a 15 s ACPI shutdown ([records/124-vm-stop.txt](records/124-vm-stop.txt)). |
| Test server | This branch's apiserver with its own PostgreSQL, TLS front and fake model, all on 127.0.0.1 and outside the runner's cgroup, state in `LAB_TEST_SERVER_DIR=/mnt/data/managed-runner-lab/test-server-t06` (a fresh database; T02a's, T03's, T04's and T05's were not touched). Replica B (`orbit-mr-lab-api-b`, port 13720) ran on the same database and profile whenever the switch was on, so two managers shared one capacity pool. Source: the project tip `b1cd8cab3`, and from 01:06:49 the same with the reaper change below. |
| Image | T02a's lab image, still in the guest's containerd: `docker.io/library/orbit-managed-runner-lab@sha256:54441a07…aef98d` (product image of 292b2eb43 plus the lab CA). No runner or image code changed since; nothing was built, imported or pushed. |
| Manager and profile | T04's identity (ServiceAccount `orbit-mr-manager`) and T02a's lab CA and webhook token, copied by `wake-lab.py prepare` ([records/01-prepare.json](records/01-prepare.json)). API server: T04's gate on 127.0.0.1:16444. `resourceProfileId` `orbit-mr-lab-t06`. **Budget: one runner** (`500m`, `768Mi`, `1Gi` ephemeral, 1 Pod, 1 attachment, 1 active user; storage `12Gi` usable, `2Gi` headroom). Lifecycle: `idleSeconds` 60, `drainSeconds` 300, `capacityRetrySeconds` 30, `pollIntervalSeconds` 5, `heartbeatFreshSeconds` 120, `maxAttempts` 5, backoff 5–60 s, `startupDeadlineSeconds` 900. |
| Accounts | `root` (bootstrapped with the switch unset, so it has no managed runner; it holds the self-managed runner `root-selfhost`, made through the runner API), `amy`, `ben`, `carl`. Each account's default permission mode is Bypass, so fake-model.py's tool calls run unasked. |

The driver is [wake-lab.py](../../../../scripts/managed-runner/lab/wake-lab.py). It reuses T04's manager-lab.py (gate, replica, views,
`kill-runner`) and T02a's single-writer.py (admission guard, cluster access). A recorder unit wrote one line per change of any mapping,
heartbeat, managed Pod, attachment, session or pool figure ([logs/timeline.jsonl.gz](logs/timeline.jsonl.gz), 421 lines from
00:44:20; it failed at its first start on a wrong enum value, so the first sleep below comes from the managers' logs and the stop proof).
[kit/timings.py](kit/timings.py) reads every sleep and start off it ([logs/timings.json](logs/timings.json)). Exact turn times are the
database's own (`conversation_turn`, `run_event`), quoted in the records.

fake-model.py gained three triggers for this task: `FAKE-BG <s>` answers with a call of the runner's own `mcp__orbit__bg_run`
(`sleep <s>` as a job with `wakeOnExit`), `FAKE-WAKEUP <s> <word>` with `mcp__orbit__schedule_wakeup`, and `FAKE-APIERR <n> <word>` with
Claude Code's API-error sentence for an overloaded provider (529) for its first `n` requests. Each answer quotes the `T06-…` marker of the
message it answers, which is how the driver ties an answer to its demand.

No record holds a credential. [kit/secret-scan.py](kit/secret-scan.py) looked for 34 of them in all 142 files here and found none
([logs/secret-scan.txt](logs/secret-scan.txt)): every owner's password and tokens, the self-managed runner's token, the server's database,
JWT and provider secrets, the webhook token, the manager's token, the lab admin's key and every managed runner's bootstrap credential.

## The finding, and the change: a woken runner's first run was failed as `runner offline`

A woken managed runner starts claiming at once, but its runner process sends its first heartbeat only on the first tick of its
30-second ticker (`src/runner-go/runloop.go`). Until then the runner row's `last_heartbeat_at` is the beat of the instance that went to
sleep, minutes old. The reaper (`src/apiserver/src/realtime/reaper.service.ts`) calls a RUNNING session's runner offline on 90 s
without a heartbeat, so a run the woken runner had just been handed was finalized as lost.

On the project tip, a task's Run Now woke amy's sleeping runner ([records/31](records/31-amy-task1-run-now.json)):

| When | What |
| --- | --- |
| 00:56:18.0 | Run Now; the run's session is queued and its demand wakes the runner (Pod created 00:56:18.6, Running 00:56:30.6). |
| 00:56:34.721 | The new generation claims the run (`run_claimed_at`). |
| 00:56:35.433 | Replica A's reaper: `reaped session 6722a68b-… -> FAILED (runner offline)`. Not one event; the heartbeat it read was 00:50:24, from before the sleep. The first heartbeat of the new instance came at 00:56:59. |

The message wake before it had gone through only because its turn was answered within the second it was claimed. With a real model a
turn takes seconds to minutes, and both replicas sweep every 30 s, so a woken runner's first turns would have been failed routinely.

The change (`reaper.service.ts`): a claim of the run inside the 90-second window is presence, as a heartbeat is. `runnerLooksOffline`
takes the session's `run_claimed_at`, and the finalizing write carries the same clause in its WHERE (not claimed inside the window), so a
run claimed between the sweep's read and the write is not reaped either. A run claimed longer ago, on a runner silent since, is reaped as
before. [reaper-claim-presence.spec.ts](../../../../src/apiserver/src/realtime/reaper-claim-presence.spec.ts) pins it (5 cases); undone in
the compiled JS, exactly the two claim cases fail ([logs/reaper-specs-first-run.txt](logs/reaper-specs-first-run.txt) is the first green run
of all 25 reaper cases). The ten PostgreSQL specs that drive the reaper or wake and sleep (session requests, integration-job deletion,
four watch specs, project exception items, managed-runner wake, sleep and recovery) pass on it: 164 cases, no skips
([logs/pg-specs-reaper-summary.txt](logs/pg-specs-reaper-summary.txt)). The other places that read the heartbeat only display or gate a
resume, which a managed runner answers from its mapping already; only the reaper wrote FAILED.

With the change deployed (01:06:49), the same Run Now on a sleeping runner ([records/34–36](records/)): Run Now 01:07:01.2, Pod 01:07:02.5,
Running 01:07:12.1, claimed 01:07:16.2, turn delivered 01:07:17.66 and answered 01:07:18.23; READY 01:07:42.3 at the first heartbeat.
Nothing was reaped then or in any later wake: the run's only `runner offline` is the one above
([logs/apiserver-managed-lines.txt](logs/apiserver-managed-lines.txt)).

## Results on real k3s

### 1. Scale to zero, and the start after it

amy's first session (S1) was answered at 00:42:27.8, its last demand at 00:42:26.6 ([records/15–17](records/)). Untouched after that:

| When | What |
| --- | --- |
| 00:43:27 | Replica A: `idle; draining generation 1 to sleep` (60 s after the last demand, and the runner's own report 60 s idle). |
| 00:43:45 | The runner accepted at its heartbeat, was confirmed, drained and exited 0 (container `finishedAt`). |
| 00:43:48.066 | The kubelet's report recorded as the stop proof (`OBSERVED_STOP`: Pod `Succeeded`, both containers exit 0); the Pod object removed. |
| 00:43:51.063 | Replica B: `asleep; generation 1 stopped (OBSERVED_STOP), compute released, volume kept`. Generation 1 retired, its credential replaced, generation 2 reserved. The attachment of amy's PV was gone. |

The pool's compute went back to 0 and its storage share (2 GiB) stayed; S1 stayed `AWAITING_INPUT` ([records/20](records/20-amy-snapshot-asleep.json)).

Over the run there were 22 sleeps, each logged `asleep; generation N stopped (OBSERVED_STOP)`, and never a fence. From the drain request
to SLEEPING took 35–41 s, 15–25 s when the runner's next heartbeat came early. That is the wait for that heartbeat (5–29 s), then
3.6–7 s to the Pod's removal and 4–11 s for the detach ([logs/timings.json](logs/timings.json)). Every start after a sleep began on the same
PVC, PV and RBD image, under the same runner row and default workspace. amy went through generations 1 → 17, ben 1 → 8.

### 2. The three kinds of wake

Each on a sleeping runner. "Answered" is fake-model.py's answer reaching the server; READY follows the woken instance's first heartbeat,
about 30 s after its Pod runs. A woken instance claims before that (see "Observations").

| Demand | What woke it, and when | Pod created → Running | Claimed → answered | READY |
| --- | --- | --- | --- | --- |
| A new message to a parked session (S1) | turn queued 00:44:51.291 | 00:44:51.99 → 00:44:54.39 | 00:44:54.614 → 00:44:55.176 (3.9 s after the message) | 00:45:26.8 |
| An executable task, Run Now | 01:07:01.2 (after the change) | 01:07:02.5 → 01:07:12.1 | 01:07:17.658 → 01:07:18.226 (17 s) | 01:07:42.3 |
| Scheduled work: a wakeup the server held (`schedule_wakeup`, 240 s, from S3's turn) | due 01:21:30.176, delivered by the worker 01:21:32.312 | 01:21:33.9 → 01:21:39.9 | 01:21:42.706 → 01:21:43.322 (13.1 s after due) | 01:22:13.4 |
| Scheduled work: a task's run time | run time 01:25:31; the scheduler started the run 01:25:43.7 | 01:25:45.3 → 01:25:53.6 | 01:25:59.631 → 01:26:00.003 (29 s after the run time) | 01:26:26.0 |

[records/21–25](records/), [34–36](records/), [44–50](records/). The engine took up each session's conversation from the volume: S1's
model requests carried 2, then 5, then 8 messages, and amy's last turn of the run carried 32 ([records/117](records/117-amy-probe-check-final.json)).
Ben was woken the same ways later, also by a wakeup and a run time due together (01:59:41–01:59:44, one start).

### 3. No sleep while a turn or a background job runs

| Work | What happened |
| --- | --- |
| A turn held open 150 s (`FAKE-SLOW 150`, 00:46:09.2 → answered 00:48:39.5) | The runner reported `1/0/0/0` (one turn) at every heartbeat. amy stayed READY past the idle interval: no drain in 100 s of watching ([records/27](records/27-amy-no-drain-while-turn.json)). The owner's sleep at 00:47:49.6 was refused `409 MANAGED_RUNNER_BUSY`, work `ACTIVE_TURN` ([records/28](records/28-amy-owner-sleep-while-busy.json)). The drain came at 00:49:59.2, 80 s after the answer, once the runner's own count of idle seconds reached 60; SLEEPING 00:50:39.5. |
| A runner-hosted background job: the turn called `mcp__orbit__bg_run` for `sleep 180` with `wakeOnExit`; the session was `AWAITING_INPUT` from 01:11:44 | The runner reported `0/1/0/0` (one background job). No drain in 110 s ([records/40](records/40-amy-no-drain-while-bg-job.json)); the owner's sleep refused `409 MANAGED_RUNNER_BUSY`, work `BACKGROUND_WORK` ([records/41](records/41-amy-owner-sleep-while-bg-job.json)). The job ran its full time: `background_job_wake` `bgj_d8df1d37b5ac`, trigger `exit`, status `completed`, exit 0, at 01:14:42.883, and its exit woke the session (`bg-wake:` turn answered 01:14:43.227) ([records/43](records/43-amy-bg-jobs.json)). Only then: DRAINING 01:16:16.6, SLEEPING 01:16:52.0. |

Also seen by accident: my first fake model did not recognise Claude Code's tool results (it ends each request with a `system` message),
so one session called `bg_run` 1,765 times in two minutes and the runner held about 1,345 `sleep 180` jobs at once. It never offered to
sleep, and ending the session (`interrupt` with `stopBackgroundWork`, then `end`) left none running. fake-model.py now calls a tool at most
once per conversation.

### 4. Demand merging, and a message racing the drain

- **Eight demands at once** on the sleeping runner at 01:37:15.69–.72: four messages to parked sessions, two new sessions and two
  tasks' Run Now ([records/52](records/52-amy-burst.json)). One start: Pod `1cf81837` (generation 9) created 01:37:16.5, Running 01:37:21.3,
  and all eight answered by it between 01:37:29.7 and 01:37:36.8 ([records/53](records/)). The gate saw exactly one Secret create, one
  admission probe and one Pod create in that window ([records/54](records/54-amy-burst-gate.json)).
- **A message as the drain began.** The idle drain was asked at 01:38:52.772; the driver's message landed at once (demand revision 27 → 28),
  and at 01:38:53.055 the manager logged `drain to sleep called off (DEMAND); READY again`. The runner never stopped; the message was
  answered at 01:38:58.894 by the same instance, and the next idle drain, at 01:39:53, ran to SLEEPING ([records/55–56](records/)).

### 5. Starts that fail, and their retry

| Failure | What happened |
| --- | --- |
| The runner crashes while starting: the owner's `/wake` (no work to claim), then SIGKILL to `orbit run` (PID 7) in generation 11's container at 01:45:27.5, the mapping still STARTING | The kubelet reported the runner container exit 137 and the Pod `Failed` (01:45:30.7). The manager at 01:45:32: `POD_TERMINATED: Pod fd9b4f78-… of generation 11 stopped in STARTING with exit code 137, not out of memory; starting generation 12 on the same volume in 3 s (attempt 1 of 5)`. Generation 12's Pod at 01:45:40.3 (`POD_RESTARTING`, attempt 1), READY 01:46:18.3, the same PVC and RBD image, one Pod on the claim ([records/61–63](records/)). This is D7's restart rule. A first try killed nothing: the container was still in its entrypoint (`orbit-container run`) before it execs `orbit run` ([records/58–60](records/)). |
| The cluster refuses the Pod: a ResourceQuota `t06-no-pods` (`pods: 0`) in the namespace, then a message to the sleeping runner (01:47:59.4) | The Pod create was refused `403 … exceeded quota: t06-no-pods, requested: pods=1, used: pods=1, limited: pods=0`. FAILED `KUBERNETES_FORBIDDEN` at 01:48:00.07, retryable; the owner's status offered Retry and the display read "Managed runner failed" ([records/66–67](records/)). The message waited, the session `PENDING` with its turn queued. The quota removed (01:48:21.28), the owner's retry (01:48:21.41, `202`, FAILED → REQUESTED) started generation 13 on the same volume; the waiting message was answered at 01:48:46.86, READY 01:49:02.8 ([records/68–71](records/)). |

### 6. Waiting for capacity

The budget holds one runner, and the node could hold three: these waits are the pool's, not the scheduler's.

| Wait | What happened |
| --- | --- |
| A new account's provisioning: ben's first sign-in (01:49:21.03, `201` in 57 ms) while amy was READY | WAITING_CAPACITY at 01:49:21.25, `MANAGED_RUNNER_CAPACITY_UNAVAILABLE`, retry time +30 s; the manager logged `short of cpu, memory, ephemeralStorage, pods, attachments, activeUsers`. Shown as "Waiting for capacity", work accepted. Nothing was created for ben (the gate saw 3 reads), and the pool held amy's share alone ([records/72–76](records/)). amy slept at 01:50:42.546; ben was PROVISIONING in the same second (a release makes waiting intents due at once), had his PVC and Secret at 01:50:46.3 and his Pod at 01:50:46.9, and was READY on his key at 01:51:27.1: 81 s waiting ([records/78](records/78-ben-until-ready.json)). |
| A wake: a message to amy's parked session (01:51:48.71) while ben was READY | WAITING_CAPACITY 01:51:49.6, "Waiting for capacity". ben idled and slept at 01:53:05.1; amy's Pod followed at 01:53:08.7 (3.6 s later); the message was delivered 01:53:27.781 and answered 01:53:28.322. One Secret, one probe and one Pod create, all after ben's release ([records/81–84](records/)). |
| After the switch came back on (02:26:56, section 9) | ben waited 44 s for amy's slot, then ran everything that had waited. A retry due meanwhile was asked for its runner and re-armed (`demand (auto-retry) while WAITING_CAPACITY`), its attempt count unchanged. |

At no recorded moment was there more than one managed Pod, or more than one Pod reserved in the pool ([logs/timeline.jsonl.gz](logs/timeline.jsonl.gz)).

### 7. Background work: no offline give-up, no false failure

- **A retry due while asleep.** S4's provider answered "overloaded" twice ([records/51](records/51-amy-retry-arm-and-sleep.json)). The second
  failure (01:27:46.6) armed a retry for 01:29:54.6 with `retry_attempts` 1; amy idled and slept at 01:29:11.2. When the retry came due the
  manager's sweep woke her (01:29:55, `work waiting while it sleeps; waking it`), and the auto-retry sweep, finding her STARTING, asked for
  her and re-armed it for 01:30:43.6 with the attempt count still 1 (`demand (auto-retry) while STARTING`). READY 01:30:31.8; the retry was
  sent at 01:30:43.7 and answered, and the count went back to 0. ben's three-failure retry went the same way at 02:12:00 → 02:12:43.7.
  Through the switch-off phases below it was re-armed every 30 s on the ordinary offline path, then sent and answered after the switch
  came back on, 15.7 minutes after its failure: no give-up, no attempt spent while it waited.
- **Nothing failed by a sleep.** No session of a managed runner ended FAILED except the reaped run of the finding above. Sessions slept
  through as `AWAITING_INPUT`, some for over 40 minutes, far past the reaper's 90 s; the background job above ended `completed` with exit 0;
  every stop was the runner's own exit 0 after it accepted the sleep (or, for a disabled owner, after its claims were refused).
- **Scheduled work reaches a sleeping runner**: the wakeups and run times of sections 2, 8 and 9.

### 8. Disabled accounts (C6b)

| Case | What happened |
| --- | --- |
| A mapping not yet ready: carl signed in while amy held the slot (WAITING_CAPACITY 01:53:52.07), and the administrator disabled him at 01:53:52.163 | SLEEPING, desired SLEEPING, at 01:53:53.9: `its owner's account is disabled; asleep from WAITING_CAPACITY, nothing having started`. No PVC, Secret or Pod, no reservation; the gate saw 6 reads ([records/85–89](records/)). |
| A running instance: ben disabled at 02:00:04.946, his Pod having just answered a message, a delivered wakeup and a task run | `its owner's account is disabled; draining generation 3 to sleep` at 02:00:06.7, stop recorded 02:00:31.7, SLEEPING/SLEEPING 02:00:42.06, the PVC kept ([records/94–98](records/)). Again while STARTING (disabled 02:01:37.311): DRAINING 02:01:40.5, SLEEPING 02:02:16.0 ([records/99](records/99-ben-disabled-cycle.json)). The runner exited by itself, its claims refused; it never accepted a sleep. |
| Demand while disabled | Prepared before the second disable: a wakeup (due 02:04:37.0) and a task's run time (02:04:55). ben's own token was refused at once (`401`) for a message and for wake, retry and ensure. The wakeup was delivered at 02:04:39.0 and the run queued at 02:05:43.7, and both just waited: the mapping stayed SLEEPING/SLEEPING at the same revision and demand revision, and no connection reached the gate from 02:02:17 to 02:07:19. |
| Enabled again (02:07:36.92) | Replica B's sweep at 02:07:40: `work waiting while it sleeps; waking it`. Pod 02:07:41.3; the delivered wakeup's turn and the queued run were answered at 02:08:04.8 and 02:08:05.0, by the same runner row, on the same PVC, PV and RBD image, in the same default workspace ([records/100–103](records/)). Enabling alone, with no work waiting (02:01:25.65), woke nothing. |

### 9. The switch unset, and `false`

Prepared with the switch on ([records/104–105](records/)): on ben, two wakeups (due 02:18:16.5 and 02:26:20.2), two run times
(02:18:55, 02:26:55) and a retry armed for 02:17:55.4; then ben asleep (02:13:19) and amy READY with Pod `aa9d644e` (02:13:59). Both
replicas were then restarted with the switch unset (02:14:20), later `false` (02:21:0x), and finally on again (02:26:56). The baseline
before any mapping existed: the bootstrap and a self-managed dispatch with the switch unset ([records/04–07](records/)).

| Check | Unset (330 s from 02:14:32.8) | `false` (330 s from 02:21:13.2) |
| --- | --- | --- |
| Demands made | A message to ben's parked session and to amy's, a task's Run Now on ben's workspace ([records/107](records/107-off-check-unset.json)) | A message to ben's other session and to amy's, a Run Now on ben's ([records/110](records/110-off-check-false.json)) |
| Came due meanwhile | ben's retry (02:17:55), his wakeup (delivered 02:18:17.9) and run time (02:18:55) | The second wakeup (delivered 02:26:20.8) and run time (02:26:55) |
| The three mappings, the pool | unchanged | unchanged |
| Connections to the gate, apiserver sockets to the k3s API | 0, none | 0, none |
| The namespace (41 objects, UID and resource version each) | unchanged but for one status update of amy's running Pod by k3s itself (manager `k3s`, subresource `status`, 02:14:54) | unchanged |
| Owner writes (ensure, retry, wake, sleep, delete), both owners | `404 MANAGED_RUNNER_DISABLED` | `404 MANAGED_RUNNER_DISABLED` |
| ben's work | queued: the messages and Run Now as `PENDING`, the wakeups as queued turns; the retry re-armed every 30 s on the offline path, attempts unchanged; no wake | the same |
| amy's running instance | took her message as any runner would (delivered 02:14:32.909, answered 02:14:33.16); idle for minutes, never drained; the same Pod throughout | the same (answered 02:21:13.67) |
| A self-managed runner's dispatch (`root-selfhost`, runner API) | claimed ([records/108](records/108-selfhost-dispatch-unset1.json)) | claimed ([records/111](records/111-selfhost-dispatch-false1.json)) |

Both run times were held by the due-task sweep, which starts nothing for a runner whose queued sessions already fill its `maxConcurrent`
(2): ordinary scheduler behaviour, not a managed one. On again (02:26:56): the sweep found ben's queued work at once (WAITING_CAPACITY
02:26:58.9), amy drained (02:27:01.3) and slept (02:27:42.1), ben's Pod started at 02:27:43.3, and everything that had waited was
answered 02:28:08.7–02:28:13.8; the retry, which waits for READY, at 02:28:34.7; the two run-time tasks once the queue had room, started
02:28:57 and answered 02:28:58.6 and 02:28:59.8 ([records/114–116](records/)).

### 10. Identity, data and one instance per volume

- **Data on the volume.** Written by generation 1 at 00:42:4x inside amy's runner container: 8 MiB of random bytes, a Git commit and 500
  SQLite rows in WAL mode with `synchronous=full` ([records/17](records/17-amy-probe-write.json)). Read again by generation 2 after the first
  wake and by generation 16 at the end of the run: the same SHA-256, row count, row hash and Git HEAD, `git fsck` clean, `integrity_check`
  `ok`, the same runner UUID in `config.json`, `/var/lib/orbit` on `/dev/rbd1` ext4 ([records/24](records/24-amy-probe-check-after-wake1.json),
  [117](records/117-amy-probe-check-final.json)).
- **The database against k3s** at the end: no problem ([records/118](records/118-consistency.json)); each mapping's PVC bound and the
  recorded one, a sleeping mapping with no Pod and no attachment. Never more than one Pod on a volume, nor more than one managed Pod.
- **The other tasks' objects.** The 28 objects of L0, T02a, T03, T04 and T05 in the namespace kept their UIDs and resource versions
  ([records/119](records/119-foreign-check.json)). L0's smoke Pod `lab-20261017061552-b` kept running untouched.
- **Left in the lab:** amy and ben SLEEPING with their PVCs kept as retained test data, carl SLEEPING with none; no T06 Pod; the webhook
  configuration removed; the VM, test server, replica, gate and recorder off ([records/120–124](records/)). Ceph's pool `orbit-mr-rbd`: 390 MiB
  stored, 18 GiB max available, above the budget's 12 GiB ([records/122](records/122-ceph-df.txt)).

## Timings

From [logs/timings.json](logs/timings.json) (the recorder's view, up to ~1.2 s late) and the records above.

| Step | Measured |
| --- | --- |
| Last work → drain request | 60–93 s: `idleSeconds` 60 by the runner's own count, which starts at its first heartbeat after the work ended |
| Drain request → SLEEPING | 35–41 s; 15–25 s when the next heartbeat came early (n = 21 recorded) |
| A wake: demand → Pod created | under 1.2 s (no capacity wait) |
| Pod created → Running | 2.4–12 s |
| Pod running → first claim | 0.2–5 s; a turn was answered 0.5–1.5 s after its claim (fake model) |
| Demand → READY | 35–47 s, the first heartbeat ~30 s after the Pod runs; 56 s with the crash and restart; 89–126 s with a capacity wait |
| A disabled owner's running instance → SLEEPING | 37.1 and 38.7 s from the disable (DRAINING after 1.8 and 3.2 s) |
| Re-enabled with work waiting → answered | 28 s |

## How the run was read against the newer rules

- **D7 (restart after a stop with its host's report).** The crash in section 5 restarted exactly as recorded: one attempt of 5, a 3 s
  backoff, the next generation on the same volume, the attempt left at 1 once READY. No sleep was mistaken for a crash: every stop of a
  runner asked to sleep went to SLEEPING, and a disabled owner's to SLEEPING with desired SLEEPING.
- **T04 (the stop-report finalizer).** Every stop, 22 sleeps and the crash, was recorded as `OBSERVED_STOP` from the kubelet's report, and no
  mapping ever fenced.
- **T04 (an unreachable backend spends no attempt).** Not exercised: there was no outage in this run.

## Not shown here

- **A real model.** Every answer came from fake-model.py. The real DeepSeek wake and continuation wait for the key file (T03, D4, T08).
- **Several nodes.** One node and one failure domain: no cross-node attach, migration or takeover, which this task does not cover.
- **A real landing during a drain** (`drainSeconds` against a long integration job) and the operator's view of an overdue drain: no
  landing ran here. T03 measured a landing held through a runner's stop.
- **Capacity exhaustion at the scheduler or a LimitRange.** The budget stayed below the node (three runners would fit), so the scheduler
  never refused a Pod; the quota case shows the cluster refusing one.
- **The 30-minute offline give-up of a retry that is not managed.** The armed retry waited 15.7 minutes on the offline path while the switch
  was off, inside that limit.
- **Clients.** No browser or native client was driven; the display is `@orbit/shared`'s `managedRunnerDisplay` over the server's status.

## Observations for the coordinator

1. **Fixed here:** the reaper failing a woken runner's first run as `runner offline` (above).
2. **A woken instance claims before READY.** The mapping reads STARTING, and the status "starting", for the ~30 s until the instance's
   first heartbeat, while that instance is already answering turns. Auto-retry waits for READY, so a retry due during a wake waits those
   30 s more than a message does. A heartbeat at the runner's start, before its first claim (runner-go), would close both gaps; it needs a
   runner image change and was not made here.
3. **A quota refusal reads as a permissions problem.** A namespace ResourceQuota below the budget fails the start as `KUBERNETES_FORBIDDEN`,
   "The cluster refused the manager. An operator has to check its permissions" (already noted as a known limit in D7's record). The
   operator's log has the quota; the sentence could name it.
4. **A brand-new account cannot queue its first session while it waits for capacity.** ben's first session was refused
   `409 MODEL_UNAVAILABLE` during his wait, with nothing named and with his key named, because his runner had never reported its runtimes;
   the display says so (`startsNewSession` false). A runner that has run before queues its work while it waits.
5. **A reaped run of a standalone task was not run again.** The task of the finding (`autoRunWhenReady`, no prerequisites, no project) went
   back to OPEN, the reaper standing aside for the scheduler; in the ten minutes until the change was deployed nothing started it again.
