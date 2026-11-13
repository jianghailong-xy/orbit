# The managed runners' firewall beside k3s: lab (2026-11-13)

Task 34wdoShyYD41lQoGgRxPv. The production rollout to 10.66.0.3 stopped because that host also runs single-node k3s,
whose jumps sit above `DOCKER-USER` in `FORWARD` and whose `KUBE-SERVICES` DNATs on every interface in nat
`PREROUTING`; the firewall refused to report enforced there. This lab shows the change (commit `b7ee5596c`; the docs
commit after it changes no code) on a host running Docker and k3s together:
[the firewall's README, "Beside Kubernetes"](../../../../deploy/managed-runner/firewall/README.md#beside-kubernetes-k3s).

## The machine

One `docker:29.8.2-dind` container on the HPC host (10.66.0.2), privileged, with its own network namespace, iptables
and Docker, on a private bridge `mrk3s-net` (172.31.92.0/24) at 172.31.92.20, capped at 6 GB and 6 CPUs. Not
production, not 10.66.0.3; the HPC host's own firewall was not touched. The machine was removed after the run.

| | |
| --- | --- |
| Docker | 29.8.2, iptables v1.8.13 (nf_tables) |
| k3s | v1.37.2+k3s1 (the release binary, checked against its `sha256sum-amd64.txt`), `--node-ip 172.31.92.20`, with k3s' networking defaults: flannel (vxlan, `cni0` 10.42.0.1/24, pods 10.42.0.0/16), kube-router network policy, kube-proxy in iptables mode, ClusterIPs 10.43.0.0/16. Traefik, servicelb and metrics-server were disabled (`--disable`) to save memory; none of them changes these chains. The NodePort service `kube-system/lab-dns-nodeport` (30053/tcp to CoreDNS) was added so that a NodePort could be tried. |
| The channel-host kit | `deploy/managed-runner/remote-host/remote-host.sh install --listen 172.31.92.20 --allow-peer 172.31.92.10 --instance orbit-lab-k3s` from a checkout of `b7ee5596c`, on the host where k3s already ran ([log](logs/kit-install.txt)) |

The whole run was one hold of the HPC heavy lock (`flock /mnt/data/tmp/34bc-hpc-heavy.lock gate-then.sh 4000
kit/heavy.sh`), 20:05–20:22Z. A first attempt the evening before failed before it started: the machine, created outside
the lock, was taken by the HPC host's OOM killer while the job waited about ten hours in the lock's queue, so this run
creates it inside the hold.

## Commands

Scripts in [kit/](kit/), run from the HPC host; [kit/heavy.sh](kit/heavy.sh) runs them in this order:

1. `kit/machine.sh up`, `checkout b7ee5596c`, `k3s-start`, `k3s-wait` ([log](logs/k3s-up.txt)); the NodePort; the
   tables of k3s alone ([logs/iptables-k3s-before-kit.txt](logs/iptables-k3s-before-kit.txt): no `ORBIT-MR` line).
2. The kit install ([log](logs/kit-install.txt)).
3. `kit/lab.sh listing`, `state` and `reach` after the install ([logs/1-installed.txt](logs/1-installed.txt)).
4. `kit/lab.sh restart`: k3s killed and started again, as `systemctl restart k3s` does (KillMode=process); the first rule
   of each hook sampled every 0.5 s; then the listing, state and reach again ([logs/2-k3s-restart.txt](logs/2-k3s-restart.txt)).
5. `kit/lab.sh before-program`: the service stopped, `remove`, and the firewall program before this task
   (`git show a5e20f8ef:deploy/managed-runner/firewall/firewall.py`, mounted over the image's) applied once on the same
   host; the listing and reach ([logs/3-before-program.txt](logs/3-before-program.txt)).
6. `kit/lab.sh remove`: the service stopped, `remove`, what is left, the service started again; listing, state, reach
   ([logs/4-remove.txt](logs/4-remove.txt)). The tables at the end: [logs/iptables-final.txt](logs/iptables-final.txt).

"From a runner container" is a container of the kit's own `orbit-managed-runner:local` image on
`orbit-managed-runners`, as the runner's user 10001, every capability dropped, `no-new-privileges`
([kit/reach.py](kit/reach.py)); no Orbit server was attached, so the channel started none itself.

## The install, on a host already running k3s

The preflight found Kubernetes in both families and tried the nat guard's rules in a scratch chain:

```json
{"backend": "nft", "iptables": "iptables v1.8.13 (nf_tables)", "ipv4Hook": "DOCKER-USER", "ipv4Kubernetes": true, "ipv6": "present", "ipv6Hook": "DOCKER-USER", "ipv6Kubernetes": true}
```

The rules were written once for each family, the install's probe from the network passed (`172.18.0.1:1`,
`169.254.169.254:80`, `10.255.255.1:9` all `EHOSTUNREACH`, `registry-1.docker.io` resolved), and both services came up
healthy.

## Rule listings

Before the kit, k3s alone (from [logs/iptables-k3s-before-kit.txt](logs/iptables-k3s-before-kit.txt)): the five
Kubernetes jumps lead `FORWARD`, `DOCKER-USER` is sixth, flannel's `FLANNEL-FWD` last; nat `PREROUTING` is
`KUBE-SERVICES`, then Docker's `DOCKER`.

After the install, and the same after the k3s restart (IPv4, `iptables -S`, numbered; bridge `br-9e958c5a5c2a`, gateway
172.18.0.1):

```text
-- FORWARD
 1: -A FORWARD -i br-9e958c5a5c2a -m comment --comment orbit-managed-runners -j ORBIT-MR-FORWARD
 2: -A FORWARD -m comment --comment "kube-router netpol - TEMCG2JMHZYE7H7T" -j KUBE-ROUTER-FORWARD
 3: -A FORWARD -m conntrack --ctstate NEW -m comment --comment "kubernetes load balancer firewall" -j KUBE-PROXY-FIREWALL
 4: -A FORWARD -m comment --comment "kubernetes forwarding rules" -j KUBE-FORWARD
 5: -A FORWARD -m conntrack --ctstate NEW -m comment --comment "kubernetes service portals" -j KUBE-SERVICES
 6: -A FORWARD -m conntrack --ctstate NEW -m comment --comment "kubernetes externally-visible service portals" -j KUBE-EXTERNAL-SERVICES
 7: -A FORWARD -j DOCKER-USER
 8: -A FORWARD -j DOCKER-FORWARD
 9: -A FORWARD -m comment --comment "flanneld forward" -j FLANNEL-FWD
-- INPUT
 1: -A INPUT -i br-9e958c5a5c2a -m comment --comment orbit-managed-runners -j ORBIT-MR-INPUT
 2: -A INPUT -m comment --comment "kube-router netpol - 4IA2OSFRMVNDXBVV" -j KUBE-ROUTER-INPUT
 3: -A INPUT -m conntrack --ctstate NEW -m comment --comment "kubernetes load balancer firewall" -j KUBE-PROXY-FIREWALL
 4: -A INPUT -m comment --comment "kubernetes health check service ports" -j KUBE-NODEPORTS
 5: -A INPUT -m conntrack --ctstate NEW -m comment --comment "kubernetes externally-visible service portals" -j KUBE-EXTERNAL-SERVICES
 6: -A INPUT -j KUBE-FIREWALL
-- DOCKER-USER
 1: -A DOCKER-USER -i br-9e958c5a5c2a -m comment --comment orbit-managed-runners -j ORBIT-MR-FORWARD
-- nat PREROUTING
 1: -A PREROUTING -i br-9e958c5a5c2a -m comment --comment orbit-managed-runners -j ORBIT-MR-PREROUTING
 2: -A PREROUTING -m comment --comment "kubernetes service portals" -j KUBE-SERVICES
 3: -A PREROUTING -m addrtype --dst-type LOCAL -j DOCKER
-- nat ORBIT-MR-PREROUTING
-A ORBIT-MR-PREROUTING -d 172.18.0.1/32 -p tcp -m tcp --dport 2086 -j RETURN
-A ORBIT-MR-PREROUTING -j ACCEPT
```

`ORBIT-MR-INPUT` and `ORBIT-MR-FORWARD` hold the same rules as on a host without Kubernetes (the reject list of every
private and reserved range, the gateway's port). IPv6 has the same order: `ORBIT-MR-FORWARD` first in `FORWARD` (above
`KUBE-PROXY-FIREWALL`), `ORBIT-MR-INPUT` first in `INPUT`, `ORBIT-MR-PREROUTING` (one `ACCEPT`) first in nat
`PREROUTING`, both filter chains a single reject. Every Kubernetes and Docker rule is still there, in its order.

## The k3s restart

The first rule of each hook, sampled every 0.5 s and printed when it changed ([logs/2-k3s-restart.txt](logs/2-k3s-restart.txt)):

```text
2026-11-13T20:18:52Z k3s server stopped
2026-11-13T20:18:52Z k3s server started
20:18:52.  FORWARD: -j ORBIT-MR-FORWARD     INPUT: -j ORBIT-MR-INPUT     nat PREROUTING: -j ORBIT-MR-PREROUTING  ip6 FORWARD: -j ORBIT-MR-FORWARD
20:19:01.  FORWARD: -j ORBIT-MR-FORWARD     INPUT: -j KUBE-ROUTER-INPUT  nat PREROUTING: -j ORBIT-MR-PREROUTING  ip6 FORWARD: -j ORBIT-MR-FORWARD
20:19:01.  FORWARD: -j KUBE-ROUTER-FORWARD  INPUT: -j KUBE-ROUTER-INPUT  nat PREROUTING: -j ORBIT-MR-PREROUTING  ip6 FORWARD: -j ORBIT-MR-FORWARD
20:19:09.  FORWARD: -j ORBIT-MR-FORWARD     INPUT: -j ORBIT-MR-INPUT     nat PREROUTING: -j ORBIT-MR-PREROUTING  ip6 FORWARD: -j ORBIT-MR-FORWARD
```

kube-router, starting again, put its jumps first in `FORWARD` and `INPUT` 9 s after k3s started; the service's next
check, 8 s later and within its 10 s interval, put the firewall's first again. kube-proxy left its nat jump where it was,
so the nat guard stayed first throughout, and nothing moved over IPv6. Nothing moved again in the 150 s watched. The
service's log:

```text
2026-11-13T20:18:28Z orbit-managed-runner-firewall: enforced
2026-11-13T20:19:09Z orbit-managed-runner-firewall: IPv4: INPUT does not start with the jump for br-9e958c5a5c2a: KUBE-ROUTER-INPUT come(s) before it; FORWARD does not start with the jump for br-9e958c5a5c2a: KUBE-ROUTER-FORWARD come(s) before it: writing the rules
2026-11-13T20:19:09Z orbit-managed-runner-firewall: rules written for IPv4 (nft backend)
```

The check found and repaired it in the same pass, so the state never left `enforced`. Between 20:19:01 and 20:19:09
kube-router's chains came before the firewall's in `FORWARD` and `INPUT` while the status of the check before
still said enforced; see "Not covered" below.

## status.json and check

After the restart, `check` answered `{"backend": "nft", "enforced": true, "problems": []}` (exit 0), `show` listed each
jump as `rule 1 of N` in its hook, and the status file:

```json
{
  "apiPort": 2086,
  "backend": "nft",
  "bootId": "b519c2e2-1152-4338-b996-c2108aeeb937",
  "bridge": "br-9e958c5a5c2a",
  "checkedAt": 1794601301,
  "gateway": "172.18.0.1",
  "kubernetes": ["IPv4", "IPv6"],
  "network": "orbit-managed-runners",
  "schemaVersion": 1,
  "state": "enforced",
  "validUntil": 1794601331
}
```

Both services `Up (healthy)`.

## From a runner container

CoreDNS pod 10.42.0.3; the runner 172.18.0.2. The same results after the install (20:18:36Z), after the k3s restart
(20:21:43Z) and after `remove` and the service's restart (20:22:12Z). The last column is the firewall program before this
task, on the same host with k3s running (20:22:00Z):

| Target | Address | With this change | Before this change (`a5e20f8ef`) |
| --- | --- | --- | --- |
| kube-dns ClusterIP | 10.43.0.10:53 | `EHOSTUNREACH` | **`CONNECTED`** (DNATed to the pod by `KUBE-SERVICES`, marked, accepted by `KUBE-FORWARD`) |
| kubernetes API ClusterIP | 10.43.0.1:443 | `EHOSTUNREACH` | `EHOSTUNREACH` |
| CoreDNS pod IP | 10.42.0.3:53 | `EHOSTUNREACH` | **`CONNECTED`** |
| CoreDNS pod IP, readiness port | 10.42.0.3:8181 | `EHOSTUNREACH` | **`CONNECTED`** |
| The node address, k3s API | 172.31.92.20:6443 | `EHOSTUNREACH` | `EHOSTUNREACH` |
| The node address, kubelet | 172.31.92.20:10250 | `EHOSTUNREACH` | `EHOSTUNREACH` |
| The node address, a NodePort | 172.31.92.20:30053 | `EHOSTUNREACH` | **`CONNECTED`** |
| The node's flannel `cni0` address, kubelet | 10.42.0.1:10250 | `EHOSTUNREACH` | `EHOSTUNREACH` |
| This host on the runners' network, port 22 | 172.18.0.1:22 | `EHOSTUNREACH` | `EHOSTUNREACH` |
| This host on the runners' network, the k3s API | 172.18.0.1:6443 | `EHOSTUNREACH` | `EHOSTUNREACH` |
| The HPC host on the lab bridge | 172.31.92.1:22 | `EHOSTUNREACH` | `EHOSTUNREACH` |
| The HPC host's LAN address | 192.168.1.12:22 | `EHOSTUNREACH` | `EHOSTUNREACH` |
| The HPC host's `wg1` address | 10.66.0.2:22 | `EHOSTUNREACH` | `EHOSTUNREACH` |
| Cloud metadata | 169.254.169.254:80 | `EHOSTUNREACH` | `EHOSTUNREACH` |
| A public address | 1.1.1.1:443 | `CONNECTED` | `CONNECTED` |
| Public HTTPS | `https://www.cloudflare.com/cdn-cgi/trace` | `HTTP 200` | `HTTP 200` |
| Public HTTPS | `https://github.com/` | `HTTP 200` | `HTTP 200` |

`EHOSTUNREACH` is the firewall's reject (`icmp-admin-prohibited`). The program before this task said why it was not in
force, as it did on 10.66.0.3 (`{"enforced": false, "problems": ["IPv4: FORWARD does not start with Docker's jump to
DOCKER-USER", "IPv6: ..."]}`, exit 1), and its rules, which it had written in `DOCKER-USER`, left a runner the cluster's
DNS service, its pods and its NodePorts: what the refusal guarded against, measured.

## remove

With the service stopped, `remove` took off, in both families: the jumps in `INPUT`, `FORWARD` and `DOCKER-USER`,
`ORBIT-MR-INPUT` and `ORBIT-MR-FORWARD`, the nat `PREROUTING` jump and `ORBIT-MR-PREROUTING`
([logs/3-before-program.txt](logs/3-before-program.txt), the first lines); afterwards `iptables-save` and
`ip6tables-save` held no line naming `ORBIT-MR` ([logs/4-remove.txt](logs/4-remove.txt)), and every Kubernetes and Docker
rule was still there. Started again, the service wrote the rules and said `{"state":"enforced","kubernetes":["IPv4","IPv6"]}`.

## A host without Kubernetes

Not run again here: this lab's host had k3s. `WithoutKubernetesTest` in `scripts/managed-runner/firewall_test.py` holds
the iptables-restore transaction on a Docker-only host byte for byte to the rules before this change, with nothing in
nat, no jump in `FORWARD` itself and no `kubernetes` in the status; every earlier test of that file passes unchanged.
The Docker-only behaviour measured on 2026-10-19
([evidence](../../managed-runner-docker-firewall/2026-10-19/README.md)) is that transaction's.

## Not covered

- **The seconds after kube-router reinserts its jumps.** Until the service's next check (at most `intervalSeconds`, 10;
  8 s here) kube-router's `KUBE-ROUTER-FORWARD` and `KUBE-ROUTER-INPUT` see a runner's packets before the firewall, and
  the status written before still says enforced. The nat guard stayed first, so no ClusterIP was DNATed in that time;
  whether kube-router's chains would accept a runner's packet to a pod IP in those seconds was not measured.
- **kube-router's periodic sync** (every 5 minutes by default) was not watched: 150 s after the restart nothing moved.
  If it moves its jumps up again, the same check puts the firewall's back, as after the restart.
- **The host unit `/usr/local/sbin/k3s-host-firewall.sh` of 10.66.0.3**, NodePorts bound to one address
  (`nodeport-addresses`) and a k3s on another iptables backend than Docker's were not reproduced.
- **UDP** to the ClusterIP (DNS over UDP) was not probed; the nat guard and the reject list do not depend on the protocol.
