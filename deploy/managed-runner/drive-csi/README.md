# Drive CSI plugin (`drive.orbit.dev`)

The node plugin that gives each managed runner Pod its Drive (docs/drive-technical-design.md
§6.1). The runner container receives one plain directory, `/run/orbit-drive`, with HostToContainer propagation; the
drive's FUSE mount sits below it at `drive/`, made by the plugin, never in the container. The runner makes
`/home/orbit/Drive` a link to it (`src/runner-go/drive_link.go`). Source: `src/drive-mount` (the `csi` command and
packages `csi` and `parent`).

| File | What it is |
|---|---|
| [namespace.yaml](namespace.yaml) | `orbit-drive-system`, Pod Security `privileged`: the plugin and the mount credentials only. |
| [csidriver.yaml](csidriver.yaml) | `drive.orbit.dev`: no attach, inline (ephemeral) volumes only, the Pod's name, namespace and UID passed to the plugin. |
| [rbac.yaml](rbac.yaml) | The plugin may `get` Secrets in `orbit-drive-system`, nothing else. The manager may `get`, `create`, `update`, `delete` Secrets there. |
| [daemonset.yaml](daemonset.yaml) | The plugin (privileged, `hostPID`), with the stock `node-driver-registrar` and `livenessprobe` sidecars. `updateStrategy: OnDelete`. |
| [admission-policy.yaml](admission-policy.yaml) | Cluster-wide ValidatingAdmissionPolicy `orbit-drive-driver`: no Pod outside the managed-runner namespace may name the driver. |
| [Dockerfile](Dockerfile) | One static binary on `scratch`, with the CA bundle. |

## What it does

- **Publish.** It refuses unless the Pod is in the managed-runner namespace and the volume's attributes are exactly
  `{ runnerId }`. It reads Secret `mrf-<runnerId>`, the mount credential the manager wrote for the Pod's
  generation. The door must admit the Pod: `503 MANAGED_RUNNER_INSTANCE_PENDING` (the manager has not recorded the
  Pod's UID yet) answers `UNAVAILABLE`, which the kubelet retries; a refusal answers `PERMISSION_DENIED`. The plugin then
  starts that runner's privileged parent, which runs the daemon, the watchdog and the remounts. Once the mount
  answers, it binds the plain `/var/lib/orbit-drive/<runnerId>` (never `drive/`) onto the kubelet's target and writes
  `/var/lib/orbit-drive-state/<runnerId>.json`. One Pod of a runner at a time: another one waits (`UNAVAILABLE`) until
  the first is unpublished.
- **Each runner's daemon runs as a uid of its own** (from 300000, `--daemon-uid-base` in daemonset.yaml, clear of the 200000 the older drivers' plugins start from), with no capabilities,
  `no_new_privs` and a seccomp filter. Its spool is `0700` under that uid, so no daemon can read another runner's.
- **Unpublish.** It unmounts the target, stops the daemon after its open commits (at most 60 s), unmounts the drive
  and removes the state file.
- **Who may name the driver (B13), three layers.** The admission policy here; Orbit's webhook inside the managed
  namespace, which allows only the one volume naming the Pod's own runner, mounted only by `runner` at
  `/run/orbit-drive` with HostToContainer; and the plugin's own namespace check. The door's Pod-UID check comes after
  all three.

## Install

Order: the namespace, the CSIDriver, RBAC, the admission policy, then the DaemonSet. Replace every `__…__` first:
the managed namespace is the profile's `kubernetes.namespace`; the manager's ServiceAccount is the one
`admission.managerUsername` names; the server is the profile's `runner.serverUrl`; the image is pinned by digest.
Then add `"files": { "namespace": "orbit-drive-system" }` to the manager's profile. Without that section, runner
Pods get no drive and nothing here is used.

The plugin's image is imported locally as the runner image is (the same local-import caveat as
docs/managed-runner-k3s-xfs-deployment.md): build it from the repository root with
`docker build -f deploy/managed-runner/drive-csi/Dockerfile -t <registry>/orbit-drive-csi:<source sha> .` and use
its digest.

The node needs `/dev/fuse`. If its init did not mount fusectl at `/sys/fs/fuse/connections`, the plugin mounts it
in its own mount namespace: the watchdog aborts a frozen daemon through it.

## Restart and upgrade (review A8, row 55)

The daemons run in the plugin container. When it stops, each daemon commits its open writes and exits; the mounts
stay, so callers meet `ENOTCONN` rather than an empty folder. The kubelet does not publish a running Pod's volume
again, so on start the plugin **adopts** every state file whose target is still mounted. It re-reads the Secret and
mounts over the dead `drive/`, and the parent-directory layout carries the new mount into the running Pod. A daemon
that died without stopping (killed with its container) leaves its spool behind. The parent moves those chunks into
the runner's `unsent/` before the next daemon starts, and `errors.log` names each one. A Pod whose generation was
superseded meanwhile is not mounted again.

The drive is down for the plugin's restart. Measured on k3s v1.36.5 (one node, in Docker, 2026-11-22): 0.8–1.3 s
for a deleted plugin Pod, and 6.8 s for a plugin killed with `SIGKILL` and restarted by the kubelet.

**Upgrade** with `updateStrategy: OnDelete`, one node at a time, when the node's runners are asleep or in a stated
maintenance window:

1. Apply the DaemonSet with the new image digest. Nothing restarts.
2. On one node: `kubectl -n orbit-drive-system delete pod <orbit-drive-csi pod of that node>`. The DaemonSet starts the
   new image there, and it adopts that node's drives.
3. Check its log (`adopted N drives`) and one runner's `/run/orbit-drive/status.json`, then go on to the next node.

Never delete the DaemonSet while runner Pods use the drive. That stops every node's plugin at once, and nothing
adopts the drives until it is back.

## Moving from an older driver (the rename to Drive)

Before the drive was renamed Drive, this plugin was `documents.orbit.dev`, installed from
`deploy/managed-runner/documents-csi` of the release you deployed it from: namespace `orbit-documents-system`,
DaemonSet `orbit-documents-csi`, policy `orbit-documents-driver`, node directories `/var/lib/orbit-documents`, `-spool`
and `-state`, and runner Pods that receive the drive at `/run/orbit-documents`. A cluster that has not finished the
rename before that one may still run `files.orbit.dev` too (`orbit-files-system`, `orbit-files-csi`,
`orbit-files-driver`, `/var/lib/orbit-files…`, Pods at `/run/orbit-files`); treat it exactly like
`documents.orbit.dev` below.

A Pod's CSI driver cannot change while it runs, so the drivers run side by side until every Pod of an old one has
gone. Every name of the new driver differs from the old ones' (namespace, DaemonSet, policy, CSIDriver, kubelet socket
`/var/lib/kubelet/plugins/drive.orbit.dev`, node directories, daemon uids from 300000 rather than 200000), so neither
touches the other's objects, files or processes. The old plugin keeps working against this release's server: its
daemons call `/api/runner/documents/*`, which the server still answers as an alias of `/api/runner/drive/*`, with the
same mount credentials.

1. **Install the new driver next to the old one.** Apply everything here as in [Install](#install), with the same
   replacements. Leave every object of the old driver in place, and do not re-apply its DaemonSet or change its image:
   its pinned digest is the old binary, which serves only `documents.orbit.dev`. Each node then runs both plugins;
   check that `kubectl get csinode <node> -o jsonpath='{.spec.drivers[*].name}'` lists `documents.orbit.dev` and
   `drive.orbit.dev` on every node that runs runner Pods, and that the new plugin logs no errors.
2. **Start new Pods on the new name.** Change these together, in one restart of the apiserver: upgrade Orbit to a
   release with the Drive names (the apiserver, and the profile's `runner.image` to that release's runner image), and
   set the profile's `files.namespace` to `orbit-drive-system`. From then on the manager writes each new generation's
   mount credential in `orbit-drive-system` and creates every runner Pod with a `drive.orbit.dev` volume mounted at
   `/run/orbit-drive`. The apiserver and the namespace must move together: a `drive.orbit.dev` Pod whose credential
   is in `orbit-documents-system` is never published (the new plugin reads only its own namespace), and an older
   apiserver writing into `orbit-drive-system` creates `documents.orbit.dev` Pods whose plugin cannot find their
   credential. The runner image may go first on its own: a runner of this release uses whichever of `/run/orbit-drive`,
   `/run/orbit-documents` and `/run/orbit-files` its Pod has, while an older runner in a new Pod would not find the
   drive. During the transition the admission webhook still admits a Pod with an old volume (`documents.orbit.dev`
   at `/run/orbit-documents`, `files.orbit.dev` at `/run/orbit-files`, each only at its own path and as strictly the
   template as a new Pod), so an old Pod's updates, such as the manager taking its finalizer off, are not refused. To
   roll back, undo the three changes together; the old driver is still installed.
3. **Let old Pods drain.** A Pod keeps its driver until it ends; its runner's next generation (a restart, an image
   upgrade, a sleep and wake) starts on the new driver. The old plugin still reads the old Pods' credentials in
   `orbit-documents-system` when it restarts, so leave that namespace alone until the end. To see which Pods are left:

   ```
   kubectl -n <managed namespace> get pods -o json \
     | jq -r '.items[] | select(any(.spec.volumes[]?; .csi.driver? == "documents.orbit.dev" or .csi.driver? == "files.orbit.dev")) | .metadata.name'
   ```

   Wait until it prints nothing. Then, on each node, look for bytes an old daemon could not commit
   (`ls /var/lib/orbit-documents/*/unsent/ /var/lib/orbit-files/*/unsent/`) and put any into the drive.
4. **Remove the old driver.** In this order: `kubectl delete daemonset -n orbit-documents-system orbit-documents-csi`;
   the policy (`kubectl delete validatingadmissionpolicybinding,validatingadmissionpolicy orbit-documents-driver`);
   `kubectl delete csidriver documents.orbit.dev`; `kubectl delete namespace orbit-documents-system`, which removes its
   RBAC and the old mount credentials. Then, on each node, remove `/var/lib/orbit-documents`,
   `/var/lib/orbit-documents-spool`, `/var/lib/orbit-documents-state` and
   `/var/lib/kubelet/plugins/documents.orbit.dev`. Do the same with the `orbit-files` names if `files.orbit.dev` is
   still installed.

Once no deployment has an old Pod left, a later release can stop admitting `documents.orbit.dev` and
`files.orbit.dev`, stop looking for `/run/orbit-documents` and `/run/orbit-files`, and drop the server's
`/api/runner/documents` alias.
