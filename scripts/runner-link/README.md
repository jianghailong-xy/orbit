# Runner link staging stack

These scripts run a complete Orbit deployment for runner link drills on one host: postgres, the apiserver, web, the web
gateway, the link gateway ([src/link-gateway](../../src/link-gateway/README.md)) and NATS, which carries the runner hints
between the last two. It is the root
`docker-compose.yml`, under a Compose project of its own, with `staging.compose.yml` on top. Every container is renamed,
every host port is moved to the staging bind address (127.0.0.1 by default), and every data directory moves into the
staging state directory. The images it builds are tagged with the project's name. Nothing it runs, writes or builds can
be taken for a deployment's.

| Script | What it does |
| --- | --- |
| `staging-up.sh` | Build from this checkout, start, seed and smoke-check. Run it again to converge: images are rebuilt, changed containers recreated, and the database, secrets, certificates and seeded account kept. `--rotate-cert` gives the link gateway a new certificate in place. `--no-build` reuses the last images. |
| `staging-down.sh` | Stop and remove the containers and the project's network, keeping the state directory. `--purge` also deletes the state directory and the project's volume. `--rmi` also deletes the images. |
| `staging-client.sh` | Run the gateway's test client as the seeded probe runner. Arguments go to `link-gateway client`. |
| `staging-check.sh` | The shadow period's check, with the stack in MODE_HTTP. It checks the running stack's link gateway end to end, in six steps: refusals and TLS; a mirroring runner with heartbeats and pings; a gateway release that drains the runner, which then reconnects; a certificate rotation under a live connection; a revocation that closes a live connection; and hints over NATS, published on each runner's own subject and relayed only for the runner the gateway holds. Each step's records go to `<state>/client/check/`. Run it on a quiet stack, in the files TLS mode. Step 5 leaves the probe runner with a new token, and step 6 registers a second runner the first time it runs (its token is kept in `secrets/hint_peer_token`). |
| `staging-check-link.sh` | The forwarding check, with the stack in MODE_LINK over two apiservers. Six steps, with the test runner's drills (`link-gateway client -drill`) and the stack's own state: NATS's authorization on the stack's NATS; the link drill (requests and their answers, heartbeats and facts, hints, an approval the owner allows through the web API with its hint and HeartbeatAck's hints, durable events, gaps and credit, the live stream while the owner watches, the turn prefix, an answer in pieces), then presence and the database's own record of it; a claim cancelled while it waits for the claim lock, held from `psql`; calls answered while the second apiserver is killed and started again; a runner that stops reading, closed as a slow consumer; and a session's event stream cut with batches in flight, resumed on a new connection from the durable seq its Welcome states, with no seq refused as a gap and every seq stored once. Each step's records go to `<state>/client/check-link/`. |
| `staging-check-switch.sh` | The cut-over switch's check, with the gateway following the server's `RUNNER_LINK_REQUIRED` (`ORBIT_LINK_STAGING_MODE=http`). The test runner's switch drill (`link-gateway client -drill switch`): the owner, the stack's administrator, flips the switch on, and HTTPS daemon calls are answered `426 UPGRADE_REQUIRED` unless they name their caller, the shadow's connection is told `MODE_LINK`, and a new connection works over the link; then off in the middle of a session's event stream, and the work connection is told `MODE_HTTP` and its requests refused while its event batches are still stored, before the runner sends the rest over HTTPS. Then the stack's record: the gateway back in `MODE_HTTP`, every read of the switch answered, each switch logged, and every seq of the session stored once. The records go to `<state>/client/check-switch/`, and the switch is left off. |
| `staging-name-check.sh` | Check that every staging script refuses a Compose project outside `orbit-link-*` before it does anything: a deployment's containers are `orbit-*`, so such a name could make a script stop, rebuild or write into one. |
| `nats-auth-check.sh` | Check `src/link-gateway/nats.conf` on a throwaway nats-server with fresh keys: it refuses to start without both public keys, and admits each user to what it does alone. |
| `gen-hint-fixtures.mjs` | Regenerate `src/link-gateway/testdata/b1-hints.json` from the apiserver's hint encoder. |
| `gen-token-fixtures.mjs` | Regenerate `src/link-gateway/testdata/a3-tokens.json` from the apiserver's token code. |
| `gen-event-kind-fixtures.mjs` | Regenerate `src/runner-go/testdata/b8-link-events.json` from the apiserver's event rules: `isNoiseSystemEvent`, the live-only types and the coordinator-context boundary subtypes, which the runner's link event stream mirrors. |
| `loadgen-seed.sh` | The load test's fleet in the stack's database: `seed` (owners, runners, a workspace each, idle sessions), `arm` before each run (fresh running sessions, presence, the fleet file `<state>/loadgen/fleet.jsonl`), `disarm` after it, `remove`. See [Load test](#load-test). |
| `loadgen-run.sh` | One load test run: `src/link-gateway/cmd/loadgen` against the stack, with the stack's CPU, memory, metrics, database and logs collected beside it, then the report. |
| `loadgen-report.mjs` | A run's report: each criterion with the figure it rests on (`report.md`, `report.json`). |
| `loadgen-baseline.mjs` | What one heartbeat and one event batch cost, from a heartbeats-only run and a run with events: see [Per-operation baseline](#per-operation-baseline). |

```bash
scripts/runner-link/staging-up.sh
scripts/runner-link/staging-check.sh
scripts/runner-link/staging-check-switch.sh
ORBIT_LINK_STAGING_MODE=link ORBIT_LINK_STAGING_BACKENDS=2 scripts/runner-link/staging-up.sh --no-build
scripts/runner-link/staging-check-link.sh
scripts/runner-link/staging-client.sh -duration 60s
scripts/runner-link/staging-down.sh
```

## Settings

Each setting is an environment variable. A run that leaves one unset keeps the value the previous run recorded, or
else the default:

| Variable | Default | Meaning |
| --- | --- | --- |
| `ORBIT_LINK_STAGING_PROJECT` | `orbit-link-staging` | The Compose project, and the prefix of container and image names. It must be `orbit-link-<name>`: every script refuses anything else before it runs (`staging-name-check.sh`). |
| `ORBIT_LINK_STAGING_DIR` | `/var/tmp/<project>` | The state directory. |
| `ORBIT_LINK_STAGING_BIND` | `127.0.0.1` | The address the host ports listen on. |
| `ORBIT_LINK_STAGING_HOST` | `localhost` | The name clients use, in URLs and in the link gateway's certificate. |
| `ORBIT_LINK_STAGING_HTTP_PORT` | `18086` | Web and `/api`, through the web gateway. |
| `ORBIT_LINK_STAGING_LINK_PORT` | `18443` | The link gateway. |
| `ORBIT_LINK_STAGING_METRICS_PORT` | `19464` | The link gateway's metrics, on 127.0.0.1. |
| `ORBIT_LINK_STAGING_TLS` | `files` | `files`: a staging CA and a certificate from it. `acme`: Pebble issues the certificate over ACME. |
| `ORBIT_LINK_STAGING_NATS_PORT` | `14222` | NATS's client port, on the bind address. |
| `ORBIT_LINK_STAGING_NATS_MONITOR_PORT` | `18222` | NATS's monitoring, on 127.0.0.1. |
| `ORBIT_LINK_STAGING_MODE` | `http` | The link gateway's `LINK_MODE`: `http`, which follows the server's `RUNNER_LINK_REQUIRED` switch (the shadow period that `staging-check.sh` checks while the switch is off, and what `staging-check-switch.sh` flips), or `link`, forwarding whatever the switch says, that `staging-check-link.sh` checks. Switching recreates only the gateway. |
| `ORBIT_LINK_STAGING_BACKENDS` | `1` | How many apiservers the gateway forwards to: `2` adds `apiserver-b`, the first one's whole definition on the same database, which `staging-check-link.sh` kills and starts again. |
| `ORBIT_LINK_STAGING_LOADGEN` | `0` | `1` adds `staging.loadgen.compose.yml` for a load test: the gateway logs only Hello, Welcome, Drain and Close, admits any number of connections from one address (the per-address limit; the limit across all clients stays), and the gateway, apiservers and database are capped in memory. |
| `ORBIT_LINK_STAGING_DB_CPUS` | `0` | With `LOADGEN=1`, the database's CPU allocation (Compose `cpus`), the capacity a load test's database CPU is a share of. `0` is unlimited. |

Two stacks can run side by side under different projects, state directories and ports. Compose runs with an empty
environment plus the env file the scripts write, so nothing from the calling shell reaches the stack. That includes an
agent session's `ORBIT_*` variables, which Compose would otherwise prefer to the file.

## What the state directory holds

| Path | What it is |
| --- | --- |
| `staging.json` | Where everything is: the origin and API, the link URL, the metrics URL, the probe runner's id, and the paths below. |
| `compose.env` | The env file Compose reads, with the secrets in it. |
| `secrets/` | The JWT and provider secrets, the link signing key, the gateway token, the owner's password (`owner@orbit-staging.test`), the probe runner's token, a fresh enrollment token for one more runner, and NATS's two nkey users (`nats_apiserver_seed`/`_key`, `nats_gateway_seed`/`_key`), made once with the gateway image's `nkey`. |
| `tls/ca.pem`, `tls/ca-bundle.pem` | The staging CA, and the system's roots with the CA added (for `SSL_CERT_FILE`). |
| `gateway/` | Mounted into the link gateway: `tls/fullchain.pem` and `tls/privkey.pem`, and `acme/` in the ACME mode. |
| `postgres/`, `pg-archive/` | The database and its WAL archive. |

## Drills

- **A real runner.** Build the runner from the checkout under test and register it with the enrollment token in
  `secrets/enrollment_token`, against `http://127.0.0.1:18086`. A runner that dials the link trusts the staging CA through
  `SSL_CERT_FILE=<state>/tls/ca-bundle.pem`.
- **A gateway release.** Run `docker compose kill -s TERM` on `<project>-link-gateway`, or simply
  `docker kill -s TERM <project>-link-gateway`. The gateway drains and exits, and its restart policy starts it again.
  Run `staging-client.sh -until-drains 1` beforehand to see a runner drained and reconnected.
- **A certificate rotation.** Run `staging-up.sh --rotate-cert --no-build`. The gateway loads the new certificate within
  30 seconds, without a restart. The serial in its log and `link_tls_certificate_not_after_timestamp_seconds` show it.
- **A revocation.** Rotate the probe runner's token (`POST /api/runners/<id>/rotate-token` as the owner). The gateway
  closes the runner's open connections at its next revocation read and refuses the old token from then on.
  `staging-up.sh` registers a new probe runner when it finds the old token dead.
- **Hints.** Every hint the apiserver publishes can be watched as it goes by, with NATS's own CLI inside the project's
  network, signed in as the gateway's user: `docker run --rm --network <project>_default -v <state>/secrets:/s:ro
  natsio/nats-box nats sub -s nats://nats:4222 --nkey /s/nats_gateway_seed 'rnr.>'`. Without a seed NATS refuses the
  connection.
  `curl -s 'http://127.0.0.1:18222/subsz?subs=1'` lists the subjects the gateway subscribes to, one per connected
  runner, and `link_hints_total` counts what the gateway did with each hint.
- **Metrics.** `curl -s http://127.0.0.1:19464/metrics | grep ^link_`.
- **Logs and frames.** `docker logs <project>-link-gateway` summarizes every frame in both directions; staging sets
  `LINK_FRAME_LOG=all`. `link-gateway dump` decodes a frame from its log line.

## Load test

The cell-scale load test (task C2, design §9) runs on a stack in MODE_LINK with the load test's settings. A private
stack keeps it from the shared one's drills, and its database from their sessions:

```bash
export ORBIT_LINK_STAGING_PROJECT=orbit-link-c2 ORBIT_LINK_STAGING_DIR=/var/tmp/orbit-link-c2
ORBIT_LINK_STAGING_HTTP_PORT=61086 ORBIT_LINK_STAGING_LINK_PORT=61443 ORBIT_LINK_STAGING_METRICS_PORT=61464 \
  ORBIT_LINK_STAGING_NATS_PORT=61422 ORBIT_LINK_STAGING_NATS_MONITOR_PORT=61822 ORBIT_LINK_STAGING_PEBBLE_PORT=61500 \
  ORBIT_LINK_STAGING_MODE=link ORBIT_LINK_STAGING_LOADGEN=1 scripts/runner-link/staging-up.sh
scripts/runner-link/loadgen-seed.sh seed            # 10,000 owners, 15,000 runners, 40,000 open sessions
scripts/runner-link/loadgen-seed.sh arm             # 5,000 of them running, and the fleet file
scripts/runner-link/loadgen-run.sh --name full-1h -- -duration 1h -event-rate 2000
```

- **The fleet** follows the cell's planning numbers per owner (design §1.3): 1.5 runners, 4 open sessions, 0.5 turns
  running. Its rows are SQL inserts, and each runner's token and process id are kept in the `loadgen` schema. A
  running session is leased to its runner's process and has an engine session id, as a claim and an engine start leave
  it. `arm` gives each run new running sessions, so a run starts from seq 1 on sessions the reaper never finished;
  `loadgen-run.sh` disarms them as soon as the loadgen exits, before the reaper reads the fleet's silence (90 s) and
  queues their cancellation for the runners' next processes.
- **The connections** go to the gateway container's own address (`-connect`), so no docker-proxy stands between, and
  TLS still checks the certificate's `link-gateway` name.
- **What is collected**, besides what the runners saw (`series.jsonl`, `summary.json`, `errors.log`): CPU, CPU
  pressure (PSI) and memory of each container and of the loadgen every 5 s, with the host's CPU, load, memory and swap
  (`samples.jsonl`); every service's and container's CPU on the host every 15 s, for what else ran (`slices.jsonl`);
  the gateway's `/metrics` every 15 s (`metrics.prom`); the database's sessions, transactions, rows and WAL every 15 s
  (`db.jsonl`), its statements (`pgss.json`, after `pg_stat_statements_reset()` at the start) and sizes; and each
  container's log over the run (`logs/`).
- **The report** takes every figure over the steady window. Errors are counted wherever a part can report them: the
  runners, the gateway's counters and its WARN/ERROR lines, the apiserver's ERROR lines and any 5xx of the web
  gateway, the database's ERROR/FATAL/PANIC lines and deadlocks, NATS's `[ERR]` lines. The database's CPU peak is the
  highest 10 s average of its container's CPU time, as a share of `ORBIT_LINK_STAGING_DB_CPUS` when set.
- **On a shared host**, the loadgen runs in a scope of its own (`systemd-run`), and the run stops itself when the
  host's available memory stays under `LOADGEN_MIN_AVAILABLE_MB` (800) for 15 s. The report's host section says what
  else used the CPUs and how long the stack's containers waited for one (CPU pressure).
- **One load test at a time on HPC**, whichever stack it is for. Wrap each run, its `arm` included, in the host's lock,
  so a second run waits until the first ends:
  `flock /var/tmp/orbit-loadgen.lock sh -c 'scripts/runner-link/loadgen-seed.sh arm && scripts/runner-link/loadgen-run.sh --name <run> -- <args>'`.
  `run.json`'s `loadTestLock` and the report's first line say whether a run held it. Two runs that overlap spoil each
  other's per-operation figures, and on HPC they swap, which slows the production wiki model's vLLM workers there.

### Knobs

| Where | Knob | Default |
| --- | --- | --- |
| `loadgen-seed.sh` | `LOADGEN_OWNERS`, `LOADGEN_RUNNERS`, `LOADGEN_SESSIONS`, `LOADGEN_ACTIVE`: owners, runners, open sessions, running sessions | 10000, 15000, 40000, 5000 |
| `loadgen-run.sh -- …` | `-duration` (steady window), `-settle` (from the fleet connected to the window), `-event-rate` (events/s across the fleet), `-ramp-rate` (first connections/s), `-flush-min`/`-flush-max`/`-max-batch` (batching), `-runners` (play the first N), `-spread-renewals`, `-volatile`/`-volatile-edits` (the reports that move in production); all of them in [src/link-gateway/cmd/loadgen](../../src/link-gateway/cmd/loadgen/README.md) | 1h, 30s, 2000, 150, 1s/3s/100, all, true, off/0.5 |
| `loadgen-run.sh` | `LOADGEN_MIN_AVAILABLE_MB`: the host memory floor that stops a run | 800 |
| `loadgen-run.sh` | `--mark-every <seconds>`: move every runner's change count this often, so each beat reconciles in full (see [the heartbeat after task O1](#the-heartbeat-after-task-o1)) | off |
| `staging-up.sh` | `ORBIT_LINK_STAGING_BACKENDS` (apiservers behind the gateway), `ORBIT_LINK_STAGING_DB_CPUS` (the database's CPU allocation) | 1, unlimited |

`node scripts/runner-link/loadgen-report.mjs <run>` writes a run's report again from what it collected.

### Host sizing

Measured on 2026-10-25 (commit ada118b91):

| Part | Memory | CPU |
| --- | --- | --- |
| link gateway | about 190 KB a connection: 2.3 GB at 12,000 connections | 0.47 cores at 12,000 connections, with the apiserver overloaded behind it |
| loadgen | 1.2 GB at 12,000 runners | 0.25 cores |
| apiserver (one Node process) | up to 1.9 GB when overloaded | saturates at 100 beats/s and 260 batches/s: its main thread at 99% |
| postgres | 0.2 to 1.6 GB | see the baseline below |

A 15,000-runner run needs 6–7 GB beside whatever else the host runs. On HPC (14 GB of memory, about 9 of 24 cores
used by other work) it swapped 3.5 GB out within 2.4 minutes. A stack scaled out to carry the target (6 or more
apiservers, an 18–20 core database) needs a machine of its own: 32 or more cores and 32 GB or more.

### Per-operation baseline

What one heartbeat and one event batch cost, for the optimisation tasks to measure against. On a fleet of 3,000 runners
with 1,000 running sessions, run heartbeats alone, then with events, and compare:

```bash
export LOADGEN_OWNERS=2000 LOADGEN_RUNNERS=3000 LOADGEN_SESSIONS=8000 LOADGEN_ACTIVE=1000
scripts/runner-link/loadgen-seed.sh seed
scripts/runner-link/loadgen-seed.sh arm && scripts/runner-link/loadgen-run.sh --name cost-hb -- -duration 2m -event-rate 0
scripts/runner-link/loadgen-seed.sh arm && scripts/runner-link/loadgen-run.sh --name cost-ev150 -- -duration 2m -event-rate 150
node scripts/runner-link/loadgen-baseline.mjs <state>/loadgen/runs/cost-hb <state>/loadgen/runs/cost-ev150
```

It prints the table below and the statements each operation runs, most database time first. Measured on 2026-10-25 at
commit 572171c2e (the apiserver and the gateway of project tip 529d161bd, B4a and D0 included), on a fresh stack with
one apiserver, the stack's idle use under 0.02 cores. CPU counts the steady window; statements and commits count the
whole run, connects included:

| Per operation | apiserver CPU | database CPU | gateway CPU | SQL statements | commits |
| --- | --- | --- | --- | --- | --- |
| heartbeat | 3.80 ms | 8.08 ms | 0.48 ms | 28.3 | 28.4 |
| event batch (1.22 events) | 2.41 ms | 2.82 ms | 0.18 ms | 13.7 | 6.3 |

The first baseline, at ada118b91 before B4a and D0, measured the heartbeat at 3.29 / 7.67 / 0.60 ms and 27.9
statements, and the batch at 2.20 / 2.69 / 0.16 ms and 13.6 statements.
- The heartbeat's 0.4 more statements are B4a's welcome route. Every connect runs four more: the guard's three reads
  and the durable-seq walk, spread over the run's six beats a connect.
- The CPU figures moved by 5 to 20%, about what this host varies between runs: other work used 6 to 10 of its 24
  cores. A first pass at this head measured the heartbeat at 3.98 / 8.86 / 0.60 ms.

- A heartbeat is the full reconcile on every beat: every statement is its own transaction. It rewrites the runner row
  with all its facts, upserts presence, and runs about 20 reads and conditional updates for the commands it may
  deliver. Design §5.7 has a beat write presence only and reconcile when flagged or every 5 minutes.
- An event batch is one ingest transaction: BEGIN, about 8 statements, the NOTIFY and COMMIT. Before it come about
  5 reads, each its own transaction: the guard's runner, owner and managed-instance reads, and the engine-session
  check. Design §6.6 batches several sessions' events into one write.
- At the cell's target (500 beats/s and 2,000 events/s, which the B8 cadence sends as about 1,290 batches/s of 1.55
  events), these costs come to about 5 apiserver cores (7 or more Node processes at 75%) and about 7.7 database cores
  on average, 11 to 12 at 10-second peaks.


### The heartbeat after task O1

Since task O1 a heartbeat the link gateway forwards is answered from `runner_presence`
([link-heartbeat.ts](../../src/apiserver/src/runner-api/link-heartbeat.ts)). One statement does three things: it admits
the caller, records the beat and reads what the answer needs. It goes to the database as a named prepared statement.

A beat reconciles in full only when one of these holds:

- something it delivers was marked;
- its inputs changed;
- a lease was lost;
- there is no record;
- the runner's five-minute period turned over.

A beat whose reports alone moved writes them in one more statement. Every beat is therefore either unflagged or
reconciled in full. A third heartbeats-only run tells the two apart: `--mark-every 5` moves every runner's change count
every 5 s, so every beat of that run reconciles in full. `loadgen-baseline.mjs --full` then splits each figure by kind:

```bash
run() { flock /var/tmp/orbit-loadgen.lock sh -c "scripts/runner-link/loadgen-seed.sh arm && scripts/runner-link/loadgen-run.sh $*"; }
run --name cost-hb -- -duration 2m -event-rate 0
run --name cost-hb-full --mark-every 5 -- -duration 2m -event-rate 0
run --name cost-ev150 -- -duration 2m -event-rate 150
node scripts/runner-link/loadgen-baseline.mjs <state>/loadgen/runs/cost-hb <state>/loadgen/runs/cost-ev150 --full <state>/loadgen/runs/cost-hb-full
```

To move the runners' reports as production moves them, add `-volatile` to the loadgen arguments of all three runs.

HPC has 8 P-cores (CPUs 0–7) and 16 E-cores, under the `powersave` governor. A light run's CPU time per operation depends
on which kind of core its containers land on: the same Ed25519 check takes 45 µs on a P-core and 64 µs on an E-core.
Unpinned, the same code measured an unflagged beat at 0.90 ms and at 1.58 ms of apiserver CPU, an hour apart, while its
full and event runs cost the same both times. For comparable figures, pin the containers:

```bash
docker update --cpuset-cpus 0-7 <project>-apiserver <project>-postgres <project>-link-gateway <project>-gateway <project>-nats
```

Unpin them afterwards with `--cpuset-cpus 0-23`. `run.json` keeps each container's cpuset.

Measured on 2026-10-26 at commit 777a01d38. The stack was the private `orbit-link-o1`, with one apiserver and its
containers on CPUs 0–7. Every run held the host's load test lock. Statements and commits are over the steady window:

| Per heartbeat | apiserver CPU ms | database CPU ms | SQL statements | commits |
| --- | --- | --- | --- | --- |
| unflagged | 0.53 | 0.34 | 1.07 | 1.08 |
| unflagged, reports moving (`-volatile`) | 0.59 | 0.63 | 1.38 | 1.38 |
| reconciled in full | 2.19 | 5.97 | 23.5 | 23.5 |
| reconciled in full, reports moving | 2.39 | 6.37 | 25.2 | 25.2 |
| every beat (9.9% reconciled in full) | 0.70 | 0.90 | 3.29 | 3.30 |
| every beat, reports moving (11.5% reconciled in full) | 0.80 | 1.29 | 4.12 | 4.13 |

Before O1 every beat reconciled in full: 3.80 ms and 8.08 ms (the baseline above, unpinned). An event batch of 1.22
events cost 1.87 ms of apiserver CPU, 2.03 ms of database CPU, 13.7 statements and 6.3 commits.

- **An unflagged beat** is one statement and one commit (`link-heartbeat.pg.spec.ts`, case 1). The figures also carry
  the window's renewals, the reaper's sweeps and the stack's idle use: 0.019 apiserver cores and 0.008 database cores,
  0.18 ms and 0.08 ms of each beat at 100 beats/s.
- **A beat whose reports alone moved** writes them in one more statement and commit. With `-volatile`, about a third
  of the unflagged beats did. That statement's text varies with what moved, so it goes unnamed.
- **The beat statement goes as a named prepared statement.** Unnamed, PostgreSQL parsed and planned it on every beat:
  1.58 ms of database CPU a beat, against 0.21 ms named (pgbench, one client).
- **The guard checks a link token's signature once per token**, not on every call. Before, the check took 0.16 ms of
  the apiserver's main thread a beat.
- **At the cell's 500 beats/s**, every beat at 0.70 ms and 0.90 ms comes to 0.35 apiserver cores and 0.45 database
  cores; with reports moving, 0.40 and 0.65. The loadgen's runners get no commands, and a fleet's do: a command, and
  everything still settling after it, keeps a runner reconciling in full. Each percent of beats reconciled in full adds
  about 0.008 apiserver cores and 0.028 database cores at 500 beats/s.
