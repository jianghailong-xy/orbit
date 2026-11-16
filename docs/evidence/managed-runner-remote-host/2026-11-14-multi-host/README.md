# Managed runners on several channel hosts: placement, draining, one-host outage, upgrade drill (2026-11-14)

Task 34w2jFbstazPkmD2XCDCe ([design](../../../managed-runner-remote-host-design.md), "Several channel hosts", D5 A).
It uses the kit of the two-host lab ([2026-11-13](../2026-11-13/README.md), task 34w2jF2t5FFJzkQ15RMyF), extended to a
second channel host. Commits under test:

- `a76a31cdb`: placement (D5), `draining`, the unreachable-host skip of task 34wRJdvOtxVlslvU5khjw, and its
  once-per-poll-interval recheck. Steps 0, (a), (b), (c) refused and (c) blackholed "before".
- `d29ffe525`: **the bug this lab exposed, fixed in this task** (below). Step (c) blackholed "after", and the commit
  channel host B was upgraded to in (d).

**The lab found a bug, fixed here.** With one channel host's address dropping packets (blackholed), every channel call
to that host waited out the 60 s request timeout, one after another, before the other host's share of the worker pass
ran. Host B's passes came **243–246 s apart instead of every 5 s**. A new account created 16 s into the outage was
**placed on the blackholed host**, because no call had failed yet and the host was not marked unreachable. Fix
`d29ffe525`:

- a channel connection not made within 3 s fails as "reached nothing", so the host is marked unreachable in seconds;
- while a host stays marked after its recheck, the worker drives none of its mappings in that pass.

After the fix, B's passes during the same outage are 8–9 s apart (5 s interval plus at most one 3 s connect attempt to A,
under one poll interval). A new account 9 s into the outage is placed on B.

## The machines

Three `docker:29.8.2-dind` containers on the HPC host (10.66.0.2), each with its own Docker, network namespace and
iptables, on a private bridge `mrmh-net` (172.31.92.0/24), as orbit-prod and its channel hosts are on `wg1`. None is
production, and none is 10.66.0.3.

| | Server `mrmh-server` | Channel host A `mrmh-chan-a` | Channel host B `mrmh-chan-b` |
| --- | --- | --- | --- |
| Private address | 172.31.92.10 | 172.31.92.20 | 172.31.92.30 |
| Runs | The Orbit stack (`install-server.sh --no-managed-runners`, then managed runners on with a remote profile), the fake model | The channel-host kit, instance `orbit-lab-a`, on 172.31.92.20:7300 for 172.31.92.10 only | The channel-host kit, instance `orbit-lab-b`, on 172.31.92.30:7300 for 172.31.92.10 only |
| Runner image | none | `sha256:7f66c5f86923…` (built here from `a76a31cdb`) | `sha256:61e1370ab959…` (built here from `a76a31cdb`), then `sha256:2e999fc4446e…` (from `d29ffe525`) |

Each host builds its own image, so the two IDs differ even from the same commit. Under `"image": "channel"` the server
takes each host's own ID from its `/v1/info`.

The runners reach the server, and the runner link, at a throwaway Cloudflare quick tunnel to the server's gateway
(`https://`, as production's `https://orbitd.io`). The fake model ([kit/fake-model.py](kit/fake-model.py), an
Anthropic-dialect stand-in, not a model) has its own tunnel, which each account's model key names.

## Commands

[kit/](kit/), run from the HPC host:

1. `kit/dind.sh up server|a|b`, then `kit/dind.sh checkout <machine> a76a31cdb` on each.
2. Under the HPC heavy lock, `kit/heavy.sh a76a31cdb`: the server's images
   ([log](logs/build-server-images.txt)), then the kit itself on each channel host:
   `remote-host.sh install --listen 172.31.92.20 --allow-peer 172.31.92.10 --instance orbit-lab-a`
   ([log](logs/kit-install-a.txt)), and the same for B with 172.31.92.30 and `orbit-lab-b` ([log](logs/kit-install-b.txt)).
3. `kit/lab-server.sh` ([log](logs/lab-server.txt)): tunnels, `install-server.sh`, managed runners on, both tokens
   copied (0600), `profile.json` naming A only, the stack up.
4. `kit/profile.sh <hosts…>` ([log](logs/profile.txt)) rewrites `docker.hosts` and recreates the apiserver, as the design
   says ("add its entry to docker.hosts, recreate the apiserver"). `node kit/scenario.mjs new|ready|session|sleep|wake|state`
   drives the accounts through the server's API. `kit/cadence.sh` reads B's channel log for B's pass cadence.
   `kit/drill.sh` runs the upgrade drill. Every line below is in [logs/timeline.txt](logs/timeline.txt).

## The profile (no secrets)

