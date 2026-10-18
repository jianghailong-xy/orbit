# Managed runners on Kubernetes: deployment, backup and restore, rollback and failover

This runbook is for an **authorized, isolated test environment** that runs managed runners on Kubernetes with Ceph RBD
storage: an Orbit apiserver with `ORBIT_MANAGED_RUNNERS_ENABLED=true` and a profile whose backend is Kubernetes.
Production deployment and enablement are outside the managed-runner project. Every account has a runner of its own: a
Pod `mr-<runner uuid>` in the managed namespace, its data claim `mr-data-<runner uuid>` (ReadWriteOnce, Filesystem, ext4
on kernel RBD), the claim's PersistentVolume (`Retain`) and an RBD image `csi-vol-…` in the runner pool. The volume holds
the account's checkouts, sessions, uploads, engine sign-ins and the runner's own identity; nothing else keeps a copy of
it. A deployment whose managed runners run on Docker has [its own runbook](managed-runner-docker-operations.md).

Every procedure here, and every number, comes from the single-machine lab ([docs/managed-runner-lab.md](managed-runner-lab.md))
on 2026-10-18 ([evidence](evidence/managed-runner-acceptance/2026-10-18/README.md)): k3s v1.36.5, Ceph 20.2.4, Ceph-CSI
v3.18.0, one node. What needs a second node is marked **Not verified here**. Read the [design contract](managed-runner-design.md)
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
   - `GET /api/auth/capabilities` answers `managedRunners.enabled: true`.
   - An account's next sign-in provisions: the mapping, the claim and the bootstrap Secret within seconds, the Pod once
     admission and capacity allow, `READY` at the runner's first heartbeat once a model is available (a signed-in
     runtime, or the owner's own enabled key). Measured: ⟪T08:provision⟫.
   - More than one apiserver may run the manager: a lease in the database gives each mapping one manager at a time.
     Sixteen concurrent sign-ins of two accounts over two replicas made one claim, one Secret and one Pod each
     (⟪T08:concurrent⟫).

## Find an account's runner

