# Runner updates the owner can see, postpone and interrupt

Status: owner took A for D1–D5 on 2026-11-12; project 34w72tJoQfAFqIW7dE4Pg. Board: `docs/mocks/runner-update-drain/`.

## 1. What happens today

A runner checks for a release of itself every 10 minutes (`selfUpdateCheckInterval`). It installs
one only when no turn is in flight (`closeForUpdate`; owner rule 2026-09-25: an automatic update
never evicts a running turn). Once a release has waited `selfUpdateDeferralLimit` (1 h), the runner
drains (`drainForUpdate`): it claims no new session or turn, holds the follow-ups that sessions
already on it are handed, and says `draining` in its heartbeat. Nothing ends the drain except the
update. With long turns in flight the drain lasts hours.

The control plane already stores everything needed to say so: `runner.heartbeat_draining` and
`runner.self_update` (`state: waitingForIdle`, reason `deferred for 1h5m51s, the limit; taking no
new work until the 8 turn(s) in flight end`). Nothing reads them for the person who is waiting:

- `queuedReason` (`sessions.service.ts`, the gate CASE) has no draining gate, so a session queued
  behind a drain falls through to `null` and reads "Waiting for the runner to pick it up". That
  sentence is meant for a wait of one long-poll round trip.
- A message queued in a session that is already on the runner shows only `Queued`.
- The runner page says "installs when no turn is running" both before and during the drain.
- "Update Runner Now" only asks for an earlier check, which then waits for idle like any other.

So the system silently decides, on the owner's behalf, between "install the release sooner" and
"new work starts now", and offers no way to choose differently.

## 2. Model: a macOS-style software update

The runner update becomes a visible object with four phases. Every surface draws the same phases.

| Phase | When | Effect on work | What shows |
|---|---|---|---|
| Available | release assigned, turns in flight, under the 1 h limit | none | runner page: `0.1.254 installs when no turn is running` (as today) |
| Draining | over the limit, turns still in flight | new sessions and follow-ups on this runner wait | queued sessions, queued messages, a workspace banner (only when something waits), runner page Update card |
| Restarting | idle, or the owner pressed Update Now | seconds; turns interrupted by Update Now resume | `Restarting into 0.1.254…` on the same surfaces |
| Postponed | the owner pressed Later | none; the runner takes work again | runner page: `0.1.254 postponed until 18:40 · Update Now` |

Two actions, both on every surface that shows Draining:

- **Later ▾**: In 1 hour / Tonight (02:00) / Tomorrow. The drain ends at once and the runner
  takes work again. When the time comes the release waits for idle again, under a fresh 1 h limit.