`data/managed-runners/profile.json` on the server; the `docker.hosts` list is the only thing the steps change:

```json
{
  "schemaVersion": 1, "valueKind": "actual", "backend": "docker",
  "environmentId": "mrmh-lab", "clusterKey": "mrmh-lab", "resourceProfileId": "docker-default",
  "docker": {
    "hosts": [
      { "instanceId": "orbit-lab-a", "channel": { "url": "http://172.31.92.20:7300" }, "tokenFile": "/var/lib/orbit-managed-runners/orbit-lab-a.token" },
      { "instanceId": "orbit-lab-b", "channel": { "url": "http://172.31.92.30:7300" }, "tokenFile": "/var/lib/orbit-managed-runners/orbit-lab-b.token" }
    ]
  },
  "storage": { "capacity": "5Gi" },
  "runner": { "image": "channel", "serverUrl": "https://<quick tunnel>.trycloudflare.com", "maxConcurrent": 2,
              "tmpSizeLimit": "512Mi", "resources": { "cpu": "1", "memory": "2Gi", "pids": 4096 } },
  "lifecycle": { "maxAttempts": 5, "backoffBaseSeconds": 10, "backoffMaxSeconds": 300, "startupDeadlineSeconds": 1800,
                 "requestTimeoutSeconds": 60, "leaseSeconds": 60, "pollIntervalSeconds": 5, "heartbeatFreshSeconds": 120,
                 "idleSeconds": 3600, "capacityRetrySeconds": 60, "drainSeconds": 600 }
}
```

| Step | `docker.hosts` | apiserver's line |
| --- | --- | --- |
| 0 | A | `managed runners are enabled in mrmh-lab (Docker instance orbit-lab-a (remote))` |
| (a) | A, B | `… (Docker instance orbit-lab-a (remote), Docker instance orbit-lab-b (remote))` |
| (b) | A `"draining": true`, B | `… (Docker instance orbit-lab-a (remote) (draining), Docker instance orbit-lab-b (remote))` |
| (c), (d) | A, B | `… (Docker instance orbit-lab-a (remote), Docker instance orbit-lab-b (remote))` |

Each pool is 5 runners, from each channel's `/v1/info` limits. The lab tracks it as `pods_reserved/pods` in
`managed_runner_capacity`.

## Each account's placement

| Account | Created | Docker hosts then | Pools then (A, B reserved/5) | Placed on | Why |
| --- | --- | --- | --- | --- | --- |
| `first` (administrator) | step 0 | A | – | **A** | the only host |
| `u2` | (a) | A, B | 1, 0 | **B** | the second host, more free room |
| `u3` | (a) | A, B | 1, 1 | **A** | a tie goes to the earlier host |
| `u4` | (a) | A, B | 2, 1 | **B** | more free room |
| `u5` | (b) | A draining, B | 2, 2 | **B** | a tie would go to A; A is draining |
| `u6` | (c) A refused | A, B | 2, 3 | **B** | A has more room but is unreachable |
| `u7` | (c) A blackholed, before the fix | A, B | 2, 4 | **A (bug)** | 16 s into the outage A was not yet marked |
| `u8` | (c) A blackholed, after the fix | A, B | 1, 2 | **B** | A has more room but is unreachable, marked within 3 s |

## Both hosts' runners at each step

From `scenario.mjs state` ([logs/timeline.txt](logs/timeline.txt)). A row is account, mapping state, generation and
container image. Every READY row's runner was `ONLINE` over the `LINK`.

### 0. `docker.hosts` = [A]

`first` READY on A in 27 s; its session answered in 7 s.

| Host A | Host B |
| --- | --- |
| first READY g1 `7f66c5f86923` | (not in the profile) |

### (a) B added: the next accounts are placed by free room

