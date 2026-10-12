# Optional Ceph RBD storage preparation

This directory prepares the storage contract in [the managed runner design](../../../docs/managed-runner-design.md).
It is independent of Compose, release, upgrade, and normal application startup. Managed runners
remain disabled by default. No file here installs Ceph, Rook, CSI, admission infrastructure, or a
workload, and the renderer never applies a manifest.

The owner confirmed at **2026-10-04T07:26:13Z** that no non-production test cluster is currently
available. The actual T01 topology, storage specifications, supported installation, and credentials
remain pending. The design's preference for external test Ceph does not confirm that production
or a future test cluster uses external Ceph. Neither an in-cluster Rook deployment nor infrastructure
purchase is an automatic fallback. This delivery establishes preparation, not storage acceptance.

## Files and offline use

| File | Purpose |
| --- | --- |
| `environment.example.json` | Parameter contract; `valueKind: example`, placeholders and pending values are not environment facts or authorization. |
| `csi-config.template.json` | Reference ConfigMap containing the CSI cluster-to-MON mapping; storage owner integrates it through the existing supported deployment. |
| `storageclass.template.json` | Explicit, non-default `runner-data` RBD class. |
| `pvc.template.json` | One independent filesystem PVC for one user, with no compute owner reference. |
| `backup-request.example.json` | Independent backup request contract for the storage owner's existing export/backup workflow; no backup is performed. |

The templates use JSON, which Kubernetes accepts as a manifest format. Whole-value `${field.path}`
tokens refer to the environment contract. The renderer constructs `cephCSIConfigJSON` as the JSON
string containing `[{"clusterID": ..., "monitors": [...]}]`; it does not interpolate credentials.

Run these commands from the repository root, without Kubernetes or Ceph access:

```sh
python3 scripts/managed-runner/ceph_rbd.py check --environment deploy/managed-runner/storage/environment.example.json
python3 scripts/managed-runner/ceph_rbd.py render --environment deploy/managed-runner/storage/environment.example.json --output /tmp/orbit-rbd-example
python3 scripts/managed-runner/test_ceph_rbd.py
```

An example render remains unusable against a cluster. Static JSON/template checks establish only
the declared contract. Local ordinary-file, Git and SQLite probes establish only the probe's
behavior. They establish no Ceph mount, exclusivity, fencing, migration, failover, or actual timing.
See [the isolated verification tools](../../../scripts/managed-runner/README.md) for the exact CLI,
operator receipt format, and offline tests.

## Inputs required from the test and storage owners

Copy the example to a separately supplied actual environment file and replace every pending
execution input. Independent backup status stays pending until its separate restore is proved.
The copy must record `valueKind: actual` and documented authorization; a local boolean alone does
not grant permission. Do not place kubeconfig contents or Ceph keys in this directory, an image,
an evidence artifact, or a committed actual environment file.