- **Update Now…**: a confirm dialog lists the turns it interrupts. The runner stops them as a
  runner stop does today (the session stays resumable), installs the release, restarts, reclaims
  those sessions and continues each one with a note that the update interrupted its turn. The
  queued work then starts. Only the owner can press it, so the 09-25 rule ("an *automatic* update
  never evicts a running turn") still holds.

## 3. Surfaces

1. **Queued session**: new `queuedReason = 'runner_updating'`, checked right after
   `runner_offline` and before every capacity gate. Title `Runner updating`. Body: `studio-mac is
   updating to 0.1.254. It starts no new work until 2 turns finish: <links>. This session starts
   right after.` Below that: `Waiting 38 min` and the two actions.
2. **Queued message** in a session on that runner: the bubble's foot-row tag reads `Queued ·
   runner updating` in the meta voice. A click opens the same explanation and actions.
3. **Session list chip**: `Runner updating` instead of `Queued`.
4. **Workspace banner**: one line at the top of the conversation pane, only while this runner
   drains *and* something of the owner's waits for it. Push notification at the same moment
   (D3).
5. **Runner page**: an Update card at the top while draining, restarting or postponed: version
   pair, phase, the turns it waits for, how long it has waited, and both actions.
6. **iOS / Android**: the same queued state and the same actions on the runner page; the banner
   becomes the existing attention strip.

## 4. Data and protocol

- Gate SQL: `WHEN r.heartbeat_draining IS TRUE THEN 'runner_updating'`, `queuedActive` = the
  runner's active turns. The list payload gains nothing else; the detail reads the runner.
- `RunnerSelfUpdate` (shared dto) gains `phase: 'available' | 'draining' | 'restarting' |
  'postponed'`, `targetVersion`, `drainingSince`, `postponedUntil`. The runner fills them; old
  runners send none, and the clients keep today's wording for them.
- Owner requests ride the heartbeat answer the way `selfUpdateRequestedAt` does today:
  `POST /runners/:id/self-update/postpone {until}` and `POST /runners/:id/self-update/now
  {interruptTurns: true}`. Both are owner-only and audited. A runner too old to honour them is
  refused with the existing "too old" sentence.
- Runner: postpone clears `drainingForUpdate` and the deferral clock until `until`. Now = the
  graceful stop path (`detached for shutdown (resumable)`), then install and restart. On reclaim,
  the control plane sends each interrupted session a resume turn with an Orbit note.

## 5. Decisions for the owner

- **D1 Later options**: A. 1 hour / Tonight / Tomorrow (recommended). B. A single 1 hour button.
- **D2 Postpone cap**: A. No cap, but each postpone lasts at most until tomorrow (recommended).
  B. A release marked required can't be postponed.
- **D3 Banner and push**: A. Only when something of the owner's waits on the drain (recommended).
  B. Whenever a runner drains.
- **D4 Update Now and the interrupted turns**: A. Resume them automatically with a note
  (recommended). B. Leave them waiting for the owner.
- **D5 Quiet hours** (later phase): A. No setting; Tonight in D1 covers it (recommended). B. A
  per-runner window in which updates install without waiting for idle.

## 6. Phases, cheapest first

1. `runner_updating` gate + wording on web/iOS/Android, queued message tag. No runner change.
2. Runner phase fields + runner page Update card.
3. Later (postpone) end to end.
4. Update Now with resume.
5. Banner and push.

Separate bug, own task: a session that is running reads PENDING in the database while its runner
drains, which would also make the new gate name the wrong state.

## 7. What the update wait holds, and what goes through

Owner-approved on 2026-11-13, revised 2026-11-24. This is the rule for the wait that
`drainForUpdate` starts; it is not a description of the code as of that date.

The fault it removes: a draining runner's session loop took the next queued message off the inbox
and then blocked in `waitTurnPermit` (`waitActive`, `heldForUpdate` set by `holdFollowUpForUpdate`).
The inbox is read one turn at a time, so an interrupt filed after that was not read until the update
ended, and the owner's Stop did nothing. If the follow-up had not been fetched yet, Stop was refused
with `SESSION_NEXT_TURN_STARTING`. Either way the session read Running, because the control plane
had kept its slot for the follow-up when the turn completed.

### 7.1 What is held

The update wait is a dispatch pause of one runner, with the semantics of the administrator's
dispatch pause (`src/apiserver/src/queue/dispatch-pause.ts`): it holds work that has not started,
and nothing else.

| Inbox turn | During the update wait |
|---|---|
| `message` | held |
| `shell`, including `!cmd &` | held |
| `reload` (it replaces the engine's process) | held |
| `interrupt` | goes through |
| `end` | goes through |
| `steer` (written into the turn already running) | goes through |
| `withdraw` | goes through |
| `setconfig` | goes through |
| `diff` | goes through |
| redelivery of a `message` or `shell` turn already running (expired lease, own-lease redelivery) | goes through |

On a draining inbox fetch nothing is put back in the queue and no inbox lease is retired: the held
turns simply stay `PENDING` on the server. This differs from the dispatch pause, which requeues a
`RUNNING` session with nothing in flight. The slot is returned only at turn completion (§7.3). A
session the draining runner claimed because its engine is running a turn of its own
(`drainClaimScope`) keeps its lease until that turn ends, so its process is not retired mid-turn, and
then §7.3 applies.

### 7.2 Where the hold lives

On the control plane. The runner says it is draining on every inbox fetch and every turn completion,
each in an optional request field, and the server decides from that request what it hands out and
whether the slot is kept. On the inbox fetch the field is the query parameter `draining=1` (beside
`acceptsSteer=1`, `GET /runner/sessions/:id/inbox`, over the link as over HTTPS); a fetch that
does not drain leaves it out. The heartbeat's `draining` flag lags the runner, so it is not used for
this.

The runner's own hold (`heldForUpdate`) stays only as a backstop for a control plane too old to read
those fields. It never stops the session loop from reading control turns: a held `message` or
`shell` must not block an `interrupt`, `end` or other turn from §7.1 filed behind it. The inbox
poller every engine loop shares holds such a turn while its permit does not come and goes on
fetching (`inboxPoller.holdTurns`); an `interrupt` hands the held turn back unrun, as
`INTERRUPTED`, before the loop handles the interrupt as it handles any.

### 7.3 A turn that ends on a draining runner

It does not keep the slot for a queued follow-up. The session goes back to the queue and reads phase
`PENDING`, `waitingOn: HOLD`, `queuedReason: runner_updating`: the queued state this design already
has (board 5 of `docs/mocks/runner-update-drain/`), not a new one. Its follow-ups run after the
update, through the ordinary claim.

The draining flag on the turn completion also records the runner as draining on the server, in the
column the heartbeat writes (`runner.heartbeat_draining`). The requeued session therefore reads
`queuedReason: runner_updating` at once, not after the next heartbeat. A later heartbeat that says
the runner is not draining clears it, as today.

### 7.4 Stop on such a session

Stop on a session queued behind the update:

- drops its queued messages;
- ends its background work (`stopBackgroundWork`);
- leaves the session idle.

It is never refused with `SESSION_NEXT_TURN_STARTING`.

### 7.5 Not covered here

The Codex app-server has interrupt gaps that predate the update wait. They are fixed separately.
