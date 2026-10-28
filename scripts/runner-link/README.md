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
| `staging-check-relay.sh` | The relay check, with the stack in MODE_LINK over two apiservers: what a person's request leaves in one apiserver process's memory (an Antigravity sign-in's pasted code, a Cursor key to check) reaches the runner over the link whichever process its calls land on, and is kept nowhere. With the gateway forwarding to the second apiserver alone (`ORBIT_LINK_STAGING_LINK_BACKENDS=apiserver-b`), every call of the runner lands on a process the web's requests never reach: NATS's authorization and logging, the relay drill (`link-gateway client -drill relay`, [client_relay.go](../../src/link-gateway/client_relay.go)), a second apiserver started after the code was pasted, and a holder paused while it is asked. With it forwarding to both (`all`), the relay drill three times, round robin. Then every code and key of the run is looked for in every container's log, the database and the drills' records. Each step's records go to `<state>/client/check-relay/<b-only or round-robin>/`. |
| `staging-name-check.sh` | Check that every staging script refuses a Compose project outside `orbit-link-*` before it does anything: a deployment's containers are `orbit-*`, so such a name could make a script stop, rebuild or write into one. `loadgen-watch.mjs`, which is given a state directory, refuses one of another project before it looks for the secret there. |
| `nats-auth-check.sh` | Check `src/link-gateway/nats.conf` on a throwaway nats-server with fresh keys: it refuses to start without both public keys, and admits each user to what it does alone. |
| `gen-hint-fixtures.mjs` | Regenerate `src/link-gateway/testdata/b1-hints.json` from the apiserver's hint encoder. |
| `gen-token-fixtures.mjs` | Regenerate `src/link-gateway/testdata/a3-tokens.json` from the apiserver's token code. |
| `gen-event-kind-fixtures.mjs` | Regenerate `src/runner-go/testdata/b8-link-events.json` from the apiserver's event rules: `isNoiseSystemEvent`, the live-only types and the coordinator-context boundary subtypes, which the runner's link event stream mirrors. |
| `loadgen-seed.sh` | The load test's fleet in the stack's database: `seed` (owners, runners, a workspace each, idle sessions), `arm` before each run (fresh running sessions, presence, the fleet file `<state>/loadgen/fleet.jsonl`), `disarm` after it, `remove`. See [Load test](#load-test). |
| `loadgen-run.sh` | One load test run: `src/link-gateway/cmd/loadgen` against the stack, with the stack's CPU, memory, metrics, database and logs collected beside it, then the report. |
| `loadgen-report.mjs` | A run's report: each criterion with the figure it rests on (`report.md`, `report.json`). `loadgen-report.test.mjs` tests it on synthetic runs: `node --test scripts/runner-link/`. |
| `loadgen-baseline.mjs` | What one heartbeat and one event batch cost, from a heartbeats-only run and a run with events, and with `--live` what one forwarded live delta costs: see [Per-operation baseline](#per-operation-baseline). |
| `loadgen-connects.mjs` | What one connect costs (a link token, the TLS handshake and Hello, the Welcome route, the first heartbeat reconciled in full), from a run's ramp: see [The cell's size](#the-cells-size). |
| `cell-spec.mjs` | A cell's size projected from what each operation costs: apiserver processes, database cores, gateway nodes, and what a gateway node's loss adds. Task O3's inputs are `cell-inputs.json`. See [The cell's size](#the-cells-size). |
| `loadgen-watch.mjs` | The load test's watchers: a session stream (SSE) on each of a run's first running sessions, as their owners, counting the live deltas that reach them and how late. A stream that ends opens again from the last stored event it received (`sinceSeq`), as the apps' do, and each session's stored events it missed are counted. `loadgen-run.sh --watch` starts it. See [The live stream](#the-live-stream). |
| `loadgen-streams.mjs` | Which apiserver held each session's streams over a run, from NATS's clients (`nats.jsonl`): the sessions each apiserver holds streams of, what NATS delivered to it and its main thread; sessions held by two at once; sessions that moved; and the watchers' gaps and resumes. `loadgen-run.sh` writes it as `streams.md` and `streams.json`. See [Several apiservers](#several-apiservers). |
| `gateway-routes-check.sh` | The web gateway's routes for several apiservers (`gateway/several-apiservers/`) on stand-ins that answer with their own name: which nginx loads which configuration (an nginx older than 1.27.3 loads `gateway/nginx.conf` and refuses the routes), one session's streams on one apiserver, the sessions spread over all of them, link tokens on all of them, the rest on the first, and an apiserver killed and started again. A Compose project of its own, removed at the end; no staging stack needed. |

```bash
scripts/runner-link/staging-up.sh
scripts/runner-link/staging-check.sh
scripts/runner-link/staging-check-switch.sh
ORBIT_LINK_STAGING_MODE=link ORBIT_LINK_STAGING_BACKENDS=2 scripts/runner-link/staging-up.sh --no-build
scripts/runner-link/staging-check-link.sh
ORBIT_LINK_STAGING_LINK_BACKENDS=apiserver-b scripts/runner-link/staging-up.sh --no-build
scripts/runner-link/staging-check-relay.sh
ORBIT_LINK_STAGING_LINK_BACKENDS=all scripts/runner-link/staging-up.sh --no-build
scripts/runner-link/staging-check-relay.sh
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
| `ORBIT_LINK_STAGING_BACKENDS` | `1` | How many apiservers the gateway forwards to, 1 to 16. `2` adds `apiserver-b`, the first one's whole definition on the same database, which `staging-check-link.sh` kills and starts again. A third and more are `apiserver-c` and on, each defined as `apiserver-b` is, in `<state>/backends.compose.yml`. Each starts once the first one is healthy, so migrations run once. |
| `ORBIT_LINK_STAGING_LINK_BACKENDS` | `all` | Which of those apiservers the link gateway forwards to: `all`, round robin, or names such as `apiserver-b`, comma-separated. The web's requests always reach `apiserver`, so with `apiserver-b` alone a runner's calls never land where a person's request left something (`staging-check-relay.sh`). Changing it recreates only the gateway. |
| `ORBIT_LINK_STAGING_LOADGEN` | `0` | `1` adds `staging.loadgen.compose.yml` for a load test: the gateway logs only Hello, Welcome, Drain and Close, admits any number of connections from one address (the per-address limit; the limit across all clients stays), and the gateway, apiservers and database are capped in memory. |
| `ORBIT_LINK_STAGING_DB_CPUS` | `0` | With `LOADGEN=1`, the database's CPU allocation (Compose `cpus`), the capacity a load test's database CPU is a share of. `0` is unlimited. |
| `ORBIT_LINK_STAGING_DB_MEM` | `4g` | With `LOADGEN=1`, the database's memory limit (Compose `mem_limit`): room for the cache a cell-scale run needs. |
| `ORBIT_LINK_STAGING_INGEST_RATE` | `off` | The link gateway's `LINK_DRILL_INGEST_RATE`: the durable events a second it forwards at most, so that a load test's runners send faster than the events are stored and the gateway's ingest queue fills to its bound ([Durable events and credit](../../src/link-gateway/README.md#durable-events-and-credit)). `off` forwards them as they come. Changing it recreates only the gateway. |
| `ORBIT_LINK_STAGING_SPREAD` | `0` | `1` adds `staging.spread.compose.yml`: the web gateway mounts `gateway/several-apiservers/`, as a deployment with several apiservers does ([docs/self-hosting.md](../../docs/self-hosting.md#several-apiservers)), and sends session streams, by session, and link tokens to every apiserver. `0` sends every request to the first apiserver, as a deployment with one does, which the relay check relies on. Changing it recreates only the web gateway. |
| `ORBIT_LINK_STAGING_MERGE_WINDOW` | `default` | The link gateway's `LINK_EVENT_MERGE_WINDOW`: how long an event batch waits for others, from any connection, to go with it in one merged call ([events_merge.go](../../src/link-gateway/events_merge.go)). `default` is the gateway's own (100 ms); `0` forwards every batch alone, as before merging, which is what a load test compares against. Changing it recreates only the gateway. |

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
- **A gateway release.** Run `docker kill -s TERM <project>-link-gateway`: the gateway drains and exits. Wait for it to
  exit (`docker wait <project>-link-gateway`), then start it again with `docker start <project>-link-gateway`; its
  restart policy will not. Run `staging-client.sh -until-drains 1` beforehand to see a runner drained and reconnected.
  Docker takes a `docker kill` or `docker compose kill`, with TERM or KILL, for a stop someone asked for, and
  `restart: unless-stopped` leaves such a container stopped until it is started (Docker 29.9.2 in task C2b, 29.8.2 on
  HPC). The policy starts a container again only when its process ended without Docker being asked, as an OOM kill ends
  it (started again in 0.39–0.57 s in C2b). To drill that, signal the gateway's process from the host as root (its image
  has no shell to do it from inside), with TERM, or KILL for a crash:
  `kill -s TERM "$(docker inspect -f '{{.State.Pid}}' <project>-link-gateway)"`.
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
  (`db.jsonl`), its statements (`pgss.json`, the 60 with the most time, after `pg_stat_statements_reset()` at the start;
  `pgss-totals.json`, every statement's calls) and sizes; each apiserver's node process every 5 s, its CPU time as a
  whole and its main thread's (`threads.jsonl`, since task O3); NATS's clients every 5 s, with what each was delivered
  and the sessions' live streams each apiserver subscribes to (`nats.jsonl`, read into `streams.md`); and each
  container's log over the run (`logs/`).
- **The report** takes every figure over the steady window. Errors are counted wherever a part can report them: the
  runners, the gateway's counters and its WARN/ERROR lines, the apiserver's ERROR lines and any 5xx of the web
  gateway, the database's ERROR/FATAL/PANIC lines and deadlocks, NATS's `[ERR]` lines. The database's CPU peak is the
  highest 10 s average of its container's CPU time, as a share of `ORBIT_LINK_STAGING_DB_CPUS` when set. A gateway
  that restarts in the window (an OOM kill, a drill) counts again from zero, its container's CPU time too: the report
  adds up what each process counted.
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
| `loadgen-run.sh` | `--watch <N>`: a session stream on each of the first N running sessions while the run lasts, which the loadgen's `-live-rate` sends live deltas to (see [the live stream](#the-live-stream)) | off |
| `loadgen-run.sh` | `LOADGEN_WATCH_STREAMS`: with `--watch`, how many streams each watched session has, as tabs and devices would; the watchers' deltas count each stream's | 1 |
| `staging-up.sh` | `ORBIT_LINK_STAGING_BACKENDS` (apiservers behind the gateway, up to 16), `ORBIT_LINK_STAGING_DB_CPUS` (the database's CPU allocation) | 1, unlimited |

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

### Merged event calls

Since task O2 the link gateway merges the event batches of all its connections into calls of up to 64 batches, and the
apiserver stores each call in one transaction (design §6.6, [events_merge.go](../../src/link-gateway/events_merge.go)).
The pair of runs above measures them, with the gateway's merge window off (`ORBIT_LINK_STAGING_MERGE_WINDOW=0`: every
batch alone, as before merging) and on (`default`, 100 ms), at the same event rates. 400 events/s over 1,000 running
sessions is the cell's target shape (0.4 events/s a session) at a fifth. On a host other load tests share:

- every run holds the host's load-test lock, arm included, and once it holds it, waits until no other stack's loadgen
  process (`pgrep -af 'cmd/loadgen|/loadgen -fleet'`) or `*-loadgen` container has run for 2 minutes;
- a heartbeats-only run goes before and after the event runs, and each event run is taken against the two around it;
- a run whose host swapped in more than 100 pages/s over its steady window is void and run again: swapping inflates
  CPU (a heartbeats-only run swapping in 1,100 pages/s read 12% more database CPU than its repeat at 2 pages/s). So does
  other work: with the host's other work at 9.4 cores instead of 5.2, an event run read 30 to 40% more per event.

```bash
lock() { flock /var/tmp/orbit-loadgen.lock sh -c "scripts/runner-link/loadgen-seed.sh arm && scripts/runner-link/loadgen-run.sh $*"; }
ORBIT_LINK_STAGING_MERGE_WINDOW=default scripts/runner-link/staging-up.sh --no-build     # 0: merging off
lock --name hb-1 -- -duration 2m -event-rate 0
lock --name ev400-on -- -duration 2m -event-rate 400
lock --name hb-2 -- -duration 2m -event-rate 0
node scripts/runner-link/loadgen-baseline.mjs <state>/loadgen/runs/hb-1 <state>/loadgen/runs/ev400-on --target-events 2000
node scripts/runner-link/loadgen-baseline.mjs <state>/loadgen/runs/hb-2 <state>/loadgen/runs/ev400-on --target-events 2000
```

Measured on 2026-10-26 with the apiserver and gateway of commit 03bee4272 (before O1's heartbeat), the containers not
pinned, the reports written with 99a58ea8e's steady-window means, one apiserver, heartbeats-only runs at 0.81 to 0.83
database cores (8.1 ms a beat), each event run against the heartbeats-only runs before and after it, the host's other
work at 5.2 cores:

| Per event | apiserver CPU | database CPU | SQL statements | commits | EventAck p99 at the runner |
| --- | --- | --- | --- | --- | --- |
| 150 events/s, merging off (1.22 events a batch) | 1.81–1.84 ms | 1.80–1.93 ms | 11.2 | 5.16 | 17–19 ms |
| 150 events/s, merging on | 0.60–0.61 ms | 0.87–1.03 ms | 2.5 | 0.06 | 133–137 ms |
| 400 events/s, merging on (1.55 events a batch) | 0.47 ms | 0.75–0.78 ms, mean 0.76 (4 runs) | 2.0 | 0.025 | 176–185 ms |

- At 400 events/s the gateway made 8.9 merged calls a second of 27 batches each. They are the ingest's only commits,
  against 674 a second unmerged at 150 events/s. Each call's transaction held its sessions p50 35 ms, p99 95 to 117 ms.
- With merging off, 400 events/s saturates the one apiserver (EventAck p99 42 s, 2026-10-25), so before and after are
  compared at 150 events/s. There the database's per-event figure is noisy: the events add 0.15 cores to 0.8.
- Linear in events, 2,000 events/s needs about 1.5 database cores and 0.95 apiserver cores for the ingest, and at most
  45 commits a second. That is an upper bound: at that rate one gateway's calls fill to their 64-batch cap, where at
  400 events/s they carry 27 (a 250 ms window gives 61 at 400 events/s, but the host swapped through that run).
- With O1's heartbeat merged, a heartbeats-only run costs the database 0.10 to 0.11 cores instead of 0.8, so the events
  stand out far better. A round on the merged branch with the containers on the P-cores could not be measured: while
  the production model used those cores (the host's other work at 9 to 12 cores), every run swapped past 100 pages/s.
  The one target-shape run of it read about 0.83 ms an event against its heartbeats-only runs.
- What an event still costs is the derivation's own work, 0.28 ms of execution at 400 events/s: the session's one
  UPDATE (non-HOT whenever the preview text changes, since `session_search_trgm` indexes it), the run_event insert,
  and the tool_call and approval writes. The rest, about 0.23 ms for each of its 2.0 statements, is parse, plan and
  protocol: the Prisma adapter sends every statement unnamed (task O1's finding).
- Statement counts come from `pgss-totals.json` since b47a66768. Before it, a merged run counted only the 60 statements
  with the most time, and the one insert's row-count variants pushed the approval writes off that list.

### The live stream

Design §9 counts about 10,000 live deltas a second per cell that reach someone watching. They load:

- the link gateway, which publishes each `LiveBatch` on NATS while somebody watches its session;
- NATS;
- the apiserver that holds the watcher's session stream, which relays the deltas into it;
- the web gateway in front of that stream.

Since task O3 a run can carry them:

- **`loadgen -live-rate <deltas/s>`.** The deltas a second across the fleet, shared by the running sessions somebody
  watches. They are gathered 50 ms a `LiveBatch`, as a runner gathers them
  ([cmd/loadgen](../../src/link-gateway/cmd/loadgen/README.md)).
- **`loadgen-run.sh --watch <N>`.** Before the loadgen starts, `loadgen-watch.mjs` opens a session stream
  (`GET /api/sessions/:id/events`, through the web gateway) on each of the fleet's first N running sessions, as their
  owners. The stack's apiserver counts each one as a watcher and tells the session's runner (`WatchersHint`).
  - The watchers sign their access tokens with the stack's own secret (`<state>/secrets/jwt_secret`) and take it from
    nowhere else.
  - They refuse a state directory that is not an `orbit-link-*` stack's (`staging-name-check.sh` checks this).
  - They record what reached them in `watch.jsonl` (every 10 s) and `watch.json`. The stream merges the deltas of each
    50 ms and gives a delta no time, so each delta's text starts with when it was produced. The watchers count and time
    the deltas from the text.
- **The report.** It gets a section on the live stream: what the loadgen sent, what the gateway did with it
  (`link_live_events_total`), and what the watchers received and how late.
- **The baseline.** `loadgen-baseline.mjs --live <run>` gives what one delta costs each part, against a run with the
  same events and no watchers.

```bash
lock() { flock /var/tmp/orbit-loadgen.lock sh -c "scripts/runner-link/loadgen-seed.sh arm && scripts/runner-link/loadgen-run.sh $*"; }
lock --name hb -- -duration 2m -event-rate 0
lock --name ev400 -- -duration 2m -event-rate 400
lock --name ev400-live --watch 100 -- -duration 2m -event-rate 400 -live-rate 2000
node scripts/runner-link/loadgen-baseline.mjs <state>/loadgen/runs/hb <state>/loadgen/runs/ev400 --live <state>/loadgen/runs/ev400-live
```

A run without `-live-rate` and `--watch` sends no `LiveBatch`, and its report is the same as before task O3, byte for
byte. The loadgen's test (`TestNoLiveBatchWithoutTheLiveRate`) shows the first. The second was checked by reporting
copies of O1's and O2's runs with both versions of `loadgen-report.mjs` and `loadgen-baseline.mjs`.

On HPC (task O3) the tool ran end to end in every attempt:
- 100 watchers took 1,992–1,997 of the 2,000 deltas a second, in LiveBatch frames of about two deltas;
- the gateway published every one (`link_live_events_total{result="published"}`);
- each delta reached its watcher p99 103–115 ms after it was produced.

No attempt ran clean, though: the host's swapping voided all of them. What a delta costs is therefore an
order-of-magnitude estimate, in [The cell's size](#the-cells-size).

### Several apiservers

A stack runs several apiservers in one of two ways:

- **`ORBIT_LINK_STAGING_BACKENDS=N`** (1 to 16). `apiserver-b`, then `apiserver-c` and on, each the first one's whole
  definition on the same database, starting once it is healthy. The link gateway is given every one.
- **A deployment's override file.** This is the `docker-compose.override.yml` that
  [docs/self-hosting.md](../../docs/self-hosting.md#several-apiservers) gives, with `apiserver-2` and on. Put it on top
  of the stack's Compose files beside a link to `docker-compose.yml`, plus staging's renaming of what it adds (the
  container's name and its image's tag). Task O3 brought its stack up so, with the file cut out of the document byte
  for byte, on Compose v5.5.1, and recorded what follows. Every process was healthy. From the web gateway's container,
  `apiserver` resolved to the first one alone. The link gateway was given both. The second applied no migration and
  started only once the first was healthy (Compose's own record of the start). In a short run (300 runners, 30 s),
  the two processes took the same share of the link calls: 0.082 and 0.079 cores.

Either way `loadgen-run.sh` samples every apiserver it finds running, `apiserver-*` beside the first, and the report and
the baseline count them all: "apiserver CPU" is the sum. Each process's main thread is what fills: a process carries
about a core of the load test's work, less what its other threads take. The figures below say how much.

The web gateway sends every session stream to the first apiserver unless the stack mounts its routes for several
apiservers (`ORBIT_LINK_STAGING_SPREAD=1`, task 34nb3xgCijTDzQJVXDVT7). Then each session's streams reach one apiserver,
by session, and so does the relay of its deltas. `streams.md` says, run by run, which apiserver held how many sessions'
streams, what NATS delivered to each, and each one's main thread: an apiserver that holds no stream of a session is
delivered none of its deltas.

```bash
ORBIT_LINK_STAGING_MODE=link ORBIT_LINK_STAGING_LOADGEN=1 ORBIT_LINK_STAGING_BACKENDS=4 ORBIT_LINK_STAGING_SPREAD=1 \
  scripts/runner-link/staging-up.sh
flock /var/tmp/orbit-loadgen.lock sh -c 'scripts/runner-link/loadgen-seed.sh arm &&
  scripts/runner-link/loadgen-run.sh --name spread --watch 400 -- -duration 6m -settle 2m -event-rate 200 -live-rate 8000 -volatile'
ORBIT_LINK_STAGING_SPREAD=0 scripts/runner-link/staging-up.sh --no-build     # every stream on the first again
```

On HPC (task 34nb3xgCijTDzQJVXDVT7, 2026-10-28) a stack of four apiservers, 1,000 runners, 500 running sessions and
200 durable events a second (`-volatile`), with its containers on the P-cores, ran five times, each with a 6-minute
steady window after 2 minutes' settle:

| Run | Web gateway | Watched sessions, deltas a second | Main thread of apiserver, -b, -c, -d (cores) | NATS messages delivered to each a second | Deltas received |
| --- | --- | --- | --- | --- | --- |
| spread-live | `SPREAD=1` | 400, 8,000 | 0.119, 0.123, 0.125, 0.113 | 997, 1,028, 1,094, 903 | 8,004.1 of the 8,004.9 sent, p99 113 ms |
| first-live | `SPREAD=0` | 400, 8,000 | 0.264, 0.040, 0.042, 0.042 | 4,020, 0, 0, 0 | 8,004.8 of 8,005.1, p99 3,502 ms: the host swapped for 15 s |
| first-nolive | `SPREAD=0` | none | 0.039, 0.038, 0.038, 0.038 | 0, 0, 0, 0 | — |
| first-throttled | `SPREAD=0`, the first apiserver capped at 0.2 CPU | 400, 8,000 | 0.179, 0.037, 0.038, 0.038 | 4,022, 0, 0, 0 | 8,007.2 of 8,008.2, p99 620 ms |
| spread-failover | `SPREAD=1`, `apiserver-d` killed for 2 minutes | 200 with 2 streams each, 4,000 | 0.105, 0.102, 0.099, 0.100 | 576, 662, 584, 179 | 7,992.9: each delta twice |

- **Spread**, the 400 sessions' streams were held 99, 102, 109 and 90 to an apiserver, none by two at once, and their
  main threads were within 6% of their mean. No error anywhere; no stream missed a stored event.
- **Together the four apiservers took 0.563 cores spread and 0.462 with every stream on the first**: a relayed delta
  cost about 0.044 ms spread over four processes and 0.031 ms in one, against 0.211 cores without the live stream.
- **An apiserver with no stream of a session is delivered none of its deltas**: with every stream on the first, NATS
  delivered the other three nothing. Each of them took 0.052–0.053 cores without the live stream, 0.056–0.059 while the
  first relayed 8,000 deltas a second, and 0.052–0.054 while the first, saturated, was throttled in 65% of its periods.
- **Killed**, `apiserver-d` held 48 sessions' 96 streams. They opened again on the other three, both streams of a
  session on the same one, each with its next delta 1.1–1.4 s after it ended, from the last stored event it had and
  missing none. The link gateway sent the 26 calls it had for `apiserver-d` to the others; the runners saw no error.

### The cell's size

Task O3 (2026-10-26) measured what each operation costs once tasks O1 and O2 were in, and projected the cell's size
from it. [docs/self-hosting.md](../../docs/self-hosting.md#the-cells-size) gives the result for operators.

**How it was measured.**

- **The stack.** The private stack `orbit-link-o3`, its apiserver and gateway built from 8a8c0abdc: the project tip with
  O1 and O2 merged. C1c, merged after, added only drill hooks, off unless `LINK_DRILL_LOSE_ANSWERS` is set.
- **The load.** One apiserver, and the per-operation baseline's fleet (3,000 runners, 1,000 running sessions), with the
  containers on HPC's P-cores (CPUs 0–7).
- **The rules.** Every run held the host's load-test lock. Before it ran, it waited for two minutes without another
  loadgen, and for a calm host: swap-in under 60 pages/s and 3 GB available. It waited up to 20 minutes, then gave the
  lock back. A run whose host swapped in more than 100 pages/s over its steady window is void.
- **The host.** On 2026-10-26 another project's Android regression (emulators and a Kotlin daemon) kept the host
  swapping for most of the day. Of 27 attempts, two were clean: `o3-hb-1` and `o3-ev400-1`. Their swap-in was 37 and
  90 pages/s, and the host's other work took 8.6 and 9.1 cores.

| Per operation | apiserver CPU ms | database CPU ms | link gateway CPU ms | SQL statements | commits |
| --- | --- | --- | --- | --- | --- |
| heartbeat, 10.3% of them reconciled in full | 0.86 | 1.03 | 0.31 | 3.37 | 3.38 |
| event, merged: 1.55 a batch, 27 batches a call | 0.445 | 0.58 | 0.045 | 1.94 | none of its own: 9.3 calls a second |
| connect: link token, TLS, Welcome, first beat reconciled in full | 4.7 | 8.6 | 1.05, and 0.16 at the web gateway | | |
| live delta forwarded to a watcher (an estimate: see below) | about 0.04 | 0.015–0.019, within the controls' spread | 0.015–0.017; NATS 0.012–0.013; web gateway 0.008 | | |

- **Where the rows come from.** `loadgen-baseline.mjs o3-hb-1 o3-ev400-1` gives the first two rows, and
  `loadgen-connects.mjs o3-hb-1` the third. A beat's statements and commits are the steady window's, renewals and the
  reaper's sweeps included.
- **The merged calls.** Each held its sessions p50 38 ms, p99 132 ms. EventAck p99 at the runner was 189 ms.
- **The main thread.** The apiserver's main thread took 0.91 of its process's CPU, sampled beside `o3-ev400-1` as
  `threads.jsonl` now records it.
- **WAL and storage.** Heartbeats alone write no WAL (`runner_presence` is UNLOGGED). Events wrote 2.22 MiB/s at 400 a
  second: about 5.7 KB each, with `wal_compression` on. Stored, an event takes about 1.5 KB: `run_event`'s row and
  indexes 1,070 bytes, its tool calls about 400.
- **Peaks.** The database's 10-second peak was 1.40 times its mean with events, and the apiserver's 1.17.

**What the projection takes** ([cell-inputs.json](cell-inputs.json), each cost with the runs it rests on;
`node scripts/runner-link/cell-spec.mjs scripts/runner-link/cell-inputs.json` prints every step of the arithmetic):

| Input | Value | From |
| --- | --- | --- |
| a beat, unflagged | 0.59 ms apiserver, 0.63 ms database | O1, pinned, reports moving (`-volatile`). Every attempt at this task's split (`--mark-every`, `-volatile`) was void. This task's clean mixed beat read 23% and 14% above O1's mixed beat, within this host's spread. |
| a beat reconciled in full | 2.39 ms, 6.37 ms | O1, the same |
| beats reconciled in full | 25% | An estimate. The five-minute period alone is 10%. Each command, cancellation or settings change marks its runner, which then reconciles in full at once and while the change settles. |
| a beat at the link gateway | 0.31 ms | this task |
| an event | 0.47 ms apiserver, 0.761 ms database | O2: unpinned, on mixed cores, with other work on the host. The coordinator's rule is to size with it. This task's 0.58 ms on the P-cores goes beside it. |
| an event at the link gateway | 0.045 ms | this task |
| a connect | 4.7, 8.6 and 1.05 ms | this task |
| a live delta | 0.042 ms apiserver, 0.017 link gateway, 0.013 NATS, 0.0085 web gateway, 0.019 database | An order-of-magnitude estimate, the coordinator's fallback. No attempt at the live pair was clean (below), so these are its void attempts: per part, the higher of the medians over all of them and the means of the three least swapped. |
| a process's own background work | 0.004 apiserver cores; 0.008 database cores | The apiserver figure is each of the two processes of the documented override, idle from 03:00 to 05:55Z on 2026-10-27 (the thread sampler). The database figure is O1's for the whole one-apiserver stack; per process it is open. |
| the main thread's share of a process | 0.91 | this task |
| gateway memory | 190 KB a connection | C2; this task saw 155–194 KB at 3,000 connections |

- **Rules.** The 10-second peak is 1.2 times the mean for the apiservers, and 1.5 times for the database (C2 at scale).
  A process's main thread may be at most 60% busy at the peak, and 75% with one process down. The database may use at
  most 60% of its cores (the project's criterion). The cell has at least 3 gateway nodes, each carrying at most 7,500
  connections with one node down (§9) and taking 200 handshakes a second.
- **Heartbeats, events and renewals** come to 1.48 apiserver cores, spread over every process. Four processes carry
  them: each main thread is 41% busy at the peak, 54% with one process down.
- **The first process** also takes the live relay, 0.42 cores at 10,000 deltas a second, which does not divide, and
  people's requests (not measured). Its main thread would be 87% busy at the peak, 100% with one of the others down. As
  session streams reach it now, the first apiserver does not carry a cell's full live load.
  - With the session streams spread over every process (`"sessionStreamsSpread": true` in the inputs), the same four
    processes carry everything at 52%, 70% with one down.
- **The database** takes 2.8 cores on average (heartbeats 1.03, events 1.52, the live relay's estimate 0.19, renewals
  0.04, the processes' own work), 4.2 at the 10-second peak: 8 cores at 53%.
- **The database's memory, 32 GB,** is mostly cache for the newest events.
  - What the runners' calls keep hot is small. On the test's 3,000 runners, the runners, their presence, workspaces and
    15,000 sessions took 55 MB (`o3-ev400-1`'s `sizes.txt`), so a cell's take a few hundred MB. Its connections are
    55: 11 for each of four apiservers and the wiki worker.
  - A stored event takes about 1.5 KB, so the peak stores about 10.8 GB of events an hour, and an average day
    (4,000 events a person) 2.5 GB an hour.
  - With `shared_buffers` at 8 GB, a quarter, and the OS's cache most of the rest, about 25 GB of cache holds the last
    two hours of events at the peak, and about ten hours' at the average rate. That is where each insert lands and what
    people open first. People's reads of older sessions are not measured here.
- **A gateway node's loss** sends its 5,000 runners to the other two nodes at 400 a second, for 12.5 s. Meanwhile it
  adds 1.9 apiserver and 3.45 database cores.
- **Each percent of beats reconciled in full** adds 0.009 apiserver and 0.029 database cores.

**The database's failover** must not lose an acknowledged commit (the coordinator, 2026-10-27, from C1a's failover
drill). A runner drops its copy of events once their EventAck arrives, so C1a held through a failover only because its
standby was synchronous. A cell's database needs a synchronous standby (`synchronous_commit = on`, the standby in
`synchronous_standby_names`, or a quorum of two), or an equivalent that keeps every acknowledged commit.

**Before production with more than one apiserver** (the coordinator filed these tasks on 2026-10-26):

- **(a) The singleton jobs on one process** (task 34mNe88onMT6k23kHz7ce): the reaper, with a heartbeat-write-failure
  hold every process sees; the task sweep; auto-retry.
- **(b) The runner-relayed sign-in state carried across processes** over NATS, without persistence (task
  34mNe8DOyUq2wlk81EGlZ): Antigravity's pasted code and the Cursor key check.
- **(c) The default upgrade recreating the replicas** (task 34mNe8H0YZ4Qkwd0t6jPJ). Until then, the manual step in
  docs/self-hosting.md applies.

**Open items** of the spec:

- **The live relay, measured cleanly.**
  - On HPC, 24 attempts at the live pair on the 3,000-runner fleet (2026-10-26, 13:25–23:13Z) and 12 on a 600-runner
    fleet (until the coordinator's deadline, 06:00Z on 2026-10-27) were all void. The host swapped in 132–17,944 pages/s.
  - C2b measures it on the dedicated machine, with `--watch 500` and `-live-rate 10000` at the cell's scale.
- **The design question: do the session streams need spreading over every apiserver?** It would take a web-gateway
  route sending `GET /api/sessions/:id/events` to every apiserver (proposal only; not in the deployment). Or the first
  apiserver leaves `LINK_INTERNAL_API_URLS` once (b) is done.
- **What else the first apiserver carries.** People's own requests, the web, the apps and their streams, are not
  measured here.
- **The beat's split by kind, re-measured on a quiet host** (C2b). The share reconciled in full in production is the
  25% estimate.
- **What each apiserver's own background work costs the database.** The jobs that run in every process repeat their
  reads N times (the reaper's sweep, the task sweep), on a production database larger than staging's.

**If the database runs hot.** The Prisma adapter sends every statement unnamed except those marked `PREPARED_STATEMENT`
(task O1), and an unnamed statement costs about 0.21 ms of database CPU in parse and plan each time it runs.

- **First choice: name the merged event call's five fixed statements.** O2 estimated 0.02–0.05 ms an event, or 0.04 to
  0.1 cores at 2,000 events a second.
- **Next: give the statements that vary with the batch a fixed text first, then name them.** These are the event insert
  and the session and tool-call writes. An event's 1.94 statements cost up to about 0.4 ms of parse and plan, of its
  0.58–0.76 ms.
- **Then the full reconcile.** Its 23 statements cost up to about 5 ms of parse and plan, of its 6.37.

These are upper bounds, from 0.21 ms a statement. None of them is implemented.

### Re-testing at cell scale (task C2b)

**The machine.** One machine of its own, for the whole stack and the loadgen, with one kind of core. On it, the
containers need no pinning.

- **32 cores.** At the cell's peak the stack takes about 18:
  - the database's allocation, 8;
  - four apiservers, about 1 core each;
  - one link gateway carrying all 15,000 connections, 1 to 2 cores;
  - the loadgen and the watchers, about 1 core each;
  - NATS and nginx, less than 1.

  The rest is room for the host, the samplers, and a gateway release's reconnects.
- **64 GB of memory.** The database 16 GB, four apiservers up to 3 GB each, the gateway about 3 GB (190 KB a connection),
  the loadgen about 1.5 GB.
- **200 GB of SSD.** An hour at 2,000 events a second stores about 11 GB of tables, and writes about 40 GB of WAL into
  the stack's archive before it is compressed.

**The stack**, in the cell's shape, except that one gateway node carries every connection:

```bash
export ORBIT_LINK_STAGING_PROJECT=orbit-link-c2b ORBIT_LINK_STAGING_DIR=/var/tmp/orbit-link-c2b
export ORBIT_LINK_STAGING_MODE=link ORBIT_LINK_STAGING_LOADGEN=1 ORBIT_LINK_STAGING_BACKENDS=4 \
  ORBIT_LINK_STAGING_DB_CPUS=8 ORBIT_LINK_STAGING_DB_MEM=16g
scripts/runner-link/staging-up.sh
docker exec orbit-link-c2b-postgres psql -U orbit -d orbit -c "ALTER SYSTEM SET shared_buffers = '4GB'" \
  -c "ALTER SYSTEM SET max_wal_size = '8GB'" -c "ALTER SYSTEM SET max_connections = 200"
docker restart orbit-link-c2b-postgres && scripts/runner-link/staging-up.sh --no-build
scripts/runner-link/loadgen-seed.sh seed                 # 10,000 owners, 15,000 runners, 40,000 open sessions
scripts/runner-link/loadgen-seed.sh arm && scripts/runner-link/loadgen-run.sh --name full-1h -- -duration 1h -event-rate 2000 -volatile
scripts/runner-link/loadgen-seed.sh arm && scripts/runner-link/loadgen-run.sh --name live-1h --watch 500 -- \
  -duration 1h -event-rate 2000 -volatile -live-rate 10000
```

- **`-volatile`.** The reports that move in production move at their production rates (the coordinator's ruling of
  2026-10-25), so beats reconcile in full about as often as they would there.
- **The database's CPU peak** in the report is a share of `ORBIT_LINK_STAGING_DB_CPUS`: the 8 cores the spec gives the
  database.
- **What the report holds.** Each apiserver's main thread is in the report (`threads.jsonl`): the spec has each at most
  60% busy at the peak. `loadgen-connects.mjs` gives the ramp's cost per connect beside the gateway-release
  measurement.
- **The second run is not the pass/fail run.** It carries the cell's live load (500 watched sessions, 20 deltas a second
  each), and is reported apart from the 1-hour run that decides the criterion.
