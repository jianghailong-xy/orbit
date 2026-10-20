# Two accounts' runners across the lab's two nodes: moves, second Pods, a power cut, failover and drains (2026-10-19)

Task T08x (34i56D6O5QbxCsbYrf8YO) of project 34ZteKCnYMpKY46f63Leb, the cross-node part of criterion 8. The run used the
test server's own manager, C2b's admission guard and fencing gate, and the two-node lab L1 built
([docs/managed-runner-lab.md](../../../managed-runner-lab.md), "Two nodes (L1)"). Two independent accounts, `ann` and
`bob`, each went through:

- provisioning on the first node, a first session and data on the volume;
- a normal move to the second node through sleep and wake (ann by a message, bob by a task run now);
- second Pods on its claim pinned to the other node, and Pods mixing the two accounts;
- the second node's power cut while both runners wrote there, and the runbook's failover onto the first node, run with
  the runbook's own query and commands;
- the old node's return under the out-of-service taint;
- the runbook's planned move, `kubectl drain`, to the second node and back.

The single-node parts of criterion 8 (sign-in, capacity, busy and idle, wakes, rebuilds, a controller restart, an image
rollback, an independent backup restored, the switch off) are T08's ([its evidence](../../managed-runner-acceptance/2026-10-18/README.md)).
The storage layer across nodes is T02's ([its evidence](../../managed-runner-cross-node/2026-10-19/README.md)). Times are UTC.

**What these records cannot show.**

- Both VMs are on one physical machine, with one power supply, one HDD and one failure domain. Their link is a loopback
  TCP connection between two qemu processes.
- Ceph is a single-host cluster in the first VM: one MON, one mgr and three OSDs on virtual disks of the one HDD. No OSD
  or storage host failed in this run.
- "Powered off" means the second VM's qemu was killed on the host. There was no BMC, and no partition that keeps the node
  running. Only the second node, which runs no part of the control plane, was failed.
- No model was used. The owner's DeepSeek key file (`/mnt/data/managed-runner-lab/secrets/deepseek-api-key`) did not
  exist, so fake-model.py answered as a DeepSeek-preset key ([records/006](records/006-facts-model.json)). A real model
  session is still to be run.
- Nothing here is evidence of availability across physical machines.

## Where it ran

