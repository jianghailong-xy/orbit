# Load test steady

Commit `c615e5f18b5e`, 1 apiserver backend(s), database CPU allocation 4, host 8 CPUs, the gateway's merge window default, under the host's load test lock.
Steady window 2026-10-28T02:01:00.000Z → 2026-10-28T02:11:00.000Z (10 min), after a ramp of 20 s.

**Verdict: FAIL**

| Criterion | Target | Measured | Pass |
| --- | --- | --- | --- |
| connections | 1000 | 1000 (lowest in the window) | yes |
| heartbeats per second | ≈ 500 | 67 | **no** |
| durable events per second | ≈ 2000 | 20 | **no** |
| steady window | 1 h | 10 min | **no** |
| errors | 0 | 7 | **no** |
| EventAck p99 (runner side, per batch) | < 1000 ms | 120 ms | yes |
| EventAck p99 (runner side, per event) | < 1000 ms | 120 ms | yes |
| EventAck within 1 s (gateway histogram) | ≥ 99% | 99.333% | yes |
| database CPU peak (10 s) | < 60% | 50% of 4 CPUs (2 cores) | yes |

## Errors

| Source | Count |
| --- | --- |
| loadgen | 0 |
| gateway | 7 |
| gatewayLogWarnError | 0 |
| apiserverErrorLines | 0 |
| http5xx | 0 |
| postgresErrorLines | 0 |
| deadlocks | 0 |
| natsErrorLines | 0 |

Gateway counters that moved:

- `backend_retries{kind="welcome",reason="lost"}`: 7

Log lines of link-gateway in the window: none

Log lines of postgres in the window: none

Log lines of nats in the window: none

Web gateway responses in the window: {}; link tokens {}

## What the runners saw (loadgen, steady window)

| Measure | Value |
| --- | --- |
| runners, active sessions | 1000, 500 (0.040 events/s each) |
| heartbeats acknowledged per second | 67 |
| events acknowledged per second | 20 |
| batches acknowledged per second | 10 |
| events per batch | 2 |
| payload bytes per second | 12000 |
| EventAck latency per batch (ms) | p50 60, p90 120, p99 120, p99.9 120, max 120 |
| EventAck latency per event (ms) | p50 60, p90 120, p99 120, p99.9 120, max 120 |
| HeartbeatAck latency (ms) | p50 2, p99 9, max 9 |
| renewals, reconnects, link tokens minted | 0, 0, 0 |
| token mint latency (ms) | p50 3, p99 8 |
| dial to Welcome (ms) | p50 4, p99 40 |
| events resent | 0 |
| notes | {} |
| unacknowledged at the end | 0 |

## The gateway (counters over the window)

| Measure | Value |
| --- | --- |
| connections (min, max) | 1000, 1000 |
| EventAck duration (gateway) | 6000 batches, mean 80 ms, p50 ≈ 62.5 ms, p99 ≈ 750 ms, 99.333% within 1 s |
| heartbeat forward duration | mean 3 ms, p99 ≈ 23 ms |
| ingest queue, most events | 40 |
| link_handshakes_total | — |
| link_disconnects_total | — |
| link_backend_calls_total | {kind="events",result="answered"} 6000, {kind="heartbeat",result="answered"} 40000 |
| link_heartbeat_forwards_total | {result="forwarded"} 40000 |
| link_event_batches_total | {result="stored"} 6000 |
| link_hints_total | — |
| link_event_merge_calls_total | — |
| link_event_merge_flushes_total | — |
| link_event_merge_alone_total | — |

## CPU and memory (steady window)

| Component | mean cores | peak 10 s | peak 60 s | peak MiB | CPU pressure (mean / peak 60 s) | throttled |
| --- | --- | --- | --- | --- | --- | --- |
| postgres | 2 | 2 | 2 | 2048 | 5% / 5% | 0% |
| apiserver | 0.8 | 0.8 | 0.8 | 700 | 0% / 0% | 0% |
| link-gateway | 1.5 | 1.5 | 1.5 | 512 | 10% / 10% | 0% |

## The host

| Measure | Value |
| --- | --- |
| busy cores (mean, peak 60 s) of 8 | 4.8, 4.8 |
| of which this test (mean) | 4.3 |
| of which everything else (mean): busy minus this test, and by cgroup | 0.5, 0.5 |
| load average 1 min (min, mean, max) | 4.8, 4.8, 4.8 |
| host CPU pressure (some) | 2% |
| memory available, lowest | 8789 MiB |
| swap in / out (pages) | 0 / 0 |

