# Optional managed runner image and restore contract

This directory is an independent test delivery. Root Compose, installation, release and upgrade
entry points do not build or start it (`scripts/managed-runner/deployment_boundary_test.py` checks
that). The product default remains disabled. The image starts the foreground `orbit run` protocol in
one of two ways: from the runner credential the manager issued for its Pod's generation (the managed
path), or by one owner enrollment (standalone image smoke). The single-writer protection — the
admission guard, generation-bound runner authentication and the manager's stop/fencing gate — is
described under [Single-writer protection](#single-writer-protection). Fencing a node or Ceph
clients is an infrastructure operator's action; nothing here performs it.

The deployment owner confirmed on 2026-10-04 that no non-production Kubernetes/Ceph test cluster is
available. Do not create a cluster, use the current kubeconfig context, borrow production resources,
or infer permission from available credentials. Local fixtures are preparation evidence only.

## Image and build

[Dockerfile](image/Dockerfile) pins the base images by digest, Go 1.27.1, Node 26.10.0, Codex 0.158.0
and a dated Debian package snapshot. Codex is the first supplied engine; Claude, Kimi, OpenCode and
Antigravity are not installed. Codex uses its native binary with adjacent vendor tools, avoiding a
Node wrapper between Orbit and the engine. The generated `/usr/local/share/orbit/tool-versions.json`
records the source SHA, actual tool versions and installed package versions. That build artifact,
the final image digest and actual test environment must accompany later acceptance evidence.

Build only on an explicitly authorized isolated builder, with a reviewed clean source commit:

```bash
docker --host "$AUTHORIZED_TEST_DOCKER_HOST" build \
  --file deploy/managed-runner/image/Dockerfile \
  --build-arg ORBIT_SOURCE_SHA="$(git rev-parse HEAD)" \
  --tag orbit-managed-runner:test .
```

Use a final image digest in Kubernetes. Do not point this command at the production daemon or mount
its socket in a runner. The file-specific Docker ignore file allowlists only runner/image inputs;
credentials, runtime homes and repository environment files are excluded. Updating the runner or
engine requires draining and replacing the pinned image. Both automatic update loops and automatic
engine installation are disabled; root-owned tools and a read-only root filesystem prevent explicit
update operations from replacing the image tools.

## Persistent paths and identity

Mount one user's entire original ext4 PVC at `/var/lib/orbit`. Paths and UID/GID **10001:10001** must
stay constant across rebuilds and nodes:

| Fixed location | Retained data |
| --- | --- |
| `/var/lib/orbit/home` | Entire user home, runtime histories and configuration. |
| `/var/lib/orbit/home/.orbit/config.json` | Original runner ID, server URL and runner credential. |
| `/var/lib/orbit/home/.orbit/runs` | Session metadata, recovery/lease markers, legacy and isolated engine homes. |
| `/var/lib/orbit/home/.orbit/worktrees` | Linked Git checkouts, alongside the original repository's `.git`. |
| `/var/lib/orbit/home/.orbit/uploads` | Attachment scratch retained until ordinary session-aware GC. |
| `/var/lib/orbit/home/.orbit/codex-state` | Codex SQLite partitions, including database, WAL and SHM. |
| `/var/lib/orbit/home/.codex` | Default Codex auth/configuration, transcripts and sessions. |
| `/var/lib/orbit/home/.claude` | Reserved persistent location if a later image explicitly supplies Claude. |
| `/var/lib/orbit/home/orbit-repos/default` | Stable default workspace directory and original repository. |

The entrypoint fixes `HOME`, `ORBIT_HOME`, `CODEX_HOME` and `CLAUDE_CONFIG_DIR` to these paths. Codex
partitions hash the absolute engine home; Git worktree metadata also embeds absolute paths. Moving
paths or copying only a SQLite database is not a valid restore. Preserve the entire PVC, including
account slots, complete run metadata and original `.git`. `/tmp` is ephemeral.

Initialize with the same image's `init-volume` command. It uses root only for these known directory
ownership/mode changes, has no enrollment or model credentials, and does not recurse through user
files or launch user code. The runtime process then runs as UID 10001 with `umask 077`; the machine
directory is `0700`, and config/identity files are regular non-symlink files at `0600`, satisfying
`configStoragePrivate`. Unexpected owners, retained symlinks and an unmounted state path are refused.
No `fsGroup` is used because its recursive permission changes can widen private credential storage.

### Managed start (the manager's Pod)

The manager creates the runner row before the Pod and issues that row's credential for one
generation into Secret `mr-boot-<runner-uuid>` (keys `token` and `generation`), mounted at
`/run/orbit-bootstrap`. [runner-pod.yaml.example](runner-pod.yaml.example) is exactly the Pod it
creates. With `ORBIT_RUNNER_CREDENTIAL_FILE` set the entrypoint never enrolls; it requires:

- `ORBIT_RUNNER_SERVER_URL`, `ORBIT_RUNNER_NAME`, `ORBIT_RUNNER_MAX_CONCURRENT` as below;
- `ORBIT_RUNNER_EXPECTED_ID`: the runner UUID of the mapping;
- `ORBIT_MANAGED_RUNNER_GENERATION` and `ORBIT_MANAGED_RUNNER_POD_UID`, from the Downward API: the
  Pod's `orbit.dev/generation` annotation and `metadata.uid`;
- a non-empty credential whose Secret `generation` equals the Pod's generation.

It writes the expected runner ID and this generation's credential into `config.json`, refuses a
config or volume of another runner, a volume a later generation (or another Pod of this
generation) has already run on (`managed-instance.json`), and a volume with an uncertain
enrollment. It passes the generation and Pod UID to `orbit run`, which sends both with every
request (`src/runner-go/managed_instance.go`). The next generation's Pod brings its own credential;
only `runnerToken` changes in the retained config.

### Standalone enrollment (image smoke)

Without `ORBIT_RUNNER_CREDENTIAL_FILE`, first start requires all of:

- `ORBIT_RUNNER_SERVER_URL`: the explicitly authorized test Orbit HTTPS server, with no built-in
  hosted-server fallback. HTTP is accepted only for a loopback fake server.
- `ORBIT_RUNNER_NAME`: the user's stable runner name.
- `ORBIT_RUNNER_MAX_CONCURRENT`: the approved positive session concurrency; this is not capacity
  admission or a CPU/memory resource profile.
- `ORBIT_RUNNER_ENROLLMENT_TOKEN_FILE`: a Secret file containing that target user's one-time test
  enrollment token. Tokens are never baked into the image or documentation.

The entrypoint durably records `registration-pending.json`, calls `orbit register --no-service
--no-auto-install-engines` once, validates the saved config and records `container-identity.json`.
It then removes inherited session/bootstrap environment and execs `orbit run`. This preserves the
existing registration ownership checks and recovery protocol, rather than creating new identities.
The enrollment token passes through the existing CLI argument during registration; bootstrap logs
and process inspection belong to the same isolated user's trust boundary.

On rebuild, reuse the original PVC and supply `ORBIT_RUNNER_EXPECTED_ID` from the recorded mapping.
Remove the enrollment Secret mount/reference and environment variable. The saved ID, token and config
bytes are reused without calling register, forcing a registration or unregistering. Malformed or
mismatched config fails closed. A populated repository/runtime home without config also fails; put
file-based engine credentials in place only after first enrollment, or provide an authorized key
through the test environment. Never erase state to make bootstrap pass.

If registration was interrupted before a usable config reached disk, the pending marker prevents
another registration attempt. An operator must inspect the **test** server's registration result and
restore that original credential/config, or establish that the attempt created no runner before
removing the marker. An existing valid config survives loss between registration and marker creation.
The local `flock` prevents duplicate processes on the mounted local filesystem; it is not evidence
of Kubernetes single-writer admission, node cessation or Ceph fencing.

## Optional Kubernetes test template

[runner-pod.yaml.example](runner-pod.yaml.example) is the bare Pod the manager creates for one
generation: `restartPolicy: Never`, an existing per-user PVC, immutable tools, no host
namespaces/sockets, no service-account token and no Kubernetes/Ceph credentials in user processes.
Its init container has only the filesystem capabilities needed for scoped ownership initialization.
It installs no storage backend, PVC, manager or server. All placeholders must be replaced from the
authorized environment record; resource amounts are not deployment defaults. The admission guard
refuses it unless the manager reserved its generation, so it is not applied by hand. A container
`Running` state or a local filesystem lock is not readiness evidence.

Before applying, the coordinator needs the exact context/API identity, namespace/node allowlists,
original PVC/PV/RBD identity, Ceph/CSI/kernel versions, supported access mode, resource profile,
test Orbit server/database, target owner, approved model/credential references, tenant isolation
and verified admission/cessation gates described in [the design](../../docs/managed-runner-design.md).
For this contract, RWO alone does not prevent a second Pod on the same node. This template must wait
for the storage task and manager/admission implementation before being used as a managed deployment.

The test operator explicitly sets `ORBIT_MANAGED_RUNNERS_ENABLED=true` **only on the authorized
isolated test apiserver** when testing managed flows. This runner template does not enable a product
flag, change defaults or install infrastructure. Independently registered image smoke can run with
the server flag absent; that does not validate managed provisioning.

Every Kubernetes command must include both the approved context and namespace:

```bash
kubectl --context "$AUTHORIZED_TEST_CONTEXT" --namespace "$AUTHORIZED_TEST_NAMESPACE" \
  apply --filename "$REVIEWED_RENDERED_TEST_POD"
```

Do not run this until those resources and actions are explicitly authorized. Do not enable rolling
replacement or force-delete a predecessor. Stop claims through SIGTERM/SIGINT, await the original
drain, prove process cessation/unmount, then recreate the fixed Pod against the same PVC. The template
gives **240 seconds** termination grace for the existing 100-second turn drain and 170-second
supervisor/lease/event envelope. It has no preStop sleep. Tini forwards the signal to the foreground
runner, which owns signaling/draining its engine children; do not broadcast a signal to the whole
process group and prematurely kill active turns. Budget expiry or uncertain old-node status requires
operator reconciliation/fencing, not a second writer. Keep the original PVC on sleep or failure.

## Manager environment profile

An apiserver with `ORBIT_MANAGED_RUNNERS_ENABLED=true` reconciles only in the environment that
`ORBIT_MANAGED_RUNNERS_PROFILE` names: an absolute path to a JSON profile shaped like
[manager-profile.example.json](manager-profile.example.json). The example is refused as it stands
(`valueKind: example`, placeholders). An actual profile names the JSON kubeconfig file, context,
expected API server and namespace, the storage class and capacity, a digest-pinned image, the runner's
Orbit URL, the resource amounts of this Pod template and every lifecycle budget. Without a valid
profile the feature reports itself unavailable and nothing is reconciled. Only the authorized isolated
test apiserver may set these variables; no default entry point does.

The manager creates the PVC above from `storage/pvc.template.json` and the Pod above, by the fixed
names `mr-data-<runner-uuid>` and `mr-<runner-uuid>`, with the runner credential of the Pod's
generation in Secret `mr-boot-<runner-uuid>`. The profile's `admission` section names the manager's
Kubernetes username (the only identity allowed to create a Pod that uses a managed volume) and the
SHA-256 of the bearer token the API server presents to the admission webhook. See the implementation
records in [the design](../../docs/managed-runner-design.md#implementation-record-single-writer-protection).

## Single-writer protection

ReadWriteOnce lets two Pods on one node mount the same claim, and RBD `exclusive-lock` passes between
clients cooperatively; neither is the protection here. Three pieces are, together, and none alone:

1. **Single-Pod admission guard.** [admission/pod-admission-webhook.template.json](admission/pod-admission-webhook.template.json)
   is a `ValidatingWebhookConfiguration` with `failurePolicy: Fail` for every Pod create and update
   (and `pods/ephemeralcontainers`) in the managed namespace, selected by namespace, never by labels.
   The Orbit apiserver answers it at `POST /api/managed-runner/admission` and decides from the
   database: a Pod that refers to a managed claim is admitted only if the mapping owns that claim,
   the manager's identity creates it, it has the fixed name, the owner/runner/PVC annotations and the
   generation the manager reserved (STARTING, no Pod recorded, a CREATE_POD pending), the pinned
   image and the runner template. Other names, unlabelled Pods, Jobs, read-only mounts, other nodes
   and stale generations are refused; concurrent creates under the fixed name are left to the API
   server's one-object-per-name rule. A webhook is used rather than a ValidatingAdmissionPolicy
   because the reservation lives in PostgreSQL under the mapping's compare-and-set: CEL would need a
   copy of it in the cluster that could lag or go backwards. Off (404), unavailable (503), without
   its token (401), timing out or with its database down, the webhook fails and the API server
   refuses the Pod. Before it creates a Pod the manager proves the guard is in force with a dry-run
   create the guard must refuse; admitted, it creates nothing (`ADMISSION_GUARD_MISSING`).

   Installing it needs the cluster operator: replace the placeholders (`__AUTHORIZED_TEST_NAMESPACE__`,
   the Orbit host and its CA bundle — drop `caBundle` for a publicly trusted certificate), and
   configure the API server to present the webhook token, through its admission configuration:

   ```yaml
   # --admission-control-config-file
   apiVersion: apiserver.config.k8s.io/v1
   kind: AdmissionConfiguration
   plugins:
     - name: ValidatingAdmissionWebhook
       configuration:
         apiVersion: apiserver.config.k8s.io/v1
         kind: WebhookAdmissionConfiguration
         kubeConfigFile: /etc/kubernetes/orbit-webhook-kubeconfig.yaml
   ```

   where that kubeconfig has a `users` entry named after the Orbit host carrying `token:` — the
   token whose SHA-256 the manager profile holds. A cluster whose API server cannot present it
   cannot run managed Pods: every create is refused.

2. **Generation-bound runner authentication.** Every request a managed runner makes with its
   credential names its generation and Pod UID (`X-Orbit-Managed-Runner-Generation`,
   `X-Orbit-Managed-Runner-Pod-Uid`) and declares `managed-runner-instance-v1`; the runner guards
   accept it only from the recorded instance and refuse a predecessor (403
   `MANAGED_RUNNER_INSTANCE_SUPERSEDED`), another Pod, a fenced mapping, or no instance at all;
   claims and inbox polls re-check it where work is handed out. Self-managed runners are unaffected.
   The owner cannot rotate a managed runner's credential (409 `MANAGED_RUNNER_ROTATE_REFUSED`).

3. **Stop or fencing proof before another generation.** The manager issues generation N+1's
   credential, Secret and Pod only after generation N's Pod was reported stopped by its kubelet,
   its object is gone and no VolumeAttachment holds the volume — or after an operator's fencing
   receipt bound to that instance and volume, with the object gone and the volume detached.
   Otherwise the mapping is FENCING: the predecessor's credential is replaced at once, the disk and
   Secret stay, and nothing starts. A stale heartbeat, an expired lease or an owner's retry never
   opens it.

### Fencing receipt

After fencing the old node (power-off through its BMC or hypervisor, kept quarantined) or its Ceph
clients (a tested, persistent blocklist), the operator records it for the manager as ConfigMap
`mr-fence-<runner-uuid>` in the managed namespace, key `receipt.json`, shaped like
[fencing-receipt.example.json](fencing-receipt.example.json):

```bash
kubectl --context "$AUTHORIZED_TEST_CONTEXT" --namespace "$AUTHORIZED_TEST_NAMESPACE" \
  create configmap "mr-fence-$RUNNER_UUID" --from-file=receipt.json="$REVIEWED_RECEIPT"
```

The receipt names the predecessor exactly as the mapping recorded it (runner, generation, Pod name
and UID, node, PVC UID, CSI volume handle, RBD pool/image), the action (who, when, what, reference)
and an independent observation that it took effect. `NODE_POWER_OFF` needs `POWERED_OFF` and a
quarantined node; `STORAGE_FENCE` needs `CLIENTS_BLOCKLISTED`, the blocklisted addresses and nonces,
the OSD map epoch and propagation time, a tested procedure reference, `persistent: true`,
`expiresAt: null` and a rejoin policy. An incomplete or unbound receipt is reported on the mapping
(`FENCING_RECEIPT_INVALID`) and opens nothing; an accepted one is recorded on the mapping. The
manager can read ConfigMaps and cannot write them. The operator's runbook still has to remove the
stale Pod object and attachment (`node.kubernetes.io/out-of-service`); the gate waits for both.

### Manager permissions

In the managed namespace: Pods get, create (including `dryRun`), delete; PVCs get, create; Secrets
get, create, delete; ConfigMaps get. Cluster-scoped and read-only: PersistentVolumes get,
VolumeAttachments list. Nothing on nodes, Ceph or the webhook configuration.

## Reproducible checks and pending acceptance

Run the local preparation checks from the checkout, preferably through a runner-hosted background job:

```bash
bash scripts/managed-runner/local-smoke.sh /tmp/orbit-managed-local-evidence
```

These clear all inherited `ORBIT_*` variables and provider keys, use scratch homes and recording
provider tripwires, build the current Orbit binary, test entrypoint bootstrap/reuse/refusal behavior,
and run selected existing config, Codex layout, Git worktree and graceful-drain tests with fakes.
The PASS count and original exit status are checked. Entrypoint tests substitute the local mapped
UID and mount check: they cannot prove UID 10001 execution or an actual persistent-volume mount.

After an isolated container builder/daemon is supplied, run the optional image smoke. Its environment
file records `kind: "isolated-container-test"`, `approved: true`, `environmentId` and `dockerHost`;
it does not discover a daemon from inherited Docker configuration. The image must be addressed by
digest or immutable local image ID:

```bash
python3 scripts/managed-runner/image-smoke.py \
  --environment-file "$AUTHORIZED_CONTAINER_TEST_RECORD" \
  --image "$RUNNER_IMAGE_DIGEST_OR_ID" --evidence-dir "$NEW_IMAGE_EVIDENCE_DIRECTORY"
```

This uses disposable resources on that daemon, a loopback fake control plane without provider
network access, fixture Git/worktree/attachment/engine files, actual nonroot image execution and
container recreation. Fixture engine files are not a real session. Retain logs, image/package/runtime
versions and artifact hashes; sanitise credentials before submitting evidence.

The following acceptance items remain **unexecuted**, independently of any local/static success:

1. Actual image build and isolated image smoke, including actual runtime manifest/image digest.
2. Kubernetes/Ceph-CSI mount, single-Pod protection and original-PVC rebuild/cross-node restore on the
   approved version tuple, with Pod/PVC/PV/volume/node identities and storage evidence.
3. First real engine session, using an explicitly authorized test model and credential/account;
   record provider/model/runtime versions and successful execution. No approved test supply is given
   by this task; current session credentials or host account homes are not a test supply.
4. Actual Git worktree and uploaded attachment created by that session, persisted through recreation;
   compare stable workspace/worktree paths and content hashes.
5. A continuation of the same real engine session after recreation, with unchanged runner ID/token,
   retained engine thread/session ID, metadata and SQLite integrity. Merely finding fixture files
   or comparing runner config is insufficient.
6. SIGTERM during real active work: prove claims stop, heartbeats/draining remain valid, the turn
   finishes/releases/flushes normally and the runner exits within the approved window.

Local check results and commits are a phase report for the coordinator. They do not complete the
project criterion requiring Kubernetes operation and real session recovery. The coordinator must
arrange these external prerequisites and resume the same task for final independent acceptance;
production deployment remains outside the project scope.