| Part | Value |
| --- | --- |
| Lab | Both VMs as L1 left them ([records/002](records/002-facts-host.json), [003](records/003-facts-cluster.json), [004](records/004-facts-ceph.json)). Ubuntu 26.04.1, kernel 7.0.0-34-generic, k3s v1.36.5+k3s1 and containerd 2.3.4-k3s1.36 on both: server `orbit-mr-lab` (10.77.0.1; 4 vCPU, 6 GiB, allocatable 3 CPU and 2592 MiB) and agent `orbit-mr-lab-2` (10.77.0.2; 2 vCPU, 3 GiB, allocatable 1750m and 2134 MiB). Ceph 20.2.4 Tentacle: pool `orbit-mr-rbd` size 3, `min_size` 2, 32 PGs, failure domain `osd`, FSID `12b3f1b2-c9ec-11f1-80c0-525400123456`. Ceph-CSI v3.18.0 through Operator v1.1.0, its controller plugin on the first node and its node plugin on both. kubectl v1.36.5 on the host. |
| Host | HPC (`workstation`): Debian 13, kernel 6.12.107, 24 CPUs, 15357 MiB. The VMs' units `orbit-mr-lab` (`MemoryMax` 6656M, `CPUQuota` 400%) and `orbit-mr-lab-2` (3584M, 200%), both `OOMScoreAdjust` 1000, outside the runner's cgroup. No `rbd`, `nbd`, `ceph` or `libceph` module on the host. |
| The window | No other experiment, dind host or pg-spec batch ran. Another session's landing merge check (`vitest run`) ended at 14:20:26 before the boot (task comment of 14:18). Booted by `start.sh --nodes 2` at 14:20:32, healthy at 14:22:10 ([logs/00-start-both.txt](logs/00-start-both.txt)); off again at 15:01:30 ([logs/99-stop-both.txt](logs/99-stop-both.txt)). |
| StorageClass `runner-data` | `rbd.csi.ceph.com`, `imageFeatures: layering`, `mounter: rbd`, ext4, `reclaimPolicy: Retain`, `Immediate`, no expansion. CSIDriver `attachRequired: true`. Access mode `ReadWriteOnce`, `Filesystem`: the protection against a second Pod is the admission guard. |
| Test server | This checkout's apiserver, built at 14:03 from the project line's `9fb3ecdcb`, which holds `origin/main` `e7168b246` (the task's commits change only lab tooling, its tests and documents), with its own PostgreSQL, TLS front and fake model on 127.0.0.1, in `LAB_TEST_SERVER_DIR=/mnt/data/managed-runner-lab/test-server-t08x`. Its manager reached k3s through manager-lab.py's gate. Profile ([records/009](records/009-on-prepare.json)): a budget of two runners (1 CPU, 1536 MiB, 2 Pods, 2 attachments, 2 active users), 2 GiB volumes, runners at 500m/768Mi requested and 2/2Gi limited, `idleSeconds` 3600 (a runner sleeps only when asked), `maxAttempts` 5, 5 s poll, `heartbeatFreshSeconds` 120. |
| Manager identity | ServiceAccount `orbit-mr-test:orbit-mr-manager`, least privilege; `auth can-i` says no for nodes. |
| Admission | The repository's webhook template (`failurePolicy: Fail`), installed for the run and removed at its end ([records/011](records/011-on-admission.json), [032](records/032-final-teardown.json)). |
| Image | T02's build, reused: `deploy/managed-runner/image` at `8055bb568` plus the lab CA layer, `orbit-managed-runner-lab@sha256:6483cb75…`, already in both VMs' containerd under the same image ID. Nothing under `src/runner-go` or `deploy/managed-runner/image` changed since `8055bb568` ([records/005](records/005-facts-image.json)). Nothing was built or pushed. |
| Driver | [scripts/managed-runner/lab/cross-node-lab.py](../../../../scripts/managed-runner/lab/cross-node-lab.py), on takeover-lab.py's and acceptance-lab.py's helpers, in a transient unit (`MemoryMax=1G`). One record per step ([steps.jsonl](steps.jsonl), [logs/run.txt](logs/run.txt)); it stops at the first failed check. A recorder sampled the database and k3s every second ([logs/timeline.jsonl](logs/timeline.jsonl), 122 changes). |

**How the run went.**

- A first attempt ([attempt-1/](attempt-1/steps.jsonl)) stopped at `facts/ceph`, 26 s after the boot: `status.sh` had said
  healthy while the PGs were still `unknown`, and they were peering. Ceph was `HEALTH_OK` a minute later. Nothing but
  facts had run. The run started again from nothing at 14:23:30.
- It went in one pass to `drain/move` (14:48:34). There one check failed: the drain moved both runners, but
  `kubectl drain` itself waited until its 300 s timeout for a Pod of an earlier task (section 7). The check was fixed to
  judge the runners it moves (`0aa05a83a`), and the run went on from a new step (`--from-step drain/stuck`) at 14:57:28
  to its end at 14:59:54.
- 32 steps were recorded, 31 of them passed, with 412 checks. Phase times: accounts 74 s, move 65 s, second Pods 129 s,
  takeover 870 s (420 s of it the deliberate wait), rejoin 217 s, drains 434 s.

## The accounts and their volumes

| | ann | bob |
| --- | --- | --- |
| Runner | `01a1548e-0f66-719f-aa98-e3ed285e4e91` | `01a1548e-0fc4-702f-a800-04fd55cdd1b9` |
| PVC | `mr-data-01a1548e-0f66-…`, UID `22b25daa-3fa0-4432-a081-8ec8ed247208` | `mr-data-01a1548e-0fc4-…`, UID `89d67b8d-c292-4f99-a619-0d964d1df9e5` |
| PV | `pvc-22b25daa-…`, UID `5b9395ef-b79d-49c5-bd9a-c26b0c278883` | `pvc-89d67b8d-…`, UID `f2dc08d4-fe64-4e22-a47b-1ee2cf30bf56` |
| RBD image | `orbit-mr-rbd/csi-vol-1ba6c477-9ddf-44ff-b3d8-d2e2f9dc3568`, ID `47d106222c7d7`, 2 GiB, `layering` | `orbit-mr-rbd/csi-vol-d8f26c68-4384-451c-9ad9-cb493d72ac14`, ID `47d1057b82977`, 2 GiB, `layering` |
| Workspace | `01a1548e-0f68-72e3-89db-49dad07f2acb` | `01a1548e-0fc5-746d-a245-0286d8193f9c` |
| Generations | 1 on the first node, 2 on the second (the move), 3 on the first (the failover), 4 on the second (the drain), 5 on the first (the drain back) | the same |

The runner IDs, claims, PVs, volume handles, RBD images and workspaces never changed: the records check them at every
stage.

## 1. A normal move to the other node, for both

The manager names no node for a runner Pod, so the nodes were cordoned to choose
([records/012](records/012-accounts-ready.json) to [015](records/015-move-wake.json)).

| Stage | Result |
| --- | --- |
| On the first node, the second cordoned | Both signed in at 14:25:58 (201 in 54 and 49 ms). The claims at once, the admission probes, Secrets and Pods 6 s later, the runner containers 16 s after the sign-in, both READY at 14:26:36 on a fake-model key, 38 s after it. One VolumeAttachment each, to `orbit-mr-lab`; the first VM's kernel mapped ann's image as `/dev/rbd1` and bob's as `/dev/rbd2`; one RBD watcher each, `10.77.0.1`. |
| Data | Each a first session with an attachment and a file the engine committed in its worktree (`FAKE-WRITE`), answered 0.9–1.1 s after it was made. Probe p1 on each volume: 8 MiB random, 150 SQLite rows committed one by one in WAL mode with `synchronous=FULL`, a Git commit; `integrity_check` ok. |
| Sleep | Both owners' sleep answered 202 at 14:27:12; both SLEEPING by 14:27:22.6, on their kubelets' reports (`OBSERVED_STOP`). No Pod, attachment, mapping or watcher; compute released; the claims kept. |
| Wake on the other node | The first node cordoned and the second uncordoned at 14:27:26.6. A message to ann's session and a task run now for bob (14:27:26.7): both Pods made in the same second on `orbit-mr-lab-2`, runner containers 20 s later, the waking work answered after 35.7 s (ann) and 36.2 s (bob, the task's own session), both READY after 37.2 s. |
| Where | VolumeAttachments `csi-55d2fb91…` (ann) and `csi-7e13271a…` (bob) to `orbit-mr-lab-2`; the second VM's kernel mapped both images, the first VM neither; one watcher each, `10.77.0.2`. |
| The same data | The same runner, PVC, PV, handle, image and workspace each. Probe p1 the same random bytes, rows, row hash and Git commit, `integrity_check` ok. Uploads, worktrees with the engine's commits and the transcripts unchanged; every SQLite database on the volumes `ok`. ann's message and a message to bob's first session (answered 1.1 s after it was sent) each carried the earlier conversation to the engine. |