```sql
select u.email, m.management_state, m.desired_state, m.generation, m.attempt, m.runner_id, m.pvc_name, m.pvc_uid,
       m.pv_uid, m.volume_handle, m.pod_uid, m.node_name, m.last_error->>'code' as reason, m.last_error->>'detail' as detail
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
running runner left the object held by the finalizer, and the next generation started by itself
(⟪T08:rebuild-delete⟫). Without the finalizer the kubelet's final delete would remove the report within a second, and
a routine deletion would end in `FENCING`.

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
  on again later finds the generation gone without a recorded proof, so that runner waits in `FENCING`
  (`PREDECESSOR_STOP_UNPROVEN`) for a fencing receipt: prefer bringing a manager back if the runner is to run again;
- the Pod's node has been **fenced**: powered off through its BMC or hypervisor and kept out, or its Ceph clients
  blocklisted by a tested, persistent procedure, and the receipt below is (or is about to be) written. The manager reads
  the receipt once the object is gone.

**It must not be removed** while the node has not reported the stop and is not fenced: the phase is still `Running`,
`Pending` or `Unknown`, the node is `NotReady` or unreachable, or the Pod was marked terminal only by the control plane.
The processes on that node may still be writing to the volume. With the object gone, Kubernetes no longer accounts for
them, the attach/detach controller may force the volume's detach after its timeout, and an operator, or a receipt written
on the strength of "the Pod is gone", could let the next generation mount the same volume on another node: a second
writer to one ext4 filesystem and its SQLite files. A missing heartbeat, `NotReady`, a cordon or a timeout are not
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
   sleeps, and no message, task or wakeup wakes it; this also signs the account out. Measured: asleep ⟪T08:disable⟫
   after the disable.
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
   image exported and copied out of the VM in ⟪T08:export⟫; the archive was ⟪T08:archive⟫.
4. **Enable the account again.** Its runner wakes on its own volume at its next message, task or wakeup.

## Check a backup without the cluster

The archive is a raw ext4 image. Its checks need no Ceph, no Kubernetes, no mount and no kernel module (`debugfs` reads
it as a file), so they run on the backup host:

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
Git commit, every upload and engine transcript with its checksum, and `ok` for every SQLite file (⟪T08:verify⟫).

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
   claim mounted at `/var/lib/orbit` as the runner sees it: SQLite `integrity_check`, `git fsck`, the checksums. It runs no
   runner: never start `orbit run` on a restored copy while the account's runner exists, because the copy carries its
   credential.
4. **Afterwards** delete the check Pod. The restored claim, its PV and image stay until someone deletes them on purpose
   (`Retain`: delete the claim, then the PV, then `rbd rm` the image, or set the PV's reclaim policy to `Delete` first).

Measured in the lab: the claim, the write and the read-back, and the check Pod took ⟪T08:restore⟫. The new image read back
byte for byte as the backup; the Pod found it as ext4, the probe's file, rows and commit as backed up, the uploads,
worktrees and transcripts with their checksums, and `ok` everywhere. The original claim, PV, handle and RBD image were
untouched, and ann's runner then woke on its original volume with the same identity.

**What a restore does not do.** The manager accepts a runner's data volume only as recorded: the claim's UID, the PV's
UID and the volume handle. A new claim is never adopted, and the admission guard admits no Pod but the runner's own on the
runner's claim. So a restored copy cannot be put back under an account's runner by these steps. If the runner's own
volume is lost or damaged, the account's data can be handed over from the restored copy; putting it back as the runner's
volume needs a mapping switch the manager does not have yet (see the design's "Retention explicit deletion and backup").
Until then, a runner whose claim is gone stays `PVC_MISSING`, and nothing is created in its place.

## Rollback

**Switch managed runners off.** Set `ORBIT_MANAGED_RUNNERS_ENABLED=false` (or remove it) and restart the apiserver. The
switch is read at start-up. Management freezes: nothing is created, woken, put to sleep or deleted; claims, PVs and RBD
images stay; the managed API answers `404 MANAGED_RUNNER_DISABLED`; sign-in provisions nothing. A runner that was
running keeps serving its sessions as a runner, but nothing drains it and nothing restarts it, and a Pod deleted meanwhile
hangs `Terminating` ([above](#the-stop-report-finalizer)). So put the runners to sleep first: each owner's sleep, or
disable the accounts, and wait for `SLEEPING`. Measured with every runner asleep, unset and then `false`: messages, a
task run now and a task's run time made no managed write and no request to Kubernetes for ⟪T08:off⟫ each, every claim
was kept, and the waiting work woke the runners once the switch was on again.

**Roll the runner image back.** Set `runner.image` in the profile to the previous digest and restart the apiservers. A
running Pod keeps its image; each runner gets the pinned one at its next start, as its next generation. The admission
guard admits only the pinned image, so pin the previous digest, not a tag.

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

**A planned move off a node** (`kubectl drain`, maintenance): the eviction deletes the Pod, the finalizer keeps its
kubelet's report until the manager has it, the volume detaches, and the next generation is scheduled on another node
with the same claim. In the lab, with one node, an eviction, a delete and a crash each started the next generation on the
same volume (T04, and the T08 rebuild); the move to another node is **Not verified here**.

**A node that stops reporting** (power loss, network partition): its runner's Pod is not terminal by its kubelet, so the
mapping goes `FENCING` (`PREDECESSOR_STOP_UNPROVEN`). To bring the runner back elsewhere:

1. Identify the predecessor from the mapping: runner, generation, Pod name and UID, node, claim UID, volume handle, RBD
   pool and image.
2. **Fence the node.** Power it off through its BMC or hypervisor and verify the power state independently, then keep it
   out until its stale Pods and mounts are gone; or blocklist its Ceph clients by a tested, persistent procedure (record the
   addresses and nonces, the OSD map epoch, the expiry and the rejoin policy). A lock break, a temporary blocklist, a
   cordon or a token rotation is not fencing.
3. **Write the receipt** as ConfigMap `mr-fence-<runner uuid>`, key `receipt.json`, shaped like
   [fencing-receipt.example.json](../deploy/managed-runner/fencing-receipt.example.json), naming the predecessor exactly as
   the mapping records it ([Fencing receipt](../deploy/managed-runner/README.md#fencing-receipt)). An incomplete or unbound
   receipt is refused field by field (`FENCING_RECEIPT_INVALID`, seen in the lab, T02a) and opens nothing.
4. **Let Kubernetes release the volume**: the `node.kubernetes.io/out-of-service` taint on the fenced node (only after the
   power-off is verified), then [take the finalizer off](#the-stop-report-finalizer) the stale Pod. The manager waits for
   the object and the attachment to be gone, reads the receipt, and starts the next generation on another node.
5. Check the account's data on the new node (SQLite, Git, the engine's session), and keep the old node out until it is
   wiped or rejoined under the rejoin policy.

All of this is **Not verified here**: the lab has one node, and powering it off stops the cluster. What was seen on the
one node: `FENCING` after a stop nobody could prove (a force delete, T02a; a Pod gone with its finalizer stripped, T04), a
receipt refused field by field (T02a), the finalizer keeping an operator's delete provable (T04, T08), and the gate waiting
for the old attachment to go (T07b). An accepted receipt, the out-of-service taint, a second node's mount, and the old
writer's fate after a takeover have not been run on real nodes.

## Where each setting lives

| Setting | Where | Applies after |
| --- | --- | --- |
| The switch and the profile's path | The authorized apiserver's environment (`ORBIT_MANAGED_RUNNERS_ENABLED`, `ORBIT_MANAGED_RUNNERS_PROFILE`) | Its restart |
| Cluster, context, namespace, API server, storage class, per-runner capacity, image digest, `serverUrl`, runner resources | The profile (`kubernetes`, `storage`, `runner`) | The apiserver's restart; a runner's resources and image at its next start |
| The capacity budget the manager admits runners into | The profile, `capacity` | The apiserver's restart |
| Idle interval, attempts, backoff, poll, lease, startup deadline, heartbeat freshness, drain | The profile, `lifecycle` | The apiserver's restart |
| The manager's identity and rights | Its ServiceAccount, Role, ClusterRole and the kubeconfig the profile names | At once (RBAC); the kubeconfig at the apiserver's restart |
| The admission guard | `ValidatingWebhookConfiguration` `orbit-managed-runner-pods`; the API server's admission configuration (token) | At once; the token at the API server's restart |
| The webhook token's hash | The profile, `admission.webhookTokenSha256` | The apiserver's restart |
