# Runner link gateway

The link gateway is the WebSocket endpoint each runner keeps one connection to
([docs/runner-link-design.md](../../docs/runner-link-design.md) §4, §5.4, §6.1). Where it has a host name of its own, as
production's has, runners reach it directly on a port of its own, never through Cloudflare or the web gateway (decision
D1). On a default install they reach it through the web gateway's port (§15.10; [docs/self-hosting.md](../../docs/self-hosting.md#how-a-runner-reaches-the-link)),
and it speaks plain `ws://` inside the project's network. Frames are the protobuf messages of
[contracts/runner-link/v1](../../contracts/runner-link/v1/runner_link.proto); `linkpb/` is their generated Go.

It authenticates connections, greets runners, keeps connections alive and drains them, and relays the
[hints](#hints) the apiserver publishes on NATS for the runners it holds. Runners do their work over the link, and every
Welcome and HeartbeatAck says so: `MODE_LINK` (D15). The gateway forwards their requests, heartbeats and durable events
to the apiserver's internal listener, publishes their live streams on NATS while someone watches, and relays the
apiserver's turn prefix requests to them ([Forwarding](#forwarding)). It makes no decision of the control plane's: every
rule stays in the route a call is forwarded to.

Until the cut-over on 2026-11-05 it also served the shadow period (§11.2): told `MODE_HTTP` while the server's switch,
`RUNNER_LINK_REQUIRED`, was off, runners worked over HTTPS and the gateway only compared what they mirrored to it. That
code is gone; [After the shadow period](#after-the-shadow-period) says what went, what stayed, and what an older gateway
or runner does beside this one.

It is one static binary with these subcommands:

| Command | What it does |
| --- | --- |
| `link-gateway serve` | Serve runners (the default). Configured by the `LINK_*` variables below. |
| `link-gateway dump` | Decode frames: base64 or hex lines (the gateway logs an undecodable frame as `raw=<base64>`), or a length-delimited capture. |
| `link-gateway client` | A test runner for staging and drills. See [Test client](#test-client). |
| `link-gateway health` | The container health check: exits 0 when `/healthz` on the metrics port answers 200. |
| `link-gateway nkey` | Print a new NATS user nkey pair, `seed=` then `public=`, once to standard output. See [NATS](#nats). |
| `link-gateway secrets` | Print a new deployment's link secrets as `.env` lines, once to standard output: the signing key and its public half, the gateway token, and both NATS pairs. `scripts/install-server.sh` and `/upgrade`'s script write them into `.env`. |
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
| `LINK_TLS_MODE` | `acme` when `LINK_ACME_DOMAINS` is set, else `files` | `files`, `acme`, or `off` (plain `ws://`, for development, and behind a web gateway that carries the deployment's own TLS: `deploy/runner-link/behind-web-gateway.env`). |
| `LINK_TLS_CERT_FILE`, `LINK_TLS_KEY_FILE` | required in `files` mode | The certificate chain and its key, PEM. When either file changes, they are read again every `LINK_TLS_RELOAD_INTERVAL` (30s) and at once on `SIGHUP`. A renewal or rotation needs no restart. A pair that does not load leaves the certificate in use alone. |
| `LINK_ACME_DOMAINS` | — | Comma-separated names to obtain certificates for over ACME (TLS-ALPN-01). The ACME server must reach this gateway on port 443. |
| `LINK_ACME_EMAIL` | — | The ACME account's contact address. |
| `LINK_ACME_DIRECTORY_URL` | Let's Encrypt | Another ACME directory, for example a staging CA. |
| `LINK_ACME_CACHE_DIR` | required in `acme` mode | Where the account key and certificates are kept across restarts. |
| `LINK_ACME_CA_FILE` | — | An extra PEM root to trust for the ACME directory's own TLS, for example a test CA. |
| `LINK_REVOCATION_INTERVAL` | `30s` | How often the revocation list is read. |
| `LINK_NATS_URL` | — | The NATS server the apiserver publishes [hints](#hints) to, as a `nats://` address without credentials. Unset, the gateway relays no hints, publishes no live stream and says so when it starts. |
| `LINK_NATS_SEED` | — | The gateway's NATS nkey seed (`SU…`), its credential on the [NATS](#nats) server. Never logged. Unset, it connects without credentials, which the deployment's NATS refuses. |
| `LINK_INTERNAL_API_URLS` | required | The apiserver's internal listener for runner link calls (`RUNNER_LINK_INTERNAL_PORT`), one `http://` address per apiserver instance, comma-separated, for example `http://apiserver:3001`: where every call is forwarded. |
| `LINK_RPC_TIMEOUT` | `60s` | How long one forwarded call may take, retries on other backends included. |
| `LINK_BACKEND_MAX_CONNS` | `256` | The most connections open to each apiserver `LINK_INTERNAL_API_URLS` names. A call that finds them all busy waits for one to come free, in the order the calls came, instead of dialing another, so a stalled apiserver, or a gateway stalled by its own garbage collection, does not open a connection for every call in flight. A waiting call is bound by `LINK_RPC_TIMEOUT`: it ends `BACKEND_TIMEOUT` when no connection comes free in time, or is dropped when its runner's connection closes. Nothing of it reached the apiserver, and the runner sends it again. |
| `LINK_EVENT_MERGE_WINDOW` | `100ms` | How long an event batch waits for others, from any connection, to go with it in one [merged call](#merged-calls), up to `500ms`. `0` forwards every batch alone. |
| `LINK_EVENT_MERGE_MAX_BATCHES`, `LINK_EVENT_MERGE_MAX_BYTES` | `64`, `2097152` | What one merged call may carry: the sessions its transaction holds at once (at most the apiserver's 256), and the bytes of its events. A full call goes at once. |
| `LINK_EVENT_MERGE_CALLS_PER_BACKEND` | `4` | How many merged calls may be out at once to each apiserver `LINK_INTERNAL_API_URLS` names, from 1 to 8. The gateway's calls out at once are this many times the apiservers: 4 with one, 16 with four (see [Merged calls](#merged-calls)). At most 8, because a call holds one of its apiserver's 10 database connections for its whole transaction, and its heartbeats and other calls need the rest. |
| `LINK_INGEST_QUEUE_MAX_EVENTS`, `LINK_INGEST_QUEUE_MAX_BYTES` | `200000`, `134217728` | The most durable events, and payload bytes, the [ingest queue](#durable-events-and-credit) holds across all connections, however many there are. At the defaults that is about half a gigabyte of the gateway's memory: 200,000 events of 660 bytes are about 470 MiB, at the 2.4 KB each that task C2b measured, and 128 MiB of larger events, which the bytes bound stops first, about 600 MiB. Size it to the gateway's memory beside its connections (about 158 KiB each: 2.3 GiB for 15,000). Each must be at least one connection's credit, 10,000 events and 64 MiB. The credit's high- and low-water marks are half and a quarter of it. |
| `LINK_HELLO_TIMEOUT` | `10s` | How long after the upgrade a Hello may take. |
| `LINK_HANDSHAKE_TIMEOUT` | `5s` | How long the TLS handshake and the upgrade request may take, together. |
| `LINK_IP_RATE`, `LINK_IP_BURST` | `1`, `20` | New connections per second per client address, and the burst allowed. Behind a web gateway every runner is one address: `deploy/runner-link/behind-web-gateway.env` raises these to the limit across all clients. |
| `LINK_HANDSHAKE_RATE`, `LINK_HANDSHAKE_BURST` | 100 per CPU, at least `200`; the burst a second of it | New connections per second across all clients, and the burst allowed. Checked as a connection is accepted, before TLS: one past it is reset at once, which costs the gateway next to nothing, and the runner backs off as from any connection that fails. The default counts the CPUs the gateway may use (`GOMAXPROCS`, which follows the container's CPU limit): 2,800 a second at 28. A vCPU completes about 500 handshakes a second, and past about twice that a core they time out rather than level off, so the default leaves most of the CPU to the connections already open while bringing 800,000 runners back in under 5 minutes after a restart. |
| `LINK_DRAIN_BATCH`, `LINK_DRAIN_BATCH_INTERVAL` | `250`, `1s` | How many connections are sent Drain at a time, and how far apart. |
| `LINK_DRAIN_RECONNECT_MIN`, `LINK_DRAIN_RECONNECT_MAX` | `1s`, `30s` | The range the per-connection reconnect delay is drawn from, uniformly. |
| `LINK_DRAIN_GRACE` | `15s` | How long past its delay a drained connection may stay open before the gateway closes it. |
| `LINK_DRAIN_TIMEOUT` | `80s` | When the drain gives up and closes what is left. Keep Compose's `stop_grace_period` (90s) above it. |
| `LINK_FRAME_LOG` | `lifecycle` | `lifecycle` logs Hello, Welcome, Drain and Close. `all` logs a summary of every frame, in and out. `off` logs no frames. |
| `GOMEMLIMIT` | the container's memory allowance less a tenth | The Go runtime's memory limit. Unset, the gateway reads the allowance of the cgroup it runs in (the least `memory.max` of it and those above it, or cgroup v1's `memory.limit_in_bytes`) and keeps a tenth of it for what the runtime does not count, such as the kernel's socket buffers. The GC then collects as often as it must to stay inside the allowance, instead of the kernel killing the gateway at it. With no allowance and no `GOMEMLIMIT`, no limit is set and the gateway says so when it starts. |
| `GOGC` | `200` | How far the heap may grow past what is live before the GC collects again. Unset, the gateway uses 200, not Go's 100: at hundreds of thousands of connections each collection marks tens of gigabytes for seconds, and every request that meets a mark waits on it, so fewer of them are better while the memory limit bounds the heap. |
| `LINK_DRILL_LOSE_ANSWERS` | — | For staging drills only: answers the gateway loses on purpose, such as `claim:3,inbox:3` ([Lost answers](#lost-answers-a-drills-fault)). Unset, it loses none. |
| `LINK_DRILL_INGEST_RATE` | — | For load tests only: the durable events a second the gateway forwards at most, each batch in its turn, so that runners can send faster than the events are stored and the ingest queue fills to its bound. A batch waiting its turn counts in the queue. Unset, batches are forwarded as they come. |

These values are fixed by the design: ping every 20s, disconnect after 60s without a pong, heartbeat every 30s, at most
two connections per runner, frames of at most 256 KiB. Forwarding's bounds are fixed too: 64 calls in flight and 8
sessions' events being stored at once per connection; a credit of 10,000 events or 64 MiB per connection, a tenth of
it, or the connection's share of the high-water mark when that is less, while the ingest queue holds more than half its
bound (100,000 events or 64 MiB at the defaults), back once it holds less than a quarter and 30s after it last held
more than half, told 1,000 connections every 10ms; room the queue frees held
15s for a session in line; retries on other backends for up to 5s; a watcher count lapses after 60s; a turn prefix
request waits 10s for the runner.

## Handshake

Before any TLS, a new connection past the handshake rate across all clients (`LINK_HANDSHAKE_RATE`) is closed with a
TCP reset as it is accepted: no handshake is spent on it, and it is counted `rate_limited`.

Then the gateway checks each upgrade request in this order. Nothing is upgraded until every check has passed. A refusal is
an HTTP response with `Connection: close`. Its JSON body has a `code`, named after the CloseCode the same refusal would
carry after the upgrade, a `message` and, where it applies, `reason` and `retryAfterMs`. A `Retry-After` header carries
the same delay.

| Check | Refusal |
| --- | --- |
| The gateway is draining. | `503 DRAINING`, `Retry-After: 5`. |
| The request is a WebSocket upgrade. | `426 WEBSOCKET_REQUIRED`. |
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

- protocol version 1 and `MODE_LINK`;
- `heartbeat_interval_ms` 30000, `max_frame_bytes` 262144, and the [credit](#durable-events-and-credit) a connection
  gets now;
- where each session Hello names stands and the runner's release, as the apiserver answers them ([Welcome](#welcome));
- an empty `HintState` and a `connection_id` (`c-` followed by 16 hex digits).

Welcome lists no `HintState` yet: a runner sends its first Heartbeat as soon as it has read Welcome, and that beat's
HeartbeatAck carries the `HintState`.

## Connections

- **Heartbeats** are counted, logged and [forwarded](#heartbeats), and each is answered with what the heartbeat route
  says, in a `HeartbeatAck` saying `MODE_LINK`.
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
(NATS lets a connection answer a request once). It writes each hint as a `Hint` frame to every connection of that
runner, behind control frames and never ahead of Welcome. With `LINK_FRAME_LOG=all`, each hint that is not sent is
logged with its runner, kind and result.

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

| Body | What the gateway does |
| --- | --- |
| `Hello` | The first frame only. A second Hello is a protocol error. |
| `Heartbeat` | [Forwarded](#heartbeats) to the heartbeat route, and answered with a `HeartbeatAck`. |
| `EventBatch` | [Stored](#durable-events-and-credit) through the ingest route and acknowledged. |
| `Rpc` | [Forwarded](#requests), and answered with exactly one `RpcResult`. |
| `LiveBatch` | [Published](#live-stream-and-watchers) while someone watches. |
| `TurnPrefixResponse` | The answer to a [turn prefix request](#turn-prefixes). |
| `Chunk` | Joined, then handled as the frame it makes up. |
| Anything else | Ignored, as the protocol asks of a body the receiver does not take. |

## After the shadow period

The shadow period (§11.2) and the cut-over switch (§11.3, §11.4, §15.1) ended with the cut-over on 2026-11-05. D2
removed the switch, the HTTPS work path and the runner's shadow connection from the apiserver and the runner
(docs/runner-link-design.md §15.11); task 34sSqSNx9BHCECKDNblLr removed the gateway's part (§15.12):

- **Gone:** the shadow comparison (`shadow.go`: the mirrors' pairing and its `link_shadow_*` series), the reading of the
  switch (`mode.go`: `GET /api/runner/link/mode` every second, `link_mode_link`, `link_mode_fetches_total`), `LINK_MODE`
  and its `link` override, the connection in `MODE_HTTP` (its HeartbeatAck answered at once, its `LINK_MODE_HTTP`
  refusal, its event batches neither stored nor acknowledged, its hints counted as `mode_http`), the test client's
  mirrors and the `switch` drill.
- **`LINK_MODE` is no longer read.** A deployment that still sets it starts, and its runners are told `MODE_LINK`, as a
  gateway reading D2's server tells them. `LINK_INTERNAL_API_URLS` is required.
- **Kept: `MODE_LINK` in every Welcome and HeartbeatAck.** A runner from before D2, such as 0.1.246 (src/runner-go
  link_mode.go and link_shadow.go at 763df9fab), moves its work onto the link when it is told `MODE_LINK`, takes a
  Welcome that states no mode as saying nothing, and goes back to HTTPS when it is told `MODE_HTTP`. Its shadow
  connection sends no mirror on a connection told `MODE_LINK`, and stands down once the work connection holds the
  process's one. So against this gateway a 0.1.246 runner works over the link as it did against the gateway before it:
  D2's server refuses its HTTPS daemon calls 426 (one to three as its process starts), and none follows once the link
  carries the work.
- **Kept: `MODE_HTTP` in the protocol.** contracts/runner-link/v1 keeps the value, which no field number may reuse; this
  gateway never sends it. A D2 runner told `MODE_HTTP` by an older gateway stays on the link and keeps asking.
- **Kept on the server: `GET /api/runner/link/mode`**, answered `{"required": true}` (runner-link-required.controller.ts).
  A gateway from before this cleanup, such as production's at f8b9964f3, reads it every second; one that starts and
  cannot read it tells every runner `MODE_HTTP` and forwards nothing. It stays as long as such a gateway may run: on a
  deployment whose link has a host of its own, /upgrade never rebuilds the gateway (`operator`), so that is until an
  operator rebuilds it.

## Forwarding

Every call the gateway forwards goes to one of the apiserver's internal listeners in `LINK_INTERNAL_API_URLS`
(`src/apiserver/src/runner-api/runner-link-call.ts`), as the HTTPS request a runner made before the link, under `/api`.
It carries, besides the request itself:

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

A `Heartbeat` is forwarded to `POST /runner/heartbeat` as the body a runner posted over HTTPS before the link, which
`TestAHeartbeatIsForwardedAsTheBodyTheHeartbeatRouteTakes` holds it to. `status` is `ONLINE`, `version` is Hello's, `leaseOwner` is the connection's process, `idleCapacity`,
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

Every `HeartbeatAck` names the beat it answers: its `beat_id` is the `Heartbeat`'s, whatever became of the beat
(reconciled, `want_facts`, refused, or no answer within `LINK_RPC_TIMEOUT`). A runner keeps one beat unanswered on a
connection and keeps the connection when the answer is late; by `beat_id` it tells that answer from the next beat's
(docs/runner-link-design.md §15.13). A beat from a runner older than the field names none, and its answer names none.
`TestEveryHeartbeatAckNamesTheBeatItAnswers` holds the gateway to this.

### Durable events and credit

An `EventBatch` is stored through `POST /runner/sessions/<id>/events`, the existing ingest route, as the batch a runner
posted over HTTPS before the link (task B5 gives the link an entry of its own). A session is named by its UUID or its public id,
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
  frame, and it comes back once the queue holds less than a quarter of its bound and has not held more than half for
  30s. That hold keeps a queue that crosses the mark again and again, as it did at each GC mark of a gateway with
  400,000 connections every 11-13s, from changing every connection's credit twice each time. A change is not written
  to every connection at once: a walk tells 1,000 connections every 10ms (400,000 in 4s), and a connection that sends
  a batch before the walk reaches it is told with that batch, ahead of its `EventAck`. That batch is held to the
  credit the runner had been told when it sent it. The reduced credit is also at most
  the connection's share of the high-water mark in events, among the connections with events in the queue: 20 events
  each when 5,000 connections send. So what they may have in flight together stays about the high-water mark, however
  many connections there are and however many of them are idle, and runners slow down rather than send what the queue
  would refuse; the rest of the bound is room for what comes before a `Credit` frame does. The share moves only once
  the number of connections that send has moved by more than an eighth. The bytes are not shared: the reduced 8 MiB is
  what the largest event a runner sends needs, and the bytes bound alone holds them. A connection opened meanwhile gets
  the reduced credit in its Welcome, and one whose share has moved is sent its new credit with its next batch, ahead
  of that batch's `EventAck`.

#### Merged calls

Every connection's batches go to the apiserver in merged calls (§6.6, `events_merge.go`): a batch waits up to
`LINK_EVENT_MERGE_WINDOW` for others, from any connection, and they go as one `POST /runner/link/events`, which the
apiserver stores in one transaction (`src/apiserver/src/runner-api/link-events.ts`). Each batch's answer in it is the
one the events route would give it alone, and it is acknowledged on its own connection as the table above says. A call
goes at once when it is full or when a batch carries a `turn_end` (a turn completion waits for its events: `after_seq`).

How many calls are out at once grows with the apiservers: at most `LINK_EVENT_MERGE_CALLS_PER_BACKEND` (4) to each one
`LINK_INTERNAL_API_URLS` names, so 4 with one apiserver and 16 with four. A call goes to the apiserver with the fewest
out. One that could not be dialed a moment ago is passed over, and its slots are not lent to the others, so no apiserver
holds more than its share. While every slot is taken, batches collect behind the calls out and go as soon as one
returns.

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
prefix, then only the live events after its `through_live_seq`. With no connection of the runner, a full live queue,
the connection's end or no answer within 10s, the request is answered at once with an empty response, and the client
gets today's behaviour.

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
| `link_tls_certificate_not_after_timestamp_seconds`, `link_tls_reloads_total`, `link_tls_handshake_errors_total` | gauge, counter, counter | `result`: ok, error |
| `link_rpcs_total` | counter | `result`: forwarded; not_forwarded on a gateway built without backends, as tests build one |
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
| `link_turn_prefix_requests_total` | counter | `result`: answered, timeout, dropped, no_connection, closed, superseded, unknown_answer, malformed |
| `link_queue_full_total` | counter | `queue`: control, normal, live; `result`: closed (slow_consumer), dropped |
| `link_hints_total` | counter | `kind`: inbox, claim, commands, approval, watchers, unknown; `result`: sent, no_connection, dropped, malformed, unchanged (a watchers count that did not move the sum) |
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

1. It trades a runner token for a link token (`POST /api/runner/link-token`), connects, says Hello and heartbeats; each
   beat is forwarded to the heartbeat route, as a runner's is.
2. It follows Drain make-before-break, and reconnects with exponential backoff and full jitter, from 1s to 60s,
   never sooner than a refusal's Retry-After or a Close's `retry_after_ms`.
3. When it stops, it prints a JSON summary of connects, heartbeats, the modes its HeartbeatAcks said, drains and
   reconnects.

```bash
link-gateway client -api http://127.0.0.1:18086 -runner-token "$TOKEN" -ca ca.pem -until-drains 1 -summary summary.json
```

With `-drill <name>`, it acts as a runner on each path the gateway forwards and writes a report of every step
(`-report`): `link` (requests, heartbeats and facts, hints, an approval its owner decides, durable
events and credit, the live stream and the turn prefix, an answer in pieces), `cancel` (a claim dropped while it waits),
`retry` (calls answered while a backend goes away) and `slow` (a runner that stops reading). It signs in as the runner's
owner (`-owner-email`, `-owner-password-file`) to create, watch and decide for sessions, and reads the live subject as
the apiserver's NATS user (`-nats-url`, `-nats-seed-file`). `scripts/runner-link/staging-check-link.sh` runs them all.

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
