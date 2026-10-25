# loadgen: the runner link's cell-scale load test

`loadgen` plays a cell's fleet of runners against a link gateway in `MODE_LINK` (task C2,
[docs/runner-link-design.md](../../../../docs/runner-link-design.md) §9: 15,000 runner connections, about 500
heartbeats and 2,000 durable events a second). Each simulated runner behaves as a runner in link mode does:

- it trades its runner token for a link token (`POST /api/runner/link-token`), dials the link, says `Hello` with a
  runner's capabilities, engines and write contract and, as a runner names them (`Hello.sessions`), every session it
  supervises with the last seq it assigned there and the turn it runs. It reads `Welcome`: a session stored further than
  an `EventAck` said (an answer lost with its connection) is not sent again, and a lease `Welcome` says this process no
  longer holds is an error;
- it beats every `Welcome` interval (30 s), naming its open sessions, with the parts of a runner's heartbeat
  (engines, model catalog, commands, skills, repos and the rest, about 7 KB of JSON): whole on a connection's first
  beat and when the gateway asks for them, by digest otherwise. Each runner's beats start at a random point of the
  interval, as a fleet's do, and, as a runner's, the next beat waits for the last one's `HeartbeatAck`;
- it replaces its connection make before break 5 minutes before the token expires. With `-spread-renewals` (the
  default) a runner's first renewal comes at a random point of its token's life, so renewals arrive at the steady rate
  of a fleet that has run for a while (about 4.5 a second for 15,000 runners), not all at once an hour in. Before
  opening the next connection it waits, for up to 5 s, until nothing of the current one is out;
- each of its active sessions streams durable events (§5.8): a step of `thinking`, `assistant`, `tool_use` and
  `tool_result`, with payloads shaped as the ingest reads them (a tool call and its result share an id). Events arrive
  at random (exponential gaps) at `-event-rate` shared evenly by the active sessions. A batch is sent 1–3 s after its
  first event, or at once on a `tool_result` (a boundary event), and kept until an `EventAck` covers it. A failed
  batch, and what was out behind it, is sent again from `durable_seq + 1`; a lost connection's batches are sent again
  on the next one; nothing of a session is sent on a new connection while a batch of it is out on the old one, so a
  session's events are stored in seq order.

It counts as an error every connection that ends unasked, every refusal, every `EventAck` that fails or refuses an
event, every acknowledgement more than 30 s late, every heartbeat answered without a reconcile, and every heartbeat
answer that cancels a session or takes its lease. It measures each batch's acknowledgement latency from its first send
to the `EventAck` covering it, per batch and per event, in histograms of 1% resolution.

```bash
loadgen -fleet fleet.jsonl -api http://127.0.0.1:61086 -link-url wss://link-gateway:8443 -connect 172.19.0.6:8443 \
  -ca ca.pem -duration 1h -event-rate 2000 -out results/
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `-fleet` | required | The fleet file: one runner per line, `{runner, token, process, sessions, active: [{id, seq}]}`. `scripts/runner-link/loadgen-seed.sh` writes it. |
| `-api` | required | The server's origin, for link tokens. |
| `-link-url`, `-connect` | — | Dial this link address instead of the one tokens name; open its TCP connections to this `host:port` (TLS still checks the address's name). Staging uses the gateway container's own address, so no proxy stands between. |
| `-ca` | — | Also trust this CA for the link's TLS. |
| `-runners` | all | Play only the fleet's first N runners. |
| `-ramp-rate` | 150 | First connections opened per second (the gateway admits 200 a second across all clients). |
| `-duration` | 1h | The steady window. |
| `-settle` | 30s | Once every runner is connected, how long before the steady window opens. The ramp queues every runner's first beat and connect at once (since B4a a connect also costs the welcome route's lookup), and on one apiserver that backlog takes about half a minute to drain at 3,000 runners. |
| `-event-rate` | 2000 | Durable events per second across the fleet. |
| `-flush-min`, `-flush-max`, `-max-batch` | 1s, 3s, 100 | When a batch is sent, and how many events it carries at most. |
| `-renew-before`, `-spread-renewals` | 5m, true | When a connection is replaced. |
| `-drain-timeout` | 30s | After the window, how long runners wait for their last acknowledgements. They send no new beat meanwhile, and close each connection with the close handshake, so the gateway sees them leave. |
| `-interval` | 10s | How often `series.jsonl` gets a line. |
| `-seed` | 1 | The random seed. |

It writes to `-out`:

- `series.jsonl`: one line per interval, with its phase (`ramp`, `settle`, `steady`, `drain`), the runners connected, what was
  sent and acknowledged, the latencies' percentiles and the errors by kind;
- `summary.json`: the steady window and the whole run, each with its counters, rates, latency summaries and errors,
  the notes (Drain, Credit changes, renewals whose old connection ended first) and the first details of each error;
- `errors.log`: every error, one line each.

It exits 0 only if the steady window was reached, nothing was counted as an error and every event produced was
acknowledged.

`scripts/runner-link/loadgen-run.sh` runs it against the staging stack with the stack's own measurements beside it, and
`loadgen-report.mjs` turns both into the report ([scripts/runner-link/README.md](../../../../scripts/runner-link/README.md)).
