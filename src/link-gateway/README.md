# Runner link gateway

The link gateway is the WebSocket endpoint each runner keeps one connection to
([docs/runner-link-design.md](../../docs/runner-link-design.md) §4, §5.4, §6.1). Runners reach it directly, on a port of
its own, never through Cloudflare or the web gateway (decision D1). Frames are the protobuf messages of
[contracts/runner-link/v1](../../contracts/runner-link/v1/runner_link.proto); `linkpb/` is their generated Go.

It authenticates connections, greets runners, keeps connections alive and drains them, and relays the
[hints](#hints) the apiserver publishes on NATS for the runners it holds. What else it does depends on its mode, which
every Welcome and HeartbeatAck states (D15):

- **`MODE_HTTP`, the shadow period** (§11.2), the default. Runners do their work over HTTPS. The gateway compares the
  heartbeats and event batches they mirror to it and **forwards nothing** to the control plane
  ([Shadow comparison](#shadow-comparison)).
- **`MODE_LINK`** (version 1). Runners do their work over the link. The gateway forwards their requests, heartbeats and
  durable events to the apiserver's internal listener, publishes their live streams on NATS while someone watches, and
  relays the apiserver's turn prefix requests to them ([Forwarding](#forwarding-mode_link)). It makes no decision of the
  control plane's: every rule stays in the route a call is forwarded to.

Which mode runners are told is the server's cut-over switch, `RUNNER_LINK_REQUIRED` (§11.3, §11.4, task D0):
`MODE_HTTP` while it is off, `MODE_LINK` while it is on ([The switch](#the-switch)). `LINK_MODE=link` pins `MODE_LINK`
whatever the switch says, which the staging drills use. A deployment leaves `LINK_MODE` unset.

It is one static binary with these subcommands:

| Command | What it does |
| --- | --- |
| `link-gateway serve` | Serve runners (the default). Configured by the `LINK_*` variables below. |
| `link-gateway dump` | Decode frames: base64 or hex lines (the gateway logs an undecodable frame as `raw=<base64>`), or a length-delimited capture. |
| `link-gateway client` | A test runner for staging and drills. See [Test client](#test-client). |
| `link-gateway health` | The container health check: exits 0 when `/healthz` on the metrics port answers 200. |
| `link-gateway nkey` | Print a new NATS user nkey pair, `seed=` then `public=`, once to standard output. See [NATS](#nats). |
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
| `LINK_NATS_URL` | — | The NATS server the apiserver publishes [hints](#hints) to, as a `nats://` address without credentials. Unset, the gateway relays no hints, publishes no live stream and says so when it starts. |
| `LINK_NATS_SEED` | — | The gateway's NATS nkey seed (`SU…`), its credential on the [NATS](#nats) server. Never logged. Unset, it connects without credentials, which the deployment's NATS refuses. |
| `LINK_MODE` | `http` | `http`: runners are told what the server's `RUNNER_LINK_REQUIRED` switch says, `MODE_HTTP` (the shadow period: compare, forward nothing) while it is off and `MODE_LINK` (forward) while it is on. `link`: `MODE_LINK`, whatever the switch says. See [The switch](#the-switch). |
| `LINK_INTERNAL_API_URLS` | required with `LINK_MODE=link` | The apiserver's internal listener for runner link calls (`RUNNER_LINK_INTERNAL_PORT`), one `http://` address per apiserver instance, comma-separated, for example `http://apiserver:3001`. Without it there is nowhere to forward to: the gateway does not read the switch, and runners are told `MODE_HTTP`. |
| `LINK_RPC_TIMEOUT` | `60s` | How long one forwarded call may take, retries on other backends included. |
| `LINK_EVENT_MERGE_WINDOW` | `100ms` | How long an event batch waits for others, from any connection, to go with it in one [merged call](#merged-calls), up to `500ms`. `0` forwards every batch alone. |
| `LINK_EVENT_MERGE_MAX_BATCHES`, `LINK_EVENT_MERGE_MAX_BYTES` | `64`, `2097152` | What one merged call may carry: the sessions its transaction holds at once (at most the apiserver's 256), and the bytes of its events. A full call goes at once. |
| `LINK_INGEST_QUEUE_MAX_EVENTS`, `LINK_INGEST_QUEUE_MAX_BYTES` | `200000`, `134217728` | The most durable events, and payload bytes, the [ingest queue](#durable-events-and-credit) holds across all connections, however many there are. At the defaults that is about half a gigabyte of the gateway's memory: 200,000 events of 660 bytes are about 470 MiB, at the 2.4 KB each that task C2b measured, and 128 MiB of larger events, which the bytes bound stops first, about 600 MiB. Size it to the gateway's memory beside its connections (about 158 KiB each: 2.3 GiB for 15,000). Each must be at least one connection's credit, 10,000 events and 64 MiB. The credit's high- and low-water marks are half and a quarter of it. |
| `LINK_HELLO_TIMEOUT` | `10s` | How long after the upgrade a Hello may take. |
| `LINK_HANDSHAKE_TIMEOUT` | `5s` | How long the TLS handshake and the upgrade request may take, together. |
| `LINK_IP_RATE`, `LINK_IP_BURST` | `1`, `20` | New connections per second per client address, and the burst allowed. |
| `LINK_HANDSHAKE_RATE`, `LINK_HANDSHAKE_BURST` | `200`, `400` | New connections per second across all clients, and the burst allowed. |
| `LINK_DRAIN_BATCH`, `LINK_DRAIN_BATCH_INTERVAL` | `250`, `1s` | How many connections are sent Drain at a time, and how far apart. |
| `LINK_DRAIN_RECONNECT_MIN`, `LINK_DRAIN_RECONNECT_MAX` | `1s`, `30s` | The range the per-connection reconnect delay is drawn from, uniformly. |
| `LINK_DRAIN_GRACE` | `15s` | How long past its delay a drained connection may stay open before the gateway closes it. |
| `LINK_DRAIN_TIMEOUT` | `80s` | When the drain gives up and closes what is left. Keep Compose's `stop_grace_period` (90s) above it. |
| `LINK_FRAME_LOG` | `lifecycle` | `lifecycle` logs Hello, Welcome, Drain and Close. `all` logs a summary of every frame, in and out. `off` logs no frames. |
| `LINK_DRILL_LOSE_ANSWERS` | — | For staging drills only: answers the gateway loses on purpose, such as `claim:3,inbox:3` ([Lost answers](#lost-answers-a-drills-fault)). Unset, it loses none. |
| `LINK_DRILL_INGEST_RATE` | — | For load tests only: the durable events a second the gateway forwards at most, each batch in its turn, so that runners can send faster than the events are stored and the ingest queue fills to its bound. A batch waiting its turn counts in the queue. Unset, batches are forwarded as they come. |

These values are fixed by the design: ping every 20s, disconnect after 60s without a pong, heartbeat every 30s, at most
two connections per runner, frames of at most 256 KiB. Forwarding's bounds are fixed too: 64 calls in flight and 8
sessions' events being stored at once per connection; a credit of 10,000 events or 64 MiB per connection, a tenth of
it, or the connection's share of the ingest queue's bound when that is less, while the queue holds more than half its
bound (100,000 events or 64 MiB at the defaults), back once it holds less than a quarter; room the queue frees held
15s for a session in line; retries on other backends for up to 5s; a watcher count lapses after 60s; a turn prefix
request waits 10s for the runner.

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

- protocol version 1 and the gateway's mode;
- `heartbeat_interval_ms` 30000, `max_frame_bytes` 262144, and the [credit](#durable-events-and-credit) a connection
  gets now;
- in `MODE_LINK`, where each session Hello names stands and the runner's release, as the apiserver answers them
  ([Welcome](#welcome)); nothing of either in `MODE_HTTP`;
- an empty `HintState` and a `connection_id` (`c-` followed by 16 hex digits).

Welcome lists no `HintState` yet: a runner sends its first Heartbeat as soon as it has read Welcome, and in `MODE_LINK`
that beat's HeartbeatAck carries the `HintState`. A runner in `MODE_HTTP` ignores it.

## Connections

- **Heartbeats** are counted and logged. In `MODE_HTTP` each is answered at once with a `HeartbeatAck` saying
  `MODE_HTTP` that reconciles nothing: `reconcile_json` is empty and `want_facts` names nothing. In `MODE_LINK` each is
  [forwarded](#heartbeats) and answered with what the heartbeat route says. A `HeartbeatAck` states the mode runners
  are told now, which may not be the one the connection opened in ([The switch](#the-switch)).
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
- **Slow readers.** Frames are written in [three tiers](#writing). A runner that does not read loses what may be lost and
  is closed with `CLOSE_CODE_SLOW_CONSUMER` once what it must get no longer fits, so memory never grows for it.
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
| `approval` | `{"hint":{"approval":{"sessionId":"<uuid>","approvalId":"<uuid>"}}}` | A person allowed or denied an approval of a session assigned to the runner. |

`testdata/b1-hints.json` holds those messages, the watchers hint and its header and the turn prefix request among them,
as the apiserver's encoder writes them (`src/apiserver/src/realtime/runner-hints.ts`), and
`TestHintFixturesDecodeStrictly` decodes each one with unknown fields refused, so a field renamed in the proto fails a
test instead of dropping hints.

The gateway subscribes to `rnr.<runnerId>` from the Welcome of a runner's first connection to the end of its last one,
and to no other runner's subject; one subscription per runner, which is also what lets it answer a turn prefix request
(NATS lets a connection answer a request once). It writes each hint as a `Hint` frame to every connection of that runner
in `MODE_LINK`, behind control frames and never ahead of Welcome. In `MODE_HTTP` a hint is counted and not sent: a
runner working over HTTPS is woken by its long polls. With `LINK_FRAME_LOG=all`, each hint that is not sent is logged
with its runner, kind and result.

Two more kinds of message arrive on a runner's subject: an apiserver instance's count of a session's
[watchers](#live-stream-and-watchers), a `watchers` hint with the instance named in an `Orbit-Instance` header, which
the gateway sums across instances before it tells the runner; and a [turn prefix request](#turn-prefixes).

A hint is sent at most once (§5.2). One that finds no connection of its runner, a full queue, or no NATS is counted and
dropped, never waited for, and a full queue does not close the connection the way a full queue of other frames does. The
runner's next heartbeat carries the same news. The gateway serves whether or not NATS is up. Its client dials until NATS
answers and subscribes again after every reconnect. A message on a hint subject that is not a hint is counted as
`malformed` and logged at most once a minute. A field or hint kind the gateway does not know is ignored, as the protocol
asks.

### Frames a runner may send

| Body | In `MODE_HTTP` | In `MODE_LINK` |
| --- | --- | --- |
| `Hello` | The first frame only. A second Hello is a protocol error. | The same. |
| `Heartbeat` | Answered at once with `HeartbeatAck` (`MODE_HTTP`), and the typed half of a [mirror](#shadow-comparison). | [Forwarded](#heartbeats) to the heartbeat route. |
| `EventBatch` | The typed half of a mirror. Never stored and never acknowledged: an `EventAck` would say the events are stored (§5.8). | [Stored](#durable-events-and-credit) through the ingest route and acknowledged. |
| `Rpc` | Answered with exactly one `RpcResult`, `Failure{code: LINK_MODE_HTTP, retryable: false}`. A `shadow:` request is the raw half of a mirror. | [Forwarded](#requests); a `shadow:` request is still never forwarded. |
| `LiveBatch` | Counted and dropped: the shadow period publishes no live stream. | [Published](#live-stream-and-watchers) while someone watches. |
| `TurnPrefixResponse` | Dropped. | The answer to a [turn prefix request](#turn-prefixes). |
| `Chunk` | Joined, then handled as the frame it makes up. | The same. |
| Anything else | Ignored, as the protocol asks of a body the receiver does not take. | The same. |

The columns are the mode a connection opened in, which its Welcome stated. What changes once the switch has changed
since then is in [The switch](#the-switch).

### Forwarding invariants

`mayForward` (`conn.go`) is the only check an Rpc passes before it may reach a backend. Two things hold, and
`TestRpcForwardingInvariants` pins both:

1. On a connection in `MODE_HTTP`, no Rpc is forwarded. A connection opened in `MODE_LINK` is in `MODE_HTTP` once the
   switch is off ([The switch](#the-switch)).
2. An Rpc whose `request_id` starts with `shadow:` is never forwarded, in any mode.

## The switch

The cut-over to the link and its first rollback are one switch on the server, `RUNNER_LINK_REQUIRED` (§11.3, §11.4). An
administrator reads and flips it at runtime, and nothing is rebuilt or restarted:

```sh
curl -H "Authorization: Bearer $TOKEN" https://<host>/api/admin/runner-link-required
curl -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"required":true}' https://<host>/api/admin/runner-link-required
```

While it is on, the apiserver answers an HTTPS call to a runner daemon route `426` with `code: "UPGRADE_REQUIRED"`
(`src/apiserver/src/runner-api/runner-link-required.ts`), and this gateway tells runners `MODE_LINK`. A runner that speaks
the link moves its work here on either signal, and goes back to HTTPS once it is told `MODE_HTTP`.

- **Reading it.** `GET {LINK_API_URL}/api/runner/link/mode`, with the gateway token, is read once before serving and then
  every second. What it answers, `{"required": true}` or `false`, is what runners are told from then on.
- **A read that fails changes nothing.** An error status, a refusal, an answer that does not say, or an apiserver that
  cannot be reached leaves runners told the mode last read, so a blip does not move every runner between the link and
  HTTPS. A failure is logged when it starts or changes, and the recovery once. Until a read succeeds, runners are told
  `MODE_HTTP`, what `LINK_MODE` says.
- **Not read at all** with `LINK_MODE=link`, which pins `MODE_LINK`, or without `LINK_INTERNAL_API_URLS`, when runners are
  told `MODE_HTTP`. The gateway says which when it starts.
- **Welcome** states the mode as the connection opens, and that stays the connection's: one opened in `MODE_LINK` has what
  forwarding needs, one opened in `MODE_HTTP` never forwards.
- **HeartbeatAck** states the mode now. A runner told `MODE_LINK` on a connection opened in `MODE_HTTP` (its shadow's)
  opens a new connection for its work. Once the switch is off, on a connection opened in `MODE_LINK`, a heartbeat is
  answered at once with `MODE_HTTP` and nothing to apply, and a request is refused `LINK_MODE_HTTP`, both without reaching
  a backend: the runner sends them again over HTTPS. Its `EventBatch`es are still stored and acknowledged until the runner
  leaves the connection; the ingest stores each seq once, so nothing is lost or stored twice whichever way it comes.
- `link_mode_link` is 1 while runners are told `MODE_LINK`, and `link_mode_fetches_total` counts the reads by outcome.

## Forwarding (MODE_LINK)

Every call the gateway forwards goes to one of the apiserver's internal listeners in `LINK_INTERNAL_API_URLS`
(`src/apiserver/src/runner-api/runner-link-call.ts`), as the HTTPS request a runner makes today, under `/api`. It
carries, besides the request itself:

| Header | What it is |
| --- | --- |
| `Authorization: Bearer <LINK_GATEWAY_TOKEN>` | The gateway's secret: the internal listener takes nobody else. |
| `X-Orbit-Runner-Link-Token` | The link token the connection was opened with. It names the runner and the process (`leaseOwner`); the apiserver checks it on every call. |
| `X-Orbit-Link-Request-Id` | `Rpc.request_id`: a claim sent again under it answers the session the first one claimed. |
| `X-Orbit-Link-Session-Id`, `X-Orbit-Link-After-Seq` | `Rpc.session_id` and `Rpc.after_seq`, when set: the call waits for the session's events to be stored through that seq. |
| `X-Orbit-Link-Gateway-Id` | This gateway node, which the heartbeat route records in the runner's presence. |
| `X-Orbit-Runner-Capabilities`, `X-Orbit-Runner-Os`, `X-Orbit-CLI-Version`, the three `X-Orbit-Runner-*-Revision`/`-Digest` write-contract headers, `X-Orbit-Managed-Runner-Generation` and `-Pod-Uid` | What Hello declared, under the names a runner sends on every HTTPS request today. |
| `X-Orbit-Supported-Providers` | The engines the newest Heartbeat names (Hello's until one does; an empty list leaves the last one). |

Each call runs under its connection's context: a runner that disconnects aborts its calls, so a route that watches its
request close (the claim waiting for its lock) sees the runner hang up, as over HTTPS (§6.4).

**Retries across backends** (§6.1). Backends are taken round-robin, and one that could not be dialed is passed over for
a few seconds. A call is sent again on the next backend, for up to 5s, when that is safe:

- whatever it is, when it reached no backend: the dial failed, or the connection failed before the request was written
  in full, so no handler ran;
- when it may have reached one, only if it is idempotent: a GET, a heartbeat (reconciled level-triggered) or an event
  batch (stored once per seq). Any other call that lost its answer comes back as `BACKEND_CUT_OFF`, and the runner sends
  it again under the same request_id.

An answer, whatever its status, is never retried: the route decided.

### Welcome

Before it writes a connection's Welcome, the gateway asks `POST /runner/link/welcome`
(`src/apiserver/src/runner-api/runner-link-welcome.ts`) about the sessions Hello names, by their UUIDs, with the headers
every forwarded call carries. A Hello naming no session is asked about too, for the release. The route answers, for each
session in the order asked:

- `durableSeq`: the highest seq up to which every one of the session's events is stored, counting from 1, a refused
  event's tombstone counting as stored. 0 when the first is missing, and for a session that is not this runner's.
- `leaseHeld`: whether this process holds the session's lease, by the rule the heartbeat's `leaseLostSessionIds`
  follows: the session is this runner's, open, a conversation, and its inbox leased to the process.

And `release`, the release `GET /runner/release` would assign the runner, from the two releases the apiserver reads
off /dl (`runner-release-feed.ts`), when it can state one. Welcome carries the sessions as `SessionState`s, under the ids
Hello used, and the release as `AssignedRelease`. The call writes nothing and is retried across backends like any
idempotent call, within 3s in all, well inside the 10s a runner waits for Welcome. It is made before the new connection
supersedes the process's older one, which carries the work meanwhile.

**When the route cannot answer**, the Welcome goes without sessions and without a release, and the connection opens as
usual. That covers no backend reached, a refusal (404 from an apiserver older than the route, 5xx from a database that is
down), an answer that does not state each session in order, and no answer within the 3s. The handshake is not refused:
an apiserver released after the gateway, or a database outage, must not keep every runner off the link or turn its
reconnects into a storm. `link_welcome_lookups_total` counts each outcome. A runner reads such a Welcome this way:

- **No entries means unknown, not lost.** A Welcome without sessions says nothing about them: neither that their events
  are not stored nor that the process lost their leases. The runner keeps every event no EventAck has covered and sends
  each again; the ingest stores each seq once, and the EventAcks say how far each session is stored. It keeps working
  on its sessions, and a lease it lost is named in the next heartbeat's `leaseLostSessionIds`, as it always was.
- **No release means asking over HTTPS.** The runner asks `GET /runner/release`, as it did before the link.

Whether or not the route answered:

- `durable_seq` can be too low, never too high. It is read while the process's older connection may still be storing
  a batch, so the runner may send events at or below it again, and they are stored once. Over HTTPS every live event and
  noise ping took a seq and was never stored, so for a session older than link mode the mark stops at the first of them.
  A runner never numbers new events from it alone: it starts after the largest of `durable_seq`, its own last seq and
  the claim's MaxSeq.
- The gateway does not hold the runner to it. A connection's first batch of a session may start anywhere, and
  `EVENT_SEQ_GAP` guards the batches after it on that connection, as before
  ([durable events and credit](#durable-events-and-credit)).

### Requests

An `Rpc` carries a `TunnelRequest`: method, path and JSON body of a runner route. The gateway forwards only `GET`,
`POST`, `PUT`, `PATCH` and `DELETE` to a path under `/runner/` in its plain form: no dot segments, doubled or trailing
slashes, escapes, backslashes, spaces or control characters. Anything else is answered at once, and nothing is sent:

| Failure code | Retryable | When |
| --- | --- | --- |
| `RPC_BAD_REQUEST` | no | A request_id that is not 1 to 128 letters, digits, `.`, `:`, `_` or `-`; no `TunnelRequest`; another method or path. |
| `RPC_TOO_MANY_IN_FLIGHT` | yes, after 1s | 64 calls of the connection are in flight already. |
| `BACKEND_UNAVAILABLE` | yes, after 1s | No backend could be reached within the retries. |
| `BACKEND_TIMEOUT` | yes | No answer within `LINK_RPC_TIMEOUT`. |
| `BACKEND_CUT_OFF` | yes | A call that is not idempotent reached a backend that never answered. |
| `BACKEND_ANSWER_TOO_LARGE` | no | The answer is more than a frame may carry once joined (8 MiB). |

The route's answer comes back as `TunnelResponse{status, json_body, retry_after_ms}`, whatever the status: the body as
the route wrote it, with the link's `code` and `retryable` in an error's body, and `retry_after_ms` from its
`Retry-After-Ms` header, else the body's `retryAfterMs`, else `Retry-After`.

### Lost answers (a drill's fault)

`LINK_DRILL_LOSE_ANSWERS` makes the gateway lose answers on their way to the runner, for the staging drill
`scripts/runner-link/drills/lost-answer-drill.sh` (§10, an answer lost on its way). It names calls, each with how many
of its answers to lose: `claim` (`GET /runner/sessions/claim`) and `inbox` (`GET /runner/sessions/:id/inbox`), as in
`claim:3,inbox:3`; a name without a number loses one. Only an answer that hands out work is lost: a claim's that names a
session, an inbox's that leases a message or shell turn, never a control turn or a steer. The route has committed it by
then. In its place the gateway cuts the runner's connection, with no Close frame (`link_disconnects_total` counts it as
`drill_lost_answer`), and logs `drill: an answer is lost`. The runner reconnects and sends the call again under the same
request_id; the gateway logs the answer that call gets next as `drill: the call whose answer was lost is answered
again`, with how long after the loss it came (`after_ms`), what it hands out (`work`) and whether that is what the lost
answer did (`same_work`). A call's answer is lost once: the same call sent again is answered, whatever losses are left
for the next calls. Once a call's losses are spent, its answers are relayed as usual.

Unset, which is the default and every deployment's setting, no answer is lost.

### Heartbeats

A `Heartbeat` is forwarded to `POST /runner/heartbeat` as the body a runner posts over HTTPS today: the exact inverse of
the [shadow comparison's](#shadow-comparison) mapping, which `TestAHeartbeatIsForwardedAsTheBodyItsMirrorWouldCarry`
holds it to. `status` is `ONLINE`, `version` is Hello's, `leaseOwner` is the connection's process, `idleCapacity`,
`draining` and `supervisedSessionIds` are the typed fields, and each `Fact`'s JSON is the member it is named after.

A Fact may come by digest alone. The connection keeps the last full value of each kind (64 kinds, 4 MiB), and fills in a
digest it holds. If a beat names a digest it does not hold, or a part that is not JSON, the beat is **not forwarded**:
its `HeartbeatAck` names those kinds in `want_facts` and carries no reconcile and no hints, and the runner sends those
parts whole in its next beat, at once. An absent heartbeat member keeps or clears what the server holds, so a body
missing one would say something the runner did not.

Beats are forwarded one at a time per connection; one waiting its turn is replaced by a newer one. The `HeartbeatAck`
of a forwarded beat carries the mode, the route's answer as `reconcile_json`, and `hints`:

- the route answers a link call with `linkHints` beside today's HeartbeatResponse: the sessions with a message waiting,
  whether a session waits to be claimed and the approvals that have a decision while the call or job that asked still
  waits (`runner-link-hints.ts`), and the answering instance's watcher counts. The gateway takes `linkHints` out of
  `reconcile_json`, which stays today's response, and states the approvals as `HintState.approvals`;
- `HintState.watchers` is the gateway's sum across apiserver instances.

It carries `release` too when `linkHints` names one: the release the runner is assigned, as in
[Welcome](#welcome). An answer naming none states none, and the runner asks `GET /runner/release` over HTTPS.

A beat that gets no 2xx answer is acknowledged with nothing to apply: no reconcile, no hints, no release.

### Durable events and credit

An `EventBatch` is stored through `POST /runner/sessions/<id>/events`, the existing ingest route, as the batch a runner
posts over HTTPS today (task B5 gives the link an entry of its own). A session is named by its UUID or its public id,
and acknowledged under the id the runner sent. One session's batches are forwarded one after another, in order.

| What happens | EventAck |
| --- | --- |
| The route stores the batch (2xx). | `durable_seq` = the batch's last seq. It never goes back. |
| The route refuses it (4xx), the session closed or the lease lost. | `failure` with the route's code, not retryable. |
| It fails otherwise (5xx, no answer). | `failure`, retryable, with the route's retry hint. |
| A batch failed ahead of it. | The same `failure`: stored after a gap, it would make `durable_seq` a lie. |
| It starts after a seq this connection has not stored. | `EVENT_SEQ_GAP`, retryable, not forwarded. |
| Its own seqs are not increasing without gaps. | `EVENT_BATCH_MALFORMED`, not forwarded. |
| It would put the connection past its credit. | `CREDIT_EXCEEDED`, retryable after 1s, not forwarded. |
| The ingest queue has no room for it (below). | `CREDIT_EXCEEDED`, retryable after 1s, not forwarded; its session waits in line. |

A failure's `durable_seq` is the last this connection acknowledged; the runner sends again from it plus one. `rejected`
stays empty until B5 writes tombstones.

The ingest queue is every connection's events queued for or in flight to the apiserver, counted from a batch's arrival
to its `EventAck`. It never holds more than `LINK_INGEST_QUEUE_MAX_EVENTS` events or `LINK_INGEST_QUEUE_MAX_BYTES`
payload bytes (200,000 or 128 MiB), however many connections there are: about half a gigabyte of the gateway's memory
at the defaults (see [Configuration](#configuration)). What it has no room for stays with the runner, which slows down
and holds its events in its own buffer, in memory and then on disk (design §5.8).

- **The line.** A session whose batch finds the queue full takes a place in line. Room the queue frees goes to the
  sessions in line, oldest first: it is held for each until its runner sends again, at most 15s, and nothing else may
  take it, not even a batch that would fit. So every session gets its turn, however small the others' batches. A
  session whose runner sends more than was held for it stays first in line for what it sends; one whose runner does
  not send again within 15s loses its turn, and one whose connection closes leaves the line.
- **Credit.** Credit is granted by the depth of the queue (§5.8). While it holds more than half its bound (100,000
  events or 64 MiB), every connection's credit drops from 10,000 events or 64 MiB to a tenth of that, in a `Credit`
  frame, and it comes back once the queue holds less than a quarter of its bound. The reduced credit is also at most
  the connection's share of the bound in events, the bound divided by the connections in `MODE_LINK`: 13 events each
  for 15,000 connections. So what every connection may have in flight fits in the queue, and runners slow down rather
  than send what it would refuse. The bytes are not shared: the reduced 8 MiB is what the largest event a runner sends
  needs, and the bytes bound alone holds them. A connection opened meanwhile gets the reduced credit in its Welcome, and
  one whose share has moved with the number of connections is sent its new credit with its next batch, ahead of that
  batch's `EventAck`.

#### Merged calls

Every connection's batches go to the apiserver in merged calls (§6.6, `events_merge.go`): a batch waits up to
`LINK_EVENT_MERGE_WINDOW` for others, from any connection, and they go as one `POST /runner/link/events`, which the
apiserver stores in one transaction (`src/apiserver/src/runner-api/link-events.ts`). Each batch's answer in it is the
one the events route would give it alone, and it is acknowledged on its own connection as the table above says. A call
goes at once when it is full or when a batch carries a `turn_end` (a turn completion waits for its events: `after_seq`);
at most four calls are out at once, and batches collect behind them.

| What happens | The batch |
| --- | --- |
| The call answers it stored. | Acknowledged from that answer. |
| The call answers it `sendAlone`: the apiserver wrote nothing of it (its session another writer holds, a refusal of the route's, a value the database refuses). | Forwarded alone to the events route, and acknowledged from that answer. |
| It is 256 KiB or more of events. | Forwarded alone. |
| The call is refused or fails otherwise (an apiserver without the route, a call it could not read, a 500). | Every batch of it forwarded alone. |
| The database turns the call away (503), or no backend answers. | Every batch of it fails as it would have alone, retryable. |

A session's batches still go one after another: its next batch is merged into a later call once this one is answered.

### Live stream and watchers

A `LiveBatch` is published on NATS, on `ses.<sessionId>.live` (the session's UUID) as a link `Frame` with only
`live_batch` set, in protobuf's canonical JSON, **only while someone watches the session**. For a session nobody
watches, it is dropped, and the runner is sent `Hint{watchers: 0}`, once, so that it stops sending.

Who watches comes from the apiserver instances. Each counts its own clients of a session's stream and publishes the
count, as a `watchers` hint naming the instance in `Orbit-Instance`, whenever it changes and every 20s while it is not
zero; the heartbeat route's answer carries the answering instance's counts too. The gateway sums them per session. A
count not repeated within 60s has lapsed: its instance is gone. The runner is told each new sum, and every HeartbeatAck
states them all. An apiserver instance with a client of the session subscribes to its live subject.

`testdata/b4-live.json` holds what the gateway publishes, live batches and turn prefix answers, as its encoder writes
them, and the apiserver's spec decodes it (`src/apiserver/src/realtime/runner-hints-live.spec.ts`); `TestLiveFixtures`
holds the fixture to the encoder.

### Turn prefixes

When a client opens a session, its apiserver instance asks the session's runner what the current turn has streamed so
far: a NATS request on `rnr.<runnerId>`, a `Frame` with only `turn_prefix_request` set, with a reply subject. The
gateway sends the runner a `TurnPrefixRequest`, in the live tier, on the connection whose last heartbeat names the
session (else the newest), and publishes the runner's `TurnPrefixResponse` on the reply subject. The client is handed the
prefix, then only the live events after its `through_live_seq`. With no connection of the runner in `MODE_LINK`, a full
live queue, the connection's end or no answer within 10s, the request is answered at once with an empty response, and
the client gets today's behaviour.

### Writing

Frames are written in three tiers, a tier only while every tier above it is empty:

1. control: Welcome, Close, Drain, HeartbeatAck, EventAck, Credit;
2. hints and RpcResults;
3. the live stream's: TurnPrefixRequest.

A frame over 256 KiB is written as `Chunk`s, one message at a time, and a frame of a higher tier is written between two
pieces. A runner that does not read is handled as §6.1 asks:

- a full live queue (64) drops the frame, and a hint finding a full queue (256) is dropped: the connection stays;
- a full control queue (64), an RpcResult finding a full queue, or queued frames past 32 MiB, whatever their count,
  close the connection with `CLOSE_CODE_SLOW_CONSUMER`.

### NATS

The deployment's NATS (`nats.conf` beside this file, docker-compose.yml's `nats` service) admits two users, each by the
public half of its nkey, each allowed only what it does:

| User | Publishes | Subscribes |
| --- | --- | --- |
| the apiserver | `rnr.>`: hints and turn prefix requests | `ses.*.live`, and `_INBOX.>` for its requests' answers |
| the gateway | `ses.*.live`, and the answer to a request it received | `rnr.>` |

A client without a seed cannot connect. The gateway connects with `LINK_NATS_SEED`; `link-gateway nkey` makes a pair.
`scripts/runner-link/nats-auth-check.sh` holds a real nats-server running `nats.conf` to that table
(`TestNATSAuthorizationOnARealServer`).

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
| `link_disconnects_total` | counter | `reason`: client_closed, connection_lost, superseded, ping_timeout, token_expired, revoked, protocol_error, slow_consumer, drained, shutdown, internal_error; drill_lost_answer only under `LINK_DRILL_LOSE_ANSWERS` |
| `link_rtt_seconds` | histogram | — (WebSocket ping round trips) |
| `link_frames_received_total`, `link_frames_sent_total` | counter | `type`: the frame body |
| `link_frame_decode_errors_total` | counter | — |
| `link_heartbeats_total` | counter | — |
| `link_draining`, `link_drains_sent_total` | gauge, counter | — |
| `link_revocations`, `link_revocation_fetches_total`, `link_revocation_last_success_timestamp_seconds` | gauge, counter, gauge | `result`: ok, error, unauthorized, not_configured |
| `link_mode_link`, `link_mode_fetches_total` | gauge, counter | `result`: ok, error, unauthorized, not_configured (see [The switch](#the-switch)) |
| `link_tls_certificate_not_after_timestamp_seconds`, `link_tls_reloads_total`, `link_tls_handshake_errors_total` | gauge, counter, counter | `result`: ok, error |
| `link_rpcs_total` | counter | `result`: shadow, not_forwarded, forwarded |
| `link_rpc_results_total` | counter | `result`: the route's status class (2xx, 4xx, 5xx), or the Failure code when there was no answer (`BACKEND_*`, `RPC_*`, `CANCELLED`) |
| `link_rpc_duration_seconds` | histogram | — (from a forwarded request's start to its route's answer) |
| `link_backend_calls_total` | counter | `kind`: rpc, heartbeat, events, welcome; `result`: answered, timeout, cancelled, cut_off, unavailable, too_large |
| `link_backend_retries_total` | counter | `kind`; `reason`: not_delivered (no handler ran), lost (an idempotent call's answer was lost) |
| `link_backend_call_duration_seconds` | histogram | — (retries included) |
| `link_heartbeat_forwards_total` | counter | `result`: forwarded, want_facts, refused, failed, superseded, other_process, unencodable |
| `link_heartbeat_forward_duration_seconds` | histogram | — |
| `link_heartbeat_facts_total` | counter | `result`: whole, cached, unknown_digest, invalid_json, digest_mismatch, ignored |
| `link_welcome_lookups_total` | counter | `result`: answered, failed (no answer), refused (not 2xx), malformed; all but answered send a Welcome without sessions and release |
| `link_event_batches_total` | counter | `result`: stored, credit_exceeded (past the connection's credit), queue_full (no room in the ingest queue), gap, malformed, no_answer, refused, refused_retryable, failed_behind, empty |
| `link_events_stored_total` | counter | — (events stored and acknowledged) |
| `link_event_ack_duration_seconds` | histogram | — (from a batch's arrival to its EventAck: the acknowledgement latency) |
| `link_event_merge_calls_total` | counter | `result`: answered, alone (every batch forwarded alone instead), failed (no answer, or the database turned the call away) |
| `link_event_merge_flushes_total` | counter | `reason`: window, batches, bytes, turn_end, due (a call slot freed) |
| `link_event_merge_alone_total` | counter | `reason`: too_large, answered_alone, call |
| `link_event_merge_batches` | histogram | — (batches per merged call) |
| `link_event_merge_call_duration_seconds` | histogram | — (from a merged call's start to its answer) |
| `link_event_merge_held_seconds` | histogram | — (how long the call's transaction held its sessions, as the apiserver states it) |
| `link_ingest_queue_events`, `link_ingest_queue_bytes` | gauge | — (queued or in flight to the apiserver: the depth credit is granted by; the unacknowledged events; never past `LINK_INGEST_QUEUE_MAX_*`) |
| `link_ingest_waiting_sessions` | gauge | — (sessions whose batch found the ingest queue full, in line for its room) |
| `link_credit_reduced`, `link_credit_changes_total` | gauge, counter | `to`: reduced, restored |
| `link_live_events_total` | counter | `result`: published, no_watchers, nats_down, publish_failed, bad_session |
| `link_watched_sessions` | gauge | — |
| `link_turn_prefix_requests_total` | counter | `result`: answered, timeout, dropped, mode_http, no_connection, closed, superseded, unknown_answer, malformed |
| `link_queue_full_total` | counter | `queue`: control, normal, live; `result`: closed (slow_consumer), dropped |
| `link_shadow_pairs_total`, `link_shadow_mismatches_total`, `link_shadow_unpaired_total`, `link_shadow_events_compared_total`, `link_shadow_pending_bytes` | | see [Shadow comparison](#shadow-comparison) |
| `link_hints_total` | counter | `kind`: inbox, claim, commands, approval, watchers, unknown; `result`: sent, mode_http, no_connection, dropped, malformed, unchanged (a watchers count that did not move the sum) |
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

With `-drill <name>`, against a gateway in `MODE_LINK`, it acts as a runner on each path the gateway forwards and writes
a report of every step (`-report`): `link` (requests, heartbeats and facts, hints, an approval its owner decides, durable
events and credit, the live stream and the turn prefix, an answer in pieces), `cancel` (a claim dropped while it waits),
`retry` (calls answered while a backend goes away) and `slow` (a runner that stops reading). It signs in as the runner's
owner (`-owner-email`, `-owner-password-file`) to create, watch and decide for sessions, and reads the live subject as
the apiserver's NATS user (`-nats-url`, `-nats-seed-file`). `scripts/runner-link/staging-check-link.sh` runs them all.
Against a gateway that follows the server's switch, `switch` has the owner, as the administrator, flip
`RUNNER_LINK_REQUIRED` on and then off in the middle of a session's event stream ([The switch](#the-switch));
`scripts/runner-link/staging-check-switch.sh` runs it.

The staging stack's scripts ([scripts/runner-link](../../scripts/runner-link/README.md)) build and run all of this.

## Development

```bash
cd src/link-gateway && go test ./...                  # CI runs it with -race
npm run generate:runner-link -w @orbit/shared         # after a change to contracts/runner-link/v1 (writes linkpb/)
npx tsc -p src/apiserver/tsconfig.json && node scripts/runner-link/gen-token-fixtures.mjs   # testdata/a3-tokens.json
npx tsc -p src/apiserver/tsconfig.json && node scripts/runner-link/gen-hint-fixtures.mjs    # testdata/b1-hints.json
go test -run TestLiveFixtures -args -update-live-fixtures       # testdata/b4-live.json, after a change to what is published
scripts/runner-link/nats-auth-check.sh                          # nats.conf on a real nats-server, with fresh keys
docker run -d --rm -p 127.0.0.1:14222:4222 nats:2.15-alpine &&
  LINK_TEST_NATS_URL=nats://127.0.0.1:14222 go test -race -run TestHintsOverARealNATSServer .   # against a real NATS
```

The image (`Dockerfile`) is built with Go 1.27.3, the first release that carries every standard-library fix govulncheck
reports for this module. The dependency reviews are in
[docs/dependency-security.md](../../docs/dependency-security.md#link-gateway-dependencies-2026-10-25), and for the NATS
client in [its own section](../../docs/dependency-security.md#nats-clients-for-runner-link-hints-2026-10-25).
