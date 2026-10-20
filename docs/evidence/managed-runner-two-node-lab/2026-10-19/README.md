# A second k3s node in the lab (L1)

Task L1 (34iSoC3YeYPt1Rn0XFHLy) of the managed-runner project, 2026-10-19. The owner decided on 2026-10-19 to add a
second, smaller KVM VM on HPC to the single-machine lab, as a second k3s node. These are the records of building it
and of its smoke tests. T02 (cross-node takeover, criterion 2) and T08x (cross-node migration, criterion 8) are to test
in it next. The lab page's section is [Two nodes (L1)](../../../managed-runner-lab.md#two-nodes-l1); the scripts are in
[`scripts/managed-runner/lab/`](../../../../scripts/managed-runner/lab/).

What these records cannot show: both VMs are on one physical machine, with one power supply, one HDD and one failure
domain. Their link is a loopback TCP connection between two qemu processes, and Ceph is a single-host cluster in the
first VM (three OSDs on one disk). Nothing here is evidence of high availability across machines. Single-Pod
protection across nodes, fencing and takeover are T02's to establish.

## The environment

| | First VM `orbit-mr-lab` | Second VM `orbit-mr-lab-2` |
| --- | --- | --- |
| Unit | `orbit-mr-lab.service` in `system.slice`: `MemoryMax=6656M`, `OOMScoreAdjust=1000`, `CPUQuota=400%` | `orbit-mr-lab-2.service` in `system.slice`: `MemoryMax=3584M`, `OOMScoreAdjust=1000`, `CPUQuota=200%` |
| Guest | 4 vCPU, 6144 MiB; Ubuntu 26.04.1, kernel 7.0.0-34-generic | 2 vCPU, 3072 MiB; the same image and kernel (`facts-second-vm.json`) |
| Disks | `/mnt/data/managed-runner-lab/disks/root.qcow2` and `osd-{0,1,2}.qcow2` | `/mnt/data/managed-runner-lab/disks/node2-root.qcow2`, 30 GiB thin |
| Network | QEMU user network (SSH 127.0.0.1:16222, API 127.0.0.1:16443); `lablink0` 10.77.0.1/24 | its own QEMU user network (SSH 127.0.0.1:16223); `lablink0` 10.77.0.2/24 |
| The link | qemu `-netdev socket,listen=127.0.0.1:16230` | qemu `-netdev socket,connect=127.0.0.1:16230` |
| k3s v1.36.5+k3s1 | server, node IP 10.77.0.1, flannel over `lablink0` | agent of `https://10.77.0.1:6443`, node IP 10.77.0.2, flannel over `lablink0` |
| Ceph 20.2.4 | MON `[v2:10.77.0.1:3300,v1:10.77.0.1:6789]`, mgr, 3 OSDs on 10.77.0.1, `public_network` 10.77.0.0/24 (`facts-first-vm.json`) | none |
| Ceph-CSI v3.18.0 | operator, controller plugin (pinned by node affinity), node plugin | node plugin |

`topology.json` holds both nodes' labels, addresses, Pod CIDRs, flannel addresses, taints, allocatable resources and
the Pods on each. `10-host-boundary.txt` is the host after the runs. Its addresses and routes are the same as at the
task's start (the LAN, `docker0`, a default route), with no bridge or tap. The lab's qemu listens only on 127.0.0.1.
No `rbd`, `nbd`, `ceph` or `libceph` module is loaded, and no Kubernetes, Ceph or CSI tool is on the PATH. The VM
units' cgroups are outside `orbit-runner-root.service`. The host NIC MACs are redacted in that file.

## The records

