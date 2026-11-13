# Host firewall (managed runners, Docker backend)

[firewall.py](firewall.py) keeps the rules on a Docker-backend deployment's host that leave a managed runner what it
needs and nothing else of the host or the network behind it. Every account's managed runner is a container on one
bridge network of the host, `orbit-managed-runners`. Without these rules, code in it reaches every service the host
listens to on an address other than loopback (sshd, for one), and through the host the private networks behind it:
task D5 measured both on the HPC host.

Root Compose runs it as the `managed-runner-firewall` service, built from [Dockerfile](Dockerfile) (Python's standard
library, the iptables binaries of both backends and this one file), under the `managed-runner-firewall` profile. A
fresh install (`scripts/install-server.sh`) switches that profile on in `.env` beside the Docker backend's, and so do
`--enable-managed-runners` and `--enable-managed-runner-firewall`; `--no-managed-runner-firewall` leaves it off, and an
upgrade never starts, builds or recreates it. The design record is
[docs/managed-runner-design.md](../../../docs/managed-runner-design.md), "Implementation record: the managed runners'
host firewall"; operating it is in
[docs/managed-runner-docker-operations.md](../../../docs/managed-runner-docker-operations.md), "The managed runners'
firewall".

## What a runner keeps

Every rule matches only traffic that comes in from the network's bridge (`-i <bridge>`). Nothing else on the host,
another container or a host process included, is affected.

| From the managed runners' network | |
| --- | --- |
| To the host itself (`INPUT`) | The gateway's published port at the network's gateway address (`apiPort`, 2086 by default: how a runner reaches the apiserver), DNS to the servers in `dnsServers`, the destinations in `allow`, and the replies of connections already made. Everything else is rejected, on every address the host has. |
| Through the host (`DOCKER-USER`, so `FORWARD`) | The published port again: Docker DNATs a runner's connection to the gateway address and that port to the gateway's container on the stack's network, a private address. The rule matches what the runner asked for (`--ctorigdst <gateway> --ctorigdstport <port>`), so it holds whether Docker's userland proxy is on or off. Then `dnsServers`, `allow`, and every public address. 10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16 (the cloud metadata address), 127/8, 0/8, 192.0.0/24, the documentation and benchmarking ranges, multicast and 240/4 are rejected. |
| Over IPv6 | Nothing: the network is IPv4-only (the install creates it with `--ipv6=false` and refuses one with IPv6 on), and anything IPv6 from its bridge is rejected, to the host and through it. |

A rejected connection fails at once with "No route to host" (`icmp-admin-prohibited`, `EHOSTUNREACH`), which tells it
apart from a refused one (the host's own stack answered) and a timeout.

The rules only take reachability away. An allowed packet returns (`RETURN`) to the rules the host already has, so
nothing the host's own firewall closes is opened. They live in two chains of this program, `ORBIT-MR-INPUT` and
`ORBIT-MR-FORWARD`, reached from the first rule of `INPUT` and of `DOCKER-USER`, the chain Docker keeps first in
`FORWARD` and never flushes. Each write is one `iptables-restore --noflush` transaction of the backend Docker uses, nft
or legacy, so a reader finds the old rules or the new ones, never part of either.

### Beside Kubernetes (k3s)

On a host that also runs Kubernetes' networking (a `KUBE-*` or `FLANNEL-*` chain: kube-proxy, kube-router's network
policy, flannel, as single-node k3s has), `DOCKER-USER` is no longer the first word on a runner's packet. kube-router
and kube-proxy put their jumps (`KUBE-ROUTER-FORWARD`, `KUBE-PROXY-FIREWALL`, `KUBE-FORWARD`, `KUBE-SERVICES`, ...) above
it in `FORWARD`, and kube-proxy's `KUBE-SERVICES` in nat `PREROUTING` DNATs a connection to a ClusterIP on every
interface and marks it, so that `KUBE-FORWARD` accepts it into the cluster before `DOCKER-USER` is reached. There the
rules add, still matching the runners' bridge only:

| | |
| --- | --- |
| `FORWARD` | A first rule `-i <bridge> -j ORBIT-MR-FORWARD`, the same chain `DOCKER-USER` jumps to (which keeps its jump). |
| nat `PREROUTING` | A first rule `-i <bridge> -j ORBIT-MR-PREROUTING`. That chain lets the gateway's published port and the `allow`/`dnsServers` destinations go on (`RETURN`) to Docker's DNAT, and `ACCEPT`s everything else, which ends nat `PREROUTING` for that packet: `KUBE-SERVICES` never DNATs or marks it, so a ClusterIP stays a 10/8 address that `ORBIT-MR-FORWARD` rejects. Over IPv6 the chain is one `ACCEPT`. |
| raw `PREROUTING` | A first rule `-i <bridge> -j ORBIT-MR-RAW`. That chain lets the same destinations go on (`RETURN`) and marks every packet to a refused range (`MARK --set-xmark 0x100000/0x100000`; over IPv6, every packet). |
| Routing | `ip rule`: `priority 1 iif <bridge> fwmark 0x100000/0x100000 prohibit`, right after the local table's rule. A marked packet bound through the host is refused by routing, before any filter chain sees it, with ICMP "administratively prohibited": the runner gets `EHOSTUNREACH`, as from the filter's reject. |

Why the last two. kube-router puts its jumps back first in `FORWARD` and `INPUT` as k3s starts and on its syncs (pod
and policy changes, and every few minutes), and its per-pod chains (`KUBE-POD-FW-*`, default allow) accept a packet to a
pod before `ORBIT-MR-FORWARD` sees it: until this program's next check, a runner would reach pods. Kubernetes writes
neither raw `PREROUTING` nor routing rules, and the mark is set before nat `PREROUTING`, so a ClusterIP that
`KUBE-SERVICES` might DNAT to a pod is refused too, whatever order the filter and nat chains are in. Packets to the
host's own addresses are routed locally first; there kube-router's `INPUT` chain accepts only what its pods send, so the
filter rules still refuse them, also while kube-router's jump is above this program's (measured in the lab).