Swapping out at 1 MiB/s or more began: never. At 10 MiB/s or more: never.
Peak swap-out: 0 pages/s (0 MiB/s) at 5 s, 500 runners connected.

Host memory over the run, every 15 s:

| elapsed | connected | available MiB | swap out pages/s | swap in pages/s |
| --- | --- | --- | --- | --- |
| 5 s | 500 | 8789 | 0 | 0 |
| 20 s | 1000 | 8789 | 0 | 0 |
| 35 s | 1000 | 8789 | 0 | 0 |
| 50 s | 1000 | 8789 | 0 | 0 |
| 65 s | 1000 | 8789 | 0 | 0 |
| 80 s | 1000 | 8789 | 0 | 0 |
| 95 s | 1000 | 8789 | 0 | 0 |
| 110 s | 1000 | 8789 | 0 | 0 |
| 125 s | 1000 | 8789 | 0 | 0 |
| 140 s | 1000 | 8789 | 0 | 0 |
| 155 s | 1000 | 8789 | 0 | 0 |
| 170 s | 1000 | 8789 | 0 | 0 |
| 185 s | 1000 | 8789 | 0 | 0 |
| 200 s | 1000 | 8789 | 0 | 0 |
| 215 s | 1000 | 8789 | 0 | 0 |
| 230 s | 1000 | 8789 | 0 | 0 |
| 245 s | 1000 | 8789 | 0 | 0 |
| 260 s | 1000 | 8789 | 0 | 0 |
| 275 s | 1000 | 8789 | 0 | 0 |
| 290 s | 1000 | 8789 | 0 | 0 |
| 305 s | 1000 | 8789 | 0 | 0 |
| 320 s | 1000 | 8789 | 0 | 0 |
| 335 s | 1000 | 8789 | 0 | 0 |
| 350 s | 1000 | 8789 | 0 | 0 |
| 365 s | 1000 | 8789 | 0 | 0 |
| 380 s | 1000 | 8789 | 0 | 0 |
| 395 s | 1000 | 8789 | 0 | 0 |
| 410 s | 1000 | 8789 | 0 | 0 |
| 425 s | 1000 | 8789 | 0 | 0 |
| 440 s | 1000 | 8789 | 0 | 0 |
| 455 s | 1000 | 8789 | 0 | 0 |
| 470 s | 1000 | 8789 | 0 | 0 |
| 485 s | 1000 | 8789 | 0 | 0 |
| 500 s | 1000 | 8789 | 0 | 0 |
| 515 s | 1000 | 8789 | 0 | 0 |
| 530 s | 1000 | 8789 | 0 | 0 |
| 545 s | 1000 | 8789 | 0 | 0 |
| 560 s | 1000 | 8789 | 0 | 0 |
| 575 s | 1000 | 8789 | 0 | 0 |
| 590 s | 1000 | 8789 | 0 | 0 |
| 605 s | 1000 | 8789 | 0 | 0 |
| 620 s | 1000 | 8789 | 0 | 0 |
| 635 s | 1000 | 8789 | 0 | 0 |
| 650 s | 1000 | 8789 | 0 | 0 |
| 665 s | 0 | 8789 | 0 | 0 |
| 680 s | 0 | 8789 | 0 | 0 |

Biggest CPU users on the host over the window (cores):

- docker-postgres.scope (this test: postgres): 2
- docker-link-gateway.scope (this test: link-gateway): 1.5
- docker-apiserver.scope (this test: apiserver): 0.8
- user.slice: 0.45
- cron.service: 0.05

## The database (steady window)

| Measure | Value |
| --- | --- |
| seconds | 600 |
| commitsPerSecond | 300 |
| rollbacks | 0 |
| rowsInsertedPerSecond | 20 |
| rowsUpdatedPerSecond | 70 |
| walMiBPerSecond | 0.05 |
| deadlocks | 0 |
| tempBytes | 0 |
| cacheHitPct | 100 |
| backendsMax | 15 |
| activeMax | 3 |
| lockWaitsMax | 0 |

Top statements by total time:

| calls | total s | mean ms | max ms | statement |
| --- | --- | --- | --- | --- |

## Per 5 minutes (loadgen series)

| elapsed | phase | connected | events/s | beats/s | ack p99 ms (max of intervals) | errors |
| --- | --- | --- | --- | --- | --- | --- |
| 10 s | steady | 1000 | 20 | 67 | 120 | 0 |
| 310 s | steady | 1000 | 20 | 67 | 120 | 0 |
| 610 s | drain | 0 | 20 | 67 | 120 | 0 |