| Contract fields | Required actual evidence |
| --- | --- |
| `authorization.reference`, `nonProduction`, `allowedOperations` | Explicit authorization for a non-production context and named resource scope; separate authority for faults and backup. Allowed harness operations are `create-test-pods`, `delete-test-pods`, `exec-test-pods`, and `fault-resume`, each opt-in. |
| `kubernetes.kubeconfig`, `context`, `apiServer` | Explicit kubeconfig path, confirmed named context and expected API endpoint. Never use the user's unconfirmed current/default context or in-cluster discovery. |
| `kubernetes.namespace`, `namespaceUID`, `nodeA`, `nodeB` | Dedicated, already authorized namespace and two eligible distinct nodes, each with its real UID. Recreated objects require a new reviewed profile. |
| `ceph.topology`, `fsid` | T01 owner decision: existing external Ceph or existing Rook-managed Ceph; record provider, ownership, installed version and FSID. |
| `ceph.monitors`, network evidence references | Actual MON endpoints and reachability of every client-advertised OSD from CSI components and both nodes; routes, DNS, MTU, firewall and security policy. |
| `ceph.pool`, `replicaCount`, `minSize`, `crushFailureDomain` | Storage-owner approved, initialized replicated test pool; CRUSH rule/device class, capacity/headroom, PG policy and healthy state. Null/example numbers are not defaults. |
| `csi.clusterID`, `driver`, `namespace`, `configMapName`, `configurationOwner` | Installed CSI driver and integration owner: `raw`, `operator`, or `rook`. Match the configured cluster entry, immutable clusterID and approved pool; do not install a competing driver. |
| `csi.secretRefs` | Existing provisioner, controller-publish, controller-expand and node-stage Secret names/namespaces owned by infrastructure. Key material is excluded. |
| `ceph.cephXCapabilitiesEvidenceRef`, `cephXKeyCompatibilityEvidenceRef` | Storage-owner evidence of real client identity/caps and CephX key compatibility across CSI libraries and both vendor-supported node kernels. |
| `storage.ownerID`, `runnerID`, `pvcName`, `capacity` | Real owner/runner mapping and explicit approved per-user capacity. Use `mr-data-<runner-uuid>`; preserve the recorded PVC UID and volume identity on adoption. |
| `versions.*`, `compatibilityEvidenceRef` | Exact server/kubelet/runtime, Ceph, CSI/operator/sidecar digests, Rook when applicable, both node kernels/vendor support, RBD/ext4 modules, CephX key type and validated compatibility. |
| `protection.*` | Deployed fail-closed single-Pod admission/reservation and verified fencing procedure; controller forced-detach policy reviewed by the test owner. |
| `verification.*` | Approved immutable probe image containing Python 3 and Git, reserved manager ServiceAccount/annotation, precise admission denial marker, bounded timeout, and trusted receipt authorities. |
| `backup.*` | Independent destination, credential/encryption/retention policy and restore evidence; `pending` establishes no backup. |

