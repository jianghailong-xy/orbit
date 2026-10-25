# Wake and capacity follow-ups on the lab's real k3s and on real Docker (2026-10-18)

This is task T06b (34hpKqWRaAJbUXoikQ3U4) of project 34ZteKCnYMpKY46f63Leb, for criterion 6. It fixes three of the findings
T06 reported from the lab's real k3s (task comment 34hp4a5g8mLh8dAvHSOeC, items 1–3;
[T06's evidence](../../managed-runner-wake-lab/2026-10-18/README.md)), and checks each fix there:

1. **A woken instance claimed before its first heartbeat.** runner-go's first beat waited for the first tick of its 30 s
   ticker, so the mapping read STARTING, and READY came about 30 s after the instance had started serving turns; an auto
   retry, which waits for READY, waited as long. Now a managed instance beats before its first claim.
2. **A namespace ResourceQuota read as a permissions problem.** Its refusal of the Pod failed the runner
   `KUBERNETES_FORBIDDEN` ("The cluster refused the manager. An operator has to check its permissions"). Now it is
   `KUBERNETES_QUOTA_EXCEEDED`, and the runner waits for room.
3. **A brand-new account could not queue its first session while it waited for capacity.** `409 MODEL_UNAVAILABLE`, even
   naming its own key. Now that session is queued and runs once the runner is READY.

The rules are those of the shared state machine and run backends ([design record](../../../managed-runner-design.md#implementation-record-wake-and-capacity-follow-ups)).
Times are UTC, 2026-10-18; the apiserver log prints local time (UTC+8).

**No model was used.** The owner's DeepSeek key file (`/mnt/data/managed-runner-lab/secrets/deepseek-api-key`) still does
not exist (task comment 34hqXUEcFlvIkb5oAhGF0). Every lab session ran on a DeepSeek-preset model key of the owner's whose
endpoint is the lab's [fake-model.py](../../../../scripts/managed-runner/lab/fake-model.py), T05's and T06's way.

## The changes

| Finding | Change | Where |
| --- | --- | --- |
| 1 | A managed instance sends its first heartbeat before its first claim, once the engine probe has answered (at most 20 s), so the beat carries what READY reads; refused or unanswered, it is sent again every 2 s until one is taken or the first tick is due. The claim loop waits for it. A self-managed runner is unchanged: no startup beat, its claims not held back. The image built from source carries it; nothing under `deploy/managed-runner/image` changed. | `src/runner-go/managed_startup_beat.go`, `runloop.go` (`startupBeatDone`), `enginehealth.go` (`probed`) |
| 2 | A 403 whose message says `exceeded quota` is `KUBERNETES_QUOTA_EXCEEDED`, the quota's own words the operator's detail; the manager waits for room as it does at Docker's cap on containers: nothing spent, no startup deadline running, asked again every `capacityRetrySeconds`, the deadline set afresh once the create goes through. For any create: the claim, the bootstrap Secret, the Pod. The shared state fixture gains the state. | `kubernetes-backend.ts` (`failure`), `managed-runner-manager.ts` (`waitForRoom`, `roomMade`), `managed-runner-backend.ts`, `src/shared/src/managed-runner-states.fixture.json` |
| 3 | While the runner row has never stored an engine report, a first session that brings its own credential (the owner's key) on a runtime counted as supply is queued, not refused; one on a runtime's own sign-in still is. Before the runner was ever ready, the default workspace's derived default is the owner's own key that READY would record. | `managed-runner-supply.ts` (`assertManagedFirstSessionRuntime`, `managedFirstSessionKey`), `workspaces/workspace-provider.ts` |

Why a quota waits rather than fails retryable: the design names a quota among the causes of a wait for capacity
("Management and execution states"). A quota below the budget is lifted by itself when another runner's Pod goes at its
sleep, so a failure would leave the owner to press Retry at the right moment while the work waits. And Docker's cap on
containers already waits (D7, D8), and the state machine is the same on both backends.

## Where it ran

| Part | Value |
| --- | --- |
| Lab | VM `orbit-mr-lab` as L0 built it (k3s v1.36.5+k3s1, Ceph 20.2.4, Ceph-CSI v3.18.0, StorageClass `runner-data`, namespace `orbit-mr-test`). Booted 03:49, healthy 03:50:15 ([records/00](records/00-vm-start.txt)); off at 04:23:20 after a 15 s ACPI shutdown ([records/94](records/94-vm-stop.txt)). |
| Test server | This branch's apiserver (commit `ebf54ab8d`, built `dist/`) with its own PostgreSQL, TLS front and fake model on 127.0.0.1, outside the runner's cgroup; a fresh `LAB_TEST_SERVER_DIR=/mnt/data/managed-runner-lab/test-server-t06b` (T06's and the earlier tasks' databases untouched). One replica. |
| Image | Rebuilt from `ebf54ab8d`: deploy/managed-runner/image in the capped `t03-capped` builder (39 s, manifest `sha256:9844c08e…58b8`, [logs](logs/image-product-build.txt)), plus [lab-ca-image.Dockerfile](../../../../scripts/managed-runner/lab/lab-ca-image.Dockerfile) (2 s). Imported into the guest's containerd as `docker.io/library/orbit-managed-runner-lab@sha256:cdb09014…102312` ([records/01](records/01-import.json); `single-writer.py import` did the import, and its own check, which expects one digest reference of the name, found T02a's beside it). Its runner was built with `-X main.version=managed-ebf54ab8d…` ([logs](logs/image-product-build.txt)), and every Pod of the run ran that image (`imageID`, [records/27](records/27-amy-wakeB-snapshot.json)). Nothing was pushed. |
| Profile | `wake-lab.py prepare` ([records/02](records/02-prepare.json)): T04's manager identity behind T04's gate, T02a's lab CA and webhook token; **a budget of one runner** (`500m`, `768Mi`, `1Gi` ephemeral, 1 Pod, 1 attachment, 1 active user); `idleSeconds` 60, `capacityRetrySeconds` 30, `pollIntervalSeconds` 5, `heartbeatFreshSeconds` 120, `maxAttempts` 5, `startupDeadlineSeconds` 900. |
| Accounts | `root` (bootstrapped with the switch unset, no managed runner), `amy` and `ben`, each with a fake-model key (`deepseek`, `deepseek-2`). |
| Records | [kit/beats.sh](kit/beats.sh) sampled the test database every 0.5 s: each mapping's state with when it was entered, its runner's `last_heartbeat_at` as the server stamped it, and its sessions' `run_claimed_at` ([logs/beats.jsonl.gz](logs/beats.jsonl.gz)); `wake-lab.py record` the Pods as k3s reported them ([logs/timeline.jsonl.gz](logs/timeline.jsonl.gz)). [kit/timings.py](kit/timings.py) reads both ([logs/timings.json](logs/timings.json)). All three stamps are the test server's own clock. |

`wake-lab.py` gained one change for this: it accepts `test-server-t06b` beside `test-server-t06`. [kit/t06b.py](kit/t06b.py)
adds a first session naming a provider and the owner's view of the default workspace.

## 1. A managed instance's first heartbeat comes before its first claim

Every start of a generation, from [logs/timings.json](logs/timings.json). "First heartbeat" is the first stamp after STARTING
began; "first claim" the earliest `run_claimed_at` after it.

| Generation | What woke it | First heartbeat | First claim | READY | Claim − beat | READY − claim |
| --- | --- | --- | --- | --- | --- | --- |
| amy 2 | a new session while asleep ([records/20](records/20-amy-wakeA-session.json), [23](records/23-amy-wakeA-turns.json)) | 03:57:56.032 | 03:57:56.201 | 03:57:59.386 | 0.169 s | 3.185 s |
| amy 3 | a message to the parked session ([records/24–27](records/)) | 04:05:35.113 | 04:05:35.152 | 04:05:36.223 | 0.039 s | 1.071 s |
| ben 1 | his first start, after a wait for capacity (section 3) | 04:11:35.181 | 04:11:35.390 | 04:11:36.541 | 0.209 s | 1.151 s |
| amy 4 | a task's Run Now, behind a wait for capacity ([records/45–47](records/)) | 04:13:26.149 | 04:13:26.292 | 04:13:28.764 | 0.143 s | 2.472 s |
| amy 5 | a message, behind the quota's wait (section 2) | 04:17:36.755 | 04:17:36.789 | 04:17:41.812 | 0.034 s | 5.023 s |
| amy 6 | a message ([records/64–67](records/)) | 04:21:26.758 | 04:21:26.812 | 04:21:29.617 | 0.054 s | 2.805 s |

The control plane saw every instance online before it claimed anything, and READY came 1.1–5.0 s after the first claim:
the manager's next pass, at most `pollIntervalSeconds` (5 s) later, since a heartbeat does not kick the manager. T06, with
the old runner, had READY about 30 s after the first claim ("A woken instance claims before READY").

What it costs: the first beat waits for the engine probe. Generation 6's runner came online at 04:21:18.652
([records/66](records/66-amy-wakeD-runner-log.txt); its container started 04:21:17, [records/67](records/67-amy-wakeD-pod.json)) and beat 8.1 s
later, and the same 8 s showed in generation 3 (container 04:05:27, beat 04:05:35.1). A woken instance's first claim
waits for that beat, so it now comes about 8 s after the container starts, where T06 measured 0.2–5 s after the Pod ran.
A message to a sleeping runner was answered 20 s after it was sent (generation 3), against T06's 4–17 s.

amy's first start (generation 1, 03:55:49 → READY 03:56:09.985, 20.6 s from the Pod's creation,
[records/12](records/12-amy-until-ready.json)) had no work to claim; it is before the sampler began, so it is not in the table.

**A self-managed runner is unchanged.** The same runner build (`go build` of `src/runner-go` at `ebf54ab8d`), run on the
host as a self-managed runner of the test server's root account ([kit/selfhost-real.py](kit/selfhost-real.py)). It was registered through the runner
API rather than `orbit register`, which would install a service. It had a scratch `HOME`, `ORBIT_HOME` and engine
homes, `PATH=/usr/bin:/bin`, and `ORBIT_NO_SELFUPDATE` and `ORBIT_NO_ENGINE_UPDATE` set; a session was queued for it
before it started ([records/70–74](records/)):

| When | What |
| --- | --- |
| 04:19:30.651 | Registration, which stamps `lastHeartbeatAt` itself; the session queued at 04:19:30.675. |
| 04:19:49.561 | `orbit run`: "runner … online". |
| 04:19:49.653 | The session claimed (`run_claimed_at`), 0.09 s after the start: no beat waited for. It failed at once (no Claude Code on that `PATH`). |
| 04:19:54.087 | A beat: the existing re-probe after a session finds its engine signed out, which asks for a beat at once. |
| 04:20:19.569 | The first tick, 30.0 s after the start, as before. |

## 2. A namespace ResourceQuota waits for room

| When | What |
| --- | --- |
| 04:15:20.054 | ResourceQuota `t06-no-pods` (`pods: 0`) in the namespace, both runners asleep, the pool empty ([records/52–53](records/)). |
| 04:15:20.198 | A message to amy's parked session; she is admitted and starts generation 5 on her volume ([records/54](records/54-amy-quota-message.json)). |
| 04:15:20.866 | Her Pod create refused: STARTING, `KUBERNETES_QUOTA_EXCEEDED`, attempt 0, no Pod ([records/55](records/55-amy-until-quota-wait.json)). The manager's one line: `KUBERNETES_QUOTA_EXCEEDED: exceeded quota: t06-no-pods, requested: pods=1, used: pods=1, limited: pods=0; it is started once there is room` ([logs/apiserver-managed-lines.txt](logs/apiserver-managed-lines.txt)). |
| 04:15:20–04:17:21 | What the owner read: STARTING with "The cluster's resource quota for managed runners has no room for this runner, so it is not started yet. It starts by itself once there is room, as when another runner goes to sleep or an operator raises the quota.", `retryable` false, `canRetry` false, a retry time 30 s ahead ([records/56](records/56-amy-status-quota-wait.json)). Asked again every 30 s: still STARTING after 1 min 48 s, attempt 0, `startup_deadline_at` empty, the line said once, never FAILED (`until amy FAILED` timed out, [records/57–58](records/)). T06 saw `FAILED KUBERNETES_FORBIDDEN` at once. |
| 04:17:17.821 | The quota deleted ([records/59](records/59-quota-off.json)). |
| 04:17:21.778 | At the next retry, the Pod made by itself, the reason gone ([records/60](records/60-amy-until-ready-after-quota.json)); nobody asked for a retry. |
| 04:17:36.789 → 04:17:41.812 | First claim, then READY; the message answered at 04:17:37.392 ([records/61](records/61-amy-quota-answered.json)). |

The guard probe was not affected: the admission webhook refuses it before ResourceQuota runs, as in T06.

## 3. A new account queues its first session while it waits for capacity

| When | What |
| --- | --- |
| 04:06:47.7 | amy READY, given a turn fake-model holds open for 150 s, so she holds the one slot ([records/30](records/30-amy-hold-turn.json)). |
| 04:07:08.854 | ben signs in (WAITING_CAPACITY at 04:07:09.07, `MANAGED_RUNNER_CAPACITY_UNAVAILABLE`), and his key is added ([records/33–35](records/)). |
| 04:07:09 | What he reads: WAITING_CAPACITY, "The managed environment has no room for this runner right now (CPU, memory, temporary storage, runner slots, volume attachments, active managed users). It starts by itself when room frees up; nothing was removed or resized to make room." His runner row has never stored an engine report; his default workspace lists his key: `lastProvider` `deepseek-2`, `lastEngine` `claude`, `providerBuiltin` false ([records/36](records/36-ben-default-waiting.json)). |
| 04:07:18.580 | A first session on Claude Code's own sign-in: `409 MODEL_UNAVAILABLE`, as before ([records/37](records/37-ben-first-signin.json)). |
| 04:07:18.639 | His first session, nothing named: `201`, PENDING, on `deepseek-2` and Claude Code ([records/38](records/38-ben-first-nothing-named.json)). T06: 409. |
| 04:07:18.717 | One naming his key: `201`, PENDING ([records/39](records/39-ben-first-key-named.json)). T06: 409. |
| 04:11:11.5 | amy asleep (the held turn answered, then her idle interval); ben admitted at once, his claim made and bound, STARTING at 04:11:20.983. |
| 04:11:35.181 / .390 / 36.541 | His first heartbeat, first claim, READY on `deepseek-2` ([records/43](records/43-ben-default-ready.json)). |
| 04:11:37.954, 04:11:38.068 | Both queued sessions answered ([records/40–42](records/)). |

## 4. The first session on Docker, on the host's real Docker

D2's integration test ([scripts/managed-runner/docker-backend-it.py](../../../../scripts/managed-runner/docker-backend-it.py)
running [docker-backend.it.ts](../../../../src/apiserver/src/managed-runners/docker-backend.it.ts)). It is the whole apiserver of this branch in one process with a Docker profile,
D2's restricted channel holding the Docker socket, a disposable PostgreSQL, and an internal network that reaches no model.
Every container ran the product image built from `ebf54ab8d` (`orbit-managed-runner:t06b-ebf54ab8d`, `sha256:9844c08e…58b8`,
the same build as the lab's, loaded into the host's Docker, not pushed; [docker-it/image.txt](docker-it/image.txt)), whose
real runner heartbeats and claims. Its case (10), the third runner waiting for capacity, gained the first session. Everything
it made was labelled and removed afterwards ([docker-it/cleanup.txt](docker-it/cleanup.txt)).

| When | What ([docker-it/steps.jsonl](docker-it/steps.jsonl)) |
| --- | --- |
| 04:31:17.150 | carol's runner WAITING_CAPACITY, `MANAGED_RUNNER_CAPACITY_UNAVAILABLE`, with alice and bob holding both slots; nothing made for her. |
| 04:31:17.178 | carol, with a key of her own, opens her first session with nothing named: `201`, PENDING, on her key (`deepseek`) and Claude Code. Her default workspace listed that key before it. |
| 04:31:38.678 | bob asleep: a slot free. |
| 04:31:41.024 | Her real runner, in its first container, claims the session that waited; it is RUNNING (then ended by the test: the network reaches no model). |
| 04:31:41.928 | carol READY. |

All 14 tests passed, 413 s ([docker-it/it.tap.gz](docker-it/it.tap.gz)). The other cases are D2's and D7's:

- the channel's refusals, the template, a crash and its restart;
- idle sleep, released only after Docker's exit report and the removal, and a wake by a message, a task and a scheduled
  wakeup, each claimed by the woken runner of this image;
- concurrent wakes making one container;
- a "host restart", the manager stopped mid-wake, the channel down mid-wake;
- the disk limit;
- never two containers on a volume, and this process never opened the Docker socket.

## Records

[records/](records/) holds every command's answer in the order it ran (numbered), [logs/](logs/) the sampler, recorder,
fake model and manager lines, [docker-it/](docker-it/) the integration test's records, [kit/](kit/) the scripts. Four
records show slips of mine rather than of the system:
- [21](records/21-amy-wakeA-answered.json) and [22](records/22-amy-wakeA-ready.json) timed out: the marker `T06B-…` is not one fake-model.py quotes (it quotes `T06-…`), and amy had gone back to sleep. The turn itself was answered 0.8 s after its claim ([23](records/23-amy-wakeA-turns.json)).
- [32](records/32-ben-key.json): a key cannot be added before the account has signed in.
- [63](records/63-amy-gen5-runner-log.txt): that Pod had already gone.

No record holds a credential. [kit/secret-scan.py](kit/secret-scan.py) looked for 18 of them in all 97 files here and found
none ([logs/secret-scan.txt](logs/secret-scan.txt)). They were:
- every owner's password and tokens;
- the test server's database, JWT, provider and webhook secrets;
- the manager's token and the lab admin's key;
- the real self-managed runner's token;
- the integration test's channel token.

The lab's runner bootstrap credentials could not be scanned with the VM off (see below).

## Not shown here

- **A real model.** fake-model.py answered every lab session. The real DeepSeek sessions wait for the key file (T03, D4, T08).
- **The clients.** No client was driven. The shared display still offers no draft in a managed default workspace before
  `initialProvider` is known (`startsNewSession`, C7). So a new account can queue its first session through the API, the
  CLI or a task, but not from a client's composer until its runner is READY.
- **A key on an engine the runner does not have.** It is queued before the runner reports; the runner cannot become READY on
  it and ends `MODEL_UNAVAILABLE`, and the session waits.
- **Several nodes**, as for T06: one node, one failure domain.
- **The managed runners' bootstrap credentials in the secret scan**: only the lab's Secrets hold them, and the VM was off
  when the scan ran. No tool used here prints one.
