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
  answer (`after_ms`). It measures until that answer is written to the runner's new connection.
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
