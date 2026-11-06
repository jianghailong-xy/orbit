# Runner link drills

Each drill beside this file runs a staging stack ([../README.md](../README.md)) with real runners, the test suite's
scripted claude their only engine, and judges one of the link's fault semantics: durable events through outages, an
answer lost on its way, an engine that stops during an outage, and many runners out of reach at once. `drill-api.mjs`
makes their API calls on the stack, as its owner or as a drill runner.

The cut-over's rollback runbook and its drill, `rollback-drill.sh` (task C3), are gone: they drilled the switch off,
`RUNNER_LINK_REQUIRED`, and a version rollback to runners working over HTTPS, and D2 removed the switch and the runner's
HTTPS work path. What C3's drill and D1's rehearsal measured is in docs/runner-link-design.md §11.4; the way back after
D2 is the server version rollback of §15.11.

# Durable events through outages: the drill

A runner holds a session's durable events until the control plane says they are stored (docs/runner-link-design.md
§5.8): in memory, then in its spool on disk. Whatever goes down in between, the link gateway, the apiserver, the
database or the network, the events wait and go again once it is back, and the session's run_event rows stay numbered
1..N without a hole (§10). `durable-events-drill.sh` beside this file drills the four faults §11.1 lists, one after
another, on one session that streams output through all of them, with a real runner in the cut-over state (task C1a).

```bash
export ORBIT_LINK_STAGING_PROJECT=orbit-link-c1a ORBIT_LINK_STAGING_DIR=/var/tmp/orbit-link-c1a
ORBIT_LINK_STAGING_HTTP_PORT=31086 ORBIT_LINK_STAGING_LINK_PORT=31443 ORBIT_LINK_STAGING_METRICS_PORT=31464 \
ORBIT_LINK_STAGING_NATS_PORT=31422 ORBIT_LINK_STAGING_NATS_MONITOR_PORT=31822 \
scripts/runner-link/drills/durable-events-drill.sh all
scripts/runner-link/drills/durable-events-drill.sh report
scripts/runner-link/drills/durable-events-drill.sh stop
scripts/runner-link/staging-down.sh
```

The session's engine is the test suite's scripted claude (`src/runner-go/fake_claude_test.go`), so the drill spends no
model. Its prompt streams a tick every `ORBIT_DURABLE_EVENTS_TICK` (2) seconds for as long as the drill lasts, each tick
released by a timer of the drill's own (`await: release`): a progress ping (`system`/`status`), a reply delta and an
assistant message saying `tick K`. Over the link the ping takes no seq and the delta goes to the live stream (task B8),
so only the assistant message is a durable event. The engine needs nothing of the network, so it writes on through
every fault, as a model's stream does.

| Phase | What it does | What must hold |
| --- | --- | --- |
| `prepare` | Starts the stack, built from this checkout, where HTTPS refuses the runner's daemon calls and only the link carries them. Builds the runner and the scripted claude from this checkout, registers the runner and starts it as a systemd unit of its own. | The runner logs that a link connection `carries the work of process` it, and its presence says `LINK`. |
| `stream` | Opens the session. Its prompt streams ticks until `finish`. | The session is `RUNNING` and stores its ticks. |
| `gateway` | Kills the link gateway (`docker kill`, as a crash ends it) for `ORBIT_DURABLE_EVENTS_GATEWAY_SECONDS` (60), then starts it again. | See below. |
| `apiserver` | Kills the apiserver for `ORBIT_DURABLE_EVENTS_APISERVER_SECONDS` (60), the link gateway up. | See below. |
| `database` | Fails the database over. A standby, taken from a base backup of the primary, streams from it synchronously. The primary is killed, and `ORBIT_DURABLE_EVENTS_DATABASE_SECONDS` (20) later the standby is promoted and takes the name `postgres` in the stack's network. Then a planned switchback: the promoted standby stops cleanly, and the stack's own container starts on its data. | See below, for each of the two. |
| `partition` | Cuts the runner off for `ORBIT_DURABLE_EVENTS_PARTITION_SECONDS` (600): an nftables rule drops every packet its unit's processes send (`socket cgroupv2`). The runner and its engine keep running. | See below. |
| `finish` | Releases the stream's last ticks at once and waits for its turn to end. | The whole session: every seq held, every tick stored once, no ping or delta stored, nothing dropped in the runner's whole log, the prompt delivered to the engine once, the engine started once, and the session `AWAITING_INPUT`. |
| `all` | `prepare`, `stream`, `gateway`, `apiserver`, `database`, `partition`, `finish`. | |

