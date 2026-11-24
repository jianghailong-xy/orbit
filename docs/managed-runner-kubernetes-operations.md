# Managed runners on Kubernetes: deployment, backup and restore, rollback and failover

This runbook is for an **authorized, isolated test environment** that runs managed runners on Kubernetes with Ceph RBD
storage: an Orbit apiserver with `ORBIT_MANAGED_RUNNERS_ENABLED=true` and a profile whose backend is Kubernetes.
Production deployment and enablement are outside the managed-runner project. Every account has a runner of its own: a
Pod `mr-<runner uuid>` in the managed namespace, its data claim `mr-data-<runner uuid>` (ReadWriteOnce, Filesystem, ext4
on kernel RBD), the claim's PersistentVolume (`Retain`) and an RBD image `csi-vol-…` in the runner pool. The volume holds
the account's checkouts, sessions, uploads, engine sign-ins and the runner's own identity; nothing else keeps a copy of
it. A deployment whose managed runners run on Docker has [its own runbook](managed-runner-docker-operations.md).

> **The .3 deployment (2026-11-16)** does **not** use the ext4/kernel-RBD baseline below. It runs on XFS with
> `mounter: rbd-nbd`, Ceph-CSI 3.18.2 carrying the local [XFS reflink patch](../deploy/managed-runner/csi-xfs-reflink/README.md),
> StorageClass `runner-data-xfs` with `reflink: enabled`, 100 GiB and 2 CPU/4 GiB per runner, on one node. See
> [the deployment record](managed-runner-k3s-xfs-deployment.md). Every ext4/kernel-RBD or "no clones" statement
> below describes the lab/test baseline; the record's values apply to production.

The procedures were run in the lab ([docs/managed-runner-lab.md](managed-runner-lab.md)): k3s v1.36.5, Ceph 20.2.4,
Ceph-CSI v3.18.0. The deployment steps are its scripts' (tasks L0, T02a and T04). Every other number comes from one of these
runs:

- task T08's end-to-end run of 2026-10-18 on one node ([evidence](evidence/managed-runner-acceptance/2026-10-18/README.md));
- task T08b's volume switch, the same day ([evidence](evidence/managed-runner-volume-switch/2026-10-18/README.md));
- task T02's move to another node and failover, on the lab's two nodes on 2026-10-19
  ([evidence](evidence/managed-runner-cross-node/2026-10-19/README.md));
- task T08x's two accounts on the same two nodes, the same day: moves, a failover of both runners at once with this
  page's commands, and drains ([evidence](evidence/managed-runner-cross-node-accounts/2026-10-19/README.md)).

What was not run is marked **Not verified here**. Read the [design contract](managed-runner-design.md)
first: this page says how to operate it, not why it is built so.

Conventions. Name the context and the namespace on every command, never a default:

```bash
K="kubectl --kubeconfig $ADMIN_KUBECONFIG --context $TEST_CONTEXT --namespace $MANAGED_NAMESPACE"
psql "$ORBIT_DATABASE_URL"   # the deployment's own database
```

`rbd` and `ceph` run on a Ceph admin host with an identity allowed to read the runner pool (in the lab: `cephadm shell`
inside the VM). The CSI driver's own CephX identity is never used for this.

## What there is to keep

| What | Where | Kept by |
| --- | --- | --- |
| Each account's runner data | RBD image `<pool>/csi-vol-…`, behind PV `pvc-…` and claim `mr-data-<runner uuid>` | Only this runbook's independent backups. Ceph replicas and same-cluster snapshots are not backups. |
| Which account has which runner, claim, PV, volume handle, Pod and generation, and in which state | PostgreSQL table `managed_runner` (with `runner` and `workspace`) | The deployment's [PostgreSQL backups](postgres-backup-restore.md) |
| The manager profile, the manager's kubeconfig (a ServiceAccount token) and the admission webhook's token | Files on the apiserver host that `ORBIT_MANAGED_RUNNERS_PROFILE` and the profile name (mode 0600) | Copy them with the PostgreSQL backups. Two of them are secrets. |
| The API server's admission configuration (the webhook's bearer token) | The control plane's configuration (in the lab: a k3s drop-in under `/etc/rancher/k3s/config.yaml.d/`) | The cluster operator |
| A generation's bootstrap Secret `mr-boot-<runner uuid>` | The managed namespace | Nothing to keep: each generation gets a new credential |
| Fencing receipts `mr-fence-<runner uuid>` | ConfigMaps in the managed namespace | The operator who wrote them, with the incident record |
| Who switched which runner to a restored volume, when, from which to which | PostgreSQL table `activity`, type `managed_runner.volume_switched` | The deployment's PostgreSQL backups |
| The runner image | The environment's registry, or each node's containerd, by digest | Rebuild it from the commit in `deploy/managed-runner/image`, or keep the archive |

A volume backup holds what the account signed in with (engine credentials) and a runner credential. Treat it like the
database backups: private, encrypted at rest under its own key, and outside the Ceph cluster's failure domain.

## Deploy a test environment

The order matters: storage first, then the manager's identity and the admission guard, and only then the switch. The lab
does every step with `scripts/managed-runner/lab/` (`create.sh`, `single-writer.py`, `test-server.sh`); a test cluster
supplied by its own owners does the same with that owner's tooling.

