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
| [Run loop](../src/runner-go/runloop.go) and [session shutdown](../src/runner-go/session.go) | Heartbeats run every 30 seconds and continue during drain, including while work the heartbeat started (a landing's checks, repository operations) finishes; one last beat is sent at exit. The current supervisor shutdown envelope is 170 seconds, including the 100-second turn drain and release/flush backstops. Heartbeat work gets the same 100 seconds; a landing still checking then is stopped with its process tree, its scratch worktree removed and its claim handed back for immediate re-dispatch ([stop sequence](../src/runner-go/shutdown_drain.go), contract §2.2 J-T11), inside the same envelope. Kubernetes termination must leave time beyond that envelope. |
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

Revised by the account owner on 2026-10-17 for new deployments ("Implementation record: new
deployments"): the code's default stays off, and so does every deployment whose `.env` does not say
`true`, but a fresh install writes the switch on with the Docker backend and its Compose profile.
`/upgrade` never writes it. The default entry points may reference the Docker backend, and still
reference or install nothing of Kubernetes, Rook, Ceph or CSI.

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
   An instance that stops unasked, with its host's report of the stop, is replaced the same way —
   through the single-writer gate, within the same attempt count and backoff — so a host restart
   needs no retry; a crash loop still ends FAILED ("Implementation record: failure recovery and
   visibility").
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

For an unreachable node, block replacement and leave the takeover to the operator. A lost heartbeat
proves nothing about the node's writers, so the mapping stays `READY` with its generation and Pod
recorded. The owner's status says the runner is not usable once its heartbeat is older than
`heartbeatFreshSeconds`; demand waits, the owner's retry is refused, and no Pod is created. The
manager goes `FENCING` only when the recorded Pod disappears, is replaced, or turns terminal without
its kubelet's report. In practice that happens when the operator's `node.kubernetes.io/out-of-service` taint
lets PodGC make the Pod `Failed` (step 4). From then on the predecessor's credential is refused, and
the next generation starts on the operator's fencing receipt.

This behavior was kept by the coordinator's decision of 2026-10-19, after T02 found it, instead of
fencing as soon as the control plane marks the Pod for eviction:

- A takeover needs the operator's receipt either way, so fencing earlier would not be safer.
- It would cut a draining runner's credential whenever a healthy node is given a `NoExecute` taint.
- It would make every loss of contact longer than the taint toleration an event for an operator.

The first supported fault path is operator-confirmed fencing in the authorized test environment:

1. Identify the predecessor by Pod UID, node UID, generation, PVC UID, volume handle, and RBD image.
   Preserve the mapping and pending demand. The predecessor's managed API generation is rejected
   from the moment the mapping is `FENCING`. No timeout or user retry may authorize disk access by a
   successor.
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

For the Docker backend of a new deployment, the account owner decided on 2026-10-17 that every
account is eligible by default, those created by open sign-up included, except a disabled one. The
owner is aware that the containers share the host's kernel, which is no strong isolation from a
malicious public user, and the deployer bears that risk; the deployment documentation
([self-hosting](self-hosting.md#isolation-and-its-limits)) says so. The rule is `EVERY_ACCOUNT` in
`managed-runner-eligibility.ts`, asked only about accounts that are not disabled.

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
On Kubernetes that switch is an administrator's request the manager verifies and records
("Implementation record: a restored volume back under its runner").

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
reason? { code, message, retryable }, retryAfter?, initialProvider?, firstSessionProvider?,
actions { canEnsure, canWake, canSleep, canRetry, canDelete }
```

`firstSessionProvider` (since 2026-10-18, task T07) is what a first session in the default workspace, sent with
nothing named, starts on now: `initialProvider` once the runner has been READY, before that the owner's own model key
such a session is queued on while the runner has not reported its engines or reported that key's engine installed, and
null when the session would be refused `MODEL_UNAVAILABLE`. A client offers that session exactly when it is set; a
server that predates the field is read by `initialProvider`.

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
never install a backend as a side effect. Infrastructure variants have separate entry points. (Since
2026-10-17 the Docker backend's channel and image are the exception, in a Compose profile a fresh
install switches on: "Implementation record: new deployments".)

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
| Model supply | READY also needs the fresh heartbeat after STARTING to report a runtime installed and signed in: `auth: yes`, no installation error, and advertised where the claim requires it. Claude Code, Codex, Kimi Code and Antigravity count, preferred in that order, and the first is stored as `initialProvider`. With none signed in, one of the owner's own enabled model keys counts (since 2026-10-18, task T05: an account whose only model is an API key, such as a DeepSeek key, never became READY before). The key counts when the runner reported the engine that key runs on installed, without an installation error and advertised where the claim requires it. That engine needs no sign-in, because a session on a key brings its own credential. The first such key in the owner's order (`position`, unset last, then age) is stored as `initialProvider`, by its slug. Another account's key, a shared key (an administrator's), a disabled key and a key whose slug is a built-in runtime's name do not count. Without either the mapping stays STARTING with reason `MODEL_UNAVAILABLE`; a runtime signed in or a key added meanwhile makes the next pass READY. At the startup deadline it turns FAILED with that reason, retryable, and a retry waits on the same Pod. OpenCode and DeepSeek Harness are not counted as supply in this version. |
| First session | The derived provider seed (`lastProviderByWorkspace`) answers a managed default workspace with no interactive history with its `initialProvider`: a runtime's name as that built-in provider, or a key's slug as that configured provider on the engine its row names. Its `lastProvider` in workspace payloads, and a session created there without a provider, start on it; every other workspace keeps the Claude floor. `SessionsService.create` refuses a first session there with 409 `MODEL_UNAVAILABLE`, before anything is created, on a runtime the managed runner did not report installed and signed in, whether the provider was named or derived. A session bringing its own credential needs only the CLI installed. After the first interactive session the workspace's history decides, as for every workspace. The deprecated workspace `provider` alias is neither read nor written. |

Left for the authorized test environment: a real sign-in provisioning a real PVC and Pod; the managed
image consuming the bootstrap credential and heartbeating with real engine health (its entrypoint
still stops before registering, as the manager record says); a real first session executed by a real
runtime with a real model credential; how a real runner's engine probe reports supply (an `unknown`
answer from a slow probe delays READY); and sign-in under load alongside manager passes. Client
rendering of these states, capacity admission and wake/sleep belong to the client and wake/sleep work.

The local evidence is `managed-runner-sign-in.spec.ts` and `managed-runner-supply.spec.ts` in the
unit suite, and `managed-runner-sign-in.pg.spec.ts`, run with `scripts/run-pg-spec.sh <spec>`.

In the single-machine lab (T05, 2026-10-17), real sign-ins provisioned real RBD-backed PVCs and Pods.
The managed image registered with its bootstrap credential, and its engine probe reported Claude Code and Codex installed and signed out.
A key-only account then became READY only with the model-key rule above.
A first session with nothing named ran on the managed runner, through to an answer.
These also held there:
- concurrent sign-ins on two replicas;
- repeated sign-ins;
- an existing account's landing and deep links;
- a refused intent and a missing admission guard, each followed by its retry;
- the switch unset and `false`, for new and existing accounts.

The model there was a stand-in endpoint behind a DeepSeek-preset key, so a session on a real model is still open
([lab record](managed-runner-lab.md#sign-in-provisioning-t05)).

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

Verified in the single-machine lab by T06 on 2026-10-18 ([evidence](evidence/managed-runner-wake-lab/2026-10-18/README.md),
[the lab page](managed-runner-lab.md#wake-sleep-and-capacity-t06)), with two replicas sharing a pool budgeted for one runner and
fake-model.py as the model: 22 real scales to zero (the runner's exit 0 and the kubelet's report, the Pod removed, the detach; 35–41 s from
the drain request to SLEEPING) and the starts after them on the same PVC and runner row; wakes by a message, a task's Run Now, a held
wakeup and a task's run time; no sleep through a long turn or a runner-hosted background job; eight demands making one start; a drain
called off by a message; a crash while starting restarted by itself and a quota refusal retried by the owner; capacity waits for a new
account and for a wake; disabled accounts; and the switch unset and `false` with all of this pending. Real capacity exhaustion at the
scheduler or a LimitRange and a long landing during a drain were not reached.

One finding was fixed there. A woken instance claims at once, while its first heartbeat waits for its 30-second ticker, so the runner
row's `lastHeartbeatAt` was still from before the sleep and the reaper finalized the instance's first run as `runner offline` within a
second of its claim. The reaper now takes the run's claim (`run_claimed_at`) inside its 90-second window as presence, in its sweep and in
the finalizing write's WHERE (`reaper.service.ts`, `reaper-claim-presence.spec.ts`).

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
| Runner's exit | Nothing stops the instance. The runner treats the claim's 403 as a permanent failure: it stops claiming, drains its sessions (whose event posts are refused too) and exits 0, so its Pod ends `Succeeded` with the kubelet's report. An instance that stopped before the manager looked sleeps the same way; an enabled owner's unrequested stop is still FAILED `POD_TERMINATED` (since D7 it is started again: "Implementation record: failure recovery and visibility"). A Pod gone or made terminal without the kubelet's report fences, as anywhere. No runner code changed; a runner test pins the two answers this relies on. |
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

Verified in the lab by T06 on 2026-10-18 ([evidence](evidence/managed-runner-wake-lab/2026-10-18/README.md), section 8): a mapping waiting
for capacity went to sleep 1.7 s after its owner was disabled, nothing having been made; a running instance (twice, once still STARTING)
went DRAINING 1.8 and 3.2 s after the disable, exited on its own with its claims refused, and slept 37–39 s after it with its PVC kept;
a held wakeup and a task's run time that came due while disabled were recorded and woke nothing, with no connection to the cluster; and
enabled again, the waiting work had the runner's next Pod 4.4 s later, on the same PVC, PV and runner row, and was answered 28 s after. Not reached
there: a runner whose session slots were all busy, and a disabled account's Pod that never started.

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

## Implementation record: run backends

Recorded 2026-10-17 for the second phase's backend task (D1: a Docker backend beside Kubernetes). It
was verified with the in-memory Kubernetes namespace of `test-support/fake-kube-client.ts`, an
in-memory one-host backend (`test-support/memory-run-backend.ts`), disposable PostgreSQL databases
and every existing managed runner spec, none of whose assertions changed. No cluster, Docker daemon
or credential was used. Kubernetes behaviour is unchanged: the same calls in the same order, the same
identity checks, stored proofs, reason codes and messages.

| Area | As implemented |
| --- | --- |
| Interface | `ManagedRunnerBackend` (`managed-runner-backend.ts`): its name; the words operator details use for its objects; its location — where a new mapping's volume lives (cluster key, namespace) and the key of its capacity pool — and the fixed names of a runner's objects; the pool's budget and one runner's compute and storage shares; the data volume (read, create once, identity check, the storage it is bound to and that storage's identity, and what still holds it — nothing holding it means released); the bootstrap credential of a generation (read, issue, identity check, removal of a retired one by UID); the instance (read — UID, machine, running, terminated, stop confirmed by its host, being removed — proof of the single-instance guard before a create, create once, identity check, removal by UID); the stop proof (the recorded observation of an instance's own stop, and an operator's fencing receipt); and what a failure means (transient, or a definite refusal with its reason code). A backend observes and acts; the manager decides and writes every row. |
| Kubernetes | `KubernetesBackend` (`kubernetes-backend.ts`) over the unchanged client of `kube-client.ts`: the PVC and its PV, VolumeAttachments, the Secret, the bare Pod, the kubelet's terminal container states, the ConfigMap receipt and the admission dry-run probe. 401 and 403 are `KUBERNETES_FORBIDDEN`, other refusals `KUBERNETES_REJECTED`; ambiguous answers, 429 and 5xx are retried. The object builders and checks (`managed-runner-resources.ts`), the receipt reader (`managed-runner-fencing.ts`) and the admission webhook stay where they were. |
| Manager | `managed-runner-manager.ts` keeps the states, capacity admission, the single-writer gate, wake and sleep, a disabled owner's runner, every database write and every reason sentence, and calls no Kubernetes API. Its one Kubernetes import is for its constructor: a bare Kubernetes client — how every caller and spec built a manager before — runs on KubernetesBackend. The service takes a new mapping's location and volume name from the backend; the capacity pool is keyed by the backend's location and holds the backend's budget. The stored vocabulary stays for every backend: the mapping's columns (`pvcName`, `pvcUid`, `pvUid`, `volumeHandle`, `podName`, `podUid`, `nodeName`), the resource operation kinds (`CREATE_PVC`, `CREATE_SECRET`, `CREATE_POD`, `DELETE_POD`, `DELETE_SECRET`) and the reason codes, which a backend reads as the data volume, the storage behind it, the credential and the instance. |
| Not in the interface | No call stops a running instance and none removes a data volume. An instance stops by itself — it accepted a sleep request, or its owner's account was disabled and the runner door refuses it — and nothing is forced; a volume stays until an explicit deletion workflow exists. A backend that needs a forced stop has to add it together with what the gate then accepts as proof. |
| Profile | Optional `backend`. Absent, it is `kubernetes`, as every existing profile is read; `kubernetes` is accepted; `docker` is refused with the one problem `backend is "docker", which this server does not implement yet; it does not run managed runners on Kubernetes instead`, which leaves the enabled feature unavailable (`MANAGED_RUNNER_UNAVAILABLE`) with no Kubernetes client built; any other value is refused. The shipped example is unchanged. |
| Data | No migration. Every mapping so far is a Kubernetes one, and with Docker refused no other kind can be made. A mapping's location (cluster key and namespace) already tells pools apart. A backend recorded on the mapping is left to the Docker work if it needs one; a new `managed_runner` column also changes the full-row literal in `managed-runner-status.spec.ts`. |
| Switch off | Unchanged: the runtime factory returns null before reading a profile, so no backend exists. |

Left for the Docker backend (D2): its implementation of the interface over the restricted Docker
channel; the Docker profile's shape and validation; its pool key and a budget derived from the host;
an instance UID in canonical UUID form, which the runner door requires; the stop report from Docker's
own container state; release once no container uses the volume; a guard to prove before a create;
and the admission webhook route's answer when the backend is not Kubernetes. Real-environment work
on Kubernetes (T04) changes `kubernetes-backend.ts` and its helpers for what a real cluster does, and
the manager only for the states.

The local evidence is `managed-runner-backend.spec.ts` in the unit suite and
`managed-runner-backend.pg.spec.ts`, run with `scripts/run-pg-spec.sh <spec>`, beside every existing
managed runner unit and pg spec.

## Implementation record: single-machine lab

Recorded 2026-10-17 for the lab task. The owner authorized one KVM virtual machine on the shared
HPC host as the authorized isolated test environment: one physical machine, one node, one failure
domain. [The lab page](managed-runner-lab.md) records its versions, names, memory measurements,
operation and smoke results; the scripts are in `scripts/managed-runner/lab/`.

| Area | As built |
| --- | --- |
| Stack | Ubuntu 26.04.1 LTS with kernel 7.0.0-34-generic (kernel RBD), k3s v1.36.5+k3s1, Ceph 20.2.4 under cephadm, Ceph-CSI v3.18.0 deployed by Ceph-CSI Operator v1.1.0, every download and image pinned by checksum or digest. |
| Topology | Ceph runs beside k3s in the same VM, outside Kubernetes, so k3s consumes it as an external backend. Three OSDs on three virtual disks; pool `orbit-mr-rbd` size 3, `min_size` 2, CRUSH failure domain `osd`. |
| Profile | StorageClass `runner-data` rendered from `deploy/managed-runner/storage/storageclass.template.json` by `ceph_rbd.render`, with the storage profile fields required above; `clusterID` is the FSID, which also names the operator's ClientProfile. The CSI identity has exactly the documented pool-scoped caps; its key is `aes256k`, the only cipher a fresh 20.2.4 cluster allows, which the 7.0 kernel maps without a downgraded key. |
| Observed | Pod recreation and a VM stop/start kept file, Git and SQLite data (`integrity_check` ok, row hashes equal). A second, differently named Pod on the same node ran on the RWO claim and wrote to it, so RWO is not single-Pod protection here either; a ReadWriteOncePod claim's second Pod stayed Pending. |
| Not covered | The multi-node parts of criteria 2 and 8; no fencing procedure, Rook or CSI snapshots are installed, and the admission guard only for a test window ([T02a](managed-runner-lab.md#single-writer-protection-t02a)). `ceph-rbd-verify.py`'s live phases need two nodes and were not run. |

## Implementation record: Docker backend

Recorded 2026-10-17 for the second phase's Docker backend task (D2). It was verified with the
channel's own tests (an in-memory Docker Engine behind its real HTTP server), DockerBackend over an
in-memory channel that keeps the real one's rules, the manager on DockerBackend over disposable
PostgreSQL databases, and on the HPC host's real Docker (29.8.2): the whole apiserver in one process
with the switch on and a Docker profile, the real channel, the managed runner image built locally
from T03's branch (08375121e) with the entrypoint change below, its real runner in every container,
and a disposable PostgreSQL
(`scripts/managed-runner/docker-backend-it.py`). No model credential was used: Codex was signed in
with a placeholder key on an internal network with no route to any model, so nothing here is evidence
of a real engine session (D4) or of a new deployment's wiring (D3).

| Area | As implemented |
| --- | --- |
| Channel | `deploy/managed-runner/docker-channel/channel.py`, Python 3 standard library, a process of its own and the only one holding `docker.sock`. JSON over HTTP on a unix socket (or loopback), bearer token from a file only its owner reads. It creates, reads and removes data volumes; keeps the runner credential of a generation; creates one container from its own template and starts it, reads its state and exit, stops it and removes it once stopped; reports what holds a volume, the host's size and this instance's resources. Everything it creates carries `orbit.managed-runner.instance=<instanceId>`; nothing without that label is read, returned, adopted or removed. A request names identities and amounts only: `privileged`, capabilities, binds and mounts, host network/PID/IPC/UTS, devices, security options, a user, an environment or labels are refused by name, a volume that is not `mr-data-<runner uuid>` (a host path, the Docker socket) is refused, another image is refused, amounts above its ceilings are refused. The spec is checked against its rules before it is sent and the created container is inspected and checked again before it starts. Its README gives the API, the rules and the reasons. |
| Template | Image by local ID (built here, never pushed), user 10001:10001, every capability dropped, `no-new-privileges`, read-only root, private IPC and cgroup namespaces, `NanoCpus`, memory with no swap beyond it, PID limit, `/tmp` a sized tmpfs (counted in memory), restart policy `no`, bounded json-file logs, the one configured network, and three mounts: the data volume at `/var/lib/orbit` (Docker copies the image's 10001-owned `/var/lib/orbit` into an empty volume, so no root init step is needed), the bootstrap volume at `/run/orbit-bootstrap`, `/tmp`. |
| Credential and identity | The runner credential of the container's generation is written, before it starts, into its bootstrap volume as root-owned mode-0444 files beside `generation` and `instance.json` (runner, generation, instance UID). The container's environment names the files (`ORBIT_RUNNER_CREDENTIAL_FILE`, `ORBIT_MANAGED_RUNNER_INSTANCE_FILE`), never the credential or the generation. The image's entrypoint reads both from the files and, as on Kubernetes, hands the generation and UID to `orbit run`, which no longer prints them in its log. That entrypoint change is commit 198f6d6cc (branch `d2/entrypoint-instance-file`), handed to the image task (T03): this task changes nothing under `deploy/managed-runner/image`. The instance UID is a canonical UUID the channel gives each container: the runner door authorizes it as it authorizes a Pod UID. |
| Network | One dedicated bridge network the deployment creates, inter-container traffic off; the runner reaches the apiserver at an address of the host's container network. For a Docker container (identity from its instance file) the Docker profile, and the entrypoint in 198f6d6cc, accept plain HTTP to a private, loopback or link-local address or a single-label host; anything else must be HTTPS, and a Pod's rule is unchanged. |
| Backend | `DockerBackend` implements the run backend interface over the channel: fixed names from the runner UUID, create once with read-back after a lost answer, identity checks (owner, runner, generation, volume UID), the volume as its own storage (handle `docker:<instance>/<volume>/<uid>`), holders of every label, the guard probe (a dry run under another name must come back `SINGLE_CONTAINER_GUARD`), removal by instance UID, Docker's exit report as the stop proof. A channel that cannot be reached, or answers 5xx/429, is transient; its refusals are `DOCKER_CHANNEL_FORBIDDEN`, `DOCKER_CHANNEL_MISMATCH`, `DOCKER_CHANNEL_REFUSED`, `VOLUME_OVER_LIMIT`, `CONTAINER_GUARD_MISSING` or `CONTAINER_GUARD_UNVERIFIED`, each with a sentence in the manager's table. |
| Stop proof and stopping | Docker's state — `exited` with exit code and `FinishedAt`, `dead`, or never started — is the host's report, recorded as `OBSERVED_STOP` with the exit code and time; the container is then removed by UID, and only once it is gone and nothing refers to the volume does the generation advance or compute go back. The interface gains `stopInstance`, for a backend whose host reports every stop it makes: the manager asks it only when an accepted sleep overruns `drainSeconds` (`SLEEP_STOP_FORCED`) or a disabled owner's runner has not stopped by then; asking is never the proof. Kubernetes has no `stopInstance` and is unchanged. A container gone without Docker's report fences, and only an operator's `HOST_PROCESS_CHECK` receipt (in the channel's state directory) moves it on. |
| Disk | Measured, not quota'd: a local volume has no size limit without host filesystem quotas, which this backend may not require. The volume carries its limit (`storage.capacity`, also its storage share); every `diskCheckSeconds` the channel reads Docker's own volume sizes and stops the container of a volume over its limit, keeping the reason; no container is created for a volume over its limit (`VOLUME_OVER_LIMIT`) until an operator frees space or raises it. Data is never deleted to enforce it; overshoot is bounded by the check interval. |
| Capacity | `capacityBudget` may now be asynchronous. The Docker profile states each runner's limits (its compute share) and may state any dimension of the pool; the rest is derived from the host the channel reports: CPU and memory less a reserve (a quarter each by default), `/tmp` within the memory budget, as many runners as CPU and memory both fit, and storage from the free space of the disk Docker's volumes live on plus what this instance's volumes already hold, keeping a tenth of that disk free. The pool, admission, waiting and release are the existing ones. |
| Mapping | Migration 0430 adds `managed_runner.backend` (`kubernetes` by default for every existing row, or `docker`, held by a CHECK). The service records the runtime's backend on a new mapping; a manager lists, leases and drives only its own backend's mappings and leaves another's as they are. On Docker the mapping's namespace is the channel's instance. |
| Admission webhook | On a Docker server `POST /api/managed-runner/admission` answers 404 `MANAGED_RUNNER_ADMISSION_NOT_APPLICABLE` before any token is read: there is no Kubernetes profile and no Pod to admit. |
| Recovery | A pass in READY, DRAINING or FENCING that the backend does not answer spends no attempt of the provisioning budget and fails nothing: it is logged, and the next pass looks again (a channel restart, or a Kubernetes API blip, used to count towards `maxAttempts` and could turn an up runner FAILED). This is the shared state machine's, so it holds for Kubernetes too. The channel finishes, at start-up, any container create a previous run left unstarted. An abnormal exit fails the runner retryable with Docker's report as the proof; the owner's retry replaces it on the same volume (since D7 the manager replaces it itself, within `maxAttempts`). |

Measured on the real Docker run of 2026-10-17, 14 of 14
(`docs/evidence/managed-runner-docker/2026-10-17-1017083206f4/`, with Docker's own events of every
container and volume):

- The channel refused 24 requests outside its rules (no or a wrong token, each forbidden parameter by
  name, a host path or the Docker socket as the volume, another image, another runner's volume, a
  second container for a volume, amounts above its ceilings, resources without its label), and Docker
  was left unchanged. The apiserver process never connected to a Docker socket.
- The container Docker made matched the template field by field, and neither the credential nor the
  generation was in its environment or its log.
- A message, a task's Run Now and a due session wakeup each woke the sleeping runner: a new generation
  on the same volume, which claimed the work. After the idle sleep and the wakes, the file checksums,
  `PRAGMA integrity_check` and the rows matched what was written before.
- Compute stayed reserved while the exited container still existed: the drained container exited at
  08:37:03.33, Docker removed it at 08:37:03.68, and the mapping slept at 08:37:03.69, releasing its
  compute in the same commit.
- Eight concurrent wakes, raced by a second manager, made one container. Sampled every 250 ms, no
  volume ever had two.
- Each of these recovered to one container on the same volume, with the database intact and its
  committed rows kept: a container killed with SIGKILL (exit 137); the manager, the channel and the
  container killed together while a SQLite writer ran; the manager stopped mid-wake; the channel down
  mid-wake.
- With room for two runners, a third waited with nothing made for it, and its container was created
  once one of the two slept.
- A volume written past its 256 MiB limit (346105301 bytes) was stopped within one disk check, and no
  container was started on it again.
- On this host (24 CPUs, 15 GiB, Docker's disk 914.8 GiB with 12.4 GiB free) the default budget for
  1-CPU, 2-GiB runners is 18000m of CPU, 11.25 GiB and five runners. Storage stays closed (12.4 GiB
  usable against 91.5 GiB headroom) until the profile states it.

Left to later work, or not shown here:

- A real engine session, and its continuation across a sleep and a wake, in a Docker container (D4).
  The owner's DeepSeek key file was not there, and the test network reaches no model; the turns the
  woken runners claimed could not be answered. A deployment's network must also let the runner reach
  its model's endpoint; this run's network reached only the apiserver.
- The deployment's wiring (D3): the channel as a service, its network and token, the Docker profile.
  No default deployment entry changed here.
- Backup, restore and the failure handbook for local volumes (D5).
- The entrypoint change lands with T03. An image without it stops at start in a Docker container: it
  asks for a generation and Pod UID from the Downward API.
- No real host reboot or Docker daemon restart on this shared host. After one, Docker marks each
  container whose process is gone as exited with code 255 and `FinishedAt` at its restart (moby
  docker-v29.8.2, `daemon/daemon.go` line 517 and `daemon/container/state.go` lines 284–285). That is
  the same kind of report as the SIGKILL above, and it is handled the same way.
- The disk limit is a measurement, so a volume can overshoot it by what is written in one check
  interval (`diskCheckSeconds`, at least 10 s).
- The Recovery row's change is in the shared state machine, so it holds for Kubernetes too. Only the
  Docker pg spec tests it (its case 10); no Kubernetes spec or lab (L0) run does yet.

## Implementation record: new deployments

Recorded 2026-10-17 for the second phase's task D3. The account owner decided that a new deployment runs managed
runners with the Docker backend, while an existing deployment, orbitd.io included, keeps them as its `.env` has
them: the code's default stays off. The operator's side is [self-hosting](self-hosting.md#managed-runners).

The two paths, as the repository had them:

| Path | Before D3 | Now |
| --- | --- | --- |
| Fresh install | No server install script (`src/web/public/install.sh` installs a runner). README's Quick Start, [self-hosting](self-hosting.md) and the [first-run checklist](first-run.md) had the operator clone, `cp .env.example .env`, write `JWT_SECRET` and `PROVIDER_SECRET_KEY` with `openssl rand` and `sed`, and `docker compose up -d --build` root Compose; the first visitor creates the administrator at `/setup` (`POST /api/auth/bootstrap`, which signs in through `completeLogin` like a password sign-in). | `scripts/install-server.sh` does those steps for a checkout with neither `.env` nor `data/postgres`. It builds the managed runner image from `deploy/managed-runner/image` (or takes `--managed-runner-image`), creates the network `orbit-managed-runners` (bridge, inter-container traffic off, not internal), writes `data/managed-runners` (the channel's token, `channel.json`, and `profile.json` with `"backend": "docker"`), appends `ORBIT_MANAGED_RUNNERS_ENABLED=true`, `ORBIT_MANAGED_RUNNERS_DIR=./data/managed-runners` and `COMPOSE_PROFILES=managed-runners-docker` to `.env`, applies the migrations, then starts the stack. `--no-managed-runners` writes the switch `false` instead. The manual path stays documented and leaves the switch off. |
| Upgrade | `/upgrade`: `.claude/skills/upgrade/upgrade.sh` and `.agents/skills/upgrade/scripts/upgrade.sh` rebuild apiserver, wiki worker and web from the checkout and recreate them with the gateway; self-hosting's "Upgrading" checks out a release and runs `docker compose up -d --build`. Neither writes `.env`. | Still never writes `.env`, so the switch stays as it was: off wherever `.env` does not say `true`. Where `.env` turns on the `managed-runners-docker` profile, both copies also rebuild and recreate `docker-channel`. Switching managed runners on for a deployment installed without them is an administrator's explicit `scripts/install-server.sh --enable-managed-runners`, which edits only those lines of `.env`. |

| Area | As implemented |
| --- | --- |
| Root Compose | `docker-channel`, the restricted channel, built from `deploy/managed-runner/docker-channel/Dockerfile` (Python's standard library and `channel.py`), under the `managed-runners-docker` profile: no network, the only Docker socket mount, the managed runners' directory at `/var/lib/orbit-managed-runners`, and a health check on its socket. The apiserver reads `ORBIT_MANAGED_RUNNERS_ENABLED` (default `false`) and its profile at a fixed path in that directory, mounted read-only; where `.env` names no directory, `/dev/null` stands in and nothing is created on the host. Without the profile, Compose runs the same six services as before. |
| Network | A runner reaches the apiserver as a runner on another machine does, through the gateway's published port 2086, at the gateway address of `orbit-managed-runners` (Docker 29.8.2 lets a container on an ICC-off bridge reach the host's published port there, and nothing else on the host's container networks). |
| Eligibility | Every account, open sign-up included, except a disabled one: `EVERY_ACCOUNT`, asked only about accounts that are not disabled (C6b). Self-hosting states that a container shares the host's kernel, is not a strong boundary against a malicious user, and that the deployer bears that risk. |
| Boundary tests | `test/compose-topology.test.mjs` pins the channel's whole definition and the apiserver's four new lines, allows its one profile, and gives the Docker socket to no other service; its counterexamples cover each. `scripts/managed-runner/deployment_boundary_test.py` lets the default entry points name the Docker channel and the image, and still nothing else of `deploy/managed-runner` and nothing of Kubernetes, Rook, Ceph or CSI; neither `/upgrade` copy names the switch or writes `.env`. `scripts/managed-runner/new_deployment_test.py` runs the install script and both `/upgrade` copies against a fake `docker`. |

Verified on 2026-10-17 in two isolated Docker hosts on the HPC machine (`docker:29.8.2-dind`, capped, outside the
runner's cgroup; nothing of an existing deployment touched). The branch carries T03's image fix: its tip d856cde9b
(198f6d6cc, d856cde9b, Claude Code), merged as e7b149183 with none of T03's files changed, so the install builds a
working image from the branch's own `deploy/managed-runner/image`
([evidence](evidence/managed-runner-new-deployment/2026-10-17/README.md)):

- At e7b149183, a fresh install with no flags built the managed runner image itself (`sha256:b89d6f3f9c44…`, source
  e7b149183, with Codex and Claude Code) and came up healthy with the switch, the directory and the profile in
  `.env`. The first account's sign-in made its runner at once (STARTING 3 s later, the runner online 30 s later),
  READY after an operator's placeholder Codex sign-in. Switched off, a new account's sign-in made nothing
  (`MANAGED_RUNNER_DISABLED`, ensure 404), and the first account's volume stayed, its container still running.
- The previous version (c291f9af6), upgraded to e7b149183 with `/upgrade`, kept `.env` byte for byte and managed
  runners off: three accounts' sign-ins made nothing, only the apiserver, wiki worker and web were built and
  recreated, and no channel, network, image, container or volume of managed runners appeared.
- Earlier runs at 6f51ce21d, with T03's image named by `--managed-runner-image`, showed the same and also that
  `/upgrade` of a new deployment rebuilds `docker-channel` and keeps `.env`, and that `--enable-managed-runners`
  switches an upgraded deployment on, its administrator's next sign-in getting a READY runner. The first of them, at
  af6047e9c, failed: a new database's 428 migrations outlasted the apiserver's health check at its first boot on
  that disk, which is why the install now applies them first.

Left to later work, or not shown here:

- A real engine session on a managed runner (D4); the channel's refusals, the containers' limits, backups and
  failure handling (D5).
- An upgrade does not rebuild the managed runner image, whose runner does not update itself: a deployment's
  runners keep the image `channel.json` and `profile.json` name until an administrator builds another and names
  its ID in both. (Since D6 it does: "Implementation record: image upgrades".)
- The manual path's `docker compose up -d --build --wait` still applies a new database's migrations at the
  apiserver's first boot, and on a slow disk the pinned health check can give up first; the install script avoids
  it, the checklist does not. This predates D3.

## Implementation record: Docker backend security and operations

Recorded 2026-10-17 for the second phase's task D5: an independent check of the boundary every account's runner
sits behind, and the runbook for its data. Everything ran in two isolated places on the HPC machine, and nothing of
an existing deployment was touched ([evidence](evidence/managed-runner-docker-security/2026-10-17/README.md)):

- `d5-dind`, a capped `docker:29.8.2-dind` test host whose own dockerd and data root (under /mnt/data) belonged to
  this task alone. It ran a default deployment from `scripts/install-server.sh` with no flags; `/upgrade` later
  moved it to the channel fix below.
- The HPC host's own Docker, which a Docker-in-Docker host cannot stand in for: AppArmor and the host's network.
  A separately labelled channel instance ran there, as Compose runs it (no network, the Docker socket), with the
  same runner image and its own ICC-off network. It was removed afterwards.

| Area | What was checked | Result |
| --- | --- | --- |
| Channel refusals | 267 requests the channel must refuse, sent to the default deployment's own channel: Docker parameters by name and smuggled into nested objects (privileged, capabilities, binds and mounts, the Docker socket as mount, volume, URL or `DOCKER_HOST`, host network, PID, IPC, UTS, user and cgroup namespaces, devices and GPUs, security options, a user, an environment, labels, sysctls, restart policies, ports and more); other images (by tag, by ID, the configured image's own tag); amounts over the ceilings; another runner's volume, name or owner; resources without this instance's label (unlabelled, another instance's, the wrong kind), and the stack's own containers and volumes; route, query and body tricks; 41 requests without the token or with a wrong, partial, case-changed or second one. Docker's whole inventory and the channel's state directory were compared before and after each one, and a positive control showed that the comparison sees a change. | All refused, each with its code, and nothing changed. Two were accepted at c16d115b3 and are fixed: a runner id or owner id with a trailing newline (`$` matched before it). |
| The channel's surface | The deployment's `docker-channel` and its directory | No network at all (only `lo`, no TCP or UDP socket); one unix socket, root 0600, in a 0700 root directory; the token 0600. No other container has the Docker socket. The apiserver mounts the directory read-only. |
| The container | Inside a real runner container, as its user, on the host's Docker and in the default deployment | User 10001; every capability set empty; `NoNewPrivs` 1; seccomp in filter mode; AppArmor `docker-default (enforce)` on the host (unconfined only inside the dind test host, which cannot load profiles); read-only root. It can write only to its volume, `/tmp` and `/dev/shm`. The bootstrap files are root-owned 0444 in a root-owned 0755 directory, and the runner can neither change, rename nor delete them (T03's point), nor add a file there. Setuid binaries do nothing (`mount`: "must be superuser"). `unshare`, `mount`, `setuid`, `chroot`, `keyctl`, `bpf`, `perf_event_open` and `open_by_handle_at` get EPERM. No Docker socket or binary, no host path, no block device; the environment holds the runner's six keys and the image's own. |
| Limits | Measured inside the containers | CPU 1.01 of 1.0 and 1.99 of 2.0 CPUs; PIDs refused at `pids.max` (256, 4096); `/tmp` full at its size (64 MiB, 1 GiB), counted in memory; memory: the allocating process OOM-killed at the 512 MiB limit while the runner went on; disk: a 64 MiB volume with checks every 10 s stopped at 192,940,181 bytes, a new generation refused (`VOLUME_OVER_LIMIT`) until `volumeLimitOverrides` raised it. |
| Network | TCP from inside, on both | Unreachable: another runner, the stack's containers (their names do not resolve), other networks, Docker's API, the host's loopback, the metadata address. Reachable: the internet, the gateway's published port (the designed path), and every service the host listens to on another address: sshd and rpcbind on the HPC host, through the network's gateway, docker0 and the LAN address. |
| `serverUrl` | The default deployment's `profile.json` against its network | `http://172.19.0.1:2086`, the gateway of `orbit-managed-runners`: this host's own address on the runners' network. Self-hosting and the runbook now state that plain HTTP goes nowhere else. |
| Backup and restore | `scripts/managed-runner/volume-backup.sh`, as [the runbook](managed-runner-docker-operations.md) gives it, on a sleeping runner's volume | Backed up with its labels (163 files) and checked in a scratch volume: every checksum matched, and the six SQLite files and two repositories were `ok`. The volume was then deleted and restored with its labels while the account was disabled. The runner woke on it as its next generation: every file had its checksum, `integrity_check` was `ok`, and the rows, the dump digest, the repository and the runner identity were the same. |
| Host restarts | `d5-dind` restarted gracefully (`docker restart`) and power-cut (`docker kill`, then `docker start`), each with one runner ready and a SQLite writer in it, and one runner just put to sleep | Docker reported the running container exited (0 on the graceful stop; 255 after the power cut, `FinishedAt` at the daemon's restore). The manager recorded that report as the stop proof and failed the runner `POD_TERMINATED`, its compute held until its owner's Retry started the next generation on the same volume. The sleeping runner woke normally. No committed row of the writer was lost, and every file kept its checksum. |
| Outages | The channel stopped for 62 s during a wake; the apiserver stopped for 60 s | The ready runner stayed ready throughout. The wake backed off (`TRANSIENT`, four attempts) and finished once the channel was back. The runner's container ran on through the apiserver's absence, and the runner was ready 6 s after the apiserver came back. |

Fixed here (commit d44626483, channel and tests):

- the channel's anchored patterns end in `\Z`, so `<uuid>\n` is no runner id or owner id;
- the disk check stops a container over its volume limit even when it cannot write down why, as on a full disk.

Added: `scripts/managed-runner/volume-backup.sh` (`backup`, `check`, `restore`, and `verify` for a volume after a power loss) and its test, and the operations runbook. Self-hosting links to it
and states the `serverUrl` rule and what a runner can reach.

Left to later work (in the task's comment for the coordinator):

- **Host restarts.** After a host or Docker restart every runner that was running needs its owner's Retry. No
  automatic recovery and no operator route exist. (Since D7 the manager starts them again itself.)
- **Silent failures.** The apiserver does not log a runner that failed, and the `detail` (such as `OOM-killed`)
  reaches no client. (Since D7 every stop is logged with its exit code and whether it ran out of memory, and running
  out of memory has reasons of its own; the `detail` still reaches no client.)
- **A held volume fails the wake.** A wake that finds another container referring to the volume (a backup's)
  fails the runner (`DOCKER_CHANNEL_REFUSED`, `VOLUME_IN_USE`) instead of waiting. (Since D7 it waits.)
- **`PVC_MISSING` has no way back.** A runner woken while its volume was missing stays `PVC_MISSING` even after
  the volume is restored. (Since D7 it can be retried once the volume is back as recorded.)
- **The storage budget measures the wrong disk.** In Compose it is measured on the disk under
  `data/managed-runners`, not on Docker's data root. Taken up by D8 (Implementation record: channel and template
  hardening).
- **The host's own services are reachable.** Runners reach every service the host listens to on another address,
  and the LAN; the default deployment adds no firewall rule. (Since D9 a fresh install firewalls the managed runners'
  network on the host, and the Docker channel starts no runner without it: Implementation record: the managed
  runners' host firewall.)
- **Two defence-in-depth gaps in the channel.** It caps each container but not their number, and it offers volume
  deletion to the token's holder although the manager never asks for it. Taken up by D8 (same record).

## Implementation record: image upgrades

Recorded 2026-10-17 for the second phase's task D6. The managed runner image carries the runner, and the runner in
it never updates itself (`ORBIT_NO_SELFUPDATE=1`), so until now a new deployment's managed runners kept the runner
of the image they were installed with. The operator's side is [self-hosting](self-hosting.md#what-an-upgrade-does).

| Area | As implemented |
| --- | --- |
| `/upgrade`, profile on | Both copies of the script share one section, byte for byte (`new_deployment_test.py` compares them). Where `docker compose config --services` lists `docker-channel`, the script finds the managed runners' directory as Compose binds it into the channel (the bind's source at `/var/lib/orbit-managed-runners`, so the script names no variable of `.env`), and stops before building if `channel.json` or `profile.json` is missing or names the image other than once. It builds `docker-channel` with the other images, then the managed runner image from this checkout as `orbit-managed-runner:local` (`--build-arg ORBIT_SOURCE_SHA` the deployed commit, `--provenance=false`, never pushed). When the ID is new in either file it writes it into both, each through a copy with the original's mode and owner, then a rename. It recreates the other services as before, then the apiserver if that did not recreate it, then `docker-channel`, last (`--no-deps --force-recreate` for both, since each reads its file only as it starts). |
| `/upgrade`, profile off | Unchanged: each copy makes the Docker calls it made at c16d115b3, in the same order (pinned in `new_deployment_test.py`), and writes nothing under `data/`. |
| Order | The apiserver goes first. A manager whose profile names an image the channel does not serve stops each pass at the mismatch (`capacityBudget`, `DOCKER_CHANNEL_MISMATCH`) before it reads any mapping, so it changes nothing and waits; the channel then restarts on the new image and the next pass goes on. The other order would let the previous apiserver, its capacity pool already established, ask a channel already on the new image for a container: refused (`IMAGE_REFUSED`, or the guard probe refused for that) and the runner it was starting `FAILED` (the Docker backend pg spec, case 12). |
| Running containers | Left as they are. A container keeps the image it was made from: the upgrade stops, drains and restarts no managed container, and the channel still reads, stops and removes containers of a previous image by UID. Each runner moves to the new image with its next container, the next generation the wake after its next sleep (or a retry) makes, on the same volume and runner. A runner is stopped for nothing but the reasons it already was: draining for an image would cost a busy user a wake for nothing they asked for, while the sleep already decides when a runner can stop without interrupting anything. A runner that never sleeps keeps the previous image; its owner can ask it to sleep (`POST /api/managed-runner/sleep`). One container per volume, the stop proof and the compute reservation are exactly those of any sleep and wake. |
| Channel | Only the configured image is made or started. A container of a previous image that was made and never started is removed and made again from the current image, at start-up (as before) and now also on a create (`create_container` started it if its credential was there again). |
| Unfinished switch | `data/managed-runners/.image-switch` names the image from before the files are written until both services have started on them; a run that finds it starts both again, whatever it built. |
| Image ID | BuildKit's provenance attestation is made anew for every build, and in Docker's containerd image store the image's ID is the digest of the index carrying it: a fully cached rebuild of the same commit got a new ID (`sha256:efa7b75f9ac0…`, then `sha256:1eb5a013755c…`, config and layers identical). Built with `--provenance=false` (the install too, now), it keeps one ID, so a re-run finds the files already naming it. |
| Previous images | Nothing deletes one. In the containerd image store the previous image loses its name when the new one takes the tag (no dangling record) while its containers keep running on it; their removal frees its storage. In the classic store it stays untagged, kept by Docker while a container was made from it and removed by `docker image prune -f` (`/upgrade --prune`) afterwards. Both shown in throwaway Docker 29.8.2 hosts. |
| Cost | The image is stamped with its commit, so every new commit rebuilds it. `ARG ORBIT_SOURCE_SHA` comes before the package and `chown` steps of its last stage, so both run again: 10 minutes on the test host's spinning disk, which needs the network for the package snapshot. The install's cold build there took 19.5 minutes. |

Verified on 2026-10-17 in isolated Docker hosts on the HPC machine (`docker:29.8.2-dind`, containerd image store,
capped, outside the runner's cgroup; [evidence](evidence/managed-runner-image-upgrade/2026-10-17/README.md)):

- A fresh install at the project line's tip c16d115b3 (`scripts/install-server.sh`, no flags) built
  `sha256:efa7b75f9ac0…`; the first account's runner was READY, generation 1, after a placeholder Codex sign-in.
- With data written to its volume (a file, a SQLite database) and a process in its container writing a timestamp
  every second, `/upgrade` deployed d051db3d8 plus a one-line runner source change: it rebuilt the image
  (`sha256:09a872d9ce72…`, source f899e5fe6), rewrote only the `image` line of each file, recreated the apiserver
  (its own image had not changed) and then the channel. The new apiserver's two passes before the channel came back
  stopped at the mismatch; the channel served the new image eight seconds after the apiserver started on it. The
  runner's container was the same container, started at the same time, through the whole upgrade, its writer without
  a gap over two seconds, its mapping READY at the same revision.
- Its owner's sleep: the runner exited by itself (exit 0), the channel removed the container, and only then did the
  mapping sleep, compute released. The wake made generation 2 from the new image: the same runner ID and volume, the
  file and the database intact, the runner reporting `managed-f899e5fe6…`. A sampler every 250 ms saw at most one
  container referring to the volume (5223 samples).
- A deployment installed by hand at c16d115b3, with no managed runner line in `.env` (orbitd.io's kind), upgraded
  first with c16d115b3's own `/upgrade` and then with D6's: the same Docker calls in the same order, the same
  containers recreated, `.env` byte for byte as installed, no file added under `data/`, and no channel, network,
  managed runner image, container or volume.
- Both repeated at 6fcdaa8d6 and again at d431d1021, after D5's merge: each time the new deployment switched the
  same way (`sha256:8a3c127f2568…`, then `sha256:8284db3f7c45…`) and after the next sleep its runner woke on the new
  image as the next generation, the same runner and volume, never two containers on the volume; the deployment
  without managed runners made the baseline's calls again, and nothing under `.env` or `data/` was written but by
  Postgres. (Between the two, a restart of the test host left the runner `FAILED` until its owner's retry, as D5
  recorded for any host restart.)

Left to later work, or not shown here:

- No model was used: the owner's DeepSeek key file was not there, so READY came from a placeholder Codex sign-in
  and the work the upgrade did not interrupt was a process in the container, not an engine session.
- A runner that never sleeps keeps the previous image; there is no administrator command to move every runner at
  once.
- Every commit rebuilds the image's last stage. Moving `ARG ORBIT_SOURCE_SHA` and the label below the package and
  `chown` steps in `deploy/managed-runner/image/Dockerfile` (T03's) would keep those cached.
- The by-hand upgrade steps (self-hosting's "Upgrading") rebuild no managed runner image; they now list the commands
  that do.

## Implementation record: failure recovery and visibility

Recorded 2026-10-17 for the second phase's task D7, which fixes the four manager findings that D5 left to later work
(above: host restarts, silent failures, a held volume, `PVC_MISSING`). Every rule below is the shared state machine's
(`managed-runner-manager.ts`), so it is the same on Kubernetes and on Docker, and `managed-runner-recovery.pg.spec.ts`
runs each case on both. The single-writer gate is unchanged: at most one instance refers to a volume, a new
generation is started only on a stop proof, and compute goes back to the pool only after one. The operator's side is
[the runbook](managed-runner-docker-operations.md).

| Area | As implemented |
| --- | --- |
| Restart after a stop | A STARTING or READY instance that stops with its host's report of the stop — the kubelet's terminal container states on Kubernetes, the exit Docker recorded on Docker — is started again by itself: a crash, its memory limit, its host or Docker restarting. The report is recorded as the stop proof, and the mapping goes back to `REQUESTED` with the stopped instance still recorded, which is what an owner's retry writes. After the backoff of its attempt, the gate removes that instance by UID, waits until nothing holds the volume, retires the generation (its credential replaced) and starts the next one on the same volume, runner row and workspace. Compute stays reserved throughout, as for a retry: neither given back nor taken twice. A stop nobody reported (an instance gone, or made terminal by the control plane) is no proof and fences, as before. A runner whose owner had asked it to sleep goes to sleep instead: the stop is the end of its drain. |
| Crash loops | Each stop spends one attempt of `lifecycle.maxAttempts` and waits the backoff of a failed try (`backoffBaseSeconds`, doubling up to `backoffMaxSeconds`), from the same count: READY no longer resets it. A runner that had stayed READY for twice `backoffMaxSeconds` starts the count again at its next stop, as the kubelet starts a crash loop's backoff again after twice its ceiling, so a host restart months later is attempt 1. The stop that spends the last attempt leaves the mapping FAILED `POD_TERMINATED` (or `POD_OUT_OF_MEMORY`), retryable, the stopped instance and its compute kept until the owner's retry, which starts a fresh count. With `maxAttempts` 1 nothing is restarted. |
| Visibility | Every such stop is one warn line: `managed runner <id>: POD_TERMINATED: <instance> <uid> of generation <n> stopped in <state> with exit code <code>, out of memory` (or `not out of memory`), then `; starting generation <n+1> on the same volume in <s> s (attempt <k> of <max>)`, `; FAILED: attempt <k> of <max> in a row`, or `; its owner asked it to sleep, so it goes to sleep`. Out of memory is the host's OOM report on a runner that ended killed (exit 137): Docker marks a container OOM-killed whenever any process in it was, and the kubelet's `OOMKilled` reason is given the same way, so the mark alone says nothing about the runner. While it restarts, the owner's reason is `POD_RESTARTING` or `POD_RESTARTING_OUT_OF_MEMORY`, kept until it is READY unless a later wait says more (capacity, a transient error, its volume still detaching or held, a runtime to sign in); once the attempts are spent, `POD_TERMINATED` or `POD_OUT_OF_MEMORY`. The operator's `detail` still reaches no client. |
| A held volume | No instance is created on a volume something else holds. Before every create the manager asks what holds the volume (Docker: any container, labelled or not; Kubernetes: any VolumeAttachment of its PV), and the channel's own `VOLUME_IN_USE` refusal of the create — a holder that came between the look and the create, read back as `ManagedVolumeHeld` — is the same answer. STARTING then waits with `VOLUME_IN_USE`, as the gate waits for a predecessor's volume with `VOLUME_STILL_ATTACHED`: no attempt is spent and no startup deadline runs. Once the volume is free the deadline is set from that moment and the instance is created. One warn line when the wait begins. On Kubernetes this is new as well: a create used to go ahead while another node's attachment of the PV was there. |
| The container cap (Docker) | D8's channel refuses a create past `limits.maxContainers` (`429 CONTAINER_LIMIT`), counting every container of its instance in any state. The pool's budget holds its pods to that cap, so the refusal comes only from a cap lowered under running runners before the apiserver measured its pool again, or from a container of the instance that no runner records. The Docker backend reads the refusal as `ManagedInstanceLimit`, and STARTING waits for room with `CONTAINER_LIMIT`, as for a held volume: no attempt spent, no startup deadline running, one warn line, a look again every `capacityRetrySeconds`, and the deadline set afresh once the instance is made. Before, the 429 was a transient failure, and each one spent an attempt from the count a restart spends too: a runner restarting after a crash met the cap twice and was FAILED `RETRY_EXHAUSTED` (the control in the evidence). Other 429s are still transient. |
| A restored volume | A FAILED `PVC_MISSING` mapping is looked at on each pass, after every other kind of work. Once a volume is under its name with the recorded identity (its UID, owner and runner, bound to the recorded storage — what `scripts/managed-runner/volume-backup.sh restore` leaves on Docker, or a restore of the cluster's etcd on Kubernetes) and nothing holds it any more, the reason becomes `PVC_RESTORED`, retryable, and the owner's retry starts the runner on it through the usual checks. While the restore's own containers still hold it (the script makes the volume, labels and all, before it unpacks into it), it stays `PVC_MISSING` and the detail says it is back and held; between the script's unpacking and its inspection nothing holds it for a moment, by which time the data is complete and checked, and a retry then waits for the inspection like any create (`VOLUME_IN_USE`). A volume under the name that is not the recorded one changes only the operator's detail; nothing is created in place of a recorded volume. |
| Clients | The three clients show the server's sentence for any reason, so none of their copy changed. The shared state fixture gains seven states, 33 in all: waking after a stop, after running out of memory, while the volume is held and at the host's cap on containers; failed after too many stops, after running out of memory, and with the volume restored (Retry offered). |
| Data | No migration. `attempt` now counts restarts after a stop as well as failed tries; its schema comment says so. |

Verified on 2026-10-17 ([evidence](evidence/managed-runner-recovery/2026-10-17/README.md)):

- `managed-runner-recovery.pg.spec.ts`, every case on the fake Kubernetes cluster and on Docker's fake channel: a
  restart after a stop with its host's report (one instance per volume after every pass, one compute share reserved
  throughout, a stop nobody reported still fencing); a crash loop in READY and STARTING ending FAILED, the owner's
  retry starting afresh, and the count starting over after twice `backoffMaxSeconds`; out of memory said while
  restarting and once spent; a runner asked to sleep going to sleep; a wake on a held volume waiting and finishing by
  itself; a lost volume failing the wake and, once restored as recorded and free, retryable. All 12 cases fail on the
  previous manager. A 13th, on Docker alone, has a restart meet the channel's container cap after it was lowered
  under two running runners: the restart waits, past the attempt budget and the startup deadline, and starts once the
  other runner sleeps. With the Docker backend's reading of the refusal switched off it ends FAILED.
- On the HPC host's real Docker, D2's integration test with this build's image: 14 of 14, the kill, the "host
  restart" and the disk-limit cases now recovering, or failing `VOLUME_OVER_LIMIT`, with no retry. Run again on the
  merge with D8, whose channel refuses volume removal and gives runners an executable `/tmp`.
- In an isolated Docker host (`docker:29.8.2-dind`) with a default deployment upgraded to this branch (fb93b9403,
  then e51574350 for the restore; both before D8's merge, and not repeated after it): a graceful restart and a power
  cut of that host each brought its READY runner back by itself in 69–75 s, the same runner and volume UID, the next
  generation, every committed SQLite row and every file kept; a backup's helper container holding the volume made a
  wake wait and the runner start 2 s after the helper left; a volume lost while asleep failed the wake and was
  retryable once the runbook's restore had finished; a real OOM kill of a runner was logged and said to its owner
  while the runner restarted. No data volume ever had two containers.

Left to later work, or not shown here: Kubernetes only on the fake cluster (a real node's reboot, its kubelet's report
and its detach timing are for T04 and T06); no model was used; the power cut was the test host's, with the HPC host's
kernel up; the OOM kill came from lowering a running container's limit, and Docker's OOM mark cannot tell a runner
killed for memory from one SIGKILLed after a child was; no administrator's retry for another account; the wait at the
container cap only against the fake channel (no runner met the real channel's cap in the integration test or the
isolated host); on Kubernetes a namespace quota on Pods below the budget still fails the runner
(`KUBERNETES_FORBIDDEN`), as before.

## Implementation record: channel and template hardening

Recorded 2026-10-17 for the second phase's task D8, which takes up three of D5's findings (record above): the storage
budget measured the wrong disk, the channel bounded each container but not their number and served volume removal
to the token's holder, and a runner's `/tmp` was `noexec`. The fourth that D5 left to the owner, what a runner may
reach on the host and its LAN, is not part of it. The operator's side is in
[the operations runbook](managed-runner-docker-operations.md) and [self-hosting](self-hosting.md#managed-runners).

| Area | As implemented, and why |
| --- | --- |
| The disk the budget measures | Root Compose mounts an empty, anonymous volume into `docker-channel`, read-only, at `/var/lib/orbit-docker-volumes`, and names it with `--disk-probe-path` in the service's `command`. Docker keeps that volume beside every data volume, so `statvfs` on it is their filesystem, wherever `data-root` points and whatever filesystem the checkout is on. The two ways the task suggested were weighed and not taken. Binding Docker's data root into the channel, even read-only, would show it every container's files and every account's volume, which it needs none of. Its path also differs by host, so Compose would need a variable in `.env` that `/upgrade` may not write, and a recursive bind would copy running containers' overlay mounts into the channel's namespace. An install-time `capacity.storage` would be a number that goes stale as the disk fills with anything else, and that `/upgrade` would have to add to an operator's `profile.json` on existing deployments. The channel gains no write access, and no file in `data/managed-runners` changes. A fresh install, `/upgrade` (which recreates `docker-channel` from the new Compose file) and the by-hand `docker compose up -d --build` all get the fix. The order of precedence is `diskProbePath` in `channel.json`, then `--disk-probe-path`, then Docker's data root where the channel can see it, then the state directory. The last comes with a warning at start-up, and a probe path that is not a directory stops the channel before it serves. |
| A cap on containers | `limits.maxContainers` in `channel.json`, optional. The channel counts every container of its instance, in any state (each one holds its volume until it is removed), and refuses a create past the cap with `429 CONTAINER_LIMIT` before anything is made. The count and the create are one step under one lock, and the containers already there are not touched. The default is one container per CPU and per GiB of the host's memory, whichever is fewer (Docker's `NCPU` and `MemTotal` at start-up). That holds every runner of any profile giving each at least one CPU and 1 GiB, which is more than the budget (the host less a quarter) can start. `/v1/info` reports the cap it applies, and `dockerCapacityBudget` holds the pool's pods, and the slots derived with them, to it. So the manager never admits a runner the channel would refuse, and a cap set below what the host fits makes runners wait for capacity rather than fail. Should anything else fill the cap, a runner being started waits for room (`CONTAINER_LIMIT`, in the record of D7 above) rather than failing. |
| Volume removal | `allowVolumeRemoval` in `channel.json`, `false` unless set. Off, `DELETE /v1/volumes/…` is refused (`403 REMOVAL_REFUSED`) before anything is looked up. The manager never asked for it. The runbook's deletion procedure turns it on for one removal, by UID, and off again. |
| An executable `/tmp` | The template's `/tmp` tmpfs asks for `exec` (`TmpfsOptions.Options [["exec"]]`). The task offered a second way, `TMPDIR` and `GOTMPDIR` on the data volume. It would leave a program in `/tmp` itself unable to run, and put scratch files on the account's volume, where they count against its disk limit and outlive the container. Docker keeps every tmpfs `nosuid` and `nodev` and accepts only `exec` and `noexec` as options there: in the probe of 2026-10-17 it refused `suid`, `dev`, `size` and `nr_inodes`. The size limit (`runner.tmpSizeLimit`) and its place in the memory limit are unchanged. Nothing is gained that the runner lacked: the data volume was writable and executable already. The template's rules accept that option or none, and nothing else. `TmpfsOptions.Options` came with Docker Engine 27 (API 1.46). An older engine ignores it, so `/tmp` stays `noexec` there, and the channel says so in its log at start-up. Nothing under `deploy/managed-runner/image` changed. |

Verified on 2026-10-17 in an isolated Docker host on the HPC machine (`docker:29.8.2-dind`, capped, outside the
runner's cgroup), whose Docker data root was on `/mnt/data` and whose deployment's checkout was on a 3 GiB tmpfs of
its own ([evidence](evidence/managed-runner-docker-hardening/2026-10-17/README.md)):

- **Before** (the project line at 1f5bc9cec, a fresh install): `/v1/info` measured the tmpfs (3,221,225,472 bytes),
  and the first account's runner waited `short of storage`. Docker's disk had 15.3 TB free.
- **`/upgrade` to this change**: the channel came back on the probe, and `/v1/info` and the pool measured the
  15.87 TB disk. The waiting runner was admitted and its container made, with no file under `data/managed-runners`
  changed.
- **A fresh install**: the same.
- **`/tmp` in a runner container**: `rw,nosuid,nodev,size=1048576k`. A script, a program and a Go binary ran from it,
  `go test` and `go run` passed with the default temporary directory, and a write stopped at the 1 GiB limit
  (`No space left on device`).
- **The cap at 1, with two containers there**: neither was touched. A token holder's create was refused (429) with
  nothing made. A third account's runner waited, and went on waiting, short of runner slots alone, after another
  runner slept. With the cap removed it started at once.
- **The runbook's deletion procedure**: off, refused (403); on, a wrong UID refused (409) and the volume's own
  removed (204); off again, refused.
- **A deployment without the profile**: both copies of `/upgrade` made the same Docker calls as before. `.env`,
  `data/`, the services, volumes and networks were as installed, and nothing of managed runners appeared.

Left to later work, or not shown here:

- Docker older than 27 keeps `/tmp` `noexec` (logged); only 29.8.2 was run.
- After the channel has been recreated, `docker compose down -v` leaves the empty probe volume behind; the runbook
  says so.
- What a runner may reach on the host and its LAN (D5's finding 6) waits for the owner. (The owner decided on
  2026-10-19; D9 implements it: Implementation record: the managed runners' host firewall.)

## Implementation record: Kubernetes reconciliation in the lab

Recorded 2026-10-17 for the real-environment task T04: the manager against the single-machine lab's real k3s
([the evidence](evidence/managed-runner-manager-lab/2026-10-17/README.md), [the lab page](managed-runner-lab.md#manager-reconciliation-t04)),
and the two Kubernetes findings T02a left to it. The Kubernetes changes are in `kubernetes-backend.ts` and its helpers,
and one rule is in the shared state machine. Kubernetes behaviour is otherwise unchanged.

| Area | As implemented |
| --- | --- |
| A deleted Pod's stop report | Every Pod the manager creates carries its finalizer `orbit.dev/managed-runner-stop-report`. Before, an operator's `kubectl delete`, an eviction or `kubectl drain` fenced a runner whose kubelet had reported it stopped: the kubelet's terminal report stayed in the API for under a second after its final delete, and the manager looks every `pollIntervalSeconds` (T02a). Now the object stays, ended, with that report until the manager has recorded it. A terminal Pod the finalizer holds is not reported as being removed, so the gate goes on to `removeInstance`. That deletes the Pod by UID and then takes the finalizer off with a JSON Patch (`test` of the UID and of the finalizer, then `remove`), and the next generation starts by itself, as for a crash. A patch whose test fails (409 or 422) is read again on the next pass. A Pod whose finalizer was stripped and that vanished is still gone without a proof, and fences. So is one its node cannot report on, once the control plane marks it terminal. Its object stays until an operator taking over removes the finalizer (deploy README, "Fencing receipt"), and the receipt is then read as before. The manager's Role gains `patch` on Pods, and nothing else: not `update`, not `pods/status`, not `pods/ephemeralcontainers`. The admission guard allows the patch, which changes no identity field. `runner-pod.yaml.example` carries the finalizer, and its spec still matches the built Pod. |
| An unreachable backend | A backend that could not be reached at all spends no attempt, in any state, on both backends: the budget counts tries that failed, not an outage. Before, a two-minute VM restart spent four attempts of a STARTING runner, and one of about 15 minutes would have ended it `FAILED RETRY_EXHAUSTED` (T02a). "Not reached" means no request got there. The failure is `{ retryable: true, unreachable: true }`, from `KubeUnreachableError` (the HTTPS transport tracks `secureConnect`: refused, reset, timed out or unresolved before the TLS session was up) and from `DockerChannelUnreachable` with `connected: false` (no socket connection). The pass is said as `TRANSIENT` and tried again after the backoff of the attempt it is on, pass after pass. A backend that was reached and answered 5xx or 429, or gave no answer after the request went out, still spends an attempt while provisioning. The observing states (READY, DRAINING, FENCING, FAILED) spent nothing already (D2). The startup deadline still runs through an outage. |
| What clients show | Nothing changed. During an outage a READY runner stays "Managed runner ready" (it keeps heartbeating to Orbit), and a STARTING one says the transient sentence. A FENCING one shows "Waiting for an operator" and its fence reason, unchanged, because a pass that only looks writes no lastError. The outage itself is only in the server log, one warn line per pass. |

Verified on 2026-10-17:

- `managed-runner-recovery.pg.spec.ts` (8) on both backends and (9) on Kubernetes (above in the evidence). With the
  manager's rule undone, (8) fails on both backends. With the finalizer undone, (9) fails FENCING instead of a restart.
  All 12 managed-runner pg specs and the unit suite pass on the change, and `kube-http-transport.spec.ts` runs the real
  transport on loopback.
- In the lab, all of the following, with the database and k3s agreeing after every step and never two Pods on a volume:
  - two replicas and 32 concurrent sign-ins and ensures;
  - a wait for capacity;
  - a PVC create and a Pod create whose answers were lost after k3s applied them;
  - a Secret create committed while both controllers were SIGKILLed;
  - a stopped instance left behind while no controller ran;
  - 150 s outages while READY and while STARTING;
  - a killed runner process and a VM restart, after which the kubelet itself reported both Pods stopped;
  - a delete, an eviction and a force delete;
  - a Pod gone with no report;
  - one owner against another;
  - the switch unset and `false` with live resources.

Left to later work, or not shown here: everything across nodes; the operator's path out of FENCING (an accepted receipt,
or the finalizer removal on a node that cannot report), since on one node a power-off stops the cluster; PodGC on a real
unreachable node; READY with a real runtime (a stand-in login was used); a real API server answering 5xx while
provisioning; and what an operator sees of an outage while FENCING (the log only).

## Implementation record: wake and capacity follow-ups

Recorded 2026-10-18 for task T06b, which fixes three of T06's findings on the lab's real k3s (above, "capacity, wake and
sleep"). Two rules are the shared state machine's and hold on both backends. The third, the quota, is Kubernetes' own, and
it now waits as the Docker channel's cap on containers already did. This record supersedes three earlier statements for
the cases it covers: the run backends record's "401 and 403 are `KUBERNETES_FORBIDDEN`", the failure recovery record's
note that a namespace quota on Pods "still fails the runner", and the sign-in record's 409 for a first session on a runner
that has never reported its engines.

| Area | As implemented, and why |
| --- | --- |
| A managed instance's first heartbeat | A managed instance now beats once before it claims anything (runner-go `managed_startup_beat.go`, `runloop.go`). The beat waits for the engine probe's first answer, for at most 20 s, so that it carries what READY reads. If the beat is refused or unanswered (a control plane restarting, an instance not recorded yet), it is sent again every 2 s, until one is taken or the first tick is due. The claim loop waits for it; the ticker keeps its cadence from the process's start. Before, the first beat came at the first tick, 30 s after the start. A woken instance served turns all that time while its mapping read STARTING, and an auto retry, which waits for READY, waited as long. Carrying the online information on the claim instead would not have done: READY needs the engine report, which only the heartbeat carries. A self-managed runner is unchanged: no startup beat, its claims not held back, its first beat at the first tick. The cost: a woken instance's first claim now waits for its probe, about 8 s after `orbit run` starts, in the lab. Nothing under `deploy/managed-runner/image` changed, and an image built from source carries it. |
| A namespace quota | On Kubernetes, a 403 whose message says `exceeded quota` is now `KUBERNETES_QUOTA_EXCEEDED`, not `KUBERNETES_FORBIDDEN` ("check its permissions"). That 403 is the ResourceQuota admission's refusal (`kubernetes-backend.ts`, `failure`), and the quota's own words (`exceeded quota: <name>, requested: …, used: …, limited: …`) become the operator's detail. The runner waits for room rather than fails (`managed-runner-manager.ts`, `waitForRoom`, now one method for this and `CONTAINER_LIMIT`). Nothing was made, so no attempt is spent and no startup deadline runs; the create is asked again every `capacityRetrySeconds`, and the deadline runs from when it goes through (`roomMade`). This holds for every create the manager makes: the claim, the bootstrap Secret and the Pod. A quota on claims or Secrets is lifted only by an operator. Why wait rather than fail retryable: "Management and execution states" names a quota among the causes of a wait for capacity. A quota on compute below the budget is lifted by itself when another runner's Pod goes at its sleep; a failure would leave the owner to press Retry at the right moment while their work waits. And the cap on Docker already waited. The owner reads "The cluster's resource quota for managed runners has no room for this runner, so it is not started yet. It starts by itself once there is room, as when another runner goes to sleep or an operator raises the quota.", not retryable since there is nothing to retry. The shared state fixture gains the state (35 in all), which every client shows by its sentence; no client changed. |
| A new account's first session | Before, `SessionsService.create` refused a first session in a managed default workspace (409 `MODEL_UNAVAILABLE`) unless the runner had reported its runtime ready. A runner waiting for capacity, being provisioned, or not yet heard from never has, so even a session naming the owner's own key was refused (T06). Now, while the runner row has stored no engine report at all, a session that brings its own credential is queued, and the runner runs it once it is READY (`assertManagedFirstSessionRuntime`). The credential can be one of the owner's model keys, an account pool or a workspace credential, on a runtime counted as supply. A session on a runtime's own sign-in is still refused, since nobody could have signed it in on a runner that has never come up. Once the runner has reported, what it reported decides, as before. With nothing named, a managed default workspace whose runner was never ready (no `initialProvider`) now derives the owner's own key that READY would record (`managedFirstSessionKey` in `lastProviderByWorkspace`): the first of the owner's enabled keys, in their order, on a runtime counted as supply. Without such a key it still derives the Claude floor. While the session waits, its reason is the owner's status reason (for capacity, "The managed environment has no room for this runner right now (…)"), which `GET /api/managed-runner` answers and the clients show above the composer; the session itself is PENDING like any queued session. The rule reads only the runner row and the owner's keys, so it is the same on both backends. |

Verified on 2026-10-18 ([evidence](evidence/managed-runner-wake-followups/2026-10-18/README.md), [the lab page](managed-runner-lab.md#wake-and-capacity-follow-ups-t06b)):

- runner-go: `managed_startup_beat_test.go` covers the probe wait, its bound, the retry, the limit and a stopping runner, the probe's first answer, and runLoop's wiring for a managed instance alone.
- `managed-runner-recovery.pg.spec.ts` case (10), on Kubernetes: a Pod refused by a quota waits and starts once another runner sleeps, and a claim refused by a quota on claims waits until the quota is raised. With the previous product code it ends FAILED.
- `managed-runner-first-session.pg.spec.ts`, on both backends, with the whole application in process: a new account waiting for capacity queues its first session, with nothing named and then naming its key, while a sign-in session is still refused. Once the other runner sleeps, the new one is READY on the key and claims both. With the previous product code those sessions are refused.
- The lab's real k3s, with a one-runner budget and the image rebuilt from the task's commit:
  - In five wakes and a new account's first start, the first heartbeat came before the first claim (by 0.03–0.21 s), and READY 1.1–5.0 s after it (the manager's poll). T06 measured about 30 s.
  - With a quota of zero Pods, a wake waited for 2 minutes with nothing spent, and the Pod was made by itself about 4 s after the quota was lifted.
  - A new account's first sessions were queued while it waited for capacity, and answered once it was READY.
  - The same runner build as a self-managed runner claimed at once and beat at its first tick.
- The host's real Docker, in D2's integration test with this commit's image, 14 of 14: a new account's first session was queued
  (201, on her key) while her runner waited for capacity, and her runner claimed it 2.3 s after a slot was released.

Left to later work, or not shown here:

- The clients still offer no draft in a managed default workspace before `initialProvider` is known (C7's `startsNewSession`). A new account can therefore queue its first session through the API, the CLI or a task, but not from a composer. Opening that gate needs the status to say what a first session would start on before READY.
- A queued first session on a key whose engine the runner turns out not to have waits, while the runner ends `MODEL_UNAVAILABLE`.
- No model was used: fake-model.py stood in for the owner's DeepSeek key.

## Implementation record: the three clients against the lab

Recorded 2026-10-18 for task T07. Web, macOS and iOS were run against the lab's test server, and this record covers the
changes that needed ([lab page](managed-runner-lab.md#the-three-clients-t07),
[evidence](evidence/managed-runner-clients-lab/2026-10-18/README.md)). It builds on the client status record above
(C7), which proved the three clients against the shared fixture only. It closes the first item that T06b's record left
to later work.

| Area | As implemented, and why |
| --- | --- |
| What a first session starts on, before READY | T06b queued a new account's first session on the owner's key while the runner waits for capacity or starts. The clients still offered no draft until `initialProvider` existed (C7's `startsNewSession`). The status now names it in `firstSessionProvider`: `initialProvider` once the runner has been READY. Before that, it is the owner's own model key such a session is queued on (`managedFirstSessionKey`), while the runner has not reported its engines or has reported that key's engine installed. It is null when the create would refuse the session `MODEL_UNAVAILABLE`. The status read computes it with the create's own rule (`managedFirstSessionProvider`, beside `assertManagedFirstSessionRuntime`). It asks for the owner's keys only while the switch is on and nothing was recorded. The shared display offers the first session when the field is set (`startsNewSession`) and reads a server that predates it by `initialProvider`; OrbitKit mirrors this. The field is additive, so the contract version stays 1. |
| The draft follows the key | The draft's default provider and model come from the workspace list (`lastProvider`, which the server derives). The list went stale when the key arrived, so a draft opened by the status would have offered Claude Code's floor and its model. The web reads the workspace list again when the first-session provider changes (`useFollowFirstSessionProvider`). The native apps reload their workspaces, and with them the provider list (`ManagedRunnerModel.onFirstSessionProviderChanged`). On the lab, the web draft opened on the key and its model 3.4 s after the key was added. |
| Waking, shown at once | Found on the lab: a message to a runner asleep for 15 s woke it and was answered 4.4 s later. Meanwhile the web said "Managed runner asleep" until its next 30 s read. Web and native read the managed status again right after a send only when the runner row read offline, and a just-slept managed runner's row still reads online until its last beat goes stale. Both now read it whenever the managed status is anything but available. On the lab after the fix, "Waking your managed runner" showed 0.7 s after the send. |
| Not changed: the restart reason after a held volume | On Kubernetes a restart waits a few seconds for the old Pod's volume to detach (`VOLUME_STILL_ATTACHED`, "…still detaching"). When that wait ends, the reason is cleared rather than going back to `POD_RESTARTING`, so for the rest of the restart the clients show the generic "It is starting again". `restartReason` keeps a restart reason only while it is still the stored one. Reported to the coordinator. |

Verified on 2026-10-18:

- Unit tests:
  - `managed-runner-status.spec.ts` and `managed-runner-supply.spec.ts`: a table test that the status's rule agrees
    with the create's;
  - `managedRunnerDisplay.spec.ts`;
  - the shared fixture's four new states (39 in all), held by the apiserver, shared, web and Swift tests;
  - `WorkspaceView.managedRunner.test.tsx`: the draft offered on the key, the workspaces read again, and waking shown
    for a just-slept runner whose row still reads online. The last two were mutation-checked.
  - OrbitKit's `ManagedRunnerLogicTests` and `ManagedRunnerWiringTests`.
- `managed-runner-first-session.pg.spec.ts`, on both backends: with no key the status names nothing, the display offers
  nothing, and a session with nothing named is refused 409 `MODEL_UNAVAILABLE`. With the key, the status names it and
  the display offers the first session. After READY, `firstSessionProvider` is the key's slug.
- The lab's real k3s, a budget of one runner, the web live. Covered: new accounts, first sessions, sleep and wake, a
  crash loop and an out-of-memory loop each with Retry, a quota, a held and a deleted volume, and an environment the
  server cannot use. The switch was also tested unset, `false`, missing and on, for an account with its own runner.
- The host's real Docker, the web live: `CONTAINER_LIMIT` while preparing and waking, `VOLUME_IN_USE`, and
  `PVC_MISSING` then `PVC_RESTORED` with Retry.
- The iPhone and Mac apps on GitHub's macos-26, fed the same server's recorded answers. Each of the 25 scenes passed on
  both apps: round 2, then scene 20 on the Mac again in round 4, and the landing scenes in round 3. No app made a
  request outside the recording, and no write differed from the recorded one. Round 1's failures came from the
  recording, where the provider list was read only every 15 s, and the replay now accounts for that. Round 2's one
  Mac exit did not recur.

Left to later work, or not shown here:

- The native apps did not reach the test server live; their run is a replay. Replay cannot show the live server's
  timing: when an answer came is the recording's, sampled every 2 s, or every 15 s for the slower lists.
- No model was used: fake-model.py stood in for the owner's DeepSeek key.
- No runtime was signed in from Infrastructure to clear "Your managed runner needs a model". Removing and deleting a
  runner exist in the fixture only, and the server has no deletion flow yet.
- A Retry pressed on one client shows on another at that client's next settled read (30 s). The clients still poll,
  because no server sends revision notices.

## Implementation record: a restart's reason through the waits on its way

Recorded 2026-10-18 for task T07b, which fixes the finding T07 left to it (the row "Not changed: the restart reason after a
held volume" in the record above). The rule is the shared state machine's (`managed-runner-manager.ts`), so it is the same
on both backends; on Docker it shows only after the waits Docker has, since nothing there detaches. For the cases it
covers, this record supersedes the failure recovery record's "kept until it is READY unless a later wait says more".

| Area | As implemented, and why |
| --- | --- |
| What the owner reads | While a runner restarts by itself (D7), its reason is `POD_RESTARTING`, or `POD_RESTARTING_OUT_OF_MEMORY`, until it is READY. A wait on the way says what it waits for while it lasts, as before: the stopped instance's volume still attached (`VOLUME_STILL_ATTACHED`), the volume held by something else (`VOLUME_IN_USE`), the environment's cap on what it holds (`CONTAINER_LIMIT`, `KUBERNETES_QUOTA_EXCEEDED`) or a transient error (`TRANSIENT`). Once the wait is over, the restart's reason is back, with its detail: when the gate advances to the next generation, at admission, at the move to STARTING, when a held volume is free and when a create that a cap held back goes through. Before, `restartReason` kept a restart's reason only while it was still the stored one, so the end of any wait cleared it. For the rest of the restart the clients said the generic "It is starting again", and the out-of-memory notice was gone. |
| How it is kept | The wait's reason carries the restart's own reason (`lastError.restart`: its code, sentence, retryable flag and detail). `waitReason` writes it, and `restartReason` reads either. Neither the status read nor the demand hook's answer shows it: both give clients only `code`, `message` and `retryable`, as before, so every client shows the wait while it lasts. The task also offered a marker on the mapping. That would need a migration, and every way a restart ends would have to clear it, or a later start would read as a restart: READY, a failure, a fence, a sleep, a disabled owner, an owner's retry. Kept in the reason, it goes wherever the reason goes, because each of those writes a reason of its own, or none. |
| What stays as it was | Attempts: a wait spends none, a transient error the backend answered still spends one, and one that never reached the backend spends none (D7, T04). Startup deadlines: none runs during a wait, and one runs from admission, from a held volume freed or from a create a cap held back (D7, T06b). The single-writer gate, its stop proofs and compute held through a restart are unchanged. A fence's reason carries nothing, so a start after an operator's receipt is not said to be a restart: its fresh attempt budget already says it is not one. A start nobody restarted carries no restart reason through the same waits: a wake, an owner's retry, a new account. A restart never waits for capacity (WAITING_CAPACITY), since its compute stays reserved. `MODEL_UNAVAILABLE` carries nothing: it lasts until READY or until the start fails, so no later step gives a reason back. A transient error while the next instance starts (STARTING) is said until READY, as on any start, because STARTING writes no reason between the try and READY. |
| Clients | No change. The three clients show the server's sentence for any reason (C7, D7). The shared state fixture already holds a restart's states (waking after a stop, and after running out of memory) and each wait's own. |
| Data | No migration. `managed_runner.last_error` is JSONB and nothing constrains its members. |

Verified on 2026-10-18 ([evidence](evidence/managed-runner-restart-reason/2026-10-18/README.md), [the lab page](managed-runner-lab.md#the-restart-reason-through-the-detach-wait-t07b)):

- `managed-runner-recovery.pg.spec.ts`, cases (11) to (15):
  - (11), on the fake cluster: a restart after a stop, and one after running out of memory, whose stopped Pod's volume
    stays attached. Each says `VOLUME_STILL_ATTACHED` while it waits, with nothing spent, no next generation and no
    startup deadline. Once the volume detaches, it is restarting again through admission, provisioning and the start,
    and READY clears it. An owner's retry through the same wait says nothing of a restart.
  - (12) to (15), on both backends unless marked: a transient error when the restart is due; a backup's helper container
    holding the volume when the gate looks (Docker); the environment's cap on instances; a volume held when the next
    instance is to be made. A wake through that last wait says nothing of a restart.
  - Nine of the ten new cases fail on the previous manager, each because the reason after the wait is none. The tenth,
    the owner's retry, passes on both. All 17 earlier cases still pass.
- The lab's real k3s, with the runner killed while READY (`orbit run` SIGKILLed, and the container run out of memory):
  - The stopped Pod's attachment kept for a while (below). The status read, every 0.5 s, gave REQUESTED `POD_RESTARTING`
    (4.5 s), then REQUESTED `VOLUME_STILL_ATTACHED` (15 s), then STARTING `POD_RESTARTING` on the next generation, then
    READY with no reason. Out of memory gave the same, with `POD_RESTARTING_OUT_OF_MEMORY` before and after the wait.
  - The previous manager, with the same lab, image, profile and hold: STARTING had no reason after the wait, and the
    clients said "It is starting again", which is T07's finding.
  - Without the hold, in three runs and a kill while starting, the volume detached 3.3–6.1 s after the Pod failed. That
    was before the gate looked, and the restart's reason stood until READY, as before the change.

Left to later work, or not shown here:

- On the lab's idle VM, a stopped Pod's volume detached 3 to 6 s after the kubelet's report, before the gate looked (its
  first look comes one poll and one backoff after the stop). So the lab showed the wait only with the attachment kept by
  a test finalizer, as a slow detach keeps it; the detach itself had finished. T07 saw the natural wait in a crash loop
  of a runner that was still starting.
- The host's real Docker was not run: the Docker backend's waits were checked against the fake channel only.
- No model was used: fake-model.py stood in for the owner's DeepSeek key. Nothing crossed nodes.

## Implementation record: two accounts end to end, an independent restore, and the Kubernetes runbook

Recorded 2026-10-18 for task T08 on the single-machine lab, the "two-user end-to-end, independent backup restore and
operator runbook" step of the order above. No product code changed; the record is of what the delivered system did, run
by `scripts/managed-runner/lab/acceptance-lab.py` in one pass on the project line, and of the runbook written from it,
[managed-runner-kubernetes-operations.md](managed-runner-kubernetes-operations.md).

| Area | What the run established, and what it did not |
| --- | --- |
| The switch unset and `false` | Both groups ran with no profile, so with no Kubernetes or Ceph setting in the apiserver's environment. Sign-ins, the managed status (`enabled: false`, the shared display shows nothing), every managed write `404 MANAGED_RUNNER_DISABLED`, and a real self-managed runner (this checkout's build, Claude Code on the host) answering a session, a task run now and a task's run time. Nothing managed was written, no object in the namespace changed and no request reached Kubernetes for 90 s each. With every runner asleep, the same held for messages, a task run now and a task's run time; claims stayed, and the waiting work woke the runners once the switch was on again. |
| Provisioning | Two accounts, sixteen concurrent sign-ins over two replicas, with no admission guard: one mapping, claim, Secret and probe each, `FAILED ADMISSION_GUARD_MISSING`, no Pod. With the guard installed, the owners' retries started them on the same claims; `MODEL_UNAVAILABLE` until each added a key, then READY. |
| Capacity | A budget of two runners: a third account waited (`WAITING_CAPACITY`) with nothing created, and was admitted, with its claim made, only after a runner slept. |
| Work and data | Sessions with an attachment, a file written and committed in the session's Git worktree by Claude Code's own Bash tool, and a probe of random bytes, SQLite rows in WAL mode and a Git commit. They kept their checksums, `integrity_check` and the engine's transcripts through idle sleep, a wake by a message and by a scheduled task, an operator's Pod delete, a killed runner, an image rollback and roll-forward, and a controller restart; each resumed session's next request carried the earlier conversation from the volume. The runner, claim, PV, volume handle and RBD image never changed, and no volume had more than one Pod in any sample of the run's timeline. |
| Between the accounts | The other owner's token and runner credential could not read or act on a runner, workspace, instance, session or attachment, and the admission guard refused Pods mixing the two owners and volumes, and a second Pod on the same node and claim. A runner has no service account token and the Kubernetes API refuses it. |
| Busy and idle | A long turn and a background job each kept their runner READY past the idle interval, and the owner's sleep was refused `409 MANAGED_RUNNER_BUSY`; once the work ended each slept by itself. |
| The controller | Both apiservers SIGKILLed while one runner was being woken and the other ran a turn: the turn finished, the waking runner came up without a second Pod create, and the database and Kubernetes agreed. |
| Backup and restore | The RBD image of a disabled, asleep account exported out of the VM to the host, checked there with no cluster (`debugfs`, SQLite, Git, checksums), and written into a new claim's image, which read back byte for byte as the backup; a Pod found the data there. The original was untouched and its runner woke on it. A static PV naming an imported image cannot be used with this Ceph-CSI (its ControllerPublish refuses the handle and its ControllerUnpublish panics), so the runbook restores into a claim the driver provisions. |
| Not established | Everything across nodes: a planned move to another node, takeover after a node stops or is fenced (an accepted fencing receipt, the out-of-service taint), and refusing a duplicate Pod on another node (since T02 on the two-node lab: "Implementation record: one runner across two nodes"). A real model: the sessions ran on fake-model.py. A way to put a restored claim back under an account's runner: the manager accepts only its recorded claim, PV and handle, and switching a mapping to a verified new claim, which this design's retention section calls for, is not implemented (since T08b an administrator's switch does it: "Implementation record: a restored volume back under its runner"). Encryption at rest of the backup. Rolling the apiserver back past the managed-runner feature. |

Verified on 2026-10-18 ([evidence](evidence/managed-runner-acceptance/2026-10-18/README.md), [the lab page](managed-runner-lab.md#end-to-end-acceptance-t08)).

## Implementation record: a restored volume back under its runner

Recorded 2026-10-18 for task T08b, which closes the gap T08 left (its record above, "Not established"): a restored volume
had no way back under an account's runner. The manager accepts a runner's data volume only as recorded, and a Kubernetes
claim's UID cannot be recreated, so a runner whose volume was lost or damaged stayed `FAILED` `PVC_MISSING` for good. The
retention section above calls for the manager to switch the mapping explicitly to a verified new claim; this is that
switch. The operator's side is [the runbook](managed-runner-kubernetes-operations.md#put-a-restored-volume-back-under-its-runner).

| Area | As implemented, and why |
| --- | --- |
| Who asks | An Orbit administrator: `POST /api/admin/managed-runners/:id/volume-switch`, `:id` the runner's (`managed-runner-admin.controller.ts`), behind JwtAuthGuard, the managed switch and AdminRoleGuard in that order, and refused to a personal access token. Off, it answers `404 MANAGED_RUNNER_DISABLED` before the role or the body is read, as the owner's writes do. The body names the restored claim by the UID the administrator verified, the mapping's `revision`, a `reason` for the audit row and an `idempotencyKey`, and `confirmReplacement` unless the manager found the old volume missing itself. The other ways the task allowed were weighed. An owner can neither make nor check a claim. An operator's ConfigMap or annotation would carry no identity Orbit could put in the audit row, and its refusal would have to be read back from somewhere; the call answers at once with the check that failed. |
| Which volume | Only the claim under the runner's own fixed name, `mr-data-<runner uuid>`, in the managed namespace. The names, the Pod template, the mapping's CHECK on its names and the admission guard stay as they are. A claim under a managed name is one no Pod but the runner's own may use from the moment it exists, so nothing can have mounted the restore before the switch, and nothing but the reserved generation can after it. A claim of another name could have been used by any Pod until the switch, and the manager, which may not list Pods, could not have shown none did. This design calls a claim found under the name with a different UID a conflict for review: the switch is that review's outcome, made explicit. |
| The checks | Under the mapping's lease, with a holder of its own (`switchVolume` in `managed-runner-manager.ts`; the Kubernetes reads are `readReplacement` and `recordedVolumeHolders` in `kubernetes-backend.ts`). Each refuses the switch, nothing switched or recorded, with a code, a sentence and the operator's detail. The mapping is `SLEEPING` or `FAILED`, not deleted, with no resource operation in flight and a volume recorded, and either `FAILED` `PVC_MISSING` or confirmed (`managed-runner-volume-switch.ts`). An instance still recorded needs the gate's own stop proof (`stopProofFor`) and its object gone. The claim is the one named and not the recorded one, not being deleted, and bound. It carries the marks every pass checks (`pvcIdentityProblem`: owner and runner annotations, no owner reference, the storage class, `ReadWriteOnce`, `Filesystem`), and its PV is bound to it (`pvIdentityProblem`). No other mapping records its UID, its PV's UID or the handle, and its PV was not made before it, as a retained PV rebound by hand would be. Nothing attaches it, and no Pod is under the runner's name. No attachment holds the recorded PV, found by its recorded UID or handle (one whose PV cannot be read counts). The admission guard refuses a probe of the runner's template on it. |
| The switch | One transaction (`commitSwitch`). The mapping is written by a compare-and-set on the revision, the switch's lease, the state, the generation and the recorded Pod: the new claim UID, PV UID and handle, `SLEEPING`, its reason, attempts and drain fields cleared. The desired state is kept, so demand that waited wakes the runner at once. An instance still recorded is retired there on its proof, as a sleep retires one: generation + 1, the credential nobody may hold any more replaced, the proof marked retired, its compute given back. The storage share stays, for a volume of the same size. |
| Audit | One `activity` row in the same transaction, type `managed_runner.volume_switched`: the administrator (`actor_id`), the time, the mapping, owner, runner, backend, cluster and namespace, the generation, the state, desire and reason before, `from` and `to` (claim UID, PV UID, handle, and the new PV's name), the instance retired if any, the confirmation, the reason given and the idempotency key. The same key again is answered from the mapping, with nothing written. No migration: the activity feed is append-only with no foreign key, and is where the other administrator actions are recorded (`user.disabled`, `user.impersonated`). |
| What stays as it was | The single-writer gate, its stop proofs and fencing, the admission guard's rules and the capacity rules. After a switch they read the new claim as they read the old one. The next wake is the reserved generation's Pod, admitted for the new claim's UID. Its next sleep's stop proof names the new claim and handle, and a Pod gone without a report fences. The old PV and RBD image, where they still exist, are no longer Orbit's: a storage operator purges them under the retention policy. |
| Docker | No switch (`NOT_APPLICABLE`). The Docker runbook's restore (`volume-backup.sh`) gives the volume back its recorded identity, and a `PVC_MISSING` runner is retried once it is back (`PVC_RESTORED`, D7). |
| Clients and census | No client changed: after a switch the runner is `SLEEPING`, a state every client shows, and no owner reason or fixture state was added. The route has a path parameter, so the tenant isolation census lists it, by hand (`TENANT_ISOLATION_BY_HAND`): the census server runs with managed runners off, where every caller is answered 404. The reading cites the guard, the lookups and the pg spec that sends the route. |

Verified on 2026-10-18 ([evidence](evidence/managed-runner-volume-switch/2026-10-18/README.md), [the lab page](managed-runner-lab.md#a-restored-volume-back-under-its-runner-t08b)):

- `managed-runner-volume-switch.pg.spec.ts`, on the fake cluster with the admission guard and a real PostgreSQL, the route
  sent over HTTP:
  - (1) A volume lost while asleep fails its wake, `PVC_MISSING`. Thirteen switches that cannot be verified are refused,
    each with its check, and nothing is switched or recorded in the database or the cluster: no volume; another account's
    marks; storage another mapping records; a PV made before its claim; one not bound; one attached; one a Pod admitted
    before the guard uses; a Pod under the runner's name; the recorded PV attached; another UID; a moved revision; no
    guard; another manager's lease. So are a stranger (401), a member (403), an unknown runner (404) and malformed
    requests (400). The restored claim is switched to with one audit row. The waiting wake starts the reserved generation
    on it, its Pod admitted for the new claim's UID, no claim created. A replay, even while a pass holds the lease,
    writes nothing.
  - (2) After the switch, the guard refuses another Pod on the new claim, and the next sleep's stop proof names it. A Pod
    gone without a report fences, and the switch then refuses the runner.
  - (3) A disabled account's sleeping runner whose volume is replaced: refused while the recorded claim is under the name
    and without the confirmation; switched with it; asleep while work waits; woken on the new claim once enabled.
  - (4) A runner that failed `PVC_MISSING` with its stopped Pod recorded is switched on the recorded proof (the generation
    retired, the credential replaced, the compute given back), and starts its next generation on the new claim. One that
    failed with its Pod still running is refused.
  - (5) READY is refused, and a server on Docker answers `NOT_APPLICABLE`.
- Unit specs: `managed-runner-volume-switch.spec.ts` (the state rule, and the Kubernetes reads of the claim and of the
  recorded PV's attachments on the in-memory cluster), `managed-runner-disabled.spec.ts` (off, the route reads nothing),
  `managed-runner-boot.pg.spec.ts` (the production server, off and unavailable) and the census.
- The lab's real k3s, `switch-lab.py` in one run at `eccae61cd` (22 steps, 78 checks, 8 minutes). An account was
  provisioned, wrote data and was backed up off the cluster. Then its claim, PV and RBD image were deleted, and its wake
  failed `PVC_MISSING`. The runbook's restore went into a new claim under the runner's name, which read back byte for byte
  as the backup. A member's switch, another UID and a stale revision were refused; the administrator's switch wrote one
  audit row. The waiting message then woke the runner on the restored claim: the same runner ID, generation 2, a Pod
  admitted for the new claim's UID. The data, `integrity_check`, uploads, worktree, transcripts and the engine's session
  were as backed up, and there was never more than one Pod on the volume.
- Found in the lab and fixed (`eccae61cd`): the same switch sent again right after it was refused `MAPPING_BUSY`. The
  switch kicks the manager, whose wake pass then holds the lease. A replay is now answered from a read.

Left to later work, or not shown here:

- Across nodes: a switch on a cluster of several nodes, with the restored claim attached on another node than the lost one.
- Ceph clients: the manager cannot see them, so that nothing maps the old RBD image is the operator's check
  (`rbd status`), not the switch's. In the lab the old image had been deleted.
- A runner that failed `PVC_MISSING` while fencing, its predecessor's stop unproven, is refused. The manager reads an
  operator's fencing receipt only in `FENCING`, which a failed mapping does not go back to. This was not reached in the lab
  or the specs, and no way out is built for it.
- No client offers the switch: it is the runbook's API call, and the admin pages have no button for it.
- No model: fake-model.py stood in for the owner's DeepSeek key.

## Implementation record: the managed runners' host firewall

Recorded 2026-10-19 for the second phase's task D9. D5 measured that a managed runner reaches every service its host
listens to on an address other than loopback (sshd and rpcbind on the HPC host, through the network's gateway, docker0
and the LAN address), and through the host the LAN behind it. Since every account of a new deployment gets a runner,
open sign-up included, anyone who signs up could probe the deployer's host and network from their runner. The account
owner decided on 2026-10-19 (ask_owner 34hXDEryfBDt3Dq5b95wD) that a fresh install adds host firewall rules by default:
the managed runners' network reaches the Orbit service port and the internet, and every other port of the host and
the private ranges are refused; Docker and host restarts apply them again; the deployer can turn them off; upgrading an
existing deployment changes nothing. The owner accepted the cost: the install changes the deployer's host firewall,
and hosts with nftables only, rootless Docker or a cloud firewall may need manual work. The operator's side is in
[the operations runbook](managed-runner-docker-operations.md#the-managed-runners-firewall) and
[self-hosting](self-hosting.md#isolation-and-its-limits); the program is
[deploy/managed-runner/firewall](../deploy/managed-runner/firewall/README.md).

| Area | As implemented, and why |
| --- | --- |
| How the rules are kept: a Compose service | `managed-runner-firewall`, built from `deploy/managed-runner/firewall` (Python's standard library and the iptables binaries), run with the host's network, `NET_ADMIN` and `NET_RAW`, every other capability dropped, a read-only root, `no-new-privileges` and no Docker socket. It writes the rules, checks them every 10 seconds and writes again what changed, and Docker restarts it with the stack (`restart: unless-stopped`) after its own restart and after a host's. A systemd unit was weighed and not taken: the install needs only Docker access today, never root on the host or systemd, and a unit would need both, would live outside the checkout or name its path, and would not come and go with the stack. The service's costs are one more resident container with the host's network, and the seconds after a host restart before it has written the rules, which the channel's gate below closes. |
| Its own profile | `managed-runner-firewall`, beside `managed-runners-docker` in `COMPOSE_PROFILES`. Under the Docker backend's profile, `--no-managed-runner-firewall` could not leave it off, and `/upgrade --pull-base`, whose full recreate starts every service of every active profile, would have started it on every deployment installed before it. |
| The rules | Two chains, `ORBIT-MR-INPUT` and `ORBIT-MR-FORWARD`, reached from the first rule of `INPUT` and of `DOCKER-USER`, by jumps that match the network's bridge (`-i <bridge>`): nothing else on the host is touched. To the host: the replies of connections made, the gateway's published port at the network's gateway address, DNS to `dnsServers`, the operator's `allow`; everything else is rejected on every address. Through the host: replies, the published port as Docker DNATs it (`--ctstate DNAT --ctorigdst <gateway> --ctorigdstport <port>`: the DNAT target is the gateway's container on the stack's network, a private address), `dnsServers`, `allow`, then IANA's special-purpose IPv4 blocks that are not globally reachable are rejected (10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16 with the metadata address, 127/8, 0/8, 192.0.0/24, 192.0.2/24, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4). Allowed packets `RETURN` to the host's own rules and rejected ones get `icmp-admin-prohibited`, so the rules only ever take reachability away, and a refused connection fails at once (`EHOSTUNREACH`) instead of hanging. Each write is one `iptables-restore --noflush` transaction: declaring a chain empties it, the old jumps go and the new ones go first, all or nothing in both backends. |
| Userland proxy on and off | On Docker 29 a runner's connection to the gateway address and port 2086 is DNATed in both cases (the nat `DOCKER` chain has no exception for other bridges), so it is `FORWARD` traffic either way. Docker before 28 skips the DNAT for traffic from a bridge when the proxy is on, and `docker-proxy` answers through `INPUT`: the `INPUT` rule for the gateway address and port covers that. |
| IPv6 | The network is created IPv4-only (`--ipv6=false`, whatever Docker's `default-network-opts` say), and the install refuses one with IPv6 on. Docker 29 also turns IPv6 off on a container's interface on an IPv4-only network (measured: `disable_ipv6` 1 on `eth0`). As defence in depth, everything IPv6 from the bridge is rejected too (`ip6tables`, the same two chains, through `DOCKER-USER` where Docker manages ip6tables and `FORWARD` where it does not). A kernel without IPv6 gets IPv4 rules alone. |
| DNS | Docker's embedded resolver forwards a runner's queries to the host's own resolvers from the host's namespace (`# ExtServers: [host(192.168.1.254)]`), which no rule here sees: DNS works with the private ranges refused. Servers that Docker's `dns` setting or `--dns` names are reached from the container's own namespace instead (measured on Docker 29.8.2: the query left from the container's address), and the HPC host's resolver, 192.168.1.254, is private. So the install reads those servers from a container on the network (`docker-dns`), writes them into `dnsServers`, and checks that a name resolves after the rules if it did before. |
| The gate in the Docker channel | Where `firewall/config.json` is beside `channel.json`, the channel creates or starts a runner container only while `firewall/status.json` says the rules are in force: `"enforced"`, within `validUntil` (three check intervals), with this boot's ID, and for the bridge and gateway the configured network has now (Docker's view, so a network made again with another bridge is caught). Otherwise `503 FIREWALL_NOT_ENFORCED` with the reason, before anything is made. The manager first took that as a transient failure, and on the isolated host four refusals and the next stop failed a runner (`POD_TERMINATED`, five of five): it now waits on it as on `CONTAINER_LIMIT` (`ManagedFirewallNotEnforced`, `waitForRoom`): nothing made or spent, asked again every `capacityRetrySeconds`, said once, and the runner starts by itself once the firewall is back. The service writes `"starting"` before anything else, so a status a killed run left is not believed, and `"stopped"` when it stops. The channel is the place for it because it is the one process that starts runner containers and the one that can see the network's bridge; the apiserver only learns to wait on its refusal. Without the gate, a runner started in the seconds before the service writes the rules at boot, or while it cannot write them, would run unprotected. |
| iptables backends | The service uses the backend whose filter table holds Docker's `DOCKER-USER`, jumped to from `FORWARD`. It reads the legacy backend only where legacy tables exist, because reading it would make them, and it refuses when both or neither hold Docker's chains: Docker's nftables backend, `"iptables": false` or rootless Docker. The legacy backend replaces a whole table at a time and must share the host's `/run/xtables.lock` with Docker's own calls: the install names it in `.env` (`ORBIT_MANAGED_RUNNER_FIREWALL_XTABLES_LOCK`) on such a host, and Compose binds it with `create_host_path: false`, since a directory made in its place would break the host's iptables. The nft backend takes no lock and gets `/dev/null`. |
| A safe failure at install | Before anything is written: rootless Docker and Docker's nftables backend are refused from `docker info`, and the program's preflight tries every match and target the rules use in a scratch chain no packet reaches, then removes it. Once the network exists, its IPv6 is checked and the rules are applied once from `config.json.new`. From a container on the network, the gateway on a closed port, the metadata address and a 10/8 address must be refused by a firewall (`EHOSTUNREACH`, not a timeout or `ECONNREFUSED`), and DNS must still resolve if it did before. Only then does `config.json` take its place, which is what arms the channel's gate. Once the stack is up, the gateway's port must be reached from the network. Each failure stops the install with the reason and the way out: fix it, or `--no-managed-runner-firewall`. |
| Turning it off | `--no-managed-runner-firewall` (with a fresh install or `--enable-managed-runners`) leaves the host's firewall alone. `COMPOSE_PROFILES` then names the Docker backend's profile alone, `.env` carries a note that the firewall is off, and the install warns as it starts and as it ends. Later, the runbook turns it off: the service removed, `config.json` moved aside (the channel stops waiting) and the profile taken out of `.env`. `remove` takes the rules off; until then they stay. `--enable-managed-runner-firewall` adds it to a deployment that has managed runners without it. |
| Existing deployments | `/upgrade` never builds, starts or recreates the service. The `.claude` copy's `--pull-base` recreate leaves it out by name, and the `.agents` copy names its services already. So a deployment without the firewall gets no rule, and one with it keeps its rules and its service's image as they are. `--enable-managed-runners` firewalls the managed runners it switches on, unless told not to. |
| Untouched | `deploy/managed-runner/image` (T03's) and the Kubernetes templates. The apiserver changes only to wait on `FIREWALL_NOT_ENFORCED` (above); the clients show its message as they show every reason's. |

Verified on 2026-10-19 in an isolated Docker host on the HPC machine (`docker:29.8.2-dind`, its own network namespace and
iptables, capped, outside the runner's cgroup; Docker 29.8.2, kernel 6.12.107, iptables 1.8.13), every result read
from inside a managed runner container ([evidence](evidence/managed-runner-docker-firewall/2026-10-19/README.md)). The
HPC host's own firewall, network and Docker were not touched.

- **Before** (the project line at 20eaa14b7, a fresh install): a runner reached the test host's services on every
  address, the HPC host's sshd at its LAN address and at docker0, and a model endpoint on a private network behind the
  host, as D5 found.
- **`/upgrade` to this change**: no rule, no service, no file appeared, and `.env` was unchanged. The same held for a
  deployment installed without managed runners.
- **`--enable-managed-runner-firewall`** (the deployment with managed runners) and **`--enable-managed-runners`** (the
  one without): the rules appeared. The same runner container was refused every port of the host and every private and
  link-local address, the metadata address among them, and kept the gateway's port, DNS and public HTTPS.
  - A session on a model endpoint behind the host failed with `EHOSTUNREACH`. Allowed by one `allow` entry, it was
    answered.
- **A fresh install**: the same, with its preflight before anything was written and its checks from the network.
  - **dockerd restarted:** the rules never left the host.
  - **The host restarted:** a new network namespace with no rule; the service wrote them again, and the runner's next
    generation was created 19 s after that. In no sample did a runner container run without the rules.
  - **The userland proxy off and on:** the same results. On Docker 29 the gateway is reached through Docker's DNAT
    either way: the `FORWARD` rule counted it, the `INPUT` rule did not.
  - **`/upgrade` of the firewalled deployment:** the same firewall container, byte-identical rules and configuration.
- **The gate**: with the firewall service stopped (its rules left in place), a woken runner got no container until it
  was back. At first the refusals spent the runner's attempts, and the next stop failed it (`POD_TERMINATED`); since
  74f2c0ec5 it waits (`FIREWALL_NOT_ENFORCED`, attempt 0, asked every 60 s) and starts by itself.
- **`--no-managed-runner-firewall`**: warnings at both ends of the install, the note in `.env`, no rule, and the runner
  reaches what D5 measured.
- **The legacy iptables backend**: detected, `.env` names `/run/xtables.lock`, the service mounts it, the rules go into
  the legacy tables of both families, and the runner is refused as on nft.

Left to later work, or not shown here:

- Docker before 28 (the userland proxy through `INPUT`), firewalld and ufw hosts, SELinux, rootless Docker and Docker's
  nftables backend were not run live; the install's refusal of the last two is unit-tested.
- The kernel's boot ID did not change on the test host's restarts, so the gate's boot check was not exercised live.
- IPv6 rules were checked present, not exercised with traffic: Docker 29 turns IPv6 off on a runner's interface.
- A connection a runner had open before `--enable-managed-runner-firewall` is not cut; new ones are filtered at once.
- The firewall's image is built at install and never rebuilt by `/upgrade`; a newer firewall program reaches an existing
  deployment only by turning the firewall off and on again (the runbook).

## Implementation record: one runner across two nodes

Recorded 2026-10-19 for task T02, the cross-node part of criterion 2, on the lab's two nodes (task L1: two VMs on one
physical machine, one failure domain, Ceph a single-host cluster in the first). No product code changed: the record is of
what the delivered manager, admission guard and fencing gate did. It was run by `scripts/managed-runner/lab/takeover-lab.py`
through the test server's manager, with its findings
([evidence](evidence/managed-runner-cross-node/2026-10-19/README.md), [the lab page](managed-runner-lab.md#cross-node-migration-and-takeover-t02)).

| Area | What the run established |
| --- | --- |
| Normal move | A runner put to sleep on one node (its kubelet's report recorded as the stop proof, the volume detached, no RBD client left) and woken with that node cordoned started its next generation on the other node. The runner, PVC, PV, volume handle, RBD image and workspace were the same; probe data, uploads, the worktree, transcripts and the engine's session carried over. The manager places nothing: the scheduler does, among the schedulable nodes. |
| A second Pod on another node | While the runner ran on one node, Pods on its claim pinned to the other node were refused by the admission guard, whoever created them and in whatever shape. The refusals were `NOT_THE_MANAGER`, `NOT_THE_FIXED_NAME`, `NOT_RESERVED`, `NOT_THE_RESERVED_GENERATION`, and a Job's Pod refused at its controller's create. The guard decides from the database and never looks at the node. Without it, RWO alone left a second node's Pod `Pending` (the attach/detach controller), a refusal the out-of-service taint deliberately overrides; on one node RWO admits a second Pod outright. RBD alone (`layering`, no `exclusive-lock`) let a second client open and read the image. |
| A node that stops | The node's power cut while its runner wrote. For 420 s the mapping stayed `READY` at its generation with its Pod recorded, and the owner's status said not usable once the heartbeat was stale. No Pod, admission probe or Secret was created, demand waited and the owner's retry was refused. The VolumeAttachment stayed on the dead node, and the taint manager's eviction (`DeletionByTaintManager`) left the Pod `Running`, held by the stop-report finalizer. |
| Failover | The runbook's steps: a `NODE_POWER_OFF` receipt bound to the predecessor, the out-of-service taint, the finalizer taken off. PodGC made the Pod `Failed` and the attachment was force-deleted. The manager went `FENCING` on a Pod terminal by the control plane's word, replacing the predecessor's credential, then accepted the receipt as the stop proof and started the next generation on the other node. Every SQLite row acknowledged before the cut was there after WAL recovery, `integrity_check` ok, fsynced files as before. |
| The old node's return | Under the taint it mapped and mounted nothing of the volume and ran nothing of the old Pod. Its kubelet could not reach the CSI driver, whose node plugin the taint evicts. The old generation's credential was refused 401, and an instance naming it 403 `MANAGED_RUNNER_INSTANCE_SUPERSEDED`. With the taint removed the node rejoined, and the volume stayed with the new generation. |

Found, and left to later work (reported to the coordinator):

- **For an unreachable node, the manager does not persist `FENCING`** until the operator's out-of-service taint lets
  PodGC make the Pod terminal: the mapping stays `READY`, and the predecessor's credential valid, until then. The
  coordinator decided on 2026-10-19 to keep this behavior. "Single Pod and single writer protection" above now
  describes it, with the reasons. T08x saw it again with two runners on the stopped node
  ([its record](#implementation-record-two-accounts-across-two-nodes)).
- **Work a node had not made durable when it lost power can be lost**, and a repository with it.
  - Git fsyncs neither loose objects nor refs by default. ext4 allocates delayed blocks at writeback, and a rename is
    durable only at the next journal commit.
  - A commit 14 s before the cut came back as zero-length files.
  - With `core.fsync=committed,index`, a commit 1.5 s before a cut kept its objects but lost `HEAD` and its branch ref.
  - The runner's workspace and worktrees are such repositories. Making the Git work that must survive durable (for
    example syncing the volume after it), or repairing a repository at the next start, is the image's and the runner's.
  - **Handled by T02c** (2026-10-19): a managed runner syncs its volume before it reports work and behind every tool an
    engine runs, and looks at its repositories when it starts. The approach, what it covers and what it costs:
    [Git work and engine sessions through a power cut](#implementation-record-git-work-and-engine-sessions-through-a-power-cut).
- Not established: a partition that keeps the old node running, a storage fence as the receipt's method, two managers,
  failover across physical machines, a real model.

## Implementation record: two accounts across two nodes

Recorded 2026-10-19 for task T08x, the cross-node part of criterion 8, on the lab's two nodes (task L1: two VMs on one
physical machine, one failure domain, Ceph a single-host cluster in the first). No product code changed: the record is of
what the delivered manager, admission guard and fencing gate did for two accounts at once, and of the runbook as it was
followed. It was run by `scripts/managed-runner/lab/cross-node-lab.py` through the test server's manager
([evidence](evidence/managed-runner-cross-node-accounts/2026-10-19/README.md), [the lab page](managed-runner-lab.md#two-accounts-across-two-nodes-t08x)).

| Area | What the run established |
| --- | --- |
| Normal move, two accounts | Both runners put to sleep on one node and woken on the other, one by a message and one by a task run now: each the same runner, PVC, PV, volume handle, RBD image and workspace, with its probe data, uploads, worktree, transcripts and engine session. Both again by `kubectl drain` of either node: the next generations on the other node, with their data and sessions. |
| Second Pods on another node | For each account the shapes T02 tried, and Pods mixing the two accounts' runners and claims (`NOT_THE_FIXED_NAME`, `NOT_THE_OWNER`, `MULTIPLE_MANAGED_CLAIMS`), were refused while the runners ran. So were Pods made while the node was lost and the volumes still attached to it, the next generation's under the fixed name among them (`NOT_THE_RESERVED_GENERATION`): the guard reserves nothing a receipt has not opened. |
| A node that stops with two runners | Both mappings stayed `READY` at their generation for 420 s: no Pod, admission probe or Secret was created, demand waited and retries were refused. This is the behavior "Single Pod and single writer protection" now describes. |
| Failover | The runbook's query and commands, two receipts, one out-of-service taint, two finalizer patches. One Pod's finalizer came off right after the taint and the other's once its mapping was `FENCING`. The manager fenced on the Pod object's removal (`gone without a stop proof`) for the one and on PodGC's `Failed` (`not by its kubelet's report`) for the other, accepted each receipt as its stop proof and started both next generations on the other node. Every SQLite row each writer acknowledged was there, `integrity_check` ok, Git commits made more than a minute before the cut intact. |
| The old node's return | Under the taint it mapped nothing of either volume and ran nothing of either old Pod; both old generations' credentials were refused. |

Found (reported to the coordinator):

- **The engine's transcript loses what was not written back.** Claude Code does not fsync its transcript on the volume.
  - A turn answered 20 s before the power cut was missing after the takeover, and the session went on without it.
    Orbit's server kept its events.
  - A volume synced in the runner container just before the cut kept its last turn.
  - Like Git work (T02's finding), this is data the image or the runner would have to make durable. It belongs with T02c.
  - **Handled by T02c** (2026-10-19): the volume is synced before the runner reports a turn's end, so a turn the control
    plane has heard is over is in the transcript the next generation resumes
    ([the record](#implementation-record-git-work-and-engine-sessions-through-a-power-cut)).
- **The planned move needs `kubectl drain --delete-emptydir-data --force`**, for a bare Pod with an emptyDir. A drain
  ends only when a manager records each evicted runner's stop. A managed Pod no running manager records holds the drain
  until its timeout: here, an earlier task's Pod, which the drain marked for deletion. The runbook now says so.
- Not established: a real model, a partition, a storage fence, the failure of the node that runs the control plane, two
  managers, failover across physical machines.

## Implementation record: Git work and engine sessions through a power cut

Recorded 2026-10-19 for task T02c, part of criterion 2. It handles T02's finding 2 and T08x's finding about the engine's
transcript ([above](#implementation-record-one-runner-across-two-nodes)). The lab runs were on the lab's two nodes
(task L1: two VMs on one physical machine, one failure domain, Ceph a single-host cluster in the first)
([evidence](evidence/managed-runner-power-cut-durability/2026-10-19/README.md),
[the lab page](managed-runner-lab.md#git-work-and-engine-sessions-through-a-power-cut-t02c)).

**What a managed runner does.** The code is in `src/runner-go/volume_durability.go` and `managed_repo_recovery.go`.

| Where | What |
| --- | --- |
| Before a report | The runner syncs the volume (`syncfs`, its filesystem only) before it reports work that lives on it. That covers a turn's end (a failed turn's too), a session's end (after its finalize commit), the session's checkout (before its engine starts), a commit, a merge, a checkout cleanup and an integration job's result (after its spooled copy). A report waits at most 30 s for the sync, then goes on and logs it. |
| Behind every tool | After every tool result an engine reports, a sync runs in the background, one at a time; a result during one runs one more after it. The engine is not held up. Claude Code, Codex, Kimi, OpenCode, Antigravity, Cursor and DeepSeek Harness all report tool results through the session's one emitter. |
| At start | Before anything runs Git, the runner looks at the checkouts under `reposRoot` and the sessions' worktrees. Lock files no process holds are removed, and a branch left empty or missing is restored from its own reflog. Anything else that cannot be read is logged, and every session that would work there is refused: `REPOSITORY_DAMAGED` with the reason, its session `FAILED`. setupWorktree's fallbacks used to run such a session in the workDir without a checkout, or start a new repository over the broken one. |
| Who | A managed instance only: `ORBIT_MANAGED_RUNNER_GENERATION` and `ORBIT_MANAGED_RUNNER_POD_UID` set. A self-managed runner does none of this. |

**Which Git writes are covered.** A `syncfs` writes back everything dirty on the volume and commits its journal. At
each point above, that covers all of these:

- loose objects, packs and their indexes;
- refs and `packed-refs`, `HEAD` (as `git init`, `git worktree add` and a checkout write it) and the index;
- reflogs, config and worktree metadata (`gitdir`, `commondir`, the worktree's `.git` file);
- the checked-out files, the engine's transcripts and session files, and the runner's own records.

Git's own setting covers much less. Traced with strace for Git 2.47.3, the image's
([kit/git-fsync-coverage.py](evidence/managed-runner-power-cut-durability/2026-10-19/kit/git-fsync-coverage.py)):

- `core.fsync=all` fsyncs loose objects, refs, `packed-refs` and the index before they are put in place.
- It never fsyncs `HEAD`, a worktree's `HEAD` or metadata, reflogs, config or checked-out files.
- It leaves a command's last rename (its ref, often its index) to the next journal commit. In the trace, 10 of 15 ref
  writes and 4 of 11 index writes were not durable when the command returned.
- `git init` made no fsync at all.

**Why not Git's own fsyncs.** On top of those gaps, they cost one device round trip per file. These are medians of
`git add` and `git commit` in a fresh repository
([kit/git-commit-timing.py](evidence/managed-runner-power-cut-durability/2026-10-19/kit/git-commit-timing.py)):

| Storage | Commit | Git's defaults | defaults, then `syncfs` | `core.fsync=all` | `core.fsync=all`, `fsyncMethod=batch` |
| --- | --- | --- | --- | --- | --- |
| Lab: the runner class's ext4 on RBD, second node | 1 file | 49 ms | 299 ms | 893 ms | 1103 ms |
| | 200 files | 162 ms | 1.04 s | 59.2 s | 19.1 s |
| HPC host: ext4 on HDD | 1 file | 7 ms | 71 ms | 109 ms | 228 ms |
| | 200 files | 22 ms | 129 ms | 4.71 s | 192 ms |
| HPC host: ext4 on NVMe | 1 file | 4 ms | 15 ms | 25 ms | 26 ms |
| | 200 files | 19 ms | 26 ms | 560 ms | 45 ms |

- On the lab's volume (`data=ordered`, `commit=5`, three OSDs on one HDD), Git's fsyncs made a one-file commit 18 times
  slower and a 200-file commit 365 times slower. The same commit followed by one `syncfs` took a third of that time for
  one file and a fiftieth for 200, and also covers what Git leaves out.
- `batch` writes each object through and waits for it, so on high-latency storage it gains little. Git does not document
  it as safe on Linux.
- A `syncfs` with nothing dirty took 0.1 ms on the lab's volume. After 1 MiB written it took 0.78 s, after 64 MiB 5.3 s.

**Commit time before and after.**

| What | Before (project line) | After |
| --- | --- | --- |
| An engine's own `git commit` | 49 ms / 162 ms (1 / 200 files, lab) | Unchanged: nothing is added to the engine's commands. A sync runs beside the engine after the tool's result, about 0.25 s / 0.9 s of background writeback on the lab's volume, 0.1 ms when the tool wrote nothing. |
| The runner's own commit, merge, checkout | The commit alone | The commit, then one `syncfs` before the report: 299 ms / 1.04 s on the lab's volume (lab kit). End to end in the lab runs, from asking to the report: commit 0.78 → 2.03 s, merge 1.51 → 2.26 s, a new session's first engine commit 1.47 → 2.27 s (one sample each). |
| A turn's end | No sync | One `syncfs` before `/turn-complete`: mostly already written by the syncs behind the tools. In the lab runs, a FAKE-WRITE turn from send to answered took 1.51 → 2.26 s. |

**Self-managed runners.** They are unchanged. Their filesystem is their owner's, shared with everything else they run,
where a `syncfs` writes back all of it. The HDD host above took 350 ms for one after 64 MiB written, and a build's output
can be much more. Whether to pay that is the owner's call, not the runner's.

**What the lab showed** ([evidence](evidence/managed-runner-power-cut-durability/2026-10-19/README.md)). The setup:

- One account's runner on the second node, with three sessions.
- In the last seconds, each run made five Git writes:
  - a new session's checkout and an engine commit in a turn still running (s3, `FAKE-HOLD`);
  - a runner commit and a runner merge into the workspace's `master` (s2);
  - an engine commit (`FAKE-WRITE`) in a last turn that then ended (s1).
- Then the second node's power was cut, and a copy of the volume's snapshot was read before anything mounted the volume
  again. The runbook's failover followed, and the session was resumed.

| | Before: the project line's runner (`8055bb568`, amy) | After: this change (`0e894464e`, bob) |
| --- | --- | --- |
| Seconds before the cut | Runner merge and last answer 0.0; engine commit 0.4; runner commit 1.5; s3's engine commit 2.3 | 0.0; 0.9; 2.3; 4.3 |
| The repositories | All four unreadable. `master` and both session branches point at commits whose object files are empty (9 empty loose objects); s3's new worktree has an empty `HEAD`, `gitdir` and `commondir`; `git fsck` exit 11 | All four read; `git fsck` clean; no empty file, no lock |
| Commits that had returned | The engine's last commit, the runner's commit and its merge: unreadable | All on their branches; s3's mid-turn commit too |
| The engine's transcript | The last turn gone (0 of its lines); s3's transcript 0 bytes | The last turn there, its message and its final answer |
| The resumed session | Resumed without the last turn (8 messages, the first turn's secret only), in repositories that still failed `fsck` | Resumed with it (14 messages, both secrets) |
| The next start | (no check) | `volume check: 4 checkouts in 1 repositories after start; 0 stale lock files removed, 0 branches restored, 0 checkouts damaged` |

The before run's damaged volume was then woken on this change's final build (`5928c0e0a`):

- The runner's start logged each of the four repositories with its reason.
- It refused the reclaimed sessions. The next message's session ended `FAILED` with
  `REPOSITORY_DAMAGED: the Git repository at …/orbit-repos/default cannot be read: commit 22957bc…, where its branch
  master points, cannot be read. The runner does not work in a damaged repository or start a new one over it: …`.
- No engine was asked about that message, and nothing was started over the broken repository.

The first wake, on `0e894464e`, refused the reclaimed session and then answered its next message anyway: the claim's
payload dropped the refusal. `5928c0e0a` carries it over (`sessionPool.activatePrepared`), and a unit test covers it.

**Limits.**

- Work a tool did is durable a sync's time after the tool returns: 0.3–1 s on the lab's volume. A cut inside that
  window can still leave what T02 found, and the next start then restores a broken branch or refuses the repository with
  its reason. Here s3's commit, 4.3 s before the cut, was kept.
- The Docker backend's volume is a directory of the host's filesystem, so a `syncfs` there writes back everything dirty
  on that filesystem, other runners' data included. This was measured on the host's own disks above, not on a busy
  Docker host.
- No real model, one physical machine, the lab's slow storage. A real cluster's latencies differ, and so do the costs
  above.

## Implementation record: volume syncs on a shared Docker host

Recorded 2026-10-20 for the second phase's task D10, part of criterion 12. T02c ([above](#implementation-record-git-work-and-engine-sessions-through-a-power-cut))
has a managed runner `syncfs` its volume before every report and, in the background, behind every tool an engine runs.
A Kubernetes volume on RBD is an ext4 of its own, so there the sync writes back the runner's own data. A Docker local
volume is a directory of the Docker host's filesystem: the sync writes back everything dirty on it, the other runners'
volumes and the deployment's Postgres (`./data/postgres`) among it. New deployments run the Docker backend and give
every account a runner, so the cost was measured with up to eight runners at work on one Docker host
([evidence](evidence/managed-runner-docker-volume-sync/2026-10-20/README.md)). The operator's side is in
[the Docker runbook](managed-runner-docker-operations.md#volume-syncs-and-the-hosts-disk).

**How it was measured.**

- **Host.** An isolated Docker host on the HPC machine (`docker:29.8.2-dind`, capped, outside the runner's cgroup). Its
  Docker data root and its deployment's checkout share one spinning disk, as on a default host whose `/var/lib/docker`
  and checkout share its disk. A default install (`scripts/install-server.sh`), with runners of 1 CPU and 1 GiB so that
  eight fit.
- **Load.** 1, 4 and 8 runners, each running fake-model.py's tool loop turn after turn: three cycles of an edit, a
  `git commit` and a build that writes 400 files (about 4 MB), then one more edit, which the runner itself commits once
  the turn is answered. Each round's 120 s window had:
  - every `syncfs` traced (an ftrace instance on the HPC host);
  - the disk, IO pressure and the containers' cgroups sampled every second;
  - the API probed as an account (8 requests a second through the gateway: three reads and a rename);
  - Postgres probed by pgbench (one-row commits and reads).
- **Control.** The same load on the runner from just before T02c (`326f43dc0`): an image that differs from T02c's only in
  the runner binary.
- **Patterns.** First with every runner in step: all start at once and every model step takes 2 s, so their syncs come
  in bursts. Then staggered: random starts and steps of 1 to 3 s, as different people's sessions are. The staggered
  rounds are the comparison; the rounds in step are the worst case of bursts. The rounds of a kind are pooled.

**The bound.** For the Docker backend, against the same load without volume syncs, at each runner count measured:

| What | At most | Why |
| --- | --- | --- |
| The API's p99 as an account sees it (its runner's status, a session, the session list, a rename) | 25% over, or 10 ms | Every account's clients and runners share the apiserver, while a runner's syncs make only that runner's work durable. What one account's durability costs the others has to stay small. |
| Postgres's commit p99 (a one-row `INSERT`) | 50% over, or 10 ms | Every API write waits for a commit, and a commit waits for the WAL's flush on the shared disk: the first thing a sync on that disk slows. A request's own work dilutes it, so it may move more than the API's p99. |
| Postgres's IO pressure (the share of time its tasks wait on IO) | 5 points over | The database's own stall, whatever the probes happen to ask. |
| The runner's own commit, from asking to done (p50) | 1 s over | Its owner pays this for the durability of what the runner reports to them. |

The bound was set after the first comparison of T02c with the control and before the change below was measured. It is
relative to the control: a spinning disk's absolute latencies say little of an SSD host's.

**The conclusion.** Pooled over the rounds of a kind. The rounds ran beside other sessions' work on the HPC host, and in
a third of them outside memory pressure made the test host read back more than 100 MB of evicted page cache from the
disk, which slowed every build alike; "undisturbed" leaves those rounds out. Both views are in the evidence.

- **T02c's syncs exceed the bound at 8 runners in every view.**
  - Staggered: Postgres's commit p99 759 ms against 400 with all rounds, 224 against 59 undisturbed; the API's p99 225
    against 137, and 127 against 52.
  - In step: 676 against 172 and 273 against 107, and the runner's own commit took 4.0 s at the median against 0.86.
  - At 4 runners they exceed it with all rounds (341 against 115 ms in step, 431 against 156 staggered), though not in
    the one staggered round without outside pressure. With one runner they stay within it.
- **So on the Docker backend the runner now syncs before its reports only** (below).
- **With that change, 1 and 4 runners are within the bound in every view.** At 4 runners staggered: the API's p99 54 ms
  against 49, Postgres's commit p99 93 against 156, its IO pressure 2.5% against 2.7%, the runner's commit 773 ms
  against 679.
- **At 8 runners at work at once on one spinning disk, the syncs before reports still exceed it in every view but
  one.**
  - Staggered and undisturbed: Postgres's commit p99 184 ms against 59, the API's p99 95 against 52.
  - Without the runner's commits, one sync per turn: 237 against 55, and 129 against 46.
  - With all rounds the change looks within (314 against 400). That is the control's own round under memory pressure,
    with 904 MiB left on the HPC host, lifting the control's tail.
  - Every Postgres commit over 100 ms in the undisturbed rounds ran while one of those syncs did (51 of 51, and 64 of 68
    without runner commits). In the control's undisturbed rounds one commit in all took that long.
  - That is the guarantee's own cost. Each sync before a report writes back every runner's unwritten data on the disk,
    and it is what keeps a reported commit and an answered turn through a power cut.
- **The Docker backend's syncs are acceptable where at most four runners at work share a spinning disk with
  Postgres.**
  - The default profile (2 CPUs and 4 GiB a runner, a quarter of the host kept back) admits four runners on a host of
    about 11 CPUs and 22 GiB, eight on one of about 22 CPUs and 43 GiB.
  - A host that admits more runners than that, on spinning disks, wants Postgres on another disk than Docker's data
    root, an SSD, or a lower `limits.maxContainers` ([the runbook](managed-runner-docker-operations.md#volume-syncs-and-the-hosts-disk)).

**What changed, on the Docker backend only** (`src/runner-go/volume_durability.go`, `volume_shared_linux.go`):

| Where | What |
| --- | --- |
| Which volume | At start the runner reads, from `/proc/self/mountinfo`, the mount that holds `ORBIT_HOME`. Its fourth field, the mount's root inside its filesystem, is `/` for a volume that is a filesystem of its own (an RBD volume's ext4), and the volume's directory for a Docker local volume (`/var/lib/docker/volumes/mr-data-…/_data`). A volume whose mount cannot be read counts as one of its own, so T02c's syncs stay. The start logs which: `volume syncs: before reports only; the volume is a directory of /dev/sdb (ext4), which it shares, …` or `… before reports and behind every tool; the volume is /dev/rbd0 (ext4), a filesystem of its own`. |
| Before a report | Unchanged on both backends: a turn's end, a session's end, a checkout, a commit, a merge, a landing, a cleanup and the volume check each wait for a `syncfs` first. |
| Behind every tool | Only on a volume that is a filesystem of its own. On a shared one the nudge does nothing. |
| Kubernetes | Unchanged: an RBD volume is the root of its own ext4, so the runner keeps every one of T02c's syncs. T02c's power cut after-run, done again on the lab's two nodes with this change ([evidence](evidence/managed-runner-docker-volume-sync/2026-10-20/README.md#kubernetes-unchanged-t02cs-power-cut-after-the-fix-on-this-change)): the runner logged `volume syncs: before reports and behind every tool; the volume is /dev/rbd0 (ext4), a filesystem of its own`. After the cut, every repository read and passed `fsck`, every returned commit and the mid-turn one (3.4 s before the cut) were on their branches, and the session resumed with its last turn: 15 steps, 90 checks, as T02c's after-run did. |
| Self-managed runners | Unchanged: they sync nothing. |

Why these syncs: the ones behind tools were four in five of T02c's (186 a minute at 8 runners in step, the reports'
32), and every report already waits for a sync of its own. Dropping them is what brings 4 runners within the bound. At
8, the syncs before reports exceed it on their own, so no rate limit on the others could have brought 8 within it. A
sync merged across the host's runners would need a channel from every runner container to something on the host,
which the Docker backend's isolation does not give them.

**What it does to durability.**

- **Unchanged:** a commit, merge or checkout the runner has reported and a turn that has been answered are on the disk
  before the control plane hears of them, as T02c made them.
- **Wider:** what a tool writes in the middle of a turn reaches the disk at the next sync on that filesystem, whichever
  runner makes it: this turn's end, a report, or another runner's report. Failing those, the kernel's own writeback
  takes it, data dirty for 30 s (`vm.dirty_expire_centisecs`) at the flusher's next pass and its metadata at ext4's next
  journal commit. Measured from each tool result to the end of the first sync that started after it (staggered):

  | Runners | T02c | This change |
  | --- | --- | --- |
  | 1 | p50 0.04 s, p99 0.14–0.15 s | p50 9.6–11.5 s, p99 26–30 s |
  | 4 | p50 0.04–0.07 s, p99 0.2–0.8 s | p50 3.2–5.4 s, p99 13–22 s |
  | 8 | p50 0.09–0.11 s, p99 0.4–0.8 s | p50 1.5–1.8 s, p99 8–15 s |

- **What a power cut in that window leaves:** a turn still running at the cut can lose its mid-turn work, as T02 found
  before T02c (a commit's files empty). The turn had not been answered. The runner's next start finds it with T02c's
  check: stale locks removed, a broken branch restored from its reflog, anything else refused with its reason. Its
  session is not run in a broken repository.

**Left to later work, or not shown here.**

- Per-runner filesystems on Docker (a volume driver that gives each volume a filesystem of its own) would make a sync
  the runner's own again. The runner would see it from its mount and keep T02c's syncs behind tools by itself.
- Postgres on another disk than Docker's data root, an SSD Docker host, and the kernel's writeback settings were not
  measured.
- No power was cut on Docker: a test host inside the HPC host shares its kernel, and so its page cache. The window above
  is computed from the traced syncs, not observed through a cut.
- fake-model.py stands in for a model: its steps are regular and fast. The rounds ran beside other sessions' work on the
  HPC host, whose memory pressure made some rounds re-read their page cache from the disk; each round records that, and
  the comparison pools the rounds of a kind.