What must hold after each fault. The drill waits for the tick released as the fault ended to be stored, for up to
`ORBIT_DURABLE_EVENTS_CATCHUP` (300) seconds, then checks:

- **No hole.** Every seq up to the session's last is held by a row: an event's, or a tombstone's for an event the server
  refused (task B5).
- **Every tick once.** The ticks written during the fault are among them, and no progress ping or live event is stored.
- **Read as it came.** The runner recorded each tick within 5 s of its release, however late it was stored: a row's
  `created_at` is the runner's time and `ingested_at` the database's. A runner that stopped reading its engine's stdout
  while it could not send would fail here.
- **Nothing dropped.** The runner logs no `dropping N events` and none of the link's losses: a stream given up, events
  not sent or not kept, the spool losing what it held.
- **The same session and runner.** The session stays `RUNNING` throughout, and the runner is the same process.

Why the standby is synchronous: an asynchronous one can be behind the primary by commits whose acknowledgements the
runner has already had. The runner drops the events an acknowledgement covers, so a failover to such a standby loses
them for good, and no protocol can send them again. Only a failover that loses no acknowledged commit can keep the
events, which is what the drill checks. The standby is the primary's container in all but its data directory: the same
image, command, WAL archive and environment, streaming through the primary's unix socket, which `pg_hba` already trusts
for replication. `runner_presence` is UNLOGGED, so it is empty on the promoted standby until the runner's next beat. The
database phase waits until the apiserver is past its reaper's 3-minute startup grace, which the apiserver phase restarts,
so that grace is not what keeps the session through the failover.

The cut runner is the stack's only beating runner, so it is the whole cell, and the reaper holds its sessions as a mass
silence (task B3). A runner cut off alone in a cell of many is reaped at the 90 s offline line instead. The drill does
not cover that case: there the reaper decides, not the link.

What the drill measured on 2026-10-27, in two runs: at 84a0b7424, and at 3b0141a78 with the project line merged in.
Every fault held in both runs.

- **The link gateway, killed for 60 s:** 33 ticks written meanwhile. The runner was back on the link 62 to 80 s after it
  lost the connection, and the stored ticks caught up within 15 s of the gateway's restart.
- **The apiserver, killed for 60 s:** 33 ticks written meanwhile. The link connection held. The gateway answered the
  event batch `BACKEND_UNAVAILABLE`, retryable, and the runner sent it again; it was stored 0.1 s after the apiserver
  was healthy.
- **The failover:** 11 ticks written in the 20 s without a primary, stored 3.6 to 5.2 s after the promotion.
  `runner_presence` held no row on the promoted standby. The switchback cost 6 to 8 s.
- **The 10-minute cut:** 301 ticks written meanwhile. The runner reconnected 9 to 10 minutes after it lost its connection,
  and never took its work back to HTTPS. The reaper held 18 sweeps in the second run.
- **Through all of it:** the runner read every tick off its engine within 0.1 s of its release. Each run's session
  stored seqs 1..1275 without a hole, and each of its 1270 ticks once. No ping or delta was stored, and there were no
  tombstones. The runner's log has no `dropping N events` and none of the link's loss lines.

