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
| `nats-auth-check.sh` | Check `src/link-gateway/nats.conf` on a throwaway nats-server with fresh keys: it refuses to start without both public keys, and admits each user to what it does alone. |
| `gen-hint-fixtures.mjs` | Regenerate `src/link-gateway/testdata/b1-hints.json` from the apiserver's hint encoder. |
| `gen-token-fixtures.mjs` | Regenerate `src/link-gateway/testdata/a3-tokens.json` from the apiserver's token code. |

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
| `ORBIT_LINK_STAGING_PROJECT` | `orbit-link-staging` | The Compose project, and the prefix of container and image names. |
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
