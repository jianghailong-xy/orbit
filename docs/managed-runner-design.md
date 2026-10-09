# Managed runner deployment and data contract

This is the first implementation contract for an optional default runner on Kubernetes, with one
Ceph RBD filesystem PVC per user and one active runner instance per PVC. It is for the server,
runner, client, and storage implementers. Managed runners are **disabled by default**. This project
delivers code, separate optional templates, and isolated tests; it authorizes no production
deployment, infrastructure installation, or change to the existing deployment topology.

Status: design, 2026-10-04. Code observations below refer to repository commit
`72246fe2aec1d852cad06d568c3ec9ea844042c7`. New tables, interfaces, configuration, and template paths
in this record are proposed contracts for subsequent implementation, not features already present.
Actual cluster versions, credentials, hardware, quotas, and tenant population have not been supplied.
Their absence blocks infrastructure execution, not this design review.

## Scope and existing implementation

The existing apiserver remains the control plane. A small managed runner manager records desired
state in PostgreSQL and reconciles user Pods and PVCs in one explicitly configured test environment.
The existing session queue, heartbeats, runtime selection, and session leases continue to execute
work. No general cloud scheduler, new model platform, billing system, or dynamic flag service is added.
Self-managed runners remain supported alongside the optional managed runner.

| Repository evidence | Existing behavior and implementation consequence |
| --- | --- |
| [Prisma schema](../src/apiserver/prisma/schema.prisma) | `Runner` is owner-bound; its status is `ONLINE`, `OFFLINE`, or `DRAINING`. `Workspace.runner` has `onDelete: Cascade`. Compute removal must preserve the runner row. Managed provisioning needs its own durable unique mapping. |
| [Auth service](../src/apiserver/src/auth/auth.service.ts) | Login and bootstrap currently issue tokens; refresh also calls `tokenFor`. Add provisioning intent after successful login/bootstrap, not inside token issuance or token refresh. |
| [Workspaces service](../src/apiserver/src/workspaces/workspaces.service.ts) | Binding verifies runner ownership; deletion is soft deletion and protects project coordinators. Reuse those checks and preserve workspace IDs and ordering. |
| [Queue service](../src/apiserver/src/queue/queue.service.ts) | Claims use a transaction advisory lock, owner predicates, provider capabilities, and active-turn caps. These are session execution limits, not infrastructure admission or storage fencing. |
| [Reaper service](../src/apiserver/src/realtime/reaper.service.ts) | Sweeps every 30 seconds; runner silence exceeds its offline threshold at 90 seconds. Active turns can be finalized after losing a runner; idle `AWAITING_INPUT` sessions can survive. Silence does not prove a node stopped writing. |
| [Runner config](../src/runner-go/config.go) | `config.json` persists runner ID and credential under `ORBIT_HOME`; private directory/file modes are 0700/0600. `runs` and `codex-state` also live there. |
| [Run loop](../src/runner-go/runloop.go) and [session shutdown](../src/runner-go/session.go) | Heartbeats run every 30 seconds and continue during drain. The current supervisor shutdown envelope is 170 seconds, including the 100-second turn drain and release/flush backstops. Kubernetes termination must leave time beyond that envelope. |
| [Worktrees](../src/runner-go/worktree.go) | Per-session checkouts and upload scratch live under `ORBIT_HOME`; Git metadata contains absolute paths. Preserve both the primary checkout and worktree root. Existing GC is distinct from PVC lifecycle. |
| [Codex state](../src/runner-go/codex_state.go) | Shared partitions are keyed by the cleaned absolute `CODEX_HOME`; persisted layout/home/partition markers govern resume. Legacy and credential-isolated state can live under session scratch. Preserve all layouts. |
| [Runner API](../src/apiserver/src/runner-api/runner-api.controller.ts) | Enrollment derives owner from an enrollment token and reuses a name match; deregistration hard-deletes the runner. Neither is a safe managed provisioning identity or managed delete path. |
| [Workspace provider seed](../src/apiserver/src/workspaces/workspace-provider.ts) | A workspace stores no provider; a new workspace currently defaults to Claude before it has history. Managed first-session selection must positively select a supplied, ready runtime instead of inheriting an unavailable engine. |

## Default disabled gate

Use the server environment variable **`ORBIT_MANAGED_RUNNERS_ENABLED`**. Read it once through a small
server configuration provider after the existing global Nest `ConfigModule` has loaded configuration.
Follow the repository's `ORBIT_*` environment configuration and guarded route conventions, including
the invalid-value handling of [wiki rollout](../src/apiserver/src/wiki/wiki-rollout.ts), with this
feature's stricter default:

| Input after trimming and lowercasing | Effective value |
| --- | --- |
| Absent, empty, or `false` | Disabled |
| `true` | Enabled |
| Any other string, including `1`, `yes`, and `on` | Disabled; log one configuration warning |

Changes take effect on server restart. There is one shared effective value for controllers,
authentication hooks, API guards, background services, and the capability response. No browser build
variable or runner label can enable the feature. All API replicas must use the same value; mixed
configuration is an invalid test setup. A disabled worker must not consume existing managed intents.

| Boundary | Required disabled behavior | Required enabled behavior |
| --- | --- | --- |
| Dependency construction and module initialization | Construct only the inert configuration/status facade. Do not construct a Kubernetes client, read kubeconfig, try in-cluster discovery, validate Ceph secrets, register watches, or start a reconcile timer. | Validate the explicitly selected environment, RBAC, storage profile, image, admission protection, resource budget, and model supply before reconciliation starts. Missing prerequisites make the managed service unavailable while ordinary login remains usable. |
| Successful login and first-user bootstrap | No managed intent, runner, workspace, credential, or PVC write. | Idempotently record owner-scoped provisioning intent after authentication; login does not wait for Pod readiness or contact Kubernetes. Provisioning failure must not invalidate the issued login session. |
| Refresh, logout, password change, and capability reads | Preserve existing authentication behavior; reads have no provisioning side effects. | Still no implicit allocation. Login/bootstrap and explicit ensure are the allocation entry points. |
| Ensure, retry, wake, sleep, or delete APIs | Authenticate first, then return `404 MANAGED_RUNNER_DISABLED` before any managed DB write or infrastructure call. | Record a valid desired-state transition; the manager performs resource operations. Retry never creates a second mapping or bypasses fencing. |
| Messages, executable tasks, scheduled work, watch wakes, and auto retry | Continue existing self-managed queue behavior. No managed allocation, wake, sleep, or cleanup hook runs. | Only demand addressed to this owner's managed mapping requests wake; hooks run before an offline runner gate can prevent demand from being recorded. |
| Three client applications | Missing capability or `enabled: false` preserves existing onboarding, navigation, workspace selection, and self-managed runner controls. Hide managed provisioning and retry flows. | Render the common server state contract; clients do not infer enabled status from runner names or offline heartbeats. |
| Turning the flag off with existing resources | Freeze management. Do not stop Pods, revoke credentials, delete intents/PVCs, remove finalizers, or perform automatic orphan cleanup. Existing execution/heartbeat protocols can continue for an already running managed instance. | Re-enabling resumes reconciliation from stored identities after checking observed resources; it is not a fresh enrollment. |

The default server must start using its ordinary database/auth/provider requirements with **no
Kubernetes or Ceph credentials**. A disabled managed facade returns before any cluster credential
validation. If drain is wanted before disabling, an operator must explicitly drain while enabled;
setting the flag to false is not a shutdown or data-deletion command.

Keep `.env.example`, root Compose, `/upgrade`, release workflows, installation scripts, and normal
`dev`/`start` entry points disabled. A later configuration reference may document a commented
`ORBIT_MANAGED_RUNNERS_ENABLED=false`; no default entry point forwards an inherited session variable
as an opt-in or installs Kubernetes, Rook, Ceph, CSI, or managed workloads.

## Identity and durable mapping

For an enrolled user, the mapping is:

```text
User.ownerId
  -> ManagedRunner.ownerId UNIQUE
       -> Runner.id UNIQUE and stable
       -> Workspace.id UNIQUE and stable for the default workspace
       -> (clusterKey, namespace, pvcName, pvcUID) for one independent data PVC
            -> PV UID and CSI volumeHandle -> one Ceph pool and RBD image
       -> zero or one authorized Pod UID for the current instance generation
```

The mapping is keyed by the authenticated owner UUID, never email, hostname, display name, or
user-controlled labels. All owner IDs in runner/workspace/session associations must agree, enforced
by database ownership constraints and owner-scoped services. Existing users can retain any number of
self-managed runners/workspaces; only the default **managed** mapping is unique per user.

Proposed `managed_runner` fields are `ownerId`, `runnerId`, `defaultWorkspaceId`, `desiredState`,
`managementState`, `generation`, `revision`, `clusterKey`, `namespace`, `pvcName`, `pvcUid`, `pvUid`,
`volumeHandle`, `podName`, `podUid`, `nodeName`, `nodeUid`, `reservation`, `demandRevision`,
`lastDemandAt`, `initialProvider`, `resourceProfileId`, `resourceOperationId`, `resourceOperationState`,
`attempt`, `nextAttemptAt`, `lastError`, `fencingReceipt`, and `deletedAt`.
Record creation/update times as usual. Use the schema's camelCase fields and snake_case database
mapping. Unique constraints cover `ownerId`, `runnerId`, `defaultWorkspaceId`, and the cluster/PVC
location; recorded PVC UID/volume handle cannot be adopted by another mapping. References that would
discard the storage/fencing record on account or runner deletion must restrict deletion, not cascade.

The instance generation is a monotonically increasing execution incarnation. It differs from the
mapping revision used for compare-and-set updates. `podUid` identifies the actual Kubernetes object;
a reused Pod name does not mean the old process stopped. Persist predecessor identities until stop
or fencing is proven. An expired manager lease permits another reconciler, not another data writer.

Use deterministic names derived from the internal runner UUID: `mr-<runner-uuid>` for the Pod and
`mr-data-<runner-uuid>` for the PVC, in the configured managed namespace. API IDs keep the existing
public ID codec; Kubernetes names use canonical UUIDs. PVCs have no owner reference to a Pod, Job,
or other disposable compute resource. A PVC name found with a different UID, owner, storage profile,
or volume handle is a conflict requiring review; never silently replace it with an empty disk.

Create the mapping, runner row, and default workspace together in a retriable database transaction.
Keep network/resource operations outside that transaction. A concurrent request that loses the
owner unique constraint reads and returns the winner. Kubernetes creates use deterministic names;
an ambiguous timeout is followed by a read and identity comparison before retrying. Existing desired
state is the durable work queue for reconciliation, so process restarts cannot lose provisioning.