Two phases are gone with the switch they drove (task 34sSqSNx9BHCECKDNblLr): `partition-off`, the partition with
`RUNNER_LINK_REQUIRED` off, past which the runner took its work back to HTTPS, and `rollback`, a runner stopped with
events unacknowledged and started again with `ORBIT_LINK_MODE=off` (task 34mumXbJjOvZUwNmDNzmY). A runner from D2 on
has neither: it works over the link alone. The spool `rollback` drilled is the runner's (`link_events_spool.go`), and
the process after a restart still sends what it holds first, over the link (design §11.4, §15.8).

## Records

The records go to `<state>/client/durable-events/`, which `prepare` empties first, so that a run's records are its
own; keep a copy of one you want to compare:

- `timeline.txt` is the drill's account.
- `phases.tsv` has a line per fault and one for the whole session.
- `summary.txt` has the judgement, which `durable-events-drill.sh report` prints.
- `<label>-ticks.tsv` has each tick's release time. Each phase leaves `<phase>-samples.tsv`, sampled every 2 s: the
  session's status, the ticks released and stored, and the runner's presence. It also leaves the runner's, the link
  gateway's and the apiserver's logs over the phase.

The runner, its log, its spool and the scripted claude's records are in `<state>/durable-events/`. The runner and its
ticker keep running after the drill until `durable-events-drill.sh stop`, which also undoes any fault a drill that died
left in place: the nftables table, a killed container, a standby. The drill needs root, for the runner's mount namespace
and unit and for nftables.

# An answer lost on its way: the drill

A control request's answer can be lost on its way to the runner: the connection drops after the apiserver has committed
the claim or the lease, before the answer arrives. The design's answer (docs/runner-link-design.md §5.6, §10) is that
the runner sends the call again under the same request_id and gets the same work back at once: the same session from a
claim, the same message from an inbox fetch, instead of waiting for the 300 s lease to run out. The runner drops a turn
it already runs by its id, so the work runs once. `lost-answer-drill.sh` beside this file drills that on a staging stack
with a real runner (task C1c).

The fault comes from the link gateway, and only when a drill asks for it: `LINK_DRILL_LOSE_ANSWERS`
(src/link-gateway/README.md, "Lost answers"). With it, the gateway has the apiserver's answer to a claim or an inbox
fetch, and cuts the runner's connection instead of relaying it. The drill sets it by recreating the gateway with
`lost-answer.compose.yml` on top of the stack's own files, and its last phase recreates the gateway without it.

```bash
export ORBIT_LINK_STAGING_PROJECT=orbit-link-c1c ORBIT_LINK_STAGING_DIR=/var/tmp/orbit-link-c1c
ORBIT_LINK_STAGING_HTTP_PORT=27086 ORBIT_LINK_STAGING_LINK_PORT=27443 ORBIT_LINK_STAGING_METRICS_PORT=27464 \
ORBIT_LINK_STAGING_NATS_PORT=27422 ORBIT_LINK_STAGING_NATS_MONITOR_PORT=27822 \
scripts/runner-link/drills/lost-answer-drill.sh all
scripts/runner-link/drills/lost-answer-drill.sh stop
scripts/runner-link/staging-down.sh
```

| Phase | What it does | What must hold |
| --- | --- | --- |
| `prepare` | Starts the stack, built from this checkout, with the link gateway as the stack runs it. Builds the runner and the test suite's scripted claude (`src/runner-go/fake_claude_test.go`) from this checkout, then registers and starts the runner. | The gateway runs without `LINK_DRILL_LOSE_ANSWERS`. The runner's work goes over the link: a baseline session's prompt and message are answered, with calls forwarded by the gateway and none over HTTPS. |
| `claim` | Recreates the gateway to lose `ORBIT_LOST_ANSWER_ROUNDS` (5) claim answers. Each round opens a session. | The answer that claimed the session is lost, and the claim is answered again within `ORBIT_LOST_ANSWER_BOUND` (5) seconds, with the same session. The session's `claim_request_id` is the lost call's request_id, so the second answer replayed the first claim and claimed nothing new. The session's engine starts once, and its prompt runs once. |
| `inbox` | Recreates the gateway to lose as many inbox answers. Each round sends the baseline session a message. | The answer that leased the message's turn is lost, and the fetch is answered again within the bound, with the same turn. The message runs once. |
| `restore` | Recreates the gateway as the stack runs it. | The gateway's environment and log say nothing of the setting. A new session's prompt and a message are answered, no answer is lost, and the runner's connection holds. |
| `all` | `prepare`, `claim`, `inbox`, `restore`. | |

