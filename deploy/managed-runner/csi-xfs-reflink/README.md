# Ceph-CSI XFS reflink patch

The managed runner clones a session checkout from its workspace checkout with
`FICLONE` (`src/runner-go/clone_checkout.go`). That only works when the PVC's
filesystem has reflink: XFS with `reflink=1` or btrfs. The Kubernetes backend
uses XFS, but upstream Ceph-CSI always disables reflink while formatting an XFS
RBD volume:

```go
case xfsFilesystem:
    // always disable reflink
    // TODO: make enabling an option, see ceph/ceph-csi#1256
    if ns.xfsSupportsReflink() {
        args = append(args, "-m", "reflink=0")
    }
```

The hard-coded `-m reflink=0` is appended after the StorageClass `mkfsOptions`,
so a StorageClass cannot enable reflink itself: `-m reflink=1` and
`-m reflink=0` end up on one `mkfs.xfs` command and it fails with
`-m reflink option respecified`. Upstream issue
[ceph/ceph-csi#1256](https://github.com/ceph/ceph-csi/issues/1256) asks for a
StorageClass option; it is still open.

This directory holds a local patch that adds that option, so a StorageClass can
opt in without changing the behavior of any other volume.

## What the patch adds

A StorageClass parameter `reflink` for `fstype: xfs`:

| Value | `mkfs.xfs` arguments | Meaning |
| --- | --- | --- |
| empty or `disabled` | `-m reflink=0` when `mkfs.xfs` supports it | Upstream behavior, unchanged |
| `enabled` | `-m reflink=1` | Opt in; the node kernel must be able to mount reflink XFS |
| `auto` | nothing | Leave the `mkfs.xfs` default (`reflink=1` since xfsprogs 5.1) |

Anything else is refused with an error. A StorageClass whose `mkfsOptions`
already sets `reflink=` is also refused unless `reflink: auto` is set, so the
two cannot silently disagree. The patch adds `TestXfsReflinkArgs`; the default
(`empty`/`disabled`) is byte-for-byte the upstream behavior.

The patch is against Ceph-CSI **v3.18.2**, commit
`2ae061402d436cf742ada728229898ac30f2e633`.

## Build

Go 1.26.4 or later is required (`go.mod`), and a container runtime (Docker or
podman) for `make image-cephcsi`.

```sh
git clone --depth 1 --branch v3.18.2 https://github.com/ceph/ceph-csi.git
cd ceph-csi
git apply /path/to/deploy/managed-runner/csi-xfs-reflink/xfs-reflink.patch

make image-cephcsi \
  CONTAINER_CMD=docker \
  CSI_IMAGE_NAME=<registry>/cephcsi \
  CSI_IMAGE_VERSION=xfs-reflink-v3.18.2

docker push <registry>/cephcsi:xfs-reflink-v3.18.2
docker inspect --format '{{index .RepoDigests 0}}' <registry>/cephcsi:xfs-reflink-v3.18.2
```

Pin the resulting `@sha256:…` digest. The patch only changes the node stage
formatting path, but the same image serves both the controller and node plugin;
overriding both is harmless and keeps one digest for the release.

## Deploy

Override the Ceph-CSI image in the installed Helm release or operator image
set, pinned by digest. For example, with the chart installation used on `.3`
(chart `3.18.2`):

```sh
helm -n ceph-csi-rbd get values <release> > values.yaml
# set the nodeplugin/controller image repository, tag and digest to the built image
helm -n ceph-csi-rbd upgrade <release> <chart> -f values.yaml
```

Confirm the running nodeplugin uses it:

```sh
kubectl -n ceph-csi-rbd get pods -l app=ceph-csi-rbd-nodeplugin \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.containerStatuses[*].imageID}{"\n"}{end}'
```

## Deployment record: .3 (2026-11-16)

The production managed-runner environment on 10.66.0.3 runs this patch. The operator built and pinned it as follows:

- Ceph-CSI **v3.18.2** (chart **3.18.2**), patched; image `quay.io/cephcsi/cephcsi:xfs-reflink-v3.18.2`; Docker image
  ID `sha256:7a58e795…`, containerd manifest `sha256:97acea1c…`. The nodeplugin and provisioner containers both run
  the patched image.
- Helm release **revision 5**: `nodeplugin.plugin.image.tag=xfs-reflink-v3.18.2`, `imagePullPolicy: IfNotPresent`.
  A first upgrade from the git chart tree changed the chart label to `3-canary`; the operator re-packaged the same
  chart with `--version 3.18.2` and restored it. A future chart upgrade must apply this patch and set the values again.
- The image is **local to .3's containerd**, not in a registry. A node rebuild or an image GC needs it re-imported, or
  the archive pushed to a registry. Keep the image archive with the deployment records.
- The class is [runner-data-xfs](#storageclass). A scratch claim's `xfs_info` showed `reflink=1`, `rmapbt=1`,
  `crc=1`, `finobt=1`, `sparse=1`, `bigtime=1`, `inobtcount=1`, `nrext64=1`; a 64 MiB `cp --reflink=always` returned 0
  with no `statfs` growth; the mount carried `noatime,discard`.
- The first 100 GiB managed-runner PVC and the real-repository 32-checkout benchmark that proved the reflink saving are
  in [the deployment record](../../../docs/managed-runner-k3s-xfs-deployment.md).

## StorageClass

Only the managed runner's class opts in:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: runner-data-xfs
provisioner: rbd.csi.ceph.com
parameters:
  clusterID: <fsid>
  pool: kubernetes
  imageFeatures: layering
  mounter: rbd-nbd
  csi.storage.k8s.io/fstype: xfs
  reflink: enabled
  # the usual provisioner/controller/node-stage secret parameters
mountOptions: ["noatime", "discard"]
reclaimPolicy: Retain
allowVolumeExpansion: false
volumeBindingMode: Immediate
```

Do not set `mkfsOptions` for reflink; the `reflink` parameter owns that. Any
other XFS StorageClass keeps the default (`disabled`).

## Verify

On a freshly bound PVC and before it holds data:

```sh
xfs_info /home/orbit | grep -E 'reflink|rmapbt'
# reflink=1

cp --reflink=always /home/orbit/.probe /home/orbit/.probe.clone
stat -c '%b' /home/orbit/.probe /home/orbit/.probe.clone   # same blocks
```

Then a managed runner's start log must say
`checkouts: cloned: the filesystem of … can clone files`, and each session
checkout must log `checkout cloned: <n> files`.

The patch itself is checked without a cluster:

```sh
./verify.sh
```

It clones the pinned tag, applies the patch, checks `gofmt`, and runs
`go test ./internal/rbd -run '^TestXfsReflinkArgs$'`. The RBD package imports
`go-ceph`, so the test needs the Ceph client development headers
(`librados-dev`, `librbd-dev`) or the project's devel container; the script
stops with a clear message when they are missing.

## Maintenance

- Re-apply the patch whenever Ceph-CSI is upgraded; check
  [issue #1256](https://github.com/ceph/ceph-csi/issues/1256) first. When a
  release supports a reflink StorageClass option, drop this patch and use the
  upstream parameter.
- The default path is unchanged, so a volume created before this patch keeps
  `reflink=0`; only new PVCs from a class with `reflink: enabled` get reflink.
- Reflink needs a kernel that can mount the feature: Linux 4.9 or later. The
  `.3` node runs 6.1, so it is fine. Do not use `reflink: enabled` for volumes
  that may move to an older node.