## 2. Second Pods on the other node are refused

Both runners ran on the second node, each with the repository's probe payload committing rows in its container. With
two volumes on the one HDD their first 100 rows each took about a minute. Each Pod below used a runner's claim
and was pinned to the first node by `nodeName` ([records/016](records/016-duplicate-writers.json), [017](records/017-duplicate-guard.json)):

| Attempt, for each account | Who | Answer |
| --- | --- | --- |
| Unlabelled Pod, another name | cluster admin | `NOT_THE_MANAGER` |
| Unlabelled Pod, another name | the manager's ServiceAccount | `NOT_THE_FIXED_NAME` |
| Copy of the runner's Pod, another name | the manager | `NOT_THE_FIXED_NAME` |
| The copy under the fixed name, same generation | the manager | `NOT_RESERVED` |
| The fixed name for the next generation | the manager | `NOT_THE_RESERVED_GENERATION` |
| A Job's Pod | the Job controller | `FailedCreate … NOT_THE_MANAGER`; no Pod |

| Mixing the two accounts | Who | Answer |
| --- | --- | --- |
| bob's runner Pod under his fixed name, with ann's claim in place of his | the manager | `NOT_THE_FIXED_NAME` (the one Pod of ann's volume is ann's) |
| ann's fixed name and claim, naming bob as owner and runner | the manager | `NOT_THE_OWNER` |
| One Pod on both claims | the manager | `MULTIPLE_MANAGED_CLAIMS` |

