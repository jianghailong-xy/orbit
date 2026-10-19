# Managed runner single-machine lab

A disposable test environment for the managed runner project: one KVM virtual machine on the HPC
host (Orbit runner `workstation-gpu`) running k3s, a single-host Ceph cluster and Ceph-CSI RBD, and
since 2026-10-19 a second, smaller VM that joins it as a second k3s node ([Two nodes](#two-nodes-l1)).
The owner authorized the first VM on 2026-10-17 as the project's "authorized isolated test
environment", limited to one machine, one node and one failure domain. On 2026-10-19 they added the
second VM, so that one volume can move between two nodes; it is still one physical machine and one
failure domain. The lab changes nothing on the host beyond its own files and its own transient
systemd units, it is off unless a test window needs it, and it does not enable managed runners
anywhere: the server switch stays off by default, and no default entry point (root Compose,
`.env.example`, `/upgrade`, release, install or start scripts) refers to it.
[The design contract](managed-runner-design.md) is the baseline; this page records how the lab
follows it and where it departs from it.

The scripts are in [`scripts/managed-runner/lab/`](../scripts/managed-runner/lab/), with every
version and checksum pinned in [`lab.env`](../scripts/managed-runner/lab/lab.env).

## Architecture

```text
HPC host (Debian 13, kernel 6.12, ~15 GiB RAM, shared by every Orbit session)
  orbit-runner-root.service ............ the Orbit runner and its sessions (not touched)
  orbit-mr-lab.service (transient) ..... first VM's qemu, its own cgroup in system.slice:
  |                                      MemoryMax 6656M, OOMScoreAdjust 1000, CPUQuota 400%
  |  127.0.0.1:16222 -> guest :22    (SSH)          QEMU user network (slirp): no bridge,
  |  127.0.0.1:16443 -> guest :6443  (k3s API)      no tap, no firewall change; the guest
  |  127.0.0.1:16230 (listens) .. the link          reaches host services at 10.0.2.2
  orbit-mr-lab-2.service (transient) ... second VM's qemu (two-node mode only), system.slice:
  |                                      MemoryMax 3584M, OOMScoreAdjust 1000, CPUQuota 200%
  |  127.0.0.1:16223 -> guest :22    (SSH)          its own QEMU user network
  |  -> 127.0.0.1:16230 (connects) .. the link: a QEMU socket netdev, Ethernet frames between
  |                                   the two qemu processes over one loopback TCP connection
  /mnt/data/managed-runner-lab/ (0700) .. every disk, key, log and kubeconfig of the lab

Guest orbit-mr-lab (Ubuntu 26.04.1 LTS, kernel 7.0.0-34-generic, 4 vCPU, 6 GiB)
  user network 10.0.2.15, link lablink0 10.77.0.1/24
  Ceph 20.2.4 under cephadm/podman ...... 1 mon, 1 mgr, 3 OSDs on vdb/vdc/vdd (one virtual disk
  |                                       each on /mnt/data), all on 10.77.0.1; outside
  |                                       Kubernetes, so for k3s an external Ceph test backend
  k3s v1.36.5 server, node 10.77.0.1 .... Ceph-CSI Operator v1.1.0 -> Ceph-CSI v3.18.0 RBD driver
                                          StorageClass runner-data, namespace orbit-mr-test

Guest orbit-mr-lab-2 (same image and kernel, 2 vCPU, 3 GiB), two-node mode only
  user network 10.0.2.15 (its own), link lablink0 10.77.0.2/24
  k3s v1.36.5 agent, node 10.77.0.2 ..... Ceph-CSI node plugin; kernel RBD client of the first
                                          VM's Ceph over the link; no Ceph of its own
```

Nothing of Kubernetes, Ceph or CSI is installed on the host, and the host loads no `rbd`, `nbd`,
`ceph` or `libceph` module: RBD devices are mapped by the guests' kernels. `status.sh` prints the
host's module list, each qemu process's listening sockets (only 127.0.0.1) and the link's one
connection. The host keeps only `kubectl` (v1.36.5, checksum-verified) in
`/mnt/data/managed-runner-lab/bin/`.

## Versions

| Component | Version | Pin |
| --- | --- | --- |
| Guest image | Ubuntu 26.04 LTS cloud image, release 20260927 (26.04.1), for both VMs | SHA-256 `8800651811af…7332b2`, checked against `SHA256SUMS`, whose signature by Ubuntu's image key `D2EB4462…7DB87C81` is verified |
| Guest kernel | `7.0.0-34-generic` in both VMs; `rbd.ko` is in the base modules package and loads at boot | from the image |
| Kubernetes | k3s `v1.36.5+k3s1` (Kubernetes 1.36.5, inside Ceph-CSI v3.18.0's tested 1.34–1.36): the server in the first VM, the same binary as the agent in the second | binary and `install.sh` by SHA-256 |
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
| External Ceph supplied by a storage owner | Ceph in the first VM, deployed by cephadm with podman, independent of k3s | No storage owner or cluster exists; the owner authorized building one inside the VM. k3s reaches it like any external cluster (MON at 10.77.0.1:6789, on the link). |
| Nodes on separate machines and a real network | Two VMs on one host, joined by a QEMU socket netdev over 127.0.0.1; Ceph's public network and the k3s nodes' addresses are the link's 10.77.0.0/24 | The owner's 2026-10-19 decision: a second node without a second machine or any change to the host's network. Cross-node attach, detach and mount are real; physical failures are not (one machine, one failure domain). |
| CSI controller plugin wherever the scheduler puts it | Pinned to the first VM by the Driver's `controllerPlugin.affinity` | The second VM is the one failed on purpose; with the provisioner and attacher on it, its hard stop would also stop every attach and detach. |
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
| Second VM, its Kubernetes node | `orbit-mr-lab-2` (unit `orbit-mr-lab-2.service`); no context of its own: the one kubeconfig and context serve both nodes |
| Link | `lablink0` in both guests (MAC `52:54:00:4c:00:01` and `…:02`), 10.77.0.1/24 and 10.77.0.2/24; the first qemu listens on 127.0.0.1:16230, the second connects |
| kubeconfig | `/mnt/data/managed-runner-lab/kubeconfig.json` (0600, JSON as the manager profile expects); context `orbit-mr-lab`, cluster `orbit-mr-lab`, user `orbit-mr-lab-admin` (k3s admin client certificate, cluster-admin), server `https://127.0.0.1:16443`, default namespace `orbit-mr-test` |
| Test namespace | `orbit-mr-test` |
| StorageClass | `runner-data` (not default; the k3s local-path class is disabled, so it is the only class) |
| Ceph pool | `orbit-mr-rbd`: replicated, size 3, `min_size` 2, 32 PGs, application `rbd` |
| Ceph FSID / CSI `clusterID` | New on every `create.sh`; read it from `state/facts.json`. The current one is `12b3f1b2-c9ec-11f1-80c0-525400123456`. |
| CSI | namespace `ceph-csi-operator-system`; Driver `rbd.csi.ceph.com`; CephConnection `orbit-mr-lab-ceph` (monitor `10.77.0.1:6789`); ClientProfile named after the FSID; image set ConfigMap `orbit-mr-lab-images` |
| CephX identity of the CSI driver | `client.orbit-mr-csi`: `mon 'profile rbd'`, `osd 'profile rbd pool=orbit-mr-rbd'`, `mgr 'profile rbd pool=orbit-mr-rbd'` |
| CSI Secret | `ceph-csi-operator-system/orbit-mr-csi-rbd` (`userID`, `userKey`), referenced by the StorageClass for provisioner, controller publish, controller expand and node stage |
| SSH | `ssh -i /mnt/data/managed-runner-lab/ssh/id_ed25519 -p 16222 ubuntu@127.0.0.1`; the second VM on port 16223 (same key) |

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
| Second guest | 2 vCPU, 3072 MiB RAM; unit `orbit-mr-lab-2.service` with `MemoryMax=3584M`, `OOMScoreAdjust=1000`, `CPUQuota=200%`; kubelet `system-reserved` cpu 250m, memory 512 MiB (no Ceph beside it), the same hard eviction |
| Boot guard | `start.sh` refuses to boot when the host's `MemAvailable` is below the floor of what it is about to boot, and says why: 2048 MiB for the first VM (`LAB_MIN_AVAILABLE_MIB`), 1536 MiB for the second (`LAB2_MIN_AVAILABLE_MIB`), 3584 MiB for both together |
| Disks | first VM: root 40 GiB qcow2 overlay on the verified image, three 20 GiB qcow2 OSD disks; second VM: root 30 GiB qcow2 overlay (`disks/node2-root.qcow2`); all thin, `cache=none`, on the /mnt/data HDD |
| Ceph | `osd_memory_target` 896 MiB per OSD (the smallest value Ceph accepts), autotune off; `mon_memory_target` 512 MiB; one mon, one mgr; no dashboard, monitoring stack, ceph-exporter or device monitoring; mgr modules `nfs` and `nvmeof` off |
| k3s | traefik, servicelb, metrics-server, local-path and the Helm controller disabled; kubelet `system-reserved` cpu 1, memory 3 GiB (Ceph runs outside the kubelet's accounting), hard eviction below 256 MiB |
| Returning memory | virtio-balloon free page reporting, at 32 KiB granularity (`page_reporting_order` 3; the default 2 MiB returned almost nothing of a busy guest's free memory), and clean page cache dropped at the end of `create.sh` and `start.sh` and every 5 minutes by `orbit-lab-drop-caches.timer` |

### Memory measured

The two-node figures of 2026-10-19 are in [Two nodes](#memory-measured-1). Figures in MiB from 2026-10-17: the unit's cgroup (`memory.current`, `memory.swap.current`), the
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
| `create.sh [--nodes 2]` | Builds the lab, or finishes an interrupted build: verified downloads, disks, cloud-init seeds, boot (through `start.sh`), guest packages, the link NIC, Ceph, k3s, kubeconfig, Ceph-CSI, StorageClass, namespace, facts, a page-cache drop, health. With `--nodes 2` it then builds the second VM: its disk and seed, boot, packages, link NIC, the join token, the k3s agent and the CSI node plugin on it. Each step skips what exists, so rerun it after any failure. A lab from before the link gets its Ceph and k3s moved onto it ([below](#moving-ceph-and-k3s-onto-the-link)). Leaves the VMs running. |
| `start.sh [--nodes 2]` | Single-node mode by default: boots the first VM as `orbit-mr-lab.service`. `--nodes 2` is two-node mode: the first VM if it is off, then the second as `orbit-mr-lab-2.service`; it also brings the second back after a hard stop. Behind the memory guard for what it boots, it waits until `status.sh` reports healthy, cordons the second node in single-node mode and uncordons it in two-node mode, and drops the guests' page cache (`--no-wait` returns after SSH). |
| `stop.sh [--node 2] [--hard]` | ACPI shutdown through QMP and a wait for qemu to exit, the second VM first (15–22 s measured for the first); `--force` stops a unit after the timeout. Use it, not `systemctl stop`, which cuts the power. `--node 2` stops only the second VM, cordoned first: back to single-node mode. `--node 2 --hard` kills the second VM's qemu with SIGKILL instead, for failure tests ([below](#a-hard-stop-of-the-second-node)). |
| `status.sh` | Host boundary (kernel modules, listening sockets, the link's connection), each unit's memory, guest memory through the balloon, both guests' health (Ceph, the link, Ceph reached from the second VM), every running VM's node Ready, Ceph-CSI workloads and the node plugin on each of those nodes, StorageClass and namespace; with the second VM off its node is reported, not required. Exit 1 when running but unhealthy, `--wait SECONDS` to wait for health. |
| `smoke.sh run` / `smoke.sh verify RUN_ID` | The single-node storage smoke test below; reports go to `state/smoke-RUN_ID.json`. |
| `two-node.py topology\|migrate\|hard-stop\|verify RUN_ID\|memory LABEL` | The two-node checks ([below](#two-nodes-l1)): one PVC moving between the nodes, the second node's hard stop and recovery, the data after a restart, memory; reports go to `state/two-node-RUN_ID.json`. |
| `destroy.sh --yes-destroy-lab [--node 2]` | Shuts down and deletes the disks (all Ceph and PVC data), seeds, SSH key and kubeconfig; keeps downloads, logs and earlier reports (`--purge` removes everything). `--node 2` deletes only the second VM's disk and seed and its node in the cluster; it holds no Ceph data. |
| `test-server.sh start [--managed\|--managed-false\|--managed-false-no-profile]\|stop\|status\|secrets` | The isolated test control plane on the host, all on 127.0.0.1 and outside the runner's cgroup with memory caps: PostgreSQL (container `orbit-mr-lab-pg`, port 15433), this checkout's apiserver (unit `orbit-mr-lab-api`, port 13710, built beforehand), a TLS front with a lab-only CA (unit `orbit-mr-lab-tls`, port 13711, the address Pods use: `https://10.0.2.2:13711`) and `fake-model.py` (unit `orbit-mr-lab-fake-model`, port 13712). Data, secrets and logs in `LAB_DIR/test-server`, or in `LAB_TEST_SERVER_DIR`, which keeps a task's database apart. `--managed` turns managed runners on with the profile `single-writer.py profile` wrote, `--managed-false` names the same profile with the switch explicitly `false`, `--managed-false-no-profile` sets `false` and names no profile (no Kubernetes or Ceph configuration at all); `secrets` only makes the secrets and the lab CA. |
| `single-writer.py` | The manager's own Pods in the lab ([below](#single-writer-protection-t02a)): the manager's ServiceAccount and least-privilege RBAC, the admission webhook (k3s's AdmissionConfiguration with the webhook's bearer token, and the repository's webhook template), the image import under its digest, the manager profile, and the checks: second Pods, outages, the probe payload inside the runner container, storage records, credential replay at the runner door, stopping the runner, a force delete and an incomplete fencing receipt. |
| `manager-lab.py` | The manager against real k3s ([below](#manager-reconciliation-t04)): the T04 server directory, a second apiserver replica, owners and their concurrent sign-ins and ensures, the database against k3s (`consistency`), a recorder of every change, a stand-in Claude login on a runner's volume, a killed runner process, an operator's delete or eviction, an API outage, a controller crash timed on a create, the switch checks and one owner against another. |
| `login-lab.py` | Sign-in provisioning on real k3s ([below](#sign-in-provisioning-t05)), through manager-lab.py's gate, replica and views: accounts and timed (concurrent) sign-ins, an account with its own runner and arranged workspaces, its landing by the web's own rule and its deep links, the switch-off check for new and existing accounts, a model key on fake-model.py's endpoint or the owner's key file, sessions in the managed default workspace, a provisioning timeline, the manager's requests by size, and a database trigger that refuses the sign-in's intent. |
| `api-gate.py` | A pass-through in front of the k3s API forward that only the test manager's kubeconfig names: it logs each connection's TLS record sizes, never decrypting them, and can lose one create's answer after k3s applied it (and the read-back's), or hold it while the controller is killed. |
| `qmp.py SOCKET hostfwd-remove\|hostfwd-add` | Takes the 127.0.0.1 forward of the k3s API (or SSH) away and puts it back: an outage of the API server for everything on the host. |
| `lab-ca-image.Dockerfile` | One layer on the product image: the lab CA in the system trust store, for the manager's Pod, which mounts no CA bundle. |
| `runner-image.py` | Runs the optional runner image in the lab: imports an image archive into the guest's containerd, enrolls once, starts, stops and recreates the runner Pod on one PVC, drives sessions and a landing on the test server, and hashes the persistent state; see [Runner image](#runner-image-t03). |
| `wake-lab.py` | Wake, sleep and capacity on real k3s ([below](#wake-sleep-and-capacity-t06)), through manager-lab.py's gate, replica, views and `kill-runner`: a profile with a budget of one runner and a 60 s idle interval, accounts with a fake-model key, a self-managed runner and its dispatch, every kind of demand (a turn, a session, a task's Run Now or run time, all at once), waits on a mapping or on an answer quoting a marker, data on the runner's volume, the administrator's disable, a ResourceQuota of zero Pods, the switch-off check for demand, and a recorder with its timeline. |
| `fake-model.py` | An Anthropic-dialect stand-in that answers turns with canned text and logs each request's history, for checks that must not depend on a model or a key. Its answers are not engine acceptance. `FAKE-SLOW`, `FAKE-BG` (a call of the runner's `bg_run`), `FAKE-WAKEUP` (`schedule_wakeup`), `FAKE-WRITE` (a call of Claude Code's own Bash tool that commits a file in the session's worktree), `FAKE-HOLD` (the answer to that tool's result held open, so the turn is still running) and `FAKE-APIERR` (an overloaded provider) in a message shape the answer; see its header. |
| `acceptance-lab.py` | The end-to-end run of task T08 ([below](#end-to-end-acceptance-t08)): two accounts through the switch unset, `false` and on, provisioning, capacity, sessions, busy and idle, wakes, Pod rebuilds, a controller restart, an image rollback, an independent RBD backup restored to a new PVC, and the switch off again, in one command that stops at the first failed check; `report` condenses a run, `secret-scan` checks its records. |
| `switch-lab.py` | Task T08b's run ([below](#a-restored-volume-back-under-its-runner-t08b)), on acceptance-lab.py's helpers: one account provisioned, data on its volume, an independent backup, the volume lost, the runbook's restore into a new claim under the runner's name, the administrator's volume switch and the wake on the restored claim, in one command that stops at the first failed check; `report` condenses a run. |
| `takeover-lab.py` | Task T02's run on the two nodes ([below](#cross-node-migration-and-takeover-t02)), on acceptance-lab.py's helpers: one account's runner moved to the other node through sleep and wake, Pods on its claim pinned to the other node, what RWO and RBD do alone, the second node's power cut while the runner writes there, the runbook's failover (receipt, out-of-service taint, finalizer) and the old node's return; it stops at the first failed check and goes on from a step (`--from-step`); `report` condenses a run, `secret-scan` checks its records. |
| `cross-node-lab.py` | Task T08x's run on the two nodes ([below](#two-accounts-across-two-nodes-t08x)), on takeover-lab.py's helpers: two accounts' runners moved to the other node (a message, a task run now), second Pods on each claim and Pods mixing the accounts, the second node's power cut with both runners on it (no Git work in the last minute, a last message to each session, one volume synced and one not), the runbook's failover for both with the runbook's own query and commands, the old node's return, and `kubectl drain` both ways; `--from-step`, `report` and `secret-scan` as above. |
| `durability-lab.py` | Task T02c's run on the two nodes ([below](#git-work-and-engine-sessions-through-a-power-cut-t02c)), on takeover-lab.py's and cross-node-lab.py's helpers: T07's leftover Pod released by the runbook's patch after its owner is confirmed, Git's commit costs on the runner class's storage, then one account's runner on the project line's image and one on this branch's: the runner's and the engine's Git work and a last turn in the last seconds, the second node's power cut, a copy of the volume's snapshot read before anything mounts it, the runbook's failover, the session resumed, the second node back; and a damaged volume woken on the fixed image. Its last phase, `again` (task D10), does the after run once more for a later runner change, with a new account. `--from-step`, `report` and `secret-scan` as above. |

A test window:

```sh
sudo scripts/managed-runner/lab/start.sh            # single-node mode; refuses below 2 GiB MemAvailable
sudo scripts/managed-runner/lab/start.sh --nodes 2  # or two-node mode; refuses below 3.5 GiB for both
K="/mnt/data/managed-runner-lab/bin/kubectl --kubeconfig /mnt/data/managed-runner-lab/kubeconfig.json --context orbit-mr-lab"
$K get nodes -o wide
$K -n orbit-mr-test get pvc
ssh -i /mnt/data/managed-runner-lab/ssh/id_ed25519 -p 16222 ubuntu@127.0.0.1 sudo cephadm shell -- ceph -s
sudo scripts/managed-runner/lab/stop.sh             # both VMs, the second first; leave them off between windows
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

## Runner image (T03)

Recorded 2026-10-17 by task T03. The optional runner image ([deploy/managed-runner](../deploy/managed-runner/README.md))
was built on the host and run in the lab through its **standalone enrollment path**: one owner
enrollment on the first start, then the identity retained on the volume on every rebuild. The
test server ran with `ORBIT_MANAGED_RUNNERS_ENABLED` unset, so the manager's own Pod, the
admission guard and generation-bound credentials are not part of this record (T02a, T04).

```sh
bash scripts/worktree-overlay.sh && npm run build -w @orbit/shared && npm run build -w @orbit/apiserver
sudo scripts/managed-runner/lab/start.sh && sudo scripts/managed-runner/lab/test-server.sh start
docker buildx build --file deploy/managed-runner/image/Dockerfile --build-arg ORBIT_SOURCE_SHA="$(git rev-parse HEAD)" \
  --output type=docker,dest=/mnt/data/image.tar,name=orbit-managed-runner:TAG .   # clean checkout; nothing is pushed
R=scripts/managed-runner/lab/runner-image.py
python3 $R import /mnt/data/image.tar          # into the guest's k3s containerd; the Pod uses imagePullPolicy Never
python3 $R owner && python3 $R enroll t03 && python3 $R start t03 --image docker.io/library/orbit-managed-runner:TAG
python3 $R workspace t03 && python3 $R provider t03 --fake    # or --key-file for a real key
python3 $R session t03 --provider SLUG --model deepseek-v4-flash --attach FILE --prompt TEXT
python3 $R snapshot t03 && python3 $R stop t03 && python3 $R start t03 --image ... && python3 $R snapshot t03
```

The Pod follows [runner-pod.yaml.example](../deploy/managed-runner/runner-pod.yaml.example) for the
standalone path: init container `init-volume` (root, `CHOWN FOWNER DAC_OVERRIDE` only), runner UID
10001 with a read-only root, no capabilities, `RuntimeDefault` seccomp, no service account token,
`restartPolicy: Never`, 240 s grace, an RBD claim `t03-data` (`runner-data`, RWO, 5 GiB) at
`/var/lib/orbit` and an `emptyDir` `/tmp`. It reaches the test server at `https://10.0.2.2:13711`; the
lab CA comes from a ConfigMap through `SSL_CERT_DIR`, which Go reads besides the image's public roots.

| Check | Result |
| --- | --- |
| Build | The image had never been built. The first build failed at `apt-get update` (the slim Node base has no OpenSSL CA file until the `openssl` package arrives), and the second produced `/usr/local/share/orbit` with mode 0644 (`COPY --chmod`), unreadable for UID 10001. Both are fixed. Builds took 101–170 s in a 5 GiB-capped buildx builder; the archive is 500 MB. Final image `r4-6bfe0a871`: manifest `sha256:7e20b93f…6d1ba`, config `sha256:feda0de7…b76`. Its `tool-versions.json`: Go 1.27.1, Node v26.10.0, Codex 0.158.0, Claude Code 2.1.300, git 2.47.3, Python 3.13.5, ripgrep 14.1.1, SQLite 3.46.1, tini 0.19.0. |
| Engine | The image had only Codex, and an Anthropic-dialect key (DeepSeek's) runs on `claude`, `opencode` or `dsh`: such a session failed as soon as it was claimed. Claude Code 2.1.300 is now in the image (native binary, `DISABLE_AUTOUPDATER=1`). |
| Git identity | A fresh volume had no git identity, so the runner's commits failed (`unable to auto-detect email address`), the `autoInitGit` baseline of a managed default workspace among them. The image now sets `Orbit Runner <runner@orbit.invalid>` in `/etc/gitconfig`: the runner's real `autoInitGit` baseline in a new workspace was authored with it, with no `GIT_*` variable set; a repository identity overrides it (build check and `image-smoke.py --fixture-git-identity`). |
| Import | `k3s ctr images import` of the archive: 37–39 s. The VM's unit grew to 3.6–3.9 GiB of host RAM (page cache), back to under 2 GiB a minute after `provision.sh trim`. |
| First start | 16.6 s from Pod creation to `Running` (init included); `orbit register` ran once, its doctor output took 8 s, then `orbit run`; the first real heartbeat came 30 s later (registration also stamps `lastHeartbeatAt`, so it alone proves nothing). `/var/lib/orbit` is ext4 on `/dev/rbd*`; home 0700, `config.json` 0600. |
| Recreation | Six recreations on the same claim and RBD image, two of them onto a newer image (r2 → r3 → r4): the same runner (public id and UUID), the same `enrolledAt`, `config.json` byte-identical (no token rotation), one runner of that name throughout. Pod `Running` in 6–17 s, first heartbeat 36–50 s after creation. Worktrees (with an uncommitted file), the workspace repository, `runs/*/meta.json`, Claude transcripts and the uploads of open sessions were byte-identical after each. |
| Wrong expected ID | Passing the owner API's public id as `ORBIT_RUNNER_EXPECTED_ID` made the entrypoint refuse to start (exit 1, no registration, no state change); it takes the UUID that `orbit-container check` prints, which the message now says. |
| Uploads | An attachment of a message turn lands in `uploads/<session>/` with its SHA-256; a shell turn downloads none. At the next start the runner removes the uploads of sessions that are no longer open (FAILED, ended): `gc: removed orphan uploads dir`. |
| Continuation | A session reclaimed after recreation (and after both image upgrades) resumed with `--resume`: its next request carried the whole earlier conversation, read from the transcript on the volume (checked with `fake-model.py`, which is not a model). |
| Drain, idle | SIGTERM to exit: 1.5–2.3 s; the idle sessions detach as resumable. |
| Drain, turn in flight | A turn held open for 60 s when SIGTERM came: the runner waited, the answer and `turn_end` reached the server, the session detached, exit 0 after 49.8 s. |
| Drain, turn too long | A turn held for 150 s: at the runner's 100 s deadline it was torn down (`interrupt`, reason `runner_restart`), exit 0 after 101.5 s; the session stayed `RUNNING`, and the next Pod re-delivered the turn, which completed. |
| Drain, landing in flight | A `LAND_TASK` integration job's merge check (330 s) was running when SIGTERM came. The runner stopped heartbeating at once (its last beat preceded the signal), detached its sessions, then waited for the job with no time limit: the kubelet killed it at the end of the 240 s grace (exit 137, Pod gone after 241.3 s). The server kept the job `RUNNING` until its heartbeat was 10 minutes old; the next Pod took it over 10 min 26 s after that heartbeat, ran it again from the start and landed it at 08:05:12, about 10.5 minutes later than it would have. The killed attempt's scratch worktree `_integrate-<job>` stayed on the volume until the rerun removed it. |
| Least privilege | In the runner: UID/GID 10001, every capability set empty, `NoNewPrivs`, seccomp filter, read-only root; no service account token, Docker socket, kubeconfig or credential variable; tini is PID 1 and `orbit run` gets only the fixed paths and update switches. |
| Real engine session | Pending: the owner's DeepSeek key file does not exist yet. |

## Single-writer protection (T02a)

Recorded 2026-10-17 by task T02a: the same-node part of criterion 2 with the manager's own Pods,
C2b's admission guard and generation-bound credentials, and D7's recovery rule. The records are in
[the evidence](evidence/managed-runner-single-writer-lab/2026-10-17/README.md). No model was used:
the runners stayed STARTING with `MODEL_UNAVAILABLE`, which the gate and the guard do not depend on.

```sh
export LAB_TEST_SERVER_DIR=/mnt/data/managed-runner-lab/test-server-t02a   # T03's database untouched
W=scripts/managed-runner/lab/single-writer.py
sudo scripts/managed-runner/lab/test-server.sh secrets                     # the lab CA the image trusts
docker buildx build ... --output type=oci,dest=product.oci.tar ...          # deploy/managed-runner/image, as for T03
docker buildx build --build-context base=oci-layout://DIR@sha256:... \
  --file scripts/managed-runner/lab/lab-ca-image.Dockerfile ...             # one layer: the lab CA
python3 $W import lab.tar && python3 $W identity && python3 $W profile --image REF
sudo scripts/managed-runner/lab/test-server.sh start --managed
python3 $W owner                              # sign-in provisions; without the guard: ADMISSION_GUARD_MISSING
python3 $W admission install && python3 $W retry
python3 $W contenders                         # ... payload, credential, signal, force-delete, receipt
python3 $W admission remove                   # before the test server stops
```

| Part | As set up |
| --- | --- |
| Manager | The test server's own manager, `ORBIT_MANAGED_RUNNERS_ENABLED=true` and a profile naming a separate JSON kubeconfig: ServiceAccount `orbit-mr-manager` in `orbit-mr-test` with `get`/`create`/`delete` on Pods and Secrets, `get`/`create` on PVCs, `get` on ConfigMaps, `get` on PVs and `list` on VolumeAttachments, nothing else (`auth can-i` checks in the record). Its username is the profile's `admission.managerUsername`. |
| Admission | k3s's API server runs with `--admission-control-config-file`, from a drop-in in `/etc/rancher/k3s/config.yaml.d` (`config.yaml`, which `provision.sh` rewrites, is untouched): its WebhookAdmissionConfiguration names a kubeconfig whose user `10.0.2.2:13711` holds the webhook's bearer token (0600 in the guest, only its hash in the profile). The ValidatingWebhookConfiguration is the repository template with the namespace, `https://10.0.2.2:13711/api/managed-runner/admission` and the lab CA; the API server reaches the test server's TLS front through the QEMU user network. |
| Image | The product image from deploy/managed-runner/image at the project tip, plus one layer adding the lab CA to the system trust store: the manager's Pod mounts only its claim, emptyDirs and its bootstrap Secret, and the guard refuses anything else, so the CA cannot come as a ConfigMap. `ctr images import --digests --base-name` names a digest reference, which the profile pins and the kubelet finds locally (no pull policy is set, so a digest reference is `IfNotPresent`); that digest is the archive's index, which holds the one built manifest. |

| Check | Result |
| --- | --- |
| Without the guard | The sign-in provisioned the PVC, its PV and generation 1's Secret, then the manager's dry-run probe was admitted and it stopped: `FAILED ADMISSION_GUARD_MISSING`, retryable, no Pod. After `admission install` the owner's retry started generation 1's Pod; the probe was refused by the guard. |
| Second Pod, same node, same claim | Refused, while the authorized Pod kept running (same UID, its writer committing rows, one VolumeAttachment, one RBD mount): an unlabelled Pod by the cluster admin (`NOT_THE_MANAGER`), the same by the manager's identity and a full copy of the authorized Pod under another name (`NOT_THE_FIXED_NAME`), the fixed name again (`NOT_RESERVED`), the fixed name for the next generation (`NOT_THE_RESERVED_GENERATION`), a Job's Pod (`FailedCreate`, `NOT_THE_MANAGER`), an ephemeral container mounting the volume (`EPHEMERAL_CONTAINER`). With the TLS front down every Pod create in the namespace was refused (`failed calling webhook`); with only PostgreSQL down, a Pod on the claim was refused and one with no claim admitted (its decision reads no row). |
| Generations | A SIGTERM to the runner (what the kubelet sends) ended the Pod `Succeeded`; the manager recorded the kubelet's report, deleted the Pod by UID, waited for the detach and started generation 2 on the same PVC in 11 s. After the VM restart the kubelet reported generation 2's runner stopped (exit 0) and generation 3 followed. Each older generation's credential was then refused 401 at heartbeat, claim and `GET /runner/me`; the current credential naming an older instance 403 `MANAGED_RUNNER_INSTANCE_SUPERSEDED`. |
| No stop proof | An operator's graceful `kubectl delete pod` and a force delete each left the mapping `FENCING` (`PREDECESSOR_STOP_UNPROVEN`) with its generation, recorded Pod, Secret, PVC and compute reservation kept and no new Pod, for 14 and 6 minutes until the end of the window; the credential was replaced (401), the owner's retry refused (409), an incomplete fencing receipt rejected field by field (`FENCING_RECEIPT_INVALID`), and the manager identity's fixed-name Pods refused (`NOT_RESERVED`). The graceful delete fenced because the kubelet's terminal report was in the API for about a second and the manager polls every 5 s. |
| Data | Ordinary file, Git commit (fsck clean), a 32 MiB random file and SQLite rows in WAL mode (`synchronous=FULL`) written inside the runner container: the same after the Pod's recreation as generation 2, and after the VM restart (written until the shutdown) every acknowledged row present, `integrity_check` `ok`, the earlier rows hashing as before. |

## Manager reconciliation (T04)

Recorded 2026-10-17 by task T04: the manager driving several owners' runners against the real k3s API server, with the
switch off and on, two replicas, lost answers, crashes, outages and a VM restart. The records are in
[the evidence](evidence/managed-runner-manager-lab/2026-10-17/README.md). No model was used: READY came from a stand-in
Claude login on the runner's volume (no access token, so no request leaves the runner), which is no engine acceptance.

```sh
export LAB_TEST_SERVER_DIR=/mnt/data/managed-runner-lab/test-server-t04
M=scripts/managed-runner/lab/manager-lab.py
python3 $M prepare --image docker.io/library/orbit-managed-runner-lab@sha256:...   # T02a's CA and token; identity; profile -> the gate
python3 $M gate start && sudo scripts/managed-runner/lab/test-server.sh start --managed && python3 $M replica start
python3 scripts/managed-runner/lab/single-writer.py admission install
python3 $M owner alice --no-signin && python3 $M signin alice --parallel 8 && python3 $M ensure alice --parallel 8 --replica
python3 $M consistency && python3 $M stand-in-login alice      # READY within the runner's 5-minute engine probe
python3 $M api-outage 150                                      # also: kill-runner, delete [--force], evict, cross-user A B
python3 $M gate arm --min-bytes 4000 --skip 1 --then 1         # the next Pod create's answer lost, and its read-back's
python3 scripts/managed-runner/lab/single-writer.py admission remove   # before the test server stops
```

| Check | Result |
| --- | --- |
| Switch unset and `false` | On a fresh database and with live managed objects: the server answers, sign-in provisions nothing, every managed write is 404 `MANAGED_RUNNER_DISABLED`, not one connection reaches the gate in 60–90 s, and no object in the namespace changes. On again, the managers resume from the stored identities. |
| Concurrent provisioning | 16 sign-ins and 16 ensures of two accounts across two replicas: one mapping, runner, workspace, PVC, Secret and Pod each; the gate saw one create of each, no duplicate even sent. |
| Lost answers, a crash | A PVC create and a Pod create whose answers were lost after k3s applied them were found by name and recorded on the next pass; a Secret create whose answer was held while both apiservers were SIGKILLed was adopted, same UID, by the restarted ones after the dead lease expired. |
| Outages | 150 s with no API forward: READY runners wrote and spent nothing; a STARTING runner spent no attempt (before this change it would have been FAILED in about 75 s). |
| Stops | A killed runner process, a VM restart (the kubelet reported both Pods stopped after the boot, exit 255), `kubectl delete`, an eviction and a force delete: each started the next generation by itself on the same volume, the old attachment gone first. A Pod gone with its finalizer stripped fenced. |
| Owners | Another owner's token and runner credential could not read, change or act as one owner's runner, workspace or instance; the guard refused Pods mixing their identities and volumes. |

The manager's Pods now carry the finalizer `orbit.dev/managed-runner-stop-report`. A managed Pod deleted while no manager
runs (the switch off, the test server stopped) stays Terminating until a manager records its stop, or until an operator
removes the finalizer by hand.

## Sign-in provisioning (T05)

Recorded 2026-10-17 by task T05: new accounts signing in on real k3s, through provisioning, a heartbeat and the default workspace,
to a first session. Also concurrent and repeated sign-ins, an existing account's landing and deep links, two provisioning failures
and their retries, and the switch unset and `false`. The records are in
[the evidence](evidence/managed-runner-login-lab/2026-10-18/README.md). The owner's DeepSeek key file did not exist, so every
session ran on a DeepSeek-preset model key whose endpoint is fake-model.py. That is the real key's code path, but not a model.

```sh
export LAB_TEST_SERVER_DIR=/mnt/data/managed-runner-lab/test-server-t05
L=scripts/managed-runner/lab/login-lab.py
python3 $L prepare --image docker.io/library/orbit-managed-runner-lab@sha256:...   # T02a's CA and token, T04's identity
python3 $L gate start && sudo scripts/managed-runner/lab/test-server.sh start      # switch unset; --managed-false; --managed
python3 $L off-check admin --label unset          # the first user, then new and existing accounts: nothing managed
python3 $L account vera && python3 $L veteran vera && python3 $L landing vera --save
python3 scripts/managed-runner/lab/single-writer.py admission install            # with --managed, and replica start
python3 $L account erin && python3 $L until erin STARTING --reason MODEL_UNAVAILABLE
python3 $L key erin --fake && python3 $L until erin READY       # or --key-file the owner's DeepSeek key
python3 $L session erin --prompt TEXT && python3 $L wait-session erin SESSION   # nothing named, as a client sends it
python3 $L signin hank --parallel 16 --replica && python3 $L gate-summary --since TS
python3 $L intent-fault on|off                    # a sign-in whose intent cannot be written
python3 scripts/managed-runner/lab/single-writer.py admission remove             # before the test server stops
```

| Check | Result |
| --- | --- |
| Switch unset and `false` | The deployment's first user, new accounts and an existing one (with its own runner, workspaces and a session) sign in as before. No mapping, runner, workspace or namespace object is written or changed, and every managed write is 404 `MANAGED_RUNNER_DISABLED`. The gate's first connection came only once the switch was on. The same with six mappings present, on the fixed build. |
| Model supply | A key-only account never became READY: Claude Code and Codex installed but signed out kept it `MODEL_UNAVAILABLE`, and the shared display offered no first session. Since `baea95083` the owner's own enabled model key counts, on both backends, and READY records its slug as `initialProvider` ([design record](managed-runner-design.md#implementation-record-sign-in-provisioning)). |
| A new account | Sign-in 201 in 47 ms. PVC, Secret and Pod within 5.4 s, the first heartbeat 47 s after the sign-in, READY 10 s after its key was added. The first session, with nothing named, started on the key, was claimed by the managed runner and answered. The workspace is on `/dev/rbd*` ext4 with its `autoInitGit` baseline. A fresh deployment's first user (the bootstrap) went the same way. |
| Concurrent and repeated | 16 concurrent first sign-ins over two replicas: one mapping, runner and workspace, and one PVC, Secret, admission probe and Pod create sent. Five later sign-ins left the mapping's revision as it was. |
| An existing account | Its workspaces, their order, the web landing and every deep link were unchanged through sign-in, a capacity wait, start, READY and the switch `false`. The managed default was added last, matched by nothing. |
| Failures | An intent the database refused, and a cluster without the admission guard (`FAILED`, `ADMISSION_GUARD_MISSING`): each sign-in still answered 201 with a working token. The next sign-in, or the owner's retry once the guard was back, made it READY, on the same PVC. A sign-in does not retry a FAILED mapping. |

## Wake, sleep and capacity (T06)

Recorded 2026-10-18 by task T06: a managed runner woken by messages, tasks and scheduled work, put to sleep when idle and only then,
on a budget of one runner, through failed starts, disabled accounts and the switch unset and `false`. The records are in
[the evidence](evidence/managed-runner-wake-lab/2026-10-18/README.md). The owner's DeepSeek key file did not exist, so every session ran on
a DeepSeek-preset key whose endpoint is fake-model.py (T05's way), which is not a model.

```sh
export LAB_TEST_SERVER_DIR=/mnt/data/managed-runner-lab/test-server-t06
W=scripts/managed-runner/lab/wake-lab.py
python3 $W prepare --image docker.io/library/orbit-managed-runner-lab@sha256:...   # T02a's CA and token, T04's identity; budget: one runner
python3 $W gate start && sudo scripts/managed-runner/lab/test-server.sh start    # unset: the bootstrap, then accounts without sign-in
python3 $W account root && python3 $W account amy --no-signin && python3 $W selfhost root && python3 $W selfhost-dispatch root --label unset0
sudo scripts/managed-runner/lab/test-server.sh start --managed                    # after stopping the apiserver unit
python3 scripts/managed-runner/lab/single-writer.py admission install && python3 $W replica start && python3 $W record start
python3 $W account amy && python3 $W key amy && python3 $W until amy READY
python3 $W session amy --prompt "T06-AMY-S1 ..." && python3 $W answered amy T06-AMY-S1 && python3 $W probe amy write p1
python3 $W until amy SLEEPING && python3 $W message amy SESSION --prompt "T06-AMY-M1 ..." && python3 $W answered amy T06-AMY-M1
python3 $W task amy --prompt "T06-..." --run-now          # or --run-at-seconds S; a session with "FAKE-WAKEUP 240 WORD" for a wakeup
python3 $W burst amy --prompt T06-AMY-BURST --messages S1,S2 --sessions 2 --tasks 2
python3 $W quota on|off && python3 $W action amy retry && python3 $W disable ben on|off
python3 $W off-check --label unset --seconds 330 --message ben:SESSION --task ben    # with the switch unset, then false
python3 scripts/managed-runner/lab/single-writer.py admission remove                  # before the test server stops
```

| Check | Result |
| --- | --- |
| Scale to zero | 22 sleeps: the drain 60 s after the last work by the runner's own count, the runner's acceptance at its next heartbeat, its exit 0, the kubelet's report as the stop proof, the Pod removed, the volume detached; 35–41 s from the drain request to SLEEPING. The next start always on the same PVC, PV, RBD image, runner row and workspace (generations 1 → 17). |
| Three kinds of wake | A message (answered 3.9 s after it was sent), a task's Run Now (17 s), a held wakeup (13 s after due), a task's run time (29 s after it). READY follows ~30 s after the Pod runs, at the woken instance's first heartbeat; the instance claims before that. |
| No sleep while busy | Through a 150 s turn and a 180 s runner-hosted background job, the runner stayed READY and the owner's sleep was refused `409 MANAGED_RUNNER_BUSY`; the job ran out (`completed`, exit 0) and only then did the runner sleep. |
| Demand | Eight demands at once: one start, one Pod create. A message as the drain began called it off (`DEMAND`). |
| Failed starts | A runner killed while starting was restarted by itself (D7: attempt 1 of 5, the next generation on the same volume). A ResourceQuota of zero Pods failed the start `KUBERNETES_FORBIDDEN`; with the quota gone the owner's retry ran the waiting message. |
| Capacity | A new account and a wake each waited (`MANAGED_RUNNER_CAPACITY_UNAVAILABLE`, "Waiting for capacity") with nothing created, and started within seconds of the other runner's release. Never more than one managed Pod. |
| Background work | A retry due while asleep woke the runner and was re-armed with no attempt spent until READY; one armed retry waited 15.7 minutes through the switch-off phases on the offline path, then ran. |
| The finding | A woken runner's first run was finalized `runner offline` by the reaper, whose heartbeat was from before the sleep. Since this task the reaper counts the run's claim as presence (`reaper.service.ts`). |
| Disabled accounts | A waiting mapping went to sleep with nothing made; a running one drained and slept 37–39 s after the disable, its PVC kept; demand while disabled was recorded and woke nothing; enabled again, the waiting work woke it on the same PVC and runner row. |
| Switch unset and `false` | Messages, Run Now, held wakeups, run times and an armed retry: no mapping, pool or namespace change and no connection to the gate for 330 s each; owner writes `404 MANAGED_RUNNER_DISABLED`; a running instance kept serving as any runner and was never drained; a self-managed runner's dispatch worked. On again, the waiting work woke the runner. |

## Wake and capacity follow-ups (T06b)

Recorded 2026-10-18 by task T06b: three of T06's findings, fixed and checked on the lab's real k3s with a budget of one
runner. The records are in [the evidence](evidence/managed-runner-wake-followups/2026-10-18/README.md). The owner's
DeepSeek key file still did not exist, so the sessions ran on fake-model.py as a DeepSeek-preset key, which is not a model.
The runner image was rebuilt from the task's commit (deploy/managed-runner/image unchanged, plus the lab CA layer) and
imported into the guest; nothing was pushed.

```sh
export LAB_TEST_SERVER_DIR=/mnt/data/managed-runner-lab/test-server-t06b   # T06's database untouched
W=scripts/managed-runner/lab/wake-lab.py; K=docs/evidence/managed-runner-wake-followups/2026-10-18/kit
python3 scripts/managed-runner/lab/single-writer.py import lab.oci.tar && python3 $W prepare --image REF
python3 $W gate start && sudo scripts/managed-runner/lab/test-server.sh start && python3 $W account root
sudo scripts/managed-runner/lab/test-server.sh start --managed                   # after stopping the apiserver unit
python3 scripts/managed-runner/lab/single-writer.py admission install && python3 $W record start
sudo systemd-run --unit=orbit-mr-lab-t06b-beats $K/beats.sh                     # heartbeat, claim and state stamps
python3 $W account amy && python3 $W key amy && python3 $W session amy --prompt "T06-B-..."   # wakes: session, message, task
python3 $W account ben && python3 $W key ben && python3 $K/t06b.py first-session ben --prompt "T06-B-BEN-S1 ..."
python3 $W quota on && python3 $W message amy SESSION --prompt "T06-B-AMY-Q1 ..." && python3 $W quota off
python3 $K/timings.py beats.jsonl timeline.jsonl                                # per generation: beat, claim, READY
```

| Check | Result |
| --- | --- |
| Heartbeat before the first claim | Five wakes of amy (a new session, a message, a task's Run Now behind a capacity wait, a message behind a quota wait, a message) and ben's first start: the instance's first heartbeat came 0.03–0.21 s before its first claim every time, and READY 1.1–5.0 s after that claim, the manager's 5 s poll. T06 had READY about 30 s after the first claim. The first beat now waits for the engine probe: it came about 8 s after `orbit run` started. A woken instance's first claim waits for that beat, so it now comes later than T06's 0.2–5 s after the Pod ran. |
| A self-managed runner | The same build of the runner, run on the host as a self-managed runner of the test server: it claimed its queued session 0.09 s after it started, before any heartbeat of its own, and its first tick came 30.0 s after the start. The one beat between them (4.5 s after the start) was an existing trigger: the engine re-probe after that session failed on a missing Claude Code. |
| A namespace quota | A ResourceQuota of zero Pods, then a message to amy asleep. Her Pod create was refused 403 `exceeded quota`, and she waited in STARTING with `KUBERNETES_QUOTA_EXCEEDED` and the quota's sentence (no Retry offered) for 2 minutes. She was asked again every 30 s with no attempt spent and never failed, and it was logged once. Before this change it went FAILED `KUBERNETES_FORBIDDEN`. With the quota removed, the next retry made the Pod about 4 s later, with no retry from the owner, and the message was answered. |
| A new account's first session | ben signed in while amy held the one slot: WAITING_CAPACITY, his runner never having reported its engines, his default workspace already on his key (`deepseek-2`). His first session with nothing named, and one naming the key, were queued (201 PENDING, on the key). Before this change both answered 409 `MODEL_UNAVAILABLE`. One on Claude Code's own sign-in was still refused 409. When amy slept, ben was admitted. He was READY on the key 15.6 s after STARTING, and both sessions were answered 1.4–1.5 s after READY. |

## The three clients (T07)

Recorded 2026-10-18 by task T07: the web, iPhone and Mac apps against the lab's test server. The run covered:

- the switch unset, `false`, missing and on;
- new accounts' first sessions, sleep and wake;
- a crash loop and an out-of-memory loop, each with its Retry;
- a namespace quota, a held volume and a deleted volume;
- an environment the server cannot use;
- the Docker-only states, on the host's real Docker.

The records are in [the evidence](evidence/managed-runner-clients-lab/2026-10-18/README.md). The owner's DeepSeek key file still did not
exist, so every session ran on fake-model.py as a DeepSeek-preset key (T05's way), which is not a model. The runner image
was T06b's, already in the guest. Nothing was built or pushed.

- **Web, live.** This checkout's web build was served same-origin on 127.0.0.1 (`kit/serve-web.mjs`), passing `/api`
  through to the test server; a second instance answers the capability route 404, as a server from before it would.
  It ran in headless Chromium on the host (`kit/t07web.mjs`), one browser per account, each signed in through the login
  page. The observer takes a picture and writes a line each time the managed notice, the composer or the answers
  change, and it sends the presses (send, Retry) from command files.
- **iPhone and Mac, replayed.** No Mac can reach the host, and the coordinator chose replay over a tunnel. A recorder
  (`kit/t07rec.py`) asked the test server, as each account, every request the two apps make on these screens, on the
  apps' cadences or faster. It also sent the apps' own writes (a first session from the draft, a message, Retry) in
  their request shapes. Scenes are windows of those recordings. The probe on GitHub's macos-26 replays each to the real
  apps (`kit/replay.py`), failing on any request it does not hold and on any write whose key fields differ.

```sh
export LAB_TEST_SERVER_DIR=/mnt/data/managed-runner-lab/test-server-t07     # T03–T06b's databases untouched
W=scripts/managed-runner/lab/wake-lab.py; K=docs/evidence/managed-runner-clients-lab/2026-10-18/kit
python3 $W prepare --image REF && python3 $K/t07lab.py profile                # one runner, 60 s idle, runner memory 1Gi
python3 $W gate start && sudo scripts/managed-runner/lab/test-server.sh start   # then --managed-false, --managed
node $K/serve-web.mjs src/web/dist 5873 13710 &                               # T07_NO_CAPABILITIES=1: a server before it
node $K/t07web.mjs run --account wen --out DIR --base http://127.0.0.1:5873   # node $K/t07web.mjs act --out DIR send TEXT
python3 $K/t07rec.py run --account nia --out DIR --client ios                 # python3 $K/t07rec.py act --out DIR retry
python3 $K/t07lab.py loop wen kill --times 5; python3 $K/t07lab.py loop nia oom --times 5
python3 $K/t07lab.py va nia on|off; python3 $K/t07lab.py pvc-delete nia; python3 $W quota on|off
python3 $K/t07docker.py up && bash $K/step-dock-limit.sh && bash $K/step-dock-cap.sh && bash $K/step-dock-volume.sh
python3 $K/scenes.py pack RUN_DIR SCENES_DIR && bash $K/push-probe.sh PROBE_DIR   # the probe on macos-26
```

| Check | Result |
| --- | --- |
| Switch unset, `false`, capability missing | Root, an account with its own runner, saw its own workspace's draft on Claude Code, its session by deep link and Infrastructure as before. There was no managed notice and no registration prompt, on the web and in the replayed apps. |
| A new account's first session | wen signed in while hana held the one slot, and nia while wen held it: "Waiting for capacity", with no draft. Once their key was added, the draft was offered on it (the web 3.4 s later). The first session sent from it with nothing named was queued, shown waiting and then preparing, and answered on the key once the runner was READY. eve did the same on Docker. |
| Sleep and wake | Going to sleep, asleep, then a message: waking, then answered (k3s and Docker). The web says "Waking" 0.7 s after the send since this task's fix; before it, "asleep" stayed until the next 30 s read. |
| Restarts and Retry | Five kills of wen's runner (the profile's five attempts): `POD_RESTARTING`, then failed with "stopped too often" and Retry, which the web pressed: waking, then READY. Five out-of-memory kills of nia's: `POD_RESTARTING_OUT_OF_MEMORY`, then `POD_OUT_OF_MEMORY` with Retry, pressed by the recorder as the iPhone presses it. |
| Quota, held and deleted volume | A quota of zero Pods: waking with the quota's sentence, until it was lifted. A VolumeAttachment left behind: waking with `VOLUME_IN_USE`, until it was removed. The claim deleted while asleep: failed `PVC_MISSING`, with no Retry. |
| Environment unusable | The switch on with a profile whose backend is neither Kubernetes nor Docker: "…not configured correctly", the composer closed. |
| Docker only | The channel's cap held by a container nobody records: `CONTAINER_LIMIT` while preparing and while waking. A stopped container holding the volume: `VOLUME_IN_USE`. The volume removed, then restored by the runbook (`volume-backup.sh`): `PVC_MISSING`, then `PVC_RESTORED` with Retry, and answered. |
| iPhone and Mac | Replayed on macos-26. Each of the 25 scenes passed on both apps: the switch off, the first session on the key, sleep and wake, both loops and their Retry, the quota, both volumes, the unusable environment, root's own workspace and deep link, the Docker states, and where each app lands by itself. No app made a request outside the recording, and every write matched the recording's key fields. The evidence explains round 1's replay artifact and round 2's one Mac exit, which did not recur. |

One finding is reported, not fixed here: on k3s the restart reason is lost after the detach wait. The evidence also
notes two behaviours from before this task: a Retry pressed on another client shows at the next 30 s read, and the
web composer under a failed notice reads "Reply…" while the runner row is still online.

## The restart reason through the detach wait (T07b)

Recorded 2026-10-18 by task T07b, which fixed T07's finding above. It records what a runner's owner is told while a
READY runner restarts by itself, before and after the fix. The records are in
[the evidence](evidence/managed-runner-restart-reason/2026-10-18/README.md).

- **Setup.** One account (`amy`), T06b's image (already in the guest) and T07's profile: one runner, its memory limit
  1Gi. The idle interval was raised to an hour, so that sleep stayed out of the way.
- **Model.** fake-model.py stood in as the owner's DeepSeek-preset key. No session ran, and nothing was built into an
  image or pushed.
- **What was read.** The status, as the owner reads it, every 0.5 s (`kit/t07b.py watch`).
- **Control.** For one run, the test server ran a build of the previous manager.

```sh
export LAB_TEST_SERVER_DIR=/mnt/data/managed-runner-lab/test-server-t07b    # earlier tasks' databases untouched
W=scripts/managed-runner/lab/wake-lab.py; K=docs/evidence/managed-runner-restart-reason/2026-10-18/kit
python3 $W prepare --image REF && python3 $K/t07b.py profile                 # then idleSeconds 3600 in the profile
python3 $W gate start && sudo -E scripts/managed-runner/lab/test-server.sh start && python3 $W account root
sudo -E scripts/managed-runner/lab/test-server.sh start --managed           # after stopping the apiserver unit
python3 scripts/managed-runner/lab/single-writer.py admission install && python3 $W record start
python3 $W account amy && python3 $W key amy && python3 $W until amy READY
$K/run.sh OUT LABEL kill|oom natural|held      # READY for 125 s first; the status every 0.5 s until READY again
$K/run-starting.sh OUT LABEL                   # sleep, wake, and a kill while the woken runner is still starting
```

| Check | Result |
| --- | --- |
| The detach wait, with the fix | The stopped Pod's own VolumeAttachment was kept by a finalizer of the kit's (`detach-hold`) after the cluster had detached the volume, as a slow detach keeps it. After a SIGKILL of `orbit run`: REQUESTED `POD_RESTARTING` (4.5 s), REQUESTED `VOLUME_STILL_ATTACHED` (15 s, the restart carried), STARTING `POD_RESTARTING` on the next generation, READY with no reason. After the container ran out of memory: the same, with `POD_RESTARTING_OUT_OF_MEMORY`, and the clients' out-of-memory sentence before and after the wait. |
| The same, before the fix | REQUESTED `POD_RESTARTING`, REQUESTED `VOLUME_STILL_ATTACHED`, then STARTING with no reason for 20 s: "It is starting again", T07's finding. |
| Without the hold | Two kills and an out-of-memory kill while READY, and a kill while a woken runner started. Each time the volume was detached 3.3–6.1 s after the Pod failed, before the gate looked (one poll and a 3.75 s backoff after the stop), so there was no wait. The restart's reason stood until READY. T07 saw the natural wait in a crash loop of a runner still starting. |
| Attempts and identity | Each run began with the runner READY for 125 s, and each restart counted attempt 1; no wait spent one. Generations 1 to 9 ran on the same PVC and PV, one Pod at a time. |

Left in the lab: `amy` SLEEPING, its PVC kept; the webhook removed; the test server and the gate stopped; the VM off.

## End-to-end acceptance (T08)

Recorded 2026-10-18 by task T08: two accounts (`ann`, `bob`) and a third (`cy`) through the whole flow on the lab's real
k3s, in one run of `acceptance-lab.py` on the project line (`eb16b3b5e`: 48 steps, 261 checks, all passed, 36.4 minutes),
with the switch unset, `false` and on. The records are in [the evidence](evidence/managed-runner-acceptance/2026-10-18/README.md),
and the runbook written from it is [Managed runners on Kubernetes](managed-runner-kubernetes-operations.md). The owner's
DeepSeek key file did not exist, so every session ran on fake-model.py as a DeepSeek-preset key (T05's way), which is not a
model. The runner image was T06b's (`…@sha256:cdb09014…`; nothing under `src/runner-go` or `deploy/managed-runner/image`
changed since its source); nothing was built into an image or pushed.

```sh
export LAB_TEST_SERVER_DIR=/mnt/data/managed-runner-lab/test-server-t08     # earlier tasks' databases untouched
sudo scripts/managed-runner/lab/status.sh && sudo scripts/managed-runner/lab/start.sh
bash scripts/worktree-overlay.sh && npm run build -w @orbit/shared && npm run build -w @orbit/apiserver
OUT=/mnt/data/tmp/t08-run && mkdir -p $OUT        # a transient unit: a runner outage cannot end the run
sudo systemd-run --unit=orbit-mr-lab-t08-run --collect -p MemoryMax=1G -p Environment=HOME=/root \
  -p Environment=LAB_TEST_SERVER_DIR=$LAB_TEST_SERVER_DIR -p WorkingDirectory=$PWD \
  -p StandardOutput=append:$OUT/run.log -p StandardError=append:$OUT/run.log \
  /usr/bin/python3 -I $PWD/scripts/managed-runner/lab/acceptance-lab.py run --out $OUT --quiet-seconds 90
python3 scripts/managed-runner/lab/acceptance-lab.py report $OUT        # each step's time and checks, the intervals
sudo scripts/managed-runner/lab/stop.sh
```

| Check | Result |
| --- | --- |
| Switch unset, then `false`, no profile | No Kubernetes or Ceph setting in the apiserver's environment. Sign-ins; `GET /api/managed-runner` `enabled: false` and no display; every managed write `404 MANAGED_RUNNER_DISABLED`; this checkout's runner as a real self-managed runner (Claude Code 2.1.302 on the host) answered a session, a task run now and a task's run time. No managed row, no namespace object changed and no connection to the gate in 90 s each. |
| Provisioning | 16 concurrent sign-ins of ann and bob over two replicas, the admission guard absent: one mapping, claim and Secret each, `FAILED ADMISSION_GUARD_MISSING` 5.7 s later, no Pod. Guard installed, the owners' retries: the Pod 6.3 s after, the first heartbeat 31 s after the Pod, `MODEL_UNAVAILABLE`, then READY 1.1 s after each key. The gate saw two claim creates, two Secret creates, two probes, then two Pod creates. |
| Capacity | A budget of two runners: cy waited `WAITING_CAPACITY` with nothing created, and got its claim the moment the first runner slept. |
| Sessions | An attachment, and a file written and committed in the session's worktree by Claude Code's own Bash tool (`FAKE-WRITE`), answered 2.3–2.4 s after each first session was made. |
| Busy, then idle | A 240 s turn (ann) and a 240 s background job (bob): READY past the 90 s idle interval, the owner's sleep `409 MANAGED_RUNNER_BUSY` at 110 s; 96 s after the work ended the drain began, 40 s later both were SLEEPING, Pod gone, volume detached, no RBD watcher, compute released. |
| Between the accounts | The other owner's token and runner credential refused (403/404) on the runner, workspace, instance, session, events, turn, attachment and a session in the other's workspace; the other's mapping unchanged. The guard refused Pods mixing the owners and volumes, an unlabelled Pod on a runner's claim and a copy of a runner's Pod under another name. In each runner: one RBD filesystem at `/var/lib/orbit`, no service account token, no credential variable, no RBD device node, UID 10001 with no capabilities, `401` from the Kubernetes API. |
| Wakes | A message to sleeping ann: answered 10.4 s later on a new Pod. A task due at a time for sleeping bob: answered 5.1 s after it was due. |
| Rebuilds | An operator's `kubectl delete pod` of ann's runner (held by the stop-report finalizer, then the next generation by itself): READY again 14.7 s after the delete. A SIGKILL of bob's `orbit run`: READY again 25.0 s after its Pod failed. Each on a new Pod of the next generation, the same claim. |
| Controller restart | Both apiservers SIGKILLed 0.4 s into bob's wake, his Pod just created (STARTING); down for 5 s, then started again (6.9 s). The restarted manager adopted that Pod (no second Pod create), bob was READY 12.5 s after the kill, and ann's 200 s turn, running through it, was answered on the same Pod. |
| Image rollback | The previous lab image (T02a's build) pinned and the apiservers restarted: the running Pod kept its image, the next generation ran the previous one; forward again the same way. |
| Data through it all | The probe's random bytes, SQLite rows (WAL, `synchronous=FULL`) and Git commit, the uploads, the worktree and its commit, and the engine's transcript: the same after every sleep, wake, rebuild, restart and image change, `integrity_check` `ok`; each resumed session's next request carried the earlier conversation. One runner, claim, PV, handle and RBD image per account throughout (ann generations 1–7), never two Pods on a volume in any of the 207 timeline samples. |
| Independent backup | ann disabled (asleep 33.8 s later), her 2 GiB image exported out of the VM to the host (7.8 s, 27.0 MB gzip, 0.3 s copy), checked there with no cluster (`debugfs`; 4.3 s), written into a new claim's image that read back byte for byte as the backup, and checked in a Pod (25.8 s). The original untouched; ann woke on it. |
| Off again, every runner asleep | Unset, then `false`: a message, a task run now and a task's run time per account made no managed write, changed nothing in the namespace and reached nothing for 90 s each; every claim kept; the self-managed runner kept working. Switched on, all six waiting pieces of work were answered, ann's last, once a runner had slept and freed a slot. |

Findings: Ceph-CSI v3.18.0 with `attachRequired: true` refuses to publish a static PV whose handle is a plain image
name, and its unpublish then panics, which holds the VolumeAttachment and the PV on the attacher's finalizer: the runbook
restores into a claim the driver provisions instead. A sleep already advances a mapping's generation, so a wake's new Pod
keeps the generation the sleeping row names. Two volumes writing on this VM's one HDD fsync three times as slowly as one.

Left in the lab: `test-server-t08` with ann, bob and cy SLEEPING, their claims kept; the restored claim
`t08-restore-20261018t125553z` and its PV and image, as retained test data; the backup archive and its manifest in
`/mnt/data/managed-runner-lab/backups/t08-20261018T125553Z` (0700); the webhook removed; the test server, gate, replica,
recorder and self-managed runner stopped; the VM off.

## A restored volume back under its runner (T08b)

Recorded 2026-10-18 by task T08b: one account through the volume switch on the lab's real k3s, in one run of `switch-lab.py`
at `eccae61cd` (22 steps, 78 checks, all passed, 15:18:39–15:26:40 UTC, 8.0 minutes). The records are in
[the evidence](evidence/managed-runner-volume-switch/2026-10-18/README.md), and the procedure it follows is the runbook's
[Put a restored volume back under its runner](managed-runner-kubernetes-operations.md#put-a-restored-volume-back-under-its-runner).
fake-model.py stood in for a model as a DeepSeek-preset key, since the owner's key file did not exist. The runner image was
T06b's, whose sources this branch does not change; nothing was built into an image or pushed.

```sh
export LAB_TEST_SERVER_DIR=/mnt/data/managed-runner-lab/test-server-t08b    # earlier tasks' databases untouched
sudo scripts/managed-runner/lab/status.sh && sudo scripts/managed-runner/lab/start.sh
bash scripts/worktree-overlay.sh && npm run build -w @orbit/shared && npm run build -w @orbit/apiserver
OUT=/mnt/data/tmp/t08b-run && mkdir -p $OUT        # a transient unit: a runner outage cannot end the run
sudo systemd-run --unit=orbit-mr-lab-t08b-run --collect -p MemoryMax=1G -p Environment=HOME=/root \
  -p Environment=LAB_TEST_SERVER_DIR=$LAB_TEST_SERVER_DIR -p WorkingDirectory=$PWD \
  -p StandardOutput=append:$OUT/run.log -p StandardError=append:$OUT/run.log \
  /usr/bin/python3 -I $PWD/scripts/managed-runner/lab/switch-lab.py run --out $OUT
python3 scripts/managed-runner/lab/switch-lab.py report $OUT        # each step's time and checks, the intervals
sudo scripts/managed-runner/lab/stop.sh
```

| Check | Result |
| --- | --- |
| Before | ann signed in and was READY on a fake-model key, her first session holding an attachment and a file the engine committed in its worktree. The probe wrote 8 MiB of random bytes, 150 SQLite rows (WAL, `synchronous=FULL`) and a Git commit while a 150 s turn kept the runner up. Disabled, she was asleep 28.4 s later. Her 2 GiB RBD image was exported out of the VM in 8.2 s (18.2 MB gzip) and checked on the host with no cluster in 4.4 s. |
| The loss | Her claim, its PV (Released, kept by `Retain`) and its RBD image deleted. Enabled again, a message: the wake failed `PVC_MISSING` 0.6 s later, no claim made in its place, the message waiting. |
| The restore | A new claim `mr-data-<runner uuid>` with the manager's marks, `Bound` to a new PV and image; the claim, its binding and the backup's write into the image took 17.1 s, and the image read back with the backup's SHA-256. A check Pod on the claim was refused by the guard (`NOT_THE_MANAGER`). The manager kept `PVC_MISSING` and adopted nothing; its detail said the claim under the name was not the recorded one. |
| The switch | ann's own request was refused 403, another UID 409 `VOLUME_NOT_VERIFIED`, a stale revision 409 with the current one; nothing was switched. The administrator's switch was answered 200 in 0.4 s: `SLEEPING`, desired `RUNNING`, generation 2, from the lost claim, PV and handle to the restored ones. One `activity` row named the administrator, the time and both volumes. The same request again: `replayed`, no second row. |
| The wake | The waiting message woke the runner at once: Secret and Pod in the switch's second, the runner container 14 s later, the message answered 23.7 s after the switch and READY at 51 s. The same runner ID and workspace, generation 2 (the backed-up volume had last run generation 1), the Pod admitted for the restored claim's UID, `/var/lib/orbit` an ext4 RBD device. The engine's next request carried the earlier conversation. The probe's random bytes, rows and Git commit and every upload, worktree file, transcript and SQLite database (`integrity_check` ok) were as backed up. |
| At the end | The database and k3s agreed; never more than one Pod on the volume in the recorder's timeline (sampled every second, 31 changes written); Ceph `HEALTH_OK`; the lost image gone and the restored one there; ann asleep on the restored claim. |

Finding, fixed in `eccae61cd`: in the first full run (kept in the evidence's `trial/`), the same switch sent again right after
it was refused `MAPPING_BUSY`. The switch kicks the manager, whose wake pass then held the mapping's lease. A replay is now
answered from a read. That trial's run passed everything else; its directory is `test-server-t08b-dev`.

Left in the lab: `test-server-t08b` (ann SLEEPING on her restored claim) and the trial's `test-server-t08b-dev` (its ann
SLEEPING on its own); the two restored claims with their PVs and images, as retained test data; the backups
`backups/t08b-20261018T150259Z` (the trial's) and `backups/t08b-20261018T152419Z` (0700). The lost volumes' claims, PVs and
images were deleted, as the test required. The webhook is removed, the test server and gate are stopped, and the VM is off.

## Two nodes (L1)

Recorded 2026-10-19 by task L1. On 2026-10-19 the owner decided to add a second, smaller KVM VM on
the same host as a second k3s node, so that the cross-node parts of criteria 2 and 8 can be tested
here (T02, then T08x). It runs only a k3s agent; Ceph stays a single-host cluster in the first VM.
The records are in [the evidence](evidence/managed-runner-two-node-lab/2026-10-19/README.md).

### Topology

| | First VM | Second VM |
| --- | --- | --- |
| Unit, size | `orbit-mr-lab.service`: 4 vCPU, 6144 MiB, `MemoryMax=6656M` | `orbit-mr-lab-2.service`: 2 vCPU, 3072 MiB, `MemoryMax=3584M` |
| Disks, in `/mnt/data/managed-runner-lab/disks` | `root.qcow2` (40 GiB) and three OSD disks | `node2-root.qcow2` (30 GiB), an overlay on the same verified image |
| User network | 10.0.2.15; 127.0.0.1:16222 → :22, 127.0.0.1:16443 → :6443 | its own, also 10.0.2.15; 127.0.0.1:16223 → :22 |
| Link | `lablink0` 10.77.0.1/24 (`52:54:00:4c:00:01`); qemu listens on 127.0.0.1:16230 | `lablink0` 10.77.0.2/24 (`52:54:00:4c:00:02`); qemu connects to 127.0.0.1:16230 |
| Kubernetes node | `orbit-mr-lab`: k3s server (control plane), InternalIP 10.77.0.1, Pod CIDR 10.42.0.0/24 | `orbit-mr-lab-2`: k3s agent of `https://10.77.0.1:6443`, InternalIP 10.77.0.2, Pod CIDR 10.42.1.0/24 |
| Labels | k3s's own: `kubernetes.io/hostname`, `node-role.kubernetes.io/control-plane=true`, `node.kubernetes.io/instance-type=k3s`, arch and os | the same without the control-plane role; no zone or region labels, since both are one machine |
| Allocatable | 3 CPU, 2592 MiB | 1750m CPU, 2134 MiB |
| Ceph | MON (3300, 6789), mgr and 3 OSDs, all on 10.77.0.1; `public_network` 10.77.0.0/24 | none: its kernel RBD client reaches the first VM's MON and OSDs over the link |
| Ceph-CSI | operator, controller plugin (pinned here), node plugin | node plugin (the DaemonSet's second Pod) |

Both run Ubuntu 26.04.1 with kernel 7.0.0-34-generic and k3s v1.36.5+k3s1, from the same pinned
image and binary; the second VM's kernel maps the `aes256k` CSI key like the first. Flannel's VXLAN
runs over `lablink0` (`flannel-iface`), and the API server advertises 10.77.0.1. The join token goes
from the server's `agent-token` into the agent's `/etc/rancher/k3s/agent-token` (0600) through an
SSH pipe and is compared by hash; it is never printed or written on the host. The lab sets no
separate agent token, so this is k3s's server token, held by the two guests only.

### The link

- A QEMU socket netdev: one more virtio NIC in each VM, the first qemu listening on 127.0.0.1:16230
  and the second connecting to it, the two exchanging Ethernet frames over that one TCP connection.
  No bridge, tap, host address or route, and no change to the host's network or firewall; `ss` on
  the host shows the listener and the one connection.
- 10.77.0.0/24 is clear of the HPC LAN (192.168.1.0/24), Docker's networks (172.16.0.0/12 and
  192.168.0.0/16, its default pools), k3s's Pods and Services (10.42.0.0/16, 10.43.0.0/16), podman's
  default (10.88.0.0/16) and the QEMU user network (10.0.2.0/24) that both VMs keep for downloads.
- In each guest `provision.sh link` writes `/etc/netplan/60-orbit-lab-link.yaml`: the NIC matched by
  its MAC, named `lablink0`, a static address, no DHCP or IPv6, and `ignore-carrier`, so that the
  address stays while the other VM is off. A new VM's seed gives DHCP to its user-network NIC only
  (the first VM's install, from when it had one NIC, already names that NIC by its MAC).
- The first VM always has its link NIC, in single-node mode too, so Ceph and k3s keep one address
  in both modes. A round trip over the link takes 0.3–0.7 ms idle (`agent-health`), up to 9 ms
  while both VMs boot.
- Only the listening end waits for a new connection. If the first VM's qemu went while the second
  ran, the second's end would stay down until its own qemu starts again; so `stop.sh` stops the
  second VM first and `start.sh` starts the first first.

### Moving Ceph and k3s onto the link

The single-node lab had Ceph and its k3s node on 10.0.2.15, the user network's address, which the
second VM cannot reach: its own user network gives it the same address. `create.sh` moved them in
place on 2026-10-19, keeping the FSID, pools, images, keys, claims and imported images.
`provision.sh ceph` and `provision.sh k3s` do this whenever they find another address:

1. First, the Pods that map RBD in the first VM are deleted, because a kernel client mapped through
   the old addresses would hang once they move. Here that was the L0 smoke Pod
   `lab-20261017061552-b`, recreated afterwards on its claim.
2. While the MON still answers at 10.0.2.15: `ceph config set global public_network 10.77.0.0/24`
   and `ceph orch host set-addr orbit-mr-lab 10.77.0.1`.
3. `ceph mon getmap`, then `monmaptool --rm orbit-mr-lab` and `monmaptool --addv orbit-mr-lab
   [v2:10.77.0.1:3300,v1:10.77.0.1:6789]`. The MON is stopped and the map injected with
   `ceph-mon -i orbit-mr-lab --inject-monmap` in `cephadm shell --name mon.orbit-mr-lab`. `mon_host`
   and the MON's `public network` are rewritten in `/etc/ceph/ceph.conf` and in every daemon's
   `config` under `/var/lib/ceph/FSID`. Then the MON is started again. This is Ceph's "Changing a
   Monitor's IP address" (the advanced method).
4. The mgr, the three OSDs and the crash agent are restarted, and they bind to the new public
   network. A quick restart of a cephadm unit can fail with "Device or resource busy", because its
   last container's conmon is still there; systemd starts it again by itself. `ceph orch ps
   --refresh` then clears cephadm's stale "failed daemon" warning.
5. k3s gets `node-ip: 10.77.0.1`, `flannel-iface: lablink0` and `tls-san` in `config.yaml`, then a
   restart. The k3s installer restarts the service only for a new binary or unit, so `provision.sh`
   remembers the config k3s last started with and asks for the restart when it differs.
6. The CephConnection's monitor became `10.77.0.1:6789`, and the operator rewrote `ceph-csi-config`.

No test data was lost. All 31 claims of earlier tasks are still `Bound`. Their 32 PVs (one
`Released`, as before) and the RBD images behind them are still there: 36 claims, 37 PVs and 37
images in all after this task's five claims. The pool `orbit-mr-rbd` and the StorageClass
`runner-data` keep their names, and the FSID is unchanged. The L0 smoke volume was read again after
the move and after each later restart, in both modes. Each time it had the same ordinary file, Git
commit, 107 SQLite rows (row hash) and random-file SHA-256, with `integrity_check` `ok`, now mapped
through 10.77.0.1; these are also the hashes of the coordinator's L0 review run of 2026-10-17. A new
lab bootstraps Ceph on the link address directly.

### Two modes

| | Single-node mode | Two-node mode |
| --- | --- | --- |
| Start | `start.sh` | `start.sh --nodes 2` |
| Running | the first VM | both; the first boots first |
| Memory guard | host `MemAvailable` ≥ 2048 MiB | ≥ 3584 MiB to boot both, ≥ 1536 MiB to add the second to a running first |
| The second node | registered, `NotReady` (unreachable) and cordoned | `Ready` and schedulable |
| Stop | `stop.sh` | `stop.sh` (the second VM first), or `stop.sh --node 2` back to single-node mode |

Single-node mode is the lab as T03–T08b used it, plus one node that stays `NotReady` and cordoned:
nothing new is scheduled onto it, and its node-plugin Pod waits there. Before a two-node window,
make sure no other experiment, dind host or pg spec batch runs on HPC (`docker ps`,
`systemctl list-units --type=service --state=running`, `free -m`). If one does, wait, and tell the
coordinator in a task comment.

### A hard stop of the second node

`stop.sh --node 2 --hard` kills the second VM's qemu with SIGKILL. That is a power cut: the guest
gets no shutdown, the node is not cordoned and nothing tells the cluster. `start.sh --nodes 2` brings
the VM back: the memory guard for the second VM, the boot, both nodes `Ready` and the node uncordoned.
`two-node.py hard-stop` does both around a writer Pod on the second node. It samples every 5 s
(`rbd status` every 15 s); the timeline is in the evidence. Observed on 2026-10-19, with the power
cut at 10:08:12Z:

| Time | Node `orbit-mr-lab-2` | The Pod (writer on an RWO claim) | VolumeAttachment | RBD watcher |
| --- | --- | --- | --- | --- |
| Before | `Ready` | `Running`, Ready | attached to `orbit-mr-lab-2` | `10.77.0.2:0/…`, the second VM's kernel |
| Cut + 34 s | `Ready` (stale) | `Running`, Ready (stale) | attached | gone: Ceph drops a watch after 30 s without pings (sampled every 15 s) |
| Cut + 48 s | `Unknown` (`NodeStatusUnknown`), taints `unreachable:NoSchedule` and `unreachable:NoExecute` | `Running`, Ready `False` | attached | none |
| Cut + 5 min 48 s | `Unknown` | evicted by the `NoExecute` taint after its 300 s toleration: `deletionTimestamp` set, still `Running`, because no kubelet confirms the stop | attached | none |
| Cut + 7 min, end of the window | `Unknown` | Terminating | still attached; nothing detached it | none |
| Boot + 31 s (10:15:47Z) | `Ready` again, taints gone | the kubelet found no containers: `Failed` | attached | none |
| Boot + 52 s | `Ready` | removed | deleted (detached) | none |

The claim was then mounted on the first node. It held 121 rows, including every one of the 120
acknowledged before the cut, and `integrity_check` was `ok` after SQLite's WAL recovery. Cleanup
left no Pod, VolumeAttachment or watcher. Within the 7 minutes nothing moved the volume off the dead
node: there was no detach while the Pod stayed Terminating, and no replacement Pod, since none was
asked for. Whether and how a successor may take the volume, and how the old node is fenced, is for
T02 to establish ([it did](#cross-node-migration-and-takeover-t02)).

A finding: after this test Ceph reported `BLUESTORE_SLOW_OP_ALERT` for osd.2, slow BlueStore
operations on the shared HDD. By default the alert stays for 24 hours, which held `status.sh`
unhealthy. The lab now sets `bluestore_slow_ops_warn_lifetime` to 600 s (`provision.sh ceph`), and
the alert cleared 10 minutes later.

### Smoke results

`two-node.py migrate` (run `l1m-20261019100149`) uses the repository's probe payload, with each Pod
pinned to its node by a required node affinity:

| Step | Result |
| --- | --- |
| PVC from `runner-data` | `Bound`: RWO, `Filesystem`, ext4, `Retain`, mounter `rbd`, image `orbit-mr-rbd/csi-vol-1ea2d45d…` |
| First node | Pod Ready in 7.2 s; VolumeAttachment `csi-d9bed501…` on `orbit-mr-lab`; `/dev/rbd1` mapped by the first VM, watcher `10.77.0.1`. It wrote 104 SQLite rows (WAL, `synchronous=FULL`), an ordinary file, a Git commit and 32 MiB of random bytes; `integrity_check` `ok` |
| To the second node | Pod deleted: VolumeAttachment gone and device unmapped 13.4 s later. Pod on `orbit-mr-lab-2` Ready in 53.4 s (the probe image's first pull there); VolumeAttachment `csi-d92a005c…` on `orbit-mr-lab-2`; `/dev/rbd0` mapped by the second VM, watcher `10.77.0.2`. Same file, Git commit, row hash, row count and random-file SHA-256; `integrity_check` `ok`. It wrote 54 more rows there, and the first 104 hashed as before |
| Back to the first node | VolumeAttachment gone 13.8 s after the delete; Pod on `orbit-mr-lab` in 8.3 s, `csi-d9bed501…` again; 158 rows with the same hashes as on the second node, `integrity_check` `ok` |
| Both VMs stopped and started | `stop.sh` stopped the second VM in 6 s, then the first in 18 s. `start.sh --nodes 2` booted both behind the 3584 MiB guard: SSH after 41 s and 45 s, healthy 2 min 20 s after the start (both nodes `Ready`, Ceph `HEALTH_OK`, the node plugin on both). `two-node.py verify` on the second node found the same 158 rows and hashes, `integrity_check` `ok`. The L0 smoke volume came back on the first node as before |
| The second VM destroyed and rebuilt | `destroy.sh --yes-destroy-lab --node 2` stopped it, deleted its node and the node's password Secret, and removed its disk and seed; the first VM and Ceph were untouched. `create.sh --nodes 2` built a new one: the node `orbit-mr-lab-2` was back with a new UID, the node plugin was ready 1.5 minutes after the boot, and `two-node.py verify` there found the same 158 rows and hashes |
| Single-node mode | `smoke.sh run` (run `lab-20261019104803`) with the second VM off and its node cordoned, then `stop.sh`, `start.sh` and `smoke.sh verify`: the same results as L0. Pod recreation and the restart kept the file, Git, 103 SQLite rows and random-file hashes with `integrity_check` `ok`; a second Pod on the same node and RWO claim was admitted and ran; a `ReadWriteOncePod` claim's second Pod stayed `Pending`, the scheduler now counting the cordoned node as unschedulable. `smoke.sh` waits for its own image to be unmapped, no longer for every RBD device of the VM, which the remounted L0 volume kept mapped |

A VolumeAttachment belongs to one volume and one node, so each move deleted the old one before the
new node's was created; there were never two at once.

### Memory measured

Figures in MiB from 2026-10-19: each unit's cgroup (`memory.current` and `memory.swap.current`), the
guests' own figures through the balloon (in use = total minus available), and the host's
`/proc/meminfo` (`two-node.py memory`, `state/memory.jsonl`). Other sessions kept the host busy: one
session's tests took its `MemAvailable` down to 2.6 GiB for a moment at 10:53 with only the first
VM up, so the units' figures are the VMs' footprint and the host's are context.

| Moment | First VM: host RAM + swap | First guest in use | Second VM: host RAM + swap | Second guest in use | Host `MemAvailable` |
| --- | --- | --- | --- | --- | --- |
| Both off (10:22:38) | – | – | – | – | 7179 |
| Two-node mode, idle, 5 min after healthy (10:30:32) | 2758 + 4 | 1548 | 1014 + 2 | 533 | 5074 |
| Two-node mode, idle, 10 min (10:35:33) | 2323 + 428 | 1591 | 724 + 251 | 531 | 6200 |
| Single-node mode, 5 min after the second VM stopped (10:41:27) | 2332 + 414 | 1581 | – | – | 7179 |
| Single-node mode, booted, healthy, page cache dropped (10:52:49) | 2971 + 30 | 1509 | – | – | 5642 |
| Both off again (10:50:22, 10:54:39) | – | – | – | – | 9674, 8788 |

- At rest the first VM costs the host 2.7–3.0 GiB in either mode and the second about 1.0 GiB, so
  two-node mode holds about 3.7 GiB of host memory; the 9 GiB is their guest RAM, the most they can
  take.
- In use in the second guest at rest: k3s agent 191, containerd 164, the CSI node plugin 87 and about
  100 for the OS; 548 in all. In the first, as in L0: k3s server 527, ceph-mgr 215, containerd 174,
  three OSDs about 150 each, Ceph-CSI and its operator about 390 together.
- Peaks: 3675 MiB for the first VM's unit while Ceph and k3s moved; 2779 MiB for the second's on its
  first boot, which pulled the Ceph-CSI and probe images (about 1.2 GiB in its page cache until
  `provision.sh trim`), and 1188–1201 on later boots. While the hard-stop test ran, the host swapped
  out up to 1.7 GiB of the first VM's pages.
- The guard's floors follow from this: 2048 MiB for the first VM, as before, and 1536 MiB for the
  second (its footprint at rest plus a margin), so 3584 MiB for both.
- Timings: `create.sh --nodes 2` took 3.5 minutes in all. The second VM went from its first boot to
  a `Ready` node with the node plugin in about 2 minutes: SSH after 32 s, the agent 14 s after its
  token, then 70 s for the plugin's images. Later boots reached `Ready` in 31 s, and its shutdown
  took 6 s.

### For T02 and T08x

- An image imported into the first VM's containerd (`single-writer.py import`, `runner-image.py
  import`) is not in the second's: those tools reach only the first VM. Import it into the second as
  well, over SSH on port 16223 (`sudo k3s ctr images import …` works on the agent), before a runner
  Pod is scheduled there.
- Pods on either node reach a test server on the host at `https://10.0.2.2:13711` through their own
  VM's user network. The admission webhook is called by the API server in the first VM.
- The manager sets no node for a runner Pod: cordon a node to choose. `start.sh --nodes 2`
  uncordons the second node, and `stop.sh --node 2` cordons it.
- The CSI controller plugin stays on the first VM, so attach and detach keep working while the
  second is down.

## Cross-node migration and takeover (T02)

Recorded 2026-10-19 by task T02, the cross-node part of criterion 2, on the two nodes of [L1](#two-nodes-l1). One
account's runner (`ann`) ran through the test server's manager, admission guard and fencing gate, in one run of
`takeover-lab.py`: 31 steps, 175 checks on the passing ones. Two steps were run again after a check's fix (below).
The records are in [the evidence](evidence/managed-runner-cross-node/2026-10-19/README.md); the procedure it follows is the
runbook's [Failover](managed-runner-kubernetes-operations.md#failover).

- **Model.** fake-model.py stood in as a DeepSeek-preset key, which is not a model.
- **Image.** Built from `8055bb568` with the lab CA layer and imported into both VMs' containerd; nothing pushed.
- **Lab window.** Both VMs were on from 12:25 to 13:12 UTC, after other sessions' pg-spec batches had ended.

```sh
export LAB_TEST_SERVER_DIR=/mnt/data/managed-runner-lab/test-server-t02    # earlier tasks' databases untouched
sudo scripts/managed-runner/lab/status.sh && sudo scripts/managed-runner/lab/start.sh --nodes 2
bash scripts/worktree-overlay.sh && npm run build -w @orbit/shared && npm run build -w @orbit/apiserver
bash docs/evidence/managed-runner-cross-node/2026-10-19/kit/build-image.sh /mnt/data/tmp/t02-cross-node/image   # the archive the run imports
OUT=/mnt/data/tmp/t02-cross-node/run && mkdir -p $OUT        # a transient unit: a runner outage cannot end the run
sudo systemd-run --unit=orbit-mr-lab-t02-run --collect -p MemoryMax=1G -p Environment=HOME=/root \
  -p Environment=LAB_TEST_SERVER_DIR=$LAB_TEST_SERVER_DIR -p WorkingDirectory=$PWD \
  -p StandardOutput=append:$OUT/run.log -p StandardError=append:$OUT/run.log \
  /usr/bin/python3 -I $PWD/scripts/managed-runner/lab/takeover-lab.py run --out $OUT    # --from-step PHASE/STEP goes on
python3 scripts/managed-runner/lab/takeover-lab.py report $OUT
sudo scripts/managed-runner/lab/stop.sh
```

| Check | Result |
| --- | --- |
| Normal move | Generation 1 on the first node, the second cordoned. The owner's sleep: asleep in 15.4 s on the kubelet's report, Pod gone, volume detached, no watcher. With the first node cordoned and the second not, a message woke the runner on the second node, its Pod made in the same second: answered after 24.7 s, READY after 25.8 s. The same runner, PVC, PV, handle, image and workspace; probe data, uploads, worktree, transcripts and the session as before |
| A second Pod on the other node | With the runner on the second node and its writer committing rows, six Pods on its claim pinned to the first node were refused by the guard: by the cluster admin (`NOT_THE_MANAGER`), by the manager's identity and as a copy of the runner's Pod (`NOT_THE_FIXED_NAME`), under the fixed name (`NOT_RESERVED`), for the next generation (`NOT_THE_RESERVED_GENERATION`), and a Job's Pod (`NOT_THE_MANAGER`). One Pod, one attachment, one RBD client throughout |
| RWO and RBD alone | A plain claim's second Pod on the other node stayed `Pending`: Kubernetes 1.36's attach/detach controller says "Waiting for detach … already used by pod(s)", which the out-of-service taint overrides on purpose. The RBD image has `layering` only (no `exclusive-lock`) and no lock, and a second Ceph client read it while the other node mapped it |
| Heartbeat loss | The second node's qemu SIGKILLed while the runner wrote there. For 420 s the mapping stayed `READY` at its generation and nothing took over. The gate saw only reads, the attachment stayed on the dead node, a message waited and the owner's retry was refused. The node went `Unknown` at 52 s, the runner not usable at 114 s, and the taint manager evicted the Pod at 351 s; it stayed `Running`, held by the finalizer |
| Failover | Receipt (`NODE_POWER_OFF`, `HYPERVISOR`) and `node.kubernetes.io/out-of-service`. The Pod was `Failed` by PodGC and its attachment force-deleted within 6 s, and the mapping `FENCING` 10.3 s after the taint, the old credential refused from then on. With the finalizer taken off, the receipt was accepted and generation 3 was READY on the first node 26.1 s later. The gate saw one Pod create |
| Data after it | Every row the writer had acknowledged before the cut was there (441), `integrity_check` ok after WAL recovery, the rows read before the cut hashing the same. Fsynced files, uploads, worktree, transcripts and the session were as before; the message sent during the outage was answered |
| The old node back | Under the taint, it mapped and mounted nothing of the volume and ran nothing of the old Pod; its kubelet could not reach the CSI driver, whose node plugin the taint evicts. The old generation's credential got 401, the old instance 403 `SUPERSEDED`. The taint removed: rejoined, the volume still with generation 3 |
| At the end | Never more than one Pod on the claim nor one attachment of its PV in the timeline; Ceph `HEALTH_OK`; ann asleep |

Findings, reported to the coordinator:

- **Heartbeat loss leaves the mapping READY.** The runbook and the design said `FENCING`. The manager fences only once
  the Pod is gone or terminal without its kubelet's report, so the predecessor's credential stays valid until the
  out-of-service taint; nothing is replaced meanwhile. The runbook now says so.
- **Git work right before a power loss can be lost.** A Git commit made 14 s before the cut came back as zero-length
  files, an unreadable repository. A second cut ([kit/git-fsync-cut.py](evidence/managed-runner-cross-node/2026-10-19/kit/git-fsync-cut.py))
  showed that `core.fsync=committed,index` keeps the objects but not a `HEAD` and a branch ref written 1.5 s before the
  cut. Fsynced data survived.
- **The Ceph-CSI node plugin has no tolerations.** The out-of-service taint evicts it from the fenced node, so
  `status.sh` reports the lab unhealthy until the taint is removed; the run booted that node with `start.sh --no-wait`.

The first run (kept in the evidence's `trial/`) stopped at the move because fake-model.py quoted only T06–T08 markers;
it now quotes T02's too. The runner had moved and answered there as well. Its database is `test-server-t02-dev`, and its
runner is asleep on its own claim.

Left in the lab: `test-server-t02` (ann SLEEPING on her claim, generation 4 reserved) and the receipt ConfigMap
`mr-fence-01a15431-…`; the trial's `test-server-t02-dev`; their claims with PVs and images, as retained test data. The
plain RWO claim and the Git experiment's claim were deleted with their PVs and images. The webhook is removed, the test
server and gate are stopped, and both VMs are off.

## Two accounts across two nodes (T08x)

Recorded 2026-10-19 by task T08x, the cross-node part of criterion 8, on the two nodes of [L1](#two-nodes-l1). Two
accounts' runners (`ann`, `bob`) ran through the test server's manager, admission guard and fencing gate, in one run of
`cross-node-lab.py`: 32 steps, 412 checks, 31 steps passed. The one failed check was fixed and the run went on from a new
step (below). The records are in [the evidence](evidence/managed-runner-cross-node-accounts/2026-10-19/README.md); the
procedures it follows are the runbook's [Failover](managed-runner-kubernetes-operations.md#failover) and planned move.

- **Model.** The owner's DeepSeek key file did not exist, so fake-model.py stood in as a DeepSeek-preset key, which is not
  a model. A real model session is still to be run.
- **Image.** T02's build (`8055bb568` plus the lab CA layer), already in both VMs' containerd; nothing under
  `src/runner-go` or `deploy/managed-runner/image` changed since. Nothing built or pushed.
- **Lab window.** Both VMs on from 14:20 to 15:01 UTC, after another session's landing merge check had ended.

```sh
export LAB_TEST_SERVER_DIR=/mnt/data/managed-runner-lab/test-server-t08x    # earlier tasks' databases untouched
sudo scripts/managed-runner/lab/status.sh && sudo scripts/managed-runner/lab/start.sh --nodes 2
bash scripts/worktree-overlay.sh && npm run build -w @orbit/shared && npm run build -w @orbit/apiserver
OUT=/mnt/data/tmp/t08x-cross-node/run && mkdir -p $OUT    # LAB_T02_IMAGE_ARCHIVE names the image archive (T02's by default)
sudo systemd-run --unit=orbit-mr-lab-t08x-run --collect -p MemoryMax=1G -p Environment=HOME=/root \
  -p Environment=LAB_TEST_SERVER_DIR=$LAB_TEST_SERVER_DIR -p WorkingDirectory=$PWD \
  -p StandardOutput=append:$OUT/run.log -p StandardError=append:$OUT/run.log \
  /usr/bin/python3 -I $PWD/scripts/managed-runner/lab/cross-node-lab.py run --out $OUT    # --from-step PHASE/STEP goes on
python3 scripts/managed-runner/lab/cross-node-lab.py report $OUT
sudo scripts/managed-runner/lab/stop.sh
```

| Check | Result |
| --- | --- |
| Normal move, both accounts | Both runners on the first node (the second cordoned), READY 38 s after the sign-in. Both owners' sleep: asleep within 11 s, on the kubelets' reports. With the first node cordoned and the second not, a message woke ann's and a task run now bob's: the Pods made on the second node in the same second, the work answered after 36 s, READY after 37 s. Each kept its runner, PVC, PV, handle, RBD image and workspace, its probe data, uploads, worktree, transcripts and session |
| Second Pods on the other node | With both runners writing on the second node, five Pods per claim pinned to the first node (as T02's) and a Job's were refused by the guard, and so were Pods mixing the accounts: bob's Pod with ann's claim (`NOT_THE_FIXED_NAME`), ann's naming bob (`NOT_THE_OWNER`), one Pod on both claims (`MULTIPLE_MANAGED_CLAIMS`) |
| The node stops | The second node's qemu SIGKILLed with both runners writing there. Before the cut: no Git work for 86 s, a last message answered 20 s before it, ann's volume synced (`sync -f /var/lib/orbit` in her runner container) 26 ms before it, bob's not. For 420 s both mappings stayed `READY` at their generation; the node `Unknown` at 56 s, the runners not usable at 95 s, the Pods evicted at 354 s; demand waited, retries were refused, the gate saw only reads; second Pods on either claim on the first node (the next generation's under the fixed name among them) were refused |
| Failover | The runbook's query listed both runners on the lost node, its commands showed each Pod and attachment there. Two receipts, one out-of-service taint; bob's finalizer off at once, ann's once she was `FENCING`. Both `FENCING` 9.1 s after the taint (ann on PodGC's `Failed`, bob on his Pod object's removal), both READY on the first node 481 s after the cut; the gate saw two Pod creates |
| Data after it | Every SQLite row each writer acknowledged, probes p1 and p2 (written 4.5 and 1.6 minutes before the cut, Git included), uploads, worktrees: as before, `integrity_check` ok, `git fsck` clean. ann's transcript kept her last turn; bob's lost it (6 lines, 20 s before the cut), and his session went on from the lines before it |
| The old node back | Under the taint it mapped and mounted nothing and ran nothing of either old Pod; both old credentials 401, the old instances 403 `SUPERSEDED`; the writers went on from the first node; the taint removed, it rejoined |
| Drains | The runbook's planned move: `kubectl drain` refused the runners' bare Pods without `--delete-emptydir-data` and `--force`. With them, both runners moved to the second node and back, READY 45–46 s after each drain began |
| At the end | Never more than one Pod on either claim nor one attachment of either PV in the timeline; Ceph `HEALTH_OK`; both asleep |

How the run went: a first attempt stopped at its Ceph facts 26 s after the boot, the PGs still peering, and the run
started again from nothing. The first node's drain then evicted, besides both runners, a managed Pod of task T07's test
server, `Failed` since 2026-10-18 and held by the stop-report finalizer of T07's manager, which was not running. The
drain waited its full 300 s and exited 1, so that check failed although both runners had moved. With the check judging
the runners it moves, the run went on with a drain of the first node that passed T07's Pod
(`--skip-wait-for-delete-timeout=60`) and the drain back.

Findings, reported to the coordinator:

- **The coordinator's decision of 2026-10-19 held for two runners**: `READY` until the out-of-service taint, `FENCING`
  then. [The design record](managed-runner-design.md#single-pod-and-single-writer-protection) now says so.
- **The engine's transcript loses the last seconds.** A turn answered 20 s before the power cut was missing from bob's
  transcript after the takeover. Orbit's server kept it; the engine resumed without it. ann's volume, synced just
  before, kept hers. Relevant to T02c.
- **The runbook's drain needed flags**, and a drain finishes only once a manager records each evicted runner's stop.
  The runbook now gives the command, says what holds it, and adds the failover commands for a node with several runners.

Left in the lab: `test-server-t08x` (ann and bob SLEEPING on their claims); their claims with PVs and images, and the
receipt ConfigMaps `mr-fence-01a1548e-0f66-…` and `mr-fence-01a1548e-0fc4-…`. T07's Pod `mr-01a14db1-…`, `Failed` before
the run, is now also `Terminating`, marked by the first drain. It has no VolumeAttachment, and T07's manager takes its
finalizer off when T07's server runs with the switch on. The webhook is removed, the test server and gate are stopped,
and both VMs are off. (T02c released T07's Pod on 2026-10-19 with the runbook's patch, [below](#t07s-leftover-pod).)

## Git work and engine sessions through a power cut (T02c)

Recorded 2026-10-19 by task T02c, part of criterion 2, on the two nodes of [L1](#two-nodes-l1). It measured what a node's
power cut leaves of a managed runner's last seconds, before and after the runner syncs its volume
([the design record](managed-runner-design.md#implementation-record-git-work-and-engine-sessions-through-a-power-cut)).
The records are in [the evidence](evidence/managed-runner-power-cut-durability/2026-10-19/README.md). One run of
`durability-lab.py`: 41 steps, 204 checks. Four steps failed and were fixed or run again (below).

- **Model.** fake-model.py stood in as a DeepSeek-preset key, which is not a model.
- **Images.** The project line's runner: T02's build from `8055bb568`, in both VMs' containerd. This branch's runner:
  `0e894464e` for the run after the fix, and `5928c0e0a` for the damaged volume woken at the end. Each was built with
  the evidence's `kit/build-image.sh` and imported into both VMs; nothing was pushed.
- **Lab window.** Both VMs were on from 16:38 to 17:52 UTC, after another session's pg-spec matrix had ended.

```sh
export LAB_TEST_SERVER_DIR=/mnt/data/managed-runner-lab/test-server-t02c   # earlier tasks' databases untouched
sudo scripts/managed-runner/lab/status.sh && sudo scripts/managed-runner/lab/start.sh --nodes 2
bash scripts/worktree-overlay.sh && npm run build -w @orbit/shared && npm run build -w @orbit/apiserver
E=docs/evidence/managed-runner-power-cut-durability/2026-10-19
bash $E/kit/build-image.sh /mnt/data/tmp/t02c/image          # this branch's image (LAB_T02C_AFTER_IMAGE)
OUT=/mnt/data/tmp/t02c/run && mkdir -p $OUT
sudo systemd-run --unit=orbit-mr-lab-t02c-run --collect -p MemoryMax=1G -p Environment=HOME=/root \
  -p Environment=LAB_TEST_SERVER_DIR=$LAB_TEST_SERVER_DIR -p WorkingDirectory=$PWD \
  -p StandardOutput=append:$OUT/run.txt -p StandardError=append:$OUT/run.txt \
  /usr/bin/python3 -I $PWD/scripts/managed-runner/lab/durability-lab.py run --out $OUT    # --from-step PHASE/STEP goes on
python3 scripts/managed-runner/lab/durability-lab.py report $OUT
sudo scripts/managed-runner/lab/stop.sh
```

| Check | Result |
| --- | --- |
| Before (amy, the project line's runner) | The cut came 0.0 s after the runner's merge returned and the last turn was answered, 0.4 s after the engine's commit, 1.5 s after the runner's commit and 2.3 s after an engine commit in a turn still running. Read from a copy of the snapshot: every repository unreadable, `git fsck` exit 11. `master` and both session branches point at commits whose object files are empty; a new worktree's `HEAD`, `gitdir` and `commondir` are empty. The last turn is missing from the engine's transcript. After the failover the session resumed without it, in the same broken repositories |
| After (bob, this branch's runner) | The cut came 0.0, 0.9, 2.3 and 4.3 s after the same five kinds of Git work. Every repository read, `git fsck` was clean, and there was no empty file or lock. Every returned commit was on its branch, the mid-turn one too, and the last turn was in the transcript. The session resumed with it. The next start said `0 stale lock files removed, 0 branches restored, 0 checkouts damaged` |
| A damaged volume on the fixed runner | amy's volume woken on `5928c0e0a`: the start logged each unreadable repository with its reason and refused the reclaimed sessions. The next message's session ended `FAILED` with `REPOSITORY_DAMAGED` and the reason; no engine saw it, and nothing was started over the broken repository |
| Git's commit costs | On a claim of the runner class on the second node, medians: a one-file commit 49 ms with Git's defaults, 299 ms followed by `syncfs`, 893 ms with `core.fsync=all`. A 200-file commit 0.16 s, 1.04 s and 59.2 s |
| Failover | Both runs went through the runbook's failover as in T02 (receipt, out-of-service taint, finalizer): `FENCING` 7.0 s and 11.4 s after the taint, READY on the first node 26 s after the finalizer came off |
| At the end | Never more than one Pod on either claim nor one attachment of either PV in the timeline; Ceph `HEALTH_OK`; every account asleep |

How the run went:

- A first attempt at the before run (ann) stopped before its cut: the driver read the last turn by an id the turn's
  answer does not carry. Its last turn and merge had already run, so ann was put to sleep and the before run was done
  again with a new account (amy).
- The read of what amy's cut left failed once in its cleanup (the copy keeps the snapshot `import-diff` writes), and was
  read again from the same snapshot.
- The first wake of the damaged volume, on `0e894464e`, found the refusal lost on a claim: the runner logged the damage,
  refused the reclaimed session, then answered its next message anyway. The fix is `5928c0e0a`, and the wake was run
  again on its build.

### The after run again for a later runner change (D10)

Task D10 changed the runner's syncs for volumes that share their filesystem (Docker's), so the run after T02c's fix
was done again on 2026-10-19 with that change, through the phase `again`
([the evidence](evidence/managed-runner-docker-volume-sync/2026-10-20/README.md#kubernetes-unchanged-t02cs-power-cut-after-the-fix-on-this-change)).
Both VMs were on from 22:58 to 23:14 UTC.

```sh
export LAB_TEST_SERVER_DIR=/mnt/data/managed-runner-lab/test-server-t02c
sudo scripts/managed-runner/lab/status.sh && sudo scripts/managed-runner/lab/start.sh --nodes 2
bash scripts/worktree-overlay.sh && npm run build -w @orbit/shared && npm run build -w @orbit/apiserver
bash docs/evidence/managed-runner-power-cut-durability/2026-10-19/kit/build-image.sh /mnt/data/tmp/<task>/lab-image
OUT=/mnt/data/tmp/<task>/lab-run && mkdir -p $OUT/logs
sudo systemd-run --unit=orbit-mr-lab-d10-run --collect -p MemoryMax=1G -p Environment=HOME=/root \
  -p Environment=LAB_TEST_SERVER_DIR=$LAB_TEST_SERVER_DIR \
  -p Environment=LAB_T02C_AFTER_IMAGE=/mnt/data/tmp/<task>/lab-image/lab.oci.tar \
  -p Environment=LAB_T02C_AFTER_OWNER=cyd -p Environment=LAB_T02C_BEFORE_OWNER=amy \
  -p WorkingDirectory=$PWD -p StandardOutput=append:$OUT/logs/run.txt -p StandardError=append:$OUT/logs/run.txt \
  /usr/bin/python3 -I $PWD/scripts/managed-runner/lab/durability-lab.py run --out $OUT --from again
sudo scripts/managed-runner/lab/stop.sh
```

- It restarts what the last teardown stopped with the image pinned, then does the after run with a new account (a run
  done again takes one). The final checks read `LAB_T02C_BEFORE_OWNER`'s claim too.
- Its own checks: the runner's start line says it syncs behind every tool with its volume the root of an RBD ext4, and
  s3's mid-turn commit is on its branch in what the cut left.
- 15 steps and 90 checks, none failed. The runner on `/dev/rbd0` logged `volume syncs: before reports and behind every
  tool; the volume is /dev/rbd0 (ext4), a filesystem of its own`. What the cut left was as after T02c's fix, s3's commit
  3.4 s before the cut included.
- `test-server-t02c` now has `cyd` asleep on its claim beside ann, amy and bob.

### T07's leftover Pod

`mr-01a14db1-…` (UID `52ed1c8a-…`) was a managed Pod of task T07's test server. It had been held by the stop-report
finalizer since T07's manager stopped running, and was `Terminating` since T08x's drain. Before it was released:

- T07's database, read in a copy, names the runner `01a14db1-e2b6-…` (owner `t06-root@lab.invalid`) and this Pod's UID
  as its own.
- Its kubelet had reported the stop: `Failed`, every container terminated. Its node was `Ready`.
- Its `DisruptionTarget` was the eviction API's (the drain), not PodGC's or the taint manager's.
- It had no VolumeAttachment, and no manager was running.

The runbook's patch, the UID-tested one in "The stop-report finalizer", released it, and the Pod was gone within a second.

Left in the lab:

- `test-server-t02c`: ann, amy and bob SLEEPING on their claims, with their claims, PVs and images (`Retain`).
- The receipt ConfigMaps of amy's and bob's failovers.
- amy's volume still holds the damage the before run's cut left, as test data.
- The snapshot copies, their claims and images, and both snapshots were removed.
- The webhook was removed; the test server, its replica, the gate and the recorder were stopped; both VMs are off.

## Known limits

- **One physical machine, one failure domain.** Since L1 the lab has two k3s nodes, so a volume
  can be mounted by one node after the other and a node can be stopped hard. Both nodes are VMs on
  one host, with one power supply, one kernel underneath and one HDD; their link is a loopback TCP
  connection, and Ceph is a single-host cluster inside the first VM (three OSDs on one disk). A
  failure of the host, its disk or its network takes both nodes and the storage. Nothing here
  proves high availability across physical machines, and two-node evidence must say so. In
  single-node mode the lab is what it was before: criteria 3–7 and the single-node parts of 2 and 8.
- The scripts stop the second node hard (`stop.sh --node 2 --hard`); they offer no network
  partition that keeps both VMs running.
- The admission guard is installed only for a test window (`single-writer.py admission install`)
  and removed after it (`admission remove`): with no test server answering, `failurePolicy: Fail`
  refuses every Pod create in `orbit-mr-test`. No Rook or CSI snapshots are installed. Fencing is
  the runbook's operator procedure; T02 ran it with the hypervisor power-off (`stop.sh --node 2
  --hard`), not with a storage fence. `ceph-rbd-verify.py`'s live phases were not run; T02's driver
  covers that ground through the manager.
- The three replicas share one VM and one HDD: no durability against hardware failure, and I/O is
  bound by that disk.
- Kernel RBD and OSDs share one kernel. Shutdown ordering is handled; severe memory pressure inside
  the guest can still stall RBD I/O, the reason production keeps them apart.
- The host can swap guest memory when the host itself runs short (it did during the first
  provisioning, and in L1 while the two-node checks ran); the VMs then slow down.
  `OOMScoreAdjust=1000` makes the VMs, not the runner, the host OOM killer's first choice.
- The kubeconfig is k3s's cluster-admin. The manager's own identity is the ServiceAccount
  `orbit-mr-manager` (`single-writer.py identity`), with only the verbs the Kubernetes backend calls;
  the webhook's caller is k3s's API server, which presents a bearer token from its AdmissionConfiguration.
- Recreating the lab gives a new FSID and new keys; read `state/facts.json` after `create.sh`.