| Record | What it shows |
| --- | --- |
| `00-before-l1-start.log` | The lab as L0 left it, booted by L0's scripts before any change. qemu listened on 127.0.0.1:16222 and 16443 only; healthy |
| `l0-volume-before-move.json`, `…-random.txt` | The L0 smoke volume (`mr-data-b3c54306…`) read before anything moved: 107 rows, row hash `1f88dd9f…`, `integrity_check` `ok`, random file `c7e6c66e…` |
| `01-create-move-first-run.log` | `create.sh` on the existing lab. Link NIC configured; the MON moved from 10.0.2.15 to 10.77.0.1 (the monmap printed); then the first OSD restart failed with "Device or resource busy". `provision.sh` now tolerates that and resumes |
| `02-create-move-rerun.log` | The rerun: the two OSDs still on 10.0.2.15 restarted onto 10.77.0.1. cephadm's stale "failed daemon" warning cleared by `ceph orch ps --refresh` (now in `provision.sh`), then HEALTH_OK. But k3s kept node IP 10.0.2.15: its installer does not restart for a new `config.yaml` |
| `03-create-k3s-node-ip.log` | After that fix: k3s restarted with node IP 10.77.0.1, monitors in the CSI config on 10.77.0.1, healthy, `cephListens 10.77.0.1` |
| `l0-volume-after-move.json`, `…-random.txt` | The L0 volume remounted after the move: every hash as before |
| `l0-review-smoke-report-2026-10-17.json` | The coordinator's own L0 review run of that volume (2026-10-17): the same 107 rows, row hash, file, Git commit and random-file hash |
| `04-create-second-vm.log` | `create.sh --nodes 2`: the memory guard for the second VM, its boot (SSH in 32 s), the link NIC, the join token (copied by hash, never printed), the agent, the node plugin; both nodes Ready |
| `05-migrate.json`, `05-migrate.log` | `two-node.py migrate`, below |
| `06-hard-stop.json`, `06-hard-stop-timeline.jsonl`, `06-hard-stop.log` | `two-node.py hard-stop`, below; the timeline holds every 5 s sample |
| `07-restart-both.log` | `stop.sh` (the second VM in 6 s, then the first in 18 s), `start.sh --nodes 2` behind the 3584 MiB guard, healthy 2 min 20 s later, `two-node.py verify` on the second node |
| `l0-volume-after-two-node-restart.json`, `l0-volume-after-single-node-restart.json` | The L0 volume after each restart: the same hashes |
| `08-single-node-mode-first-try.log` | `stop.sh --node 2` (cordoned first), idle memory, then the first `smoke.sh run`. It stopped because `smoke.sh` waited for every RBD device of the VM to unmap, and the remounted L0 volume kept one; it now waits for its own image only |
| `09-single-node-smoke.json`, `09-single-node-smoke.log` | Single-node mode, as T03-type tasks use it. `smoke.sh run`, `stop.sh`, `start.sh`, `smoke.sh verify`: L0's results again |
| `memory.jsonl` | Every memory sample: both units' cgroups, the guests' balloon figures, the host's `/proc/meminfo` |
| `11-final-stop.log` | Both VMs off after the checks |
| `12-destroy-recreate-second-vm.log`, `topology-after-recreate.json`, `facts-second-vm-after-recreate.json` | `start.sh --nodes 2`, then `destroy.sh --yes-destroy-lab --node 2`: the VM stopped, its node and node-password Secret deleted, disk and seed removed, Ceph untouched. Then `create.sh --nodes 2` from nothing, a new node UID, `two-node.py verify` on it (the second entry of `verifications` in `05-migrate.json`), and both VMs off again |
| `13-inventory-after.txt` | A last single-node start: 36 claims, all `Bound` (the 31 of 10-17 and 10-18 and this task's 5), 37 PVs (36 `Bound`, the one `Released` PV of 10-18 as before) and 37 RBD images; `ceph df`; the second node cordoned while its VM was off; both VMs off at the end |

## Results

**One PVC on both nodes** (`05-migrate.json`, run `l1m-20261019100149`):

- First node: the claim (RWO, ext4, `Retain`, image `orbit-mr-rbd/csi-vol-1ea2d45d…`) attached to `orbit-mr-lab`
  (VolumeAttachment `csi-d9bed501…`) and mapped by the first VM's kernel (watcher `10.77.0.1:0/…`). It got 104
  SQLite rows, a file, a Git commit and 32 MiB of random bytes.
- Second node: after the delete, the attachment was gone and the device unmapped in 13.4 s. The Pod on
  `orbit-mr-lab-2` was Ready in 53.4 s (the probe image's first pull there), with attachment `csi-d92a005c…` and
  the second VM's kernel as watcher (`10.77.0.2:0/…`). The same hashes and `integrity_check` `ok`; then 54 more
  rows, with the first 104 hashing as before.
- Back on the first node: the old attachment again, 158 rows, the same hashes, `integrity_check` `ok`.
- After both VMs stopped and started, `two-node.py verify` on the second node found the same 158 rows and hashes,
  and again on a second VM destroyed and rebuilt from nothing. There were never two attachments at once.

**The second node's hard stop** (`06-hard-stop.json`, run `l1h-20261019100612`): a writer Pod on the second node,
then SIGKILL to its qemu at 10:08:12.18Z.

| | |
| --- | --- |
| +34 s | the RBD watcher of the second VM gone (sampled every 15 s) |
| +48 s | node `Unknown`, taints `node.kubernetes.io/unreachable` `NoSchedule` and `NoExecute`; the Pod `Running` with Ready `False` |
| +5 min 48 s | the Pod evicted after its 300 s toleration: `deletionTimestamp` set, still listed as `Running` |
| +7 min | still so; the VolumeAttachment still attached to the dead node; no detach |
| boot +31 s | `start.sh --nodes 2`: node `Ready`, taints gone; the Pod `Failed` (the kubelet found no containers) |
| boot +52 s | the Pod removed, the VolumeAttachment deleted, no watcher |

Mounted on the first node, the claim held 121 rows: every one of the 120 acknowledged before the cut, and the one
being written. `integrity_check` was `ok` after WAL recovery. After this test Ceph raised `BLUESTORE_SLOW_OP_ALERT`
(osd.2, the shared HDD). Its 24-hour default lifetime held `status.sh` unhealthy; `provision.sh` now sets it to 600 s.

**Memory** (`memory.jsonl`; the host was shared with other sessions throughout):

- At rest the first VM held 2.7–3.0 GiB of host RAM plus swap in either mode, and the second about 1.0 GiB.
- Inside the guests, 1.5–1.6 GiB and 0.53 GiB were in use.
- Host `MemAvailable`: 7179 MiB with both off at 10:22; 5074 and 6200 MiB idle in two-node mode at 5 and
  10 minutes; 7179 MiB in single-node mode at 10:41; 8788–9674 MiB with both off later on.
