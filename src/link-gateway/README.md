# Runner link gateway, version 0

The link gateway is the WebSocket endpoint each runner keeps one connection to
([docs/runner-link-design.md](../../docs/runner-link-design.md) §4, §5.4, §6.1). Runners reach it directly, on a port of
its own, never through Cloudflare or the web gateway (decision D1). Frames are the protobuf messages of
[contracts/runner-link/v1](../../contracts/runner-link/v1/runner_link.proto); `linkpb/` is their generated Go.

Version 0 is the connection layer for the shadow period (§11.2). It authenticates connections, greets runners,
keeps connections alive, records heartbeats, drains connections, and compares what runners mirror to it. It also
subscribes to the [hints](#hints) the apiserver publishes on NATS for the runners it holds. **It forwards nothing to the
control plane**. Every Welcome and HeartbeatAck says `MODE_HTTP`, so runners keep doing their work over HTTPS. Forwarding
requests and events is task B4.

It is one static binary with these subcommands:

| Command | What it does |
| --- | --- |
| `link-gateway serve` | Serve runners (the default). Configured by the `LINK_*` variables below. |
| `link-gateway dump` | Decode frames: base64 or hex lines (the gateway logs an undecodable frame as `raw=<base64>`), or a length-delimited capture. |
| `link-gateway client` | A test runner for staging and drills. See [Test client](#test-client). |
| `link-gateway health` | The container health check: exits 0 when `/healthz` on the metrics port answers 200. |
| `link-gateway version` | Print the commit the binary was built from. |

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `LINK_PUBLIC_KEYS` | required | The public half of the apiserver's `RUNNER_LINK_SIGNING_KEY`, as PEM or base64 of PEM. While the signing key is being replaced, give both public keys, as two comma-separated base64 values. A private key is refused: the gateway never holds one. |
| `LINK_GATEWAY_TOKEN` | required | The apiserver's `RUNNER_LINK_GATEWAY_TOKEN`. The gateway presents it to read revoked credentials. |
| `LINK_API_URL` | required | The apiserver's base address, for example `http://apiserver:3000`. |
| `LINK_CELL_ID` | `cell-1` | The cell this gateway serves. A token for another cell is refused. |
| `LINK_LISTEN_ADDR` | `:8443` | The runners' port. |
| `LINK_METRICS_ADDR` | `:9464` | `/metrics` and `/healthz`, plain HTTP. Never expose it publicly. |
| `LINK_TLS_MODE` | `acme` when `LINK_ACME_DOMAINS` is set, else `files` | `files`, `acme`, or `off` (plain `ws://`, for development only). |
| `LINK_TLS_CERT_FILE`, `LINK_TLS_KEY_FILE` | required in `files` mode | The certificate chain and its key, PEM. When either file changes, they are read again every `LINK_TLS_RELOAD_INTERVAL` (30s) and at once on `SIGHUP`. A renewal or rotation needs no restart. A pair that does not load leaves the certificate in use alone. |
| `LINK_ACME_DOMAINS` | — | Comma-separated names to obtain certificates for over ACME (TLS-ALPN-01). The ACME server must reach this gateway on port 443. |
| `LINK_ACME_EMAIL` | — | The ACME account's contact address. |
| `LINK_ACME_DIRECTORY_URL` | Let's Encrypt | Another ACME directory, for example a staging CA. |
| `LINK_ACME_CACHE_DIR` | required in `acme` mode | Where the account key and certificates are kept across restarts. |
| `LINK_ACME_CA_FILE` | — | An extra PEM root to trust for the ACME directory's own TLS, for example a test CA. |
| `LINK_REVOCATION_INTERVAL` | `30s` | How often the revocation list is read. |
| `LINK_NATS_URL` | — | The NATS server the apiserver publishes [hints](#hints) to, as a `nats://` address. Unset, the gateway relays no hints and says so when it starts. |
| `LINK_HELLO_TIMEOUT` | `10s` | How long after the upgrade a Hello may take. |
| `LINK_HANDSHAKE_TIMEOUT` | `5s` | How long the TLS handshake and the upgrade request may take, together. |
| `LINK_IP_RATE`, `LINK_IP_BURST` | `1`, `20` | New connections per second per client address, and the burst allowed. |
| `LINK_HANDSHAKE_RATE`, `LINK_HANDSHAKE_BURST` | `200`, `400` | New connections per second across all clients, and the burst allowed. |
| `LINK_DRAIN_BATCH`, `LINK_DRAIN_BATCH_INTERVAL` | `250`, `1s` | How many connections are sent Drain at a time, and how far apart. |
| `LINK_DRAIN_RECONNECT_MIN`, `LINK_DRAIN_RECONNECT_MAX` | `1s`, `30s` | The range the per-connection reconnect delay is drawn from, uniformly. |
| `LINK_DRAIN_GRACE` | `15s` | How long past its delay a drained connection may stay open before the gateway closes it. |
| `LINK_DRAIN_TIMEOUT` | `80s` | When the drain gives up and closes what is left. Keep Compose's `stop_grace_period` (90s) above it. |
| `LINK_FRAME_LOG` | `lifecycle` | `lifecycle` logs Hello, Welcome, Drain and Close. `all` logs a summary of every frame, in and out. `off` logs no frames. |

These values are fixed by the design: ping every 20s, disconnect after 60s without a pong, heartbeat every 30s, at most
two connections per runner, frames of at most 256 KiB.

## Handshake

The gateway checks each upgrade request in this order. Nothing is upgraded until every check has passed. A refusal is
an HTTP response with `Connection: close`. Its JSON body has a `code`, named after the CloseCode the same refusal would
carry after the upgrade, a `message` and, where it applies, `reason` and `retryAfterMs`. A `Retry-After` header carries
the same delay.

| Check | Refusal |
| --- | --- |
| The gateway is draining. | `503 DRAINING`, `Retry-After: 5`. |
| The request is a WebSocket upgrade. | `426 WEBSOCKET_REQUIRED`. |
| The handshake rate across all clients. | `429 RATE_LIMITED`, with a Retry-After. |
| The new-connection rate of the client address. | `429 RATE_LIMITED`, with a Retry-After. |
| The connection token in `Authorization: Bearer`. | `401 UNAUTHENTICATED`, with a `reason`. |
| The runner's connection slots. | `429 TOO_MANY_CONNECTIONS`, `Retry-After: 30`. |

The token is checked without asking any database:

- The apiserver's four checks, in its order and with its reasons, apply first: `MALFORMED`, `SIGNATURE`, `AUDIENCE`
  (`orbit-runner-link`) and `EXPIRED`. `testdata/a3-tokens.json` holds tokens signed by
  `src/apiserver/src/runner-api/runner-link-token.ts` and that module's verdict on each.
  `TestVerifierAgreesWithTheApiserver` holds the Go verifier to every verdict. `kid` picks the key when it names one
  the gateway holds; otherwise every key is tried.
- Then the gateway's own checks: `CLAIMS` (runnerId, ownerId, cellId, linkUrl, leaseOwner, credential and jti are all
  present), `CELL` (the token is for `LINK_CELL_ID`) and `REVOKED` (its credential is on the deny list). A missing
  token is `MISSING`.

The connection's slots are reserved before the upgrade and given back if the handshake fails. A runner has at most two
connections. A process (the token's leaseOwner) has one: its new connection supersedes its old one, which is closed
with `CLOSE_CODE_SUPERSEDED` once the new one is welcomed. That leaves room for make-before-break, and for the
moment two processes of one runner overlap across a self-update.

A connection that completes neither TLS nor its upgrade request within `LINK_HANDSHAKE_TIMEOUT` is cut. After the
upgrade, the first frame must be Hello, within `LINK_HELLO_TIMEOUT`, and these Hello problems end the connection:

| Problem | Close code |
| --- | --- |
| No Hello in time, a frame that does not decode, or a first frame other than Hello | `CLOSE_CODE_PROTOCOL_ERROR` |
| `process_id` is not the token's leaseOwner (compared case-insensitively) | `CLOSE_CODE_UNAUTHENTICATED` |
| The version range does not include 1 | `CLOSE_CODE_UPGRADE_REQUIRED` |

Welcome carries:

- protocol version 1 and `MODE_HTTP`;
- `heartbeat_interval_ms` 30000, `max_frame_bytes` 262144, and a fixed credit of 10,000 events or 64 MiB;
- an empty `HintState` and a `connection_id` (`c-` followed by 16 hex digits).

Version 0 knows nothing about sessions, so Welcome lists no `SessionState`. A runner in `MODE_HTTP` ignores session
states anyway.

## Connections

- **Heartbeats** are counted and logged, and answered with a `HeartbeatAck` saying `MODE_HTTP`. It reconciles nothing:
  `reconcile_json` is empty and `want_facts` names nothing.
- **Pings.** The gateway pings every 20s and measures the round trip (`link_rtt_seconds`). A ping unanswered for 60s
  closes the connection. Whether the runner process is alive is judged by its heartbeats (§6.1), which version 0
  only records.
- **Token lifetime.** Version 0 cannot renew a token inside the connection (`TokenRefresh`). When the token expires,
  the connection is closed with `CLOSE_CODE_UNAUTHENTICATED`. A runner fetches a fresh token and opens its next
  connection before that, make-before-break. The test client does this five minutes ahead.
- **Revocations.** `GET {LINK_API_URL}/api/runner/link-token/revocations`, with the gateway token, is read once before
  serving and then every `LINK_REVOCATION_INTERVAL`. Each list read replaces the deny list, and the open connections
  whose credential is on it are closed with `CLOSE_CODE_UNAUTHENTICATED`. When a read fails, the list in hand stays and
  the failure is counted. If the first read fails, the gateway serves anyway. Every token expires within the hour, which
  bounds a revocation the gateway has not heard of yet.
- **Slow readers.** Control frames are queued ahead of everything else. A full queue closes the connection with
  `CLOSE_CODE_SLOW_CONSUMER`, so memory never grows for a runner that does not read.
- **Size.** A WebSocket message over 256 KiB ends the connection (status 1009). Larger frames travel as `Chunk`s and
  are joined, up to 8 MiB a frame, four frames in pieces and 16 MiB per connection, and 256 MiB across the process.

### Drain

On `SIGTERM` (`docker compose stop`, `up --force-recreate`, or a deploy), the gateway drains before it exits:

1. From then on, upgrades are refused with `503 DRAINING`, so runners come back to the next process.
2. Open connections are shuffled and sent `Drain{reconnect_after_ms}` in batches of `LINK_DRAIN_BATCH`, every
   `LINK_DRAIN_BATCH_INTERVAL`. Each connection's delay is drawn uniformly from `LINK_DRAIN_RECONNECT_MIN` to
   `LINK_DRAIN_RECONNECT_MAX`, so the runners of a draining node do not all come back at once.
3. A drained connection keeps working until the runner has opened its next one and closed it. If it is still open
   `LINK_DRAIN_GRACE` after its delay, the gateway closes it.
4. The process exits once every connection has closed, or at `LINK_DRAIN_TIMEOUT`, when it closes the rest. A second
   `SIGTERM` exits at once.

On a single-node deployment, a runner whose delay ends while the old process is still draining is refused with `503`
and retries with backoff until the new process is up.

### Hints

A hint tells a runner that something is waiting for it, so that it asks now instead of at its next heartbeat (§5.5).
The apiserver publishes each one on NATS, after the commit it announces, on the subject of the one runner it concerns:
`rnr.<runnerId>`, the runner's UUID as the link token names it. The message is a link `Frame` with only `hint` set, in
protobuf's canonical JSON:

| Hint | Message | Published when |
| --- | --- | --- |
| `claim` | `{"hint":{"claim":{}}}` | A session is queued for the runner, or a slot it waits for frees up. |
| `inbox` | `{"hint":{"inbox":{"sessionId":"<uuid>"}}}` | A message is waiting in a session assigned to the runner. |
| `commands` | `{"hint":{"commands":{}}}` | Something its heartbeat delivers is waiting: a sign-in, a merge, an update. |

`testdata/b1-hints.json` holds those messages as the apiserver's encoder writes them
(`src/apiserver/src/realtime/runner-hints.ts`), and `TestHintFixturesDecodeStrictly` decodes each one with unknown fields
refused, so a field renamed in the proto fails a test instead of dropping hints.

The gateway subscribes to `rnr.<runnerId>` from the Welcome of a runner's first connection to the end of its last one,
and to no other runner's subject. It writes each hint as a `Hint` frame to every connection of that runner in
`MODE_LINK`, behind control frames and never ahead of Welcome. In `MODE_HTTP`, which every connection is in until the
gateway forwards (B4), a hint is counted and not sent: a runner working over HTTPS is woken by its long polls. With
`LINK_FRAME_LOG=all`, each hint that is not sent is logged with its runner, kind and result.

A hint is sent at most once (§5.2). One that finds no connection of its runner, a full queue, or no NATS is counted and
dropped, never waited for, and a full queue does not close the connection the way a full queue of other frames does. The
runner's next heartbeat carries the same news. The gateway serves whether or not NATS is up. Its client dials until NATS
answers and subscribes again after every reconnect. A message on a hint subject that is not a hint is counted as
`malformed` and logged at most once a minute. A field or hint kind the gateway does not know is ignored, as the protocol
asks.

### Frames a runner may send in version 0

| Body | What the gateway does |
| --- | --- |
| `Hello` | The first frame only. A second Hello is a protocol error. |
| `Heartbeat` | Recorded and answered with `HeartbeatAck` (`MODE_HTTP`). In `MODE_HTTP` it is also the typed half of a [mirror](#shadow-comparison). |
| `EventBatch` | In `MODE_HTTP`, the typed half of a mirror. Never stored and never acknowledged: an `EventAck` would say the events are stored (§5.8). |
| `Rpc` | Answered with exactly one `RpcResult`, `Failure{code: LINK_MODE_HTTP, retryable: false}`. A `shadow:` request is the raw half of a mirror. |
| `Chunk` | Joined, then handled as the frame it makes up. |
| `LiveBatch`, `TurnPrefixResponse` | Counted and dropped. Version 0 publishes no live stream. |
| Anything else | Ignored, as the protocol asks of a body the receiver does not take. |

### Forwarding invariants

Version 0 has no forwarder. B4 adds one behind `mayForward` (`conn.go`), the only check an Rpc passes before it may
reach a backend. Whatever B4 adds, two things hold, and `TestRpcForwardingInvariants` pins both:

1. On a connection in `MODE_HTTP`, no Rpc is forwarded.
2. An Rpc whose `request_id` starts with `shadow:` is never forwarded, in any mode.

## Shadow comparison

During the shadow period, runners work over HTTPS. Each one also mirrors to the gateway the heartbeats and event
batches that the HTTP side accepted. The gateway compares each mirror with what the HTTP side received, counts the
outcome, and writes it nowhere: no database row, no acknowledgement, no forwarding. The pass criterion is zero
differences (§11.2).

This section is the contract for the runner's mirror (task A5). A runner that follows it produces no difference that
is not real, and the comparison is built so that the freedom an encoder has cannot show up as one.

### What the runner sends

For each `POST /runner/heartbeat` and each `POST /runner/sessions/<id>/events` that the server answers with 2xx, the
runner sends two frames on its link connection:

1. **The typed half**: the frame the link carries after the cutover, built from the same values.
   - For a heartbeat, a `Heartbeat`:
     - `process_id` is the body's `leaseOwner`.
     - `idle_capacity` is `idleCapacity`, `draining` is `draining`, and `session_ids` is `supervisedSessionIds`.
     - Every other member of the body becomes one `Fact`. Its `kind` is the member's name, its `json` is the member's
       JSON value, and its `sha256` is the lowercase hex SHA-256 of exactly those `json` bytes.
     - `status` and `version` are not carried. The link has no status, and the version travels in Hello.
     - A mirror sends every Fact whole, `json` included, every time. A Fact without `json` counts as a difference
       (`fact_json_missing`).
   - For an event batch, an `EventBatch`:
     - `session_id` is the session in the path.
     - Its events are the body's events, in order, one for one.
     - Each event's `seq`, `type` and `turn_id` are the event's `seq`, `type` and `turnId`, and `ts_unix_ms` is `ts` in
       Unix milliseconds.
     - `payload_json` is the event's `payload`.
2. **The raw half**: an `Rpc` with `request_id` `shadow:<connection_id>:<id>`. Here `connection_id` is the one Welcome
   gave and `id` is the typed frame's `Frame.id`. Its body is a `TunnelRequest` holding the HTTP request itself: the
   method, the path as the runner requested it under `/api` (for example `/runner/heartbeat`), and the request body,
   byte for byte as it was sent.

A half larger than 256 KiB goes in `Chunk`s like any other frame. The two halves may arrive in either order.

In `MODE_HTTP`, every `Heartbeat` and `EventBatch` a runner sends is the typed half of a mirror. A runner sends no other
`Heartbeat` or `EventBatch`, so the gateway can count a typed half whose raw half never comes. A runner's first
Heartbeat on a connection is therefore the mirror of its next HTTP heartbeat, within one heartbeat interval.

### What the runner must never do

- **Never mirror before the 2xx.** The mirror is sent after the HTTP side has answered 2xx, from a goroutine of its
  own. A request that failed is not mirrored: the HTTP side did not receive it.
- **Never let the mirror slow the work.** Mirrors go through a bounded queue. When the queue is full, the mirror is
  dropped and counted. The work path never waits on the link, its queue or its errors.
- **Never alter what was sent.** The raw half is the body that was sent, not a re-encoding of it.
- **Report coverage.** The runner reports how many mirrors it sent and how many it dropped (A5, item 4). The gateway
  cannot see a mirror that never reached it.

### How the gateway compares

The gateway pairs the halves by `request_id`. It compares the raw half's body as JSON with the typed half, and counts
the outcome in `link_shadow_pairs_total{kind, result}`. It also adds one to `link_shadow_mismatches_total{kind, field}`
for each field that differed. A difference is logged with the frame id, the path and the fields. The log names a
fact's or a payload's size and digest, never its content.

Values are compared as JSON values, never as bytes:

- Whitespace and member order do not count.
- Escapes do not count: Go's `encoding/json` writes `<`, `>` and `&` as Unicode escapes, and a string may hold `é`
  either raw or escaped.
- How a number is spelled does not count: `1`, `1.0` and `1e0` are equal. Whole numbers are compared exactly;
  others as float64.
- A `Fact.sha256` is checked against its own `json` bytes, the only bytes the digest can be of. It is never checked
  against a re-encoding.

Heartbeat, against the `POST /runner/heartbeat` body:

| Field (metric label) | Rule |
| --- | --- |
| `route` | The method is `POST` and the path is `/runner/heartbeat`. |
| `body` | The body is a JSON object. |
| `leaseOwner` | `process_id` equals the body's `leaseOwner`, case-insensitively, as the server lowercases it. |
| `idleCapacity`, `draining` | Equal to the body's. An absent member reads as zero or false. |
| `supervisedSessionIds` | The same ids as `session_ids`, compared as sets: the server reads them as a set. |
| `version` | When present, equal to Hello's `runner_version`. |
| `status` | When present, `ONLINE`. |
| `fact_missing`, `fact_extra`, `fact_duplicate` | Exactly one Fact for every other member, and none besides. |
| `fact_json_missing`, `fact_digest`, `fact_value` | Each Fact carries `json`, `sha256` is the digest of that `json`, and `json` equals the member as a JSON value. |

`supported_providers` comes from a request header rather than the body, so it is not compared.

Event batch, against the `POST /runner/sessions/<id>/events` body:

| Field (metric label) | Rule |
| --- | --- |
| `route` | The method is `POST` and the path is `/runner/sessions/<session_id>/events`. |
| `body`, `batch_member` | The body is an object holding only `leaseOwner` and `events`. |
| `leaseOwner` | When present and not empty, equal to Hello's `process_id`. |
| `events_length` | As many events as the body has. |
| `seq`, `type`, `turnId` | Equal, event by event. |
| `ts` | `ts`, read as RFC 3339, is `ts_unix_ms` to the millisecond. |
| `payload` | `payload_json` equals `payload` as a JSON value. |
| `event_member` | No event member other than `seq`, `type`, `ts`, `turnId` and `payload`: the link would drop it. |

A half that never meets its other half is counted in `link_shadow_unpaired_total{side, reason}`:

| Reason | Meaning |
| --- | --- |
| `expired` | It waited 60s. |
| `evicted` | A bound pushed it out: 64 halves of a side, or 4 MiB, per connection, or 256 MiB across the process. |
| `closed` | It was still waiting when its connection closed. |
| `wrong_connection` | Its `request_id` names another connection. |
| `malformed` | Its `request_id` does not read as `shadow:<connection_id>:<id>`, or it carries no TunnelRequest. |

The two halves of a mirror are sent back to back, so a half waits milliseconds, and these bounds only stop a runner
that never sends the other half from holding memory. `link_shadow_pending_bytes` shows what is held.

**Zero differences** for a period means three things: `link_shadow_pairs_total{result="mismatch"}` did not increase,
`link_shadow_unpaired_total` did not increase, and the runners' own drop counts were zero or accounted for.

### What it does not establish

- That a runner mirrored everything it sent: only the runner's own counts can say that.
- That the HTTP side stored what it received. The comparison is with the request the server accepted, not with the
  database, so server-side handling is outside it.
- `supported_providers`, which travels in a request header.

## Metrics

Every metric is served at `/metrics` on `LINK_METRICS_ADDR`, in Prometheus text format.

| Metric | Type | Labels |
| --- | --- | --- |
| `link_connections` | gauge | — |
| `link_handshakes_total` | counter | `result`: ok, unauthenticated, rate_limited, too_many_connections, draining, not_websocket, hello_timeout, protocol_error, upgrade_required, upgrade_failed |
| `link_handshake_duration_seconds` | histogram | — (from the upgrade request to Welcome written) |
| `link_token_refusals_total` | counter | `reason`: MISSING, MALFORMED, SIGNATURE, AUDIENCE, EXPIRED, CLAIMS, CELL, REVOKED |
| `link_disconnects_total` | counter | `reason`: client_closed, connection_lost, superseded, ping_timeout, token_expired, revoked, protocol_error, slow_consumer, drained, shutdown, internal_error |
| `link_rtt_seconds` | histogram | — (WebSocket ping round trips) |
| `link_frames_received_total`, `link_frames_sent_total` | counter | `type`: the frame body |
| `link_frame_decode_errors_total` | counter | — |
| `link_heartbeats_total` | counter | — |
| `link_draining`, `link_drains_sent_total` | gauge, counter | — |
| `link_revocations`, `link_revocation_fetches_total`, `link_revocation_last_success_timestamp_seconds` | gauge, counter, gauge | `result`: ok, error, unauthorized, not_configured |
| `link_tls_certificate_not_after_timestamp_seconds`, `link_tls_reloads_total`, `link_tls_handshake_errors_total` | gauge, counter, counter | `result`: ok, error |
| `link_rpcs_total` | counter | `result`: shadow, not_forwarded, forwarded |
| `link_shadow_pairs_total`, `link_shadow_mismatches_total`, `link_shadow_unpaired_total`, `link_shadow_events_compared_total`, `link_shadow_pending_bytes` | | see [Shadow comparison](#shadow-comparison) |
| `link_hints_total` | counter | `kind`: inbox, claim, commands, approval, watchers, unknown; `result`: sent, mode_http, no_connection, dropped, malformed |
| `link_hints_slow_total` | counter | — (hints NATS dropped because the relay was not keeping up) |
| `link_hint_subscriptions` | gauge | — (runners whose hint subject is subscribed to) |
| `link_nats_connected`, `link_nats_reconnects_total` | gauge, counter | — |
| `link_gateway_build_info`, `link_gateway_start_time_seconds` | gauge | `version` |

The handshake success rate is `link_handshakes_total{result="ok"}` over the sum of all results.

## Logs and dump

Logs are `key=value` lines on standard error. Each connection's lines carry `conn` (its Welcome `connection_id`),
`runner`, `process` and `remote`. With `LINK_FRAME_LOG=all`, every frame is summarized in both directions:

```text
level=INFO msg=frame conn=c-0c04a123cd3b9a34 runner=… dir=in frame="#5 heartbeat process=… draining=false idle=2 sessions=1 facts=[commands:31a56db6+76B reposRoot:0c692eaf+15B]"
```

A frame that does not decode is logged as `raw=<base64>`, its first 4 KiB. To decode frames:

```bash
link-gateway dump frames.txt                 # base64 or hex, one frame per line; a log line's raw= is found
link-gateway dump -json frames.txt           # each frame as protojson
link-gateway dump capture.bin                # a length-delimited capture, such as `client -capture` writes
docker compose logs link-gateway | link-gateway dump
```

`dump` joins the pieces of a chunked frame and prints the frame they make up. It exits 1 if anything did not decode.

## Test client

`link-gateway client` behaves like a runner:

1. It trades a runner token for a link token (`POST /api/runner/link-token`), connects, says Hello and heartbeats.
2. With `-http`, it sends each heartbeat to the server over HTTPS first and mirrors only the beats the server
   accepted.
3. With `-events N`, it also mirrors a synthetic event batch of N events. The payloads hold `<`, `>`, `&`, non-ASCII
   text and whitespace, and the typed half is written by a different encoder from the raw half.
4. It follows Drain make-before-break, and reconnects with exponential backoff and full jitter, from 1s to 60s,
   never sooner than a refusal's Retry-After or a Close's `retry_after_ms`.
5. When it stops, it prints a JSON summary of connects, heartbeats, mirrors, drains and reconnects.

```bash
link-gateway client -api http://127.0.0.1:18086 -runner-token "$TOKEN" -ca ca.pem -http -events 3 \
  -until-drains 1 -summary summary.json
```

`-corrupt-every N` alters the typed half of every Nth mirror, to check that the gateway counts the difference.

The staging stack's scripts ([scripts/runner-link](../../scripts/runner-link/README.md)) build and run all of this.

## Development

```bash
cd src/link-gateway && go test ./...                  # CI runs it with -race
npm run generate:runner-link -w @orbit/shared         # after a change to contracts/runner-link/v1 (writes linkpb/)
npx tsc -p src/apiserver/tsconfig.json && node scripts/runner-link/gen-token-fixtures.mjs   # testdata/a3-tokens.json
npx tsc -p src/apiserver/tsconfig.json && node scripts/runner-link/gen-hint-fixtures.mjs    # testdata/b1-hints.json
docker run -d --rm -p 127.0.0.1:14222:4222 nats:2.15-alpine &&
  LINK_TEST_NATS_URL=nats://127.0.0.1:14222 go test -race -run TestHintsOverARealNATSServer .   # against a real NATS
```

The image (`Dockerfile`) is built with Go 1.27.3, the first release that carries every standard-library fix govulncheck
reports for this module. The dependency reviews are in
[docs/dependency-security.md](../../docs/dependency-security.md#link-gateway-dependencies-2026-10-25), and for the NATS
client in [its own section](../../docs/dependency-security.md#nats-clients-for-runner-link-hints-2026-10-25).
