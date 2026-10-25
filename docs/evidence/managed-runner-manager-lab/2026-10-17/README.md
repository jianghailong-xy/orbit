# The managed runner manager against the lab's real k3s (2026-10-17)

Task T04 (34ZtjTuzPub96xx64Sz1X) of project 34ZteKCnYMpKY46f63Leb, criterion 4: one managed runner and one data volume
per owner, kept that way by the manager's reconciliation against a real Kubernetes API server through concurrent
provisioning, lost answers, a partial create, controller crashes and restarts, an instance left behind, an API server cut
off, a VM restart and owners acting on each other's runner; with the switch unset or `false`, no request to the cluster
at all. It also takes the two Kubernetes findings T02a left open (a deleted Pod fenced; an outage spent attempts while
STARTING) and D2's request for a Kubernetes test of the observing states. The lab is the single-machine one
([docs/managed-runner-lab.md](../../../managed-runner-lab.md)): one node, one failure domain, so nothing here crosses
nodes. Times are UTC, 2026-10-17; the apiserver logs print local time (UTC+8, so `6:01:19 AM` is 22:01:19).

## Where it ran

| Part | Value |
| --- | --- |
| Lab | VM `orbit-mr-lab` as L0 built it (Ubuntu 26.04.1, kernel 7.0.0-34-generic, k3s v1.36.5+k3s1, Ceph 20.2.4, Ceph-CSI v3.18.0, StorageClass `runner-data`, namespace `orbit-mr-test`, FSID `12b3f1b2-c9ec-11f1-80c0-525400123456`). Booted 21:23:33, healthy 21:24:57 ([records/start-1.txt](records/start-1.txt)); off again at 22:18:26 ([records/final/stop.txt](records/final/stop.txt)). |
| Test server | This branch's apiserver (commit `e50755024`, built into `src/apiserver/dist`) with its own PostgreSQL, TLS front and fake model, all on 127.0.0.1 and outside the runner's cgroup, state in `LAB_TEST_SERVER_DIR=/mnt/data/managed-runner-lab/test-server-t04` (T02a's and T03's databases untouched). Two apiserver replicas on the same database and profile: A on 13710 (unit `orbit-mr-lab-api`, behind the TLS front the Pods and the webhook use) and B on 13720 (`orbit-mr-lab-api-b`), each with its manager and worker ([records/10-replica-start.json](records/10-replica-start.json)). |
| Image | T02a's lab image, still in the guest's containerd: `docker.io/library/orbit-managed-runner-lab@sha256:54441a07…aef98d` (the product image of 292b2eb43 plus the lab CA). This task changed no runner code. Nothing was built, imported or pushed. T02a's lab CA and webhook token were copied into the T04 directory, so neither the image nor k3s's admission configuration changed (`admission install`: `k3s unchanged`, [records/09-admission-install.json](records/09-admission-install.json)). |
| Manager identity | ServiceAccount `orbit-mr-manager` from `single-writer.py identity`, now with `patch` on Pods for the stop-report finalizer: `auth can-i` yes to `patch pods`; no to `update pods`, `list pods`, `patch pods/ephemeralcontainers`, `patch pods/status` and everything T02a already refused ([records/01-prepare.json](records/01-prepare.json)). |
| Profile | T02a's with the API server `https://127.0.0.1:16444` (the gate below), `resourceProfileId` `orbit-mr-lab-t04` and `maxAttempts` 5 (backoff 5–60 s, poll 5 s, request timeout 20 s, lease 60 s, startup deadline 12 h). Budget: two runners (1 CPU, 1536Mi, 2 Pods, 2 attachments, 2 users), raised to three for the last part (§6). |
| The gate | [api-gate.py](../../../../scripts/managed-runner/lab/api-gate.py) on 127.0.0.1:16444 in front of QEMU's forward of the k3s API: the manager's only way to k3s, which copies bytes and never decrypts them. It logs one line per connection ([logs/api-gate.jsonl.gz](logs/api-gate.jsonl.gz), 4,812 connections). It can lose one create's answer after k3s has applied it; it tells requests apart by the size of their TLS record (a GET about 1,100 bytes, a PVC create 1,623, a Secret create 1,669, the admission probe 4,111, a Pod create 4,084). |
| Outages | The API forward itself taken away and put back through QEMU's monitor ([qmp.py](../../../../scripts/managed-runner/lab/qmp.py) `hostfwd-remove` / `hostfwd-add`): the manager, kubectl and everything else on the host could not reach k3s; only SSH into the guest could. |
| No model | The owner's DeepSeek key file did not exist (task comment 34hgQbf9U1B0JNDQEWOKV). To reach READY, which needs the runner's own runtime signed in, `manager-lab.py stand-in-login` wrote a stored Claude Code login onto the runner's volume: a placeholder refresh token and no access token ([records/14-stand-in-alice.json](records/14-stand-in-alice.json)). The runner then reports Claude Code signed in (runner-go's `claudeStoredSignedIn`), and its plan-usage probe makes no request: both runners logged `claude plan-usage unavailable: no oauth token (api-key auth?)` and nothing else about Claude ([records/final/runner-log-mr-01a14bc6-f4de-7328-9a3f-0d025ff3a21b.txt](records/final/runner-log-mr-01a14bc6-f4de-7328-9a3f-0d025ff3a21b.txt)). No session ran, and no model or Anthropic endpoint was called. It is a stand-in for the state machine, not engine acceptance. |

