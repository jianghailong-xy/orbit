# Runner link cut-over: the rollback runbook

The runner link's cut-over is one switch on the server, `RUNNER_LINK_REQUIRED` (docs/runner-link-design.md §11.3, task
D0). It has two rollbacks (§11.4):

1. **The switch off** (preferred). The old routes serve HTTPS again, and every runner goes back to it when its link says
   `MODE_HTTP`, in a Welcome or a HeartbeatAck. Nothing is deployed.
2. **The version rollback** (second line). The server goes back to vN-1, and its release pointer assigns runners vN-1
   marked as a rollback (`GET /api/runner/release`, `src/runner-go/selfupdate.go` `wantsRelease`). Each runner installs
   vN-1 by itself and works over HTTPS. For when the switch is not enough: vN itself, server or runner, is what fails.

`rollback-drill.sh` beside this file drills both on a staging stack with a real runner, as the design asks before the
production cut-over (task C3). The steps below are what an operator does in production; the drill does the same on
staging and checks each one.

## 1. The switch off

As an administrator of the deployment:

```bash
curl -fsS -X PUT -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"required":false}' "$ORIGIN/api/admin/runner-link-required"
```

What follows, and where to see it:

- The apiserver logs `RUNNER_LINK_REQUIRED switched off by administrator …` and serves the daemon routes over HTTPS at
  once on the replica that took the PUT, within a second on the others.
- The link gateway reads the switch every second and logs `RUNNER_LINK_REQUIRED switched: runners are told MODE_HTTP`;
  `link_mode_link` drops to 0. A connection opened in MODE_LINK then answers each heartbeat `MODE_HTTP` without
  forwarding it and refuses each call `LINK_MODE_HTTP`; its event batches are still stored, each seq once.
- Each runner logs `runner link mode: off — <what said it> said MODE_HTTP; daemon calls go over HTTPS`, at its next
  heartbeat (every 30 s) or its next call, whichever comes first. Its presence row (`runner_presence.link_state`) says
  `HTTP` from its next heartbeat. In the drill's two runs the runner heard it 2.9 s after the PUT from its next
  HeartbeatAck, and 9.8 s after it from a call the gateway refused.

## 2. The version rollback

vN is the release that is failing, vN-1 the one before it. `/dl` publishes both: vN at `/dl/version.json`, vN-1 at
`/dl/previous/version.json` (docs/release-process.md, "Runner rollout and rollback"). Check that before the cut-over:
`/dl/previous/version.json` must name vN-1 and carry `"runsAssignedRelease": true`, or no runner will roll back to it.