How a round is judged:

- **Within the bound**: the gateway logs how long after the cut the same call, under the same request_id, got its next
  answer (`after_ms`). It measures until that answer is written to the runner's new connection. The database agrees
  for a message: each time its turn is handed out, its lease deadline moves to 300 s on, and the timeline shows how
  soon after the lost lease the turn was handed out again.
- **The same work**: that answer hands out the session or the turn the lost one did (`same_work=true`).
- **Once**:
  - The message reached the scripted claude's stdin once, as a user message (`stdin.jsonl`). The runner's request for
    a session's title quotes its prompt too, and is not counted.
  - The turn's events are one `user`, one `user_delivery` written, one `user_delivery` acknowledged and one
    `turn_end`.
  - For a claim, the session's engine started once (`spawns.jsonl`).

The records go to `<state>/client/lost-answer/`:

- `timeline.txt` is the drill's account. It quotes the gateway's log lines for each loss, and the runner's lines for its
  connection ending and coming back.
- `rounds.tsv` has a line per lost answer.
- Each phase leaves the link gateway's log and metrics.

The runner keeps running after the drill until `lost-answer-drill.sh stop`. The drill needs root for the runner's mount
namespace, as the other drills do.

# An engine that stops during an outage: the drill

When an engine stops (the pool recycles an idle one, or it crashes), the runner releases its inbox generation before the
session does anything else: a fetch that outlives its runner (an HTTPS long poll, a link call the gateway still forwards)
must find the generation retired, or it could take a control turn nobody receives (src/runner-go/session.go). Before
task B9, a release that failed for 10 s failed the session, so a network cut, an apiserver deploy or a database failover
failed every session whose engine stopped while it lasted, though no event was lost. Now the release goes again until
it lands, and the session takes no turn until then. `release-outage-drill.sh` beside this file drills that on a staging
stack with a real runner (task B9).

The engine is the test suite's scripted claude, set to end itself `ORBIT_RELEASE_OUTAGE_ENGINE_IDLE` (20 s) after its
last message (`ORBIT_FAKE_CLAUDE_WAIT`): the drill takes the control plane down as a turn is answered, and the idle
engine stops inside the outage.

```bash
export ORBIT_LINK_STAGING_PROJECT=orbit-link-b9 ORBIT_LINK_STAGING_DIR=/var/tmp/orbit-link-b9
ORBIT_LINK_STAGING_HTTP_PORT=23086 ORBIT_LINK_STAGING_LINK_PORT=23443 ORBIT_LINK_STAGING_METRICS_PORT=23464 \
ORBIT_LINK_STAGING_NATS_PORT=23422 ORBIT_LINK_STAGING_NATS_MONITOR_PORT=23822 \
scripts/runner-link/drills/release-outage-drill.sh all
scripts/runner-link/drills/release-outage-drill.sh stop
scripts/runner-link/staging-down.sh
```