The driver is [manager-lab.py](../../../../scripts/managed-runner/lab/manager-lab.py), with T02a's single-writer.py for the
identity, the webhook and the guard probes. The longer sequences ran from [kit/](kit/). A recorder ran as its own unit for the
whole window and wrote one line per change of any mapping, Pod or attachment: [logs/timeline.jsonl](logs/timeline.jsonl),
170 lines from 21:30:43 to 22:17:00, read through the guest's own k3s while the host could not reach it. The manager's
warnings, both replicas', are [logs/manager-warnings.txt](logs/manager-warnings.txt). No record holds a credential: a scan of
every file here for the owners' tokens and passwords, the server's secrets, the webhook token, the manager's token and the
lab's admin key found none.

## The code change

`kubernetes-backend.ts` and its helpers, and one rule in the shared state machine (commit `e50755024`):

- **A deleted Pod keeps its stop report** (T02a's first finding). Every Pod the manager creates now carries its finalizer
  `orbit.dev/managed-runner-stop-report`. A Pod deleted by anyone — `kubectl delete`, the Eviction API, `kubectl drain`, a
  force delete on a node that answers — stays, ended, with its kubelet's report, until the manager has recorded that
  report. `removeInstance` then deletes it by UID and takes the finalizer off with a JSON Patch that tests the UID and the
  finalizer, and the next generation starts by itself. A terminal Pod the finalizer holds is not "being removed" to the
  manager, so the gate removes it. A Pod gone with no report (its finalizer stripped) still fences, as does one whose node
  cannot report once the control plane marks it. The Role gains `patch` on Pods, `runner-pod.yaml.example` carries the
  finalizer, and the deploy README tells an operator taking over a node that cannot report to remove it.
- **A backend that cannot be reached spends no attempt** (T02a's second finding), in any state and on both backends:
  `KubeUnreachableError` when the TLS session with the API server never came up, `DockerChannelUnreachable` with
  `connected: false`, and the manager's `unreachable` step (said as TRANSIENT, tried again after the backoff of the attempt
  it is on). A backend that was reached and answered 5xx or timed out still spends one while provisioning. The observing
  states already spent nothing (D2).

On the fake cluster ([logs/pg-recovery-1.txt](logs/pg-recovery-1.txt)), `managed-runner-recovery.pg.spec.ts` gains:

- **(8)**, on Kubernetes and on Docker: READY, DRAINING and FENCING under 5xx, timeouts and no connection, for four times
  the attempt budget, spend and write nothing, make no second instance and show the owner the same status; REQUESTED,
  STARTING and PROVISIONING spend nothing while unreachable; an answered 5xx in STARTING still spends one; each goes on
  once answered. This is the Kubernetes test D2 asked for.
- **(9)**, on Kubernetes: a delete seen ten minutes later by another replica and an eviction are restarted by themselves,
  never fencing, never two Pods on the volume; gone without a report fences; a node that cannot report fences once PodGC
  marks the Pod, and its object waits for the operator's finalizer removal.

Undoing either rule turns exactly its cases red. Without the manager's rule, (8) fails on both backends at
`REQUESTED, unreachable, pass 1: nothing spent` (attempt 2) ([logs/pg-recovery-control.txt](logs/pg-recovery-control.txt)).
Without the finalizer, (9) fails `'FENCING' !== 'BACKOFF'` right after the delete: T02a's finding on the fake cluster
([logs/pg-recovery-control2.txt](logs/pg-recovery-control2.txt)). Every other case stays green, and all 12 managed-runner
pg specs (119 cases) pass on the change ([logs/pg-all-1.txt](logs/pg-all-1.txt)). In the unit suite (5,325 tests,
[logs/unit-summary.txt](logs/unit-summary.txt)), `kube-http-transport.spec.ts` runs the real HTTPS transport against
loopback servers (TLS by pre-shared key, so no certificate): refused, reset before TLS and silent before TLS are
"unreachable", while a request that got no answer once TLS was up stays ambiguous.

## Results on real k3s

### 1. The switch unset and `false`: no request to the cluster

On a fresh database, with the switch unset ([records/05-switch-unset.json](records/05-switch-unset.json)) and then `false`
with the full profile named ([records/07-switch-false.json](records/07-switch-false.json)), and again with three mappings
and their objects in k3s, one Pod running ([records/switch-existing/](records/switch-existing/)):

- `/api/health` 200, and the admin's sign-in works.
- `GET /api/managed-runner` says `enabled: false`; the shared display makes nothing of it, so no client shows managed UI.
- `ensure`, `retry`, `wake`, `sleep` and `delete` each answer 404 `MANAGED_RUNNER_DISABLED`.
- No managed row is written (0 → 0, then 3 → 3) and no runner row is made.
- For 60 s, then 90 s, after start-up, not one connection reached the gate, and the apiserver held no socket to the gate
  or the k3s forward.
- Every object in the namespace kept its UID and resource version, the running Pod's included.
- That runner went on heartbeating (last beat 22:13:51.9), and the mappings kept their revisions.

Turned on again, the managers resumed from what was stored: the same three mappings and generations, nothing re-created,
and k3s agreeing ([records/switch-existing/consistency-on.json](records/switch-existing/consistency-on.json)).

### 2. Concurrent provisioning, two managers

Eight first sign-ins each of two new accounts, at once (all 201), then eight explicit ensures each, alternating between
the two replicas (all 202, each account's naming one runner) ([records/11-signin-alice.json](records/11-signin-alice.json),
[records/12-ensure-alice.json](records/12-ensure-alice.json), the same for bob). The result:

- One mapping, one runner row and one workspace per account.
- In k3s, one PVC, one Secret and one Pod each, the Pod with the finalizer
  ([records/13-consistency-after-race.json](records/13-consistency-after-race.json)).
- The gate saw exactly two PVC creates, two Secret creates, two admission probes and two Pod creates in that minute: no
  duplicate create was even sent.
- Both replicas took part: both logged passes over both mappings during the outages below.

Over the whole run the gate saw three PVC creates (one per mapping, ever) and thirteen Secret and Pod creates, one per
generation started.

### 3. No room: the wait, and the start when room comes

With both runners READY the pool was full. A third account's sign-in made its mapping WAITING_CAPACITY
(`short of cpu, memory, ephemeralStorage, pods, attachments, activeUsers`), shown as "Waiting for capacity", with nothing
made in k3s ([records/capacity/status-carol-waiting.json](records/capacity/status-carol-waiting.json)). When bob was put to
sleep, his Pod ended (21:56:11.5), was removed (21:56:12.1) and the mapping slept (21:56:22.6). The waiting mapping was
admitted 2.4 s later ([records/capacity/watch-sleep-admit.jsonl](records/capacity/watch-sleep-admit.jsonl)).

### 4. A create whose answer was lost, and the retry

- **The PVC.** The gate lost the answer to carol's PVC create (21:56:24.711), which k3s had applied and answered, and to
  the read-back after it. The next pass found the PVC under its name and recorded it: one PVC, its UID the recorded one,
  created 21:56:24 ([records/timeout-retry/consistency.json](records/timeout-retry/consistency.json)). That first gate
  version dropped the read-back's TLS handshake rather than its answer, so the manager took the read-back as unreachable and
  spent nothing; the gate was fixed before the next case.
- **The Pod**, alice's on a wake ([records/timeout-retry/watch-alice-wake.jsonl](records/timeout-retry/watch-alice-wake.jsonl)).
  The create (22:04:13.595) went past the admission probe, was admitted and applied (k3s answered 9,874 bytes), and its
  answer was lost; so was the read-back's, after TLS. The manager spent one attempt and said TRANSIENT, with the Pod in k3s
  and not recorded (22:04:14.2). The next pass found it under its fixed name and recorded it (22:04:19.2). READY at
  22:04:54.4, with one Pod throughout.

### 5. A partial create and both controllers crashing

The gate held the answer to bob's Secret create on a wake, and the moment it took the request, `crash-on-claim` SIGKILLed
both apiservers: claimed 22:01:19.368, killed 22:01:19.377 ([records/partial-restart/crash.json](records/partial-restart/crash.json)).

- The database said PROVISIONING, generation 4, `CREATE_SECRET` pending, while k3s had the generation-4 Secret
  (`69197081…`, created 22:01:19).
- Both controllers were started again (22:01:32–22:01:39). The next pass over the mapping came at 22:02:20, 60 s after
  the dead manager's last write: its lease (60 s) had to expire first.
- That manager found the Secret by name and adopted it: the same UID, and the runner row holding the hash of its
  credential. Generation 4's Pod followed (22:02:20), READY at 22:03:00.6, nothing created twice
  ([records/partial-restart/watch-resume.jsonl](records/partial-restart/watch-resume.jsonl),
  [records/partial-restart/secret-after.txt](records/partial-restart/secret-after.txt)).

### 6. An instance left behind while no controller ran

With both controllers stopped, bob's runner was killed (22:15:36.3). Its Pod stayed, Failed, held by the finalizer, for the
33 s until they came back ([records/residue/left-behind.txt](records/residue/left-behind.txt)). Their first passes recorded
the kubelet's report, removed that Pod by UID and started generation 6 (its Pod at 22:16:16.1), READY at 22:16:50.0
([records/residue/watch.jsonl](records/residue/watch.jsonl)). (The budget had been raised to three runners when the
switch was turned on again in §1, and the restarted pool took it up.)

Old instances otherwise: after every stop below, the old Pod object (ended, held) was removed by UID only once its stop
was recorded, and no new Pod was made while its VolumeAttachment remained. A retired generation's Secret was deleted by UID
before the next generation's was made, so the Secret's generation is the mapping's after every start. L0's and T02a's
eight managed-looking objects in the namespace, which no mapping of this database owns, were never touched (UIDs and
resource versions identical at the end, [records/final/foreign-check.json](records/final/foreign-check.json)).

### 7. D2: the API forward taken away while READY

The forward was removed for 150 s (21:39:56.4–21:42:26.4) with both runners READY; once before, by a mistake in the tool,
for about 92 s (21:37:47–21:39:19.9) ([records/d2/](records/d2/)). Both times:

- Both mappings stayed READY at revision 13, attempt 0, no lastError, no next-attempt time: before, during and after.
- The same Pods throughout, one per volume; no Pod was made.
- The owners still saw "Managed runner ready": the runners kept heartbeating, since only the manager's path to k3s was cut.
- The manager wrote only `READY, and the kubernetes backend did not answer: … Client network socket disconnected before
  secure TLS connection was established; looking again next pass`, 73 such lines from both replicas in the 150 s.
- Answered again, the next pass was READY as before.

### 8. T02a's second finding: the API forward taken away while STARTING

Carol's runner was STARTING (no runtime signed in: MODEL_UNAVAILABLE) when the forward was removed for 150 s
(21:57:27.1–21:59:57.1) ([records/t02a-starting/rows.jsonl](records/t02a-starting/rows.jsonl)):

- She stayed STARTING with attempt 0 on every pass, said as TRANSIENT; the owner saw "Preparing your managed runner" and
  "A transient infrastructure error interrupted provisioning; it is retried automatically."
- 30 lines `STARTING, and the kubernetes backend cannot be reached: …; nothing spent (attempt 0 of 5)`.
- Answered again, back to MODEL_UNAVAILABLE.

Before this change each of those passes spent an attempt: with five attempts, 5–60 s apart, she would have been FAILED
`RETRY_EXHAUSTED` about 75 s into the outage (as T02a's VM restart spent attempts 2–5 in two minutes).

### 9. D7: the runner process killed

SIGKILL to alice's `orbit run` (PID 7; tini is PID 1) at 21:48:34.958 ([records/d7-exit/](records/d7-exit/)):

| Time | What happened |
| --- | --- |
| 21:48:35.7 | The runner container ended, exit 137. |
| 21:48:37.3 | The kubelet made the Pod Failed (`Error`). |
| 21:48:39.3 | The manager recorded it (`OBSERVED_STOP`): REQUESTED, `POD_RESTARTING`, attempt 1 of 5. Logged `stopped in READY with exit code 137, not out of memory`. |
| 21:48:42.4 | The VolumeAttachment was gone, while the old Pod object, ended, was still held. |
| 21:48:44.2 | The old Pod removed by UID, generation 2 reserved. |
| 21:48:44.9 | The new Pod made. |
| 21:49:30.0 | READY. |

The same runner, PVC UID and PV; the Secret of generation 2; never two Pods on the volume.

### 10. D7: the VM restarted, as a node restart

`stop.sh` at 22:05:19.1 (off at 22:05:34.2), `start.sh` at 22:05:54.3 (healthy at 22:07:20.9), with alice READY and carol
STARTING ([records/d7-vm-restart/](records/d7-vm-restart/)).

- **The shutdown.** k3s stopped at 22:05:21, then the lab's `orbit-lab-rbd-release` stopped the containers of seven shims,
  unmounted three RBD filesystems, unmapped `rbd0` and `rbd1`, and could not unmap `rbd2` (alice's image, whose filesystem it
  had unmounted first) ([records/d7-vm-restart/guest-shutdown-journal.txt](records/d7-vm-restart/guest-shutdown-journal.txt)).
- **While it was off and booting.** The manager wrote nothing of READY alice. Carol spent nothing, attempt 0: her errors
  were refusals, resets and timeouts before TLS, all "cannot be reached".
- **After the boot, the kubelet reported the stops.** It made both old Pods Failed at 22:06:56.8, exit code 255, with no
  PodGC mark. The manager recorded those reports and started both again by itself (22:07:00–22:07:16): alice generation 5
  (attempt 1: she had been up longer than twice the longest backoff), carol generation 2 (attempt 1).
- **VolumeAttachments.** The old ones survived the reboot. They went 1.2 s (carol) and 6.2 s (alice) after their Pods were
  removed at 22:07:06.5; meanwhile the manager waited (`VOLUME_STILL_ATTACHED`) and made no Pod. The new Pods' attachments
  came within a second of their creation. Alice was READY again at 22:08:23.8.

### 11. T02a's first finding: an operator's delete, an eviction, a force delete

| | `kubectl delete pod` (bob, READY) | Eviction API (alice) | `--grace-period=0 --force` (bob) |
| --- | --- | --- | --- |
| Asked | 21:49:55.66: `deleted`; right after: Running, deletion in 240 s, finalizer on | 21:51:03.77: `201 Success`, `DisruptionTarget: EvictionByEvictionAPI` | 21:52:13.04: `force deleted`; right after: Running, finalizer on |
| The kubelet's report | Succeeded, 21:49:57.1, the object kept | Succeeded, 21:51:04.6 | Succeeded, 21:52:13.9: the object stayed, so its kubelet reported |
| Recorded | 21:50:00.2, REQUESTED, attempt 1 | 21:51:06.5, attempt 2 | 21:52:17.0, attempt 2 |
| Next generation | Pod 21:50:05.8, READY 21:50:51.3 | Pod 21:51:17.0, READY 21:52:02.1 | Pod 21:52:27.4, READY 21:53:12.9 |

([records/t02a-delete/](records/t02a-delete/), [records/t02a-evict/](records/t02a-evict/), [records/t02a-force/](records/t02a-force/)).
None of them fenced; each started the next generation on the same volume and runner, never with two Pods on it. Before
this change the delete fenced (T02a). The force delete fenced too, because the object vanished at once. The attempts
counted are the crash rule's: a runner up less than twice the longest backoff carries its count.

### 12. Gone without a report still fences; an outage while FENCING; what the clients show

Carol's Pod (STARTING, generation 2) had its finalizer stripped and was force-deleted at once (22:08:56.7): the object was
gone at 22:08:56.8, and 2.8 s later the mapping was FENCING `PREDECESSOR_STOP_UNPROVEN` (`Pod 2cf4d3a4… of generation 2 is
gone without a stop proof`), nothing started; the fence replaces the runner's credential in the same transaction, which
T02a observed at the runner door ([records/fence/](records/fence/)). Then the API forward
was removed for 60 s (22:08:59.6–22:09:59.6). The mapping stayed at revision 68, and the owner saw the same thing before,
during and after: "Waiting for an operator", "The previous runner instance is gone, and nothing proves it stopped, so no
new instance is started and the data volume is kept. It waits for proof that it stopped or for an operator's fencing
receipt.", with no Retry, no work accepted and no polling hint (`moving: false`).

What the three clients show: Web renders the shared contract's `managedRunnerDisplay`, and macOS and iOS render OrbitKit's
`ManagedRunnerDisplay`; both are tested against the same fixture (`src/shared/src/managed-runner-states.fixture.json`,
state `waiting for an operator: fencing`). So all three show that title and sentence and offer nothing, whether or not the
API answers. The outage is not visible to the owner, and not on the mapping: the manager writes no lastError while it only
looks. It is in the server log, one line a pass, both replicas (`FENCING, and the kubernetes backend did not answer: …`).

I judge that acceptable for the owner: FENCING waits for an operator either way, and nothing the owner could do changes
with the outage. For an operator, the cause is in the log only. That is left for the coordinator to judge (see "Not
established"); no code was changed for it.

### 13. One owner against another

With alice's runner READY (A) and bob's READY (B) ([records/cross-user/cross-user.json](records/cross-user/cross-user.json)):

| What B tried | Answer |
| --- | --- |
| `GET /api/managed-runner` | 200: B's own runner, not A's |
| `retry` or `sleep` at A's revision | 409 `MANAGED_RUNNER_REVISION_CONFLICT`: the owner API names no mapping, so these were B's own, at the wrong revision |
| Read, rotate the token of or delete A's runner, by its id | 404 `runner not found` |
| Read or delete A's default workspace | 404 `workspace not found` |
| B's runner credential, from B's bootstrap Secret, declaring A's generation and Pod UID, at `/runner/me` and the claim | 403 `MANAGED_RUNNER_INSTANCE_NOT_AUTHORIZED`: `Pod 90d90b21… is not the instance authorized for generation 5` |
| As the manager, a dry run of a Pod in B's fixed name and identity on A's volume | refused `NOT_THE_FIXED_NAME`: the one Pod of that volume is A's |
| As the manager, a dry run of A's fixed name and volume with B as the owner | refused `NOT_THE_OWNER` |

A's mapping (revision 73, READY, generation 5, the same Pod and PVC) was unchanged.

### 14. The database against k3s, throughout

`manager-lab.py consistency` compares every mapping with what k3s holds: the PVC and its UID, owner and runner; the PV and
its handle; the Pod under the fixed name and its UID and generation; the Secret's generation; the Pods using each volume;
and no two mappings sharing a name, UID, handle, runner or owner. It found no problem after the race, after each lost
answer, after the crash and restart, after the VM restart, with the switch off and on, and at the end
([records/final/consistency.json](records/final/consistency.json)). At no recorded moment of the timeline did a volume have
more than one Pod. The only note was carol's, FENCING with its recorded Pod gone, which is what FENCING means.

## Not established here

- Everything across nodes: a second node's attachment or Pod, migration, takeover after a node stops or is fenced. One
  node, one failure domain.
- The operator's path out of FENCING: an accepted fencing receipt, or the finalizer removal on a node that cannot report.
  On the only node a power-off stops the cluster itself. Carol's mapping was left FENCING.
- PodGC or the taint manager on a real unreachable node: after the VM restart the kubelet itself reported both stops. The
  "node cannot report" case is on the fake cluster only (case 9).
- READY with a real runtime and a real model: READY came from the stand-in login. No session ran.
- 5xx answers from a real API server: k3s's first answers after the boot were refusals and resets, and the manager was
  never answered 5xx. A reached API server answering 5xx while provisioning still spends attempts by design; that rule was
  checked on the fake cluster only.
- A transient second Pod shorter than the recorder's sampling (about 0.6 s): the admission guard is what refuses one
  (T02a), and the gate's create counts show none was asked for.
- What an operator sees of an outage while FENCING: the log only. Whether that suffices is the coordinator's call (§12).
- The startup deadline still runs through an outage while STARTING. With the lab's 12 hours it did not matter here, and
  attempts were the rule this task changed.
- The lab's shutdown could not unmap one RBD device (§10). Its filesystem had been unmounted first and the runner came
  back on it, but this run did not check that volume's data.
- Ceph itself: the manager never talks to it, so "no Ceph request" with the switch off is only what the manager's one
  route to k3s and the cluster's objects show.

## Left in the lab

The webhook configuration was removed at 22:18:10 ([records/final/admission-remove.json](records/final/admission-remove.json)).
With no test server answering it would refuse every Pod create in `orbit-mr-test`; `single-writer.py admission install`
puts it back. Kept:

- The three T04 mappings' PVCs, their PVs and RBD images, and their bootstrap Secrets. Alice and bob were put to sleep
  first, so no T04 Pod is left; carol is FENCING with no Pod.
- The manager's ServiceAccount with its Role, now with `patch` on Pods.
- k3s's AdmissionConfiguration, unchanged.
- The test server's state in `test-server-t04`.

L0's and T02a's objects were not touched. The VM, the test server, the gate, the replica and the recorder are off.

## Checks

On the landing merge `dc41def86`: this branch's commits `e50755024` (the change) and `a8f897120` (the lab tooling and this
record) with origin/main `fe7a3c49a`, whose tree is the project line's own (its promotion merge). The project line
(`2e207ce2f`) was already in the branch and had not moved. One step after another, in a transient unit outside the runner's
cgroup (`MemoryMax=9G`), with the lab VM off ([kit/gate.sh](kit/gate.sh), [logs/gate-steps.txt](logs/gate-steps.txt),
[logs/gate-results.txt](logs/gate-results.txt)):

| Step | Result |
| --- | --- |
| `npm run test:compose-topology` | 14 of 14 |
| `npm run prisma:generate`, `npm run build` | exit 0 |
| `npm test -w @orbit/shared` | 490 of 490 (32 files) |
| `npm test -w @orbit/apiserver` | 5325 of 5325 |
| `npm test -w @orbit/web` | 5371 of 5371 (414 files) |
| managed-runner Python, `python3 -B -m unittest discover -s scripts/managed-runner -p '*test*.py'` | 151 tests OK, `ApiGateTest` among them |
| every managed-runner pg spec, `scripts/run-pg-spec.sh src/apiserver/src/managed-runners/*.pg.spec.ts` | 12 specs, 119 cases, none failed or skipped: docker-backend 13, account-disabled 5, backend 7, boot 5, capacity 7, existing 3, fencing 16, manager 14, recovery 17, sign-in 12, sleep 10, wake 10 |

No Go, Swift or web code changed, so runner-go's `go test ./...` and the OrbitKit suite were not run. This section and the
gate's script and logs were added to the merge commit after the gate ran; nothing else changed.
