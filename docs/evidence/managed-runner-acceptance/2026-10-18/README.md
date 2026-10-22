# Two accounts end to end, an independent backup restored, and the Kubernetes runbook (T08)

Task T08 (34ZtjU3ZIRPPlflO47UUh) of the managed-runner project, 2026-10-18: the system acceptance of managed runners
on Kubernetes, as far as the single-machine lab can carry it, and the operations runbook written from it
([managed-runner-kubernetes-operations.md](../../../managed-runner-kubernetes-operations.md)). No product code changed.
The lab page's section is [End-to-end acceptance (T08)](../../../managed-runner-lab.md#end-to-end-acceptance-t08), the design's
record [Implementation record: two accounts end to end…](../../../managed-runner-design.md#implementation-record-two-accounts-end-to-end-an-independent-restore-and-the-kubernetes-runbook).

## The run

One command, `scripts/managed-runner/lab/acceptance-lab.py run`, ran every phase in order on the project line at
`eb16b3b5e` (the project tip `da89a8185` and this task's two commits; `head.txt`), against a fresh database
(`test-server-t08`), and stopped at nothing: **48 steps, 261 checks, all passed, 2026-10-18 12:29:59–13:06:23 UTC
(36.4 minutes)**. It ran as a transient systemd unit outside the Orbit runner's cgroup, so that a runner outage could
not end it (one had ended this session at 10:22). `steps.jsonl` has each step's time and checks, `records/NNN-*.json`
each step's full result, and `report.json` the intervals quoted here (`acceptance-lab.py report`).

It is the second full run. The first, at `815df52f5` (12:00–12:28), stopped at step 44, `off-again/unset`, on a fault of
the driver, not of the system: manager-lab.py's `http(port=…)` points single-writer.py's module-wide address at the
replica and back, and the sixteen threads of the concurrent sign-ins raced on it, so every later request went to the
replica (the same database and code), until that step stopped the replica. `eb16b3b5e` calls the replica directly and
checks before every step that the client points at the primary. The first run's steps are kept in `first-run/` (43 of
44 passed); its resources were deleted before this run. Earlier trials on `test-server-t08-dev` shaped the driver and
are not evidence; their claims, PVs, images and backups were deleted.

| Phase | Steps | Checks | Seconds | What |
| --- | --- | --- | --- | --- |
| facts | 5 | 7 | 6.9 | versions, topology, resource limits ([below](#the-environment)) |
| setup | 2 | 3 | 4.1 | the shared lab units restarted for this directory, the gate, no webhook yet; this checkout's runner built for the host |
| off-unset | 6 | 20 | 248.1 | the switch unset, no profile, a fresh database |
| off-false | 4 | 18 | 152.5 | `ORBIT_MANAGED_RUNNERS_ENABLED=false`, still no profile |
| on-provision | 4 | 18 | 55.5 | the switch on; concurrent sign-ins without the admission guard, then the guard and the retries |
| capacity | 1 | 5 | 0.4 | a third account on a budget of two |
| sessions | 7 | 41 | 244.4 | first sessions, the engine's own commit, data, isolation, a busy runner |
| sleep | 2 | 10 | 187.6 | idle sleep; the third account admitted |
| wake | 2 | 18 | 64.2 | a message, a task's run time |
| rebuild | 1 | 17 | 33.5 | an operator's Pod delete, a killed runner |
| controller | 1 | 7 | 201.5 | both apiservers SIGKILLed mid-wake |
| image | 2 | 12 | 163.7 | the image pin rolled back and forward |
| backup | 5 | 32 | 246.5 | an RBD export out of the VM, checked off the cluster, restored into a new claim |
| off-again | 4 | 44 | 564.5 | unset, then `false`, with every runner asleep; then on |
| final | 2 | 9 | 10.4 | consistency, the whole timeline, Ceph; the window closed |

## The environment

| What | Value (records 001–005, 018) |
| --- | --- |
| Host | HPC (runner `workstation-gpu`), Debian 13, kernel 6.12.107, 24 CPUs, 15 GiB RAM; no `rbd`, `nbd`, `ceph` or `libceph` module loaded |
| VM | `orbit-mr-lab.service`, its own cgroup in `system.slice`: q35/KVM, 4 vCPU (`CPUQuota` 400%), 6144 MiB guest RAM, `MemoryMax` 6656 MiB, `OOMScoreAdjust` 1000 |
| Kubernetes | k3s `v1.36.5+k3s1`, client v1.36.5; containerd 2.3.4-k3s1.36 |
| Topology | **one node**, `orbit-mr-lab` (UID `2aacc9d7…`), Ubuntu 26.04.1 LTS, kernel `7.0.0-34-generic`; capacity 4 CPU, 5.8 GiB; allocatable 3 CPU, 2592 MiB; one failure domain |
| Ceph | 20.2.4 Tentacle, all 5 daemons (1 mon, 1 mgr, 3 OSDs on one virtual HDD each); FSID `12b3f1b2-c9ec-11f1-80c0-525400123456`; `HEALTH_OK` at the start and at the end; CRUSH rule `replicated_rule` choosing by `osd` |
| Pool | `orbit-mr-rbd`: replicated, size 3, `min_size` 2, 32 PGs, application `rbd` |
| Ceph-CSI | v3.18.0 (`quay.io/cephcsi/cephcsi:v3.18.0@sha256:0a92e5c8…`) by Ceph-CSI Operator v1.1.0; csi-provisioner v6.3.0, csi-attacher v4.13.0, csi-resizer v2.2.1, node-driver-registrar v2.18.0, all by digest; CSIDriver `rbd.csi.ceph.com`: `attachRequired: true`, `fsGroupPolicy: File`. No Rook. |
| StorageClass | `runner-data`: `rbd.csi.ceph.com`, `clusterID` the FSID, pool `orbit-mr-rbd`, `imageFeatures: layering`, `mounter: rbd`, no other mounter, ext4, `Retain`, `Immediate`, no expansion |
| Access mode | `ReadWriteOnce`, `Filesystem`, ext4 on kernel RBD (`/dev/rbdN` in the runner) |
| Runner image | `docker.io/library/orbit-managed-runner-lab@sha256:cdb090148c194e536fe86c22f1507b45f74f2aa6929df26f7360747604102312` (T06b's build of `ebf54ab8d` plus the lab CA layer, 500 MB; `git diff ebf54ab8d HEAD -- src/runner-go deploy/managed-runner/image` is empty), in the guest's containerd, never pushed. Its runner reported `managed-ebf54ab8d…`. The rollback image: T02a's build, `…@sha256:54441a07…` (source `292b2eb43`). |
| Test control plane | On the host, 127.0.0.1 only, outside the runner's cgroup: PostgreSQL 16 (768 MiB cap), this checkout's apiserver and a replica (1536 MiB each), a TLS front the Pods reach at `https://10.0.2.2:13711`, fake-model.py, the gate `api-gate.py` (the manager's only way to k3s, logging each connection's record sizes), a recorder (1 s) |
| Profile | budget 1 CPU, 1536 MiB, 2 GiB ephemeral, 2 Pods, 2 attachments, 2 active users, 12 GiB usable storage with 2 GiB headroom; per runner 2 GiB storage, requests 500m/768Mi, limits 2/2Gi, init 50m/64Mi; `idleSeconds` 90, `maxAttempts` 5, backoff 5–60 s, poll 5 s, lease 60 s, `heartbeatFreshSeconds` 120, startup deadline 900 s |
| Manager identity | ServiceAccount `orbit-mr-manager`: create/delete/patch Pods, get Secrets and PVs, list VolumeAttachments; no list or update of Pods, no `pods/exec`, no ephemeral containers, no ConfigMap create, no PVC delete, nothing in `kube-system`, no nodes, no webhooks (`auth can-i`, record 018) |
| Model | fake-model.py as a DeepSeek-preset key of each account (not a model); the owner's DeepSeek key file did not exist |

The accounts' volumes, the same from their first provisioning to the end (record 047):

| Account | Runner | Claim (UID) | PV | RBD image | Generations |
| --- | --- | --- | --- | --- | --- |
| ann | `01a14f03-ec2d-…` | `mr-data-01a14f03-ec2d-…` (`4caa2267…`) | `pvc-4caa2267…` | `orbit-mr-rbd/csi-vol-803a7868-15d8-4471-80c9-6a33de2d9834` | 1–7 |
| bob | `01a14f03-ec5a-…` | `mr-data-01a14f03-ec5a-…` (`f5cccf9b…`) | `pvc-f5cccf9b…` | `orbit-mr-rbd/csi-vol-89d3b261-afdc-45cd-b89a-0fe94e3f46b8` | 1–6 |
| cy | `01a14f04-a624-…` | `mr-data-01a14f04-a624-…` (`989c98fe…`) | `pvc-989c98fe…` | `orbit-mr-rbd/csi-vol-8df43b50-2e72-44e9-ad65-4737a09dd275` | 1–3 |

## What it established

**The switch unset and `false`** (records 008–017). Both groups ran with no profile, so the apiserver's environment held
no Kubernetes or Ceph setting (`apiEnvironmentNames`; the only managed name with `false` is the switch itself), and its
home no kubeconfig. Root, ann and bob signed in; `GET /api/managed-runner` read `enabled: false`, `NOT_PROVISIONED`, and
the shared display drew nothing; `/api/auth/capabilities` said `managedRunners.enabled: false`; every managed write
(`ensure`, `retry`, `wake`, `sleep`, `delete`) answered `404 MANAGED_RUNNER_DISABLED`. This checkout's runner, built for the
host and run there as a self-managed runner of root's (`orbit run`, Claude Code 2.1.302), answered a session, a task run
now and a task's run time in each group, all claimed and answered on it. No managed row, no capacity pool row and no
runner but that one were written, no object in the namespace (53) changed, and the gate saw no connection, for 90 s each.

**Provisioning** (records 018–021). The switch on, the replica up, no admission guard: sixteen concurrent sign-ins of
ann and bob, half of them on the replica, all answered (the slowest in 236 ms). Each account got one mapping, one claim,
one Secret and one admission probe, which the cluster admitted, so both were `FAILED ADMISSION_GUARD_MISSING`, retryable,
5.7 s later, with no Pod. The gate saw two claim creates, two Secret creates and two probes. With the guard installed
(an unmanaged dry run admitted, one on an unowned `mr-data-…` claim refused), the owners' retries made the two Pods 6.3 s
later; their runners' first heartbeats came 31 s after the Pods, `MODEL_UNAVAILABLE`, and READY 1.1 s after each account
added its key. The same claims throughout, no second claim create.

**Capacity** (records 022, 031). With both slots held, cy signed in and waited `WAITING_CAPACITY`
(`MANAGED_RUNNER_CAPACITY_UNAVAILABLE`, "Waiting for capacity", work accepted), with no claim, Secret or Pod. Its claim
was made at 12:44:08, as ann's runner slept, after 6 min 21 s of waiting, and it was READY 20 s later.

**Sessions and data** (records 023–027). Each account's first session, in its managed default workspace, carried an
attachment and asked fake-model.py for `FAKE-WRITE`: Claude Code ran its own Bash tool in the session's Git worktree, wrote
and committed `t08-<name>1.txt`, and the tool's result came back 2.3–2.4 s after the session was made. Then, while a long
turn (ann) and a background job (bob) ran, a probe on each volume (8 MiB of random bytes, 150 SQLite rows each committed
in WAL mode with `synchronous=FULL`, a Git commit) and a snapshot of each runner's home: the upload with its checksum,
the worktree's HEAD at the engine's commit, the transcript, `integrity_check` `ok`.

**Between the accounts** (record 027, 19 checks). Each owner's token and runner credential against the other's: reading,
rotating or deleting the runner, reading or deleting the workspace, a runner request naming the other's instance, reading
the session or its events, sending it a turn, reading its attachment, making a session in its workspace: all 403 or 404,
and the other's mapping unchanged. The admission guard refused Pods mixing the two owners and volumes, an unlabelled Pod
on a runner's claim and a copy of a runner's Pod under another name, on the same node, while the runner kept running. In
each runner: one RBD filesystem, at `/var/lib/orbit`; no service account token, no credential variable, no RBD device
node; UID 10001 with no capabilities; the Kubernetes API answered 401. The two accounts' images are different.

**Busy, then idle** (records 024, 028–030). The turn and the job each ran 240 s. At 110 s, past the 90 s idle interval,
both runners were READY with no drain asked, and each owner's sleep was refused `409 MANAGED_RUNNER_BUSY`. The job exited 0.
96 s after the work ended each runner's drain began, and 40 s later each was SLEEPING: its Pod gone, no attachment, no RBD
watcher, its compute released, its claim bound as before.

**Wakes** (records 032–033). A message to sleeping ann was answered 10.4 s later, on a new Pod. A task with a run time
45 s ahead, for sleeping bob, was started by the due-task sweep when it was due, and answered 5.1 s after that. Each
woken runner's probe and snapshot were as before, and each resumed session's next request to the model carried the
earlier conversation (its first prompt's `T03-SECRET`, in a request of 11 messages for ann and 17 for bob), read from the
transcript on the volume.

**Rebuilds** (record 034). An operator's `kubectl delete pod` of ann's runner: the Pod stayed, held by
`orbit.dev/managed-runner-stop-report`, until the manager had its kubelet's report; READY again 14.7 s after the delete. A
SIGKILL of bob's `orbit run`: the Pod failed; READY again 25.0 s later. Each on a new Pod of the next generation, the same
claim; the gate saw exactly two Pod creates; data and sessions as before.

**The controller** (record 035). ann ran a 200 s turn; bob was put to sleep and sent a message. 0.4 s into his wake, with
his Pod just created (STARTING, the create completed, the Pod Pending), both apiservers were SIGKILLed, left down for 5 s
and started again. The restarted manager adopted that Pod, with no second Pod create; bob was READY 12.5 s after the kill
and his message was answered; ann's turn, running through it, was answered on the same Pod and generation; the database
and k3s agreed.

**The image rolled back and forward** (records 036–037). With T02a's lab image pinned and both apiservers restarted,
ann's running Pod kept its image; after a sleep and a message, her next generation ran the previous image, resumed her
session and found her data. Pinning the current image again gave it back the same way.

**Independent backup and restore** (records 038–042, 32 checks). A turn kept ann's runner awake while a second probe
was written; then her account was disabled, and her runner slept 33.8 s later: no Pod, no attachment, no RBD watcher.
Her 2 GiB image was exported in the VM (`rbd export`, its SHA-256 and gzip in one pass, 7.8 s) and copied out of the VM
to the host, `/mnt/data/managed-runner-lab/backups/t08-20261018T125553Z/` (0700; 27.0 MB, 0.3 s), with a manifest of its
identity, quiescence and checksums. On the host, with no Ceph, Kubernetes, mount or kernel module, `debugfs` read the
decompressed image: ext4 clean, the probe's bytes, rows and commit, the upload, the engine's commit in the workspace
repository, the transcript, `integrity_check` `ok` for both SQLite files, `git fsck` clean (4.3 s); the extracted copy
was then removed. A new claim of `runner-data` was made, and the backup written into its fresh image (imported as a
scratch image, then `rbd export-diff | rbd import-diff`, the scratch removed); the new image read back byte for byte as
the backup. A Pod of the runner image, as UID 10001, found it as `/dev/rbd1`, ext4, the new image, with the same data
(25.8 s in all). ann's original claim, PV, handle and image were untouched; enabled again, she woke on them, her session
resumed, the second probe as written.

**The switch off again** (records 043–046). Every runner asleep, then the switch unset, then `false`, each with no
profile: a message to ann, a task run now for bob and a task with a run time for cy made no managed write; the message
waited (`PENDING`, not failed); every managed write was 404; nothing in the namespace (60 objects) changed, nothing
reached the gate, no claim was removed; the self-managed runner kept answering. Switched on, all six waiting pieces of
work were answered on the right runners, ann's last, once a runner had slept and freed a slot.

**At the end** (record 047). The database and k3s agreed, the earlier tasks' objects in the namespace were as at the
start, never more than one Pod used any of the three claims in the 207 samples of the timeline, each claim was the one made
at its account's first provisioning, with its UID, Ceph was `HEALTH_OK`. Over the run the gate saw 3 claim creates, 14
Secret creates, 16 admission probes and 14 Pod creates. The pool held no compute and the three volumes' 6 GiB at the end.

**SQLite.** The runner's home on these volumes held no SQLite database of its own: the two probe databases are the ones
checked (`integrity_check` on every `*.sqlite`, `*.db` and `*.sqlite3` under the home, in the Pods and in the backup).

## The default entry points

`checks/default-entry-review.txt` (`kit/entry-review.sh`): the root Compose defaults the switch to `false`; the Docker
channel is in the opt-in `managed-runners-docker` profile; `.env.example` has the managed lines commented out; no default
entry point (Compose files, `.env.example`, `package.json`, `.github/`, the skills, `install.sh`, the gateway, the
Dockerfiles, `scripts/*.sh`, `scripts/*.mjs`, `scripts/ci/`, `scripts/lib/`) contains Kubernetes, kube, kubectl, kubeconfig,
k3s, Helm, Rook, Ceph, CSI, StorageClass or PersistentVolumeClaim, or names `scripts/managed-runner`, the webhook template
or the lab; `deployment_boundary_test.py` and `new_deployment_test.py` pass (20 tests). The new deployments' default (the
Docker backend, judged under criterion 11) is unchanged by this task.

Every operation with a side effect ran in the authorized lab: the lab's kubeconfig and context `orbit-mr-lab`, namespace
`orbit-mr-test`, Ceph commands over SSH in the VM, and the test control plane on the host's loopback. Nothing connected to
orbitd.io or exposed a port, and no production deployment was touched.

## The runbook

[managed-runner-kubernetes-operations.md](../../../managed-runner-kubernetes-operations.md): what to keep; the deployment
order of a test environment (storage class, the manager's least-privilege identity, the admission guard and its token,
the image by digest, the profile, the switch); finding an account's runner, claim, PV and image; the stop-report
finalizer, when it may be removed (its own kubelet has reported the stop, or its node is fenced) and when it must not
(no report and no fence: a second writer could follow); an independent backup, its check off the cluster and its restore
into a new claim; switching off, rolling the image and the apiserver back, taking a test environment down; and failover
by fencing and a receipt. Each section says what was run here and what was not. The Docker side's runbook is
[D5's](../../../managed-runner-docker-operations.md).

## Findings

- **Ceph-CSI v3.18.0 and static PVs.** A static PV naming an imported image (handle = image name), on this driver's
  `attachRequired: true`, never attaches: ControllerPublish answers "does not support publish: invalid VolumeID … failed to
  decode CSI identifier", and ControllerUnpublish then panics (`nil pointer dereference`), which holds the
  VolumeAttachment and the PV on the attacher's finalizer. Seen in a trial; the attachment had never attached, so its
  finalizer was removed by hand. The runbook restores into a claim the driver provisions instead.
- **A sleep advances the generation.** A runner's sleep retires the generation that ran, so the sleeping row already
  names the next one, and the woken Pod runs that generation. A wake is told by its new Pod and a generation past the one
  that slept.
- **I/O on the lab.** Two probes writing at once (each row `fsync`ed into a three-replica pool on one HDD) took 306 s;
  one at a time, 150 rows took about 35 s each.

## Not established here

These are **blockers**, not passes:

- **Across nodes.** A planned move of a runner to another node, takeover after a node stops or is fenced (an accepted
  fencing receipt, the `out-of-service` taint, the next generation on another node, the old writer unable to write
  afterwards), and refusing a duplicate Pod on another node. The lab has one node and one failure domain.
- **A real model.** Every session ran on fake-model.py. A real DeepSeek session, its execution and its continuation after a
  sleep and a rebuild, waits for the owner's key file (`/mnt/data/managed-runner-lab/secrets/deepseek-api-key`, absent).
- **Putting a restored copy back under a runner.** The manager accepts only its recorded claim UID, PV UID and handle, and
  the guard admits no other Pod on a runner's claim; switching a mapping to a verified new claim, which the design's
  retention section calls for, is not implemented. The restore here proves the backup and gets the data back; it does
  not make the copy the runner's volume.
- **Encryption at rest of the backup.** The archive sits in a root-only directory on the host; no encryption was run.
- **Rolling the apiserver back** past the managed-runner feature: written in the runbook, not run.
- **A runner Pod deleted while no manager runs, and its finalizer removed by hand**: the runbook's rule, from the
  manager's code; not run here (T04 saw the Pod held, T02a the fence after a stripped finalizer).

## Checks on the final tip

The branch ends in a `--no-ff` merge of origin/main (`1c1c78d72`, the promotion of the project line, whose tree is the
project tip's) onto this task's work; the project line (`da89a8185`) is already in it. On the first such merge,
`c8eaef57d`, whose code tree is the final tip's (this commit adds only this section and `checks/`), each check ran outside
the runner's cgroup (one unit, `MemoryMax` 9G, `TZ=UTC`), one after another, with the VM off
(`checks/landing-checks-merge-1.txt`, full logs beside it):

| Check | Result |
| --- | --- |
| The project's merge check: compose topology, `prisma:generate`, `build`, the shared, apiserver and web suites | exit 0: topology 14/14, shared 491 (32 files), apiserver 5,340, web 5,374 (414 files), none failed or skipped |
| The managed-runner Python tests (`unittest discover -s scripts/managed-runner -p '*test*.py'`) | 154 passed |
| Every managed-runner pg spec and `tenant-isolation-runner` (`scripts/run-pg-spec.sh`) | 14 spec files against PostgreSQL 16.15, no skips: the 13 managed-runner specs (136 tests) and tenant-isolation-runner (725), all passed |

Neither main nor the project line moved while they ran. The final tip, the same merge made again over this commit, ran
them again; that run is cited in the task's evidence.

## Reproduce

```sh
export LAB_TEST_SERVER_DIR=/mnt/data/managed-runner-lab/test-server-t08
sudo scripts/managed-runner/lab/status.sh && sudo scripts/managed-runner/lab/start.sh
bash scripts/worktree-overlay.sh && npm run build -w @orbit/shared && npm run build -w @orbit/apiserver
OUT=/mnt/data/tmp/t08-run && mkdir -p $OUT && git rev-parse HEAD > $OUT/head.txt
sudo systemd-run --unit=orbit-mr-lab-t08-run --collect -p MemoryMax=1G -p Environment=HOME=/root \
  -p Environment=LAB_TEST_SERVER_DIR=$LAB_TEST_SERVER_DIR -p WorkingDirectory=$PWD \
  -p StandardOutput=append:$OUT/run.log -p StandardError=append:$OUT/run.log \
  /usr/bin/python3 -I $PWD/scripts/managed-runner/lab/acceptance-lab.py run --out $OUT --quiet-seconds 90
docs/evidence/managed-runner-acceptance/2026-10-18/kit/collect.sh $OUT $LAB_TEST_SERVER_DIR /mnt/data/tmp/t08sh \
  $PWD/docs/evidence/managed-runner-acceptance/2026-10-18
sudo scripts/managed-runner/lab/stop.sh
```

The run needs the lab's TLS CA and webhook token from `test-server-t02a` (the image trusts that CA), the two lab images
in the guest's containerd, and a host with about 6 GiB available.

## Files

- `steps.jsonl`, `records/`, `report.json`: the run. `head.txt`: its commit. After the run, two of the driver's
  read-only commands were refined, and their versions in this task's final commit produced `report.json` and
  `secret-scan.json`: `report` reads a sleep's drain time and a restart's Pod from the recorded changes, and
  `secret-scan` no longer takes "task-…" for an `sk-` key. The run's phases did not change.
- `logs/`: the driver's output (`run.txt`), the recorder's timeline, the apiserver's and the replica's logs, fake-model.py's
  request log, the gate's connection log, the self-managed runner's log.
- `checks/`: the default entry points' review, the lab's status before the VM stopped and its stop, and the landing
  checks on the first merge (`*-merge-1.*`).
- `first-run/`: the stopped first run's steps.
- `kit/`: `collect.sh` (this directory from a run), `entry-review.sh`. The driver itself is
  `scripts/managed-runner/lab/acceptance-lab.py`.
- `secret-scan.json`: none of the 20 credentials the run handled (owners' passwords and tokens, the test server's secrets,
  the manager's token, the webhook token, the self-managed runner's token, the lab admin's key) appears in these files.

## Left behind

The VM is stopped (`checks/lab-stop.txt`). `test-server-t08` is kept, with ann, bob and cy SLEEPING and their claims,
PVs and images kept; the restored claim `t08-restore-20261018t125553z`, its PV and its image are kept as retained test
data; the backup archive and its manifest stay in `/mnt/data/managed-runner-lab/backups/t08-20261018T125553Z/`. The
webhook is removed; the test server, gate, replica, recorder and self-managed runner are stopped. Earlier tasks' objects
in the namespace were left as they were.
