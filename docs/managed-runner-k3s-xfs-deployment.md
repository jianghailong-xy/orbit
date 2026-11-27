# Managed runners on `.3`: k3s, Ceph RBD and XFS reflink

Status: deployed 2026-11-16. This is the deployment record for the production managed-runner environment on
10.66.0.3 (`workstation`). The design contract is [managed-runner-design.md](managed-runner-design.md); the
Kubernetes runbook is [managed-runner-kubernetes-operations.md](managed-runner-kubernetes-operations.md). Where this
record differs from that runbook's test-environment baseline, this record is what the deployment actually runs.

## Who gets one

Managed runners are **open to every enabled account**, including accounts created by open sign-up. The eligibility
rule is `EVERY_ACCOUNT` wrapped in `enabledAccountsOnly` (`src/apiserver/src/managed-runners/managed-runner-eligibility.ts`):
an account an administrator disabled is refused; every other account is eligible. A mapping is created at the account's
next sign-in or explicit `POST /api/managed-runner/ensure`, not before.

At the switch (2026-11-16) production had twelve enabled accounts and **one mapping** — the account that signed in
first after the profile switch. Every other enabled account gets a mapping on its next sign-in/ensure; test accounts are
not excluded by the rule.

What that gives each account, and what the environment admits together:

| | Per runner | Environment budget |
| --- | --- | --- |
| Data volume | 100 GiB, thin XFS PVC | 10 TiB usable, 1 TiB headroom |
| Waking compute | requests 250m CPU / 1 GiB, limits 2 CPU / 4 GiB; 1 GiB `/tmp` | 8 CPU / 32 GiB / 32 GiB ephemeral, 32 Pods, 32 attachments |
| Users awake at once | 1 | `maxActiveUsers` 32 |

Raised on 2026-11-16 by the owner from 3 awake runners (2 CPU / 4 GiB requests = limits) to 32, by overcommitting:
each runner reserves 250m CPU / 1 GiB and may burst to its 2 CPU / 4 GiB limits. The node has 8 CPU / 62 GiB and
also runs Ceph and other services, so many busy runners at once contend for CPU and can be OOM-killed; the previous
profile is `profile.json.bak-20261116T031245Z-max3` beside the live one. A 33rd wake waits for capacity. Storage
is reserved for the life of the volume, not only while the runner is awake.

## Stack

