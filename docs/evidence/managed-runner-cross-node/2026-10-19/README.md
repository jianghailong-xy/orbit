# One runner across the lab's two nodes: a move, second Pods, a hard stop and failover (2026-10-19)

Task T02 (34ZtjTqbRV2J7OFLVheO3) of project 34ZteKCnYMpKY46f63Leb, the cross-node part of criterion 2. The run used
the test server's own manager, C2b's admission guard and fencing gate, and the two-node lab L1 built
([docs/managed-runner-lab.md](../../../managed-runner-lab.md), "Two nodes (L1)"). It covered:

- an account's runner moved from the first node to the second through sleep and wake;
- Pods on its claim pinned to the other node while it ran;
- the second node's power cut while the runner wrote there;
- the runbook's failover onto the first node;
- the old node's return.

The same-node part is T02a's ([its evidence](../../managed-runner-single-writer-lab/2026-10-17/README.md)). Times are UTC.

**What these records cannot show.**
- Both VMs are on one physical machine, with one power supply, one HDD and one failure domain.
- Their link is a loopback TCP connection between two qemu processes.
- Ceph is a single-host cluster in the first VM: three OSDs on one disk.
- "Powered off" means the second VM's qemu was killed on the host. There was no BMC, and no partition that keeps the node
  running.
- Nothing here is evidence of availability across physical machines.
- No model was used. fake-model.py answered as a DeepSeek-preset key.

## Where it ran

| Part | Value |
| --- | --- |
| Lab | Both VMs as L1 left them. Ubuntu 26.04.1, kernel 7.0.0-34-generic, k3s v1.36.5+k3s1 and containerd 2.3.4-k3s1.36 on both (server `orbit-mr-lab` 10.77.0.1, agent `orbit-mr-lab-2` 10.77.0.2). Ceph 20.2.4 Tentacle in the first VM: 3 OSDs, pool `orbit-mr-rbd` size 3, `min_size` 2, 32 PGs, `replicated_rule` (failure domain `osd`), FSID `12b3f1b2-c9ec-11f1-80c0-525400123456`. Ceph-CSI v3.18.0 through Operator v1.1.0: controller plugin on the first node, node plugin on both. Booted by `start.sh --nodes 2` at 12:25:29, healthy at 12:27:07 ([logs/00-start-both.log](logs/00-start-both.log)), off again at 13:12:44 ([logs/99-stop-both.log](logs/99-stop-both.log)). |
| Before the boot | No pg-spec batch, dind host or other experiment ran on HPC: other sessions' pg-spec batches (a full matrix, two `projects/*` batches) were waited out first (task comment of 12:04). An idle Cursor e2e stack of another session (about 0.5 GiB) stayed up. |
| StorageClass `runner-data` | `rbd.csi.ceph.com`, `imageFeatures: layering`, `mounter: rbd`, `tryOtherMounters: false`, ext4, `reclaimPolicy: Retain`, `Immediate`, no expansion, the CSI Secret for provisioning, publish, expansion and staging. CSIDriver `attachRequired: true`, `fsGroupPolicy: File` ([records/003](records/003-facts-cluster.json)). |
| Access mode | `ReadWriteOnce`, `Filesystem`. The protection against a second Pod is the admission guard; RWO's own behaviour is below. |
| Test server | This checkout's apiserver (built from `8055bb568`; the task's later commits change only lab tooling, its tests and documents) with its own PostgreSQL, TLS front and fake model, on 127.0.0.1, outside the runner's cgroup, in `LAB_TEST_SERVER_DIR=/mnt/data/managed-runner-lab/test-server-t02`. Its manager reached k3s through manager-lab.py's gate, which logs each connection's TLS record sizes. `ORBIT_MANAGED_RUNNERS_ENABLED=true` with the profile of [records/008](records/008-on-prepare.json): a budget of two runners, 2 GiB volumes, runners at 500m/768Mi requested and 2/2Gi limited, `idleSeconds` 3600 (a runner sleeps only when asked), `maxAttempts` 5, 5 s poll, `heartbeatFreshSeconds` 120. |
| Manager identity | ServiceAccount `orbit-mr-test:orbit-mr-manager`: get/create/delete/patch Pods, get/create PVCs, get/create/delete Secrets, get ConfigMaps, get PVs, list VolumeAttachments. `auth can-i` answers no for nodes ([records/008](records/008-on-prepare.json)). |
| Admission | The repository's webhook template installed for the run (`failurePolicy: Fail`) and removed at its end ([records/010](records/010-on-admission.json), [records/031](records/031-final-teardown.json)). |
| Image | `deploy/managed-runner/image` built from `8055bb568` in the capped builder (105 s, product manifest `sha256:c8635fa7…`), plus the lab CA layer (9 s, manifest `sha256:2f6cc4f2…`) ([kit/build-image.sh](kit/build-image.sh), [logs](logs/image-product-build.txt)). Imported into both VMs' containerd as `orbit-managed-runner-lab@sha256:6483cb75…` (39.9 s and 49.4 s, in the trial's [facts](trial/records/005-facts-image.json)), the same image ID on both ([records/005](records/005-facts-image.json)). Nothing was pushed. |
| Driver | [scripts/managed-runner/lab/takeover-lab.py](../../../../scripts/managed-runner/lab/takeover-lab.py), in a transient unit (`MemoryMax=1G`). It writes one record per step ([steps.jsonl](steps.jsonl), [logs/run.log](logs/run.log)) and stops at the first failed check. A recorder sampled the database and k3s every second ([logs/timeline.jsonl](logs/timeline.jsonl), 69 changes from 12:45:13 to 13:06:35). |

