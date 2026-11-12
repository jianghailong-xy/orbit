# Managed runners on another Docker host (design, 2026-11-12)

Status: proposal, waiting on the owner's decisions D1–D4 below. Board:
[docs/mocks/managed-runner-remote-host/board.html](mocks/managed-runner-remote-host/board.html).

## The ask

orbitd.io production (orbit-prod, WireGuard `wg1` address 10.66.0.1) should turn managed runners on, with
every managed runner's container and volume on another machine, 10.66.0.3, not on the production host.

Owner decisions already taken (2026-11-12):

- Product support for a remote Docker channel, not an ad-hoc relay.
- Managed runners reach the server at `https://orbitd.io` (and the runner link at its public `wss://` address),
  never at a WireGuard or LAN address over plain HTTP.
- Every account gets one, as the product does today (open sign-up included).
- Work on 10.66.0.3 is done through sessions on the Orbit runner `workstation`, which runs there as root.

## Today

Managed runners on Docker assume one host. The apiserver, the Docker channel, the managed runners' firewall and the
runner image all sit on the deployment's own host:

| Piece | Today's rule | Where |
| --- | --- | --- |
| Channel listener | unix socket, or TCP on 127.0.0.1 / ::1 only | `deploy/managed-runner/docker-channel/channel.py:200` |
| Apiserver's channel address | `socketPath`, or `http://127.0.0.1:<port>` / `http://[::1]:<port>` only | `src/apiserver/src/managed-runners/managed-runner-profile.ts:395` |
| Image | `/upgrade` builds `orbit-managed-runner:local` on this host and writes its ID into `channel.json` and `profile.json`; the apiserver refuses a channel whose image differs | `.claude/skills/upgrade/upgrade.sh:66-180`, `docker-backend.ts:194` |
| Firewall | `managed-runner-firewall` keeps iptables rules on the host whose bridge the runners use | `deploy/managed-runner/firewall` |
| Install | `scripts/install-server.sh` prepares all of it on the deployment's host | `docs/self-hosting.md`, "Managed runners" |

## Facts of the two hosts (read 2026-11-12)

| | orbit-prod (vmi3129740) | 10.66.0.3 (`workstation`, LAN 192.168.1.11) |
| --- | --- | --- |
| CPU / memory | 8 / 23 GiB | 8 / 62 GiB (41 GiB available) |
| Disk | `/` 394 G, 94 % used | NVMe 937 G ext4, 347 G free; Docker's data root on it |
| Docker | runs the stack, `COMPOSE_PROFILES=runner-link`, managed runners off | 29.7.2, overlay2, cgroup v2, apparmor + seccomp; iptables 1.8.9 (nf_tables); no host firewall active |
| Also runs | Orbit stack, Wikova | Nextcloud, qBittorrent, NFS and SMB shares, autossh tunnels, the Orbit runner `workstation` as root |
| Reachability | its apiserver container reaches 10.66.0.3 over `wg1` | reaches `https://orbitd.io` (200); `http://10.66.0.1:2086` times out |

`wg1` is a hub at 10.66.0.1 that forwards between its peers (`FORWARD -i wg1 -o wg1 ACCEPT`), so HPC (10.66.0.2)
reaches 10.66.0.3 too. Port 22 on 10.66.0.3 is closed.

## Proposal

Split the backend over two hosts. Nothing changes for a single-host deployment.

```
orbit-prod (10.66.0.1)                         10.66.0.3 ("channel host")
apiserver ── HTTP + bearer token over wg1 ───▶ docker-channel  (listens on 10.66.0.3:<port> only,
  profile.json: channel.url = http://10.66.0.3:<port>        answers only peer 10.66.0.1)
                                               managed-runner-firewall (rules on this host)
                                               orbit-managed-runner image (built here)
                                               mr-<uuid> containers ── https://orbitd.io ──▶ gateway
                                                                  └── wss://c1.link.orbitd.io ─▶ link gateway
```

1. **Channel listens on a private address, for named peers only.** `channel.json` gains
   `listen.tcp.host` = one private address of the host (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10)
   together with a required `allowPeers` list. A connection from any other source address is closed before a
   byte is read. The bearer token stays required. The listener still refuses `0.0.0.0` and public addresses.