| Phase | What it does | What must hold |
| --- | --- | --- |
| `prepare` | Starts the stack, built from this checkout. Builds the runner and the scripted claude from `ORBIT_RELEASE_OUTAGE_RUNNER_SRC` (this checkout), then registers and starts the runner. | The runner logs that a link connection `carries the work of process` it, and its presence says LINK. |
| `apiserver` | Opens a session; once its prompt is answered, kills the apiserver for `ORBIT_RELEASE_OUTAGE_SECONDS` (60), the link gateway up, then starts it again. | See below. |
| `link` | Opens a session; once its prompt is answered, kills the link gateway as long, with the apiserver up, and asks for a diff refresh of the session meanwhile (`POST /api/sessions/:id/diff/refresh`, a `diff` control turn). | See below. |
| `all` | `prepare`, `apiserver`, `link`. | |

What must hold in each outage:

- The engine stops inside it, and the runner retries the release (`inbox generation of … not released yet`), never
  `inbox generation cleanup after process stop failed`.
- The session is `AWAITING_INPUT` throughout, and once the control plane is back the runner logs `inbox generation of …
  released`.
- A message sent then is answered by a new engine, once: one user message on the scripted claude's stdin, and one each
  of `user`, `user_delivery` written, `user_delivery` acknowledged and `turn_end`.
- Over the link: the diff turn is still `PENDING` when the generation is released (nothing that fetched for the stopped
  engine took it), then `ANSWERED` after the next engine started, and the runner never logs it handed over twice.

The records go to `<state>/client/release-outage/`: `timeline.txt` is the drill's account, with the runner's log lines
for each step, and `phases.tsv` has a line per outage. The runner keeps running after the drill until
`release-outage-drill.sh stop`. The drill needs root for the runner's mount namespace, as the other drills do. A
runner built from before task B9 (`ORBIT_RELEASE_OUTAGE_RUNNER_SRC` pointing at an older checkout) fails it: its
session goes `FAILED` once one release has failed for 10 s. The `https` phase, the apiserver killed with the runner on
HTTPS, is gone with the runner's HTTPS work path (D2); the `apiserver` phase kills it with the runner on the link.

# Many runners out of reach at once: the drill

A runner's silence is the reaper's only evidence that it died: a session whose runner has not beaten for 90 s is
finalized `runner offline` (src/apiserver/src/realtime/reaper.service.ts). When a link gateway node stops, or a network
cuts a share of the cell off, many runners go quiet together while they work on, and a reaper that took that for their
death would fail every turn they were running. The design's answer (docs/runner-link-design.md §6.5, §10, §15.6; tasks
B3 and 34nb3xhlRA03P4rMmfcpO): when a fifth of the cell's runners lose contact within 45 s of each other — those already
back counted with those still out — or a fifth are silent at once, that is a mass disconnection, and the reaper does
not reap the runs of its runners until each has been silent for 10¾ minutes. A runner counts as silent once it has
missed a beat: no beat for 45 s, a heartbeat interval and a half, whether or not it is past the 90 s line yet
(src/apiserver/src/runners/runner-presence.ts, `RUNNER_SILENT_AFTER_MS`). `mass-disconnect-drill.sh` beside this file
drills that on a staging stack with real runners (task C1b).

```bash
export ORBIT_LINK_STAGING_PROJECT=orbit-link-c1b ORBIT_LINK_STAGING_DIR=/var/tmp/orbit-link-c1b
ORBIT_LINK_STAGING_HTTP_PORT=29086 ORBIT_LINK_STAGING_LINK_PORT=29443 ORBIT_LINK_STAGING_METRICS_PORT=29464 \
ORBIT_LINK_STAGING_NATS_PORT=29422 ORBIT_LINK_STAGING_NATS_MONITOR_PORT=29822 \
scripts/runner-link/drills/mass-disconnect-drill.sh all
# The partition again, aimed: the reaper's first sweep after the first crossing 3, 8 and 13 s after it, before the
# second runner crosses, and 22 s after it, once both have.
for s in 3 8 13 22; do ORBIT_MASS_DISCONNECT_SWEEP_AFTER=$s scripts/runner-link/drills/mass-disconnect-drill.sh partition; done
scripts/runner-link/drills/mass-disconnect-drill.sh stop
scripts/runner-link/staging-down.sh
```