**How the run went.**
- A first run (`trial/`) stopped at the move: fake-model.py quoted only T06/T07/T08 markers, so the driver never saw
  its `T02-…` answer. The runner had moved and answered (26.6 s); that run's runner was put to sleep and its database
  kept as `test-server-t02-dev`.
- After the fix (`3314ffd94`) the run started again from nothing at 12:42:49 and ran in one pass to 13:06:37. It stopped
  twice on a check and went on from that step (`--from-step`) once the check was fixed:
  - `duplicate/rwo` ([017](records/017-duplicate-rwo.json), then [018](records/018-duplicate-rwo.json)): Kubernetes 1.36
    words a refused second attach "Waiting for detach … already used by pod(s)", not "Multi-Attach error". Both
    attempts saw the same behaviour.
  - `takeover/data` ([024](records/024-takeover-data.json), then [025](records/025-takeover-data.json)): a probe's
    unsynced Git commit had not survived the power cut (finding 2). The check now judges what was made durable and
    reports the rest.
- 31 steps were recorded, 29 of them passed, with 175 checks on the passing steps.

## The account and its volume

| What | Value ([records/011](records/011-account-ready.json)) |
| --- | --- |
| Runner | `01a15431-f1f1-773e-b7cd-c25915447151`, default workspace `01a15431-f209-…` |
| PVC | `mr-data-01a15431-f1f1-773e-b7cd-c25915447151`, UID `4221311d-4f1c-4715-be48-cc3d8c5ae9a5`, RWO, Filesystem, `runner-data`, 2 GiB |
| PV | `pvc-4221311d-…`, UID `446bb2d6-4df3-4366-bedc-21a0f0f2ba51`, ext4, `Retain` |
| Volume handle | `0001-0024-12b3f1b2-c9ec-11f1-80c0-525400123456-0000000000000002-6b461c68-73b8-4dd6-9cf9-d8c194663bb6` |
| RBD image | `orbit-mr-rbd/csi-vol-6b461c68-73b8-4dd6-9cf9-d8c194663bb6`, ID `455e916bbf11b`, 2 GiB, features `layering` |

These six never changed: the records check them at every stage.

## 1. A normal move to the other node

The manager names no node for a runner Pod. The second node was cordoned while the account was provisioned. To move the
runner, the first node was cordoned and the second uncordoned before the wake. The first node was uncordoned again
afterwards; the runner stayed where it ran.