Managed bootstrap is a trusted manager path binding the already created runner ID to its owner.
Do not repeatedly call ordinary `orbit register`, match by machine name, or mint a public enrollment
token. Store raw bootstrap/runner credentials only in an owner-specific Kubernetes Secret and the
private runner config; store only their hash in the control plane. Issue a new credential for a
replacement generation after the predecessor has stopped or been fenced. The init step checks the
expected ID, generation, and PVC before updating config. Same-Pod process restarts reuse its identity.
Managed runner authentication must bind every heartbeat, poll, event, and session lease operation to
the authorized Pod UID/generation, with a positive protocol capability; reject predecessor writes.
Self-managed authentication retains its current protocol.

## Management and execution states

Store desired state separately as `RUNNING`, `SLEEPING`, or `DELETED`. Absence of a mapping is the
read state `NOT_PROVISIONED`. The manager alone advances observed management state:

| Management state | Meaning and next transition |
| --- | --- |
| `REQUESTED` | Intent recorded. Evaluate storage and compute admission. |
| `WAITING_CAPACITY` | An identified compute, storage, quota, or model requirement is unavailable. Keep demand and retry after capacity changes; no duplicate resources. |
| `PROVISIONING` | Adopt/create the recorded PVC and bootstrap Secret. Await bound storage; partial success is reusable. |
| `STARTING` | Exactly one authorized Pod is attaching/initializing; await a matching heartbeat, healthy mount, and usable runtime. |
| `READY` | Authorized instance is running, heartbeat is fresh, and required runtime is available. New session turns may be claimed. |
| `DRAINING` | Stop claims, wait for active and background work to finish/release, then stop compute. Demand arriving during drain is preserved. |
| `SLEEPING` | Compute is stopped and detached; stable IDs, workspace, PVC, and data remain. Demand requests admission and `STARTING` again. |
| `FENCING` | Predecessor cessation cannot yet be proved. Block replacement, keep the disk, and require a specific stop/fencing receipt. |
| `FAILED` | Bounded attempts exhausted or a configuration/storage conflict requires action. Preserve data and structured cause; safe cases permit explicit retry. |
| `DELETING` | Explicit deletion intent accepted; drain/fence first, retain an audit record until the storage disposition is settled. |
| `DELETED` | Terminal tombstone. Login does not recreate data; ordinary retry cannot undo explicit deletion. |

`Runner.status` remains the existing heartbeat observation. `READY + OFFLINE/stale` means unavailable
and eligible for investigation, not proven dead; `SLEEPING + OFFLINE` is expected. The manager cannot
manufacture `ONLINE` to pass a dispatch gate. Pod `Running` alone does not make the environment ready.
Expose both states and `lastHeartbeatAt`, with an explicit server-derived `usable` boolean.

## Persistent filesystem layout

Mount the entire per-user PVC at **`/var/lib/orbit`** as an ext4 filesystem. The managed image uses
the following fixed absolute locations on every node and image rebuild:

| Location or environment | Data to retain |
| --- | --- |
| `HOME=/var/lib/orbit/home` | User-owned runtime configuration, engine histories, and non-rebuildable state under the home directory. |
| `ORBIT_HOME=/var/lib/orbit/home/.orbit` | The complete machine directory, including private `config.json`, credential/account slots, run metadata, and local recovery markers. |
| `$ORBIT_HOME/runs/<canonical-session-id>` | Session metadata, supervisor/event state, legacy Codex state, and isolated engine homes. |
| `$ORBIT_HOME/worktrees/<canonical-session-id>` | Session Git checkouts and worktree metadata. Retain alongside the original repository's `.git` directory. |
| `$ORBIT_HOME/uploads/<canonical-session-id>` | Downloaded/uploaded attachment scratch until normal session-aware GC; restart must not wipe it. |
| `$ORBIT_HOME/codex-state/<partition>` | Runner-wide Codex SQLite database partitions, together with WAL and SHM files. |
| `CODEX_HOME=/var/lib/orbit/home/.codex` | Default Codex configuration, authentication when used, history, and engine sessions. Additional account homes keep their persisted paths. |
| `CLAUDE_CONFIG_DIR=/var/lib/orbit/home/.claude` | Claude state when this supplied runtime is enabled. Other supported runtimes keep state below the same persistent home. |
| `/var/lib/orbit/home/orbit-repos` | Checkout root reported by existing `reposRoot()`; default workspace `workDir` is `/var/lib/orbit/home/orbit-repos/default`. |

Persist the whole home/machine directories, not just the named examples. The image and executable
tools are reproducible, `/tmp` and container runtime sockets are ephemeral, and the authoritative
user/workspace/session queue and transcript stay in PostgreSQL. Container paths, UID/GID, and relevant
engine versions must remain compatible across rebuilds. Image startup initializes missing directories
only and validates volume identity; it must not overwrite a populated checkout or re-enroll a runner.
Set `ORBIT_NO_SELFUPDATE=1` and disable automatic engine installation in the managed image; update
pinned image/runtime digests through the drain/replacement workflow rather than mutating an image.

Keep the existing private config modes. Git worktree absolute paths and Codex partition hashes make
moving `HOME`/`ORBIT_HOME`/`CODEX_HOME` a data migration, not an incidental template edit. Managed
workspace work directories and runtime-home overrides must remain within the user's PVC; reject
host paths and another user's paths. This restriction is specific to managed environments.

