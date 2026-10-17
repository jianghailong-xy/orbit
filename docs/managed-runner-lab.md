# Managed runner single-machine lab

A disposable test environment for the managed runner project: one KVM virtual machine on the HPC
host (Orbit runner `workstation-gpu`) running single-node k3s, a single-host Ceph cluster and
Ceph-CSI RBD. The owner authorized it on 2026-10-17 as the project's "authorized isolated test
environment", limited to one machine, one node and one failure domain. It changes nothing on the
host beyond its own files and its own transient systemd unit, it is off unless a test window needs
it, and it does not enable managed runners anywhere: the server switch stays off by default, and
no default entry point (root Compose, `.env.example`, `/upgrade`, release, install or start
scripts) refers to it. [The design contract](managed-runner-design.md) is the baseline; this page
records how the lab follows it and where it departs from it.

The scripts are in [`scripts/managed-runner/lab/`](../scripts/managed-runner/lab/), with every
version and checksum pinned in [`lab.env`](../scripts/managed-runner/lab/lab.env).

## Architecture

```text
HPC host (Debian 13, kernel 6.12, ~15 GiB RAM, shared by every Orbit session)
  orbit-runner-root.service ............ the Orbit runner and its sessions (not touched)
  orbit-mr-lab.service (transient) ..... qemu-system-x86_64, its own cgroup in system.slice:
  |                                      MemoryMax 6656M, OOMScoreAdjust 1000, CPUQuota 400%
  |  127.0.0.1:16222 -> guest :22    (SSH)          QEMU user network (slirp): no bridge,
  |  127.0.0.1:16443 -> guest :6443  (k3s API)      no tap, no firewall change; the guest
  |                                                 reaches host services at 10.0.2.2
  /mnt/data/managed-runner-lab/ (0700) .. every disk, key, log and kubeconfig of the lab

Guest orbit-mr-lab (Ubuntu 26.04.1 LTS, kernel 7.0.0-34-generic, 4 vCPU, 6 GiB, 10.0.2.15)
  Ceph 20.2.4 under cephadm/podman ...... 1 mon, 1 mgr, 3 OSDs on vdb/vdc/vdd (one virtual disk
  |                                       each on /mnt/data); outside Kubernetes, so for k3s it
  |                                       is an external Ceph test backend at 10.0.2.15
  k3s v1.36.5 (single node) ............. Ceph-CSI Operator v1.1.0 -> Ceph-CSI v3.18.0 RBD driver
                                          StorageClass runner-data, namespace orbit-mr-test
```

Nothing of Kubernetes, Ceph or CSI is installed on the host, and the host loads no `rbd`, `nbd`,
`ceph` or `libceph` module: RBD devices are mapped by the guest's kernel. `status.sh` prints the
host's module list and the qemu process's listening sockets (only the two 127.0.0.1 forwards).
The host keeps only `kubectl` (v1.36.5, checksum-verified) in `/mnt/data/managed-runner-lab/bin/`.

## Versions

