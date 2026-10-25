# The managed runners' host firewall, 2026-10-19 (task D9)

Task D9 (34iSiGtPrJ0LWSqn17esR) of project 34ZteKCnYMpKY46f63Leb, criterion 12. A fresh install, and
`--enable-managed-runners`, now firewall the managed runners' network on the host by default; `/upgrade` leaves a
deployment's firewall as it was. The design is in [docs/managed-runner-design.md](../../../managed-runner-design.md),
"Implementation record: the managed runners' host firewall"; operating it is in
[the runbook](../../../managed-runner-docker-operations.md#the-managed-runners-firewall) and
[self-hosting](../../../self-hosting.md#isolation-and-its-limits); the program is
[deploy/managed-runner/firewall](../../../../deploy/managed-runner/firewall/README.md).

Every scenario's command exited 0. Every result below was read from inside a managed runner container, as its user
(10001), before and after.

## Where it ran

- **`d9-dind`**, an isolated Docker host on the HPC machine ([kit/dind-up.sh](kit/dind-up.sh)).
  - A `docker:29.8.2-dind` container: privileged for its own dockerd, with its own network namespace and iptables.
  - Capped: 6 GiB memory, 8 CPUs, `--oom-score-adj 1000`. It runs outside the Orbit runner's cgroup (a container of the
    host's Docker), labelled `orbit.test=d9-34iSiGtPrJ0LWSqn17esR`.
  - Its Docker data root and the deployments' checkouts are under `/mnt/data/tmp/34iSiGtPrJ0LWSqn17esR`, so they
    outlive a restart of it, as a host's disk does. The deployment's gateway is published on HPC's 127.0.0.1:14986 only.
  - dockerd runs under [kit/supervise-dockerd.sh](kit/supervise-dockerd.sh), so it can be restarted alone
    (`pkill dockerd`, as `systemctl restart docker` on a host). A restart of the container stands for a host reboot:
    a new network namespace, its iptables empty. dockerd has no TCP listener.
- **Versions** ([s2/facts.jsonl](s2/facts.jsonl), [s4/facts.jsonl](s4/facts.jsonl)):
  - Docker 29.8.2 (API 1.56), Docker Compose v5.6.0, kernel 6.12.107+deb13-amd64, cgroup v2.
  - Docker's firewall backend `iptables`, iptables v1.8.13. The backend underneath was **nft** in S1–S3, and
    **legacy** in S4 (the same test host made again with `DOCKER_IPTABLES_LEGACY=1`).
  - The userland proxy was on, the default, except in S2's off case.
- **What a deployer's host has around it** ([kit/host-fixtures.sh](kit/host-fixtures.sh)):
  - Services of the test host itself: TCP on every address (2222), on loopback only (2223), on its eth0 address only
    (2224) and on IPv6's every address (2225), and a UDP echo (2226).
  - A private network behind it, `lan`, a network namespace with the "internal model endpoint" at 10.77.0.2:18080:
    [fake-model.py](../../../../scripts/managed-runner/lab/fake-model.py) behind a TCP relay. The account's
    DeepSeek-preset key names `http://10.77.0.2:18080/anthropic`, so a session uses it.
  - The HPC machine's own LAN, as a deployer's would be: its LAN address 192.168.1.12, with sshd on 22 and the vLLM
    port 8000 (vLLM listens on HPC's loopback only), and HPC's docker0, 172.17.0.1, the test host's default gateway.
    The LAN's resolver 192.168.1.254 is the resolver of the test host too. Toward the LAN only TCP connections were
    tried, and nothing was sent over them.
- **The commits.** `pre-d9`: the project line's tip 20eaa14b7. `d9`: this branch at a6d24199a (S1, S1b, and S2 until
  its upgrade), then at 74f2c0ec5 (S2 after its `/upgrade`, S3, S4). Between the two, only the apiserver's wait on
  `FIREWALL_NOT_ENFORCED` (below) and the kit changed. After 74f2c0ec5 the branch changed no behaviour these runs
  measure: the closing message of `--enable-managed-runner-firewall --no-start`, the apiserver's census tests, and docs.
- **The HPC host itself was not changed.** Its firewall and its network were not touched, and its Docker daemon was
  never restarted. Every rule written was in the test host's own network namespace. On the HPC host's Docker there were
  only `d9-dind` (and, briefly, `d9-probe`, an earlier exploration of Docker 29's rules), both labelled, and
  `scripts/run-pg-spec.sh`'s throwaway PostgreSQL. All of them are removed.

[kit/probe.py](kit/probe.py) ran inside the runner container through `docker exec -u 10001`, with these targets
([kit/d9.py](kit/d9.py), `targets`). A TCP probe only connects; "refused (firewall)" is `EHOSTUNREACH`, the rules'
`icmp-admin-prohibited`, told apart from "refused (target)" (`ECONNREFUSED`, the host's own stack answered) and
"timeout". Every probe line is in the scenario's `probes.jsonl`, and [kit/tables.py](kit/tables.py) makes the tables
from them.

## S1. A deployment with managed runners from before the firewall: `/upgrade`, then `--enable-managed-runner-firewall`

1. `scripts/install-server.sh` at `pre-d9`, no flags ([s1/install-pre-d9.log.gz](s1/install-pre-d9.log.gz)): managed
   runners on, no firewall. The administrator signed in, added the fake-model key, and the runner was `READY`; a session
   was answered by the model ([s1/sessions.jsonl](s1/sessions.jsonl)).
2. `.claude/skills/upgrade/upgrade.sh` at `d9` ([s1/upgrade-to-d9.log.gz](s1/upgrade-to-d9.log.gz)). It built and
   switched the managed runner image and recreated the services as before, and the word "firewall" is nowhere in its
   output. After it: no `ORBIT-MR-*` chain in either family, an empty `DOCKER-USER`, no firewall service and no
   `data/managed-runners/firewall` ([s1/rules-2-after-upgrade.txt](s1/rules-2-after-upgrade.txt)). `.env` was as
   installed ([s1/inventory-2-after-upgrade.txt](s1/inventory-2-after-upgrade.txt)), and the runner went on running.
   **No rule appeared.**
3. `scripts/install-server.sh --enable-managed-runner-firewall` ([s1/enable-firewall.log.gz](s1/enable-firewall.log.gz)),
   the runbook's command for this deployment:
   - preflight on the nft backend, hooks in `DOCKER-USER` for both families;
   - the rules applied once;
   - from the network, `172.19.0.1:1`, 169.254.169.254 and 10.255.255.1 refused (`EHOSTUNREACH`), and DNS still
     resolving;
   - `COMPOSE_PROFILES` gained `managed-runner-firewall`, the service started healthy, and the gateway's port was
     reached.

   **The rules appeared** ([s1/rules-3-after-enable-firewall.txt](s1/rules-3-after-enable-firewall.txt)), and the same
   runner container was refused at once.
4. A session then failed: Claude Code reported "API Error: No internet route — check your connection or VPN
   (EHOSTUNREACH)" after its retries, and the model got no request. After the runbook's allowance (one `allow` entry,
   the service restarted, IPv4 rewritten, `check` enforced: [s1/allow-internal-model.txt](s1/allow-internal-model.txt)),
   the next session was answered. Only that address and port opened.

| From the runner container | `1-pre-d9-installed` | `2-after-upgrade` | `3-after-enable-firewall` | `4-model-allowed` |
| --- | --- | --- | --- | --- |
| the gateway's published port 2086, the designed way to the apiserver | connected | connected | connected | connected |
| a host service on every address (2222), at the network's gateway | connected | connected | **refused (firewall)** | **refused (firewall)** |
| the same service at the test host's docker0 address | connected | connected | **refused (firewall)** | **refused (firewall)** |
| the same service at the stack network's gateway | connected | connected | **refused (firewall)** | **refused (firewall)** |
| a host service bound to the test host's eth0 address only (2224) | connected | connected | **refused (firewall)** | **refused (firewall)** |
| a UDP echo of the host on every address (2226), at the network's gateway | echoed | echoed | **refused (firewall)** | **refused (firewall)** |
| a port of the host where nothing listens (1), at the network's gateway | refused (target) | refused (target) | **refused (firewall)** | **refused (firewall)** |
| HPC's sshd at its LAN address | connected | connected | **refused (firewall)** | **refused (firewall)** |
| HPC's vLLM port 8000 at its LAN address (vLLM listens on HPC's loopback) | refused (target) | refused (target) | **refused (firewall)** | **refused (firewall)** |
| HPC's sshd at the test host's default gateway (HPC's docker0) | connected | connected | **refused (firewall)** | **refused (firewall)** |
| the LAN's DNS resolver over TCP, from the container's own namespace | timeout | timeout | **refused (firewall)** | **refused (firewall)** |
| the internal model endpoint on the private network behind the host | connected | connected | **refused (firewall)** | connected |
| the cloud metadata address | timeout | timeout | **refused (firewall)** | **refused (firewall)** |
| an address in 10.0.0.0/8 | timeout | timeout | **refused (firewall)** | **refused (firewall)** |
| an address in 100.64.0.0/10 | timeout | timeout | **refused (firewall)** | **refused (firewall)** |
| DNS: a Git host (github.com) | resolved | resolved | resolved | resolved |
| DNS: the DeepSeek endpoint (api.deepseek.com) | resolved | resolved | resolved | resolved |
| public HTTPS: a Git host | HTTP 200 | HTTP 200 | HTTP 200 | HTTP 200 |
| public HTTPS: the DeepSeek endpoint | HTTP 401 | HTTP 401 | HTTP 401 | HTTP 401 |

## S1b. A deployment without managed runners: `/upgrade`, then `--enable-managed-runners`

The task's own case, a deployment as orbitd.io is:

1. `scripts/install-server.sh --no-managed-runners` at `pre-d9`
   ([s1b/install-pre-d9-without-managed-runners.log.gz](s1b/install-pre-d9-without-managed-runners.log.gz)):
   `ORBIT_MANAGED_RUNNERS_ENABLED=false`, no managed runners' network, no rule
   ([s1b/rules-1-pre-d9-installed.txt](s1b/rules-1-pre-d9-installed.txt)).
2. `/upgrade` at `d9` ([s1b/upgrade-to-d9.log.gz](s1b/upgrade-to-d9.log.gz)). It built and recreated exactly
   apiserver, wiki-worker and web, as it did before managed runners existed, and its output names neither the firewall
   nor managed runners. **No rule appeared**, and no network ([s1b/rules-2-after-upgrade.txt](s1b/rules-2-after-upgrade.txt)).
3. `scripts/install-server.sh --enable-managed-runners` ([s1b/enable-managed-runners.log.gz](s1b/enable-managed-runners.log.gz)):
   - the firewall's preflight before anything was written;
   - the network created IPv4-only, the rules applied and checked from it;
   - `.env` with both profiles; the firewall started, then the channel and the apiserver;
   - the gateway's port reached.

   **The rules appeared** ([s1b/rules-3-after-enable-managed-runners.txt](s1b/rules-3-after-enable-managed-runners.txt)).
   The first account's runner, created 44 s after the firewall reported its rules in force, was refused everything but
   the gateway's port, DNS and public addresses ([s1b/probes.jsonl](s1b/probes.jsonl): the same column as
   `3-after-enable-firewall` above). The channel said at start-up that it starts runners only while the firewall is in
   force ([s1b/gate-final.txt](s1b/gate-final.txt)).

## S2. A fresh install, and what it lives through

`scripts/install-server.sh` at `d9`, no flags ([s2/install-default.log.gz](s2/install-default.log.gz), 07:25:46–07:29:02Z,
the images cached by then). In order:

- the firewall's image and preflight (`{"backend": "nft", ... "ipv6": "present", "ipv6Hook": "DOCKER-USER"}`), before
  anything was written;
- the managed runner image, the network, the channel's and the apiserver's files;
- the firewall's configuration (bridge `br-fddeb223c3a0`, gateway `172.19.0.1:2086`, `dnsServers` `[]`), applied once;
- refusals and DNS checked from the network;
- `.env`, the images, the migrations and the stack;
- the gateway's port reached from the network.

The administrator's runner was `READY` on the fake-model key, and after the runbook's allowance a session was answered
([s2/sessions.jsonl](s2/sessions.jsonl), [s2/allow-internal-model.txt](s2/allow-internal-model.txt)).

| From the runner container | `1-default` | `4-after-dockerd-restart` | `5-after-host-reboot` | `6-userland-proxy-off` | `7-userland-proxy-on` | `9-final` |
| --- | --- | --- | --- | --- | --- | --- |
| the gateway's published port 2086, the designed way to the apiserver | connected | connected | connected | connected | connected | connected |
| a host service on every address (2222), at the network's gateway | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** |
| the same service at the test host's docker0 address | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** |
| the same service at the stack network's gateway | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** |
| a host service bound to the test host's eth0 address only (2224) | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** |
| a UDP echo of the host on every address (2226), at the network's gateway | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** |
| a port of the host where nothing listens (1), at the network's gateway | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** |
| HPC's sshd at its LAN address | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** |
| HPC's vLLM port 8000 at its LAN address (vLLM listens on HPC's loopback) | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** |
| HPC's sshd at the test host's default gateway (HPC's docker0) | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** |
| the LAN's DNS resolver over TCP, from the container's own namespace | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** |
| the internal model endpoint on the private network behind the host | **refused (firewall)** | connected (allowed) | connected (allowed) | connected (allowed) | connected (allowed) | connected (allowed) |
| the cloud metadata address | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** |
| an address in 10.0.0.0/8 | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** |
| an address in 100.64.0.0/10 | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** | **refused (firewall)** |
| DNS: a Git host (github.com) | resolved | resolved | resolved | resolved | resolved | resolved |
| DNS: the DeepSeek endpoint (api.deepseek.com) | resolved | resolved | resolved | resolved | resolved | resolved |
| public HTTPS: a Git host | HTTP 200 | HTTP 200 | HTTP 200 | HTTP 200 | HTTP 200 | HTTP 200 |
| public HTTPS: the DeepSeek endpoint | HTTP 401 | HTTP 401 | HTTP 401 | HTTP 401 | HTTP 401 | HTTP 401 |

DNS works with every private range refused. Docker's resolver forwards the runner's queries to 192.168.1.254 from the
host's namespace (`# ExtServers: [host(192.168.1.254)]` in the container's resolv.conf, in each probe's
`containerFacts`), while the same resolver's TCP port from the container's own namespace is refused. Inside the
container, IPv6 is off on `eth0` (`disable_ipv6` 1), and the only IPv6 address is the loopback.

### The channel's gate: no runner container while the firewall is not in force

[kit/sample.py](kit/sample.py) sampled the test host about once a second through each of the following runs (the
`timeline-*.jsonl` files).

- **At a6d24199a** ([s2/gate-demo-1-stop.txt](s2/gate-demo-1-stop.txt), [s2/gate-gate-demo.txt](s2/gate-gate-demo.txt),
  [s2/timeline-gate-demo.jsonl](s2/timeline-gate-demo.jsonl)):
  1. `docker compose stop managed-runner-firewall` at 07:30:40Z. Its status became `"stopped"`, and **its rules stayed
     on the host**: `ORBIT-MR-INPUT` intact, the jump first in `INPUT`.
  2. The runner was put to sleep, then woken at 07:31:10. The channel refused the create at 07:31:10, :20, :35 and
     07:32:06 ("no runner container is started: the managed runners' host firewall is not in force (the firewall
     service reports 'stopped' …)"). No runner container existed.
  3. The firewall started at 07:32:36 and reported enforced at 07:32:37. The next create (07:32:57) went through, and
     the runner was `READY` at 07:33:19.
- **What that showed, and what changed.** The manager counted each refusal as a transient failure ("transient failure
  1/5 … 4/5"). The dockerd restart that followed (below) stopped the runner a fifth time in a row, inside D7's
  ten-minute window, and it failed `POD_TERMINATED` (5 of 5). The owner's Retry started it. Commit 74f2c0ec5 makes the
  refusal a wait, as `CONTAINER_LIMIT` is (`managed-runner-recovery.pg.spec.ts` case 16, red without the change).
- **At 74f2c0ec5, after S2's `/upgrade`** ([s2/gate-demo-2.txt](s2/gate-demo-2.txt),
  [s2/timeline-gate-demo-2.jsonl](s2/timeline-gate-demo-2.jsonl)):
  1. The firewall was stopped and the runner put to sleep, then woken at 08:05:26.
  2. It waited in `STARTING` with the reason `FIREWALL_NOT_ENFORCED` ("The Docker host's firewall for managed runners is
     not in force, so this runner is not started yet. It starts by itself once an operator has the firewall running
     again."), **attempt 0**. The channel refused at 08:05:26, 08:06:27, 08:07:27 and 08:08:27, every
     `capacityRetrySeconds`. The apiserver logged `FIREWALL_NOT_ENFORCED` once. No runner container existed.
  3. The firewall started at 08:09:01, the runner's container was created at 08:09:28 by itself, and it was `READY` at
     08:09:35, attempt 0.
  4. A dockerd restart straight after brought it back by itself (`READY` at 08:10:16, generation 8, attempt 1).

### dockerd restarted (`pkill dockerd` in the test host)

At 07:34:01Z ([s2/dockerd-restart.txt](s2/dockerd-restart.txt),
[s2/timeline-dockerd-restart.jsonl](s2/timeline-dockerd-restart.jsonl), 207 samples):

- **The firewall's chains and its first place in `INPUT` never went away.** Docker does not flush `DOCKER-USER` or
  touch `INPUT`.
- The service's status was `"stopped"` while dockerd was down, and `"enforced"` again 12 s later, when Docker restarted
  it.
- After the owner's Retry (the `POD_TERMINATED` above), the runner was `READY` and refused as before
  ([s2/rules-4-after-dockerd-restart.txt](s2/rules-4-after-dockerd-restart.txt)). The restart in gate demo 2 above
  needed no Retry.

### The host rebooted (`docker restart d9-dind`)

At 07:45:20Z ([s2/host-reboot.txt](s2/host-reboot.txt), [s2/timeline-host-reboot.jsonl](s2/timeline-host-reboot.jsonl),
70 samples):

- The test host came back in a new network namespace with **no rule** (07:45:30).
- Docker started the stack. At 07:45:34 the firewall service wrote both families again ("rules written for IPv4 and
  IPv6 (nft backend)", "enforced").
- The channel created the runner's next generation at 07:45:53, and the runner was `READY` at 07:46:00
  (`POD_RESTARTING`, no Retry).
- **In no sample did a runner container run while the chains were absent.** The probe after it is the column above
  ([s2/rules-5-after-host-reboot.txt](s2/rules-5-after-host-reboot.txt)).

### The userland proxy off and on

- **Off.** `--userland-proxy=false` in the test host's dockerd flags, dockerd restarted
  ([s2/userland-proxy-off.txt](s2/userland-proxy-off.txt), [s2/rules-6-userland-proxy-off.txt](s2/rules-6-userland-proxy-off.txt)).
  - Docker reported no userland proxy, and no `docker-proxy` process ran.
  - The nat `DOCKER` rule for 2086 had no interface exception (hairpin).
  - The runner was `READY` again, a session was answered, and the probe is the column above. The firewall's DNAT rule
    (`--ctstate DNAT --ctorigdst 172.19.0.1 --ctorigdstport 2086`) counted the runner's connections.
- **On, the default, again** ([s2/userland-proxy-on.txt](s2/userland-proxy-on.txt)). The nat rule was back to
  `! -i <the stack's bridge>`. With the counters zeroed, a probe and a session:
  - the DNAT rule in `ORBIT-MR-FORWARD` counted 7 packets;
  - the `INPUT` rule for the gateway's address and port counted 0.

  So on Docker 29 a runner reaches the gateway through Docker's DNAT, `FORWARD`, with the proxy on or off. The `INPUT`
  rule covers the `docker-proxy` path of Docker before 28, which was not run here.

### `/upgrade` of a deployment that has the firewall

The checkout moved to 74f2c0ec5, then `.claude/skills/upgrade/upgrade.sh`
([s2/upgrade-with-firewall.log.gz](s2/upgrade-with-firewall.log.gz), 07:51:07–08:04:38Z). It rebuilt and switched the
runner image and recreated the apiserver, wiki-worker, web and, last, the channel.

**The firewall was left exactly as it was** ([s2/firewall-before-upgrade.txt](s2/firewall-before-upgrade.txt),
[s2/firewall-after-upgrade.txt](s2/firewall-after-upgrade.txt)):

- the same container (`61ade336…`, started 07:48:46), on the same image;
- byte-identical IPv4 and IPv6 rules (the SHA-256 of their `iptables-save` lines);
- the same `config.json`.

The sampler, running through the build phase ([s2/timeline-upgrade-with-firewall.jsonl](s2/timeline-upgrade-with-firewall.jsonl),
528 samples), saw the chains, the first jump, a healthy service and an enforced status in every sample. The only line
of the upgrade's output that names the firewall is its row in `docker compose ps`.

## S3. `--no-managed-runner-firewall`

`scripts/install-server.sh --no-managed-runner-firewall` at `d9` ([s3/install-no-firewall.log.gz](s3/install-no-firewall.log.gz)).

- The install warned as it started and as it ended: "the managed runners' host firewall is off
  (--no-managed-runner-firewall): every account's runner can reach every service this host listens to and the private
  networks behind it …".
- `.env` carries the note "The managed runners' host firewall is OFF …" and `COMPOSE_PROFILES=managed-runners-docker`
  alone ([s3/inventory-1-no-firewall.txt](s3/inventory-1-no-firewall.txt)).
- No firewall directory, no service and no rule ([s3/rules-1-installed.txt](s3/rules-1-installed.txt)). The channel
  starts runners without a gate ([s3/gate-final.txt](s3/gate-final.txt)).
- The runner reaches what D5 measured, the internal model endpoint included, and a session was answered:

| From the runner container | `1-no-firewall` |
| --- | --- |
| the gateway's published port 2086 | connected |
| a host service on every address (2222): at the network's gateway, at docker0, at the stack network's gateway | connected, connected, connected |
| a host service bound to the test host's eth0 address only (2224) | connected |
| a UDP echo of the host on every address (2226) | echoed |
| HPC's sshd at its LAN address; at HPC's docker0 | connected; connected |
| HPC's vLLM port 8000 at its LAN address | refused (target) |
| the internal model endpoint behind the host | connected |
| the cloud metadata address; 10.0.0.0/8; 100.64.0.0/10 | timeout |
| DNS; public HTTPS (a Git host, the DeepSeek endpoint) | resolved; HTTP 200, HTTP 401 |

## S4. The legacy iptables backend

The same test host was made again with `DOCKER_IPTABLES_LEGACY=1`, so that its dockerd used iptables-legacy (legacy
`nat` and `filter` tables for both families, and `/run/xtables.lock`). Then `scripts/install-server.sh` at `d9`
([s4/install-default-legacy.log.gz](s4/install-default-legacy.log.gz), [s4/legacy-facts.txt](s4/legacy-facts.txt)):

- the preflight found `{"backend": "legacy", "iptables": "iptables v1.8.13 (legacy)", ...}`;
- `.env` gained `ORBIT_MANAGED_RUNNER_FIREWALL_XTABLES_LOCK=/run/xtables.lock`, and the service mounted the host's
  `/run/xtables.lock`;
- the rules were written into the legacy tables of both families, none into nft's;
- the runner was refused everything but the gateway's port, DNS and public addresses (14 targets refused; the model
  endpoint was not allowed here: [s4/probes.jsonl](s4/probes.jsonl)).

## Cleaned up

After the last scenario, the deployment, its runner containers and volumes and the managed runners' network were
removed in the test host ([kit/teardown.sh](kit/teardown.sh)). Then `d9-dind` was removed from the HPC host's Docker,
and `/mnt/data/tmp/34iSiGtPrJ0LWSqn17esR` (its Docker data root, the checkouts, the bare repository, the kit's copy and
the records copied here) was deleted. The account's password lived only in that directory's `secrets.json`; no access
token, credential or key was recorded.

## Not shown here

- **Older Docker.** Docker before 28, where the userland proxy answers a runner's connection to the gateway through
  `INPUT`, was not run. Neither was a Docker older than 29.8.2.
- **Other host firewalls.** firewalld and ufw hosts, SELinux, a rootless Docker and Docker's own nftables backend were
  not run live. The install's refusal of the last two is covered by `new_deployment_test.py` against a fake `docker`.
- **A real power cycle.** The kernel's boot ID did not change on the test host's restarts: the gate's boot check was
  not exercised live, and its `"starting"`/`"stopped"` statuses and `validUntil` were.
- **IPv6 traffic.** The IPv6 rules were checked present in both backends, not exercised with traffic: Docker 29 turned
  IPv6 off on the containers' interfaces.
- **Scale and models.** One account per scenario (D4 runs several). The model was fake-model.py, not the owner's
  DeepSeek key.