`csi.clusterID` is the identifier used by the installed CSI configuration. It is often the FSID for
direct Ceph-CSI integration, while Rook may use its Ceph namespace. Record the FSID separately;
do not substitute it for an existing Rook identifier. The StorageClass and CSI mapping must agree.
The driver is likewise explicit: examples such as `rbd.csi.ceph.com` or
`rook-ceph.rbd.csi.ceph.com` are illustrative, not discovered actual values.
[Ceph-CSI's versioned class parameters](https://github.com/ceph/ceph-csi/blob/v3.18.0/examples/rbd/storageclass.yaml)
and [Rook's RBD integration](https://rook.io/docs/rook/latest/Storage-Configuration/Block-Storage-RBD/block-storage/)
describe these deployment-specific values.

For `configurationOwner: raw`, the ConfigMap is an integration fragment for storage-owner review.
For `operator` or `rook`, use the original owner's supported resources instead of applying it.
A one-entry ConfigMap must not overwrite a shared cluster list, an operator-managed ConfigMap,
or a production object. Class creation and PVC provisioning are
separate, explicitly authorized test-owner actions; this harness assumes they already exist.
`runner-data` is cluster-scoped: an existing unrelated class with that name is a conflict requiring
the owner's resolution, not permission to update it.

## Selected storage profile and credentials

The first profile is `ReadWriteOnce`, `Filesystem`, ext4 on kernel RBD (`krbd`), `layering`, no
mounter fallback, `Immediate` binding, `Retain`, and expansion disabled. The Ceph-CSI `mounter`
parameter is **`rbd`**, its kernel-mounter identifier; `krbd` describes the kernel implementation
and is not that parameter's value. All eligible test nodes
must reach the same approved pool. Capacity, replication and CRUSH choices remain owner inputs;
the templates do not change pools, pool quotas, OSDs, replica counts, CRUSH rules or production CSI.
[Versioned Ceph-CSI mounter identifiers](https://github.com/ceph/ceph-csi/blob/v3.18.0/internal/rbd/rbd_util.go).

Ceph-CSI **v3.18.0** marks RBD filesystem RWO GA and RWOP Alpha, with Kubernetes 1.34–1.36 in its
tested matrix. This reference does not claim an installed stack or make the old Ceph feature
minimum a production recommendation. Recheck the selected distribution/operator/Ceph maintenance
windows and security patches before enablement. Verify each kernel's RBD features, ext4, CephX
key-format support and authentication by actual map/mount behavior. An `rbd-nbd` fallback or an
extra image feature requires a separate supported-profile review.
[Ceph-CSI v3.18.0 matrix](https://github.com/ceph/ceph-csi/blob/v3.18.0/README.md#support-matrix).

For Ceph's `aes256k` keys, record the required upstream kernel support or the actual vendor
backport on each node, along with CSI client-library compatibility. Do not infer support from
a generic kernel version floor, silently downgrade keys, or alter production authentication.
[Ceph security release compatibility guidance](https://ceph.io/en/news/blog/2026/v20-2-4-v19-2-6-combo-released/).

For the baseline CSI identity, the documented pool-scoped caps are:

```text
mon: profile rbd
osd: profile rbd pool=<approved-test-pool>
mgr: profile rbd pool=<approved-test-pool>
```

The storage owner checks these against the pinned installation, prepares/rotates the CSI Secrets
through its protected process, and verifies the actual client identity. Never use `client.admin`
or `allow *` for user-volume CSI operations. Distinct node/provisioner identities or namespace caps
must be supported by that installation. Pool isolation is not per-user cryptographic isolation.
Backup and fencing operators have separate authority. Neither the runner user process nor the
apiserver manager receives CephX keys or infrastructure Secret mounts.
[Versioned CSI capability guidance](https://github.com/ceph/ceph-csi/blob/v3.18.0/docs/capabilities.md).

Direct Ceph-CSI RBD Secret `userID` contains the identity without the `client.` prefix; the
owner checks the installed Rook/operator Secret schema rather than replacing it with a guessed
direct-driver Secret. Keep `userKey` only in the protected Secret delivery mechanism.
[Versioned RBD Secret shape](https://github.com/ceph/ceph-csi/blob/v3.18.0/examples/rbd/secret.yaml).

CSI and nodes need Ceph's client/public MON **and OSD** connectivity; access to the API endpoint or
one MON is insufficient. Record actual configured addresses/ports rather than opening generic
ranges. A separate Ceph cluster network carries OSD replication/recovery, not runner traffic.
No network/firewall mutation is included here.
[Ceph network reference](https://docs.ceph.com/en/tentacle/rados/configuration/network-config-ref/).

## Single Pod protection and fencing prerequisites

RWO allows multiple Pods on one node. RBD `exclusive-lock` coordinates RBD clients but does not
protect two concurrently mounted ext4 filesystems. This profile therefore depends on the
controller/admission contract in the design; the templates alone cannot enforce single-Pod use.
[Kubernetes access modes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#access-modes),
[Ceph exclusive locks](https://docs.ceph.com/en/latest/rbd/rbd-exclusive-locks/).

Before allowing any test Pod, the owner must deploy an admission guard with `failurePolicy: Fail`
that resolves the managed PVC/mapping and permits only the reserved fixed Pod name, generation,
manager ServiceAccount and approved security/image template. It covers every reference to the PVC,
including unlabelled/read-only Pods and updates/subresources; tenant rights cannot bypass it.
PVC annotations in this template record identity only and do not grant permission. Reservations
must be atomic and durable, not a racy list-then-create check. The harness does not install or fake
this guard, create mapping reservations, or treat an unrelated RBAC/image error as a passing denial.

Normal migration requires predecessor drain, process exit, successful unpublish/unstage and RBD
unmap, plus preserved identity before the next reservation. A missing Pod/VolumeAttachment object
alone is insufficient. For failure takeover, the infrastructure operator first stops and verifies
power-off of the exact old node, quarantines it, or supplies an independently validated persistent
fencing mechanism. The receipt binds the old Pod UID, node UID, PVC/PV UIDs, volume handle/image and
generation. The old node must remain unable to write or reconnect after takeover.

The harness never powers off nodes, applies out-of-service taints, breaks RBD locks, changes
blocklists, force-deletes Pods, or forces detach. Those require the owner's authorized runbook and
independent evidence. Lost heartbeats, `NotReady`, cordon, API deletion, RWO and timeout-driven
detach do not establish fencing. Kubernetes' out-of-service procedure requires confirming shutdown
first; use it only after that operator evidence exists.
[Kubernetes non-graceful shutdown guidance](https://kubernetes.io/docs/concepts/cluster-administration/node-shutdown/#non-graceful-node-shutdown).

## Retention and independent backup entry

Sleep/delete removes compute only after drain or confirmed fencing and detach. Keep the PVC,
bound PV and RBD image, with their recorded identities; there is no Pod/Job owner reference.
Deleting a user/runner mapping must not silently delete retained storage. `Retain` protects a
released PV's backing asset, while normal retention keeps the PVC bound. Explicit data destruction
is a separate authorized operation after retention/backup review; no cleanup script here deletes
PVCs, PVs, snapshots or RBD images. Expansion remains disabled until quota and growth are verified.

Replication provides availability within its configured failure domain. A same-cluster RBD/CSI
snapshot provides an earlier state within that cluster. Neither proves an independently recoverable
backup. The separate entry is `backup-request.example.json`, submitted to the existing storage-owner
backup workflow after filling real identity, stop/unmap evidence and independent destination.

The baseline backup workflow is:

1. Explicitly authorize one owner/volume and backup destination. Drain the original writer and
   verify stop, CSI detach/unmap and absence of old clients. Record mapping and filesystem/database
   quiescence; do not launch a backup Pod concurrently against the original RWO PVC.
2. Through the storage owner's supported authenticated workflow, export the quiesced RBD image
   to the approved independent destination. Ceph provides an `rbd export` entry; this repository
   neither runs it nor assumes a default Ceph cluster/keyring.
3. Encrypt and retain the copy under independent credentials/failure-domain policy, record its
   digest and identity, and restore to a **new test image/PVC** in an authorized scope. Check ordinary
   files, Git metadata and SQLite integrity, plus the full persistent runner layout when available.
4. Record restore timing/result and only then update backup status. The probe's generated test
   database is not a backup of the complete runner home or application data.

This is a cold backup entry. A future live application backup must separately coordinate all
writers and SQLite's backup API; copying only a database file while WAL writes run is insufficient.
CephFS/RWX must not carry the SQLite WAL runtime state.
[Ceph export command](https://docs.ceph.com/en/latest/man/8/rbd/#cmdoption-rbd-arg-export),
[SQLite WAL constraints](https://www.sqlite.org/wal.html),
[SQLite online backup](https://www.sqlite.org/backup.html).

## Remaining acceptance and handoff

The authorized multi-node session must retain actual versions and access mode; same-node and
cross-node duplicate Pod admission denials; clean drain/unmap then remount of the original volume
on node B; power-off or independently proven fencing followed by recovery; and evidence that the
old writer cannot resume. Record SHA-256 values, Git checks, SQLite integrity/recovered committed
state, PVC/PV/RBD image mapping, Pod/node identities, mount/unmap and Ceph health at each phase,
plus monotonic and wall-clock timings. Operator receipts supplement actual observations; a receipt
flag without source evidence proves nothing.

Until the owners supply the test cluster, resource/fault authorization, actual T01 topology/specs,
compatible nodes/CSI, real admission/reservation and fencing authority, these tests remain
**NOT RUN**. Report this preparation and reproducible offline checks as a stage to the coordinator;
do not request task DONE or label local/static probes as overall acceptance.