The authorized Pods kept their UIDs and ran on, their writers committing rows meanwhile (116 → 142, 145 → 163). Each
volume stayed in one place: one VolumeAttachment, to the second node, and no Pod on the first node referred to either
claim.

## 3. The second node stops with both runners on it

**Before the cut** ([records/018](records/018-takeover-prepare.json) to [020](records/020-takeover-cut.json)). T02's
finding 2 says Git work of the last seconds before a power cut can be lost, so:

- Probe p2 was written on each volume (ann's at 14:32:12, bob's at 14:35:08), each generation-2 credential saved
  (mode 0600, never printed), and each volume's state read. The last Git work on either volume was at 14:35:16.07 (the
  snapshots' `git status` and `fsck`).
- A minute later (60 s with no Git work), a last message to each session: answered at 14:36:22.83 (ann) and 14:36:22.30
  (bob). In those turns the engines and runners wrote the session transcript, `.claude/sessions/<pid>.json`, the run's
  `meta.json` and the session credential file, and no Git file.
- ann's volume was synced in her runner container (`sync -f /var/lib/orbit`, 14:36:40.90–14:36:42.48); bob's was not.

**The cut.** `stop.sh --node 2 --hard` killed the second VM's qemu at **14:36:42.510**: 86.4 s after the last Git work,
19.7 s (ann) and 20.2 s (bob) after the last answers, and 26 ms after ann's sync. On the host the unit was then
`inactive/dead`, with no qemu process, SSH and QMP refused, and no link connection.

**Heartbeat loss alone, 420 s** ([records/021](records/021-takeover-heartbeat-loss.json), 166 samples in
[records/takeover-heartbeat-loss-timeline.jsonl](records/takeover-heartbeat-loss-timeline.jsonl)). Seconds after the cut:

| s | Seen |
| --- | --- |
| ≤ 38 | Both images' RBD watcher gone (sampled every 30 s) |
| 56 | Node `Unknown`, taints `unreachable:NoSchedule` and `unreachable:NoExecute`; the Pods `Running` |
| 95 | Both owners' status `usable: false` |
| 150 | A message to each session, answered 201 and left `PENDING`; both owners' retries refused `409 MANAGED_RUNNER_TRANSITION_REFUSED` |
| 212 | Second Pods on each claim, pinned to the first node while the volumes were still attached to the dead one: the cluster admin's unlabelled Pod `NOT_THE_MANAGER`; the manager's copy under another name `NOT_THE_FIXED_NAME`, under the fixed name `NOT_RESERVED`, and the fixed name for the next generation with no receipt `NOT_THE_RESERVED_GENERATION`. Only the stale Pod referred to each claim afterwards |
| 354 | The taint manager evicted both Pods (`DeletionByTaintManager`); still `Running`, held by the stop-report finalizer |
| 0–420 | Both mappings READY at generation 2 with their Pods recorded; the VolumeAttachments stayed on the dead node; the gate saw only reads from the manager (252 connections before the contenders and 252 after; the contenders' own 6 connections as the manager in their second) |

Nothing took over, and neither mapping went `FENCING` before the taint: the behavior the coordinator decided on
2026-10-19 to keep ([the design](../../../managed-runner-design.md#single-pod-and-single-writer-protection)).

**Failover**, as [the runbook](../../../managed-runner-kubernetes-operations.md#failover) says, for both runners at once
([records/022](records/022-takeover-fence.json)):

| Time | Step |
| --- | --- |
| 14:43:46.8 | The power-off verified again on the host |
| 14:43:47–49 | **1. Identify.** The runbook's query ("Find an account's runner", run as written in the test server's PostgreSQL) listed both runners on `orbit-mr-lab-2`, READY at generation 2, with their Pods. The runbook's commands for each runner (with `R` set) showed its Pod `Terminating` on `orbit-mr-lab-2`, its claim, PV, handle, image, and its VolumeAttachment still on `orbit-mr-lab-2`; `rbd status` showed no watcher |
| 14:43:49.910 | **2 and 3.** The node fenced (powered off and kept off). Receipts as ConfigMaps `mr-fence-<runner>` with `kubectl create configmap … --from-file=receipt.json=…`: `NODE_POWER_OFF`, mechanism `HYPERVISOR`, `quarantined: true`, each naming its predecessor as its mapping recorded it |
| 14:43:49.951 | **4.** `kubectl taint node orbit-mr-lab-2 node.kubernetes.io/out-of-service=nodeshutdown:NoExecute` |
| 14:43:50.044 | bob's finalizer off at once, with the runbook's UID-tested patch, run as written |
| by 14:43:56.5 | bob's Pod object gone; ann's Pod `Failed` (PodGC under the taint; its `DisruptionTarget` the taint manager's) |
| 14:43:59.03 | Both `FENCING` `PREDECESSOR_STOP_UNPROVEN`, 9.1 s after the taint. The manager's log says why: ann's Pod "is Failed, but not by its kubelet's report", bob's "of generation 2 is gone without a stop proof" ([logs/apiserver-managed-lines.txt](logs/apiserver-managed-lines.txt)). ann's generation-2 credential refused 401 at `/runner/me`, heartbeat and claim |
| 14:43:59.49 | ann's finalizer off, with the same patch |
| 14:44:03 | Both "generation 2 retired (FENCING_RECEIPT); generation 3 reserved", each receipt recorded with its ConfigMap |
| 14:44:43.4 | Both READY at generation 3 on `orbit-mr-lab`: 480.9 s after the cut (427 s of it the deliberate wait), 43.9 s after ann's finalizer came off and 53.4 s after bob's |

- Since the receipts, the gate saw two admission probes, two Secret creates and two Pod creates: one next generation each.
- No sample had two Pods on a claim, or two VolumeAttachments of a PV.
- The new attachments went to the first node, whose kernel mapped both images; the only watchers were 10.77.0.1.

## 4. What the last 20 seconds left

The cut came 20 s after each last answer: inside the ext4 writeback window, in which data not made durable can be lost.
What the takeover found on each volume ([records/023](records/023-takeover-data.json)):

| | ann: synced 26 ms before the cut | bob: not synced |
| --- | --- | --- |
| The session's transcript | 42 lines at the cut; after the takeover the same 42 lines (the last turn's 6 kept), then the next turn's | 42 lines (741 249 bytes) at the cut; after the takeover the 36 lines written before the last message (736 992 bytes, their hash as before), then the next turn's: the last turn's 6 lines were gone |
| The conversation the next generation's engine resumed | The first session's (`annfirst`) and the last turn's (`annlast`) | The first session's (`bobfirst`), without the last turn (`boblast`) |
| `.claude/sessions/<pid>.json`, the run's `meta.json` | As before the cut | As before the cut |
| The session credential file | Changed, the same size: the next generation writes its own when it resumes a session | The same |

- Both sessions went on: the message sent while the node was down was answered by each next generation, 330 s after it
  was sent, and the engine's request carried the earlier conversation.
- Orbit's own record of bob's lost turn (its events, ingested before the cut) is on the server. Only the engine's copy on
  the volume lost it, so the next turn's model request did not see it.
- bob's other transcript (the session of his task) was as before.
- No Git file was written in the last turn, and none was damaged: every probe and worktree passed `git fsck`.

## 5. The data on the first node after the takeover

[records/023](records/023-takeover-data.json):

- **The payload writers** (`synchronous=FULL`, every acknowledgement fsynced). After SQLite's WAL recovery: ann 374 rows
  committed and 374 acknowledged, bob 374 committed and 373 acknowledged; the last read before the cut was 367 for
  each. The rows read before the cut hash as before, `integrity_check` ok, still WAL. Their ordinary file, Git commit
  and random file are unchanged.
- **Probes p1 and p2** on each volume: the same random bytes, rows, row hash and Git commit, `integrity_check` ok, `git
  fsck` clean. p2 was written on the second node 4.5 (ann) and 1.6 (bob) minutes before the cut, its Git commit more
  than 60 s before it.
- **The volumes.** Uploads, the worktrees with the engine's commits, the transcripts as of the last read before the cut,
  and the runner IDs were as before; every SQLite database said `ok`. `/var/lib/orbit` was ext4 on an RBD device, and
  `managed-instance.json` named generation 3 and its Pod.

## 6. The old node comes back

| Check | Result |
| --- | --- |
| Boot ([records/024](records/024-rejoin-start.json)) | `start.sh --nodes 2 --no-wait` at 14:44:55; the node `Ready` 34.8 s later, still tainted out of service |
| The second VM | A new boot ID; no RBD device mapped and no RBD filesystem mounted. Each old Pod's two containers listed as exited and its sandbox not ready; nothing ran. Its kubelet could not tear the old volumes down ("driver name rbd.csi.ceph.com not found in the list of registered CSI drivers"): the node plugin, evicted by the out-of-service taint, does not run there under it |
| The volumes | Each still used from the first node only: one VolumeAttachment to it, one watcher, 10.77.0.1 |
| The old credentials ([records/025](records/025-rejoin-credentials.json)) | For each account: generation 2's credential refused 401 at `/runner/me`, heartbeat and claim, whether it named its own instance or the current one; generation 3's naming generation 2 and its Pod 403 `MANAGED_RUNNER_INSTANCE_SUPERSEDED`; with no instance declaration 403 `MANAGED_RUNNER_INSTANCE_REQUIRED`; another Pod or the next generation 403 `MANAGED_RUNNER_INSTANCE_NOT_AUTHORIZED`; as itself 200, a read only |
| The writers ([records/026](records/026-rejoin-writers.json)) | Each went on from generation 3 on the first node with the old node back: ann 374 → 397 rows and bob 373 → 400 in 30 s |
| Rejoin ([records/027](records/027-rejoin-release.json)) | `kubectl taint node orbit-mr-lab-2 node.kubernetes.io/out-of-service-` at 14:47:19; the node plugin ready there 9 s later; `status.sh` healthy. Neither runner moved. The writers quiesced at 434 and 441 rows, `integrity_check` ok |

The old writers cannot write again: their node maps nothing of either volume, their Pods are gone and their
credentials are refused. Ceph's blocklist holds no entry of the second node: the fence was the power-off, not a storage
fence.

## 7. The runbook's planned move: `kubectl drain`

The runbook said a planned move is a `kubectl drain`. In the lab the first node also runs the CSI controller plugin, so
the drains named the runners' Pods only (`--pod-selector=app.kubernetes.io/name=orbit-managed-runner`)
([records/028](records/028-drain-move.json) to [030](records/030-drain-back.json)):

| Drain | Result |
| --- | --- |
| The first node, no flags | Refused: "cannot delete Pods with local storage (use --delete-emptydir-data to override)" (the runner's `/tmp` is an emptyDir). The node was cordoned and nothing evicted |
| With `--delete-emptydir-data` | Refused: "cannot delete Pods that declare no controller (use --force to override)": a runner's Pod is a bare Pod by design |
| With `--ignore-daemonsets --delete-emptydir-data --force`, 14:48:34.6 | Both runners' Pods evicted. Each runner drained and exited, the manager recorded the kubelet's report (`OBSERVED_STOP`) and took the finalizer off. The next generations' Pods were made on `orbit-mr-lab-2` 17 s after the drain began, and both were READY 45 s after it. But `kubectl drain` exited 1 after its 300 s timeout (below) |
| What held it | It had also evicted `mr-01a14db1-e2b6-…`, a Pod of task T07's test server: `Failed` since 2026-10-18 06:27 and carrying the stop-report finalizer, with no VolumeAttachment. The eviction set its `deletionTimestamp`, and only T07's manager, which does not run, takes that finalizer off. So it stays `Terminating`, and `kubectl drain` waits for every Pod it evicts to go |
| The first node again, with `--skip-wait-for-delete-timeout=60` ([records/029](records/029-drain-stuck.json)) | "node/orbit-mr-lab drained" at once, exit 0; T07's Pod passed and left as it was |
| The second node, the same flags, 14:57:43.3 ([records/030](records/030-drain-back.json)) | Both evicted; the drain finished in 10.0 s, exit 0. Pods made on `orbit-mr-lab` 13.7 s after it began, both READY after 46.2 s, on the kubelets' reports |

After each drain, for both accounts: the same runner, claim, PV, handle, image and workspace on a new Pod of the next
generation; one attachment, to the new node, one watcher; a message to the first session answered by the runner and
carrying the earlier conversation; probes p1 and p2 and the quiesced writer's rows as before, `integrity_check` ok.

## 8. At the end

[records/031](records/031-final-checks.json):

- The database and k3s agreed.
- In the recorder's timeline (122 changes) never more than one Pod referred to either claim, and never more than one
  VolumeAttachment to either PV.
- Ceph was `HEALTH_OK`.
- ann and bob were asleep (25.6 and 30.4 s after their sleep): no Pod, attachment, mapping or watcher, and the claims the
  ones made at the first provisioning.
- Since the first sign-in the gate saw 2 claim creates and 10 Pod creates, one per generation that ran (5 each).
- Memory: the host's `MemAvailable` fell to 1854 MiB while both writers and probes ran (14:35, the second VM's unit at
  1412 MiB of RAM plus 544 of swap, the first's at 2163 plus 1282). With the second VM off it was 6874 MiB.

## Findings

1. **The coordinator's decision of 2026-10-19 held for two runners on the lost node.**
   - For 420 s after the cut both mappings stayed READY. The owners read "not usable", nothing took over, no Pod was
     made, demand waited and retries were refused.
   - `FENCING` came only with the out-of-service taint: from PodGC's `Failed` for ann, from the Pod object's removal for
     bob. The old credential was refused from then on.
   - The design record now says this, with the decision's reasons.
2. **An engine transcript loses the turns of its last seconds when the node loses power.** Claude Code does not fsync
   its transcript.
   - bob's last turn, answered 20 s before the cut, came back missing from the transcript on his volume. The session
     went on from the lines written before it, without that turn.
   - ann's, synced right before the cut, was kept.
   - The engine's copy is what the next generation resumes from. Orbit's server still holds the turn's events.
   - Reported to the coordinator for T02c (Git work under a power cut), which concerns the same kind of data: making
     what must survive durable on the volume.
3. **The runbook's planned move did not work as it was written**, and the runbook now says what does:
   - `kubectl drain` of a runner's node needs `--delete-emptydir-data` and `--force`.
   - It finishes only when a manager records each evicted runner's stop. A managed Pod no running manager records
     (the switch off, another server's Pod, as here) holds it until `--timeout`. `--skip-wait-for-delete-timeout` passes
     Pods already terminating.
   - The drain here also marked T07's leftover Pod for deletion (section 7, "Left in the lab").
4. **The runbook's failover for a node with several runners.** It named the receipt and the taint without commands, and
   one runner at a time. The runbook now gives the commands run here and says:
   - a node's runners each need their own receipt and finalizer patch, under one taint;
   - the finalizer can come off right after the taint or once the mapping is `FENCING`. Both orders took over here, the
     manager fencing on the Pod's removal or on PodGC's `Failed`.

## Not established here

- A real model session: the owner's DeepSeek key file did not exist, so it is still to be run. Every answer here is
  fake-model.py's.
- Availability across physical machines; a partition that keeps the old node running; a storage fence (`STORAGE_FENCE`)
  as the receipt's method; the failure of the node that runs the k3s server and the CSI controller; an OSD or storage
  host failure (Ceph here is three OSDs on one host and one HDD).
- Two managers: one apiserver ran.
- Other Kubernetes releases' PodGC, taint manager and drain behavior: this is k3s v1.36.5's and kubectl v1.36.5's.

## Left in the lab

- The test server's state in `test-server-t08x`: ann and bob SLEEPING on their claims.
- Their claims, PVs and RBD images (`Retain`), and the receipt ConfigMaps `mr-fence-01a1548e-0f66-…` and
  `mr-fence-01a1548e-0fc4-…`, the incident's record.
- T07's Pod `mr-01a14db1-e2b6-7199-8613-d95d4616d6a7`: before the run `Failed` with the stop-report finalizer; since the
  drain at 14:48:34 also `Terminating`. It has no VolumeAttachment. T07's manager takes the finalizer off and records
  the stop when its server runs with the switch on; until then a drain of `orbit-mr-lab` waits for it unless
  `--skip-wait-for-delete-timeout` is given ([logs/90-inventory-before-stop.txt](logs/90-inventory-before-stop.txt)).
- The webhook was removed. The test server, recorder and gate were stopped, the second node was cordoned by `stop.sh`, and
  both VMs were off at 15:01:30 ([logs/99-stop-both.txt](logs/99-stop-both.txt)).
- No record holds a credential. `cross-node-lab.py secret-scan` over this directory found none: no owner token or
  password, server secret, webhook or manager token, lab admin key or runner credential (4 saved runner credentials
  looked for).

## Checks

- **The tip.** `origin/project/34ZteKCnYMpKY46f63Leb` (`9fb3ecdcb`) and `origin/main` (`e7168b246`) were both already in
  the branch, so `git merge --no-ff` of each was "Already up to date".
- **The gate.** T02's [kit/gate.sh](../../managed-runner-cross-node/2026-10-19/kit/gate.sh) ran on the tip `e355523e5`,
  one step after another, in a transient unit outside the runner's cgroup (`MemoryMax=9G`), with no other session's
  build or test running ([logs/gate-steps.txt](logs/gate-steps.txt), [logs/gate-results.txt](logs/gate-results.txt)):

| Step | Result |
| --- | --- |
| `npm run test:compose-topology` | 16 of 16 |
| `npm run prisma:generate`, `npm run build` | exit 0 |
| `npm test -w @orbit/shared` | 491 of 491 (32 files) |
| `npm test -w @orbit/apiserver` | 5320 of 5320 |
| `npm test -w @orbit/web` | 5368 of 5368 (414 files) |
| managed-runner Python, `python3 -B -m unittest discover -s scripts/managed-runner -p '*test*.py'` | 228 tests OK, among them `CrossNodeLabTest`'s four cases and fake-model.py's T08X markers |

**Not run, and why.**

- The apiserver's pg specs: no product code changed. The delivery is lab tooling under `scripts/managed-runner/lab/`,
  its offline tests, the lab page, the runbook, the design record and this evidence.
- runner-go's `go test ./...`: nothing under `src/runner-go` changed.

This section and the gate's two logs, and nothing else, were added after the gate ran.