| Stage | Result |
| --- | --- |
| Generation 1 on the first node, 12:45:21–12:45:57 ([011](records/011-account-ready.json)) | Sign-in to READY in 36 s on a fake-model key. Pod `cc460c50…` on `orbit-mr-lab`, VolumeAttachment `csi-797c640b…` to it, the image mapped as `/dev/rbd1` by the first VM's kernel, RBD watcher `10.77.0.1:0/3421088657` |
| Data ([012](records/012-account-data.json)) | A session with an attachment and a file the engine committed in its worktree (`FAKE-WRITE`), and probe p1 inside the runner container: 8 MiB random (`d4a1e6d0…`), 150 SQLite rows committed one by one in WAL mode with `synchronous=FULL` (`63dea591…`), Git commit `641340cd…`; `integrity_check` ok |
| Sleep ([013](records/013-migrate-sleep.json)) | The owner's sleep was answered 202. It was SLEEPING 15.4 s later, on the kubelet's report as the stop proof (`OBSERVED_STOP`: runner exit 0, `Succeeded`). Then: no Pod, no VolumeAttachment, mapped by no VM, no watcher, compute released, the claim kept |
| Wake on the other node ([014](records/014-migrate-move.json)) | A message at 12:46:51 made generation 2's Pod `457b55b5…` on `orbit-mr-lab-2` in the same second. Its runner container started 12:47:06. The message was answered after 24.7 s, READY after 25.8 s. VolumeAttachment `csi-51154fd9…` to the second node, `/dev/rbd0` mapped by the second VM, the only watcher `10.77.0.2:0/2935771823` |
| The same volume and data | The same runner ID, PVC, PV, handle, image and workspace. Probe p1 had the same random bytes, rows, row hash and Git commit, `integrity_check` ok. Uploads, the worktree with the engine's commit and the engine's transcript were unchanged, and the session's next request carried the earlier conversation |

## 2. A second Pod on the other node is refused

The runner ran on the second node with the repository's probe payload committing rows in its container (109, then
146 rows across the attempts). Each Pod below used the runner's claim and was pinned to the first node by `nodeName`
([016](records/016-duplicate-guard.json)):

| Attempt | Who | Answer |
| --- | --- | --- |
| Unlabelled Pod, another name | cluster admin | `NOT_THE_MANAGER: only the managed runner manager may create a Pod that uses a managed runner volume` |
| Unlabelled Pod, another name | the manager's ServiceAccount | `NOT_THE_FIXED_NAME: the one Pod of this volume is mr-01a15431-…` |
| Copy of the authorized Pod (labels, annotations, pinned image, volumes), another name | the manager | `NOT_THE_FIXED_NAME` |
| The copy under the fixed name, same generation | the manager | `NOT_RESERVED: generation 2 has no Pod creation reserved (READY)` |
| The fixed name for the next generation | the manager | `NOT_THE_RESERVED_GENERATION: the reserved generation is 2` |
| A Job's Pod | the Job controller | `FailedCreate … NOT_THE_MANAGER`; no Pod |

The authorized Pod kept its UID and ran on. The volume stayed in one place throughout: one VolumeAttachment (to the
second node), mapped by the second VM only, one watcher. No Pod on the first node referred to the claim.

**What RWO and RBD do by themselves.**
- **RWO** ([018](records/018-duplicate-rwo.json)). A plain claim of the same class, `t02-rwo-…`, has a name the guard
  does not cover. Its writer Pod ran on the first node. A second Pod on the second node stayed `Pending`
  (`ContainerCreating`) with `FailedAttachVolume: Waiting for detach for volume "pvc-…" Volume is already used by
  pod(s) t02-rwo-…-a`. There was one VolumeAttachment, and only the first VM mapped the image.
  - This refusal is the attach/detach controller's, and the out-of-service taint of the failover deliberately overrides
    it (section 3).
  - On one node RWO admits a second Pod outright (L0, T02a).
  - The claim, its PV and its image were deleted afterwards.
- **RBD** ([019](records/019-duplicate-rbd.json)), while the second VM's kernel mapped the runner's image:
  - features `layering` only, so no `exclusive-lock`;
  - no RBD lock;
  - one watcher before and after, 10.77.0.2.
  - A second Ceph client (librbd, `rbd bench` as `client.admin` in the first VM) opened the image and read 1 MiB:
    exit 0. Ceph refused nothing.

## 3. The second node stops: no takeover without proof, then the runbook's failover

**Before** ([020](records/020-takeover-prepare.json), [021](records/021-takeover-cut.json)):
- Generation 2 was READY on the second node with the payload writer committing rows.
- Probe p2 was written there at 12:52:30.644, 14 s before the cut.
- Generation 2's bootstrap credential was saved (mode 0600, never printed).
- A read beside the writer saw 439 acknowledged rows, hashing `370a5bb5…`; the last read of its acknowledgement said 441.