A link gateway node of two stopping, with the reconnections slowed down so that the last runners back are out past the
90 s line: a stack of two nodes behind a TCP balancer (`staging.gateways.compose.yml`), the second letting four
handshakes through at once and one every 150 s after. Of the runners the first node held, four are back through the
second within seconds and the rest after 150 s or more.

```bash
ORBIT_MASS_DISCONNECT_GATEWAYS=2 ORBIT_MASS_DISCONNECT_HANDSHAKE_RATE=0.00667 ORBIT_MASS_DISCONNECT_HANDSHAKE_BURST=4 \
scripts/runner-link/drills/mass-disconnect-drill.sh prepare
scripts/runner-link/drills/mass-disconnect-drill.sh node
```

| Phase | What it does | What must hold |
| --- | --- | --- |
| `prepare` | Starts the stack, built from this checkout, where HTTPS refuses every runner's daemon calls and only the link carries them, as in production since the cut-over. Builds the runner and the scripted claude from this checkout, registers `ORBIT_MASS_DISCONNECT_RUNNERS` (10) runners, each with a configuration directory (`ORBIT_HOME`) and a systemd unit of its own, and starts them across one heartbeat interval. | Every runner logs that a link connection `carries the work of process` it, and its presence says `LINK`. |
| `gateway` | Every runner's session runs a turn its engine holds open. Kills the link gateway node (`docker kill`, as a crash ends it) for `ORBIT_MASS_DISCONNECT_SECONDS` (180), then starts it again. Every runner loses the link. | See below. |
| `partition` | The same, with `ORBIT_MASS_DISCONNECT_CUT` (2) runners, a fifth of them, cut off instead: an nftables rule drops every packet the processes of their units send, the link's and HTTPS's alike. The others stay connected. With `ORBIT_MASS_DISCONNECT_SWEEP_AFTER` set, the runners cut off and the moment are chosen so that the reaper's first sweep after the first of them crosses the 90 s line falls that many seconds after the crossing (below). | See below. The runners still connected end their turns during the outage. |
| `node` | On a stack prepared with `ORBIT_MASS_DISCONNECT_GATEWAYS=2`: every runner's session runs a turn its engine holds open, and the first link gateway node is killed for `ORBIT_MASS_DISCONNECT_SECONDS`. The runners it held — those whose presence names it as their `gateway_id` — connect again through the second, at the pace its handshake limiter allows (`ORBIT_MASS_DISCONNECT_HANDSHAKE_RATE`, `_BURST`), then the first is started again. | See below, except that the runners the node held come back one by one, so only those out past the 90 s line for longer than a sweep interval must have been held, and there must be one. |
| `all` | `prepare`, `gateway`, `partition`. | |

What must hold in each outage:

- **Nothing reaped.** Every session stays `RUNNING` while its runner is out of reach, and the apiserver logs no
  `reaped session` for any of them.
- **The outage reached the reaper.** Every runner cut off was silent past the 90 s line (in `node`, some of them), and
  the reaper logged that it held their sessions (`not reaping N session(s) whose runner looks offline (…): its runner
  lost contact in a mass disconnection (X of the Y runners heard from, last heard between … and …) and has been silent
  for less than 645s`), for the mass disconnection and not for its startup grace or a failed heartbeat write.
