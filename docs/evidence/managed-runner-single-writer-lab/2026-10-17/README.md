# Single-writer protection of managed runners on the lab's one node (2026-10-17)

Task T02a (34hLQRqen3rnV1Wszrw9p) of project 34ZteKCnYMpKY46f63Leb, the same-node part of criterion 2: C2b's single-Pod
admission guard, generation-bound runner credentials and fencing gate, run by the test server's own manager against the
single-machine lab ([docs/managed-runner-lab.md](../../../managed-runner-lab.md), section "Single-writer protection
(T02a)"), and the runner's data across a Pod recreation and a VM restart under D7's recovery rule. The cross-node parts
stay with T02: this lab has one physical machine, one node and one failure domain. Times are UTC, 2026-10-17.

## Where it ran

| Part | Value |
| --- | --- |
| Lab | VM `orbit-mr-lab` as L0 built it: Ubuntu 26.04.1, kernel 7.0.0-34-generic, k3s v1.36.5+k3s1, Ceph 20.2.4 (3 OSDs, pool `orbit-mr-rbd` size 3), Ceph-CSI v3.18.0, StorageClass `runner-data` (RWO, ext4, kernel RBD), namespace `orbit-mr-test`, FSID `12b3f1b2-c9ec-11f1-80c0-525400123456`. Booted 19:45:37, healthy 19:47:11 ([logs/start-1.txt](logs/start-1.txt)); off again at 20:20:05. |
| Test server | This checkout's apiserver at the project tip 292b2eb43 with its own PostgreSQL, TLS front (`https://10.0.2.2:13711`, lab CA) and fake model, on 127.0.0.1, outside the runner's cgroup, state in `LAB_TEST_SERVER_DIR=/mnt/data/managed-runner-lab/test-server-t02a` so T03's database was not touched; `ORBIT_MANAGED_RUNNERS_ENABLED=true` with the profile below ([logs/test-server-start-1.txt](logs/test-server-start-1.txt): "managed runners are enabled in orbit-mr-lab (namespace orbit-mr-test)"). |
| Image | deploy/managed-runner/image built from 292b2eb43 in a 5 GiB-capped buildx builder in 37 s (manifest `sha256:7e69bcf2…128ab`, [logs/image-product-build.txt](logs/image-product-build.txt)), plus [lab-ca-image.Dockerfile](../../../../scripts/managed-runner/lab/lab-ca-image.Dockerfile): one layer adding the lab CA (`update-ca-certificates`: "1 added"; manifest `sha256:b9deda44…2262232`, [logs/image-lab-ca-build.txt](logs/image-lab-ca-build.txt)). Imported into the guest's containerd in 43.5 s under `docker.io/library/orbit-managed-runner-lab@sha256:54441a07…aef98d`, the archive's index holding that one manifest ([records/01-import.json](records/01-import.json)). Nothing was pushed. |
| Manager identity | ServiceAccount `system:serviceaccount:orbit-mr-test:orbit-mr-manager`: `get`/`create`/`delete` Pods and Secrets, `get`/`create` PVCs, `get` ConfigMaps, `get` PVs, `list` VolumeAttachments; `auth can-i` says no to listing or updating Pods, ephemeral containers, `pods/exec`, creating ConfigMaps, deleting PVCs, Pods in `kube-system`, nodes and webhook configurations ([records/02-identity.json](records/02-identity.json)). |
| Profile | [records/03-profile.json](records/03-profile.json): that kubeconfig and context, API server `https://127.0.0.1:16443`, the pinned image, `runner.serverUrl` `https://10.0.2.2:13711`, `admission.managerUsername` the ServiceAccount, the webhook token's SHA-256; a budget of two runners (1 CPU, 1536Mi, 2 Pods and attachments), 2Gi volumes; lifecycle `maxAttempts` 20, backoff 5–60 s, poll 5 s, heartbeat fresh 120 s, startup deadline 12 h. |
| Admission | k3s's API server restarted at 19:51:18 with exactly one `--admission-control-config-file` (its journal; the boot before had none), whose WebhookAdmissionConfiguration gives the user `10.0.2.2:13711` the webhook's bearer token; ValidatingWebhookConfiguration `orbit-managed-runner-pods` from [the repository template](../../../../deploy/managed-runner/admission/pod-admission-webhook.template.json): `failurePolicy: Fail`, CREATE and UPDATE of `pods` and `pods/ephemeralcontainers`, the namespace selector, no object selector ([records/07-admission-install.json](records/07-admission-install.json)). Removed again at 20:19:30 ([records/62-admission-remove.json](records/62-admission-remove.json)). |
| No model | The owner's key was not needed. The runners never had a runtime signed in, so they stayed STARTING with `MODEL_UNAVAILABLE` (heartbeating, claiming allowed); READY was never reached. |

The driver is [scripts/managed-runner/lab/single-writer.py](../../../../scripts/managed-runner/lab/single-writer.py); the
two longer sequences ran from [kit/vm-restart.sh](kit/vm-restart.sh) and [kit/graceful-delete.sh](kit/graceful-delete.sh).
Every record is that command's JSON output. No record holds a credential: a scan of all of them and of the logs for the
webhook token, the manager's token, every runner credential, the owners' tokens and passwords and the server's secrets
found none.

## 1. A second Pod on the same node and claim is refused; the first keeps running

**Before the guard existed** (19:50:48–19:50:53, [records/05-watch-no-guard.jsonl](records/05-watch-no-guard.jsonl),
[records/06-mapping-no-guard.json](records/06-mapping-no-guard.json)): the owner's sign-in provisioned PVC
`mr-data-01a14b6a-bbb3-703c-9da2-52e164ebf799` (UID `d5299c21…`), its PV and RBD image `orbit-mr-rbd/csi-vol-73e7db32…`
and generation 1's Secret; then the manager's dry-run probe was admitted and it stopped:
`ADMISSION_GUARD_MISSING: a Pod the single-Pod admission guard must refuse was admitted by a dry run`, FAILED,
retryable, no Pod. After `admission install`, a Pod naming no managed claim was admitted on a dry run (so k3s presented
the right token) and one naming an unowned `mr-data-<uuid>` claim refused `UNMAPPED_MANAGED_CLAIM`. The owner's retry
(19:51:59) then started generation 1: Pod `mr-01a14b6a-…` UID `38693fcf-9066-4dfa-9c27-c39b2124f3c9`, created
19:52:01, Running 19:52:10, first heartbeat 19:52:40 over TLS to `10.0.2.2:13711` ([records/09-watch-first-start.jsonl](records/09-watch-first-start.jsonl),
[records/10-mapping-gen1.json](records/10-mapping-gen1.json)).

**Second Pods**, 19:53:49–19:54:05, while the probe writer in the authorized Pod committed SQLite rows
([records/12-contenders.json](records/12-contenders.json)). Every one was pinned to the lab's only node and used the
same claim. Each answer is the API server's, quoted from kubectl or from the Job's events:

| Attempt | Who | Answer |
| --- | --- | --- |
| Unlabelled Pod, another name | cluster admin | `admission webhook "pods.managed-runner.orbit.dev" denied the request: orbit-managed-runner-admission: NOT_THE_MANAGER: only the managed runner manager may create a Pod that uses a managed runner volume` |
| Unlabelled Pod, another name | the manager's ServiceAccount | `NOT_THE_FIXED_NAME: the one Pod of this volume is mr-01a14b6a-bbb3-703c-9da2-52e164ebf799` |
| Copy of the authorized Pod (labels, annotations, pinned image, volumes), another name | the manager | `NOT_THE_FIXED_NAME` |
| The same copy under its own fixed name | the manager | `NOT_RESERVED: generation 1 has no Pod creation reserved (STARTING)` |
| The fixed name for generation 2 | the manager | `NOT_THE_RESERVED_GENERATION: the reserved generation is 1` |
| A Job whose Pod uses the claim | the Job controller | `FailedCreate: Error creating: admission webhook ... NOT_THE_MANAGER`; no Pod created |
| An ephemeral container mounting `user-state`, added to the authorized Pod | cluster admin | `EPHEMERAL_CONTAINER: no container may be added to a managed runner Pod` |

The authorized Pod, before and after: the same UID, `Running`, the only Pod using the claim, one VolumeAttachment, the
writer at 151 then 211 committed rows, the runner ONLINE. In the guest the RBD device `/dev/rbd1` was mounted at the
CSI staging path and in that Pod's volume directory only ([records/13-storage-gen1.json](records/13-storage-gen1.json)).
In L0's run, without a guard, an unlabelled second Pod on the same RWO claim was admitted, ran and wrote ([the lab page](../../../managed-runner-lab.md#access-modes)).

**When the guard cannot answer** ([records/14-outage-front.json](records/14-outage-front.json),
[records/15-outage-database.json](records/15-outage-database.json)): with the TLS front stopped, the unlabelled Pod and
even a Pod with no claim were refused (`failed calling webhook ... dial tcp 10.0.2.2:13711: connect: connection
refused`); with the test server's PostgreSQL stopped, the Pod on the claim was refused (`failed calling webhook`) and one
with no claim admitted, since that decision reads no row. After each restore the API server reached the guard again
(a Pod with no claim admitted on a dry run).

## 2. Generation-bound credentials and the fencing gate

**A new generation** (D7's rule, [records/19-signal-term.json](records/19-signal-term.json),
[records/20-watch-term-restart.jsonl](records/20-watch-term-restart.jsonl), [logs/manager-warnings.txt](logs/manager-warnings.txt)):
SIGTERM to the runner's PID 1 at 19:57:07, as the kubelet sends it; the runner exited 0 and the Pod was `Succeeded`.
The manager logged `POD_TERMINATED: Pod 38693fcf… of generation 1 stopped in STARTING with exit code 0, not out of memory;
starting generation 2 on the same volume in 4 s (attempt 1 of 20)`, recorded `OBSERVED_STOP`, went REQUESTED with
`POD_RESTARTING`; the VolumeAttachment had gone once the Pod ended (19:57:13). After the backoff it deleted the Pod by
UID (19:57:17), found nothing holding the volume, logged `generation 1 retired (OBSERVED_STOP); generation 2 reserved`,
issued generation 2's Secret and created Pod `c99d2b99-30b5-4b90-af52-00d2bd3a23fa` (19:57:18, Running 19:57:27).

**The old generation's credential at the runner door**: each generation's credential was read from its bootstrap Secret
while it ran (kept at mode 0600, never printed; [records/17-credential-save-gen1.json](records/17-credential-save-gen1.json))
and replayed against `GET /api/runner/me`, `POST /api/runner/heartbeat` and `GET /api/runner/sessions/claim`:

| When | Credential and instance it names | Answer |
| --- | --- | --- |
| Generation 1 running ([18](records/18-replay-gen1-current.json)) | generation 1, its own Pod | 200 (read only) |
| | generation 1, no instance declaration | 403 `MANAGED_RUNNER_INSTANCE_REQUIRED` |
| | generation 1, another Pod UID | 403 `MANAGED_RUNNER_INSTANCE_NOT_AUTHORIZED` |
| | generation 1 naming generation 2 | 403 `MANAGED_RUNNER_INSTANCE_NOT_AUTHORIZED` ("never authorized") |
| Generation 2 running ([23](records/23-replay-after-gen2.json)) | generation 1, its own Pod, or naming generation 2's Pod | **401 `invalid runner token`** at all three routes |
| | generation 2 naming generation 1 and its Pod | **403 `MANAGED_RUNNER_INSTANCE_SUPERSEDED`** "Generation 1 of this managed runner has been replaced by generation 2" |
| | generation 2, its own Pod | 200 (read only) |
| Generation 3 running, after the VM restart ([34](records/34-replay-after-gen3.json)) | generations 1 and 2 | 401 at all three routes |
| | generation 3 naming generation 1 or 2 | 403 `SUPERSEDED` |
| Fencing ([40](records/40-replay-while-fencing.json), [58](records/58-replay-b-fenced.json)) | every saved credential, the current one included | 401: the fence replaced it |

Only `GET /runner/me` was sent with an authorized credential: a heartbeat or a claim from outside would have acted as the runner.

**No stop proof, no next generation.** Two Pods disappeared without the manager recording the kubelet's report:

- An operator's graceful `kubectl delete pod` of generation 3 (Pod `e8bc0c13-e7ae-4064-8ecc-105e45b48d6e`) at 20:05:26.3
  ([records/35-graceful-delete.txt](records/35-graceful-delete.txt), [records/36-watch-graceful-delete.jsonl](records/36-watch-graceful-delete.jsonl),
  [records/37-pod-events-graceful-delete.json](records/37-pod-events-graceful-delete.json)). The runner drained and the
  kubelet reported the Pod `Succeeded` (seen at 20:05:27.1), then deleted the object; the manager's next look found it
  gone: `FENCING: PREDECESSOR_STOP_UNPROVEN: Pod e8bc0c13… of generation 3 is gone without a stop proof` (20:05:27.9).
- A force delete (`--grace-period=0 --force`) of a second owner's generation-1 Pod `9d9277e3-a0fb-43bd-930d-ebd3c9725b87`
  at 20:12:45.3, with its writer running ([records/54-force-delete.json](records/54-force-delete.json),
  [records/55-watch-force-delete.jsonl](records/55-watch-force-delete.jsonl)): the object was gone at once and FENCING
  followed at 20:12:48.4. The second owner was made through the admin API, and its sign-in provisioned its own mapping,
  PVC (`mr-data-01a14b7d-…`, image `csi-vol-67891ddf…`) and Pod ([records/50-owner-b.json](records/50-owner-b.json),
  [records/51-watch-b-start.jsonl](records/51-watch-b-start.jsonl)).

Then, for 14 and 6 minutes until the window ended ([records/38-mapping-fenced.json](records/38-mapping-fenced.json),
[records/56-mapping-b-fenced.json](records/56-mapping-b-fenced.json), [records/60-storage-final-a.json](records/60-storage-final-a.json),
[records/61-storage-final-b.json](records/61-storage-final-b.json)): the generation stayed (3 and 1), the recorded Pod
UID, the bootstrap Secret, the PVC and the compute reservation were kept, no Pod was created, the VolumeAttachment went
and the RBD image had no watcher; the owner's retry answered 409 `MANAGED_RUNNER_TRANSITION_REFUSED`, "A FENCING managed
runner is not retried." ([39](records/39-retry-while-fencing.json), [57](records/57-retry-b-fenced.json)); the manager
identity's fixed-name Pods for generation 3 and 4 were refused `NOT_RESERVED: generation 3 has no Pod creation reserved
(FENCING)` and `NOT_THE_RESERVED_GENERATION` ([43](records/43-create-during-fencing.json)). An incomplete receipt in
`mr-fence-<runner>` (a STORAGE_FENCE naming another Pod UID, with a temporary, expiring blocklist and no rejoin policy;
[41](records/41-receipt-invalid.json)) was refused field by field and changed nothing but the reason:
`FENCING_RECEIPT_INVALID` ([42](records/42-watch-receipt.jsonl)).

## 3. Data after the Pod's recreation and the VM restart

The repository's probe payload ([ceph-rbd-payload.py](../../../../scripts/managed-runner/ceph-rbd-payload.py), its root moved
under the runner's home, which UID 10001 owns) ran inside the runner container of the authorized Pod: an ordinary file, a
Git repository, SQLite rows in WAL mode with `synchronous=FULL` written every 0.1 s, plus 32 MiB of random data.

| Snapshot | Instance | Ordinary file SHA-256 | Git HEAD (fsck) | SQLite | random.bin SHA-256 |
| --- | --- | --- | --- | --- | --- |
| S1, quiesced, 19:56:08 ([16](records/16-snapshot-s1-gen1.json)) | generation 1, Pod `38693fcf…` | `69741060…bf379a62` | `195ffdfa…80ca` (clean) | `ok`, WAL, 606 rows, row hash `760fc5d2…cebf1a74` | `27003188…406e3b88` |
| S2 after the recreation, 19:58:37 ([24](records/24-snapshot-s2-gen2.json)) | generation 2, Pod `c99d2b99…` | same | same (clean) | `ok`, WAL, 606 rows, same row hash | same |
| S3 after the VM restart, 20:04:37 ([30](records/30-snapshot-s3-after-vm-restart.json), [31](records/31-snapshot-s3-prefix606.json)) | generation 3, Pod `e8bc0c13…` | same | same (clean) | `ok`, WAL, 877 rows = 877 acknowledged on disk (876 read just before the shutdown); rows 1–606 hash `760fc5d2…` as in S1 | same |

The writer ran again in generation 2 from 19:59:25 until the shutdown, so S3 checks that every row the writer had
acknowledged durably survived. On the volume, `managed-instance.json` named generation 1, 2 and 3 in turn and the
runner's `config.json` and `container-identity.json` kept the same runner ID, server and work directory.

**The VM restart** ([records/27-vm-restart.txt](records/27-vm-restart.txt), [records/28-watch-vm-restart.jsonl](records/28-watch-vm-restart.jsonl),
[records/29-watch-gen3-start.jsonl](records/29-watch-gen3-start.jsonl), [records/63-guest-shutdown-journal.txt](records/63-guest-shutdown-journal.txt)):
`stop.sh` at 20:00:27; k3s stopped, `orbit-lab-rbd-release` stopped both Pods' containers, unmounted and unmapped
`rbd0`/`rbd1`, and the VM was off at 20:00:42; `start.sh` at 20:01:02, healthy at 20:02:48. While the API server was
unreachable the manager logged `transient failure 2/20` to `5/20`. After the boot the kubelet reported generation 2's
runner stopped (exit 0) at 20:02:19; the manager logged `POD_TERMINATED … starting generation 3 on the same volume in
56 s (attempt 6 of 20)` and `generation 2 retired (OBSERVED_STOP); generation 3 reserved` at 20:03:21; Pod `e8bc0c13…`
was Running at 20:03:35.

**Storage at each stage** ([13](records/13-storage-gen1.json), [25](records/25-storage-gen2.json),
[32](records/32-storage-after-vm-restart.json), [60](records/60-storage-final-a.json), [61](records/61-storage-final-b.json)):

| Stage | PVC / PV | RBD image (pool `orbit-mr-rbd`) | Guest | Ceph |
| --- | --- | --- | --- | --- |
| Generation 1 | `mr-data-01a14b6a-…` Bound, RWO, `runner-data`; PV `pvc-d5299c21…` Retain, handle `0001-0024-12b3f1b2-…-73e7db32-…`, ext4 | `csi-vol-73e7db32…`, 2 GiB, `layering`; one watcher, the guest's kernel client | `/dev/rbd1` at the CSI staging path and Pod `38693fcf…` only; VolumeAttachment `csi-415eea4c…` | HEALTH_OK, 3 of 3 OSDs up and in, 33 PGs active+clean, osdmap 97 |
| Generation 2 | the same UIDs and handle | the same image; a new watch cookie: unmapped and mapped again | `/dev/rbd1` at staging and Pod `c99d2b99…` only; the attachment deleted and made again | HEALTH_OK, osdmap 97 |
| After the VM restart, generation 3 | the same | the same; the new boot's kernel client | new boot ID; `/dev/rbd1` at staging and Pod `e8bc0c13…` only | HEALTH_OK, osdmap 107, 33 PGs active+clean |
| Both mappings fenced, the end | both PVCs Bound, PVs Retain | `csi-vol-73e7db32…` and `csi-vol-67891ddf…`: no watchers | neither mapped; only L0's retained smoke Pod holds `/dev/rbd0` | HEALTH_OK |

## What D7's rule did here, and what differed from expectations

- A runner that stops with the kubelet's report is started again as the next generation, through the gate, on the same
  PVC: seen for a SIGTERM and for the VM restart, as D7 says. It works in STARTING too, which is where these runners
  were all along.
- **An operator's graceful `kubectl delete pod` fences instead.** The kubelet did report the stop, but the report is in
  the API only until the kubelet's final delete of the object, here under a second; the manager polls every
  `pollIntervalSeconds` (5 s here) and found the Pod gone. Safe, as designed ("an instance gone ... fences"), but any
  graceful removal it does not drive itself — `kubectl delete`, the Eviction API, `kubectl drain --force` — will
  usually cost an operator's fencing receipt. Keeping the object until the manager has recorded the report (a
  finalizer the manager removes) or watching Pods would let such a stop be proven. Not changed here.
- **While STARTING, an outage spends restart attempts.** STARTING is not one of the observing states, so each pass that
  could not reach the API server spent an attempt: the two-minute VM restart took attempts 2–5, and the following
  restart then waited a 56 s backoff. With these 20 attempts and the 60 s ceiling, an outage of about 15 minutes would
  end such a runner `FAILED RETRY_EXHAUSTED`. A READY runner spends nothing while it only looks. Here the runners were
  STARTING only because no model was signed in.
- Right after the boot the API server still showed generation 2's Pod `Running` and its last heartbeat was within
  `heartbeatFreshSeconds`, so for 8 s the manager wrote `MODEL_UNAVAILABLE` again before the kubelet's report came; no
  effect beyond that reason.

## Not established here

- Everything across nodes: refusing a second Pod on another node, mounting on a second node, a normal migration, takeover
  after the old node stops or is fenced, and the old node's writes after a takeover. One node, one failure domain.
- An accepted fencing receipt and the path from FENCING to the next generation: on the only node a power-off would stop
  the cluster itself, and no storage fence procedure is tested. Both mappings were left FENCING.
- That an old instance's processes can still write after its object is gone: in the force delete the kubelet had
  removed the containers within about a second.
- READY and everything that needs a model: no runtime was signed in.
- Two managers, a real admission race between concurrent creates of the fixed name, and the guard behind a cluster
  Service: one test server answered the webhook through the QEMU user network.
- Hardware durability: the three replicas share one VM and one HDD; kernel RBD and the OSDs share one kernel.

## Left in the lab

The webhook configuration was removed (with no test server answering it would refuse every Pod create in
`orbit-mr-test`); `single-writer.py admission install` puts it back for the next window. Kept: k3s's AdmissionConfiguration
in `/etc/rancher/k3s/orbit-admission` and its drop-in (a token for `10.0.2.2:13711` only), the manager's ServiceAccount,
RBAC and token Secret, the two retained PVCs with their PVs and RBD images and their bootstrap Secrets (whose
credentials no runner row accepts any more), and the test server's state in `test-server-t02a`. L0's and T03's objects
were not touched. The VM and the test server are off.

## Checks

On the landing merge `d7e9824e4`: this branch's commit `08b88e56a` with origin/main `8670932a4`. The project line
(292b2eb43) was already in the branch and had not moved. One step after another in a transient unit outside the
runner's cgroup (`MemoryMax=9G`), with the lab VM off ([kit/gate.sh](kit/gate.sh), [logs/gate-steps.txt](logs/gate-steps.txt),
[logs/gate-results.txt](logs/gate-results.txt)):

| Step | Result |
| --- | --- |
| `npm run test:compose-topology` | 14 of 14 |
| `npm run prisma:generate`, `npm run build` | exit 0 |
| `npm test -w @orbit/shared` | 490 of 490 (32 files) |
| `npm test -w @orbit/apiserver` | 5318 of 5318 |
| `npm test -w @orbit/web` | 5371 of 5371 (414 files) |
| managed-runner Python, `python3 -B -m unittest discover -s scripts/managed-runner -p '*test*.py'` | 150 tests OK, the five new `SingleWriterLabTest` cases among them |
| every managed-runner pg spec, `scripts/run-pg-spec.sh src/apiserver/src/managed-runners/*.pg.spec.ts` | 12 specs, 116 cases, none failed or skipped: docker-backend 13, account-disabled 5, backend 7, boot 5, capacity 7, existing 3, fencing 16, manager 14, recovery 14, sign-in 12, sleep 10, wake 10 |

No product code changed: the delivery is lab tooling (`scripts/managed-runner/lab/`), its offline tests, the lab page, one
row of the design record and this evidence, so runner-go's `go test ./...` was not run. This README's checks section and
the gate's script and logs were added to the merge commit afterwards; it changed nothing else.