**The cut.** `stop.sh --node 2 --hard` killed the second VM's qemu at **12:52:44.611**. On the host, the unit was then
`inactive/dead`, no qemu process was left, SSH and QMP were refused and the link had no connection.

**Heartbeat loss alone, 420 s** ([022](records/022-takeover-heartbeat-loss.json), 75 samples in
[records/takeover-heartbeat-loss-timeline.jsonl](records/takeover-heartbeat-loss-timeline.jsonl)). Seconds after the cut:

| s | Seen |
| --- | --- |
| 35 | The second VM's RBD watcher gone (sampled every 15 s) |
| 52 | Node `Unknown` (`NodeStatusUnknown`), taints `unreachable:NoSchedule` and `unreachable:NoExecute`; the Pod `Running`, Ready `False` |
| 114 | The owner's status `usable: false`: the last heartbeat, 12:52:37, older than `heartbeatFreshSeconds` |
| 155 | A message to the session, answered 201 and left `PENDING`; the owner's retry refused `409 MANAGED_RUNNER_TRANSITION_REFUSED` ("A READY managed runner is not retried.") |
| 351 | The taint manager evicted the Pod (`DisruptionTarget` `DeletionByTaintManager`, a `deletionTimestamp`); still `Running`, held by the stop-report finalizer |
| 0–420 | The mapping READY at generation 2 with Pod `457b55b5…` recorded; no other Pod object referred to the claim; the VolumeAttachment stayed attached to the dead node; the gate saw 252 connections from the manager, every one a read: no Pod create, no admission probe, no Secret create |

Nothing took over. The mapping did not go `FENCING` either: finding 1.