Several sessions can execute inside **one runner Pod**, with distinct worktrees and multiple local
processes coordinating SQLite through the local filesystem. This is not multiple Kubernetes Pods
or different nodes concurrently mounting and writing the same ext4 volume. SQLite WAL requires
same-host shared-memory coordination; the proposed RBD block mapping presents ext4 on one node.
CephFS/RWX is outside this first version and is not a substitute for this SQLite arrangement.
[SQLite WAL documentation](https://www.sqlite.org/wal.html) supplies the filesystem constraint;
crash/recovery correctness of the selected stack still requires the tests below.

## Provisioning retry wake and sleep

1. Successful login/bootstrap, while enabled, records `RUNNING` intent for the unique mapping.
   Create the default workspace only once, bound by both physical `runnerId` and routing
   `targetRunnerId`; its default directory is the fixed path above. Set `autoInitGit: true` and
   `enableWorktree: true` for this managed workspace so the existing runner can initialize its
   checkout and isolate concurrent sessions. Keep task/delegation permissions at their existing
   disabled defaults until explicitly granted. Existing workspace selections,
   manually removed defaults, project bindings, and deep links are not overwritten by login.
2. Admit durable storage and initial compute before resource creation. If unavailable, return the
   durable waiting state. Reconcile the PVC/Secret/Pod independently and preserve successful stages.
   Classify quota denial, image-pull, scheduling, attach, missing model, and ownership conflicts.
3. Readiness requires the expected Pod/generation, a mounted original PVC, a fresh owner-bound
   heartbeat, directory probes, and at least one supplied runtime with usable credentials/model.
   Persist the managed `initialProvider` selection, derived from that supply. For a workspace with
   no history, the server/client first-session path uses it explicitly; never globally replace the
   self-managed Claude seed or fall back to an uninstalled/unauthenticated engine.
4. Transient errors use persisted backoff with jitter, a maximum attempt count and startup deadline.
   The optional test profile must state concrete values before enabling; they are not infrastructure
   facts available here. Startup budgets must accommodate the existing Codex shared-state startup
   allowance. Permanent conflicts pause immediately. An explicit safe retry resets the attempt
   budget for the same mapping and preserves the PVC; it does not discard partially created state.
5. A new message/queued executable turn, a runnable task, or due scheduled/background work records
   demand and requests `RUNNING`, even when the managed runner is asleep. Use existing dispatch
   permission, dependency, cancellation, and provider checks before declaring a task runnable.
   Hooks must precede online-only dispatch/resume gates; notify plus a database demand sweep repairs
   missed notifications. Reuse existing turn/idempotency keys rather than add a second session queue.
6. Specifically integrate [scheduled wake delivery](../src/apiserver/src/runner-api/scheduled-wakeup.worker.ts),
   watch delivery, project/task dispatch, `SessionsService.createTurn`/resume, and
   [auto retry](../src/apiserver/src/sessions/auto-retry.service.ts). The latter currently waits on
   `RUNNER_OFFLINE` and can disarm after 30 minutes. Managed sleep/capacity wait must request wake
   and surface a durable waiting reason without spending a provider retry attempt or reaching that
   ordinary offline give-up path. True execution loss still follows the existing reaper/lease rules.
7. Idle means no active turn, leased/queued executable inbox item, runnable task demand, live
   background job/child operation, merge/cleanup/install/login/reset operation, or unflushed events.
   An `AWAITING_INPUT` history can sleep only after its supervisor is detached and no job requires it.
   A future wakeup can remain on the server; an already due wakeup prevents sleep. Missing or stale
   idle telemetry prohibits automatic sleep. The test profile defines the idle interval.
8. Under the mapping mutex, record the observed demand revision and request drain. Managed claims
   must refuse `DRAINING` as well as unauthorized generations. Keep heartbeats running during drain.
   Before stopping, compare demand revision again: abort sleep for new demand, or finish stop then
   wake once with the saved demand. Require supervisor/lease/job/event acknowledgements and a
   termination grace period greater than the current 170-second envelope plus preStop/unmount budget.
   Do not assume the default Kubernetes grace period is sufficient. Stop/detach must be proven before
   marking `SLEEPING` or releasing compute reservation; PVC storage reservation remains.

## Single Pod and single writer protection

The first version selects **RWO, Filesystem, ext4, and the kernel RBD mounter** on a verified stack.
Kubernetes RWO permits multiple Pods on the same node. Kubernetes RWOP is stable from v1.29, but the
Ceph-CSI v3.18.0 matrix still marks both RBD RWOP modes Alpha and advises against Alpha production
use. RBD `exclusive-lock` can transfer cooperatively between clients and does not make two mounted
ext4 filesystems safe. These are separate storage and application constraints.
[Kubernetes access modes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#access-modes),
[Ceph-CSI matrix](https://github.com/ceph/ceph-csi/blob/v3.18.0/README.md#support-matrix), and
[Ceph exclusive locks](https://docs.ceph.com/en/latest/rbd/rbd-exclusive-locks/) establish those limits.

Use a **manager-created bare Pod with a fixed name** and `restartPolicy: Never` for the first version.
This avoids a Deployment rolling update, ReplicaSet, StatefulSet repair, Job retry, or autoscaler
creating a successor independently of the manager's fencing decision. Container/init processes
belong to that one Pod. A controller restart adopts its recorded Pod UID; it does not start another.
Pod recreation is the only compute restart and follows the predecessor cessation gate.

The optional environment must install a validating admission guard with `failurePolicy: Fail`
before any managed PVC is usable. The guard checks **every Pod referring to a managed PVC**, including
unlabelled Pods, read-only mounts, Jobs, init/sidecar containers, and updates/ephemeral-container
subresources. It resolves PVC ownership, not caller-provided labels. It permits only the manager
service account, the fixed Pod name, current reserved generation, approved image/security template,
and that owner's PVC. Disallow extra applications/debug/backup Pods using the original volume.
Tenants have no Kubernetes API credential, no Pod/PVC/Secret create rights, no host mount or raw
device access, and no ability to create another PV/PVC alias to the same RBD image.

The admission reservation is persisted atomically under the mapping row mutex, not implemented as
“list Pods, then allow if none”. Only one generation/name can be reserved. The fixed Kubernetes
namespace/name provides atomic object uniqueness for competing creates of that generation; the
manager also retains a single in-flight resource operation and rereads after an ambiguous response.
Different names or generations are refused even on the same node. A stuck reservation is reconciled
against the Pod UID and resource-operation result, never freed simply because its lease expired.
Without the database or admission service, creation fails closed. Cluster administrators are trusted
infrastructure operators; bypass by those operators is outside the tenant security boundary and
must be a recorded maintenance operation.

After a create timeout, a single `GET` returning 404 does not prove the pending create cannot still
commit. Retain that operation's reservation and generation; retries use the same fixed name and
generation. Do not advance generation, finish sleep, or release compute until the operation is
settled and any resulting writer has stopped. If that cannot be established, leave the mapping
unavailable for operator reconciliation rather than authorize a competing incarnation.

Normal replacement requires drain, all container processes stopped, successful CSI unpublish/unstage
and detach, no old mount/client remaining, and preserved volume identity. Only then retire the Pod
UID, advance generation, issue its credential, and create the replacement on another eligible node.
Deletion of a Kubernetes API object, disappearance of a `VolumeAttachment`, or a manager lock alone
is insufficient evidence that a partitioned machine stopped using the disk.

For an unreachable node, persist `FENCING` and block replacement. The first supported fault path is
operator-confirmed fencing in the authorized test environment:

1. Identify the predecessor by Pod UID, node UID, generation, PVC UID, volume handle, and RBD image.
   Stop new claims and reject the predecessor's managed API generation. Preserve the mapping and
   pending demand. No timeout or user retry may authorize disk access by a successor.
2. A privileged infrastructure operator powers off the old node through its hypervisor/BMC and
   verifies that state, then quarantines it from scheduling/restart until stale Pods/mounts are
   removed. Record the control action and independent observed power/cessation result. No such
   operator access is assumed to exist here.
3. Storage/network fencing is an alternative only after a separate tested procedure proves all
   old client connections are denied by the OSDs and the old node cannot reconnect under the shared
   CSI key. Record blocklisted client addresses/nonces, OSD map epoch/propagation, expiry/renewal,
   isolation persistence, and rejoin policy. One lock break, token rotation, temporary blocklist,
   or cordon is not sufficient. A storage partition alone cannot prove fencing.
4. After confirmed power-off or validated equivalent, operators can apply the documented
   `node.kubernetes.io/out-of-service` procedure to permit Kubernetes detach, and remove residual
   attachment state using the storage operator's runbook. The manager consumes a receipt bound to
   this predecessor and volume before authorizing a new generation. If proof is missing, remain
   `FENCING`; failover availability is deliberately limited by the available fencing mechanism.
5. Mount the original volume on node B, allow ext4/SQLite crash recovery, verify data and session
   resume, and keep the old node quarantined. Rejoin only after stale execution/mappings are gone;
   a late predecessor cannot authenticate or regain storage access.

Kubernetes warns that forced detach while a workload still runs can corrupt data, and that the
out-of-service taint requires prior verification of shutdown. The optional cluster profile must
record controller-manager forced-detach behavior; timeout-driven detach never supplies Orbit's
fencing receipt. If that behavior defeats the tested protection, enabling is blocked until the
test cluster operator supplies a safe configuration.
[Kubernetes node shutdown documentation](https://kubernetes.io/docs/concepts/cluster-administration/node-shutdown/)
supports this operational prerequisite; this project does not change production controller settings.

The required proof has two parts: no second Pod is admitted against the original PVC, and no
predecessor can successfully write after takeover. Database locks, heartbeat leases, RWO, and
exclusive-lock each cover only part of that proof. The concrete multi-node test plan below must
establish both before claiming storage acceptance.

## Ceph integration and compatibility

The preferred optional test topology is an **external Ceph test backend supplied by its storage
owner**, consumed by an isolated Kubernetes test cluster using its supported Ceph-CSI installation.
Use a dedicated test pool/identity and approved namespaces; do not reuse a production data pool or
install a second CSI driver over an existing one. Actual provider location and authorization remain
pending. Rook external mode can import provider configuration without managing the provider's OSDs.
[Rook external cluster documentation](https://rook.io/docs/rook/latest/CRDs/Cluster/external-cluster/external-cluster/)
describes that separation.

An in-cluster Rook-managed **test** Ceph backend is a separate optional variant, requiring explicit
authorization for its operators/CRDs/privileged CSI plugins and enumerated disposable disks. It is
not an automatic fallback when external credentials are missing. No `useAllDevices`, disk discovery
that consumes host data, or single-node demo storage is a production design. Existing production
external/Rook topology is an input to a future enablement review and is unchanged by this project.

Official documentation checked on 2026-10-04 gives the following reference ranges. Feature minima,
release maintenance, distro support, and tested combinations are different questions:

| Component | Verified reference | First-version disposition and missing evidence |
| --- | --- | --- |
| Kubernetes | Current release page lists maintained branches 1.35–1.37; 1.34 has an EOL date of 2026-10-27. | Actual API server, kubelet, container runtime, controller flags, and distribution support are pending. Match the CSI tested window; no automatic upgrade. [Release policy](https://kubernetes.io/releases/). |
| Ceph-CSI v3.18.0 | Tested Kubernetes versions are 1.34, 1.35, 1.36. RBD filesystem RWO is GA; RWOP is Alpha. Its RBD feature minimum of Pacific 16.2.0 is not a currently supported Ceph recommendation. | RWO is the selected baseline. Pin driver/operator/sidecar image digests and current support window. No RWOP production claim; no ARM64 assumption, since this matrix labels it experimental. [Versioned matrix](https://github.com/ceph/ceph-csi/blob/v3.18.0/README.md). |
| Ceph release | Active releases are Tentacle 20.2.4 and Squid 19.2.6; estimated EOL dates are 2027-06-01 and 2026-10-31 respectively. Older Pacific/Quincy/Reef releases are archived. | Actual cluster version and maintenance provider are pending. A new candidate must have a maintenance horizon suitable for the intended rollout. [Ceph release index](https://docs.ceph.com/en/latest/releases/). |
| CephX key format and kernel | The August 2026 Ceph security release introduces `aes256k`; upstream kernel support starts at 7.0, with named distro backports. | Record real kernel build, vendor backport, client libraries, and key type on every runner node. A version string such as 5.4+ alone cannot establish compatibility with these keys. No silent credential downgrade. [Ceph release and key guidance](https://ceph.io/en/news/blog/2026/v20-2-4-v19-2-6-combo-released/). |
| Rook when used | Rook 1.19 supports Kubernetes 1.30–1.35; 1.20 supports 1.31–1.37. Both list Squid 19.2.0+ and Tentacle 20.2.1+. Only the most recent two minor series are maintained. | Pin the selected patch, its supported CSI integration, and security fixes. These ranges do not waive Ceph EOL/key requirements. [Rook support table](https://rook.io/docs/rook/latest-release/Getting-Started/maintenance-and-support/). |
| Kernel mounter | Rook requires an RBD-enabled Linux kernel; its baseline image feature is `layering`. Additional listed features require compatible kernels. | Use maintained amd64 Linux and kernel RBD with explicit feature selection. Record `uname -r`, module/distro evidence, ext4 and Ceph auth compatibility, actual map/mount behavior, and reboot recovery on every eligible node. [Rook node prerequisites](https://rook.io/docs/rook/v1.19/Getting-Started/Prerequisites/prerequisites/). |
| `rbd-nbd` mounter | The separately published mounter document recommends kernel 5.4+ and still labels this path Alpha. | Excluded from the baseline; do not silently fall back to it when kernel RBD fails. Its release-specific support would need a separate review. [Mounter document](https://github.com/ceph/ceph-csi/blob/devel/docs/design/proposals/rbd-nbd.md). |
| CSI deployment mechanism | v3.18 release notes recommend Ceph-CSI Operator; Helm deployment tests are deprecated. | Reuse the test environment's supported installation. New optional direct CSI installation follows its pinned Operator instructions; do not assume an old Helm recipe is validated. [Release notes](https://github.com/ceph/ceph-csi/releases/tag/v3.18.0). |

A candidate to assess, not an assertion about installed infrastructure, is Kubernetes 1.35/1.36,
Ceph-CSI 3.18.0, maintained Tentacle with the required security/key fixes, and kernel RBD on a vendor
supported node image. Rook 1.19 intersects that CSI range at Kubernetes 1.35; Rook 1.20 also intersects
at 1.36. Select exact patches/digests only after the test owner provides the environment and confirms
the full intersection, node authentication, and CSI sidecars. Recheck support dates before any later
production enablement. Do not substitute the broad feature minimum for production support.

The storage owner supplies an RBD-initialized replicated test pool with explicit replica count,
`min_size`, CRUSH failure domain/device class, usable capacity and headroom, PG policy, and health
requirements. Those numbers follow the supplied storage failure domains/disks and workload budget,
not the number of Kubernetes compute nodes. Do not set `size: 1` or `min_size: 1` to make a failing
test pass. Erasure-coded data pools and special image features are outside the initial profile.

| Storage profile field | Required contract |
| --- | --- |
| CSI `clusterID` | An immutable configured identifier, conventionally the Ceph FSID, matching the CSI configuration's MON endpoints. Record the actual CSI driver name; Rook can use a namespace-prefixed driver. |
| `pool` and StorageClass name | Explicit approved test values; never rely on the cluster's default class or alter a production class. |
| Volume and filesystem | PVC `volumeMode: Filesystem`, `accessModes: [ReadWriteOnce]`, `csi.storage.k8s.io/fstype: ext4`. |
| Mounter and features | Kernel RBD; start with validated `layering`. `tryOtherMounters: false`. Extra features, including exclusive-lock, need node support and do not relax single Pod rules. |
| Binding and sizing | `volumeBindingMode: Immediate` for the baseline with all approved nodes able to reach this pool. Explicit per-user storage request; avoid unvalidated topology-aware features. |
| Retention and growth | `reclaimPolicy: Retain`; PVC is independent of compute. Expansion stays disabled until quota/accounting and the selected driver growth path are verified. |
| Secret references | Explicit provisioner, controller publish/expand as applicable, node-stage, and optional snapshot Secret names/namespaces as required by the pinned driver profile. Credentials live in protected infrastructure Secrets. |

[Ceph-CSI storage configuration](https://ceph.github.io/ceph-csi/rbd/deploy/) provides parameter semantics;
the table above is Orbit's narrower proposed profile, not a copied default template. A StatefulSet
variant, if introduced later, must retain PVCs both on deletion and scale-down and preserve the same
fencing gate. [StatefulSet retention](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/#persistentvolumeclaim-retention)
does not replace PV reclaim policy or proof of predecessor termination.

For the documented baseline RBD operations, the pool-scoped CSI CephX identity needs:

```text
mon: profile rbd
osd: profile rbd pool=<approved-test-pool>
mgr: profile rbd pool=<approved-test-pool>
```

These are the documented RBD caps for provisioner/controller expand/node-stage operations, not
`client.admin` or unrestricted `allow *`. Use a distinct test CSI client and rotate through the
storage owner's Secret process. Further namespace scoping or separation of node/provisioner
identities must be checked against the pinned CSI profile rather than inventing narrower caps that
break attach or fencing. A dedicated pool isolates this CSI principal's storage authority; it is not
per-user cryptographic isolation. Snapshot/backup/fencing administration has separate privileges.
[Versioned Ceph-CSI capabilities](https://github.com/ceph/ceph-csi/blob/v3.18.0/docs/capabilities.md) supplies
the minimum documented profile. Neither the apiserver manager nor user runner process receives
CephX keys; CSI components hold them. Runner Pods receive only their own Orbit/runtime credentials.

Kubernetes nodes and CSI components must reach the Ceph **public/client** network's MONs and every
OSD address advertised to clients, not just one bootstrap MON or the apiserver. Document actual
addresses, DNS, routes/NAT, MTU, throughput, latency, TLS/msgr settings, and firewall owners. Typical
Ceph ports are MON TCP 3300/6789 and daemon TCP 6800–7568, subject to the actual cluster configuration.
OSDs also need replication/heartbeat/recovery connectivity on the configured cluster network, if
separate; user Pods do not need that network or Ceph access. Client traffic and recovery contention
must fit the approved network budget. No firewall or production route is changed here.
[Ceph network reference](https://docs.ceph.com/en/tentacle/rados/configuration/network-config-ref/) explains
client-to-OSD connectivity and the two network roles.

## Resource admission model supply and isolation

Maintain a fixed resource profile for this first version, with values supplied by the test owner.
Admission reserves CPU requests, memory requests, ephemeral storage, Pod/attach slots, per-user
durable bytes, pool capacity headroom, and maximum concurrently active managed users. Reservations
are updated atomically in PostgreSQL and backed by Kubernetes requests/limits, ResourceQuota, and
LimitRange. Pending admitted Pods count against compute capacity; sleeping users continue to count
against retained storage. Release compute only after stop/fencing proof. Do not sum observed usage
or `maxConcurrent` and call it free infrastructure capacity.

Use Ceph safe usable capacity, accounting for replication, near-full thresholds, retained images,
snapshots and backup headroom, rather than advertised raw disk bytes or thin-provisioning optimism.
Capacity wait does not delete disks, evict unrelated users, change infrastructure scale, or buy
resources. Notify/rescan waiting intents when reservations or capacity change; show a reason and
retry time. Define fair admission and startup limits within this fixed environment, not a generic
placement platform. Runtime session concurrency is a separate per-runner `maxConcurrent` limit.

Before enabling, supply at least one installed runtime, usable model/account/API credentials,
approved network endpoint, and quota. Use Orbit's existing provider/credential mechanisms, including
credential-isolated runtime state where selected. A mounted volume without model supply is not
`READY`; report `MODEL_UNAVAILABLE` and let the user/operator resolve it. Never print provider keys,
copy the server's master key into Pods, or assume a preinstalled CLI is signed in.

The initial container profile supports **approved invited testers only**, subject to a recorded
isolation decision. Use dedicated approved worker nodes, non-root fixed UID/GID, restricted Pod
security, seccomp, no privilege escalation or host PID/network/path/device access, and no service
account token automount. NetworkPolicy denies tenant-to-tenant and cluster-management traffic and
allows only the required Orbit, DNS, repository, and provider endpoints. Admission enforces the
volume/owner binding; a user's shell cannot mount another user's PVC or reach infrastructure Secrets.
CSI/OSD privileges belong to trusted infrastructure components, not tenant Pods.

Separate PVCs, namespaces/RBAC, and container controls reduce accidental and credential-based
cross-tenant access; a shared host kernel is not a hardened boundary for hostile public arbitrary
code. Public untrusted tenancy is blocked until the owner specifies and tests a stronger supported
sandbox/VM runtime and its Ceph attach path. Confirm whether separate tenant namespaces, encryption
at rest, egress mediation, and backup key isolation are required; do not claim the invited-test
profile satisfies unspecified public isolation requirements.

## Retention explicit deletion and backup

Sleeping, stopping, moving nodes, replacing images, login retry, disabling the feature, and deleting
a session/workspace do not delete the PVC, PV, RBD image, or stable runner identity. Retain data
indefinitely in this first version until explicit deletion; retained storage still consumes quota.
No age-based managed disk garbage collection is introduced. Existing session trash retention and
runner-local worktree/upload GC remain their own policies and must not be reinterpreted as whole
environment deletion. Their normal limits still apply to the corresponding session scratch.

An authenticated owner requests explicit managed environment deletion through a dedicated API with
the current mapping revision and an explicit data-disposition confirmation. Return a durable
`DELETING` operation and stop new demand. The manager drains/fences and stops compute before removing
bootstrap Secrets. Default runner unregister/remove routes must refuse hard deletion of a managed
runner even when the feature is disabled, and direct the caller to this workflow; otherwise the
schema cascade can destroy workspace relationships. Preserve runner/workspace/session history and
the storage tombstone. Account removal
must settle storage deletion or a recorded retention/export decision before losing owner metadata.

`Retain` means deleting a PVC leaves a released PV and backing image; it is not proof of erased data.
The first version separates compute deletion from privileged storage purge. Only an explicitly
authorized storage operator purges the recorded RBD image, its snapshots/clones, released PV/PVC,
and affected backup copies under the agreed retention policy, with identity checks and an audit
receipt. Retained backups/exports must be named in the response; do not claim permanent erasure
while they remain. Ambiguous purge results stay `DELETING` for reconciliation, never provision an
empty replacement on retry. A completed deletion tombstone prevents automatic login recreation.

Ceph replication protects against supported storage component failures. A snapshot in the same
cluster shares that cluster's failure domain. Neither is an independent backup. Define an encrypted,
access-controlled backup outside that Ceph failure domain plus the existing PostgreSQL backup;
destination, frequency, retention, RPO, RTO, credentials and restore authority are pending.
The first-version baseline backup drains/stops the writer, snapshots/exports consistently, and
records file checksums, complete SQLite database/WAL sets, engine/runtime version, and the logical
mapping manifest. A backup Pod must not mount the original PVC alongside the runner.

Restore to a **new** isolated PVC from the independent backup, preserve the absolute filesystem
layout, inspect SQLite `PRAGMA integrity_check`, and validate Git/attachments/engine session resume.
The restored runtime stays unable to execute as the live runner until the original is stopped/fenced
and the manager explicitly switches the mapping to the verified new PVC UID/volume handle.
Do not duplicate live runner credentials to run a restore test beside the original. Record the
mapping change and observed recovery point/time; these are measurements, not promised values here.

## Server and three client interfaces

Proposed authenticated capability route: `GET /api/auth/capabilities` returns
`{ "managedRunners": { "enabled": false, "contractVersion": 1 } }` when off. It requires no cluster
read. When on, it reports `enabled: true`; operational availability comes from the owner's status
response. Absence of this member, a pre-feature endpoint 404, or an unsupported contract version
means no managed UI. A transient fetch failure is an ordinary recoverable error, not an infinite
onboarding wait or permission to provision.

`GET /api/managed-runner` reads the authenticated owner's stored/derived status without allocating.
`POST /api/managed-runner/ensure`, `/retry`, `/wake`, `/sleep`, and `/delete` request the transitions
defined above. Require an idempotency key on writes and the current mapping revision for destructive
or conflicting transitions. Requests never accept another owner's runner/PVC/node identifiers.
Return `202` plus the same status/operation identity for asynchronous work; retries reuse it. Use
`409` for deletion/state conflicts, `404` for unknown/foreign mappings, and safe structured reasons
for configuration, quota, ownership, storage and fencing errors. Capacity waiting is an accepted
state, not an authentication failure. A retry during `FENCING` cannot bypass stop proof.

Shared status fields, defined in `@orbit/shared` and mirrored in OrbitKit, are:

```text
contractVersion, revision, managementState, desiredState,
runnerId?, workspaceId?, heartbeatStatus?, lastHeartbeatAt?, usable,
reason? { code, message, retryable }, retryAfter?, initialProvider?,
actions { canEnsure, canWake, canSleep, canRetry, canDelete }
```

IDs use the existing wire codec; timestamps are ISO 8601. Nullable IDs describe stages before the
mapping exists. Do not expose Ceph endpoints/keys, kubeconfig, node control credentials, Secret
contents, or raw infrastructure errors to clients. Add a server-derived managed marker/state to
runner/workspace list DTOs without changing the meaning of their existing heartbeat fields.
Owner-scoped realtime notifications announce revision changes; reconnect refetches status. Bounded
polling is a fallback, and starting/failed states always have a reason/deadline, not endless loading.

| Client display | Server condition | Interaction |
| --- | --- | --- |
| Preparing | `REQUESTED`, `PROVISIONING`, `STARTING` | Explain the current wait; keep login/navigation usable. |
| Waiting | `WAITING_CAPACITY` or `FENCING` | Show capacity wait or operator action; do not offer unsafe retry. |
| Available | `READY` and `usable` | Open the stable default workspace and allow session submission. |
| Sleeping | `SLEEPING` | New message requests wake, keeps its existing turn ID, and shows preparation. |
| Stopping | `DRAINING` | Keep demand/navigation; session submission records demand for the next safe start. |
| Failed | `FAILED` or unavailable configuration/model supply | Show server reason and only allowed retry/settings action. |
| Removing or removed | `DELETING`, `DELETED` | Show data disposition; no implicit recreation. |

Web integrates through [App default landing](../src/web/src/App.tsx) and
[WorkspaceConsole](../src/web/src/components/WorkspaceConsole.tsx). macOS integrates through
[AppModel](../src/macos/OrbitApp/Sources/OrbitApp/AppModel.swift); iOS uses the common
[OrbitKit models](../src/macos/OrbitKit/Sources/OrbitKit/Models/Runners.swift) and API client.
All three preserve explicit deep links, last workspace selection, existing project/session routes,
and self-managed runner registration. Only a bare/default landing with no chosen usable workspace
enters managed preparation when capability is enabled. An existing sleeping managed workspace can
be selected and queue work; it must not be mistaken for a deleted workspace or a new registration.
Older clients keep additive DTO compatibility; access gates remain enforced on the server.

## Optional test deployment boundary

Subsequent implementation places optional templates under `deploy/managed-runner/` and test
operations under a separate managed-runner test entry point. These paths are proposed, not installed
by this design. They must not be imported by root Compose, `/upgrade`, default start/release scripts,
or normal installation. Application templates refer to an already approved StorageClass/CSI and
never install a backend as a side effect. Infrastructure variants have separate entry points.

Before any mutating test command, the operator supplies an authorized environment manifest naming
the exact kubeconfig context/API server identity, namespace allowlist, node allowlist, test Ceph
FSID/pool, credential references, resource profile and permitted destructive tests. Require an
explicit context/namespace on every command; never fall back to the current context, default
namespace, in-cluster production credentials, or a production provider endpoint. Kubernetes
cluster-scoped StorageClass/webhook/CSI/Rook setup requires its own enumerated permissions.

Use a separate test apiserver/database/auth/provider environment and runner server URL; test login
must not enqueue production sessions. Fencing trials involve only enumerated disposable worker
nodes and test images/disks. Namespace separation alone is insufficient for kernel/CSI/node power
tests. A missing authorized environment stops cluster work; local fakes and documentation review can
continue. Production pools, disks, network routes, clients, containers and secrets are unchanged.

## Prerequisites still to be supplied

All entries are **pending** unless their owner supplies an evidence record. This list is the enabling
gate for follow-on infrastructure tasks, not a request to buy or install resources now.

| Required input | Who must supply or confirm it | Decision or evidence required |
| --- | --- | --- |
| Test and production topology/location | Deployment owner | Exact test cluster/context/API identity and geographic/network location; current production external Ceph/Rook relationship recorded read-only; isolation boundary. |
| Access and operational authority | Kubernetes and storage operators | Namespace/resource allowlists, least-privilege manager RBAC, operator scope for CSI/SC/admission, Ceph Secret provisioning, and authorization for node fencing. Manager has no node-power, cluster-install, or Ceph-admin authority. |
| Version tuple | Cluster/storage operators | API/kubelet/runtime, CSI/operator/sidecars, Ceph/Rook patches and digests, OS/kernel/mounter/ext4, image features and CephX key compatibility; maintained vendor/community support. |
| Failure domains and storage media | Storage owner | MON quorum placement; OSD disk inventory, media/DB/WAL layout, CRUSH domains/replica/min_size, capacity/headroom/health limits, and power/network failure assumptions. Compute node count is not this inventory. |
| Network | Network/storage operators | MON and all OSD client endpoints, routes/ports/MTU and measured latency/bandwidth, separate replication paths if used, provider/Orbit egress, and CSI host-network policy implications. |
| Per-user resources and concurrency | Deployment owner | CPU/memory/ephemeral disk requests and limits, PVC size, retained-user/active-user/attach caps, quotas, expected session concurrency and scheduler headroom. No speculative hardware numbers. |
| Lifecycle budgets | Deployment owner with runtime implementer | Idle interval, startup/retry budgets, drain/preStop/unmount limits, and the behavior when budgets expire while an old writer remains uncertain. |
| Model supply | Model/runtime owner | Installed runtime and image digest, at least one accessible model and valid test credential/account, quota, explicit first-session selection, provider network access. |
| Tenant boundary | Product/security owner | Invited vs public population, acceptable kernel sharing, namespace/sandbox requirements, egress and secret/data isolation; public hostile-code isolation remains blocked. |
| Fencing and node rejoin | Infrastructure/storage operators | Working BMC/hypervisor access or tested persistent storage/network fencing, forced-detach configuration, receipt format, failure handling and quarantined rejoin procedure. |
| Data protection and deletion | Data/storage owner | Independent backup destination/keys, frequency, RPO/RTO/retention, user/account deletion policy, purge authority and audit of snapshots/clones/backup copies. |

## Verification and implementation handoff

This design review establishes an implementation contract. It does **not** establish that a real
cluster mounted data, denied a second Pod, fenced a node, or executed a model session. Those are
follow-on evidence requirements. Local unit/integration tests use injected configuration, fake
Kubernetes/storage clients and temporary databases/directories; they never discover live credentials.
New runner tests explicitly clear session/service-token environment and use isolated scratch homes
and provider tripwires per the repository test conventions when testing provider behavior.

| Test group | Cases and required evidence |
| --- | --- |
| Default disabled | Run separately with the variable absent and explicitly `false`, no kubeconfig/Ceph credentials. Bootstrap/login/refresh, ensure/retry/wake/sleep/delete, queued messages/tasks/scheduled/watch work, controller restart and old stored intents must cause zero managed writes/resource operations. Instrument the client constructor and all resource methods to fail if reached; assert no watches/timers and normal server/login/self-managed behavior. Also test invalid values and capability absence on three clients. |
| Disable existing state | Seed mapping/Pod/PVC references, start the server disabled, run normal workers and restart. Assert no stop/delete/cleanup/revocation; a read of capabilities does not allocate. An existing runner's heartbeat/execution compatibility remains intact. |
| Enabled with isolated fakes | Explicit `true`; fake environment and budget. Cover concurrent login/ensure, timeout after each successful creation, partial failures, restart/adoption, retry exhaustion, owner mismatch, UID conflicts, two-manager admission races, and preservation of the same mapping/PVC. Missing enabled prerequisites cannot break ordinary login or accidentally select live infrastructure. |
| Admission and storage on authorized nodes A and B | Record the actual stack/profile. While the original Pod writes files and SQLite WAL, attempt differently named, unlabelled and concurrently created Pods using the same PVC on A and B. Record admission refusals and prove rejected Pods never mounted or wrote. Exercise guard/database outage and stale generation requests. A native RWO scheduling rejection alone is not sufficient. |
| Normal migration | Drain/stop/unpublish/unmap on A, then authorize B against the same PVC UID/PV/volume handle/RBD image. Compare deterministic file checksums, SQLite integrity and committed rows, runner/workspace ID, Git primary/worktree state, attachments, and a real engine session continuation. Record non-overlap of writers. |
| Fault and fencing | Partition only A's control-plane path while leaving Ceph reachable: no replacement is authorized. Then perform the approved power/validated storage fence, capture its receipt and attach on B. Attempt late old-generation API use and old-node writes/reconnect; both must be denied. Capture termination/fence/detach/attach times, client/mount state, OSD epoch and data integrity. |
| Wake and sleep | Independently test messages, executable tasks, scheduled/background/watch work and auto retry on a sleeping mapping; capacity wait, model absence and startup retry; active/job/flush work forbids sleep; demand racing drain survives; wake uses the original disk and identity. No provider retry attempt is spent merely waiting for managed capacity. |
| Data lifecycle and independent restore | Rebuild image, sleep, login/retry, workspace/session deletion and disable retain the volume. Test confirmed deletion/purge against disposable data only. Restore independent backup to a new PVC without simultaneously activating copied runner credentials; verify SQLite/Git/attachments/engine state and measure recovery point/time. |
| Clients and compatibility | Use the same state fixtures for Web/macOS/iOS: preparing, waiting, ready, sleeping, failed/retry and removed. Verify endpoint/capability absence and false, old clients/runners, selected workspace, deep links and self-managed registration. No indefinite loading or registration prompt for a sleeping managed workspace. |
| Deployment boundary | Check root Compose/start/install/release/upgrade remain disabled and do not install infrastructure. Optional test commands refuse omitted/wrong context or namespace and do not target production DB/server/provider/FSID/pool. |

Real storage evidence includes sanitized Pod/PVC/PV/VolumeAttachment UIDs, node UID/kernel, mounter,
StorageClass parameters, CSI images/sidecars, Ceph version/pool/image/client/health, admission results,
fencing receipts, filesystem mounts, checksums, SQLite results, and measured transition times. Record
credentials by reference only. Ceph pool health and a green compile do not prove single writer safety.

The project implementation order remains: storage integration and recovery evidence; managed image
and fixed paths; manager/gate/unique mapping; login/default workspace; resource admission and wake/sleep;
shared client status; two-user end-to-end, independent backup restore and operator runbook. Implementers
must update this record with actual versions, authorized test scope and observed differences. Final
acceptance and integration follow the project's independent evidence review and project branch;
production enablement is a separately authorized undertaking.

## Implementation record: manager core

Recorded 2026-10-07 for the code-track manager task. It was verified only with injected fake
Kubernetes clients and disposable PostgreSQL databases; no cluster, kubeconfig or Ceph credential was
used, and nothing here is evidence about a real cluster.

| Area | As implemented |
| --- | --- |
| Switch | `ORBIT_MANAGED_RUNNERS_ENABLED`, read once through `ConfigService` by the global gate module and shared by every consumer. Values follow the table above; an unreadable value disables the feature and logs one warning. |
| Disabled | The process builds only the gate, the read-only status facade and the guard that refuses writes. The runtime factory returns null without reading a profile or kubeconfig. No Kubernetes client, watch or timer exists. |
| Enabled prerequisites | `ORBIT_MANAGED_RUNNERS_PROFILE` names an absolute JSON profile file; the shape is in [manager-profile.example.json](../deploy/managed-runner/manager-profile.example.json). It names the JSON kubeconfig file, context, expected API server and namespace, the storage class and capacity, a digest-pinned image, the runner's Orbit URL, resource amounts and every lifecycle budget. No budget has a default. The real client reads only that kubeconfig and only the named context. It refuses `current-context` fallback, in-cluster credentials, exec and auth-provider plugins, basic auth and disabled TLS verification. A missing or invalid profile reports `MANAGED_RUNNER_UNAVAILABLE` (writes answer 503); login and the rest of the server are unaffected. |
| Routes | `GET /api/auth/capabilities`; `GET /api/managed-runner`; `POST /api/managed-runner/ensure` and `/retry` (202 with the status). `/wake`, `/sleep` and `/delete` exist and are guarded. While enabled they answer 409 `MANAGED_RUNNER_TRANSITION_REFUSED` without writing, because this version does not perform them. Off, every write is 401 without a login and then 404 `MANAGED_RUNNER_DISABLED`. Every write requires `idempotencyKey`; retry also requires the read `revision`. Tokens may read status (`runners:read`) but never write (`RUNNER_CONTROL`). |
| Data | Migration 0399 adds `managed_runner` and its two enums. Additions to the proposed field list: `resourceOperationKind`, `startupDeadlineAt`, the manager lease (`leaseHolder`, `leaseExpiresAt`), `lastRequestKey` and `stateEnteredAt`. A CHECK holds `pvcName` and `podName` to the runner UUID. Unique keys cover the owner, runner, default workspace, PVC location, PVC UID and volume handle. All three foreign keys are `ON DELETE RESTRICT`, and the runner and workspace keys are composite with the owner. |
| Manager | Moves REQUESTED → PROVISIONING (PVC, PV identity, bootstrap Secret, credential hash) → STARTING (the one Pod of the generation, until a fresh runner heartbeat after STARTING began) → READY, or FAILED with a structured cause. Each step is a compare-and-set on `revision` under a lease. A failed create is always read back by its deterministic name and compared before anything is retried. Transient failures back off with jitter up to `maxAttempts`. Identity mismatches fail immediately and are not retryable. The capacity admission hook admits everything; WAITING_CAPACITY is reserved for it. |
| Compute release | Only an explicit retry of a mapping whose recorded Pod has terminated deletes that Pod, with a UID precondition. Nothing deletes a PVC, Secret, runner row or workspace. A vanished or replaced predecessor Pod leaves the mapping FAILED with `PREDECESSOR_STOP_UNPROVEN`, and the generation does not advance. |
| Bootstrap credential | Observed difference from the Pod example: the runner row already exists, so the manager issues that row's credential into Secret `mr-boot-<runner-uuid>`. The Secret is mounted at `/run/orbit-bootstrap` and named by `ORBIT_RUNNER_CREDENTIAL_FILE`; the control plane stores only its hash. No enrollment token is minted and `ORBIT_RUNNER_ENROLLMENT_TOKEN_FILE` is not set. The current image entrypoint does not consume this credential yet; it stops before registering. |
| Existing paths | `DELETE /api/runners/:id` and runner deregistration refuse a managed runner with 409 `MANAGED_RUNNER_DELETE_REFUSED`, even when the feature is off. Enrollment-token registration and device approval no longer reuse a managed runner by name. |

Left to later work: generation-bound runner authentication, per-generation credentials and image
consumption of them, the admission guard, fencing receipts and replacement (single-writer work);
the login hook, `initialProvider` and `MODEL_UNAVAILABLE` (login work); capacity admission, wake,
sleep and drain (wake/sleep work); the explicit deletion workflow; client rendering and realtime
revision notices. Every real-cluster item in the verification table above remains unexecuted.

The local evidence lives in `src/apiserver/src/managed-runners/*.spec.ts`, run by the unit suite, and
in the three `*.pg.spec.ts` files there, each run with `scripts/run-pg-spec.sh <spec>`.

## Implementation record: sign-in provisioning

Recorded 2026-10-07 for the code-track sign-in task. It was verified with the in-memory Kubernetes
namespace of `test-support/fake-kube-client.ts`, disposable PostgreSQL databases and a test playing
the runner (heartbeat and claim with the credential the manager put in the bootstrap Secret). No
cluster, kubeconfig, Ceph or model credential was used, and nothing here is evidence about a real
cluster, a real runner heartbeat or a real model session.

| Area | As implemented |
| --- | --- |
| Hook | `AuthService.completeLogin`, the exit of password login, first-user bootstrap and the Google ticket exchange, calls `ManagedRunnerService.signedIn` after the tokens are issued. It is injected as `MANAGED_RUNNER_SIGN_IN`, the one export of `ManagedRunnerModule`, which is global for it. Nothing else calls it: refresh, logout, a password change, an administrator opening an account and the capability and status reads record nothing. A unit spec holds the call site to that one method. |
| Off | `signedIn` returns before reading anything. Login and bootstrap make exactly the database calls they made before. |
| On | An eligible owner without a mapping gets one (mapping, runner row and default workspace in the manager-core transaction), and the reconcile worker is kicked. The sign-in waits for no instance and makes no Kubernetes call. An existing mapping is left as it is in every state: a sign-in does not retry FAILED, recreate a removed workspace or a tombstone, or wake anything. Every failure is logged and swallowed, so the issued session stands; an explicit `ensure`, or the next sign-in, records the intent. |
| Eligibility | `ManagedRunnerEligibility` (`managed-runner-eligibility.ts`) is the one decision of who is given a managed runner. Sign-in, explicit `ensure` (403 `MANAGED_RUNNER_NOT_ELIGIBLE`) and the status read (`canEnsure` false, with that reason) ask it. With the switch on it answers yes for every account; narrowing it to invited testers changes that implementation and nothing else. No configuration was added. |
| Default workspace | Created once with the mapping, bound by `runnerId` and `targetRunnerId`, with `position` NULL, so it sorts after every workspace the owner already has. Existing order, the first workspace a client lands on, selections and deep links are unchanged. Nothing is matched by name. An owner who removes it does not get it, or another, back at the next sign-in. |
| Model supply | READY also needs the fresh heartbeat after STARTING to report a runtime installed and signed in: `auth: yes`, no installation error, and advertised where the claim requires it. Claude Code, Codex, Kimi Code and Antigravity count, preferred in that order, and the first is stored as `initialProvider`. Without one the mapping stays STARTING with reason `MODEL_UNAVAILABLE`; a runtime signed in meanwhile makes the next pass READY. At the startup deadline it turns FAILED with that reason, retryable, and a retry waits on the same Pod. OpenCode and DeepSeek Harness are not counted as supply in this version. |
| First session | The derived provider seed (`lastProviderByWorkspace`) answers a managed default workspace with no interactive history with its `initialProvider`. Its `lastProvider` in workspace payloads, and a session created there without a provider, start on that runtime; every other workspace keeps the Claude floor. `SessionsService.create` refuses a first session there with 409 `MODEL_UNAVAILABLE`, before anything is created, on a runtime the managed runner did not report installed and signed in, whether the provider was named or derived. A session bringing its own credential needs only the CLI installed. After the first interactive session the workspace's history decides, as for every workspace. The deprecated workspace `provider` alias is neither read nor written. |

Left for the authorized test environment: a real sign-in provisioning a real PVC and Pod; the managed
image consuming the bootstrap credential and heartbeating with real engine health (its entrypoint
still stops before registering, as the manager record says); a real first session executed by a real
runtime with a real model credential; how a real runner's engine probe reports supply (an `unknown`
answer from a slow probe delays READY); and sign-in under load alongside manager passes. Client
rendering of these states, capacity admission and wake/sleep belong to the client and wake/sleep work.

The local evidence is `managed-runner-sign-in.spec.ts` and `managed-runner-supply.spec.ts` in the
unit suite, and `managed-runner-sign-in.pg.spec.ts`, run with `scripts/run-pg-spec.sh <spec>`.

## Implementation record: single-writer protection

Recorded 2026-10-09 for the code-track single-writer task. It was verified with the in-memory
Kubernetes namespace of `test-support/fake-kube-client.ts` (which now passes Pod creates and updates
through the admission decision below and models VolumeAttachments), disposable PostgreSQL
databases, the Go runner against local HTTP servers and the image entrypoint on a scratch
filesystem. No cluster, kubeconfig, Ceph, node power or model credential was used. Nothing here is
evidence that a real API server refused a Pod, that a real node was fenced or that a real old writer
could not reach the disk. It supersedes the manager core record's "Compute release" and "Bootstrap
credential" rows and the sign-in record's note that the entrypoint stops before registering.

| Area | As implemented |
| --- | --- |
| Instance binding | A managed runner sends `X-Orbit-Managed-Runner-Generation` and `X-Orbit-Managed-Runner-Pod-Uid` on every credentialed request and declares `managed-runner-instance-v1`. `RunnerAuthGuard` and the runner-credential branch of `RunnerSessionAuthGuard` read the runner's mapping (one unique-key read, no write) and accept a managed credential only from the recorded generation and Pod UID: 403 `MANAGED_RUNNER_INSTANCE_REQUIRED` without the protocol, `..._SUPERSEDED` for an earlier generation, `..._NOT_AUTHORIZED` for another Pod or an unissued generation, `..._FENCED` while FENCING/DELETING/DELETED; 503 `..._PENDING` (retryable) before the manager records the Pod. That covers heartbeat, claim, inbox, events, session leases and every other runner-door route. The claim re-reads the mapping under `FOR SHARE` inside the claim transaction and also refuses DRAINING; later rounds of the inbox long poll re-check it. A runner with no mapping is not asked, so self-managed runners keep their protocol. Enforced whatever the switch says, like the deletion refusal: it reads one row and calls no cluster. The account check comes first: both guards read the runner with its owner's account state and refuse a disabled account 403 `ACCOUNT_DISABLED` (X1, docs/google-sign-in-design.md §5.5) before any instance is considered, so a disabled owner's managed runner is refused even from its authorized instance and served again once the account is enabled. |
| Credentials | Issued per generation. The bootstrap Secret carries `token` and `generation`; when a generation is retired or fenced, the runner row's credential is replaced in the same transaction by one nobody holds, so the predecessor's requests fail with 401; the retired Secret is deleted by UID and the next one issued. The owner's `rotate-token` refuses a managed runner (409 `MANAGED_RUNNER_ROTATE_REFUSED`) whether or not the feature is on. |
| Image and runner | With `ORBIT_RUNNER_CREDENTIAL_FILE` the entrypoint never enrolls: it requires the expected runner ID and the Downward API generation and Pod UID, checks the Secret's generation against the Pod's, refuses another runner's config or volume, a volume a later generation (or another Pod of this generation) ran on, and an uncertain enrollment, then writes the credential into `config.json` and passes the identity to `orbit run`. `runner-pod.yaml.example` is now exactly the Pod the manager builds, and a spec compares them. The Go runner reads the identity once, refuses to start on a partial or malformed one, sends it on every credentialed request (JSON calls and attachment transfers), forwards it to `orbit mcp` where an engine allowlists the environment (Codex, OpenCode, DeepSeek Harness, Wiki maintenance), and stops claiming and drains on a revocation, exiting 3. |
| Replacement gate | Generation N+1 is reserved — and its Secret, credential and Pod follow — only from proof that generation N stopped: the kubelet's report (terminal phase, every container terminated or never started, no PodGC/taint-manager DisruptionTarget), recorded when observed, then the Pod object gone and no VolumeAttachment for the PV; or a fencing receipt bound to that instance and volume, with the object gone and the volume detached. A Pod that vanished or was replaced unobserved, or was made terminal by the control plane, sends the mapping to FENCING (predecessor credential replaced, disk/Secret/Pod object untouched). A stale heartbeat, an OFFLINE runner, an expired manager lease, more passes or an owner's retry never authorize anything; FENCING is not retryable by the owner. Both proofs live in `fencingReceipt` (`OBSERVED_STOP` or `FENCING_RECEIPT`), marked `retiredAt` when used; a used one opens nothing for the next generation. No migration was needed. |
| Fencing receipt | Version 1, as `deploy/managed-runner/fencing-receipt.example.json`, in ConfigMap `mr-fence-<runner-uuid>`, key `receipt.json` — a kind the manager reads and cannot write. `NODE_POWER_OFF` or `STORAGE_FENCE`; bound field by field to the recorded runner, generation, Pod name/UID, node, PVC UID, volume handle and the PV's RBD pool/image; an action and an independent observation; power-off needs a quarantined node, a storage fence a persistent, non-expiring blocklist with addresses, nonces, OSD map epoch and propagation time. Problems are reported as `FENCING_RECEIPT_INVALID` and change nothing. |
| Admission | A validating webhook (`deploy/managed-runner/admission/pod-admission-webhook.template.json`, `failurePolicy: Fail`, every Pod create/update and `pods/ephemeralcontainers` in the managed namespace, no label selector), answered by `POST /api/managed-runner/admission` from the database: the mapping owning the claim, the manager's Kubernetes username (profile `admission.managerUsername`), the fixed name, the identity annotations, the reserved generation (STARTING, no Pod, CREATE_POD pending), the pinned image and template. Chosen over a ValidatingAdmissionPolicy because the reservation is a PostgreSQL row under the mapping's compare-and-set; CEL would need a cluster copy that could lag or move backwards. The route needs the API server's bearer token (profile `admission.webhookTokenSha256`), answers 404 off and 503 unavailable, and fails closed. The manager creates no Pod until a dry-run create the guard must refuse is refused by it (`ADMISSION_GUARD_MISSING` otherwise). |
| Not protection on their own | ReadWriteOnce (two Pods on one node may share it), RBD `exclusive-lock` (it moves between clients), the manager lease, the runner's heartbeat and the local `container.lock`. |

Left for the authorized multi-node Ceph environment (T02/T04): a real API server running the webhook
and refusing differently named, unlabelled, concurrently created, same-node and cross-node Pods that
use the original PVC, including with the webhook or its database down, and recording that the
refused Pods never mounted; the manager's dry-run probe against that API server; the real
kubelet/PodGC/VolumeAttachment sequence of a normal cross-node migration, and its timing; an
operator-performed power-off or storage fence, its receipt, the out-of-service procedure and the
takeover on node B with data and SQLite checks; a late old-generation runner and the old node's
mount both unable to write after takeover; the Downward API values the image actually receives; and
the forced-detach behaviour of the cluster's controller manager.

The local evidence is `managed-runner-instance.spec.ts`, `managed-runner-admission.spec.ts`,
`managed-runner-fencing.spec.ts` and `managed-runner-resources.spec.ts` in the unit suite;
`managed-runner-fencing.pg.spec.ts` with the manager, boot, existing and sign-in pg specs, each run
with `scripts/run-pg-spec.sh <spec>`; `src/runner-go/managed_instance_test.go`; and
`scripts/managed-runner/entrypoint_test.py` with `deployment_boundary_test.py`.

## Implementation record: capacity, wake and sleep

Recorded 2026-10-09 for the code-track capacity, wake and sleep task. It was verified with the
in-memory Kubernetes namespace of `test-support/fake-kube-client.ts` (admission guard installed),
disposable PostgreSQL databases, the whole application in-process with the switch on, the production
server with the switch absent and `false`, and the Go runner's unit tests. No cluster, kubeconfig,
Ceph or model credential was used. Nothing here is evidence of a real scale to zero, a real wake time
or real capacity exhaustion. It supersedes the manager core record's "admits everything" admission
hook and its 409 answer to `/wake` and `/sleep`.

| Area | As implemented |
| --- | --- |
| Budget | Profile `capacity`: `compute` (`cpu`, `memory`, `ephemeralStorage`, `pods`, `attachments`), `storage` (`usable`, `headroom`) and `maxActiveUsers`; lifecycle `idleSeconds`, `capacityRetrySeconds` and `drainSeconds`. None has a default, and a budget smaller than one runner is refused. One runner's compute share is the larger of its two containers' requests, `runner.tmpSizeLimit` as ephemeral storage, one Pod, one attachment and one active user; its storage share is `storage.capacity`. |
| Reservation | Migration 0413 adds `managed_runner_capacity`: one row per cluster key and namespace, with totals and reserved figures (CHECKs keep them at zero or above). A mapping records its share in `reservation`: storage from its first admission for as long as the volume exists, compute from admission until its instance is proven stopped. Admission, at REQUESTED and WAITING_CAPACITY, is one transaction: the mapping's compare-and-set, then one conditional UPDATE of the pool that adds the share only while every dimension still fits. Refused, it rolls back whole and the mapping waits as WAITING_CAPACITY with `MANAGED_RUNNER_CAPACITY_UNAVAILABLE`, the short dimensions, a retry time (`retryAfter`) and the pool revision it was refused at. Every reservation, release and change of totals moves that revision, and waiting intents refused at an older one are due at once, oldest first. Compute is released in the transaction that puts a runner to sleep, after the stop proof, and by a FAILED that has no Pod recorded or being created; never by FENCING. Nothing is deleted, evicted or resized, and neither `maxConcurrent` nor observed usage is read. |
| Demand | The hook `MANAGED_RUNNER_DEMAND` (`managed-runner-demand.ts`) is one UPDATE by runner id: demand revision + 1, demand time, RUNNING desired; it kicks the reconcile loop. `SessionsService.create` and `importSession` call it for a session queued (task runs, delegations, coordinators), `createTurn` for a session left PENDING (messages, scheduled wakeups, watch deliveries, task resumes, open-item deliveries), `resume` before its offline gate — a managed runner that comes back by itself is queued for instead of refused — and after a revive, and `AutoRetryService` for every due retry. Off, it returns before reading anything. Each manager pass also sweeps: a sleeping mapping whose runner has queued turns, pending merges or commits, due wakeups or retries, landings, repository operations, rate-limit resets or relays is woken (`managed-runner-work.ts`). |
| Auto retry | A due retry on a managed runner that is not READY (asleep, draining, waking or waiting for capacity) asks it to wake and is re-armed for the next sweep: no attempt spent and no 30-minute give-up. On a READY runner it proceeds as before. |
| Sleep | A READY runner drains when, for `idleSeconds` since it became READY and since the last demand, the records show no work and its authorized instance's fresh report says none. The records: turns running or queued; background jobs, engine turns and subagents of open sessions; merges and commits; due wakeups and retries; landings queued for or running on it; repository operations; rate-limit resets; sign-in, install, clean-up, removal, history, catalog and release relays. The report: heartbeat `managedWorkload`, stored on `runner.managed_workload` with the generation and Pod that sent it — turns, background jobs, operations and unflushed events, and how long all were zero. A missing, stale or other instance's report prevents sleep, and a runner that does not declare `managed-runner-sleep-v1` never sleeps. An owner's `/sleep` (READY, the read revision; 409 `MANAGED_RUNNER_BUSY` with work) skips only the idle interval. DRAINING refuses claims, withholds heartbeat work (landings, repository operations, merges, commits, resets) and answers heartbeats with `managedSleep`. The instance accepts with `sleepReady` while still idle; the route records the acceptance only while the drain stands, the request matches, no demand came since the drain began and the records show nothing, and answers `confirmed`. Only then does the runner stop claiming, drain and exit 0. Until acceptance the manager calls the drain off — READY — on demand, recorded work, a busy or missing report, or an unaccepted request past `drainSeconds`; that write and the acceptance exclude each other. After acceptance nothing is forced (`SLEEP_STOP_OVERDUE` after `drainSeconds` is only said): the kubelet's report of the stop is recorded as the stop proof, the Pod object is deleted by UID, and once the volume detaches one transaction retires the generation (credential replaced), clears the Pod and releases compute: SLEEPING. A Pod gone, replaced or made terminal without the kubelet's report fences, as anywhere else. |
| Wake | SLEEPING with RUNNING desired — demand that came during an accepted drain included — goes to REQUESTED, is admitted for compute, adopts its recorded PVC and replaces the retired Secret in PROVISIONING, and starts the next generation's Pod on the same PVC: the same runner row, workspace, PVC and volume handle. The owner's `/wake` is demand. |
| Switch off | The hooks return before reading; the heartbeat stores no report and asks nothing; the claim does not hold back an instance whose mapping was left DRAINING (management is frozen); no manager exists. |
| Runner | A managed instance (`managed_sleep.go`) reports turns in flight (engine-driven ones included), background jobs (hosted watches and services included), heartbeat-delivered operations counted beside the WaitGroup that joins them — landings, repository operations, merges, commits, uploads, history scans, reset steps — with sign-in and install relays, and events buffered or being posted per supervisor. It declares `managed-runner-sleep-v1`, accepts a sleep request only while all of these are zero, and stops only on confirmation: drain, exit 0. A revocation still exits 3. |

Left for the authorized test environment (T06): a real scale to zero — the runner's exit and the
kubelet's terminal report on a real node, Pod deletion, VolumeAttachment removal and the CSI detach of
the RBD image, with their timing; the real wake latency (scheduling, image pull, attach, runtime start)
against `startupDeadlineSeconds`; real capacity exhaustion against the scheduler, ResourceQuota and
LimitRange, and the pool's headroom against the test pool's actual safe usable capacity; the concrete
budget values the test owner supplies; drain timing with real long landings; and managers on several
replicas sharing one pool.

The local evidence is `managed-runner-capacity.pg.spec.ts`, `managed-runner-sleep.pg.spec.ts`,
`managed-runner-wake.pg.spec.ts` and `managed-runner-existing.pg.spec.ts`, each run with
`scripts/run-pg-spec.sh <spec>`; the profile and status specs in the unit suite; and
`src/runner-go/managed_sleep_test.go`.

## Implementation record: disabled accounts

Recorded 2026-10-09 for the code-track disabled-accounts task. It was verified with the in-memory
Kubernetes namespace of `test-support/fake-kube-client.ts` (admission guard installed), disposable
PostgreSQL databases, the whole application in-process with the switch on, and the production server
with the switch absent and `false`. No cluster, kubeconfig, Ceph or model credential was used. Nothing
here is evidence that a real runner exits when its account is disabled, or of a real Pod deletion or
detach. It narrows the sign-in record's eligibility row: a disabled account is not eligible.

An administrator disables an account by setting `User.disabledAt` (migration 0396,
docs/google-sign-in-design.md §5.5); its runner credential is then refused 403 `ACCOUNT_DISABLED` at
every runner door before any instance is considered (single-writer record above). This record makes
the managed runner follow the account. The disable itself and that refusal are unchanged.

| Area | As implemented |
| --- | --- |
| Manager | Each step reads the owner's `disabledAt` (one key read). A disabled owner's mapping is driven to sleep and never towards READY: no PVC, Secret or Pod is created, and no admission dry run or capacity admission is made. A mapping with an instance — a recorded Pod, or one found under its fixed name — goes DRAINING at once, without the idle interval or an instance report, and that drain is never called off. It ends as an idle sleep ends: the kubelet's report of the stop is recorded as the stop proof, the Pod object is deleted by UID, and once it is gone and the volume detached one transaction retires the generation (credential replaced) and releases compute: SLEEPING, desired SLEEPING. A mapping with no instance (REQUESTED, WAITING_CAPACITY, PROVISIONING, or STARTING before its Pod) goes straight to SLEEPING and gives back the compute it held, in the transaction a FAILED with no Pod uses. A Pod create whose answer was lost keeps the share and the mapping where it is and is not tried again; a Pod it committed late is recorded and drained. A sleeping mapping stays asleep, and a wake desired before the disable is dropped. A disabled owner's FENCING mapping is looked at for its proof whatever it desires, and once proven is put to sleep. FAILED, DELETING and DELETED are left as they are. `dueMappings` lists a disabled owner's mappings first, whatever their retry time. A disable that lands while a step is creating an object is seen by the next step, which drains or releases what was made. The PVC with its storage share, the runner row and the default workspace stay. |
| Runner's exit | Nothing stops the instance. The runner treats the claim's 403 as a permanent failure: it stops claiming, drains its sessions (whose event posts are refused too) and exits 0, so its Pod ends `Succeeded` with the kubelet's report. An instance that stopped before the manager looked sleeps the same way; an enabled owner's unrequested stop is still FAILED `POD_TERMINATED`. A Pod gone or made terminal without the kubelet's report fences, as anywhere. No runner code changed; a runner test pins the two answers this relies on. |
| Demand | `recordManagedDemand` matches no row for a disabled owner, so the hook every session path calls (messages, task runs, scheduled wakeups, watch deliveries, revives, auto retry) records nothing and answers `managed: false`. The caller goes on as for a runner that is not coming back: a revive of an offline runner is refused as offline, and an auto retry takes the ordinary offline path with its 30-minute give-up. The sweep passes over disabled owners. |
| Owner writes | Ensure, retry, wake, sleep and delete answer 403 `ACCOUNT_DISABLED` after the switch check, before the mapping is read or anything written. The owner's row is read afresh: JwtAuthGuard's view of disabled accounts can be 30 seconds old on another replica. |
| Eligibility | The service asks its rule (`EVERY_ACCOUNT`, unless another is provided under the token) through `enabledAccountsOnly`: a disabled account is not eligible, at sign-in or on ensure, whatever the rule says. |
| Status | With the switch on, a disabled owner's status reason is `ACCOUNT_DISABLED` (shared code; `ManagedRunnerReason.code` stays an open string), ahead of any stored cause; `usable` is false and no action is offered. The reason is derived, never stored, so an enabled account reads its mapping's own status again. |
| Enabled again | An ordinary sleeping mapping: demand — the sweep finding work that waited, a message, the owner's wake — admits it and starts its reserved generation on the same PVC, runner row and workspace. A sign-in does not wake it. |
| Switch off | None of this runs: the hooks return before reading, no manager exists, the status read reads nothing more, and no Kubernetes client is constructed. The runner door's `ACCOUNT_DISABLED` refusal belongs to the account work and holds whatever the switch says. |

Left for the authorized test environment (T06): that a real managed runner of a disabled account exits
on its own — the refused claim, the drain with its sessions' event posts refused, exit 0 — including a
runner whose session slots are all busy, and how long that takes; the kubelet's terminal report, the
Pod deletion by UID, the VolumeAttachment removal and the CSI detach of that stop, with their timing;
the delay from an administrator's disable to the drain (the disable does not kick the manager, so the
worker's poll interval bounds it); a re-enabled account's wake on a real cluster with the original
PVC; and a disabled account's Pod that never started (Pending: unschedulable or image pull), which
nothing stops — it stays DRAINING with its compute reserved until an operator acts, as a Pod that hit
`STARTUP_TIMEOUT` stays FAILED.

The local evidence is `managed-runner-account-disabled.pg.spec.ts`, case (8) of
`managed-runner-wake.pg.spec.ts` and the disabled accounts seeded in
`managed-runner-existing.pg.spec.ts`, each run with `scripts/run-pg-spec.sh <spec>`;
`managed-runner-status.spec.ts` and `managed-runner-eligibility.spec.ts` in the unit suite; and
`TestManagedInstanceStopsOnItsDisabledAccount` in `src/runner-go/managed_instance_test.go`.

## Implementation record: client status

Recorded 2026-10-09 for the code-track client task. It was verified with the shared state fixture
below, jsdom renders of the web app with a stubbed API, OrbitKit's tests on Linux (`swift:6.1`) and
source checks of the SwiftUI shell, which does not build on Linux. No server ran with the switch on
for a client, and no cluster, simulator or device was used. Nothing here is evidence that a real
managed runner was shown, woken or retried in a real client.

| Area | As implemented |
| --- | --- |
| One reading | `managedRunnersOffered` and `managedRunnerDisplay` (`src/shared/src/managedRunnerDisplay.ts`), mirrored by OrbitKit's `ManagedRunnerLogic`. Only the capability and the status fields are read. Kinds: setup and not offered (no mapping), preparing, waking, model unavailable, waiting for capacity, available, unresponsive (READY, not usable), stopping (DRAINING), sleeping, waiting for an operator (FENCING), failed, removing and removed, each with fixed words; the detail is the server's reason sentence whenever there is one, for any code. Waking is SLEEPING with RUNNING desired, or REQUESTED/PROVISIONING/STARTING once `initialProvider` is recorded. Retry is offered for FAILED with `canRetry`, Set up for `canEnsure`. Work is accepted in the demand hook's coming-back states — asleep or draining only when the server offers a wake (`canWake`), which it does not for a disabled account — and not while the server reports `MANAGED_RUNNER_UNAVAILABLE`; a first session in the default workspace only once `initialProvider` is known. Moving states are read again every 5 s, the rest every 30 s. An unknown management state or contract version shows no managed UI. |
| Fixture | `src/shared/src/managed-runner-states.fixture.json`: six capability answers (404, missing member, off, unknown contract, malformed, on), 26 server states with the display each gets (a disabled account's `ACCOUNT_DISABLED` among them, shown by its sentence like any reason), and two answers of a newer server. An apiserver spec derives every status from stored inputs with `managedRunnerStatus` and the public id mapping, and checks the two switch answers against the capability route; @orbit/shared, the web and OrbitKit are all held to the same file. |
| Web | `WorkspaceConsole` hands the managed runner's state to `WorkspaceView` only for the managed runner's console; it stands above the composer unless READY. While it accepts work, a message to a live session is sent, an ended session is resumed rather than refused as offline (the server queues the resume), and the status is read again at once, so it shows waking. The default workspace's draft offers no engine and sends nothing until `initialProvider` is known. The default landing of an account with no runner and no workspace shows the managed runner (Set up, or why there is none) with the registration guide one link away; first-run setup lands there instead of the guide while the capability is on. |
| macOS and iOS | `ManagedRunnerModel`, owned by `AppModel` and read by its polling task, reads the capability (every 5 minutes) and, only when offered, the status. Each console gets it from `ConsoleRegistry`: the same banner above the composer, the same sending rules (`ManagedRunnerLogic.sendCapabilities`, the draft block) and an immediate read after work is sent. The draft shows the state where the engine would be when it cannot start. Infrastructure shows the managed runner above the machines only for an account with no runner, which is where an account without workspaces lands. |
| Off | Missing or unknown capability, `enabled: false`, or a status with `enabled: false`: no status read (web) or no status shown (native), and every landing, workspace choice, deep link, offline refusal and registration path is what it was. Covered for every capability answer in the fixture. |

Left for the authorized test environment (T07): a real server with the switch on answering these
clients — sign-in of a new account landing in its preparing workspace, a real wake by a message and the
time it takes, a real failure and Retry, model-unavailable while a runtime is signed in from
Infrastructure, capacity waiting against real admission; the SwiftUI shell built and run on macOS and
iOS (only its source wiring is checked here); realtime revision notices, which no server sends yet, so
clients poll; and the session capabilities, which still report an ended session on a sleeping managed
runner as `RUNNER_OFFLINE` — the clients lift that from the managed status, as the server's resume does.

The local evidence is `managedRunnerDisplay.spec.ts`, `managed-runner-states-fixture.spec.ts`, the web's
`ManagedRunnerNotice.test.tsx`, `App.managedRunner.test.tsx`, `WorkspaceView.managedRunner.test.tsx`
and `SetupPage.test.tsx`, and OrbitKit's `ManagedRunnerFixtureTests`, `ManagedRunnerLogicTests`,
`ManagedRunnerAPIClientTests` and `ManagedRunnerWiringTests`.