| Piece | Actual |
| --- | --- |
| Node | `workstation` (10.66.0.3), Debian 12, kernel 6.1.0-52, k3s **v1.37.2+k3s1**, single node |
| Kubelet | `singleProcessOOMKill: true` since 2026-11-22: out of memory kills one process, not the whole container (below) |
| Ceph | Tentacle **20.2.5**, one mon + one mgr, **two HDD OSDs on the same host**; pool `kubernetes`, **size 2 / min_size 1**; 27 TiB avail, 13 TiB `MAX AVAIL` |
| CSI | Ceph-CSI **v3.18.2** (Helm chart 3.18.2, release revision 5), image `quay.io/cephcsi/cephcsi:xfs-reflink-v3.18.2` — a local build of the [XFS reflink patch](../deploy/managed-runner/csi-xfs-reflink/README.md); nodeplugin and provisioner containers both use it; `pullPolicy: IfNotPresent`, Helm value `nodeplugin.plugin.image.tag=xfs-reflink-v3.18.2` |
| Mounter | **`rbd-nbd`**, not kernel RBD: the 6.1 kernel cannot map this Ceph release's default `aes256k` CephX keys. qBittorrent's volumes on the same node already use `rbd-nbd` |
| StorageClass | `runner-data-xfs`: `fstype: xfs`, `mounter: rbd-nbd`, `reflink: enabled`, `mountOptions: ["noatime","discard"]`, `reclaimPolicy: Retain`, `allowVolumeExpansion: false`, `volumeBindingMode: Immediate`, no `mkfsOptions` |
| Manager | namespace `orbit-cloud` since 2026-11-22, when the runners moved there from `orbit-managed`, which they used from 2026-11-16 ([the move](managed-runner-kubernetes-operations.md#move-the-runners-to-another-namespace)); `orbit-managed` still exists, empty; ServiceAccount `orbit-mr-manager`; JSON kubeconfig on the apiserver host at `data/managed-runners/kubeconfig-orbit-ws03.json` (`/var/lib/orbit-cloud-runners/kubeconfig-orbit-ws03.json` in the container), context `orbit-ws03-manager`, server `https://10.66.0.3:6443` |
| Admission | `ValidatingWebhookConfiguration` `orbit-cloud-runner-pods` for namespace `orbit-cloud` (and the earlier `orbit-managed-runner-pods`, which still guards `orbit-managed`), `failurePolicy: Fail`, URL `https://orbitd.io/api/managed-runner/admission`, no `caBundle` (public certificate); the k3s API server reads an admission configuration from `/etc/rancher/k3s/config.yaml.d/90-orbit-admission.yaml` and presents the webhook token from `/etc/rancher/k3s/orbit-managed/webhook-kubeconfig.json` (that directory kept its name through the namespace move) |
| Runner image | Since 2026-11-16, `docker.io/library/orbit-cloud-runner@sha256:48eb6d0ec62f905a4af96c4857c0d39f14bf6d5416a197b68a5c97f76f245e14`, built from `main` at `dcb75cb6e6a07bcdde0249437d58dcf2e8599c5b`; before it `sha256:3b069dbf77e1d696b98bb3ec54165c4ac974d4b908cb8985c814a8e9758c2b0d`, built from `orbit/runner-3-k3s-fastpath` at `0c03c6a590cf718ad2e531fae801ea343fdb3465` (release `0.1.261-beta.9` plus the index fast path), and `sha256:1460cd2f…6533`, both kept in containerd for rollback. Later images come from the registry with each release ("From the registry, with each release", below) |
| Profile | `data/managed-runners/profile.json` on the apiserver host (`/var/lib/orbit-cloud-runners/profile.json` in the container), mode 0600 |

## Why XFS, why this CSI patch

Every session checkout is cloned from the workspace checkout with `FICLONE`, so the volume must have reflink. The
measurements on the real Orbit repository in this environment:

- 23,515 cloned files, 890 MiB apparent, **+21.5 MB** of `statfs` usage per checkout on XFS;
- 32 checkouts: about 0.7 GB of growth, 3m44s total, the first cold checkout 2m14s and the warm ones 2–8 s each once
  the index fast path was in the image.

Ceph-CSI v3.18.2 hard-codes `-m reflink=0` after the StorageClass `mkfsOptions` (upstream issue #1256), so a stock
Ceph-CSI cannot produce a reflink XFS volume. The local patch adds an opt-in StorageClass parameter:

| `parameters.reflink` | `mkfs.xfs` |
| --- | --- |
| empty / `disabled` | `-m reflink=0` (upstream behavior) |
| `enabled` | `-m reflink=1` |
| `auto` | leaves the mkfs default |

`runner-data-xfs` sets `reflink: enabled`. `mkfsOptions` must not also set `reflink=`. The build, apply and verify
steps are in [deploy/managed-runner/csi-xfs-reflink](../deploy/managed-runner/csi-xfs-reflink/README.md). The patch is
local: re-apply it on every Ceph-CSI upgrade, or drop it when upstream supports the parameter. The image is kept locally
in containerd; it is not in a registry, so a node rebuild or an image GC would need the image re-imported.

btrfs was not used. The Ceph-CSI nodeplugin image has no `mkfs.btrfs`, Ceph-CSI does not support btrfs, and pre-formatting
volumes out of band would need static PVs or a format hook; see the session storage design.

## Runner image and the checkout index fast path

The runner image includes the checkout index fast path (`70feaa7c56`): after the `FICLONE`s, the runner writes the
cloned entries' stat data into the checkout's index, so `git update-index --refresh` hashes only the entries it cannot
prove and `git reset --hard` keeps the clones. Without it, a 23,515-file sparse checkout on this HDD-backed Ceph volume
had not finished the rehash after 300 s.

The image is imported into the k3s `k8s.io` containerd namespace **and given a digest alias**:

```sh
docker save orbit-cloud-runner:fastpath-0c03c6a5 | k3s ctr -n k8s.io images import -
k3s ctr images tag --local --skip-reference-check \
  docker.io/library/orbit-cloud-runner:fastpath-0c03c6a5 \
  'docker.io/library/orbit-cloud-runner@sha256:3b069dbf…2b0d'
```

Without the `@sha256` alias, the kubelet treats the digest reference as absent, tries Docker Hub and ends in
`ImagePullBackOff`. The profile image must be the digest, and the runner's `ORBIT_NO_SELFUPDATE` is set, so a new
image meant: build, import and alias it, update the profile, restart the apiserver, and recreate the Pod (a routine
delete is enough; the manager records the stop and starts the next generation). The image of 2026-11-16, built from
`main` at `dcb75cb6e`, went in that way: `docker.io/library/orbit-cloud-runner@sha256:48eb6d0e…5e14`, with its
archive at `/root/orbit-cloud-runner-main-dcb75cb6e.tar.gz` on the node.

### From the registry, with each release

From then on the image comes with the release tag (docs/release-process.md, "Orbit Cloud runner image"). When /release
creates a tag, the build host builds `10.66.0.1:5000/orbit-cloud-runner:<version>` from the tag's commit and pushes it
(`deploy/two-stage/publish-managed-runner.sh`); its runner reports that version. A two-stage deploy builds no runner
image: it takes the one of the newest release tag at or behind the commit it deploys, and stops before changing anything
when that image is not in the registry. The deploy on `10.66.0.4` sets the profile's `runner.image` to it by digest,
`runner.imageRevision` to the tag's commit (40 hex) and `runner.imageVersion` to the release version (what the runner
reports, and what lets the status offer Update Now), keeps the
profile it replaces beside it, and replaces the apiserver, which reads the profile as it starts. The apiserver's manager
then moves each runner whose Pod runs another image onto it once that runner is idle: the drain a sleep takes, then a
wake at once, as the next generation on the same PVC (`rollPreviousImage`). Nothing in flight is cut short; a busy runner
moves when it is next idle. No Pod is deleted by hand, and nothing is imported on the node. The release pulls the image
onto the node as soon as it is published (`deploy/managed-runner/prepull-runner-image.sh`, run through workspace
orbit-ws03), so that the first runner to start on it does not wait for a 1.5 GB pull: 116 s on 2026-11-25.

The node pulls that image from the WireGuard registry, which serves plain HTTP. k3s reads its registries once, as it
starts, from `/etc/rancher/k3s/registries.yaml`:

```yaml
mirrors:
  "10.66.0.1:5000":
    endpoint:
      - "http://10.66.0.1:5000"
```

then `systemctl restart k3s`. Without it, a runner woken on a release's image ends in `ImagePullBackOff`, and its
startup deadline fails it.

The profile values that matter (full JSON in the deployed file; the webhook hash is not reproduced here):

| Field | Value |
| --- | --- |
| `environmentId`, `clusterKey` | `orbit-ws03` |
| `kubernetes.namespace` | `orbit-cloud` (since 2026-11-22; `orbit-managed` before) |
| `kubernetes.context` / `apiServer` | `orbit-ws03-manager` / `https://10.66.0.3:6443` |
| `storage.className` / `capacity` | `runner-data-xfs` / `100Gi` |
| `runner.serverUrl` / `maxConcurrent` / `tmpSizeLimit` | `https://orbitd.io` / 2 / `1Gi` |
| `runner.resources.runner` | requests 250m CPU, 1 GiB; limits 2 CPU, 4 GiB (2026-11-16; before: requests = limits) |
| `runner.resources.init` | requests 100m / 256Mi; limits 500m / 1Gi |
| `admission.managerUsername` | `system:serviceaccount:orbit-cloud:orbit-mr-manager` (since 2026-11-22; `…:orbit-managed:…` before) |
| `capacity.compute` | 8 CPU, 32 GiB, 32 GiB ephemeral, 32 Pods, 32 attachments; `maxActiveUsers` 32 (2026-11-16) |
| `capacity.storage` | 10 Ti usable, 1 Ti headroom |
| `capacity.maxActiveUsers` | 3 |
| `lifecycle` | attempts 5, backoff 10–300 s, startup 1800 s, request 60 s, lease 60 s, poll 5 s, heartbeat 120 s, idle 86400 s, capacity retry 60 s, drain 600 s |

## Manager identity and admission guard

The ServiceAccount has only what `kubernetes-backend.ts` uses: Pods get/create/delete/patch; PVCs get/create; Secrets
get/create/delete; ConfigMaps get; PersistentVolumes get and VolumeAttachments list at cluster scope. It cannot list or
update Pods, use `pods/exec`, create ConfigMaps, read Nodes, or create Pods outside its namespace (`orbit-cloud`).

The admission guard is installed in two parts: the k3s API server's admission configuration (a drop-in and a webhook
kubeconfig whose user is named `orbitd.io`) and the `ValidatingWebhookConfiguration` above. The webhook token is in
`/etc/rancher/k3s/orbit-managed/webhook-token` (0600) and only its SHA-256 is in the profile. Changing the token
requires updating both sides; the profile hash must be the SHA-256 of the **64-character token itself**, not of the
token file with a trailing newline (that mistake produced a 401 during the first attempt). The API server was restarted
to load the admission configuration; that restart also interrupted an unrelated qBittorrent copy on the same k3s node,
so coordinate a window before repeating it.

## Cutover from the Docker backend

The previous backend was Docker on the same host (`orbit-ws03`, channel at `http://10.66.0.3:7300`). The cutover:

1. Backed up the Docker profile and the owner's one `managed_runner` row under `data/managed-runners/`, and the Docker
   data volume with tar (`owner-docker-mr-volume.tar.gz`, 429,876 bytes, sha256 `3af7439a…9541`). The volume was not
   deleted.
2. Wrote the Kubernetes profile, validated it with the apiserver's own profile parser, and recreated the apiserver.
3. Deleted the Docker mapping row (the old runner and workspace rows remain), then called `POST
   /api/managed-runner/ensure` as the owner. The manager created a 100 GiB `runner-data-xfs` PVC, a bootstrap Secret
   and a Pod; the runner reached READY.
4. Turned the old Docker channel off: Compose project `orbit-channel-host`
   (`deploy/managed-runner/remote-host/compose.yml`) `down` without `-v`, and the kit's own firewall `remove` for the
   `ORBIT-MR-*` iptables chains and the `ip rule`. Port 7300 is closed; the old Docker volume, the channel's anonymous
   volume, the tar backup, the profile/token backups and the old DB rows are retained.
5. Rolled the runner to the fast-path image by updating the profile image digest, restarting the apiserver and deleting
   the Pod; the manager started generation 2 with the new digest.

## Verified on 2026-11-16

- Pod `mr-<runner uuid>` generation 2 Running/Ready, 0 restarts; imageID `sha256:3b069dbf…2b0d`; init completed.
- Runner ONLINE, version `managed-0c03c6a590cf…`; the control plane log names the fast-path commit; `volume is
  /dev/nbd2 (xfs)`; `checkouts: cloned:`; no FENCING, admission denial or ImagePullBackOff after the digest alias.
- PVC Bound, 100 GiB, `runner-data-xfs`; PV and CSI volume handle unchanged across the generation; `stat -f` reports
  xfs; `cp --reflink=always` on a 16 MiB file returns 0 and both files report 32768 blocks.
- Ceph HEALTH_OK; k3s `/readyz` ok; no change to the qBittorrent Pods/PVCs.

## Memory: one process, not the container (2026-11-22)

Until 2026-11-22 the kubelet set `memory.oom.group=1` on every container, cgroup v2's default. On 2026-11-20 a Go
build took one runner container to its 4 GiB limit. The kernel then killed the whole group, `tini` and the runner
included: dmesg logged five of these kills, each saying `Tasks in /kubepods.slice/…/cri-containerd-<id>.scope are going
to be killed due to memory.oom.group set`. The owner approved one node setting on 2026-11-20, the kubelet's
`singleProcessOOMKill: true`. It was applied on 2026-11-22 with the
[runbook's procedure](managed-runner-kubernetes-operations.md#out-of-memory-kills-one-process-the-kubelets-singleprocessoomkill):

- **Support.** k3s v1.37.2+k3s1 has no `k3s kubelet --help`. Its binary carries the field
  (`json:"singleProcessOOMKill,omitempty"`), its description ("will prevent the `memory.oom.group` flag from being set
  for container cgroups in cgroups v2 … the default value is false") and the cgroup v1 refusal. The node is cgroup v2
  with the systemd driver. k3s starts the kubelet with `--config-dir=/var/lib/rancher/k3s/agent/etc/kubelet.conf.d`
  only, and rewrites `00-k3s-defaults.conf` there at every start.
- **Files.** Both are new; `/etc/rancher/k3s` was backed up to `/root/k3s-etc-backup-20261122T103139Z.tgz` (0600) first.
  - `/etc/rancher/k3s/kubelet-orbit.yaml` (0644): `apiVersion: kubelet.config.k8s.io/v1beta1`,
    `kind: KubeletConfiguration`, `singleProcessOOMKill: true`.
  - `/etc/rancher/k3s/config.yaml.d/95-orbit-kubelet.yaml` (0600, like `90-orbit-admission.yaml`):
    `kubelet-arg+: ["config=/etc/rancher/k3s/kubelet-orbit.yaml"]`. k3s copies that file into its drop-in directory
    as `10-cli-config.conf`, so the `Running kubelet` line is unchanged.
- **Restart.** `systemctl restart k3s` ran from 10:31:53Z to 10:32:02Z, and `/readyz` and the node were back at
  10:32:02Z. The quiet checks at 10:10Z and 10:21Z found runner `mr-01a1e190` busy (`claude -p`, a `go build`, `git`),
  so the restart waited. At 10:31Z no runner Pod existed: both had stopped for the move to `orbit-cloud`. Running at
  the restart were the Ceph-CSI nodeplugin and provisioner, CoreDNS, local-path-provisioner, metrics-server and
  qBittorrent's `qbt-migrate`. None of them restarted.
- **Verified.** The kubelet's `configz` answers `singleProcessOOMKill: true`, with k3s's own defaults still in force
  (`cgroupDriver: systemd`, its `staticPodPath` and containerd socket). The first runner Pod created after the restart
  (`orbit-cloud/mr-01a1e190-…`, 10:39:59Z) has `memory.oom.group 0` with `memory.max` 4 GiB. Containers created before
  a restart keep `1` until their next generation. A test Pod in a scratch namespace (alpine, 64 MiB limit, a `sleep`
  beside `dd bs=256M count=1`) lost only `dd`: dmesg showed one `Memory cgroup out of memory: Killed process … (dd)` and
  no `memory.oom.group` line, `memory.events` counted `oom_kill 1` and `oom_group_kill 0`, the shell and `sleep` stayed in
  the cgroup, and the container stayed Running with restart count 0. The namespace was deleted afterwards.
- **Undo.** Remove `95-orbit-kubelet.yaml` and restart k3s. Runner containers then go back to the group kill at their
  next generation.

This makes the kernel kill one process. Which one it picks, and the daemon's own watchdog before the limit, are the
runner's job (`oom_score_adj` on its tool processes).

## Not verified here / risks

- **XFS was not put through the durability and power-cut drills** that the design's D4 required when leaving ext4.
  SQLite integrity, Git fsck and the runner's `syncfs` behavior after a power cut are ext4-proven; they are not yet
  XFS-proven on this volume. Run the drills before treating the XFS deployment as durability-accepted.
- The node is **single-node**. There is no cross-node failover or live move; the runbook's two-node lab evidence does
  not apply. A node failure stops the runner and its volume until the node returns.
- Ceph is two OSDs on one host with `size 2 / min_size 1`: it survives one OSD's loss, not the host's, and a second OSD
  failure before recovery can lose data. The pool is thin; the 100 GiB PVCs reserve storage, not physical bytes.
- Both the patched CSI image and the runner image are local to the node's containerd, not in a registry. A node rebuild
  or image GC needs the images re-imported (and the runner image's digest alias re-created). Keep the image archives or
  push them to a registry before relying on a rebuild.
- The fast path's runtime log (`checkout index: filled …`) appears only when a session creates a checkout; the image
  version was verified, but the log had not yet been observed at the switch.

## Drive RGW storage

The production Drive data pool is `orbit-files.rgw.buckets.data`. Its `max_bytes` quota is
**10 TiB (10,995,116,277,760 bytes)**. Set `ORBIT_DRIVE_STORE_QUOTA_BYTES=10995116277760` when
deploying the S3 backend. The S3 bucket is `orbit-files`.
Keep `ORBIT_DRIVE_S3_ACCESS_KEY_ID` and `ORBIT_DRIVE_S3_SECRET_ACCESS_KEY` in the production
apiserver's private Compose env file.

Durability for Files bytes comes from Ceph replication. The owner is scaling out Ceph to increase
replica placement and capacity. Run without a ZFS mirror and leave `ORBIT_DRIVE_S3_MIRROR` unset.

As Ceph grows, check the cluster's usable capacity and agree on a new Files pool ceiling in bytes.
From the cluster's administration environment, set and verify the new quota.

```sh
ceph osd pool set-quota orbit-files.rgw.buckets.data max_bytes "${new_quota_bytes}"
ceph osd pool get-quota orbit-files.rgw.buckets.data
```

Set `ORBIT_DRIVE_STORE_QUOTA_BYTES` to the verified pool quota at the corresponding apiserver
configuration rollout.

## Rollback

The Docker profile, the owner's mapping row and the Docker volume are preserved. To roll back: delete the Kubernetes
mapping (and its Pod/PVC if it should stop), restore the Docker profile and the mapping row, restart the apiserver, and
turn the Docker channel host back on. The old Docker runner and workspace rows are still in the database. The old Docker
volume is intact; the tar is a second copy. The old runner image digest remains in containerd for a runner-image
rollback.

## Files and links

- [Kubernetes operations runbook](managed-runner-kubernetes-operations.md)
- [Design and data contract](managed-runner-design.md)
- [Session checkout storage design](session-checkout-storage-design.md)
- [Ceph-CSI XFS reflink patch](../deploy/managed-runner/csi-xfs-reflink/README.md)
- [Ceph RBD storage preparation](../deploy/managed-runner/storage/README.md)