**Failover**, as [the runbook](../../../managed-runner-kubernetes-operations.md#failover) says
([023](records/023-takeover-fence.json)):

| Time | Step |
| --- | --- |
| 12:59:51.741 | ConfigMap `mr-fence-01a15431-…` with the receipt, `receipt.json`. It is `NODE_POWER_OFF` with mechanism `HYPERVISOR`, `quarantined: true`, and the host's power checks as the independent observation. It names the predecessor as the mapping recorded it: generation 2, Pod `457b55b5…`, node `orbit-mr-lab-2` (UID `8e19d40a-…`), the PVC UID, the handle and the image |
| 12:59:51.771 | `node.kubernetes.io/out-of-service=nodeshutdown:NoExecute` on `orbit-mr-lab-2` |
| by 12:59:57.6 | PodGC made the Pod `Failed`; the attach/detach controller deleted its VolumeAttachment, with no wait for an unmount nobody could report |
| 13:00:02.100 | The manager went `FENCING` `PREDECESSOR_STOP_UNPROVEN`, 10.3 s after the taint: the Pod was terminal, but not by its kubelet. Generation 2's credential was refused 401 at `/runner/me`, heartbeat and claim from then on |
| 13:00:02.291 | The stop-report finalizer was taken off with the runbook's UID-tested JSON patch, and the object went |
| 13:00:06.666 | The receipt was accepted, recorded on the mapping as `FENCING_RECEIPT` with the ConfigMap's UID and resourceVersion and retired at 13:00:06.678, and generation 3 reserved |
| 13:00:06.966 | Generation 3's Pod `cdb1107e…` on `orbit-mr-lab`, the second node being tainted. `Running` at 13:00:20, **READY at 13:00:28.372**: 26.1 s after the finalizer came off, 463.8 s after the cut, 427 s of that the deliberate wait |

- Since the receipt, the gate saw one admission probe, one Secret create and one Pod create.
- No sample had two Pods on the claim, or two VolumeAttachments.
- The new attachment went to the first node, which mapped the image as `/dev/rbd1`; the only watcher was 10.77.0.1.

**The data on the first node** ([025](records/025-takeover-data.json)):

- **The payload writer** (`synchronous=FULL`, every acknowledgement fsynced, Git with `core.fsync all`):
  - 441 rows committed after SQLite's WAL recovery, 441 acknowledged on the volume, the last read before the cut 441;
  - rows 1–439 hash as read before the cut (`370a5bb5…`);
  - `integrity_check` ok, still WAL;
  - its file, Git commit and random file unchanged.
- **Probe p1** (written on the first node): random bytes, rows, row hash and Git commit unchanged, `integrity_check` ok.
- **Probe p2** (written on the second node 14 s before the cut):
  - Its random file and SQLite rows, both fsynced, were unchanged, `integrity_check` ok.
  - Its Git commit, which Git does not fsync by default, was lost. `note.txt`, `HEAD`, `refs/heads/master`,
    `COMMIT_EDITMSG` and the three loose objects were all 0 bytes, so it was no longer a repository: finding 2.
- **The session.** The message sent during the outage was answered by the runner at 13:00:28.87, 309.5 s after it was
  sent, and the engine's request carried the earlier conversation.
- **The volume.** The uploads, the worktree with the engine's commit, the transcripts and the runner ID were as before
  the failure. Every SQLite database on the volume said `ok`. `/var/lib/orbit` was ext4 on `/dev/rbd1`, and
  `managed-instance.json` named generation 3 and its Pod.

## 4. The old node comes back

| Check | Result |
| --- | --- |
| Boot ([026](records/026-rejoin-start.json)) | `start.sh --nodes 2 --no-wait` at 13:02:54; the node was `Ready` 29.3 s later, still tainted out of service |
| The second VM | A new boot ID. No RBD device mapped and no RBD filesystem mounted. The old Pod's two containers were listed as exited and its sandbox not ready; nothing ran. Its kubelet tried to tear the old Pod's volume down and could not even reach the CSI driver: the node plugin, evicted by the out-of-service taint, does not run there under it |
| The volume | No VolumeAttachment to the second node; the only RBD watcher was the first VM's |
| Generation 2's credential ([027](records/027-rejoin-credentials.json)) | 401 at `/runner/me`, heartbeat and claim, whether it named its own instance or the current one. Generation 3's credential naming generation 2 and its Pod: 403 `MANAGED_RUNNER_INSTANCE_SUPERSEDED`. With no instance, another Pod or the next generation: 403. As itself: 200, a read only |
| The writer ([028](records/028-rejoin-writer.json)) | It went on from generation 3 on the first node with the old node back: 441, then 530 rows 30 s later. Ceph's blocklist held no entry for the second node: the fence was the power-off, not a storage fence. The entries there are the mgr's own restarts |
| Rejoin ([029](records/029-rejoin-release.json)) | The taint was removed at 13:04:59 and the node plugin was ready on the second node at 13:05:05. The lab was healthy, both nodes and Ceph `HEALTH_OK`. The runner did not move, the volume stayed in one place, and the second VM mapped nothing. The writer quiesced at 622 rows, `integrity_check` ok |

## 5. At the end

[030](records/030-final-checks.json):
- The database and k3s agreed.
- In the recorder's timeline, never more than one Pod referred to the claim, and never more than one VolumeAttachment to
  its PV.
- Ceph was `HEALTH_OK`.
- ann was asleep 35.9 s after her sleep: no Pod, attachment, mapping or watcher, the claim the one made at the first
  provisioning, generation 4 reserved.

The run's teardown removed the webhook and stopped the recorder, the test server and the gate.

## Findings

1. **Heartbeat loss leaves the mapping READY, not FENCING.**
   - The task description and the runbook said a node that stops reporting sends its runner to `FENCING`. The design
     says to "persist FENCING and block replacement" for an unreachable node, rejecting the predecessor's generation.
   - The manager does block replacement: no Pod was made. But it fences only when the recorded Pod disappears, is
     replaced, or turns terminal without its kubelet's report.
   - A Pod on a dead node stays `Running`, and so does one the taint manager evicts (`DeletionByTaintManager`), so the
     mapping stays READY. The owner reads it as not usable, and the predecessor's credential stays valid until the
     operator's out-of-service taint lets PodGC make the Pod `Failed`.
   - Safe here, since nothing replaced it and the node was dead. But it is not what the design and the runbook said.
   - The runbook now says what happens. Whether the manager should fence when the control plane marks the Pod for
     deletion is reported to the coordinator, with the trade-off: a healthy node's NoExecute taint would then cut a
     draining runner's credential too.
2. **Git work of the last seconds before a node's power loss can leave a repository unreadable.**
   - Probe p2's commit, 14 s before the cut, came back as zero-length files. ext4 allocates delayed blocks at writeback,
     about 30 s, and Git fsyncs neither loose objects nor refs by default.
   - A second cut in the same lab ([kit/git-fsync-cut.py](kit/git-fsync-cut.py),
     [records/git-fsync-cut.json](records/git-fsync-cut.json)) compared two repositories committed 1.5 s before the
     power went:
     - Git's defaults: unreadable, as above.
     - `core.fsync=committed,index`: its loose objects survived. But `HEAD`, written by `git init`, was empty and
       `refs/heads/master`, renamed into place, was missing, so it was unreadable too.
   - So Git's own settings do not make work of the last seconds durable on this volume. A managed runner's workspace
     and worktrees, written by the runner and the engine, can be left unreadable by a node's power loss right after Git
     work.
   - Everything fsynced survived, and so did everything older than the writeback window.
   - Reported to the coordinator. A fix belongs with the image and the runner, for example syncing the volume after the
     Git operations that must survive, or repairing a repository on the next start. It is not in this task.
3. **The Ceph-CSI node plugin has no tolerations.**
   - The out-of-service taint evicts it from the fenced node, and the DaemonSet does not bring it back there until the
     taint is removed.
   - That is right for the quarantine: the returning node cannot map anything. But `status.sh` reports the lab
     unhealthy meanwhile, so the run booted the node with `start.sh --no-wait`.

## Not established here

- Availability across physical machines.
- A partition in which the old node keeps running, reaches Orbit or Ceph, and is cut from the control plane. The scripts
  stop the second node hard; they offer no partition.
- A storage fence (`STORAGE_FENCE`, a persistent blocklist) as the receipt's method. Only the hypervisor power-off was
  run.
- Two managers: one apiserver ran.
- A real model.
- Other Kubernetes releases' PodGC and attach/detach behaviour: this is k3s v1.36.5's.

## Left in the lab

- The test server's state in `test-server-t02`: ann SLEEPING on her claim, generation 4 reserved.
- Her claim `mr-data-01a15431-…`, its PV and image (`Retain`), and the receipt ConfigMap `mr-fence-01a15431-…`, the
  incident's record.
- The trial's `test-server-t02-dev`: its ann SLEEPING on `mr-data-01a15425-…`.
- The plain RWO claim and the Git experiment's claim were deleted with their PVs and images.
- The webhook was removed. The test server, recorder and gate were stopped, the second node cordoned by `stop.sh`, and
  both VMs were off at 13:12:44 ([logs/99-stop-both.log](logs/99-stop-both.log), inventory before it in
  [logs/90-inventory-before-stop.txt](logs/90-inventory-before-stop.txt)).
- The Failed Pod `mr-01a14db1-…` of an earlier task's database was there before the run. It is held by the stop-report
  finalizer and has no VolumeAttachment, and was left untouched.
- No record holds a credential. `takeover-lab.py secret-scan` over this directory, against both test-server directories,
  found none: no owner token or password, server secret, webhook or manager token, lab admin key or runner credential.

## Checks

- **The tip.** `origin/project/34ZteKCnYMpKY46f63Leb` (`8055bb568`) and `origin/main` (`e7168b246`) were both already in
  the branch, so `git merge --no-ff` of each was "Already up to date".
- **The gate.** [kit/gate.sh](kit/gate.sh) ran on the tip `8e3edaedf`, one step after another, in a transient scope
  outside the runner's cgroup (`MemoryMax=9G`), after other sessions' builds had ended
  ([logs/gate-steps.txt](logs/gate-steps.txt), [logs/gate-results.txt](logs/gate-results.txt)):

| Step | Result |
| --- | --- |
| `npm run test:compose-topology` | 16 of 16 |
| `npm run prisma:generate`, `npm run build` | exit 0 |
| `npm test -w @orbit/shared` | 491 of 491 (32 files) |
| `npm test -w @orbit/apiserver` | 5320 of 5320 |
| `npm test -w @orbit/web` | 5368 of 5368 (414 files) |
| managed-runner Python, `python3 -B -m unittest discover -s scripts/managed-runner -p '*test*.py'` | 223 tests OK, among them `TakeoverLabTest`'s three cases and fake-model.py's T02 markers |

**Not run, and why.**
- The apiserver's pg specs: no product code changed. The delivery is lab tooling under `scripts/managed-runner/lab/`,
  its offline tests, the lab page, the runbook, a design record and this evidence.
- runner-go's `go test ./...`: nothing under `src/runner-go` changed.

This section, the gate's two logs, and nothing else, were added after the gate ran.
