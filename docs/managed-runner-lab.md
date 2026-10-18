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
| `test-server.sh start [--managed\|--managed-false]\|stop\|status\|secrets` | The isolated test control plane on the host, all on 127.0.0.1 and outside the runner's cgroup with memory caps: PostgreSQL (container `orbit-mr-lab-pg`, port 15433), this checkout's apiserver (unit `orbit-mr-lab-api`, port 13710, built beforehand), a TLS front with a lab-only CA (unit `orbit-mr-lab-tls`, port 13711, the address Pods use: `https://10.0.2.2:13711`) and `fake-model.py` (unit `orbit-mr-lab-fake-model`, port 13712). Data, secrets and logs in `LAB_DIR/test-server`, or in `LAB_TEST_SERVER_DIR`, which keeps a task's database apart. `--managed` turns managed runners on with the profile `single-writer.py profile` wrote, `--managed-false` names the same profile with the switch explicitly `false`; `secrets` only makes the secrets and the lab CA. |
| `single-writer.py` | The manager's own Pods in the lab ([below](#single-writer-protection-t02a)): the manager's ServiceAccount and least-privilege RBAC, the admission webhook (k3s's AdmissionConfiguration with the webhook's bearer token, and the repository's webhook template), the image import under its digest, the manager profile, and the checks: second Pods, outages, the probe payload inside the runner container, storage records, credential replay at the runner door, stopping the runner, a force delete and an incomplete fencing receipt. |
| `manager-lab.py` | The manager against real k3s ([below](#manager-reconciliation-t04)): the T04 server directory, a second apiserver replica, owners and their concurrent sign-ins and ensures, the database against k3s (`consistency`), a recorder of every change, a stand-in Claude login on a runner's volume, a killed runner process, an operator's delete or eviction, an API outage, a controller crash timed on a create, the switch checks and one owner against another. |
| `login-lab.py` | Sign-in provisioning on real k3s ([below](#sign-in-provisioning-t05)), through manager-lab.py's gate, replica and views: accounts and timed (concurrent) sign-ins, an account with its own runner and arranged workspaces, its landing by the web's own rule and its deep links, the switch-off check for new and existing accounts, a model key on fake-model.py's endpoint or the owner's key file, sessions in the managed default workspace, a provisioning timeline, the manager's requests by size, and a database trigger that refuses the sign-in's intent. |
| `api-gate.py` | A pass-through in front of the k3s API forward that only the test manager's kubeconfig names: it logs each connection's TLS record sizes, never decrypting them, and can lose one create's answer after k3s applied it (and the read-back's), or hold it while the controller is killed. |
| `qmp.py SOCKET hostfwd-remove\|hostfwd-add` | Takes the 127.0.0.1 forward of the k3s API (or SSH) away and puts it back: an outage of the API server for everything on the host. |
| `lab-ca-image.Dockerfile` | One layer on the product image: the lab CA in the system trust store, for the manager's Pod, which mounts no CA bundle. |
| `runner-image.py` | Runs the optional runner image in the lab: imports an image archive into the guest's containerd, enrolls once, starts, stops and recreates the runner Pod on one PVC, drives sessions and a landing on the test server, and hashes the persistent state; see [Runner image](#runner-image-t03). |
| `fake-model.py` | An Anthropic-dialect stand-in that answers turns with canned text and logs each request's history, for checks that must not depend on a model or a key. Its answers are not engine acceptance. |

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

## Known limits

- **One physical machine, one node, one failure domain.** The multi-node parts of criterion 2
  (mounting on a second node, refusing duplicate Pods across nodes, takeover after the old node
  stops or is fenced) and criterion 8's cross-node migration cannot be verified here; they wait for
  a multi-machine cluster or another decision by the owner. Single-machine evidence must not be
  presented as covering them. Criteria 3–7 and the single-node parts of 2 and 8 can be tested here.
- The admission guard is installed only for a test window (`single-writer.py admission install`)
  and removed after it (`admission remove`): with no test server answering, `failurePolicy: Fail`
  refuses every Pod create in `orbit-mr-test`. No fencing procedure, Rook or CSI snapshots are
  installed. `ceph-rbd-verify.py`'s live phases need two nodes.
- The three replicas share one VM and one HDD: no durability against hardware failure, and I/O is
  bound by that disk.
- Kernel RBD and OSDs share one kernel. Shutdown ordering is handled; severe memory pressure inside
  the guest can still stall RBD I/O, the reason production keeps them apart.
- The host can swap guest memory when the host itself runs short (it did during the first
  provisioning); the VM then slows down. `OOMScoreAdjust=1000` makes the VM, not the runner, the
  host OOM killer's first choice.
- The kubeconfig is k3s's cluster-admin. The manager's own identity is the ServiceAccount
  `orbit-mr-manager` (`single-writer.py identity`), with only the verbs the Kubernetes backend calls;
  the webhook's caller is k3s's API server, which presents a bearer token from its AdmissionConfiguration.
- Recreating the lab gives a new FSID and new keys; read `state/facts.json` after `create.sh`.