- **Held from the first crossing on.** The first sweep after the first runner cut off crosses the 90 s line holds, and
  names that runner's session; so does every sweep after it until the control plane is back. Each held sweep comes no
  more than a sweep interval (30 s, and 5 s for the sweep's own work) after that crossing or the sweep before it, and
  the last before the restore within one of it: a sweep that did not hold would have left a gap. This is what the first
  drill found missing, before B3's fix (031aafaa3): the reaper then counted only runners past the 90 s line, so the
  sweep at 09:41:52.66Z on 2026-10-26, between the first of two runners' crossings and the second's, read 1 of 10 and
  reaped that runner's session.
- **The same process comes back.** Once the control plane is back, every runner cut off is heard again with the process
  id it had (`runner_presence.process_id`), so it kept its leases.
- **Every session goes on.** It stores the event its engine wrote during the outage (after the restore, for a runner cut
  off), ends its turn, answers one message more, stores its events as seqs 1..N each once, and its engine started once.
  No runner is told it no longer holds its session.

How an outage is set up, and why:

- **Beats spread as a fleet's are.** A runner beats every 30 s from when it started, and is past the offline line 90 s
  after its last beat. The runners start 3 s apart, so in an outage they cross the line one after another across a whole
  heartbeat interval, as a fleet's runners do, rather than in the same second. The phase opens its sessions one interval
  before the cut, since the hint of a new session makes a runner beat at once.
- **A quiet cell first.** Before each cut the drill waits until the apiserver is past its 3-minute startup grace by a
  sweep and a while past the last sweep that held, and the reaper counts no runner silent: whatever holds during the outage is then the outage's doing. The cell it hears is
  then the drill's runners and no more, so the runners cut off are the share of it the drill says. On a new stack that
  takes up to 11 minutes: the probe runner `staging-up.sh` registers never beats, and stays in the reaper's count until
  it is past its window (645 s).
- **Aimed sweeps.** The reaper sweeps every 30 s on a timer, and a runner beats every 30 s and is past the line 90 s
  after its last beat: where a sweep falls against a runner's crossing is fixed by where it falls against the runner's
  beats, the same in every outage, whenever the cut comes. Run again over the same runners, a partition only changes
  which of them crosses first. `ORBIT_MASS_DISCONNECT_SWEEP_AFTER` picks the runners instead: the first one cut off is
  the one whose crossings come closest to that long before a sweep (timed from the last sweep the reaper held, so run
  the gateway phase first), the others the runners whose beats come after its across the interval, and the cut comes
  halfway between the last of their beats and its next one, so that it crosses first and no beat is on its way. With
  10 runners 3 s apart, the sweep falls within 1.5 s of the asked time; under 15 s, it falls before the second runner
  crosses, where the sweep before the fix reaped.
- **Cut off for real.** The partition drops a runner's packets by its unit's cgroup (`socket cgroupv2`), so the runner
  and its engine keep running and buffering events, while nothing they send leaves: a lost network, not a stopped
  process.

The records go to `<state>/client/mass-disconnect/`:

- `timeline.txt` is the drill's account: each runner's last beat before the cut and when that puts it past the offline
  line, each sweep the reaper held since the first crossing (how long after it, how many runners cut off were past the
  line then, and the reaper's own reading of the cell), each runner heard again and its log's connection lines, and
  each session's account.
- `outages.tsv` has a line per outage, with the first runner past the line, how long after its crossing the first held
  sweep came and how many were past the line then; `sessions.tsv` has a line per session in it.
- `<run>-samples.tsv` has the outage sampled every 2 s: each session's status (`S`), each runner's silence in seconds
  (`P`), and the cell as the reaper reads it (`F`: runners heard from, runners that missed a beat).
- `<run>-crossings.tsv` has each runner cut off, when it crossed the offline line, and its session.
- `<run>-apiserver.log` and `<run>-link-gateway.log` are the two logs over the run.

A phase can be run again, with new sessions, as often as its outage should be, aimed at a different point of the
crossings each time. Each run is numbered (`gateway-1`, `partition-2`, …), and names its sessions' release gates and
its records; `prepare` starts the numbering again.

The runners keep running after the drill until `mass-disconnect-drill.sh stop`, which also removes the partition's
nftables table should a drill have died with it in place. Each runner's log and its scripted claude's records are in
`<state>/mass-disconnect/r<n>/`. The drill needs root, for the runners' mount namespaces and units and for nftables.
