# Optional Ceph RBD test probe

These scripts are separate from every normal deployment/start/release entry point.
No cluster has been supplied; all live phases are **NOT EXECUTED**. Offline checks
and probe unit tests do not establish Ceph storage acceptance.

`ceph_rbd.py check/render` prepares optional manifests locally. The live probe
`ceph-rbd-verify.py` consumes a **precreated dedicated disposable test PVC**; it
never installs CSI or applies a StorageClass/PVC/configuration. Follow the
[storage integration runbook](../../deploy/managed-runner/storage/README.md)
first. The approved image must contain Python 3 and Git and support UID/GID 1000,
the fixed restricted security template, and a read-only root filesystem.

The actual environment file must identify an authorized non-production kubeconfig,
context, API server, namespace UID, two distinct node UIDs, exact reviewed versions,
storage profile, admission guard, fencing procedure, and trusted receipt authorities.
Example/pending values cannot run live. Every invocation requires explicit
`--environment --context --namespace --execute --output`; the output directory must
be new. Allowed operations are phase-specific (`create-test-pods`,
`delete-test-pods`, `exec-test-pods`; additionally `fault-resume` for takeover).

Before every Kubernetes write the probe checks context/API server, namespace and
node UIDs, PVC/PV/CSI-handle identity and the reserved API request user. It validates
the observed SC, CSI MON configuration, PVC ownership, Secret references, kernel,
RWO/Filesystem/ext4/RBD profile and Retain policy. No Secret data is read. The
single valid Pod name is `<verification.podNamePrefix>-<storage.runnerID>`; its
reservation annotation and service account must match the **existing admission
integration**. This probe does not implement or update manager reservations.

## Staged invocation

The following variables are placeholders, not supplied environment facts. Obtain
the actual values and receipts from the authorized test owner before replacing them.

```bash
CEPH_TEST_ENV='/secure/REPLACE_ME.actual.json'
CEPH_TEST_CONTEXT='REPLACE_ME'
CEPH_TEST_NAMESPACE='REPLACE_ME'
ceph_probe() {
  python3 scripts/managed-runner/ceph-rbd-verify.py \
    --environment "$CEPH_TEST_ENV" --context "$CEPH_TEST_CONTEXT" \
    --namespace "$CEPH_TEST_NAMESPACE" --execute "$@"
}

ceph_probe --phase baseline --receipt receipts/initial-reservation.json \
  --output evidence/01-baseline
ceph_probe --phase duplicates --state evidence/01-baseline/report.json \
  --output evidence/02-duplicates
ceph_probe --phase migration-stop --state evidence/02-duplicates/report.json \
  --output evidence/03-stop
# Operator: verify normal CSI unpublish/unstage, old-node unmap and no mounts/clients;
# retire the predecessor and reserve the same fixed Pod name/new generation on B.
ceph_probe --phase migration-resume --state evidence/03-stop/report.json \
  --receipt receipts/normal-detach-and-reservation.json --output evidence/04-migrate
ceph_probe --phase fault-snapshot --state evidence/04-migrate/report.json \
  --output evidence/05-pre-fault
# Operator: power off and independently verify B, quarantine B against restart/rejoin;
# only then perform the authorized out-of-service/detach runbook and remove old Pod
# state. Reserve the same fixed Pod name/new generation on A, with a fence receipt.
ceph_probe --phase fault-resume --state evidence/05-pre-fault/report.json \
  --receipt receipts/power-off-fence-and-reservation.json --output evidence/06-fault
```

Each phase must consume the immediately previous successful report with the same
environment hash and volume identities. Baseline writes an ordinary file, a Git
repository, and continuously committed SQLite WAL transactions (`synchronous=FULL`).
The writer fsyncs acknowledgement records; snapshots save row counts and hashes.
Duplicates use differently named, **unlabelled** Pods on A and B with the same
approved command/security/image/PVC. Only the configured admission guard's explicit
denial counts; RBAC errors, name conflicts, RWO Pending and attach failure do not.
A contender that is unexpectedly admitted stays inert, receives ordinary deletion
with an atomic Pod UID precondition, and aborts the probe for operator review.

Normal stop quiesces the writer, records its final snapshot, deletes with a Pod UID
precondition and ordinary grace, then observes API removal and VolumeAttachment
detach. It still requires independent node-unmap proof. Successors start paused
and require every original probe file/database/Git directory; missing data causes
failure, never reinitialization. Before resuming any writes the probe compares the
original file/Git hashes, all previously committed SQLite row hashes, acknowledged
counts, integrity and actual ext4 `/dev/rbdN` mount. Fault-snapshot explicitly
restarts writes on B and leaves WAL activity running for the operator's power-off.

