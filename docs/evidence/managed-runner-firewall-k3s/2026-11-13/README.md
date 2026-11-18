# The managed runners' firewall beside k3s: lab, revision 2 (2026-11-13)

Task 34wdoShyYD41lQoGgRxPv. The production rollout to 10.66.0.3 stopped because that host also runs single-node k3s,
whose jumps sit above `DOCKER-USER` in `FORWARD` and whose `KUBE-SERVICES` DNATs on every interface in nat `PREROUTING`.
[Revision 1](revision-1/README.md) put the firewall's rules first in `FORWARD`, `INPUT` and nat `PREROUTING` and put
them back at every check. The review found the hole it left: kube-router puts its jumps back on top as k3s starts and
on its syncs, and until the next check its per-pod chains accept a runner's packet to any pod. The saved tables of
revision 1 show how (`KUBE-ROUTER-FORWARD -d <pod> -j KUBE-POD-FW-…`, whose "default ingress" marks it `0x10000` and
then `0x20000`, then `-m mark --mark 0x20000/0x20000 -j ACCEPT`).

This revision (commit `1448c2c1d`; docs `6accc4b0b`) adds a refusal that does not depend on the order of any filter
or nat chain, on a host where Kubernetes runs
([the firewall's README, "Beside Kubernetes"](../../../../deploy/managed-runner/firewall/README.md#beside-kubernetes-k3s)):

- raw `PREROUTING` (which no Kubernetes component writes) starts with `-i <bridge> -j ORBIT-MR-RAW`. That chain returns
  the gateway's published port and the allowed destinations, and marks (`0x100000`) every packet to a refused range;
- a routing rule, `priority 1 iif <bridge> fwmark 0x100000/0x100000 prohibit`, right after the local table's rule,
  refuses every marked packet bound through the host before any filter chain sees it. The kernel answers with ICMP
  "administratively prohibited", which the runner reads as `EHOSTUNREACH`. The mark is set before nat `PREROUTING`, so
  a ClusterIP that `KUBE-SERVICES` would DNAT to a pod is refused too;
- once the service has seen Kubernetes it writes `kubernetes-seen` beside its configuration and puts all of this on as
  it starts, before k3s (as after a host restart).

A raw `DROP` was weighed and not taken: it stops the packet before the filter's reject, so every refused connection
would time out, and the install's probe (which needs `EHOSTUNREACH`) could not tell the firewall from a dead address.

## The machine and the run

One `docker:29.8.2-dind` container on the HPC host (10.66.0.2), privileged, with its own network namespace, iptables
and Docker, on the private bridge `mrk3s-net` (172.31.92.0/24) at 172.31.92.20, capped at 6 GB and 6 CPUs. Docker
29.8.2 with iptables 1.8.13 (nf_tables). k3s v1.37.2+k3s1 (the release binary, checked against its
`sha256sum-amd64.txt`) with k3s' networking defaults: flannel (`cni0` 10.42.0.1/24), kube-router network policy,
kube-proxy in iptables mode, ClusterIPs 10.43.0.0/16. Traefik, servicelb and metrics-server were left out
(`--disable`), which changes none of these chains. Not production, not 10.66.0.3. The HPC host's own firewall was not
touched, and the machine was removed after the run.

The whole run was one hold of the HPC heavy lock (`flock /mnt/data/tmp/34bc-hpc-heavy.lock gate-then.sh 4000
kit/heavy.sh 1448c2c1d`), 22:08–22:42Z. [kit/heavy.sh](kit/heavy.sh) runs, in order:

| Step | Log |
| --- | --- |
| The machine, a checkout of `1448c2c1d` | [logs/machine.txt](logs/machine.txt) |
| The channel-host kit installed while the machine runs **Docker only**: `remote-host.sh install --listen 172.31.92.20 --allow-peer 172.31.92.10 --instance orbit-lab-k3s` | [logs/kit-install.txt](logs/kit-install.txt) |
| Docker only: listings, `check`, status, a runner container, reach | [logs/0-docker-only.txt](logs/0-docker-only.txt), [logs/tables-docker-only.txt](logs/tables-docker-only.txt) |
| k3s started **for the first time**, the runner connecting to the cluster's addresses all along, the first rule of each hook sampled every 0.5 s | [logs/1-k3s-first-start.txt](logs/1-k3s-first-start.txt), [logs/watch-k3s-first-start.txt](logs/watch-k3s-first-start.txt) |
| k3s running (a NodePort 30053/tcp to CoreDNS added): listings, status, reach | [logs/2-k3s-running.txt](logs/2-k3s-running.txt) |
| **k3s restarted** (the server process killed and started again, as systemd's `KillMode=process` does), probed and sampled the same way | [logs/3-k3s-restart.txt](logs/3-k3s-restart.txt), [logs/watch-k3s-restart.txt](logs/watch-k3s-restart.txt) |
| Seven minutes more, a pod started at +60 s, for **kube-router's periodic sync** | [logs/4-sync.txt](logs/4-sync.txt), [logs/watch-sync.txt](logs/watch-sync.txt) |
| **The window held open by hand**: the service stopped, kube-router's `FORWARD`/`INPUT` jumps and kube-proxy's nat jump put above the firewall's and left there; reach | [logs/5-hold-window.txt](logs/5-hold-window.txt) |
| `remove`, what is left, the service started again; reach | [logs/6-remove.txt](logs/6-remove.txt), [logs/tables-final.txt](logs/tables-final.txt) |
| The firewall service's log over the whole run | [logs/firewall-service.txt](logs/firewall-service.txt) |

"The runner container" is a container of the kit's own `orbit-managed-runner:local` image on `orbit-managed-runners`
(172.18.0.2), as the runner's user 10001, with every capability dropped and `no-new-privileges`: [kit/reach.py](kit/reach.py) once per target,
[kit/watch.py](kit/watch.py) continuously. No Orbit server was attached, so the channel itself started none.

## Docker only: as before

The kit installed and probed as on any Docker host (`172.18.0.1:1`, `169.254.169.254:80` and `10.255.255.1:9` all
`EHOSTUNREACH`). The firewall's rules were the ones a host without Kubernetes always had: the jumps first in `INPUT`
and `DOCKER-USER`, nothing of this program in `FORWARD` itself, nat or raw, and no routing rule
([logs/0-docker-only.txt](logs/0-docker-only.txt)):

```text
-- iptables -t nat -S PREROUTING
 1: -A PREROUTING -m addrtype --dst-type LOCAL -j DOCKER
-- iptables -t raw -S PREROUTING
-- ip -4 rule
0:	from all lookup local
32766:	from all lookup main
32767:	from all lookup default
```

`check` answered `{"backend": "nft", "enforced": true, "problems": []}`. The status had no `kubernetes` field, and no
`kubernetes-seen` file was in the firewall's directory. From the runner every private TCP target was `EHOSTUNREACH`;
the DNS question to the private 192.168.1.254 got no answer (timeout); and 1.1.1.1:443, DNS from 1.1.1.1 and public
HTTPS were reached.

## The rules with k3s running

From [logs/2-k3s-running.txt](logs/2-k3s-running.txt) (IPv4, numbered; bridge `br-47331a1a866c`, gateway 172.18.0.1):

```text
-- iptables -t filter -S FORWARD
 1: -A FORWARD -i br-47331a1a866c -m comment --comment orbit-managed-runners -j ORBIT-MR-FORWARD
 2: -A FORWARD -m comment --comment "kube-router netpol - TEMCG2JMHZYE7H7T" -j KUBE-ROUTER-FORWARD
 3: -A FORWARD -m conntrack --ctstate NEW -m comment --comment "kubernetes load balancer firewall" -j KUBE-PROXY-FIREWALL
 4: -A FORWARD -m comment --comment "kubernetes forwarding rules" -j KUBE-FORWARD
 5: -A FORWARD -m conntrack --ctstate NEW -m comment --comment "kubernetes service portals" -j KUBE-SERVICES
 6: -A FORWARD -m conntrack --ctstate NEW -m comment --comment "kubernetes externally-visible service portals" -j KUBE-EXTERNAL-SERVICES
 7: -A FORWARD -j DOCKER-USER
 8: -A FORWARD -j DOCKER-FORWARD
 9: -A FORWARD -m comment --comment "flanneld forward" -j FLANNEL-FWD
-- iptables -t filter -S INPUT
 1: -A INPUT -i br-47331a1a866c -m comment --comment orbit-managed-runners -j ORBIT-MR-INPUT
 2: -A INPUT -m comment --comment "kube-router netpol - 4IA2OSFRMVNDXBVV" -j KUBE-ROUTER-INPUT
 ...
-- iptables -t nat -S PREROUTING
 1: -A PREROUTING -i br-47331a1a866c -m comment --comment orbit-managed-runners -j ORBIT-MR-PREROUTING
 2: -A PREROUTING -m comment --comment "kubernetes service portals" -j KUBE-SERVICES
 3: -A PREROUTING -m addrtype --dst-type LOCAL -j DOCKER
-- iptables -t raw -S PREROUTING
 1: -A PREROUTING -i br-47331a1a866c -m comment --comment orbit-managed-runners -j ORBIT-MR-RAW
 2: -A PREROUTING -d 172.18.0.2/32 ! -i br-47331a1a866c -j DROP
-- iptables -t raw -S ORBIT-MR-RAW
-A ORBIT-MR-RAW -d 172.18.0.1/32 -p tcp -m tcp --dport 2086 -j RETURN
-A ORBIT-MR-RAW -d 10.0.0.0/8 -j MARK --set-xmark 0x100000/0x100000
-A ORBIT-MR-RAW -d 172.16.0.0/12 -j MARK --set-xmark 0x100000/0x100000
   ... one MARK rule for each range ORBIT-MR-FORWARD rejects, 14 in all ...
-- ip -4 rule
0:	from all lookup local
1:	from all fwmark 0x100000/0x100000 iif br-47331a1a866c prohibit
32766:	from all lookup main
32767:	from all lookup default
```

`ORBIT-MR-FORWARD`, `ORBIT-MR-INPUT` and `ORBIT-MR-PREROUTING` are as in revision 1. The raw rule at 2 is Docker's
own. IPv6 is in the same order, with `ORBIT-MR-RAW` a single `MARK` and the same routing rule under `ip -6 rule`.
`status.json`: `"state": "enforced"`, `"kubernetes": ["IPv4", "IPv6"]`, and `kubernetes-seen` beside `config.json`.

## Kubernetes putting its jumps back on top, and what a runner reached meanwhile

The first rule of each hook, sampled every 0.5 s and printed when it changed (`rule1` counts the routing rule):

```text
k3s starting for the first time (logs/1-k3s-first-start.txt)
22:25:20  FORWARD: DOCKER-USER          INPUT: ORBIT-MR-INPUT     nat: DOCKER               raw: DROP          rule1: 0
22:25:29  FORWARD: DOCKER-USER          INPUT: KUBE-FIREWALL      nat: DOCKER               raw: DROP          rule1: 0
22:25:30  FORWARD: KUBE-PROXY-FIREWALL  INPUT: KUBE-PROXY-FIREWALL nat: KUBE-SERVICES       raw: DROP          rule1: 0
22:25:32  FORWARD: ORBIT-MR-FORWARD     INPUT: ORBIT-MR-INPUT     nat: ORBIT-MR-PREROUTING  raw: ORBIT-MR-RAW  rule1: 1
22:25:41  FORWARD: KUBE-ROUTER-FORWARD  INPUT: KUBE-ROUTER-INPUT  nat: ORBIT-MR-PREROUTING  raw: ORBIT-MR-RAW  rule1: 1
22:25:43  FORWARD: ORBIT-MR-FORWARD     INPUT: ORBIT-MR-INPUT     nat: ORBIT-MR-PREROUTING  raw: ORBIT-MR-RAW  rule1: 1
22:25:58  FORWARD: KUBE-ROUTER-FORWARD  INPUT: KUBE-ROUTER-INPUT  nat: ORBIT-MR-PREROUTING  raw: ORBIT-MR-RAW  rule1: 1
22:26:03  FORWARD: ORBIT-MR-FORWARD     INPUT: ORBIT-MR-INPUT     nat: ORBIT-MR-PREROUTING  raw: ORBIT-MR-RAW  rule1: 1
k3s restarted (logs/3-k3s-restart.txt)
22:29:55  FORWARD: ORBIT-MR-FORWARD     INPUT: ORBIT-MR-INPUT     nat: ORBIT-MR-PREROUTING  raw: ORBIT-MR-RAW  rule1: 1
22:30:03  FORWARD: KUBE-ROUTER-FORWARD  INPUT: KUBE-ROUTER-INPUT  nat: ORBIT-MR-PREROUTING  raw: ORBIT-MR-RAW  rule1: 1
22:30:06  FORWARD: ORBIT-MR-FORWARD     INPUT: ORBIT-MR-INPUT     nat: ORBIT-MR-PREROUTING  raw: ORBIT-MR-RAW  rule1: 1
seven minutes more, a pod started at 22:34:13 (logs/4-sync.txt)
22:33:13  FORWARD: ORBIT-MR-FORWARD     INPUT: ORBIT-MR-INPUT     nat: ORBIT-MR-PREROUTING  raw: ORBIT-MR-RAW  rule1: 1
22:35:03  FORWARD: ORBIT-MR-FORWARD     INPUT: KUBE-ROUTER-INPUT  nat: ORBIT-MR-PREROUTING  raw: ORBIT-MR-RAW  rule1: 1
22:35:04  FORWARD: KUBE-ROUTER-FORWARD  INPUT: KUBE-ROUTER-INPUT  nat: ORBIT-MR-PREROUTING  raw: ORBIT-MR-RAW  rule1: 1
22:35:08  FORWARD: ORBIT-MR-FORWARD     INPUT: ORBIT-MR-INPUT     nat: ORBIT-MR-PREROUTING  raw: ORBIT-MR-RAW  rule1: 1
```

(The `ip6 FORWARD` column of the logs is left out here; it held `ORBIT-MR-FORWARD` from 22:25:32 on. The pod lines are
from the same log.)

- **kube-router's periodic sync is every 5 minutes, and it puts its jumps back on top each time.** That happened at
  22:30:03 (the restart), at 22:35:03, five minutes later, and again at 22:40:10 (in the service's log). The pod
  started at 22:34:13 moved nothing by itself. On first start it also did so twice in the first 30 s (22:25:41,
  22:25:58).
- Each time, the service's next check put the firewall's jumps first again 2 to 5 s later, and logged it ("IPv4: INPUT
  does not start with the jump for br-47331a1a866c: KUBE-ROUTER-INPUT come(s) before it; FORWARD does not start with
  the jump for br-47331a1a866c: KUBE-ROUTER-FORWARD come(s) before it: writing the rules",
  [logs/firewall-service.txt](logs/firewall-service.txt)).
- **The raw jump and the routing rule never moved.** No Kubernetes component touched raw `PREROUTING` or the routing
  rules. After 22:25:32 kube-proxy did not move the nat jump either.
- On the very first start, with no `kubernetes-seen` yet, kube-proxy's jumps were above Docker's from 22:25:30 until
  the service's check at 22:25:32 found Kubernetes. That is two to three seconds (kube-proxy's `INPUT` jump from
  22:25:29), and no pod existed yet.

Through all of it the runner container connected to the cluster's addresses without a pause (each round of 13
targets, every attempt with a 0.4 s timeout, about every 4.7 s). The summaries from the watch logs:

| Watch | Duration | Rounds | Connected or answered |
| --- | --- | --- | --- |
| [k3s first start](logs/watch-k3s-first-start.txt) | 22:25:21–22:28:42 | 43 | **0** |
| [k3s restart](logs/watch-k3s-restart.txt) | 22:29:47–22:33:09 | 42 | **0** |
| [periodic sync](logs/watch-sync.txt) | 22:33:13–22:40:16 | 88 | **0** |

The targets: TCP 53 at pod IPs 10.42.0.2 to 10.42.0.6 (CoreDNS was 10.42.0.3 and then 10.42.0.4), CoreDNS's readiness
port 8181, kube-dns 10.43.0.10 over TCP and as a DNS question over UDP, a DNS question to the pod over UDP, the API
ClusterIP 10.43.0.1:443, the node's NodePort 172.31.92.20:30053 and k3s API :6443, and the kubelet on `cni0`
10.42.0.1:10250. Every attempt ended `EHOSTUNREACH` or `TIMEOUT`, and none connected or was answered. The timeouts are
the kernel's rate limit on the ICMP errors it sends one host (a few at once, then about one a second), with 13 targets
tried in a burst.

## The window held open

To show the refusal does not rest on chain order, without depending on when a sample falls, the service was stopped,
and kube-router's and kube-proxy's jumps were put first by hand and left there
([logs/5-hold-window.txt](logs/5-hold-window.txt)):

```text
-- iptables -t filter -S FORWARD
 1: -A FORWARD -m comment --comment "kube-router netpol - TEMCG2JMHZYE7H7T" -j KUBE-ROUTER-FORWARD
 2: -A FORWARD -i br-47331a1a866c -m comment --comment orbit-managed-runners -j ORBIT-MR-FORWARD
-- iptables -t filter -S INPUT
 1: -A INPUT -m comment --comment "kube-router netpol - 4IA2OSFRMVNDXBVV" -j KUBE-ROUTER-INPUT
 2: -A INPUT -i br-47331a1a866c -m comment --comment orbit-managed-runners -j ORBIT-MR-INPUT
-- iptables -t nat -S PREROUTING
 1: -A PREROUTING -m comment --comment "kubernetes service portals" -j KUBE-SERVICES
 2: -A PREROUTING -i br-47331a1a866c -m comment --comment orbit-managed-runners -j ORBIT-MR-PREROUTING
-- iptables -t raw -S PREROUTING
 1: -A PREROUTING -i br-47331a1a866c -m comment --comment orbit-managed-runners -j ORBIT-MR-RAW
-- ip -4 rule
1:	from all fwmark 0x100000/0x100000 iif br-47331a1a866c prohibit
```

This is what revision 1 measured as the program before the change did: kube-dns, the CoreDNS pod and the NodePort
`CONNECTED`, with kube-router's chains ahead of the reject. Now:

| Target | Window held open | k3s running, rules first |
| --- | --- | --- |
| kube-dns ClusterIP 10.43.0.10:53 (TCP) | `EHOSTUNREACH` | `EHOSTUNREACH` |
| kube-dns ClusterIP, a DNS question over UDP | `EHOSTUNREACH` | `EHOSTUNREACH` |
| kubernetes API ClusterIP 10.43.0.1:443 | `EHOSTUNREACH` | timeout |
| CoreDNS pod 10.42.0.4:53 (TCP) | timeout | timeout |
| CoreDNS pod, a DNS question over UDP | timeout | timeout |
| CoreDNS pod, readiness port 8181 | `EHOSTUNREACH` | `EHOSTUNREACH` |
| The node address: k3s API 6443 | `EHOSTUNREACH` | `EHOSTUNREACH` |
| The node address: kubelet 10250 | `EHOSTUNREACH` | `EHOSTUNREACH` |
| The node address: NodePort 30053 | timeout | `EHOSTUNREACH` |
| `cni0` 10.42.0.1:10250 | `EHOSTUNREACH` | `EHOSTUNREACH` |
| This host on the runners' network: 22, 6443 | `EHOSTUNREACH` | `EHOSTUNREACH` |
| The HPC host: lab bridge, LAN, `wg1`, port 22 | timeout | timeout |
| Cloud metadata 169.254.169.254:80 | timeout | timeout |
| A private DNS server 192.168.1.254 over UDP | timeout | timeout |
| 1.1.1.1:443 | `CONNECTED` | `CONNECTED` |
| A DNS question to 1.1.1.1 over UDP | answered | answered |
| `https://www.cloudflare.com/cdn-cgi/trace`, `https://github.com/` | `HTTP 200` | `HTTP 200` |

Nothing private was reached in either column, and every public target was. "timeout" is a refused connection that got
no ICMP answer within the probe's 5 s (TCP) or 3 s (UDP), because of the kernel's rate limit above: these targets come
late in a burst of refused ones, while the first refusals of a burst are `EHOSTUNREACH`. The node's own
addresses go to `INPUT`, which routing does not refuse: there kube-router's `INPUT` chain accepts only what its pods send,
so the filter's reject at position 2 still refuses a runner. `check` meanwhile said the rules were not in force (exit 1).
Started again, the service put every jump first and said `{"state":"enforced","kubernetes":["IPv4","IPv6"]}`.

## remove

With the service stopped, `remove` took off in both families: the jumps in `INPUT`, `FORWARD` and `DOCKER-USER`;
`ORBIT-MR-INPUT` and `ORBIT-MR-FORWARD`; the nat and raw `PREROUTING` jumps; `ORBIT-MR-PREROUTING` and
`ORBIT-MR-RAW`; and the routing rule. Afterwards `iptables-save` and `ip6tables-save` held no line naming `ORBIT-MR`, and
no routing rule had the mark ([logs/6-remove.txt](logs/6-remove.txt)). Every Kubernetes and Docker rule was still
there. Started again, the service wrote the rules (`kubernetes-seen` was still there), and the runner's results were
those of the right-hand column above.

## Not covered

- **The very first start of Kubernetes on a host whose firewall has never seen it.** Until the service's next check
  (2 s here, at most `intervalSeconds`), neither the raw guard nor the routing rule is there, and kube-proxy's and
  kube-router's jumps can sit above Docker's. In this lab no pod existed yet in those seconds, and the runner reached
  nothing. On 10.66.0.3, k3s runs before the firewall is first installed, so the service finds it in its first check,
  and writes `kubernetes-seen` before any runner starts (the channel starts none until the status says enforced).
- **The ICMP rate limit.** On a host with Kubernetes, refusals through the host come from routing. The kernel answers
  only a few at once, then about one a second, so a burst of refused connections partly times out instead of failing
  at once. Nothing is reached either way.
- 10.66.0.3's host unit `/usr/local/sbin/k3s-host-firewall.sh`, NodePorts bound to one address (`nodeport-addresses`),
  and a k3s on another iptables backend than Docker's were not reproduced.