**Before the cut-over: build the rollback images.** From vN-1's commit, with `runner-release.json` naming vN rolled back
(commit that on a rollback branch: the pointer's history is the record of who moved it):

```json
{ "rolloutPercent": 100, "rollback": "<vN>" }
```

```bash
docker build -f src/apiserver/Dockerfile -t orbit-apiserver:rollback-<vN-1> .
docker build --build-arg ORBIT_SOURCE_SHA="$(git rev-parse HEAD)" -t orbit-link-gateway:rollback-<vN-1> src/link-gateway
```

Built ahead, the rollback is a container recreate rather than a build.

**The rollback.** If the vN apiserver still answers, switch the link off first (§1): it costs nothing. The drill runs the
version rollback from the cut-over state, with the switch on, and it works from there too. Then, in the deployment's
directory, with its own Compose file and `.env`:

```bash
docker tag orbit-apiserver:rollback-<vN-1> orbit-apiserver:local
docker tag orbit-link-gateway:rollback-<vN-1> orbit-link-gateway:local
docker compose --profile runner-link up -d --no-deps --no-build --force-recreate --wait apiserver link-gateway
```

- **The apiserver and the link gateway go back together.** A vN-1 gateway in front of a vN apiserver with the switch on
  would tell runners MODE_HTTP while the apiserver refuses their HTTPS calls with 426. Compose recreates the apiserver
  first (the gateway depends on it).
- **The web image stays at vN.** It serves `/dl`, and `/dl` has to keep publishing vN with vN-1 at `/dl/previous`: the
  pointer can only roll back the latest release to the previous one. A web image rebuilt from vN-1 publishes vN-1 alone
  (`scripts/retain-runner-release.sh` keeps only an older release), so the pointer's rollback names a version `/dl` does
  not publish and is ignored, and no runner moves: a runner never installs an older release without the rollback mark.
- **The database stays as vN left it.** vN-1's apiserver starts on it; check the migrations vN added are ones vN-1 can run
  beside (docs/release-process.md, "Rollback decision and procedure"). In the drill, 0.1.237 started on 0.1.238's schema
  (`No pending migrations to apply`; the switch's table, 0446, went unused).
- **NATS keeps vN's configuration.** A vN-1 that predates NATS's nkey users (B1) is refused (`Authorization Violation`)
  and drops runner hints. Runners on HTTPS do not use them: the long polls carry their work.

What follows, and where to see it:

- vN-1's link gateway tells every connection `MODE_HTTP` and forwards nothing. Each runner on the link reconnects after
  the old gateway's drain, logs `runner link mode: off — the Welcome of <connection> said MODE_HTTP`, and works over
  HTTPS, still on vN. In the drill the recreate took 48 and 57 s, and the runner had no way to the server for about as
  long: the old gateway drained it and refused it `503 DRAINING`, and the new one started once the apiserver was healthy.
- At its next release check, every 10 minutes and never while a turn runs, each runner asks
  `GET /api/runner/release?latest=<vN>&previous=<vN-1>` and is assigned `{"version":"<vN-1>","rollback":true}`. The
  apiserver logs `runner release <vN> is rolled back: every runner is assigned <vN-1>`. The runner drains, downloads
  `/dl/previous/orbit-<platform>.gz`, checks its digest, version and write contract, swaps its binary and restarts into
  it: `orbit <vN> -> <vN-1>: the control plane rolled <vN> back; downloading...`, then
  `orbit updated to <vN-1>; restarting...`. Its idle sessions are detached for the restart and reclaimed by the new
  process. The Runners page's Update Runner Now (`POST /api/runners/:id/self-update`) makes a runner check at once. In
  the drill's two runs the runner's own check came 6 and 7 minutes after the server went back, and it ran vN-1 under
  half a second later.
- On vN-1 the runner's release check keeps it there: it runs the release it is assigned.

**Afterwards: the switch's row.** vN-1 neither reads nor writes `runner_link_switch`, so the row keeps what it said when
the server went back. Before anything that has the switch is deployed again, set it off, or that deploy starts in the
cut-over state and refuses the vN-1 runners' HTTPS calls with 426:

```sql
UPDATE runner_link_switch SET required = false, updated_at = now() WHERE id = 1;
```

## The staging drill

`rollback-drill.sh` runs the steps above on a staging stack (`../README.md`) with a real runner: built into the stack's
own `/dl`, installed from it as `install.sh` installs a runner, registered, with self-update on and the test suite's
scripted claude as its only engine (`src/runner-go/fake_claude_test.go`), so that sessions produce real turns and events.

```bash
export ORBIT_LINK_STAGING_PROJECT=orbit-link-c3 ORBIT_LINK_STAGING_DIR=/var/tmp/orbit-link-c3
ORBIT_LINK_STAGING_HTTP_PORT=25086 ORBIT_LINK_STAGING_LINK_PORT=25443 ORBIT_LINK_STAGING_METRICS_PORT=25464 \
ORBIT_LINK_STAGING_NATS_PORT=25422 ORBIT_LINK_STAGING_NATS_MONITOR_PORT=25822 \
ORBIT_ROLLBACK_PREVIOUS=<vN-1 commit> scripts/runner-link/drills/rollback-drill.sh all
scripts/runner-link/drills/rollback-drill.sh stop
scripts/runner-link/staging-down.sh
```

| Phase | What it does | What must hold |
| --- | --- | --- |
| `prepare` | Builds vN-1 (`ORBIT_ROLLBACK_PREVIOUS`, its pointer naming vN rolled back) and vN (this checkout's HEAD at the next version, its `/dl` keeping vN-1 at `/dl/previous`); starts the stack at vN with the switch off; installs, registers and starts the runner. | `/dl` publishes vN, and vN-1 with `runsAssignedRelease`; a session is answered with the runner's calls over HTTPS and none forwarded by the link gateway. |
| `cutover` | Switches `RUNNER_LINK_REQUIRED` on. | The runner logs `runner link mode: on`, its presence says `LINK`, and a session is answered with every call forwarded by the link gateway and none over HTTPS. |
| `switch-off` | Switches it off. | The runner logs `runner link mode: off`, the gateway logged a Welcome or HeartbeatAck saying `MODE_HTTP`, its presence says `HTTP`, and a session is answered over HTTPS with nothing forwarded. |
| `version` | From the cut-over state: the apiserver and the link gateway back to vN-1, web and `/dl` left at vN. | The runner leaves the link; `GET /api/runner/release` assigns it vN-1 as a rollback; it installs vN-1 by itself (`orbit status` names vN-1's version and commit, its binary is `/dl/previous`'s); a session is answered over HTTPS; after an Update Runner Now it is still on vN-1; the switch's row is set off. |
| `all` | `prepare`, `cutover`, `switch-off`, `cutover`, `version`. | |

Every session's turns are answered and its events stored as seqs 1..N, each once. The records go to
`<state>/client/rollback/`: `timeline.txt` is the drill's account, beside the build logs, `/dl`'s manifests, the release
answer, the link gateway's and the apiserver's logs. The runner and its log stay in `<state>/rollback-runner/`; the
runner keeps running after the drill until `rollback-drill.sh stop`.

The version phase waits for the runner's own release check, up to `ORBIT_ROLLBACK_UPDATE_WAIT` seconds (1500: two
checks); `ORBIT_ROLLBACK_UPDATE_NOW=1` presses Update Runner Now instead. It needs root, for the runner's mount
namespace: the runner looks for its engines under the account's home whatever `$HOME` says, and there it would find this
host's own CLIs, signed in to nothing on the stack.

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
| `prepare` | Starts the stack in `MODE_LINK`, built from this checkout, with the link gateway as the stack runs it. Builds the runner and the test suite's scripted claude (`src/runner-go/fake_claude_test.go`) from this checkout, then registers and starts the runner. | The gateway runs without `LINK_DRILL_LOSE_ANSWERS`. The runner's work goes over the link: a baseline session's prompt and message are answered, with calls forwarded by the gateway and none over HTTPS. |
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
namespace, as the rollback drill does.

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
| `prepare` | Starts the stack in shadow mode (`MODE_HTTP`), built from this checkout. Builds the runner and the scripted claude from `ORBIT_RELEASE_OUTAGE_RUNNER_SRC` (this checkout), then registers and starts the runner. | The runner's presence says HTTP. |
| `https` | Opens a session; once its prompt is answered, kills the apiserver for `ORBIT_RELEASE_OUTAGE_SECONDS` (60), then starts it again. | See below. |
| `link` | Brings the stack to `MODE_LINK` and the runner onto the link. Opens a session; once its prompt is answered, kills the link gateway as long, with the apiserver up, and asks for a diff refresh of the session meanwhile (`POST /api/sessions/:id/diff/refresh`, a `diff` control turn). | See below. |
| `all` | `prepare`, `https`, `link`. | |

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
`release-outage-drill.sh stop`. The drill needs root for the runner's mount namespace, as the rollback drill does. A
runner built from before task B9 (`ORBIT_RELEASE_OUTAGE_RUNNER_SRC` pointing at an older checkout) fails the `https`
phase: its session goes `FAILED` once one release has failed for 10 s.

# Many runners out of reach at once: the drill

A runner's silence is the reaper's only evidence that it died: a session whose runner has not beaten for 90 s is
finalized `runner offline` (src/apiserver/src/realtime/reaper.service.ts). When a link gateway node stops, or a network
cuts a share of the cell off, many runners go quiet together while they work on, and a reaper that took that for their
death would fail every turn they were running. The design's answer (docs/runner-link-design.md §6.5, §10; task B3): while
a fifth of the cell's runners have gone silent at once, the reaper holds the offline reaping. `mass-disconnect-drill.sh`
beside this file drills that on a staging stack with real runners (task C1b).

```bash
export ORBIT_LINK_STAGING_PROJECT=orbit-link-c1b ORBIT_LINK_STAGING_DIR=/var/tmp/orbit-link-c1b
ORBIT_LINK_STAGING_HTTP_PORT=29086 ORBIT_LINK_STAGING_LINK_PORT=29443 ORBIT_LINK_STAGING_METRICS_PORT=29464 \
ORBIT_LINK_STAGING_NATS_PORT=29422 ORBIT_LINK_STAGING_NATS_MONITOR_PORT=29822 \
scripts/runner-link/drills/mass-disconnect-drill.sh all
scripts/runner-link/drills/mass-disconnect-drill.sh stop
scripts/runner-link/staging-down.sh
```

| Phase | What it does | What must hold |
| --- | --- | --- |
| `prepare` | Starts the stack in the cut-over state, built from this checkout: the link gateway following the server's switch and `RUNNER_LINK_REQUIRED` on, so HTTPS refuses every runner's daemon calls and only the link carries them, as in production after the cut-over. Builds the runner and the scripted claude from this checkout, registers `ORBIT_MASS_DISCONNECT_RUNNERS` (10) runners, each with a configuration directory (`ORBIT_HOME`) and a systemd unit of its own, and starts them across one heartbeat interval. | Every runner logs `runner link mode: on`, and its presence says `LINK`. |
| `gateway` | Every runner's session runs a turn its engine holds open. Kills the link gateway node (`docker kill`, as a crash ends it) for `ORBIT_MASS_DISCONNECT_SECONDS` (180), then starts it again. Every runner loses the link. | See below. |
| `partition` | The same, with `ORBIT_MASS_DISCONNECT_CUT` (2) runners, a fifth of them, cut off instead: an nftables rule drops every packet the processes of their units send, the link's and HTTPS's alike. The others stay connected. | See below. The runners still connected end their turns during the outage. |
| `all` | `prepare`, `gateway`, `partition`. | |

What must hold in each outage:

- **Nothing reaped.** Every session stays `RUNNING` while its runner is out of reach, and the apiserver logs no
  `reaped session` for any of them.
- **The outage reached the reaper.** Every runner cut off was silent past the 90 s line, and the reaper logged that it
  held their sessions (`not reaping N session(s) whose runner looks offline (…): X of the Y runners heard from … have
  been silent for over 90s at once`), for the mass silence and not for its startup grace or a failed heartbeat write.
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
  sweep, any hold an earlier outage left has lapsed (the reaper keeps one for 90 s past the last sweep that saw it), and
  the reaper counts no runner silent: whatever holds during the outage is then the outage's doing. On a new stack that
  takes up to 11.5 minutes: the probe runner `staging-up.sh` registers never beats, and stays in the reaper's count until
  it is past its window.
- **Cut off for real.** The partition drops a runner's packets by its unit's cgroup (`socket cgroupv2`), so the runner
  and its engine keep running and buffering events, while nothing they send leaves: a lost network, not a stopped
  process.

The records go to `<state>/client/mass-disconnect/`:

- `timeline.txt` is the drill's account: each runner's last beat before the cut and when that puts it past the offline
  line, the reaper's held sweeps with its own reading of the cell, each runner heard again and its log's connection
  lines, and each session's account.
- `outages.tsv` has a line per outage, and `sessions.tsv` a line per session in it.
- `<run>-samples.tsv` has the outage sampled every 2 s: each session's status (`S`), each runner's silence in seconds
  (`P`), and the cell as the reaper reads it (`F`: runners heard from, runners silent).
- `<run>-apiserver.log` and `<run>-link-gateway.log` are the two logs over the run.

A phase can be run again, with new sessions, as often as its outage should be: when the reaper sweeps, every 30 s,
falls at a different point of the runners' crossings each time. Each run is numbered (`gateway-1`, `partition-2`, …),
and names its sessions' release gates and its records; `prepare` starts the numbering again.

The runners keep running after the drill until `mass-disconnect-drill.sh stop`, which also removes the partition's
nftables table should a drill have died with it in place. Each runner's log and its scripted claude's records are in
`<state>/mass-disconnect/r<n>/`. The drill needs root, for the runners' mount namespaces and units and for nftables.
