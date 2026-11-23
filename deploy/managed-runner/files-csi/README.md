# Orbit Files CSI plugin (`files.orbit.dev`)

The node plugin that gives each managed runner Pod its Orbit Files drive (docs/orbit-files-drive-technical-design.md
§6.1). The runner container receives one plain directory, `/run/orbit-files`, with HostToContainer propagation; the
drive's FUSE mount sits below it at `drive/`, made by the plugin, never in the container. The runner makes
`/home/orbit/Files` a link to it (`src/runner-go/drive_link.go`). Source: `src/drive-mount` (the `csi` command and
packages `csi` and `parent`).

| File | What it is |
|---|---|
| [namespace.yaml](namespace.yaml) | `orbit-files-system`, Pod Security `privileged`: the plugin and the mount credentials only. |
| [csidriver.yaml](csidriver.yaml) | `files.orbit.dev`: no attach, inline (ephemeral) volumes only, the Pod's name, namespace and UID passed to the plugin. |
| [rbac.yaml](rbac.yaml) | The plugin may `get` Secrets in `orbit-files-system`, nothing else. The manager may `get`, `create`, `update`, `delete` Secrets there. |
| [daemonset.yaml](daemonset.yaml) | The plugin (privileged, `hostPID`), with the stock `node-driver-registrar` and `livenessprobe` sidecars. `updateStrategy: OnDelete`. |
| [admission-policy.yaml](admission-policy.yaml) | Cluster-wide ValidatingAdmissionPolicy `orbit-files-driver`: no Pod outside the managed-runner namespace may name the driver. |
| [Dockerfile](Dockerfile) | One static binary on `scratch`, with the CA bundle. |

## What it does

- **Publish.** It refuses unless the Pod is in the managed-runner namespace and the volume's attributes are exactly
  `{ runnerId }`. It reads Secret `mrf-<runnerId>`, the mount credential the manager wrote for the Pod's
  generation. The door must admit the Pod: `503 MANAGED_RUNNER_INSTANCE_PENDING` (the manager has not recorded the
  Pod's UID yet) answers `UNAVAILABLE`, which the kubelet retries; a refusal answers `PERMISSION_DENIED`. The plugin then
  starts that runner's privileged parent, which runs the daemon, the watchdog and the remounts. Once the mount
  answers, it binds the plain `/var/lib/orbit-files/<runnerId>` (never `drive/`) onto the kubelet's target and writes
  `/var/lib/orbit-files-state/<runnerId>.json`. One Pod of a runner at a time: another one waits (`UNAVAILABLE`) until
  the first is unpublished.
- **Each runner's daemon runs as a uid of its own** (from 200000, `--daemon-uid-base`), with no capabilities,
  `no_new_privs` and a seccomp filter. Its spool is `0700` under that uid, so no daemon can read another runner's.
- **Unpublish.** It unmounts the target, stops the daemon after its open commits (at most 60 s), unmounts the drive
  and removes the state file.
- **Who may name the driver (B13), three layers.** The admission policy here; Orbit's webhook inside the managed
  namespace, which allows only the one volume naming the Pod's own runner, mounted only by `runner` at
  `/run/orbit-files` with HostToContainer; and the plugin's own namespace check. The door's Pod-UID check comes after
  all three.

## Install

Order: the namespace, the CSIDriver, RBAC, the admission policy, then the DaemonSet. Replace every `__…__` first:
the managed namespace is the profile's `kubernetes.namespace`; the manager's ServiceAccount is the one
`admission.managerUsername` names; the server is the profile's `runner.serverUrl`; the image is pinned by digest.
Then add `"files": { "namespace": "orbit-files-system" }` to the manager's profile. Without that section, runner
Pods get no drive and nothing here is used.

The plugin's image is imported locally as the runner image is (the same local-import caveat as
docs/managed-runner-k3s-xfs-deployment.md): build it from the repository root with
`docker build -f deploy/managed-runner/files-csi/Dockerfile -t <registry>/orbit-files-csi:<source sha> .` and use
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
2. On one node: `kubectl -n orbit-files-system delete pod <orbit-files-csi pod of that node>`. The DaemonSet starts the
   new image there, and it adopts that node's drives.
3. Check its log (`adopted N drives`) and one runner's `/run/orbit-files/status.json`, then go on to the next node.

Never delete the DaemonSet while runner Pods use the drive. That stops every node's plugin at once, and nothing
adopts the drives until it is back.