`u2` READY on B in 57 s, `u3` on A in 25 s, `u4` on B in 37 s. Sessions were answered on each: u2 44.5 s, u3 43.5 s,
u4 22.7 s (each a runner's first session).

| Host A | Host B |
| --- | --- |
| first READY g1 `7f66c5f86923` | u2 READY g1 `61e1370ab959` |
| u3 READY g1 `7f66c5f86923` | u4 READY g1 `61e1370ab959` |

### (b) A draining: no new placement on A; A's runners keep running

With pools tied at 2/5 (which would pick A), `u5` was placed on B, READY in 60 s, and its session answered in 12.9 s.
On draining A, `first` answered a session in 43.8 s and `u3` in 8.9 s; both containers kept running (22 and 8 minutes).

| Host A (draining) | Host B |
| --- | --- |
| first READY g1, Up 22 min | u2 READY g1 |
| u3 READY g1, Up 8 min | u4 READY g1 |
| | u5 READY g1 (new) |

### (c) one channel host unreachable

**Refused: A's channel stopped** (`docker compose stop docker-channel` on A, 12:04:32Z). The apiserver logged
`connect ECONNREFUSED 172.31.92.20:7300; looking again next pass` for A's two runners every pass. `u6`, created 26 s
later, was placed on **B** although A's pool had more room (2/5 vs 3/5), READY in 15 s, and its session answered in
5.6 s. B's `u2` and `u4` answered in 1.7 and 1.8 s. A's runner containers kept running, and `u3` answered over its link
(8.4 s). The channel was started again at 12:05:54Z. A's channel answered the manager's reads at 12:06:24Z (`GET
/v1/containers/… -> 200`), both A mappings stayed READY g1, and `first` answered (43.6 s).

| | Host A | Host B |
| --- | --- | --- |
| A stopped | first READY g1, u3 READY g1 (containers Up) | u2, u4, u5, u6 (new) READY g1 |
| A back | first READY g1, u3 READY g1 | u2, u4, u5, u6 READY g1 |

**Blackholed: A's channel port drops the server's packets**
(`iptables -I INPUT -s 172.31.92.10 -p tcp --dport 7300 -j DROP` on A; `curl` from the server hung until killed).

*Before the fix* (`a76a31cdb`, 12:07:51Z–12:19:04Z):

- `u7`, created 16 s in, was placed on **A**. It waited in PROVISIONING, `TRANSIENT`, and the apiserver logged
  `no answer within 60000 ms`.
- B's pass cadence (reads of B's container `mr-01a1d9e7…` in B's channel log): gaps of **243 s and 246 s**, against
  5–24 s before. Each pass waited 60 s for each of A's READY and PROVISIONING mappings, plus the recheck.
- B's runners stayed READY and answered (u2: 6.1 s), because the runner link does not go through the channel.
- After the unblock, `u7` came up on A in 18 s and answered (3.5 s), `u3` answered (1.4 s), and B's cadence was back to
  5–6 s.

| | Host A | Host B |
| --- | --- | --- |
| A blackholed | first READY g1, u3 READY g1, **u7 PROVISIONING (TRANSIENT)** | u2, u4, u5, u6 READY g1 |
| A back | first, u3, u7 READY | u2, u4, u5, u6 READY g1 |

*The OOM kill in between.* At 13:26Z the HPC host ran out of memory (other workloads), and the kernel killed all three
lab machines, which run with `--oom-score-adj 1000` so that they go first. They were restarted from their on-disk Docker
data, and the server's apiserver was recreated on `d29ffe525`, the profile unchanged. All seven runners came back by
themselves, each on its own host, as generation 2 (READY within a minute of the apiserver). Then u3 and u7 on A, and u5
and u6 on B, were put to sleep (`POST /managed-runner/sleep`), to leave memory and to give A more free room (pools 1/5,
2/5).

*After the fix* (`d29ffe525`, 14:09:55Z–14:15:18Z, 5 min 23 s):

- `u8`, created 9 s in, was placed on **B**, although A had more room, READY in 24 s, and its session answered in
  6.9 s.
- B's pass cadence over the whole outage: 32 reads, gaps of **8–9 s (max 11 s)**, against 5–6 s with A reachable. The
  delay is the one 3 s connect attempt per poll interval, under one poll interval.
- The apiserver logged one line for A in the whole outage
  ([logs/apiserver-blackhole-after-fix.txt](logs/apiserver-blackhole-after-fix.txt)):
  `READY, and the docker backend did not answer: … no connection within 3000 ms`.
- B's runners answered throughout: u2 3.2 s and 18.7 s, u4 1.8 s.
- Unblocked at 14:15:18Z: A's channel got `GET /v1/info -> 200`, the recheck, at 14:15:19Z, then the reads of
  `first`'s volume and container. `first` stayed READY g2 and answered (36.0 s). B's cadence was back to 5–6 s.

| | Host A | Host B |
| --- | --- | --- |
| A blackholed | first READY g2; u3, u7 SLEEPING | u2 READY g2, u4 READY g2, **u8 READY g1 (new)**; u5, u6 SLEEPING |
| A back | first READY g2 | same |

### (d) `remote-host.sh upgrade d29ffe525` on host B

Run for real on B, under the heavy lock (`kit/drill.sh upgrade d29ffe5254e7da381a880bcc16ae20c68f7dfeee`, full output in
[logs/drill-upgrade.txt](logs/drill-upgrade.txt)):

```text
==> 2026-11-14T14:20:10Z deploy/managed-runner/remote-host/remote-host.sh upgrade d29ffe5254e7da381a880bcc16ae20c68f7dfeee on mrmh-chan-b
==> Checking out d29ffe5254e7da381a880bcc16ae20c68f7dfeee
==> Building the Docker channel and the managed runners' firewall
==> Building the managed runner image from deploy/managed-runner/image (local, never pushed)
==> The managed runner image is now sha256:2e999fc4446ea8039885b2478ec4e92229624c714782e0e9f169c256b1a55553 in channel.json
    (it was sha256:61e1370ab959fb736d88b112ca7bef18e12164ae8f3d3a703c4a212e37da0dad: containers made from it keep running on it until they stop)
==> Recreating the managed runners' firewall if it changed
==> Recreating docker-channel to read channel.json
✓ Upgraded to d29ffe5254e7da381a880bcc16ae20c68f7dfeee.
upgrade exit 0
```

Before and after ([logs/drill-before.txt](logs/drill-before.txt), [logs/drill-after.txt](logs/drill-after.txt)):

| | Before (14:16:32Z) | After (14:23:35Z) |
| --- | --- | --- |
| B `channel.json` image | `sha256:61e1370ab959…` | `sha256:2e999fc4446e…` |
| B `/v1/info` image, asked from the server | `sha256:61e1370ab959…` | `sha256:2e999fc4446e…` |
| B checkout | `a76a31cdb` | `d29ffe525` |
| A `/v1/info` image | `sha256:7f66c5f86923…` | `sha256:7f66c5f86923…` (untouched) |
| apiserver container | started 14:06:48Z | started 14:06:48Z, 0 restarts, to the end of the drill |
| `profile.json` | sha256 `146a8edb0890143b…`, `runner.image` `"channel"` | the same |

`remote-host.sh status` on B afterwards ([logs/drill-status-b.txt](logs/drill-status-b.txt)): `Image:
sha256:2e999fc4446e… in channel.json, built from d29ffe5254e7…`.

**The server adopts it unchanged.** The apiserver was neither restarted nor reconfigured. Its only lines in the switch
were `connect ECONNREFUSED` for B's three READY runners at 14:23:19Z, during the channel's few-second recreate. No
`DOCKER_CHANNEL_MISMATCH` appeared.

**Runners still on the old image are not broken.** `u4` (g2) and `u8` (g1) kept running on `61e1370ab959` and answered
sessions after the switch (u4 2.5 s and 2.8 s, u8 2.4 s), and both stayed READY.

**The next generation starts from the new image:**

- `u5`, asleep on B, was woken: READY as generation 3 in 28 s, container image `2e999fc4446e`, session answered in 5.9 s.
- `u2`, running on the old image, was slept and woken: generation 3, image `2e999fc4446e`, revision label
  `d29ffe5254e7…`, session answered in 3.5 s. Its old generation's label was `a76a31cdb…`, as `u4`'s still is.

| Host A | Host B after the drill |
| --- | --- |
| first READY g2 `7f66c5f86923` | u2 READY **g3 `2e999fc4446e`** (slept, woken) |
| u3, u7 SLEEPING | u5 READY **g3 `2e999fc4446e`** (woken) |
| | u4 READY g2 `61e1370ab959` (old image, still answering) |
| | u8 READY g1 `61e1370ab959` (old image, still answering) |
| | u6 SLEEPING |

## The fix (`d29ffe525`)

- `src/apiserver/src/managed-runners/docker-channel-client.ts`: `DOCKER_CHANNEL_CONNECT_TIMEOUT_MS` = 3000, never longer
  than the call's own timeout. A connection that is not made in time is destroyed, and the call rejects with
  `DockerChannelUnreachable(…, connected: false)`, which is what marks the backend unreachable.
- `src/apiserver/src/managed-runners/managed-runner-worker.ts`: in a several-host pass, a host still marked unreachable
  after `recheckReachability` has none of its mappings driven. They are driven in the pass whose recheck it answers. A
  single host is driven as before.
- Specs: the connect timeout (`docker-backend.spec.ts`), the skip and its end (`managed-runner-hosts.spec.ts`). Pg cases
  (5) and (7) of `managed-runner-hosts.pg.spec.ts` now run at a 1 s poll interval and let it pass before a returned host
  is expected to be driven.

## Not covered here

- A new account landing on the upgraded host B. By free room the next account would go to A (1/5 against B's 4/5
  during the drill), and putting it on B would have needed `draining` on A, which is a profile edit and an apiserver
  restart inside the drill. The next generation on the new image is shown by the two wakes instead, which the task
  allows ("after it sleeps and wakes, or a new account").
- After its first, the administrator account's (`first`) sessions took 36–44 s each, against 1.4–8.9 s for `u3` and
  `u7` on the same host A. That held from step (b) onward, outages or not. This lab did not look into why.
- Only one outage of each kind, a few minutes long, with at most three runners on the unreachable host.