| Component | Version | Pin |
| --- | --- | --- |
| Guest image | Ubuntu 26.04 LTS cloud image, release 20260927 (26.04.1) | SHA-256 `8800651811af…7332b2`, checked against `SHA256SUMS`, whose signature by Ubuntu's image key `D2EB4462…7DB87C81` is verified |
| Guest kernel | `7.0.0-34-generic`; `rbd.ko` is in the base modules package and loads at boot | from the image |
| Kubernetes | k3s `v1.36.5+k3s1` (Kubernetes 1.36.5, inside Ceph-CSI v3.18.0's tested 1.34–1.36) | binary and `install.sh` by SHA-256 |
| Ceph | Tentacle `20.2.4` (2026-08-19 security release, CVE-2025-30156 and three others) | `quay.io/ceph/ceph@sha256:6bb1c8a4…` for every daemon; `cephadm` 20.2.4 by SHA-256 |
| Ceph-CSI | `v3.18.0` RBD driver | `quay.io/cephcsi/cephcsi:v3.18.0@sha256:0a92e5c8…` |
| CSI deployment | Ceph-CSI Operator `v1.1.0` | `install.yaml` by SHA-256, operator image by digest |
| CSI sidecars | csi-provisioner v6.3.0, csi-attacher v4.13.0, csi-resizer v2.2.1, node-driver-registrar v2.18.0 (the tags of Ceph-CSI v3.18.0's own manifests) | by digest |
| Smoke-test image | `python:3.13-trixie` (Python 3 and Git for the probe payload) | by digest |

Ceph-CSI v3.18.1 (2026-10-01) exists and is what Operator v1.1.0 deploys by default; the lab
overrides the plugin image with v3.18.0, the version the contract and this task name. v3.18.1
changes only an unpublish corner case (success when the backing image is already gone) and an
image build pin.

## Departures from the contract baseline

| Contract baseline | Lab | Why |
| --- | --- | --- |
| External Ceph supplied by a storage owner | Ceph in the same VM, deployed by cephadm with podman, independent of k3s | No storage owner or cluster exists; the owner authorized building one inside the VM. k3s reaches it like any external cluster (MON at 10.0.2.15:6789). |
| CRUSH failure domain from the storage owner (`host` or wider) | Failure domain `osd`; pool size 3, `min_size` 2 | One host. The contract forbids a single copy (`size 1`/`min_size 1`), so three OSDs keep three replicas; they share one VM and one physical HDD, so the replicas exercise replication and degraded-I/O rules but protect against no hardware failure. |
| Distro Ceph packages | Upstream 20.2.4 container image under cephadm | Ubuntu 26.04's own Ceph is 20.2.0 with only an RGW fix (2026-10-05); it lacks the CephX fix that introduced `aes256k`. download.ceph.com has no 26.04 packages. |
| Direct Ceph-CSI install "following its pinned Operator instructions" | Ceph-CSI Operator v1.1.0 with an image set ConfigMap pinning v3.18.0 and the sidecars | v3.17+ recommends the operator; Helm is deprecated in v3.18. |
| `clusterID`: conventionally the FSID | The FSID, which is also the ClientProfile's name | With the operator a StorageClass's `clusterID` must equal a ClientProfile name; naming the ClientProfile after the FSID satisfies both. |
| Separate storage and compute nodes | Kernel RBD client and OSDs share one kernel | A mapped RBD device whose OSDs stop first hangs shutdown. `orbit-lab-rbd-release.service` runs after k3s stops and before Ceph stops: it stops the Pods' containers, unmounts RBD filesystems and unmaps the devices. |
| — | No snapshot sidecar (`snapshotPolicy: none`) | No VolumeSnapshot CRDs or controller are installed; the contract's backups are not CSI snapshots. |
| — | Unattended upgrades off in the guest | Versions stay as pinned during tests. Security updates mean changing the pins and rebuilding. |

The repository's live probe `ceph-rbd-verify.py` cannot run here as it is: its actual-environment
check requires two distinct nodes, a deployed admission guard and a fencing procedure, which this
lab does not have. The smoke test reuses its in-Pod payload `ceph-rbd-payload.py` instead, and the
StorageClass and PVCs are rendered from the repository's templates by `ceph_rbd.render`.

## Names

| What | Value |
| --- | --- |
| VM, Kubernetes node, kubeconfig context | `orbit-mr-lab` |
| kubeconfig | `/mnt/data/managed-runner-lab/kubeconfig.json` (0600, JSON as the manager profile expects); context `orbit-mr-lab`, cluster `orbit-mr-lab`, user `orbit-mr-lab-admin` (k3s admin client certificate, cluster-admin), server `https://127.0.0.1:16443`, default namespace `orbit-mr-test` |
| Test namespace | `orbit-mr-test` |
| StorageClass | `runner-data` (not default; the k3s local-path class is disabled, so it is the only class) |
| Ceph pool | `orbit-mr-rbd`: replicated, size 3, `min_size` 2, 32 PGs, application `rbd` |
| Ceph FSID / CSI `clusterID` | New on every `create.sh`; read it from `state/facts.json`. The current one is `12b3f1b2-c9ec-11f1-80c0-525400123456`. |
| CSI | namespace `ceph-csi-operator-system`; Driver `rbd.csi.ceph.com`; CephConnection `orbit-mr-lab-ceph` (monitor `10.0.2.15:6789`); ClientProfile named after the FSID; image set ConfigMap `orbit-mr-lab-images` |
| CephX identity of the CSI driver | `client.orbit-mr-csi`: `mon 'profile rbd'`, `osd 'profile rbd pool=orbit-mr-rbd'`, `mgr 'profile rbd pool=orbit-mr-rbd'` |
| CSI Secret | `ceph-csi-operator-system/orbit-mr-csi-rbd` (`userID`, `userKey`), referenced by the StorageClass for provisioner, controller publish, controller expand and node stage |
| SSH | `ssh -i /mnt/data/managed-runner-lab/ssh/id_ed25519 -p 16222 ubuntu@127.0.0.1` |

The CSI key goes from `ceph auth print-key` straight into `kubectl create secret` inside the guest
and is compared with the Secret by hash. It is never printed, logged, written to the host or kept
anywhere else; k3s runs with `secrets-encryption: true`. The kubeconfig holds the cluster-admin
client key of this lab only.

**CephX keys.** A fresh 20.2.4 cluster creates `aes256k` keys and accepts nothing else: the monitor
map reads `auth_allowed_ciphers aes256k` and `auth_service_cipher aes256k`, and both the admin and
the CSI key carry key type 2 (`CEPH_CRYPTO_AES256KRB5`) in their header. Upstream Linux reads
`aes256k` keys from 7.0 on, so the guest's 7.0.0-34 kernel maps RBD images with the CSI key as it
is, with no downgraded key; the smoke test's `/dev/rbd0` mounts prove it. Ceph-CSI v3.18.0's
client libraries (Tentacle packages in its Rocky Linux 10 image) provision with the same key.

## Access modes

| Mode | Result here |
| --- | --- |
| `ReadWriteOnce`, `Filesystem`, ext4, kernel mounter | The baseline (GA in Ceph-CSI v3.18.0). Provisioned, attached, mapped as `/dev/rbd0` and mounted ext4. |
| Second Pod, same node, same RWO claim | **Admitted and running.** A differently named, unlabelled Pod mounted the same `/dev/rbd0` filesystem, wrote a file and the first Pod read it; one VolumeAttachment served both. RWO restricts nodes, not Pods, which is why the contract does not accept RWO as single-Pod protection: the same-node part of criterion 2 needs the admission guard (C2b) and T02's evidence. |
| `ReadWriteOncePod` | For comparison only (RBD RWOP is Alpha in Ceph-CSI v3.18.0, so not the baseline): the scheduler kept the second Pod `Pending` ("PersistentVolumeClaim with ReadWriteOncePod access mode already in-use by another pod"). |
| `ReadWriteMany` filesystem, `Block` mode | Not tested; RBD filesystem volumes are not RWX and the contract uses neither. |

## Resources and memory

| Limit | Value |
| --- | --- |
| Guest | 4 vCPU, 6144 MiB RAM; no swap inside the guest |
| Unit `orbit-mr-lab.service` | `MemoryMax=6656M` (guest RAM plus qemu's own memory), `OOMScoreAdjust=1000` (under host-wide memory pressure the kernel's OOM killer picks the VM first, ahead of processes in the runner's cgroup, whose `OOMPolicy=stop` would stop every session), `CPUQuota=400%` |
| Boot guard | `start.sh` refuses to boot when the host's `MemAvailable` is below 2048 MiB (`LAB_MIN_AVAILABLE_MIB`) and says why |
| Disks | root 40 GiB qcow2 overlay on the verified image; three 20 GiB qcow2 OSD disks; all thin, `cache=none`, on the /mnt/data HDD |
| Ceph | `osd_memory_target` 896 MiB per OSD (the smallest value Ceph accepts), autotune off; `mon_memory_target` 512 MiB; one mon, one mgr; no dashboard, monitoring stack, ceph-exporter or device monitoring; mgr modules `nfs` and `nvmeof` off |
| k3s | traefik, servicelb, metrics-server, local-path and the Helm controller disabled; kubelet `system-reserved` cpu 1, memory 3 GiB (Ceph runs outside the kubelet's accounting), hard eviction below 256 MiB |
| Returning memory | virtio-balloon free page reporting, at 32 KiB granularity (`page_reporting_order` 3; the default 2 MiB returned almost nothing of a busy guest's free memory), and clean page cache dropped at the end of `create.sh` and `start.sh` and every 5 minutes by `orbit-lab-drop-caches.timer` |

### Memory measured

Figures in MiB from 2026-10-17: the unit's cgroup (`memory.current`, `memory.swap.current`), the
guest's own statistics through the balloon, and the host's `/proc/meminfo`. Other sessions kept
running on the host throughout, so the host's `MemAvailable` also moved on its own; the unit's
figures are the VM's footprint.

| Moment | VM in host RAM | VM pages in host swap | Guest used / page cache / free | Host `MemAvailable` |
| --- | --- | --- | --- | --- |
| VM off, after `stop.sh` (05:44:53) | – | – | – | 7942 |
| `start.sh` finished: healthy, page cache dropped (05:46:19) | 2761 | 66 | 1293 / 682 / 4146 | 5475 |
| Idle, 5 minutes later (05:51:32) | 987 | 1414 | – / 691 / 4116 | 6340 |
| Idle, 10 minutes later (05:56:38) | 1242 | 1168 | 1364 / 846 / 3946 | 7053 |
| Just before and after the final `stop.sh` (05:57:15, 05:57:30) | 1303 | 1116 | – | 7128 → 8623 |
| End of a from-scratch `create.sh`, before it dropped the page cache (05:38:35) | 3522 (peak 3631) | 2604 | – / 4142 / 200 | 4217 |
| First smoke run, which pulls the 1 GB probe image (05:40:48) | 956 (peak 4878) | 4971 | – / 3963 / 321 | 5645 |

- At rest the VM costs the host about 2.0–2.8 GiB (host RAM plus host swap): the guest's ~1.35 GiB
  in use, its page cache and some free memory not yet reported. Switching it off gave the host
  about 1.5 GiB of `MemAvailable` back at that moment.
- In use inside the guest at rest (MiB): k3s server 523, ceph-mgr 214, containerd 171, three OSDs
  84–87 each, coredns 63, ceph-mon 61, Ceph-CSI and its operator about 395 together.
- Image pulls fill the guest's page cache to ~4 GiB within minutes. Before `create.sh` and
  `start.sh` dropped it at their end, that took the VM to 4.9 GiB of host RAM and the host into
  swap; now the timer drops it every 5 minutes as well. Expect the same spike while a later task
  pulls its runner image.
- Left for later workloads: the node's allocatable is 3 CPU and 2592 MiB of memory (the 3 GiB
  `system-reserved` covers Ceph, k3s and the OS, about 1.4 GiB at rest, plus OSD cache growth under
  load); the guest has ~4.5 GiB available at rest.
- Disk: the root overlay held 5.4 GiB and each OSD disk about 0.43 GiB after the first build.
- Timings of the from-scratch rebuild: `destroy.sh` 15 s; `create.sh` 517 s (SSH 23 s after boot,
  packages 43 s, Ceph bootstrap with three OSDs and the pool 5.5 min, k3s 12 s, Ceph-CSI 1.5 min);
  `smoke.sh run` 128 s; `stop.sh` 15–22 s; `start.sh` to healthy 81–114 s.

## Operating the lab

All scripts run as root on HPC from the repository checkout, and only touch this VM and
`/mnt/data/managed-runner-lab`.

| Script | What it does |
| --- | --- |
| `create.sh` | Builds the lab, or finishes an interrupted build: verified downloads, disks, cloud-init seed, boot (through `start.sh`), guest packages, Ceph, k3s, kubeconfig, Ceph-CSI, StorageClass, namespace, facts, a page-cache drop, health. Each step skips what exists, so rerun it after any failure. Leaves the VM running. |
| `start.sh` | Boots the VM as `orbit-mr-lab.service` behind the memory guard, waits until `status.sh` reports healthy and drops the guest's page cache (`--no-wait` returns after SSH). |
| `stop.sh` | ACPI shutdown through QMP and a wait for qemu to exit (15–22 s measured); `--force` stops the unit after the timeout. Use it, not `systemctl stop`, which cuts the power. |
| `status.sh` | Host boundary (kernel modules, listening sockets), unit memory, guest memory through the balloon, Ceph health, k3s node, Ceph-CSI workloads, StorageClass and namespace; exit 1 when running but unhealthy, `--wait SECONDS` to wait for health. |
| `smoke.sh run` / `smoke.sh verify RUN_ID` | The storage smoke test below; reports go to `state/smoke-RUN_ID.json`. |
| `destroy.sh --yes-destroy-lab` | Shuts down and deletes the disks (all Ceph and PVC data), seed, SSH key and kubeconfig; keeps downloads, logs and earlier reports (`--purge` removes everything). |

A test window:

```sh
sudo scripts/managed-runner/lab/start.sh            # refuses below 2 GiB MemAvailable
K="/mnt/data/managed-runner-lab/bin/kubectl --kubeconfig /mnt/data/managed-runner-lab/kubeconfig.json --context orbit-mr-lab"
$K get nodes
$K -n orbit-mr-test get pvc
ssh -i /mnt/data/managed-runner-lab/ssh/id_ed25519 -p 16222 ubuntu@127.0.0.1 sudo cephadm shell -- ceph -s
sudo scripts/managed-runner/lab/stop.sh             # leave it off between test windows
```

Pass `--kubeconfig` and `--context` on every command; never point another tool at a default or
current context. A Pod reaches a test service on the host at `10.0.2.2:<port>` (for example a test
apiserver for the runner image, or an admission webhook served from the host); the host reaches the
VM only through the two forwarded ports. Images are pulled from the internet through the same NAT.

## Smoke verification

`smoke.sh run`, then `stop.sh`, `start.sh` and `smoke.sh verify`, ran on the first build (run
`lab-20261017051258`) and again after `destroy.sh` and a from-scratch `create.sh` (run
`lab-20261017053840`, FSID `12b3f1b2-…`), with the same results. The Pods run as UID 1000 with a
read-only root filesystem and the repository's `ceph-rbd-payload.py` from a ConfigMap.

| Check | Result (both runs) |
| --- | --- |
| PVC from `runner-data` (rendered from `storage/pvc.template.json`) | Bound at once; PV `ReadWriteOnce`, `Filesystem`, ext4, `Retain`, driver `rbd.csi.ceph.com`, mounter `rbd`, pool `orbit-mr-rbd`, image `csi-vol-…`, `clusterID` the FSID; in the Pod `/var/lib/orbit` is `/dev/rbd0` ext4 |
| Writer | The payload wrote its ordinary file, a Git repository and SQLite rows in WAL mode with `synchronous=FULL` (111 and 104 committed rows), and the test added 32 MiB of random data; after quiescing, `PRAGMA integrity_check` returned `ok` |
| Pod deleted and recreated | The node unmapped the RBD device after the deletion; the new Pod found the same ordinary-file SHA-256, Git commit (fsck clean), every committed row (equal row hash), the same random-file SHA-256, and `integrity_check` `ok` |
| Second Pod, same node, same RWO PVC | Admitted and `Running`; it wrote a file the first Pod read; one VolumeAttachment (see Access modes) |
| `ReadWriteOncePod` claim, second Pod | `Pending`, refused by the scheduler |
| VM stop and start | `stop.sh` took 15–22 s; in the guest journal `orbit-lab-rbd-release` stopped the containers, unmounted the staging mount and unmapped `rbd0` before Ceph stopped. After `start.sh` the kubelet restarted the Pod on the same PVC: same hashes, same rows, `integrity_check` `ok` |

Reports are in `/mnt/data/managed-runner-lab/state/smoke-RUN_ID.json` (the first build's moved to
`logs/state-destroyed-…/` when it was destroyed). The last run's two claims stay in `orbit-mr-test`
as retained test data: `mr-data-640deaf2-…` (RWO, with the probe data) and `mr-data-13282595-…`
(RWOP). Deleting a claim leaves a released PV and its RBD image (`Retain`).

## Known limits

- **One physical machine, one node, one failure domain.** The multi-node parts of criterion 2
  (mounting on a second node, refusing duplicate Pods across nodes, takeover after the old node
  stops or is fenced) and criterion 8's cross-node migration cannot be verified here; they wait for
  a multi-machine cluster or another decision by the owner. Single-machine evidence must not be
  presented as covering them. Criteria 3–7 and the single-node parts of 2 and 8 can be tested here.
- No admission guard, fencing procedure, Rook or CSI snapshots are installed; T02 and C2b's
  admission work brings the guard. `ceph-rbd-verify.py`'s live phases need two nodes.
- The three replicas share one VM and one HDD: no durability against hardware failure, and I/O is
  bound by that disk.
- Kernel RBD and OSDs share one kernel. Shutdown ordering is handled; severe memory pressure inside
  the guest can still stall RBD I/O, the reason production keeps them apart.
- The host can swap guest memory when the host itself runs short (it did during the first
  provisioning); the VM then slows down. `OOMScoreAdjust=1000` makes the VM, not the runner, the
  host OOM killer's first choice.
- The kubeconfig is k3s's cluster-admin. Later tasks create least-privilege identities (the manager
  ServiceAccount, the admission webhook's caller) themselves.
- Recreating the lab gives a new FSID and new keys; read `state/facts.json` after `create.sh`.