1. **Prerequisites.** The environment record of [the storage README](../deploy/managed-runner/storage/README.md): context,
   namespace and node allowlist, Kubernetes/Ceph/Ceph-CSI versions inside the CSI support matrix, each node kernel's
   RBD features and CephX key type (Ceph 20.2.4's `aes256k` keys need Linux 7.0 or a vendor backport), MON and OSD
   reachability from every node, the runner pool (replicated, never `size 1`), the CSI Secret, resource budget and
   test model credentials. Nothing here installs Ceph, CSI or a cluster.
2. **Storage class.** Render `deploy/managed-runner/storage/storageclass.template.json` with
   `scripts/managed-runner/ceph_rbd.py render --environment ACTUAL.json --output DIR` and apply it: `runner-data`,
   `ReadWriteOnce`, `Filesystem`, ext4, `mounter: rbd`, `imageFeatures: layering`, `reclaimPolicy: Retain`, `Immediate`,
   no expansion, not the default class. Check that a claim binds and mounts (lab: `smoke.sh run`).
   **On the .3 deployment the class is `runner-data-xfs`**, not `runner-data`: `ReadWriteOnce`, `Filesystem`,
   `csi.storage.k8s.io/fstype: xfs`, `mounter: rbd-nbd`, `parameters.reflink: enabled`, `mountOptions: ["noatime","discard"]`,
   `Retain`, expansion disabled, no `mkfsOptions`, with the patched Ceph-CSI image. See the
   [deployment record](managed-runner-k3s-xfs-deployment.md) and the [patch](../deploy/managed-runner/csi-xfs-reflink/README.md).
3. **Namespace and the manager's identity.** A namespace for managed runners only. In it a ServiceAccount
   (`automountServiceAccountToken: false`) with exactly these rights, and nothing on nodes, Ceph or webhooks:

   | Resource | Verbs |
   | --- | --- |
   | Pods | get, create (dry runs too), delete, patch (only to take its own finalizer off) |
   | PersistentVolumeClaims | get, create |
   | Secrets | get, create, delete |
   | ConfigMaps | get (fencing receipts; never written) |
   | PersistentVolumes (cluster) | get |
   | VolumeAttachments (cluster) | list |

   Give the manager a JSON kubeconfig with one context, the API server's address and CA, and that ServiceAccount's
   token, mode 0600 on the apiserver host. `kubectl auth can-i --as=system:serviceaccount:NS:NAME …` must answer `no`
   for everything else (in the lab `single-writer.py identity` prints the table: no `update` or `list` of Pods, no
   `pods/exec`, no ConfigMap create, no PVC delete, nothing in `kube-system`, no nodes, no webhooks).
4. **The admission guard.** Without it the manager creates no Pod (`ADMISSION_GUARD_MISSING`).
   - Make a random webhook token. The API server presents it through its admission configuration: a
     `WebhookAdmissionConfiguration` whose kubeconfig has a user named after the Orbit host carrying `token:`
     ([the deploy README](../deploy/managed-runner/README.md#single-writer-protection)). The profile holds its SHA-256.
   - Apply `deploy/managed-runner/admission/pod-admission-webhook.template.json` with the namespace, the Orbit host and its
     CA bundle filled in. It has `failurePolicy: Fail`: while the Orbit apiserver cannot answer, **every** Pod create in the
     namespace is refused. Keep nothing else in that namespace.
   - Check with two dry runs: a Pod that mounts no claim is admitted; a Pod on an unowned claim named `mr-data-<uuid>` is
     refused by the guard (`single-writer.py admission install` does both).
5. **The runner image.** Build `deploy/managed-runner/image/Dockerfile` at a known commit
   (`--build-arg ORBIT_SOURCE_SHA=$(git rev-parse HEAD)`), make it available to every node (a private registry, or a
   containerd import per node as the lab does), and pin it **by digest**. The image must trust the CA of the runner's
   `serverUrl`. Nothing here pushes an image.
6. **The profile.** Copy [manager-profile.example.json](../deploy/managed-runner/manager-profile.example.json), set
   `valueKind: actual` and fill every value from the environment record: the kubeconfig, context, expected API server and
   namespace; the storage class and per-runner capacity; the image digest and the HTTPS `serverUrl`; the runner's
   resources; the manager's username and the webhook token's SHA-256; the capacity budget; every lifecycle budget. The
   lab's T08 values are in the evidence (`records/*-on-provision-prepare.json`): a budget of two runners (1 CPU, 1536 MiB,
   2 Pods, 2 attachments, 2 active users), 2 GiB per volume, runners at 500m/768Mi requested and 2/2Gi limited,
   `idleSeconds` 90, `maxAttempts` 5, backoff 5–60 s, a 5 s poll, a 60 s lease, `heartbeatFreshSeconds` 120.
7. **Switch it on**, on the authorized apiserver only: `ORBIT_MANAGED_RUNNERS_ENABLED=true` and
   `ORBIT_MANAGED_RUNNERS_PROFILE=/absolute/path/profile.json`, then restart it. No default entry point sets either
   variable ([the boundary test](../scripts/managed-runner/deployment_boundary_test.py) keeps it so).
   - `GET /api/auth/capabilities` answers `managedRunners.enabled: true` (`false` while the switch is off, as the run
     recorded).
   - An account's next sign-in provisions: the mapping, the claim and the bootstrap Secret within seconds, the Pod once
     admission and capacity allow, `READY` at the runner's first heartbeat once a model is available (a signed-in
     runtime, or the owner's own enabled key). Measured: with the guard in place, the Pod 6.3 s after the owner's retry, its
     runner container 11 s later, its first heartbeat 20 s after that (the engine probe), and READY 1.1 s after the account
     added its key. Without the guard, the sign-ins still answered at once, and 5.7 s later both mappings were `FAILED`
     `ADMISSION_GUARD_MISSING`, with their claims and Secrets made and no Pod.
   - More than one apiserver may run the manager: a lease in the database gives each mapping one manager at a time.
     Sixteen concurrent sign-ins of two accounts over two replicas made one claim, one Secret and one Pod each
     (the slowest answered in 236 ms; the manager sent two claim creates, two Secret creates and two admission probes).

## Find an account's runner

```sql
select u.email, m.management_state, m.desired_state, m.generation, m.revision, m.attempt, m.owner_id, m.runner_id, m.pvc_name,
       m.pvc_uid, m.pv_uid, m.volume_handle, m.pod_uid, m.node_name, m.last_error->>'code' as reason, m.last_error->>'detail' as detail
  from managed_runner m join "user" u on u.id = m.owner_id order by u.email;
```

```bash
R=<runner uuid>
$K get pod "mr-$R" -o wide                       # absent while it sleeps
$K get pvc "mr-data-$R" -o jsonpath='{.metadata.uid} {.spec.volumeName}{"\n"}'
PV=$($K get pvc "mr-data-$R" -o jsonpath='{.spec.volumeName}')
$K get pv "$PV" -o jsonpath='{.spec.csi.volumeHandle} {.spec.csi.volumeAttributes.pool}/{.spec.csi.volumeAttributes.imageName}{"\n"}'
$K get volumeattachments -o json | jq -r --arg pv "$PV" '.items[] | select(.spec.source.persistentVolumeName == $pv) | .metadata.name + " " + .spec.nodeName'
rbd status <pool>/<image>                        # the RBD clients that have the image mapped, by address
```

The claim UID, the PV UID and the volume handle in the database must be those Kubernetes holds: the manager refuses to
start a runner on anything else (`PVC_CONFLICT`, `PV_CONFLICT`, `PVC_MISSING`). `detail` is the operator's half of a reason;
accounts see the reason's sentence only.

## The stop-report finalizer

Every Pod the manager creates carries the finalizer `orbit.dev/managed-runner-stop-report`. Whoever deletes the Pod
(`kubectl delete`, an eviction, `kubectl drain`, the manager itself), the object stays, terminal, with its kubelet's
report of how the containers ended, until the manager has recorded that report as the proof that this generation
stopped. The manager then takes the finalizer off (a JSON patch that tests the Pod's UID and the finalizer) and, if the
runner is wanted, starts the next generation on the same volume. In the lab an operator's `kubectl delete pod` of a
running runner left the object held by the finalizer, and the next generation started by itself: READY again 14.7 s
after the delete, a new Pod of the next generation on the same claim. Without the finalizer the kubelet's final delete
would remove the report within a second, and a routine deletion would end in `FENCING` (T02a saw exactly that).

**When a Pod stays `Terminating`.** `$K get pod mr-$R` shows `Terminating` for minutes, `metadata.finalizers` lists
`orbit.dev/managed-runner-stop-report`, and deleting the namespace hangs. Find out why:

1. **Is a manager running?** The switch on, and an apiserver of the deployment up with the profile. A switched-off
   server freezes management by design: it does not take finalizers off, and it deletes nothing. If a manager is just
   down, bring it back: it records the stop and removes the finalizer within a poll. That is always the first choice.
2. **Has the Pod's own kubelet reported the stop?** `status.phase` is `Succeeded` or `Failed` and every container has a
   `state.terminated` (exit code, `finishedAt`), the node is `Ready`, and no `DisruptionTarget` condition says
   `DeletionByPodGC` or `DeletionByTaintManager` (those are the control plane speaking for a node it cannot reach, which
   proves nothing about the node).
3. **Is the volume still attached?** `$K get volumeattachments` for the PV, and `rbd status` on the image.

**It may be removed** in two cases, and only then:

- the Pod's own kubelet has reported every container terminated (point 2), its node is `Ready`, and no manager will
  record it: the switch is to stay off, or the environment is being taken down. The object then goes. Turning the switch
  on again later finds the generation gone without a recorded proof, so by the manager's rule that runner waits in
  `FENCING` (`PREDECESSOR_STOP_UNPROVEN`) for a fencing receipt (`managed-runner-manager.ts`; not run in the lab): prefer
  bringing a manager back if the runner is to run again;
- the Pod's node has been **fenced**: powered off through its BMC or hypervisor and kept out, or its Ceph clients
  blocklisted by a tested, persistent procedure, and the receipt below is (or is about to be) written. The manager reads
  the receipt once the object is gone.

**It must not be removed** while the node has not reported the stop and is not fenced: the phase is still `Running`,
`Pending` or `Unknown`, the node is `NotReady` or unreachable, or the Pod was marked terminal only by the control plane.
The processes on that node may still be writing to the volume. With the object gone, Kubernetes no longer accounts for
them, the attach/detach controller may force the volume's detach after its timeout, and an operator, or a receipt written
on the strength of "the Pod is gone", could let the next generation mount the same volume on another node: a second
writer to one filesystem (ext4 in the lab, XFS on the .3 deployment) and its SQLite files. A missing heartbeat, `NotReady`, a cordon or a timeout are not
fencing. Fence first; see [Failover](#failover).

The command, with the UID test the manager uses itself, so it can only touch that one Pod:

```bash
UID_=$($K get pod "mr-$R" -o jsonpath='{.metadata.uid}')
AT=$($K get pod "mr-$R" -o json | jq '.metadata.finalizers | index("orbit.dev/managed-runner-stop-report")')
$K patch pod "mr-$R" --type=json -p "[{\"op\":\"test\",\"path\":\"/metadata/uid\",\"value\":\"$UID_\"},
  {\"op\":\"test\",\"path\":\"/metadata/finalizers/$AT\",\"value\":\"orbit.dev/managed-runner-stop-report\"},
  {\"op\":\"remove\",\"path\":\"/metadata/finalizers/$AT\"}]"
```

A failed `test` (the Pod changed, or is a successor under the same name) leaves everything as it was: read it again.

## Back up a runner's volume

An independent backup is a copy of the RBD image outside the Ceph cluster, taken while nothing has it mapped. Same-cluster
snapshots and the pool's replicas are not backups.

1. **Hold the runner asleep.** Disable the account (**Admin → Users → Disable**). A disabled account's runner drains and
   sleeps, and no message, task or wakeup wakes it; this also signs the account out. Measured: asleep 33.8 s after the
   disable.
2. **Check that nothing has the image.** The query above says `SLEEPING`; `$K get pod mr-$R` finds nothing; no
   VolumeAttachment names the PV; `rbd status <pool>/<image>` lists no watchers. Do not start any Pod on the claim to
   back it up: the admission guard refuses it, and it would be a second writer if it did not.
3. **Export it, off the cluster.** On the Ceph admin host:

   ```bash
   IMAGE=<pool>/<csi-vol-…>
   rbd info --format json "$IMAGE" > image-info.json
   rbd export --no-progress "$IMAGE" - | tee >(sha256sum > raw.sha256) | gzip -1 > volume.img.gz
   sha256sum volume.img.gz
   ```

   Move `volume.img.gz` to the backup destination outside the Ceph failure domain, check its SHA-256 there, encrypt it
   under the backup key, and write a manifest beside it: owner, runner, claim name and UID, PV name and UID, volume handle,
   pool, image name and ID, size, FSID, the generation at the backup, both SHA-256 values and the time. Measured: a 2 GiB
   image exported, checked and compressed in 7.8 s and copied out of the VM in 0.3 s; the archive was 27.0 MB.
4. **Enable the account again.** Its runner wakes on its own volume at its next message, task or wakeup.

## Check a backup without the cluster

The archive is a raw filesystem image. The recipe below is the lab's ext4 path: its checks need no Ceph, no Kubernetes,
no mount and no kernel module (`debugfs` reads an ext4 image as a file). **The .3 volumes are XFS**, which `debugfs`
does not read: check an exported XFS image with `xfs_db`/`xfs_repair -n`, or mount it read-only on a scratch loop device,
and run the same SQLite/Git checks over the mounted tree. The raw-image export/import and `rbd import-diff` steps above are
filesystem-agnostic. For ext4 the recipe is:

```bash
gzip -dc volume.img.gz | dd of=volume.img bs=1M conv=sparse status=none
sha256sum volume.img                          # = raw.sha256
debugfs -R stats volume.img | grep -E 'state|UUID'   # "clean"
mkdir -m 0700 tree && debugfs -R "rdump /home $PWD/tree" volume.img
```

Then, as root with `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*'` (the files belong to the
runner's UID): `PRAGMA integrity_check` on every SQLite file under `tree/home`, `git fsck` on `tree/home/orbit-repos/*`,
and the checksums of what matters to the account. Remove `tree` and `volume.img` afterwards: they hold the runner's
credentials. In the lab the archive of ann's volume gave back the probe's random file, every committed SQLite row and its
Git commit, every upload and engine transcript with its checksum, and `ok` for every SQLite file, in 4.3 s.

## Restore to a new PVC

A restore goes to a **new** claim and a **new** image, never over the original. It serves to get an account's data back
and to prove that a backup restores.

1. **A new claim of the runner class.** Create a claim `restore-<name>` with `storageClassName: runner-data`, the same
   size as the backed-up volume, `ReadWriteOnce`, `Filesystem`. Its name must not look like a managed one
   (`mr-data-<uuid>`), or the admission guard refuses every Pod on it. Once it is `Bound`, read its image from the PV
   (`.spec.csi.volumeAttributes.imageName`). Nothing has mounted it yet, so the image is empty.
2. **Write the backup into that image** on the Ceph admin host, before anything mounts it. Import the archive as a scratch
   image, copy every extent of it into the new image, remove the scratch image, and read the new image back:

   ```bash
   gzip -dc volume.img.gz | tee >(sha256sum) | rbd import --no-progress --image-feature layering - <pool>/scratch-<name>
   rbd export-diff --no-progress <pool>/scratch-<name> - | rbd import-diff --no-progress - <pool>/<the claim's image>
   rbd rm --no-progress <pool>/scratch-<name>
   rbd export --no-progress <pool>/<the claim's image> - | sha256sum      # = raw.sha256
   ```

   This uses librbd only; nothing is mapped by a kernel. Do not use a static PV naming an imported image instead: with
   the CSI driver's `attachRequired: true`, Ceph-CSI v3.18.0's ControllerPublish refuses such a handle ("does not support
   publish: … failed to decode CSI identifier"), and its ControllerUnpublish then panics, which leaves the VolumeAttachment
   and the PV held by the attacher's finalizer (seen in the lab; the attachment had never attached, so its finalizer could
   be removed by hand).
3. **Check it in a Pod** of the runner image, as the runner's user (10001), read-only root, no service account token, the
   claim mounted at `/home/orbit` as the runner sees it: SQLite `integrity_check`, `git fsck`, the checksums. It runs no
   runner: never start `orbit run` on a restored copy while the account's runner exists, because the copy carries its
   credential.
4. **Afterwards** delete the check Pod. The restored claim, its PV and image stay until someone deletes them on purpose
   (`Retain`: delete the claim, then the PV, then `rbd rm` the image, or set the PV's reclaim policy to `Delete` first).

Measured in the lab: 25.8 s in all, 17.9 s of it for the claim, the write and the read-back. The new image read back
byte for byte as the backup; the Pod found it as ext4, the probe's file, rows and commit as backed up, the uploads,
worktrees and transcripts with their checksums, and `ok` everywhere. The original claim, PV, handle and RBD image were
untouched, and ann's runner then woke on its original volume with the same identity.

**What a restore does not do.** A claim restored this way, under another name, is not the runner's volume: the manager
accepts a runner's data volume only as recorded (the claim's UID, the PV's UID and the volume handle) and never adopts a
claim by itself, and the admission guard admits no Pod but the runner's own on the runner's claim. To put a restored copy
back as the runner's volume, restore into a new claim under the runner's own name and switch the runner to it:
[Put a restored volume back under its runner](#put-a-restored-volume-back-under-its-runner).

## Put a restored volume back under its runner

A runner whose volume is lost or damaged cannot run again by itself. The manager accepts a runner's data volume only as
recorded (the claim's UID, the PV's UID and the volume handle), and Kubernetes gives every new claim a new UID, so a runner
whose claim is gone stays `FAILED` `PVC_MISSING` and nothing is created in its place. An Orbit administrator puts a
restored copy back as the runner's volume with the **volume switch**: the restore goes into a new claim under the runner's
own name, and the switch has the manager verify that claim, and that nothing uses the old volume any more, and record it in
the old one's place, with an audit row. The runner then wakes on it with the same runner ID. The switch is Kubernetes only:
on Docker the restore gives the volume back its recorded identity ([its runbook](managed-runner-docker-operations.md)).

It is an administrator's API call, not the owner's and not an object in the cluster. The restore needs the cluster and the
Ceph admin host, which only an operator has, and the audit row has to name a person Orbit authenticated. An owner can
neither make nor check a claim. A ConfigMap or an annotation asking for a switch would carry no identity Orbit can vouch
for, and its refusal would have to be read back from somewhere else; the call answers at once with the check that failed.

1. **Hold the runner still.** A runner that failed `PVC_MISSING` is still already. Otherwise disable the account
   (**Admin → Users → Disable**) and wait until the query of [Find an account's runner](#find-an-accounts-runner) says
   `SLEEPING`. The switch takes only a runner that is `SLEEPING`, or `FAILED` with nothing in flight.
2. **Make sure nothing uses the old volume.** No Pod `mr-$R` (`$K get pod mr-$R`); no VolumeAttachment of its PV; and, if
   its RBD image still exists, `rbd status <pool>/<image>` lists no watcher. The manager checks the first two itself, the
   attachments by the PV UID and volume handle it recorded, but it cannot see Ceph clients. A runner that failed while its
   stopped Pod was still recorded (`pod_uid` set) is switched only on the stop proof the manager recorded for that Pod
   (`fencing_receipt->>'kind'` is `OBSERVED_STOP` or `FENCING_RECEIPT`), and only once the Pod object is gone: if the
   stop-report finalizer still holds it, delete it and [take the finalizer off](#the-stop-report-finalizer), since its
   stop is recorded already. Without that proof, it is fencing's business first ([Failover](#failover)).
3. **Free the runner's name.** If the old claim still exists (a damaged volume), delete it: `$K delete pvc mr-data-$R`.
   With `Retain`, its PV and RBD image stay. Keep them until the restored data is confirmed, then have a storage operator
   purge them under the retention policy; Orbit no longer refers to them after the switch.
4. **Create the restored claim under the runner's name**, with the marks the manager puts on its own claims (the
   repository's `deploy/managed-runner/storage/pvc.template.json`) and the profile's volume size:

   ```bash
   OWNER=<owner uuid>                     # owner_id in the query above
   $K create -f - <<EOF
   {"apiVersion": "v1", "kind": "PersistentVolumeClaim",
    "metadata": {"name": "mr-data-$R", "annotations": {"orbit.dev/owner-id": "$OWNER", "orbit.dev/runner-id": "$R"}},
    "spec": {"storageClassName": "runner-data", "accessModes": ["ReadWriteOnce"], "volumeMode": "Filesystem",
             "resources": {"requests": {"storage": "<the profile's storage.capacity>"}}}}
   EOF
   ```

   Once it is `Bound`, read its UID (`$K get pvc mr-data-$R -o jsonpath='{.metadata.uid}'`) and its image (the PV's
   `.spec.csi.volumeAttributes.imageName`). Nothing can mount it before the switch: the admission guard refuses every Pod
   on a claim under a runner's name but the runner's own. The manager, which finds a claim under the name that is not the
   recorded one, adopts nothing either: the reason stays `PVC_MISSING`, and its detail says what it found.
5. **Write the backup into its image** with step 2 of [Restore to a new PVC](#restore-to-a-new-pvc): a scratch import,
   `export-diff | import-diff` into the claim's image, the scratch removed, and the image read back, whose SHA-256 must be
   the backup's. No check Pod can mount this claim, so check the archive itself first
   ([Check a backup without the cluster](#check-a-backup-without-the-cluster)); the read-back shows the claim now holds
   exactly those bytes.
6. **Switch**, signed in as an administrator (a personal access token is refused), with the mapping's `revision` from the
   query above and the claim's UID:

   ```bash
   curl -sS -X POST "$ORBIT_URL/api/admin/managed-runners/$R/volume-switch" \
     -H "Authorization: Bearer $ADMIN_ACCESS_TOKEN" -H 'Content-Type: application/json' \
     -d '{"idempotencyKey": "<a new UUID>", "revision": <revision>, "volumeUid": "<the claim UID>", "reason": "<why, for the audit row>"}'
   ```

   Add `"confirmReplacement": true` when the manager has not found the old volume missing itself (the runner was asleep,
   or failed for another reason): it says you mean to replace it. The answer, `200`, gives the runner's state (`SLEEPING`),
   its generation, and `from` and `to`: the claim UID, PV UID and volume handle recorded before, and the restored ones.
   The same request again is answered as it stands, `replayed: true`. A refusal is `409 MANAGED_RUNNER_VOLUME_SWITCH_REFUSED`
   with `check`, a sentence and `detail` (names, UIDs, nodes), and nothing is switched:

   | `check` | What to do |
   | --- | --- |
   | `NOT_SWITCHABLE` | The runner is running, starting, fencing or deleted, has a create in flight or records no volume yet: hold it still (step 1). |
   | `CONFIRMATION_REQUIRED` | Confirm the replacement (`confirmReplacement`), if that is what you mean. |
   | `VOLUME_NOT_FOUND`, `VOLUME_NOT_BOUND` | Make the claim (step 4) and wait until it is `Bound`. |
   | `VOLUME_ALREADY_RECORDED` | The claim under the name is still the recorded one: free the name first (step 3). |
   | `VOLUME_NOT_VERIFIED` | The claim under the name is not the one you named: check it again. |
   | `VOLUME_NOT_THIS_RUNNERS` | The claim lacks the owner and runner annotations, the storage class, `ReadWriteOnce` or `Filesystem`, has an owner reference, or its PV is not bound to it: make it again as in step 4. |
   | `VOLUME_OF_ANOTHER_ACCOUNT` | Its PV, or that PV's volume handle, is recorded for another runner, or the PV was made before the claim (a retained PV rebound by hand): restore into a claim the driver provisions. |
   | `VOLUME_IN_USE` | The restored claim's PV is attached to a node: find what mounted it. |
   | `RECORDED_VOLUME_IN_USE` | A Pod under the runner's name exists, the old PV is still attached, or the stop of an instance still recorded is not proven (step 2). |
   | `ADMISSION_GUARD_MISSING` | The admission guard is not in force: install it ([Deploy a test environment](#deploy-a-test-environment), step 4). |
   | `MAPPING_BUSY` | A manager pass is on the runner right now: try again in a few seconds. |
   | `BACKEND_UNAVAILABLE` (`503`) | The cluster could not be asked: try again. |

   `409 MANAGED_RUNNER_REVISION_CONFLICT` carries the current `revision`: the mapping moved since you read it (the manager
   writes what it finds under the name into the reason's detail), so read it again and decide again. With managed runners
   off, the route answers `404 MANAGED_RUNNER_DISABLED`; a member is refused `403`.
7. **Let it wake.** Enable the account again if you disabled it. The runner wakes at its next message, task or wakeup, and
   at once when work was already waiting (as after a failed wake), on the restored claim as its next generation, with the
   same runner ID and workspace; its sessions go on from what the backup held. From then on its stop proofs, its fencing
   receipts and the admission guard name the restored claim, as they named the old one.

The audit row is one `activity` row per switch:

```sql
select created_at, actor_id, payload->'from' as "from", payload->'to' as "to", payload->>'reason' as reason
  from activity where type = 'managed_runner.volume_switched' order by created_at;
```

It names the administrator and the time, the mapping, its owner and runner, the generation, the state and reason it was in,
the claim UID, PV UID and volume handle before and after (with the new PV's name), whether the replacement was confirmed,
the reason given and the request's idempotency key. A stopped instance that was still recorded is named there too
(`retired`): the switch retires its generation on its proof, as a sleep would, and gives its compute back.

Measured in the lab (T08b, 2026-10-18, [evidence](evidence/managed-runner-volume-switch/2026-10-18/README.md)): an account's
volume was lost while it slept, its claim, PV and RBD image deleted. A message then failed its wake `PVC_MISSING` within 0.6 s,
and nothing was made in its place. The restore into a new claim under the runner's name took 18.3 s: 17.1 s of it for the
claim, its binding and the 2 GiB backup's write into the new image, which read back byte for byte as the backup. A check Pod on that claim was refused by
the guard (`NOT_THE_MANAGER`). A member's switch, another UID and a stale revision were refused first, with nothing
switched; the administrator's switch was answered in 0.4 s, with one audit row. The waiting message woke the runner at
once: its Pod was made in the same second, the message was answered 23.7 s after the switch, and the runner was `READY`
51 s after it, as generation 2 with the same runner ID and workspace, on the restored claim. Its probe data, every SQLite
database (`integrity_check` ok), its uploads, worktree and transcripts and the engine's session were as backed up, and
there was never more than one Pod on the volume.

## Rollback

**Switch managed runners off.** Set `ORBIT_MANAGED_RUNNERS_ENABLED=false` (or remove it) and restart the apiserver. The
switch is read at start-up. Management freezes: nothing is created, woken, put to sleep or deleted; claims, PVs and RBD
images stay; the managed API answers `404 MANAGED_RUNNER_DISABLED`; sign-in provisions nothing. A runner that was
running keeps serving its sessions as a runner, but nothing drains it and nothing restarts it (T06), and a Pod deleted
meanwhile hangs `Terminating` ([above](#the-stop-report-finalizer); T04). So put the runners to sleep first: each owner's
sleep, or disable the accounts, and wait for `SLEEPING`. Measured with every runner asleep, unset and then `false`: messages, a
task run now and a task's run time made no managed write and no request to Kubernetes for 90 s each, every claim
was kept, and the waiting work woke the runners once the switch was on again.

**Roll the runner image back.** Set `runner.image` in the profile to the previous digest and restart the apiservers. A
running Pod keeps its image; each runner gets the pinned one at its next start, as its next generation. The admission
guard admits only the pinned image, so pin the previous digest, not a tag. Measured: with the previous lab image pinned
and both apiservers restarted, the running Pod kept its image; the runner's next generation, after a sleep and a
message, ran the previous image and resumed its session from the volume; rolling forward the same way gave the current
image back.

**Roll the apiserver back.** Migrations only go forward. An apiserver from before the managed-runner feature ignores the
managed tables, but it also does not hold managed runners to their generation, so do not roll back past it with a managed
Pod running: put every runner to sleep, switch the feature off, and leave the admission webhook in place (answered by
nobody, it refuses every Pod in the namespace, which keeps managed Pods from starting). **Not verified here.**

**Take a test environment down.** Runners asleep, switch off, delete the `ValidatingWebhookConfiguration`, then the API
server's admission configuration. Claims, PVs and images stay until a storage operator purges them under the retention
policy; deleting a claim of `Retain` storage leaves its PV and image behind, which is not erasure.

## Failover

The manager starts a runner's next generation only on proof that the previous one stopped: its kubelet's report, the Pod
object gone, and no VolumeAttachment holding the volume; or an operator's fencing receipt bound to that instance and
volume. Anything else leaves the mapping `FENCING`: the old credential is replaced at once, the volume and the reservation
are kept, nothing starts, and no timeout, lease or owner's retry opens it.

**A planned move off a node** (maintenance): drain it. The eviction deletes each runner's Pod: the runner drains and
exits, the finalizer keeps its kubelet's report until the manager has it, the volume detaches, and the next generation
is scheduled on another node with the same claim. The manager names no node itself; the drain's cordon keeps the next
generation off the node.

```bash
kubectl --kubeconfig $ADMIN_KUBECONFIG --context $TEST_CONTEXT drain <node> --ignore-daemonsets --delete-emptydir-data --force
```

- A runner's Pod is a bare Pod. Its `/tmp` is the `.orbit-tmp` subPath of its data volume, so filling it gives the
  writer ENOSPC and the kubelet never evicts the Pod for it; a Pod made before that change still has an emptyDir
  `/tmp` until its next generation. Without `--delete-emptydir-data` the drain refuses such a Pod ("Pods with local
  storage"), and without `--force` it refuses any runner Pod ("Pods that declare no controller"). A refused drain
  cordons the node and evicts nothing.
- The drain finishes once every Pod it evicted is gone. For a runner's Pod that is once a manager has recorded its stop
  and taken the stop-report finalizer off. With managed runners switched off, or for a managed Pod no running manager
  records, it waits until its `--timeout` ([When a Pod stays Terminating](#the-stop-report-finalizer)).
  `--skip-wait-for-delete-timeout=SECONDS` passes Pods that have been terminating longer than that.
- `--pod-selector=app.kubernetes.io/name=orbit-cloud-runner` moves only the runners. The lab drains its first node this
  way, because the CSI controller plugin runs there too.

Measured:

- On one node, an eviction, a delete and a crash each started the next generation on the same volume (T04, and the T08
  rebuild).
- On the two-node lab (T02) the owner's sleep put the runner to sleep in 15.4 s, on its kubelet's report: the Pod went
  and the volume detached. With its node cordoned, a message woke it on the other node 24.7 s later: the same runner,
  claim, PV and RBD image, data and session.
- On the two-node lab (T08x) two accounts' runners were drained off each node in turn. Their next generations' Pods
  were made on the other node 14–17 s after the drain began, and both runners were READY 45–46 s after it, with the same
  claims, data and sessions. The second node's drain finished in 10 s.
- The first node's drain also evicted a managed Pod of an earlier task's test server. It was `Failed` and held by the
  stop-report finalizer of a manager that was not running, so the drain waited its full 300 s `--timeout` and exited 1,
  although both runners had moved. With `--skip-wait-for-delete-timeout=60` the next drain passed it.

**A node that stops reporting** (power loss, network partition): its runner's Pod is not terminal by its kubelet, and
nothing replaces it. The manager has no right to read nodes, and a lost heartbeat proves nothing, so the mapping stays
`READY` with its generation and Pod recorded.

- The owner's status says the runner is not usable once its last heartbeat is older than `heartbeatFreshSeconds`.
- Work sent meanwhile waits, and the owner's retry is refused.
- The node's VolumeAttachment stays.
- After the node's `NoExecute` toleration (300 s) the taint manager evicts the Pod. It is still `Running`, held by the
  stop-report finalizer, with no kubelet to confirm anything.
- The mapping goes `FENCING` (`PREDECESSOR_STOP_UNPROVEN`), and the predecessor's credential is replaced, only when the
  control plane makes that Pod terminal (step 4 below) or its object goes.

Measured on the two-node lab, the second node's qemu killed while its runners wrote there (T02: one runner; T08x: two
accounts' runners):

| Seen, after the power cut | T02 | T08x |
| --- | --- | --- |
| The node's RBD watchers gone | 35 s | by 38 s |
| The node `Unknown` | 52 s | 56 s |
| The runners not usable | 114 s | 95 s |
| The Pods evicted by the taint manager | 351 s | 354 s |

For 420 s the manager made no Pod, admission probe or Secret, the mappings stayed `READY` at their generation, and the
attachments stayed on the dead node. In T08x, second Pods on either claim pinned to the other node meanwhile were refused
by the admission guard, the next generation's under the fixed name too (`NOT_THE_RESERVED_GENERATION`).

To bring the runner back elsewhere:

1. Identify the predecessor from the mapping: runner, generation, Pod name and UID, node, claim UID, volume handle, RBD
   pool and image. A node may hold several accounts' runners, and each of them needs steps 3 and 4. The query of
   [Find an account's runner](#find-an-accounts-runner) gives every runner's `node_name`, and its commands, with `R` set,
   show the stale Pod, the claim, PV, handle and image, and the VolumeAttachment still on the lost node.
2. **Fence the node.** Power it off through its BMC or hypervisor and verify the power state independently, then keep it
   out until its stale Pods and mounts are gone; or blocklist its Ceph clients by a tested, persistent procedure (record the
   addresses and nonces, the OSD map epoch, the expiry and the rejoin policy). A lock break, a temporary blocklist, a
   cordon or a token rotation is not fencing.
3. **Write the receipt** as ConfigMap `mr-fence-<runner uuid>`, key `receipt.json`, shaped like
   [fencing-receipt.example.json](../deploy/managed-runner/fencing-receipt.example.json), naming the predecessor exactly as
   the mapping records it ([Fencing receipt](../deploy/managed-runner/README.md#fencing-receipt)). An incomplete or unbound
   receipt is refused field by field (`FENCING_RECEIPT_INVALID`, seen in the lab, T02a) and opens nothing. One receipt per
   runner:

   ```bash
   $K create configmap "mr-fence-$R" --from-file=receipt.json=receipt.json
   ```

4. **Let Kubernetes release the volume**: the `node.kubernetes.io/out-of-service` taint on the fenced node (only after the
   power-off is verified), once for all its runners, then [take the finalizer off](#the-stop-report-finalizer) each stale
   Pod. The manager waits for the object and the attachment to be gone, reads the receipt, and starts the next generation
   on another node.

   ```bash
   $K taint node <node> node.kubernetes.io/out-of-service=nodeshutdown:NoExecute
   ```

   - PodGC makes the stale Pod `Failed`, and the attach/detach controller deletes its VolumeAttachment without waiting
     for an unmount nobody can report.
   - The manager, finding the Pod terminal but not by its kubelet, or finding its object gone, goes `FENCING`. The
     predecessor's credential is refused from then on.
   - The finalizer can come off right after the taint or once the query says `FENCING`. T08x did one runner each way and
     both took over: the manager fenced on the Pod's removal for one, on PodGC's `Failed` for the other.
   - The taint also evicts the Ceph-CSI node plugin from that node, unless it tolerates the taint. In the lab it does not,
     so the node maps nothing until the taint is removed, which is the quarantine.
5. Check the account's data on the new node (SQLite, Git, the engine's session), and keep the old node out until it is
   wiped or rejoined under the rejoin policy. When its stale Pods and attachments are gone and it maps and mounts nothing
   of the volumes, remove the taint:

   ```bash
   $K taint node <node> node.kubernetes.io/out-of-service-
   ```

Measured on the two-node lab (T02, 2026-10-19, [evidence](evidence/managed-runner-cross-node/2026-10-19/README.md)):

- **Steps 3 and 4.** The receipt (`NODE_POWER_OFF`, mechanism `HYPERVISOR`, the host's checks as its observation) and
  the taint went in at once. Within 6 s the stale Pod was `Failed` and its attachment gone. 10.3 s after the taint the
  mapping was `FENCING`, and the predecessor's credential got 401 at heartbeat, claim and `/runner/me`.
- **The next generation.** 26.1 s after the finalizer came off it was READY on the other node, the receipt recorded as
  its stop proof. That is 463.8 s after the power cut, 427 s of it waiting on purpose.
- **The data.** Every row the writer had acknowledged was there, `integrity_check` ok after SQLite's WAL recovery, and
  the files, uploads, worktree, transcripts and session as before. The work sent during the outage was answered then.
- **The old node, back under the taint.** It mapped and mounted nothing of the volume, and ran nothing of the old Pod.
  Its kubelet could not even reach the CSI driver to tear the old volume down. The old generation's credential got 401
  and the old instance 403 `MANAGED_RUNNER_INSTANCE_SUPERSEDED`. With the taint removed, the node rejoined and the
  volume stayed with the new generation, one Pod and one attachment throughout.

Measured with two accounts' runners on the lost node, running this page's query and commands (T08x, 2026-10-19,
[evidence](evidence/managed-runner-cross-node-accounts/2026-10-19/README.md)):

- **Steps 1 to 4.** From the power-off check to the taint took 3 s: the query, the commands for each runner, two
  receipts, one taint. One runner's finalizer came off right after the taint, the other's once its mapping was
  `FENCING`.
- **Fencing.** Within 7 s of the taint the first Pod object was gone and the other Pod `Failed`. 9.1 s after the taint
  both mappings were `FENCING`, and the predecessor's credential of the one still recorded got 401.
- **The next generations.** Both predecessors were retired on their receipts 4 s after the second finalizer came off.
  Both runners were READY on the other node 44 and 53 s after their finalizers, 481 s after the power cut.
- **The data.** Every acknowledged SQLite row, the probes' files, rows and Git commits, uploads and worktrees were as
  before. The work sent during the outage was answered.
- **The old node.** Back under the taint, it mapped nothing of either volume and ran nothing of the old Pods. Both old
  credentials got 401.

**What a node that loses power can lose.** Data its processes had not made durable when the power went may be gone:
ext4 allocates delayed blocks only at writeback.

- A Git commit made 14 s before the cut came back as zero-length files, an unreadable repository. Git fsyncs neither
  loose objects nor refs by default.
- Even with `core.fsync=committed,index`, a repository committed 1.5 s before a cut lost its `HEAD` and its branch ref.
- What was fsynced survived: SQLite with `synchronous=FULL`, and fsynced files.
- The engine's transcript is not fsynced either (T08x). A turn answered 20 s before a cut was missing from the
  account's transcript on the volume after the failover. The session went on from the lines written before it, and the
  turn was not in the conversation the engine resumed. Orbit's server kept the turn's events. The other account, whose
  volume was synced (`sync -f /home/orbit` in the runner container) just before the cut, kept its last turn.

The measurements above are ext4. **XFS on the .3 deployment has not been put through the same power-cut drills**;
SQLite, Git and the runner's syncfs behavior are ext4-proven, not yet XFS-proven. See
[the deployment record](managed-runner-k3s-xfs-deployment.md#not-verified-here--risks) before treating XFS as
durability-accepted.

Since T02c (2026-10-19, [evidence](evidence/managed-runner-power-cut-durability/2026-10-19/README.md)) a managed runner
syncs its volume (`syncfs`) before it reports work that lives there, and behind every tool an engine runs. A turn the
control plane has heard is over, a commit, a merge or a checkout the runner made is then on the disk. Only the work of a
tool in the last fraction of a second can still be lost. In the lab, the same Git work in the last 2 s before a cut came
back intact, and the session resumed with its last turn.

After a failover, read the next generation's start in its log:

- `volume check: <n> checkouts in <m> repositories after start; <k> stale lock files removed, <b> branches restored,
  <d> checkouts damaged`, with a line for each lock, branch or checkout it names.
- A lock no process held is removed. A branch left empty or missing is put back at the newest commit of its own reflog
  that reads.
- A repository that still cannot be read is not worked in. Its sessions fail with `REPOSITORY_DAMAGED` and the reason,
  and the runner starts no new repository over it.
- To go on, repair it: point the branch at a reflog entry that reads (`git update-ref`) and remove the empty object
  files, or restore it [from a backup](#restore-to-a-new-pvc). Or move it aside, and the next session starts a new one.

**Not verified here:**
- a node that keeps running but is cut off, a partition;
- a storage fence (`STORAGE_FENCE`) as the receipt's method;
- the failure of the node that runs the control plane: the lab's k3s server and CSI controller run on its first node,
  and only the second was failed;
- failover across separate physical machines: the lab's two nodes are VMs on one host;
- any cross-node move on the .3 deployment: it is a **single-node** k3s cluster, so a node failure stops the runner until
  the node returns (see [the deployment record](managed-runner-k3s-xfs-deployment.md)).

## Session checkouts and the volume

Each session works in a checkout of its own on its runner's volume. Inside the Pod, `statfs` reports the claim's own
filesystem (ext4 in the lab; **XFS on the .3 deployment**), so the runner measures the volume itself and reclaims
checkouts below its floor as any runner does
([the rule](runner-troubleshooting.md#d-the-disk-is-short-or-a-sessions-checkout-has-gone)):

- **The floor** is the owner's **Keep Free** (the runner's page, Capacity) whenever one is set. Otherwise it is a
  quarter of the claim's size, the size admission reserved for it (the profile's `storage.capacity` when the claim
  was made): 512 MiB of the lab's 2 GiB. The default is worked out for each heartbeat answer and never stored, so
  the runner's page shows Keep Free only as its owner set it, and auto-run, which holds ready tasks while a runner's
  disk is under its floor, applies only that. With managed runners switched off, a runner gets no default floor.
- **No storage budget.** A storage budget is the Docker backend's, where `statfs` cannot see a volume's limit
  ([its runbook](managed-runner-docker-operations.md#session-checkouts-and-the-volumes-limit)). Here the rules of a
  runner without one apply: below the floor a resting session's checkout goes, oldest first, when nothing in it would
  be lost, as under a budget, but a look that finds nothing to take waits an hour, and no room is made before a new
  checkout. So a burst of new checkouts can still take the volume past its floor before a sweep catches up, and
  writes then fail with "no space left on device".
- **Clones on XFS; plain on ext4.** On the .3 deployment the claim is XFS with `reflink=1` (the patched Ceph-CSI class),
  so every session checkout is cloned from the workspace checkout and the runner logs `checkouts: cloned: …`; the
  index fast path avoids the full `git update-index --refresh` rehash. The design's D4 was revisited for this
  deployment ([checkout storage design](session-checkout-storage-design.md#8-decisions-for-the-owner)), and the XFS
  durability/power-cut drills are still outstanding (see the deployment record). On an ext4 deployment (the lab
  baseline) the runner instead says
  `checkouts: plain: probe failed (EOPNOTSUPP): the filesystem of /home/orbit/.orbit/worktrees cannot clone
  files, so git writes out every session checkout`, and every checkout is written out in full. A repository's
  `.orbit/checkout-exclude` makes checkouts smaller on either filesystem
  ([the format](runner-troubleshooting.md#f-a-sessions-checkout-lacks-some-paths)).

## Out of memory kills one process: the kubelet's `singleProcessOOMKill`

On cgroup v2 the kubelet writes `memory.oom.group=1` into every container's cgroup by default. A runner container
that reaches its memory limit then loses **every** process at once: `tini`, the daemon, every engine and every
session's tools. dmesg says `Tasks in /kubepods.slice/…/cri-containerd-<id>.scope are going to be killed due to
memory.oom.group set`, and the Pod stops with `OOMKilled`. The kubelet's `singleProcessOOMKill: true` stops it writing
that flag, so the kernel kills only the process it picks (the largest one, after `oom_score_adj`), and the container
keeps running. It is a `KubeletConfiguration` field only: no kubelet flag sets it. On cgroup v1 it is always on and
may not be set to false.

Every node that runs managed runners needs it. On k3s:

1. Check that the kubelet knows the field. k3s has no `k3s kubelet --help`, but the binary carries the field's name and
   description: `strings "$(command -v k3s)" | grep -m3 singleProcessOOMKill`. Then check how k3s starts the kubelet:
   `journalctl -u k3s | grep 'Running kubelet' | tail -1`. k3s passes `--config-dir=/var/lib/rancher/k3s/agent/etc/kubelet.conf.d`
   and rewrites `00-k3s-defaults.conf` there at every start, so do not edit that file.
2. Back up `/etc/rancher/k3s`, then add two files. `/etc/rancher/k3s/kubelet-orbit.yaml`:

   ```yaml
   apiVersion: kubelet.config.k8s.io/v1beta1
   kind: KubeletConfiguration
   singleProcessOOMKill: true
   ```

   and `/etc/rancher/k3s/config.yaml.d/95-orbit-kubelet.yaml`, which hands it to the kubelet. k3s's own
   `00-k3s-defaults.conf` does not set the field, so nothing overrides it:

   ```yaml
   kubelet-arg+:
     - "config=/etc/rancher/k3s/kubelet-orbit.yaml"
   ```

3. Restart k3s at a quiet moment: `systemctl restart k3s`. Containers keep running through the restart
   (`KillMode=process`), but the API server and the kubelet are away until k3s is back (9 s on .3), so every Pod on
   the node is briefly unmanaged and no runner Pod can be created. Before the restart, check that no runner is running a turn: read each runner Pod's log (`kubectl logs
   --since=20m`), and list the processes in its container cgroup from the host. An idle runner has only `tini`,
   `orbit-container run`, `orbit run` and its memory reserve, `orbit orbit-headroom`.
4. Verify. `kubectl get --raw /api/v1/nodes/<node>/proxy/configz` must show `"singleProcessOOMKill": true`, and the
   file must be in the kubelet's drop-in directory: k3s v1.37.2 copies a `config=` kubelet-arg file to
   `/var/lib/rancher/k3s/agent/etc/kubelet.conf.d/10-cli-config.conf` and still passes only `--config-dir`, so the
   `Running kubelet` line does not change. The kubelet writes
   `memory.oom.group` only when it creates a container. Containers made before the restart keep `1` until their Pod's
   next generation (a sleep and wake, or an image roll), and new ones read `0` in
   `/sys/fs/cgroup/kubepods.slice/…/cri-containerd-<id>.scope/memory.oom.group`. A test Pod in a scratch namespace
   proves it: give it a 64 MiB limit, a `sleep` beside it, and `dd bs=256M count=1`. dmesg then shows one `Killed
   process … (dd)` and no `memory.oom.group set` line, `memory.events` counts `oom_kill 1` and `oom_group_kill 0`, and
   the container's restart count stays 0. Delete the namespace afterwards.

To undo it, remove `95-orbit-kubelet.yaml` and restart k3s. The .3 deployment's run of this procedure is in
[its record](managed-runner-k3s-xfs-deployment.md#memory-one-process-not-the-container-2026-11-22).

### A second kill while a shared-memory victim drains: a kernel limit, and the reserve

The kernel frees a killed process's memory in two steps. Private anonymous memory, which builds mostly use, goes while
the victim unmaps it. Shared memory (`MAP_SHARED|MAP_ANONYMOUS`, memfd, tmpfs such as `/dev/shm`) goes only when the last
reference to its file is dropped, later in the victim's exit. The OOM killer stops waiting for its victim much sooner:
by the time the victim has unmapped its memory (`MMF_OOM_SKIP`) at the latest, and in the lab sometimes 2 ms after the
kill. Until the shared memory is gone the container stays at its limit, and an allocation in it then makes the kernel
kill again: the next process by badness, usually another session's tool at `oom_score_adj` 1000. **No runner-side
change can close this window entirely**: a process woken by the kill cannot free memory within 2 ms.

Measured in the lab (2026-11-24; guest kernel 7.0 under k3s; a 2 CPU / 4 GiB runner; one session's tool fills 3.6 GiB of
`MAP_SHARED|MAP_ANONYMOUS` memory while another session's tool runs `sleep 210`; all times on CLOCK_MONOTONIC from the
kernel's `oom/mark_victim`):

- The victim finished unmapping 85 to 96 ms after the kill (360 ms once, when the whole guest stalled for about a
  second), and its shared memory was gone 386 to 437 ms after it (700 ms in that trial). The OOM was the Pod cgroup's:
  the Pod's 4 GiB includes the `pause` container, so it meets the limit just before the runner container does.
- Before the reserve below, the kernel killed the other session's tool shell 93 or 115 ms after the first kill, in 2 of
  4 trials.
- With the reserve, in 10 trials the runner's watchdog stopped the allocator below the limit 5 times (no kernel kill)
  and the kernel killed it 5 times. In 3 of those 5 the reserve was woken 0.4 to 3.2 ms and freed 5.3 to 14.7 ms after
  the kill. From then until the shared memory was gone the container stayed 45 to 68 MiB below its limit and never met
  it again (`memory.events` `max` unchanged); anon and kernel memory did not grow, and only page cache came back (32 to
  134 MiB). The kernel killed only the allocator. In the other 2 the kernel killed again 2.1 and 53.0 ms after the first
  kill, before the reserve was freed, and took the reserve itself. The other session's tool finished in all 10 trials.
- On orbit-ws01's 7.2 kernel (a 1 GiB, 2 CPU scope), a second kill came 0.3 to 0.5 ms after the first in 2 of 5 runs
  without the reserve, while the victim was still unmapping; with it, 8 of 8 runs had one kill.

**The reserve.** On a managed runner the memory watchdog starts `orbit orbit-headroom`, a child of `orbit run`. It holds
64 MiB of touched private memory, counted against the container like any other, and frees it (`madvise(MADV_DONTNEED)`)
as soon as the container's `memory.events` `oom_kill` rises, so the container's other processes have that room while
the victim's shared memory drains. It waits on `memory.events` with `poll`, which the kernel wakes on a change of that
file as it signals inotify's `IN_MODIFY` (at most once in 10 ms, rounded up to whole jiffies), with a 100 ms timeout as
the fallback. It arms again once no kill has followed for 4 s and arming leaves the watchdog's tenth of the limit free.

- It is a process of its own because a daemon thread that faults at the limit holds up Go's stop-the-world, and every
  goroutine with it, until memory is freed. An earlier attempt that freed a reserve from a daemon goroutine freed it 1 to
  2.7 s after the kill, after the second kill (with heavy kernel tracing on).
- Its `oom_score_adj` is 1000 and it holds about 80 MiB resident, so when the kernel kills again before the reserve is
  freed it takes the reserve before a smaller tool (a shell, a `sleep`), as in the 2 trials above. A tool larger than the
  reserve still goes first, and so does one when more than 64 MiB of memory that cannot be reclaimed is allocated
  before the victim's shared memory is gone. The memory watchdog never stops the reserve; the daemon starts it again
  4 s after a signal ends it.
- Runner log lines: `Armed the emergency memory reserve of 64 MiB; the container's oom_kill is N`; `Freed the emergency
  memory reserve of 64 MiB: the container's oom_kill rose from N to M (woken at monotonic … ns, freed at … ns)`, on the
  clock of ftrace's `mono` trace clock, so the times compare with `oom/mark_victim`; `The emergency memory reserve was
  stopped: signal: killed - it starts again in 4s` after the kernel took it; and `The emergency memory reserve is not
  running: …` if it could not start.

## Names from before orbit-cloud (2026-11-20)

Until 2026-11-20 these names said `orbit-managed`; they now say `orbit-cloud`. What a cluster already holds keeps working:

- The admission webhook configuration is `orbit-cloud-runner-pods`. One applied earlier is `orbit-managed-runner-pods` and
  still guards the namespace: it selects no label, and the manager accepts a refusal that starts with either
  `orbit-cloud-runner-admission` or `orbit-managed-runner-admission`. To move to the new name, apply the template, check
  the two dry runs, then delete `orbit-managed-runner-pods`.
- Pods and PVCs the manager makes are labelled `app.kubernetes.io/name: orbit-cloud-runner`. Earlier ones keep
  `orbit-managed-runner` until they are made again. Nothing in Orbit selects by this label, but a `--pod-selector` of
  your own should name both.
- A runner image built before the rename sends `X-Orbit-Managed-Runner-Generation` and `-Pod-Uid`. The apiserver reads
  those as well as `X-Orbit-Cloud-Runner-*`, so a Pod keeps working until its image is replaced.
- The hosted runners' image is now `<registry>/orbit-cloud-runner`. The first release after the rename builds and pushes
  it there; the earlier `<registry>/orbit-managed-runner` digests stay in the registry for a rollback.
- The namespace is whatever the profile's `kubernetes.namespace` says. A namespace cannot be renamed: moving the runners
  out of `orbit-managed` is [Move the runners to another namespace](#move-the-runners-to-another-namespace). Production
  moved its 7 runners to `orbit-cloud` that way on 2026-11-22, with management off for about 6 minutes, and then
  deleted `orbit-managed` and its guard `orbit-managed-runner-pods`.

## Move the runners to another namespace

A namespace cannot be renamed, and a claim cannot change namespace. Each runner's data volume moves on its own: with
reclaim policy `Retain`, deleting its claim leaves the PV and the RBD image, and the PV is then bound to a new claim of
the same name in the other namespace. The PV, its UID and its CSI volume handle stay what Orbit recorded; the claim gets
a new UID, which the runner's mapping must record. The manager drives only the namespace its profile names, and on a
single cluster it treats every Kubernetes mapping as its own, so the mappings, the profile and the claims change
together, with managed runners switched off and every runner asleep. Orbit itself stays up; Orbit Cloud runners do
not wake from step 3 until step 7.

Written for production's move from `orbit-managed` to `orbit-cloud` on `orbit-ws03`; the same steps move any
namespace. Run the cluster's steps on the k3s host as root and the server's in the deploy directory of the apiserver's
host:

```bash
K="k3s kubectl"; OLD=orbit-managed; NEW=orbit-cloud          # on the k3s host
DC="docker compose"; PSQL="$DC exec -T postgres psql -U orbit -d orbit -v ON_ERROR_STOP=1"   # on the apiserver's host
MOVE=/root/ns-move-$(date -u +%Y%m%d)                         # on each host: backups and records, mode 0700
```

### 1. Before the window: back up, and prepare the new namespace

Nothing here changes what runs; the new namespace holds nothing a runner uses until step 6.

1. On the apiserver's host, keep copies: `install -d -m 700 $MOVE`, then `cp -p` the profile and the kubeconfig it
   names (both in `ORBIT_MANAGED_RUNNERS_DIR`) into `$MOVE`, and
   `$DC exec -T postgres pg_dump -U orbit -d orbit --data-only -t managed_runner -t managed_runner_capacity >$MOVE/rows.sql`.
2. On the k3s host, `install -d -m 700 $MOVE` and save the manager's objects:
   `$K get sa,role,rolebinding orbit-mr-manager -n $OLD -o json >$MOVE/manager.json`,
   `$K get clusterrolebinding orbit-mr-manager-storage -o json >$MOVE/crb.json`, and the guard in force, found by the
   namespace it selects rather than by name (production's is `orbit-managed-runner-pods`; a cluster deployed after the
   rename has `orbit-cloud-runner-pods`):

   ```bash
   OLD_GUARD="$($K get validatingwebhookconfigurations -o json | python3 -I -c 'import json,sys; old=sys.argv[1]; print(" ".join(w["metadata"]["name"] for w in json.load(sys.stdin)["items"] if any((h.get("namespaceSelector") or {}).get("matchLabels",{}).get("kubernetes.io/metadata.name")==old for h in w.get("webhooks",[]))))' $OLD)"
   echo "$OLD_GUARD"    # exactly one name
   $K get validatingwebhookconfiguration "$OLD_GUARD" -o json >$MOVE/webhook.json
   NEW_GUARD=orbit-cloud-runner-pods; [ "$OLD_GUARD" = "$NEW_GUARD" ] && NEW_GUARD="orbit-cloud-runner-pods-$NEW"
   ```

   The copy must never take the name of the guard in force: applying it would make that guard select `$NEW` and leave
   `$OLD` unguarded.
3. Make the namespace and the manager's identity in it, from those copies with the namespace replaced:

   ```bash
   $K create namespace $NEW
   python3 -I - "$MOVE/manager.json" "$OLD" "$NEW" <<'EOF' | $K apply -f -
   import json, sys
   objects, old, new = json.load(open(sys.argv[1]))["items"], sys.argv[2], sys.argv[3]
   for o in objects:
       m = o["metadata"]
       o["metadata"] = {"name": m["name"], "namespace": new, "labels": m.get("labels", {})}
       o.pop("status", None); o.pop("secrets", None)
       for s in o.get("subjects", []):
           if s.get("namespace") == old: s["namespace"] = new
   print(json.dumps({"apiVersion": "v1", "kind": "List", "items": objects}))
   EOF
   $K create -n $NEW -f - <<EOF
   {"apiVersion": "v1", "kind": "Secret", "type": "kubernetes.io/service-account-token",
    "metadata": {"name": "orbit-mr-manager-token", "annotations": {"kubernetes.io/service-account.name": "orbit-mr-manager"}}}
   EOF
   $K patch clusterrolebinding orbit-mr-manager-storage --type json \
     -p "[{\"op\": \"add\", \"path\": \"/subjects/-\", \"value\": {\"kind\": \"ServiceAccount\", \"name\": \"orbit-mr-manager\", \"namespace\": \"$NEW\"}}]"
   for verb in "create pods" "get persistentvolumeclaims" "create secrets" "get persistentvolumes"; do
     $K auth can-i $verb -n $NEW --as=system:serviceaccount:$NEW:orbit-mr-manager | sed "s/^/$verb: /"
   done
   ```

   Every `can-i` answers `yes`, as it does for `$OLD` (`--as=system:serviceaccount:$OLD:orbit-mr-manager`).
4. The admission guard for the new namespace, a copy of the one in force under the new name (same URL and CA bundle):

   ```bash
   python3 -I - "$MOVE/webhook.json" "$NEW" "$NEW_GUARD" <<'EOF' | $K create -f -
   import json, sys
   w, new, name = json.load(open(sys.argv[1])), sys.argv[2], sys.argv[3]
   w["metadata"] = {"name": name, "labels": {**w["metadata"].get("labels", {}), "app.kubernetes.io/name": "orbit-cloud-runner"}}
   for hook in w["webhooks"]:
       hook["namespaceSelector"] = {"matchLabels": {"kubernetes.io/metadata.name": new}}
   print(json.dumps(w))
   EOF
   ```

   `create`, not `apply`: it refuses rather than replace an existing guard. It guards only `$NEW`, where nothing runs
   yet, and `$OLD_GUARD` keeps guarding `$OLD`.
5. The kubeconfig for the new identity: the current one with the context's namespace set to `$NEW` and the user's token
   replaced by the new Secret's. Make it on the k3s host and copy it beside the profile on the apiserver's host as
   `kubeconfig-orbit-ws03.json.$NEW`, mode 0600, never printing it:

   ```bash
   token="$($K get secret orbit-mr-manager-token -n $NEW -o jsonpath='{.data.token}' | base64 -d)"
   # with the current kubeconfig copied to $MOVE/kubeconfig.json (mode 0600):
   TOKEN="$token" python3 -I - "$MOVE/kubeconfig.json" "$NEW" >"$MOVE/kubeconfig.$NEW.json" <<'EOF'
   import json, os, sys
   k, new = json.load(open(sys.argv[1])), sys.argv[2]
   for c in k["contexts"]: c["context"]["namespace"] = new
   for u in k["users"]: u["user"] = {"token": os.environ["TOKEN"]}
   print(json.dumps(k, indent=2))
   EOF
   chmod 600 "$MOVE/kubeconfig.$NEW.json"; unset token
   ```

6. Optional, independent of the rest, and only where the API server's admission configuration is in a directory named
   after the namespace, as production's is (`/etc/rancher/k3s/orbit-managed/`, drop-in `90-orbit-admission.yaml`; the
   lab's is `/etc/rancher/k3s/orbit-admission/` and needs nothing): move it out of `/etc/rancher/k3s/$OLD/`. `cp -a /etc/rancher/k3s/$OLD /etc/rancher/k3s/$NEW`, replace `/etc/rancher/k3s/$OLD/` with
   `/etc/rancher/k3s/$NEW/` in `config.yaml.d/90-orbit-admission.yaml` and in `$NEW/admission-configuration.json`, then
   `systemctl restart k3s`. Pods keep running across the restart; the API answers again within a minute. Check that the
   guard still answers: the dry run of [step 4 of the deployment](#deploy-a-test-environment) (an unowned
   `mr-data-<uuid>` claim) is refused in `$OLD`. Remove `/etc/rancher/k3s/$OLD` in step 8.

### 2. Put every runner to sleep

Each runner must be `SLEEPING` with no Pod. A ready runner sleeps as its owner's **Sleep** does, which never interrupts
work: the manager drains it, and it exits only once idle by its own account.

```bash
$PSQL -c "select runner_id, management_state, desired_state, pod_uid is not null as pod, resource_operation_state from managed_runner where cluster_key = 'orbit-ws03' and namespace = '$OLD'"
$PSQL -c "update managed_runner set desired_state = 'SLEEPING', revision = revision + 1 where cluster_key = 'orbit-ws03' and namespace = '$OLD' and management_state = 'READY' and desired_state = 'RUNNING'"
```

Repeat the first query until every row says `SLEEPING`, no Pod and no operation; a drain gives up after
`lifecycle.drainSeconds` (600) if the runner stays busy, and new work wakes a runner again. A runner `STARTING` or
`FAILED` must first be brought to `SLEEPING`, or to `FAILED` with nothing in flight and its Pod gone: find out why
before the window.

### 3. Freeze management

Set `ORBIT_MANAGED_RUNNERS_ENABLED=false` in the apiserver host's `.env` and recreate the apiservers
(`$DC up -d --no-deps apiserver`, then any `apiserver-2` and on). Its log no longer says
`managed runners are enabled in ...`. Nothing managed moves now: no Pod or claim is created, stopped or deleted, and work
for a sleeping runner waits. Then check that the step-2 query still says every row `SLEEPING` with no Pod, and on the
k3s host that `$K get pods -n $OLD` lists nothing and no VolumeAttachment names their PVs
(`$K get volumeattachments`). If a runner woke between steps 2 and 3, switch back on, and start again at step 2.

### 4. Move each volume

Only the mappings' claims move: a namespace can hold others (the lab keeps smoke-test claims there), and step 5 refuses
a move no mapping matches. On the apiserver's host,
`$PSQL -Atc "select pvc_name from managed_runner where cluster_key = 'orbit-ws03' and namespace = '$OLD' order by pvc_name" >$MOVE/claims.txt`,
and copy it to `$MOVE` on the k3s host. There, with `scripts/managed-runner/move_volume_namespace.py` from this
repository, and a directory of its own for this attempt and direction (`forward`; a rollback uses `back`, a second
attempt `forward-2`), so that its `moved.tsv` holds only this attempt's moves:

```bash
DIR=$MOVE/forward
while read -r pvc; do
  KUBECTL="$K" python3 -I move_volume_namespace.py --from $OLD --to $NEW --pvc "$pvc" --backup $DIR --dry-run || break
done <$MOVE/claims.txt
while read -r pvc; do
  KUBECTL="$K" python3 -I move_volume_namespace.py --from $OLD --to $NEW --pvc "$pvc" --backup $DIR || break
done <$MOVE/claims.txt
```

Each refuses, having changed nothing, if its claim is not Bound, its PV is not `Retain` or not bound to it, a Pod mounts
it or a VolumeAttachment names its PV. Before deleting a claim it saves the claim and its PV in `$MOVE`; a run that
stopped part way is finished by running it again with the same directory. `$DIR/moved.tsv` gets one line per volume:
the claim's name, its old and new UIDs, the PV, its UID and its volume handle; it must have as many lines as
`claims.txt`. Copy it to `$MOVE/forward.tsv` on the apiserver's host.

### 5. Record the moves

On the apiserver's host, in one transaction, each update matched to exactly one row by everything recorded, and the
capacity pool's row with them:

```bash
{
  echo 'begin;'
  while IFS=$'\t' read -r pvc old new pv pvuid handle; do
    echo "do \$\$ declare n int; begin
      update managed_runner set namespace = '$NEW', pvc_uid = '$new', revision = revision + 1
       where cluster_key = 'orbit-ws03' and namespace = '$OLD' and pvc_name = '$pvc' and pvc_uid = '$old'
         and pv_uid = '$pvuid' and volume_handle = '$handle' and management_state = 'SLEEPING' and pod_uid is null;
      get diagnostics n = row_count;
      if n <> 1 then raise exception 'pvc % matched % rows', '$pvc', n; end if; end \$\$;"
  done <$MOVE/forward.tsv
  echo "update managed_runner_capacity set namespace = '$NEW' where cluster_key = 'orbit-ws03' and namespace = '$OLD';"
  echo "do \$\$ begin if exists (select 1 from managed_runner where cluster_key = 'orbit-ws03' and namespace = '$OLD') then raise exception 'a mapping is still in $OLD'; end if; end \$\$;"
  echo 'commit;'
} >$MOVE/record.sql
$PSQL -f - <$MOVE/record.sql
```

A mapping whose volume was not moved stops the transaction, and nothing is recorded.

### 6. Point the profile at the new namespace

In the managed runners' directory, replace `kubeconfig-orbit-ws03.json` with `kubeconfig-orbit-ws03.json.$NEW` (by a
rename, mode 0600), and in `profile.json` set `kubernetes.namespace` to `$NEW`, `admission.managerUsername` to
`system:serviceaccount:$NEW:orbit-mr-manager`, and, while there, `kubernetes.kubeconfig` to the file's path under
`/var/lib/orbit-cloud-runners/`. The kubeconfig's context namespace and the profile's must be the same: the apiserver
refuses to start managed runners otherwise.

### 7. Switch management back on, and wake one runner

Set `ORBIT_MANAGED_RUNNERS_ENABLED=true` and recreate the apiservers. The log says
`managed runners are enabled in orbit-ws03 (namespace orbit-cloud)`. Wake one runner (send a message to a session on
it): the manager proves the guard in `$NEW` with its dry-run probe, and the runner's Pod `mr-<runner uuid>` starts in
`$NEW` on the moved claim, with its files as they were. The others wake as work reaches them.

### Rollback

Until step 7 nothing has run on the moved volumes. To go back: with management still off (or off again, step 3), move
each volume back (the same loop with `--from $NEW --to $OLD` and `DIR=$MOVE/back`), record `back/moved.tsv` as in
step 5 with `$OLD` and `$NEW` swapped, put back the profile and the
kubeconfig from `$MOVE`, and switch management on. The new namespace, its manager identity and its guard can stay until
the move is tried again.

### 8. Clean up, once the runners have run in the new namespace

`$K get pvc -n $OLD` lists none of `claims.txt`. Then delete the old guard, `$K delete validatingwebhookconfiguration
"$OLD_GUARD"` (on production `orbit-managed-runner-pods`); delete the
namespace `$OLD` (its ServiceAccount, its token, its Role and RoleBinding and the earlier generations' bootstrap
Secrets go with it, and the token is no longer accepted); remove its subject from `orbit-mr-manager-storage`; remove
`/etc/rancher/k3s/$OLD` if step 1.6 moved it; and remove the old kubeconfig and profile copies from `$MOVE` once they
are no longer needed for a rollback.

## Where each setting lives

| Setting | Where | Applies after |
| --- | --- | --- |
| The switch and the profile's path | The authorized apiserver's environment (`ORBIT_MANAGED_RUNNERS_ENABLED`, `ORBIT_MANAGED_RUNNERS_PROFILE`) | Its restart |
| Cluster, context, namespace, API server, storage class, per-runner capacity, image digest, `serverUrl`, runner resources | The profile (`kubernetes`, `storage`, `runner`) | The apiserver's restart; a runner's resources and image at its next start |
| The capacity budget the manager admits runners into | The profile, `capacity` | The apiserver's restart |
| The floor a runner reclaims session checkouts at | Its owner's **Keep Free** on the runner's page; with none, a quarter of the claim's size | The runner's next heartbeat |
| Idle interval, attempts, backoff, poll, lease, startup deadline, heartbeat freshness, drain | The profile, `lifecycle` | The apiserver's restart |
| The manager's identity and rights | Its ServiceAccount, Role, ClusterRole and the kubeconfig the profile names | At once (RBAC); the kubeconfig at the apiserver's restart |
| The admission guard | `ValidatingWebhookConfiguration` `orbit-cloud-runner-pods`; the API server's admission configuration (token) | At once; the token at the API server's restart |
| One process, not the container, on out of memory (`singleProcessOOMKill: true`) | Each node's kubelet configuration; on k3s `/etc/rancher/k3s/kubelet-orbit.yaml`, loaded by `/etc/rancher/k3s/config.yaml.d/95-orbit-kubelet.yaml` | The k3s restart, for containers created after it |
| The webhook token's hash | The profile, `admission.webhookTokenSha256` | The apiserver's restart |
