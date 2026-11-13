# Managed runners on another host: two-host lab (2026-11-13)

Task 34w2jF2t5FFJzkQ15RMyF, the channel-host kit (`deploy/managed-runner/remote-host/`) and `/upgrade` for a profile
whose channel hosts are all remote ([design](../../../managed-runner-remote-host-design.md), Proposal items 3–6, D2, D3).
Commit under test: `18a0285c6` (the kit, `/upgrade`, tests); the docs commit after it changes no code.

## The two machines

Both are `docker:29.8.2-dind` containers on the HPC host (10.66.0.2), each with its own Docker, network namespace and
iptables, on a private bridge `mrrh-net` (172.31.91.0/24), as orbit-prod and 10.66.0.3 are on `wg1`. Neither is
production, and neither is 10.66.0.3.

| | Server machine `mrrh-server` | Channel machine `mrrh-channel` |
| --- | --- | --- |
| Private address | 172.31.91.10 | 172.31.91.20 |
| Runs | The Orbit stack (`scripts/install-server.sh --no-managed-runners`, then managed runners switched on with a remote profile), the fake model | The channel-host kit: `orbit-docker-channel` on 172.31.91.20:7300 for 172.31.91.10 only, `orbit-managed-runner-firewall`, every runner container and volume |
| Public `https://` | `https://moderators-refer-attract-technological.trycloudflare.com` (Cloudflare quick tunnel to its gateway port 2086) | none |

The runners' firewall refuses every private address, and a remote profile refuses a plain-HTTP `runner.serverUrl`,
so the runners reach the server, and the runner link (`wss://`, same origin), at that public quick-tunnel address,
as production's reach `https://orbitd.io`. The fake model (an Anthropic-dialect stand-in, not a model;
[kit/fake-model.py](kit/fake-model.py), from the managed-runner upgrade drill) has a second quick tunnel,
`https://ver-emotional-looks-literacy.trycloudflare.com`, which each account's model key names. Both tunnels and both
accounts were throwaway and are removed with the lab.

## Commands

Scripts in [kit/](kit/), run from the HPC host in this order:

1. `kit/dind.sh up server`, `kit/dind.sh up channel`, `kit/dind.sh checkout <machine> 18a0285c6` (a checkout of the
   commit in each machine, from the repository's objects).
2. Under the HPC heavy lock (`flock … gate-then.sh 4000 kit/heavy.sh`):
   - `kit/build-server-images.sh 18a0285c6`: the apiserver and web images built on the HPC host from a clean worktree at
     the commit ([log](logs/build-server-images.txt)), loaded into the server machine;
   - on the channel machine, the kit itself, as an operator runs it ([log](logs/kit-install.txt)):

     ```bash
     deploy/managed-runner/remote-host/remote-host.sh install --listen 172.31.91.20 --allow-peer 172.31.91.10 --instance orbit-lab-chan
     ```

     It checked the firewall backend, made `orbit-managed-runners`, built `orbit-managed-runner:local` from the commit,
     wrote `data/channel-host`, applied and probed the firewall's rules, started both services healthy, and printed:

     ```text
     { "instanceId": "orbit-lab-chan", "channel": { "url": "http://172.31.91.20:7300" }, "tokenFile": "/var/lib/orbit-managed-runners/orbit-lab-chan.token" }
     ```

3. `kit/lab-server.sh` ([log](logs/lab-server.txt)): tunnels; `install-server.sh --no-managed-runners --public-origin
   <tunnel> --no-start`; `.env` switched to `ORBIT_MANAGED_RUNNERS_ENABLED=true`, `ORBIT_MANAGED_RUNNERS_DIR=./data/managed-runners`
   with `COMPOSE_PROFILES=runner-link` (no `managed-runners-docker`: no channel on the server); the printed entry put in
   `profile.json` under `docker.hosts` with `"image": "channel"` and the tunnel as `runner.serverUrl`; the channel's
   token copied as `orbit-lab-chan.token` (0600); `docker compose up -d --no-build --wait`. The apiserver logged:

   ```text
   [ManagedRunners] managed runners are enabled in mrrh-lab (Docker instance orbit-lab-chan (remote))
   ```

4. `node kit/scenario.mjs accounts <fake model origin>` ([log](logs/scenario.txt)): the administrator (first visitor)
   and a second account the administrator created, a fake-model key each, then each one's managed runner and a session.
5. `kit/checks.sh` ([log](logs/checks.txt)): everything below.

## Both runners READY, a session answered on each

From [logs/scenario.txt](logs/scenario.txt) and the presence query in [logs/checks.txt](logs/checks.txt):

| Account | Runner | Mapping | Location (`cluster_key`, `namespace`) | Link | Session | Turns |
| --- | --- | --- | --- | --- | --- | --- |
| first (administrator) | `34wbJyHi07ohKzo0km5nB`, container `mr-01a1d26f-5d27-740a-bf41-dcf5e211845d` | `READY`, usable, 15 s after its key | `mrrh-lab`, `orbit-lab-chan` | `ONLINE`, `LINK` | `34wbKMKNCIWIlVap3YAmJ` | `1 message ANSWERED`, 5 s |
| second | `34wbJyPhd07opx17qSpw7`, container `mr-01a1d26f-5d79-75a8-94bf-e679c4520b1f` | `READY`, usable | `mrrh-lab`, `orbit-lab-chan` | `ONLINE`, `LINK` | `34wbKUjzXPteKOSKS9Dgs` | `1 message ANSWERED`, 5 s |

Both containers run on the channel machine, generation 1, from image `98bf03329ead`, the ID the channel reports; the
server machine has no runner container and no runner image.

## The channel's `/v1/info`

Asked from the server machine (172.31.91.10, in `allowPeers`) with the token:

```json
{
  "schemaVersion": 1,
  "instanceId": "orbit-lab-chan",
  "image": "sha256:98bf03329eadb4986f0e0e0b4ed547b874f751f049216dce0fd42b40789db314",
  "network": { "name": "orbit-managed-runners", "internal": false, "interContainer": false },
  "limits": { "maxCpuMillis": 4000, "maxMemoryBytes": 8589934592, "maxPids": 4096, "maxTmpBytes": 2147483648,
              "maxVolumeBytes": 107374182400, "maxConcurrent": 8, "maxContainers": 14 },
  "allowVolumeRemoval": false, "stopGraceSeconds": 240, "diskCheckSeconds": 120,
  "host": { "name": "mrrh-channel", "cpus": 24, "memoryBytes": 16102998016, "serverVersion": "29.8.2",
            "disk": { "path": "/var/lib/orbit-docker-volumes", "totalBytes": 15873633447936, "freeBytes": 14840795734016 },
            "managedVolumeBytes": 1777734 }
}
```

The line `/upgrade` prints on this remote-only profile (`deploy/managed-runner/docker-channel/info.js`, run in the
apiserver container):

```text
    orbit-lab-chan at http://172.31.91.20:7300: image sha256:98bf03329eadb4986f0e0e0b4ed547b874f751f049216dce0fd42b40789db314
```

From any other source, the HPC host's 172.31.91.1 here, the connection is closed before a byte is read
(`curl` exit 52, empty reply), and the channel logs
`refused a connection from 172.31.91.1: not in listen.allowPeers`.

## The firewall, from inside a runner container

`docker exec` into `mr-01a1d26f-5d27-740a-bf41-dcf5e211845d` as its own user (10001), `kit/reach.py`:

| Target | Address | Result |
| --- | --- | --- |
| The channel's own listener (this host's private address) | 172.31.91.20:7300 | `EHOSTUNREACH` |
| This host, port 22 | 172.31.91.20:22 | `EHOSTUNREACH` |
| This host on the runners' network, the channel's port | 172.18.0.1:7300 | `EHOSTUNREACH` |
| This host's docker0 | 172.17.0.1:80 | `EHOSTUNREACH` |
| The server machine over the private link | 172.31.91.10:2086 | `EHOSTUNREACH` |
| The HPC host's LAN address | 192.168.1.12:22 | `EHOSTUNREACH` |
| The HPC host's `wg1` address | 10.66.0.2:22 | `EHOSTUNREACH` |
| Cloud metadata | 169.254.169.254:80 | `EHOSTUNREACH` |
| A public address | 1.1.1.1:443 | `CONNECTED` |
| The server's public origin | `https://moderators-refer-attract-technological.trycloudflare.com/api/health` | `HTTP 200` |
| A public HTTPS endpoint | `https://www.cloudflare.com/cdn-cgi/trace` | `HTTP 200` |

`EHOSTUNREACH` is the firewall's reject (`icmp-admin-prohibited`). The firewall's own `check` on the channel machine
answered `{"backend": "nft", "enforced": true, "problems": []}`, its status file `"state": "enforced"` for bridge
`br-2835712306da`, gateway 172.18.0.1, and `DOCKER-USER` jumps from that bridge to `ORBIT-MR-FORWARD`, which rejects
every private and reserved range ([logs/checks.txt](logs/checks.txt)).

`remote-host.sh status` on the channel machine:

```text
Instance:     orbit-lab-chan
Listens on:   {"host": "172.31.91.20", "port": 7300} for ["172.31.91.10"]
Checkout:     18a0285c64802fb9cc93d9913abb50d1f600f7e4
Image:        sha256:98bf03329eadb4986f0e0e0b4ed547b874f751f049216dce0fd42b40789db314 in channel.json, built from 18a0285c64802fb9cc93d9913abb50d1f600f7e4
Firewall:     {... "state": "enforced", ...}
Services:
docker-channel: Up 6 minutes (healthy)
managed-runner-firewall: Up 6 minutes (healthy)
Runner containers of orbit-lab-chan:
mr-01a1d26f-5d79-75a8-94bf-e679c4520b1f Up 2 minutes 98bf03329ead
mr-01a1d26f-5d27-740a-bf41-dcf5e211845d Up 2 minutes 98bf03329ead
Data volumes: 2
```

## Not covered here

- `remote-host.sh upgrade <sha>` and a full `/upgrade` of the server were not run in the lab: each needs another
  heavy build on the shared HPC host, whose lock queue held this lab's builds for about six hours. Both are covered with
  a fake Docker by `scripts/managed-runner/remote_host_test.py` (checkout, rebuild, `channel.json` switch, recreate
  order, unfinished-switch marker, dirty tree) and `scripts/managed-runner/new_deployment_test.py` (no runner image
  and untouched files on a remote-only profile, the host report). The report script itself ran for real above.
- One channel host only; several hosts, placement and draining are the next task's lab.