No node power, force-delete, lock break, blocklist, taint, unmap or attachment removal
command exists in this probe. `NotReady`, elapsed time and attachment disappearance
never authorize takeover. First-version fault-resume accepts only operator-confirmed
power-off plus persistent quarantine and complete stop/unmap observations; storage
fencing alternatives remain outside this probe. Keep the old node quarantined until
the storage owner verifies safe rejoin. Test volumes remain retained; the script
does not delete PVCs/PVs or purge images.

## Operator receipt contract

JSON is a carrier for reviewed operator statements; matching JSON fields cannot
prove physical power-off, client cessation, admission correctness or Ceph health.
The test owner must independently review the referenced observations before
acceptance. `authorityRef` must identify an allowed authority already listed in the
actual environment. References must resolve to saved test-scope evidence and must
not contain credentials or example/pending placeholders.

Every receipt has these fields:

| Field | Required content |
| --- | --- |
| `schemaVersion` | `1` |
| `kind` | `reservation`, `normal-detach`, or `power-off-fence` |
| `authorityRef`, `observedAt` | Trusted authority reference and actual UTC observation time |
| `scope` | Exact `context`, `apiServer`, `namespace`, `namespaceUID`, `pvcName`, `pvcUID`, `pvName`, `pvUID`, `volumeHandle`, `cephFSID`, `pool`, `rbdImage`, `podName` |
| `rbdImageMappingRef` | Storage-owner observation linking that actual CSI handle/PV to the pool/image; never decode or guess the handle |
| `reservation` | `podName`, integer `generation`, `nodeName`, `nodeUID`, `requestUser`, `reservationRef`, `admissionPolicyRef`; new generation reserved atomically by the manager |
| `detach` | All of `allContainersStopped`, `csiUnpublished`, `csiUnstaged`, `deviceUnmapped`, `noMountsOrClients` equal `true`, plus nonempty `observationRefs` |

For an initial reservation, `detach` is the owner's clean-volume assurance: a new
unused image or independently verified absence of old writers/maps/clients. A bound
PVC and empty attachment list alone do not establish that assurance. No unrelated
or existing user data PVC is allowed for baseline initialization.

Both resume receipts also include `predecessor`, exactly copying the old report's
`pod` object (`podName`, `podUID`, `nodeName`, `nodeUID`, `generation`). The receipt
observation must be after `stopRequestedAt` or `faultSnapshotAt` in that report.
Migration reserves node B; fault-resume reserves node A. Generations strictly
increase and fixed-name Pod uniqueness is retained.

A power-off receipt additionally has `powerOffFence`:

```json
{
  "poweredOff": true,
  "quarantined": true,
  "controlActionRef": "REPLACE_ME-operator-control-record",
  "independentPowerOffObservationRef": "REPLACE_ME-independent-observation",
  "quarantineRef": "REPLACE_ME-persistent-quarantine-and-rejoin-policy",
  "outOfServiceRunbookRef": "REPLACE_ME-authorized-post-shutdown-detach-runbook",
  "validUntil": "REPLACE_ME-actual-UTC-time"
}
```

Control and independently observed power-off use separate evidence references.
`validUntil` must cover at least twice the operation timeout at entry and again
before each write, to cover creation/readiness and recovery. Expiring assurance
stops the probe and requires operator review; expiry never triggers takeover.

For complete storage evidence, include actual `cephHealth` (version, observed time,
health status and raw health evidence reference), `csiObservation` (actual driver/
sidecar versions and image digests with evidence), and `nodeStorageObservationRefs`
for scoped map/mount/unmap/kernel/network observations. Supply post-phase health
and mapping evidence separately where it cannot exist before a phase starts. A
configured evidence reference does not replace a contemporaneous observation.
Missing observations remain phase-specific gaps, including phases without a new
receipt. Independent backup/export/restore receipts follow the storage runbook;
probe data and same-cluster replication/snapshots are not independent backups.

## Evidence and failure handling

Each output retains `commands.jsonl` (timestamps, argv, mutation request bodies,
results and durations), `resources.json` (actual API/Node/CSI/SC/PVC/PV observations),
matching `volumeattachments.json`, created Pod manifest/UID, and `report.json` with
file/Git/SQLite checks, operator receipts, cumulative gaps and elapsed windows.
`migrationSeconds` measures stop request through recovered mount; `faultWindowSeconds`
measures pre-fault snapshot through recovery and includes operator response time.
Neither is an isolated CSI benchmark or a promise about future recovery time.

No report asserts overall completion: `clusterAcceptance` remains `INCOMPLETE` for
review of all real evidence and remaining tests. Missing cluster authorization,
ambiguous creates/timeouts, accepted contenders, identity/spec changes, stale or
expired receipts and failed checks stop further writes. Preserve the artifacts and
settle pending creates/predecessors with the test operator; do not advance a
generation or retry against a production/default/unknown context.