The rules count as in force only while each jump is the first rule of its hook (`INPUT`, `FORWARD`, nat and raw
`PREROUTING`) and the routing rule is there with only the local table's rule before it. The next check finds what came
first, logs it ("FORWARD does not start with the jump for br-…: KUBE-ROUTER-FORWARD come(s) before it ...: writing the
rules") and puts it first again in the same pass, within `intervalSeconds`; it reports `failing` only if it cannot.
`status.json` says `"kubernetes": ["IPv4", ...]` while it keeps the rules this way.

The first time the service finds Kubernetes it writes `kubernetes-seen` beside its configuration. From then on it puts
these rules on as soon as it starts, before Kubernetes' own: after a host restart the service may start before k3s.
A host without Kubernetes gets exactly the rules above: nothing in nat or raw, no routing rule. Once Kubernetes is gone,
delete `kubernetes-seen` and restart the service, and its next check takes the extra rules off again. Kubernetes must use
the same iptables backend as Docker (k3s picks the one that already has rules in it): rules in the other backend are not
ordered by these.

`dnsServers` is not the host's resolvers. With the host's own resolv.conf, Docker's embedded resolver forwards a
runner's queries from the host's namespace, which these rules do not see (`# ExtServers: [host(...)]` in a container's
resolv.conf). Only servers it forwards to from the container's own namespace need a rule: those Docker's `dns` setting
(daemon.json) or `--dns` names. The install reads them from a container on the network (`docker-dns`).

## The service

`serve` writes the rules, checks them every `intervalSeconds` (10) and writes again what changed: a firewalld reload, a
flush by hand, a jump that lost its first place (to Kubernetes, among others). Docker's own restarts leave them: it never flushes `DOCKER-USER` or
touches `INPUT`. After a host restart there are none until the service, which Docker restarts with the stack
(`restart: unless-stopped`), writes them again.

It keeps a status file, `status.json` beside its configuration: `"enforced"` with how long that holds (three check
intervals), `"failing"` and why, `"starting"` or `"stopped"`. The Docker channel reads it before it creates or starts
any runner container, and refuses (`503 FIREWALL_NOT_ENFORCED`) unless it says the rules are in force now, since the
host last started, for the bridge the network has now. The manager then waits, as it waits for room on the host: it
asks again every `lifecycle.capacityRetrySeconds`, spends none of the runner's attempts, and the runner starts by itself
once the firewall is back. So a runner never starts unprotected,
neither during a host's boot nor while the service cannot write its rules, nor after the network was made again with
another bridge. Its health check is the same reading (`status`).

Stopping the service leaves the rules: stopping it must not open the network. Removing them is `remove`.

## Configuration

`data/managed-runners/firewall/config.json` (mode 0600 in a 0700 directory), written by the install
([config.example.json](config.example.json)):

| Field | |
| --- | --- |
| `network` | The managed runners' Docker network, for the record. |
| `bridge` | Its bridge interface: `br-<first 12 of the network ID>`, or the network's `com.docker.network.bridge.name`. |
| `gateway` | Its IPv4 gateway, the host's address on it: the address in `runner.serverUrl`. |
| `apiPort` | The gateway's published port in `runner.serverUrl` (2086). |
| `dnsServers` | IPv4 DNS servers Docker forwards to from a container's own namespace (above); usually `[]`. |
| `allow` | Private destinations runners may reach: `{"to": "<IPv4 address or network, /8 or narrower>", "protocol": "tcp" or "udp", "port": <port>}`, on the host itself or behind it. At most 64. |
| `intervalSeconds` | How often the rules are checked (2 to 300, default 10). |

The service reads it as it starts: after a change, `docker compose restart managed-runner-firewall`.

## Commands

The service runs `serve`. The others, run as `docker compose run --rm --no-deps managed-runner-firewall <command>`
(the service's privileges, a container of its own):

| Command | |
| --- | --- |
| `check` | Whether the rules are in force, and what is not (exit 0 or 1). |
| `show` | This program's jumps (with their place in their hook) and chains as they stand, the nat guard's too, both families. |
| `apply` | Write the rules once and check them. |
| `status` | What the status file says (exit 0 while it says enforced). |
| `preflight` | Whether the host can carry the rules: Docker's chains in one backend, and every match and target tried in a scratch chain no packet reaches, then removed. |
| `remove` | Every jump and chain of this program, the nat guard's included, in both backends and families, whatever bridge it names. Stop the service first, or it writes them again. |
| `docker-dns`, `probe` | Run on the managed runners' network instead (`--network orbit-managed-runners`, no privilege): the DNS servers Docker forwards to from there, and connections that must be reached (`--reach`) or refused by a firewall (`--blocked`). The install uses both. |

## What it cannot do

- **Rootless Docker.** A container's host network is then rootlesskit's namespace, not the host's: the install refuses.
- **Docker's nftables backend** (`"firewall-backend": "nftables"`, Docker 29) has no `DOCKER-USER` chain: the install
  refuses. So does a Docker that manages no iptables (`"iptables": false`).
- **The legacy iptables backend** replaces a whole table at a time and needs the host's `/run/xtables.lock` to keep out
  of Docker's way: the install mounts it (`ORBIT_MANAGED_RUNNER_FIREWALL_XTABLES_LOCK` in `.env`).
- **A cloud provider's firewall** or security groups in front of the host are not changed, and are not needed.
- **The kernel.** These rules decide where a runner's packets may go. A flaw in the kernel or the container runtime
  that gives code in a container the host is not something a firewall stops.

Its tests are `scripts/managed-runner/firewall_test.py` (in the managed-runner Python suite, against an in-memory
iptables), the channel's gate in `docker_channel_test.py`, and the install's in `new_deployment_test.py`; what the rules
do to packets was measured on an isolated Docker host
([docs/evidence/managed-runner-docker-firewall/2026-10-19](../../../docs/evidence/managed-runner-docker-firewall/2026-10-19/README.md)),
and beside k3s on one
([docs/evidence/managed-runner-firewall-k3s/2026-11-13](../../../docs/evidence/managed-runner-firewall-k3s/2026-11-13/README.md)).