2. **Apiserver accepts that address.** `docker.channel.url` may be `http://<private address>:<port>` when the
   profile says `docker.channel.remote: true`. With `remote`, `runner.serverUrl` must be `https://`
   (a runner then talks to the server over the internet, never plain HTTP to another machine).
3. **Channel-host kit.** `deploy/managed-runner/remote-host/` with a Compose file of two services
   (`docker-channel` in the host network namespace, `managed-runner-firewall`) and one script with
   `install`, `upgrade <sha>` and `status`. `install` makes the `orbit-managed-runners` network, the token,
   `channel.json`, the firewall's `config.json`, builds the image, and prints the `profile.json` fragment and token
   path to copy to the server. `upgrade` checks out a reviewed commit, rebuilds the image and switches `channel.json`
   the way `/upgrade` does today.
4. **Server side.** `/upgrade` on a deployment whose profile is `remote` builds no runner image and leaves the
   channel alone; it reports the channel's image ID. Image handling follows D2.
5. **Firewall on the channel host.** The existing service, unchanged: runners keep DNS and public addresses and
   lose the host and every private network, which covers Nextcloud, NFS/SMB, the LAN, `wg1` and the other Docker
   bridges of 10.66.0.3. Its gateway-port allowance has nothing to reach there and stays harmless.
6. **Docs and checks.** `docs/self-hosting.md` "Managed runners on another host", the operations runbook's backup
   and restore commands from the channel host, `channel.py` and profile validator tests, a two-host lab check.

### Isolation on 10.66.0.3

The owner accepted the product's model ("Isolation and its limits" in `docs/self-hosting.md`): every container
shares that host's kernel. On 10.66.0.3 that kernel also serves the Nextcloud data, the NFS/SMB shares on five
14.6 T disks and a root Orbit runner with the owner's engine sign-ins. A kernel or runtime escape from any
account's runner reaches all of that. The firewall closes the network paths, not this one.

## Decisions for the owner

| | A (recommended) | B |
| --- | --- | --- |
| **D1 channel transport** | HTTP + token over `wg1`, listener on 10.66.0.3 only, `allowPeers: [10.66.0.1]`. WireGuard already encrypts and authenticates the peers. | Also TLS with a pinned self-signed certificate. Protects against a compromised `wg1` peer that spoofs 10.66.0.1, at the cost of a cert to rotate. |
| **D2 image identity** | The channel host owns the image. `profile.json` names `"image": "channel"`; the apiserver takes the ID the channel reports and keeps checking `instanceId`. One file to change per upgrade. | Keep pinning the ID in both files. After every channel-host upgrade someone copies the new ID to prod and recreates the apiserver; a missed copy stops every new runner. |
| **D3 channel-host upgrades** | After each production deploy, the coordinator starts a session on the `workstation` runner that runs `remote-host upgrade <sha>` with the deployed commit. | The channel host follows production on a timer (reads `/dl/version.json`, builds when it moves). No human step, but builds land on that host at unplanned times. |
| **D4 capacity on 10.66.0.3** | The derived default: the host less a quarter, so 6 CPUs and ~46 GiB, at 2 CPUs / 4 GiB per runner = 3 runners awake at once, 8 containers at most; sleeping runners hold no compute. | A stated smaller pool, 4 CPUs / 16 GiB (2 awake at once), leaving more room for Nextcloud and the root runner. |

## Steps (each depends on the one before)

1. Channel: private-address listener with `allowPeers`, validator and tests.
2. Apiserver: `remote` profile, private channel URL, `https://` serverUrl rule, D2's image mode, tests.
3. Channel-host kit and `/upgrade` changes, docs, a two-host lab check (HPC as server, a VM or container host as
   channel host).
4. Production rollout, with the owner's go: install on 10.66.0.3 through a `workstation` session, copy the
   profile and token to prod, `ORBIT_MANAGED_RUNNERS_ENABLED=true`, recreate the apiserver, check the first account's
   runner reaches READY and runs a session; rollback = the switch back to `false` and recreate (volumes kept).
