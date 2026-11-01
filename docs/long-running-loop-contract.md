# Long-running loops that do not break silently: contract (v1)

**Status:** the interface source for every task of project `34pUaJboWdDFzjftkEso8` ("Long-running loops that do not
break silently"). Task A1 wrote this file from the project's instructions; it is the English text of their two
sections, "why it is designed this way" and "contract". §1 also records how the server side was built (A1), in the
places downstream tasks read it. A change to the semantics below changes this file first.

| What | Where |
| --- | --- |
| Migration | `src/apiserver/prisma/migrations/0458_session_wakeup_loop` |
| Model | `src/apiserver/prisma/schema.prisma`: `SessionWakeupLoop`, `SessionScheduledWakeup.loopId` |
| Runner door | `POST /api/runner/sessions/:id/scheduled-wakeup` (`runner-api/runner-api.controller.ts` `scheduledWakeup`) |
| Loops, ticks, the wake block | `src/apiserver/src/runner-api/scheduled-wakeup.ts` |
| Tick delivery | `src/apiserver/src/runner-api/scheduled-wakeup.worker.ts` |
| The dead-man signal (C2) | `scheduled-wakeup.worker.ts` `signalIfSilent`, `signalDropped`; `src/apiserver/src/push/push.service.ts` `notifyLoopMissed` |
| Scheduling truth (C1) | `scheduled-wakeup.ts` `readSessionWakeups`, read by `sessions.service.ts` `getForOrchestration`; `src/apiserver/src/watches/watches.service.ts` `named` (`deadLetterCount`); `src/runner-go/watch_tools.go` `watchSummary` |
| The owner's Stop | `src/apiserver/src/sessions/sessions.service.ts` `interrupt` |
| A queued wake turn taken away unrun (task F) | `src/apiserver/src/runner-api/wake-turn-withdraw.ts` `settleUnrunWakeTurns`, `signalDrainedWakeups`; called by `ReaperService.forceFinalize`, `runner-api.controller.ts` `turnComplete` and `finalize`, `SessionsService.transitionEnd`, `interrupt` and `cancelQueuedTurn` |
| Specs | `src/apiserver/src/runner-api/scheduled-wakeup-loop.pg.spec.ts`, `scheduled-wakeup.pg.spec.ts`, `wake-turn-drain.pg.spec.ts`; `src/apiserver/src/realtime/reaper-push-wiring.spec.ts` |

## Why it is designed this way

Measured on the production database over 30 days, on 2026-10-31.

- 5342 wakeups. From due to a turn being created took at most 7 seconds: the timer itself is reliable. From the turn
  being created to the turn being handed to the engine took 28 seconds on average and 6.9 hours at most, and five
  took over 2 hours, with no signal at any point. Some of those may be ordinary waits queued behind a long turn;
  they were not checked one by one.
- 15 wakeups were DROPPED, 7 of them on sessions that were revived later. Session `01a005f5` broke silently for
  21 hours on 10-05 this way: its wakeup came due while the session was FAILED, and `ScheduledWakeupWorker.deliver`
  dropped it without a word.
- The sweeper v1's context filled up, its turn FAILED, and the relay broke. `schedule_wakeup` itself once timed
  out three times in a row.
- The 2700-second migration loop from the requirement is not in this database; that incident itself was not
  located.

Conclusion: whether a tick was missed is judged by whether its turn was handed to the engine
(`conversation_turn.delivered_at`), not by whether it was queued.

## 1. Loop (server A1, runner A2)

### 1.1 Tool and wire

The tool: `schedule_wakeup({recurring: true, everySeconds, prompt, reason?, until?, delaySeconds?})`. Parameters are
camelCase, like `delaySeconds` and `ttlSeconds`.

- `everySeconds`: range [60, 86400]. A value outside it is clamped into it, and the receipt says so.
- `prompt`: required. `reason`: may be left out.
- `until`: ISO 8601. Seven days out by default, thirty days out at most.
- `delaySeconds`: the first tick's delay; `everySeconds` by default.
- `stop: true`: idempotent. It cancels the waiting one-shot wakeup and the loop together, and the receipt gives the
  two counts separately.

The runner sends the same body to `POST /api/runner/sessions/:id/scheduled-wakeup`. As built:

- `delaySeconds` of a loop is clamped to [60, 86400] like `everySeconds`. Both are rounded to whole seconds first.
- An `until` later than thirty days out is clamped to thirty days out. An `until` earlier than the first tick's due
  time is refused with 400 (`until (...) is before the first tick (...)`). So is a loop with no `prompt`, and a
  request that sends `everySeconds` or `until` without `recurring: true`. A refused request writes nothing.
- A one-shot request (`recurring` absent or false) is unchanged: `delaySeconds` and `reason` required, `delaySeconds`
  clamped to [60, 3600], and the same receipt as before.

Receipts. Every id is a public id, as everywhere else on this route.

```text
one-shot:  { outcome: 'SCHEDULED', id, dueAt, delaySeconds, clamped, replaced }
loop:      { outcome: 'SCHEDULED', recurring: true, loopId, id, dueAt, delaySeconds, everySeconds, until,
             clamped, clampedFrom: { everySeconds?, delaySeconds?, until? }, replaced }
stop:      { outcome: 'CANCELLED', cancelled, loopsStopped }
```

- For a loop, `id` and `dueAt` name its first tick, `until` is the end it will keep, `clampedFrom` holds the value
  asked for of each field that was clamped, and `replaced` says whether a running loop ended (REPLACED) for it.
- For a stop, `cancelled` counts one-shot wakeups (0 or 1) and `loopsStopped` loops (0 or 1). A second stop answers
  zeros.
- Version skew: the server is deployed first. An old runner never sends `recurring`, so nothing it does changes.
  The API strips fields it does not know, so an old server answers a new runner's loop request with a one-shot
  receipt (no `recurring`, no `loopId`) or a 400: the runner (A2) must report that as an error, not as a loop.

### 1.2 Model

A new table, `session_wakeup_loop` (migration 0458), one row per loop. `session_scheduled_wakeup` gains `loop_id`.
The loop is a generator, and a tick is an ordinary wakeup row: an ACTIVE loop always has exactly one PENDING tick.
That is why `WAKE_SOURCES`, `hasPendingWakeSource`, `DUE_WAKEUP`, `settleUnrunWakeTurns` and
`foldQueuedWakeTurnsInto` need no change: they see a waiting tick as a waiting wakeup.

- `session_scheduled_wakeup_one_pending_key` now constrains only `loop_id IS NULL` rows, and a second partial unique
  index holds `(loop_id) WHERE state = 'PENDING'`. A third, `session_wakeup_loop_one_active_key`, holds
  `(session_id) WHERE state = 'ACTIVE'`: a session has at most one ACTIVE loop, and a new recurring request replaces
  the old one. A one-shot `scheduleWakeup` and a loop never replace each other. A plain index
  `(loop_id, due_at) WHERE loop_id IS NOT NULL` serves the block's look-back (§1.5).
- Loop columns: `state` (ACTIVE, ENDED), `every_seconds`, `prompt`, `reason` (nullable), `first_due_at`,
  `until_at`, `ticks_fired`, `ticks_missed`, `revive_streak` (§1.3), `ended_reason`, `ended_at`, `alerted_at`
  (C2's), and `created_at`. An ENDED loop has both `ended_reason` and `ended_at`; an ACTIVE one has neither (a
  CHECK).
- A tick row carries `loop_id`, its `due_at` and `delay_seconds` (from when it was written to when it is due), and
  the loop's `reason` (or ''). Its `prompt` stays NULL: the block reads the prompt from the loop.
- Tick states: PENDING; DELIVERED (filed onto the wake turn named by `client_turn_id`); DROPPED (its due time
  passed without a run: a FAILED session, a refused revive, a late worker, the session had ended, or the queued
  turn it was filed onto was drained unrun as its session's run ended); CANCELLED (a stop, a replacement or the
  owner's Stop took the waiting tick, or a withdrawal or an interrupt took the queued turn it was filed onto).
- `ticks_fired` counts ticks that became a run of their own. `ticks_missed` counts due times that did not: skipped
  slots, dropped ticks, and ticks folded into a queued turn that already carried this loop's tick. Every due time
  is one or the other, except the tick that ends the loop with its session.
- A tick counts as fired from the moment it is filed onto a turn of its own. When that turn is then taken off the
  queue, or answered, without ever being handed to the engine, the tick did not run after all, and it moves from
  fired to missed in the same transaction: one per loop and turn, however many of the loop's ticks the turn
  carried, because only the first of them was counted fired. As built (task F, `wake-turn-withdraw.ts`
  `settleUnrunWakeTurns`), that is a turn still PENDING when:
  - a drain answers every queued turn as the session's run ends: the reaper's finalize (`ReaperService.forceFinalize`,
    a runner that died mid-turn), a turn that fails its session (`turnComplete`), the runner's finalize (`finalize`)
    and an end the owner asked for (`transitionEnd`, both branches). The tick is DROPPED;
  - an interrupt or a withdrawal deletes it. The tick is CANCELLED, as before.

  A turn already handed to the engine (IN_FLIGHT) ran: its ticks stay DELIVERED and counted, whatever ends it.
  Each drain settles the wakeups before it answers the turns, inside its own transaction, under the session row it
  holds. Measured by task E: loop B's tick 9 was filed behind the turn its runner was killed in, the reap answered
  that turn with no `delivered_at`, and the tick stayed DELIVERED, so the loop ended at 15 fired and 34 missed when
  14 ticks had run and 35 had not.
- Lock order: every writer that takes a loop and its tick takes the session row first, then the loop row, then
  the tick. createTurn, interrupt and the revive already hold the session FOR UPDATE. The runner door
  (`scheduleWakeup`) and the worker's own drop (`settleLoopTick`) take it FOR KEY SHARE as their first statement:
  the mode and the row the tick insert's foreign key takes anyway, moved earlier, as `common/lock-order.ts` I4 does.
  Taken at the insert instead, it came after the loop row, while createTurn and interrupt hold the session FOR UPDATE
  and then want that loop: a 40P01 cycle. `common/lock-order.ts` lists the table at rank 60.

### 1.3 Tick delivery

All of this is in `ScheduledWakeupWorker`. Fixed rate: the next due time is the previous one plus k × every, the
first slot after now, and the skipped slots count toward `ticks_missed`. What a due tick finds decides what it does:

- **A turn can be filed** (the session is live): the tick is DELIVERED, and the same transaction writes the next
  PENDING tick, through `createTurn`'s `coalesce`. When the queued turn it joins already carries this loop's
  previous tick, `ticks_missed + 1`.
- **FAILED with `retryAt` armed:** the tick is DROPPED, missed + 1, and the next one is written. Recovery is
  AutoRetry's. As built, "armed" means `retry_at` is set, or the sweep claimed the retry less than
  `RETRY_CLAIM_WINDOW_MS` (10 minutes) ago, the moment it is mid-resume.
- **FAILED, not armed, lifecycle OPEN:** the tick revives the session with `sessions.resume`, with its `bg-wake:` key
  (`bg-wake:wakeup:<tickId>`) and an empty content. The tick is settled onto the revive's turn in the revive's own
  transaction (`onTurnWritten`), so the runner's claim writes the block in. A refusal (runner offline, task
  replaced, and so on) counts as missed. When the session is still FAILED after 3 revives in a row that actually
  ran, it is no longer revived: its ticks only count missed, and the loop carries on by itself when the session is
  healthy again. Only revives that ran count: a skip while the retry is armed and a refused revive do not, or an
  outage longer than 3 ticks would use the count up before the runner is back.
  - As built: `revive_streak` counts the revives in a row, with no tick finding the session healthy in between.
    Below 3, a tick that finds the session FAILED with no retry armed revives it, and the revive adds 1; at 3, the
    tick is dropped as missed. An armed skip, a refused revive and a tick held at 3 leave the streak as it is. A
    tick that finds the session live resets it to 0.
  - The revive reads the session again inside its own transaction, under the lock `resume` holds, and goes ahead
    only if the session is still FAILED with no retry armed. Brought back, armed or ended in between, nothing of
    the revive is kept and the next pass decides again; so does a refusal from `resume` while the session is no
    longer FAILED.
- **The session has ended** (Completed, Trash, SUCCEEDED, CANCELLED, or being ended): the loop is ENDED with reason
  `SESSION_ENDED`. As built, the tick is DROPPED, and "being ended" is a session that is not in a terminal status
  with `cancel_requested_at` set. FAILED is read first, because a failed turn sets `cancel_requested_at` to reclaim
  its runner slot and a FAILED session is not ending for it.
- **Anything else:** try again on the next pass; once the tick is more than one interval late, advance it as
  missed. One tick must never hold its loop up. As built, the tick is DROPPED and missed, with the skipped slots
  after it counted too, and the streak left as it was.

A worker pass answers one of these per due row: `DELIVERED`, `DROPPED`, `HELD` (§1.6), `SETTLED_ELSEWHERE`,
`REVIVED`, `MISSED`, `LOOP_ENDED`, `RETRY`.

### 1.4 How a loop ends

End reasons: `REQUESTED` (stop), `REPLACED`, `OWNER_STOP`, `SESSION_ENDED`, `UNTIL_REACHED`. Every end writes its
reason and `ended_at`, and cancels the tick waiting (except `SESSION_ENDED`, which drops the tick that found the
session over, and `UNTIL_REACHED`, which writes no tick after the last).

- The composer's Stop (`interrupt` with `stopBackgroundWork: true`) ends the loop, because a loop is background
  work. It ends inside the interrupt's transaction.
- A plain interrupt (`session_interrupt` included) does not end the loop: it withdraws the tick already queued, and
  the next one comes due as usual.
- The last tick's due time is `min(next, until)`, and its block says it is the last. As built, `until` that passed
  while the worker was late ends the loop with no further tick, every due time up to it counted missed.
- A tick already filed onto a queued turn when its loop ends stays there and is delivered; its block says how the
  loop has since ended.

### 1.5 The wake block

It keeps `<scheduled-wakeup>` and the existing line shapes: the web, OrbitKit and Android parsers read only those
lines and pass over others. A `loop:` line goes between the timing line and the `reason:` line, with the tick
number, the interval, `until`, and how many ticks were missed since the last run. Several ticks of one loop on the
same turn are merged into one entry. The closing sentence becomes: the loop goes on by itself, do not schedule the
next one, and to stop it, use `stop: true`.

As built:

```text
<scheduled-wakeup>
  A tick of the loop you started with schedule_wakeup is due; the control plane opened this turn for it:
    2026-11-01T10:00:00.000Z scheduled 300 seconds out, due 2026-11-01T10:05:00.000Z
    loop: tick 7, every 300 seconds until 2026-11-07T10:00:00.000Z; 2 ticks missed since the last run
    reason: the archive migration
    what you left for this turn:
      advance the migration by one batch
  The control plane recorded this for you; the user did not say it. The loop goes on by itself, so do not schedule its next tick; to stop it, call mcp__orbit__schedule_wakeup with stop: true.
</scheduled-wakeup>
```

- The tick number is counted from the loop's first due time: `ceil((dueAt − first_due_at) / every) + 1`, so the last
  tick at `until` is numbered after the slot before it. A merged entry shows the latest tick on the turn.
- "Missed since the last run" is the tick numbers between this entry's latest tick and the latest tick of the loop
  delivered onto an earlier turn: every due time in between that did not become a run of its own (skipped, dropped,
  folded into this turn, or withdrawn with an interrupt).
- A loop with no `reason` has no `reason:` line. The prompt comes from the loop.
- When the loop has ended by the time the turn is delivered, the `loop:` line says so: `this is its last tick: the
  loop has reached its until`, or `the loop has since been stopped with stop: true`, `... replaced by a newer one`,
  `... stopped by the user`, `... ended with the session`. The "goes on by itself" sentence appears only while the
  loop is ACTIVE.
- A turn carrying a one-shot wakeup and a tick opens with "What you asked for with schedule_wakeup is due" and
  closes with both sentences. A turn with only one-shot wakeups reads exactly as before.

### 1.6 Two more changes

- A one-shot wakeup that comes due while its session is FAILED with `retryAt` armed stays PENDING until the session
  recovers, instead of being DROPPED (A1). As built, the worker's pass leaves such a wakeup out of its page, so a
  long-armed retry takes no batch slot; the wakeup is delivered on the first pass after the session is live again,
  and dropped if the retry is disarmed with the session still FAILED.
- A one-shot wakeup already filed onto a queued wake turn when the session's run ends (the drains of §1.2: the
  reaper's finalize, a turn that fails the session, the runner's finalize, the owner's End) is settled with that
  drain, by the session as the drain has just left it (task F):
  - FAILED with `retryAt` armed: it goes back to PENDING, and is held and delivered as above. As built, it waits as
    a copy of itself, with its reason, prompt, delay, due time and the time it was asked for, and the row filed onto
    the drained turn says SUPERSEDED. The row itself cannot wait again: a wakeup is filed under the turn key
    `bg-wake:wakeup:<its id>`, which the drained turn keeps, and `createTurn` answers a key it has already seen
    with that turn, so the worker would answer DELIVERED on every pass and file nothing.
  - FAILED with `retryAt` armed, and a newer one-shot wakeup is already waiting (asked for while the turn was
    queued): SUPERSEDED, because a newer request replaces a waiting one. The newer one is left as it is. Of
    several one-shot wakeups on the drained turns, only the newest goes back to PENDING; the others are SUPERSEDED.
  - FAILED with no retry armed: DROPPED, and its owner is told (§4).
  - The session ended or is ending (Completed, Trash, SUCCEEDED, CANCELLED, or an end requested): DROPPED, and
    nobody is told, for the reason the worker's own drop gives.

  A background job's wake on the drained turn is deleted, as a withdrawal deletes it, so the next wake under the
  same key does not find it. That the job's exit or stall wake is then lost with the turn is a residual this does
  not change.
- The `hook_bg_guard.go` and `claude_spawn.go` matchers add `CronCreate`, and its refusal points to
  `schedule_wakeup`'s `recurring`. The tool description says that the server schedules ticks, so they need not be
  renewed every turn (A2).

## 2. Stall (task B)

`bg_run({wakeOnStall: {afterSeconds}})`, with `afterSeconds >= 60`. An invalid value makes `bg_run` fail; it is
never ignored silently. The runner decides, at the same layer as `wakeOnOutput`: when `job.lastOutputAt` is older
than the threshold and this stretch of silence has not been reported yet, it sends a wake. Which stretch was
reported is remembered by its `lastOutputAt` value, so new output naturally restarts the clock.

The wake: `trigger: 'stall'`, `wakeId` = `<jobId>:stall:<n>`, with `elapsedMs` and `idleMs` (durations, not
timestamps; `background-job-activity.ts` says why). The server recovers the last output time as
receivedAt − idleMs. Migration 0459 widens `background_job_wake_trigger_check` and adds the columns. A stall does
not steer; it queues the next turn. Exit wins: a stall arriving after the exit is dropped (`StaleBackgroundWake`).

The block uses a new tag, `<background-job-stall>`, not `<background-job-wake>`: an installed older client that
meets a `bgj_` line without a trigger line it knows draws half a broken card, while a new tag leaves the whole
section as an ordinary note.

Three things must be fixed with it:

- `bgJobRecord` persists the stall settings, the counter, `lastOutputAt` and the stretch already reported, so a
  self-update takeover neither repeats nor misses one.
- `tail()`'s first read is not new output. Today a takeover refreshes `lastOutputAt` to the current time with it.
- `deliverWake` tries three times over about 6 seconds, so the roughly 20 seconds of downtime of a deploy can lose a
  wake. The asynchronous path retries until the control plane answers or the session ends (10 minutes at most), and
  exit and output wakes take this path too; the synchronous path of `endHandedOffJob` keeps its current limit.

## 3. Scheduling truth (task C1)

`session_get` (`getForOrchestration`) gains `wakeups`: `next` (dueAt, kind, reason), `lastFiredAt`, and `loop`
(state, everySeconds, until, nextDueAt, lastFiredAt, ticksFired, ticksMissed, endedReason, endedAt). `lastFiredAt` is
derived by joining the tick rows to `conversation_turn.delivered_at`; it is not written to a column of its own.
`watch_list` output gains `nextEvaluateAt`, `lastEvaluatedAt` and the dead-letter count.

As built (task C1):

```text
wakeups: {
  next:        { dueAt, kind: 'ONE_SHOT' | 'LOOP_TICK', reason } | null,
  lastFiredAt: time | null,
  loop:        { state: 'ACTIVE' | 'ENDED', everySeconds, until, nextDueAt, lastFiredAt,
                 ticksFired, ticksMissed, endedReason, endedAt } | null,
}
```

- `next` is the session's waiting wakeup that is due first: its one-shot wakeup or its loop's tick. `reason` is the
  wakeup's own, and null for a tick of a loop that was given none. A wakeup still waiting past its due time, such as a
  one-shot wakeup held for an armed retry (§1.6), is still `next`, with its due time in the past.
- `lastFiredAt` is when a wakeup of the session last fired. Of its DELIVERED wakeups, one-shot or tick, whose turn has
  a `delivered_at`, it takes the latest-due one and reports that turn's `delivered_at`. `loop.lastFiredAt` is the same
  read over the loop's own ticks, which is §4's L (`lastLoopRun`). A wakeup filed onto a turn still queued has not
  fired, and neither has one whose turn was put back in the queue, so while the runner is away both stay where the
  last run left them.
- `loop` is the session's ACTIVE loop, else the last one it started, so an ended loop still shows `endedReason` and
  `endedAt`. It is null when the session never started a loop. `nextDueAt` is its waiting tick's due time, null once
  it has ended. `ticksFired` and `ticksMissed` are the row's counts (§1.2): while a turn waits with nobody to take
  it, the tick that filed it counts as fired and every tick folded into it after that as missed. Once that turn is
  answered or deleted without having run (a drain, an interrupt, a withdrawal), its tick counts as missed too, so
  the two counts say what ran (task F).
- A one-shot wakeup that a drain sends back to waiting for an armed retry (§1.6) is `next` again, with its due time
  in the past.
- `readSessionWakeups` (`scheduled-wakeup.ts`) reads all of it in one statement and writes nothing.
- Every watch view carries `deadLetterCount`: the list, the read of one watch, the needs-attention read, and what a
  create, an edit, a pause, a resume and a cancel answer. It counts the DEAD_LETTER deliveries among its Matches' and
  `expiryDeliveries`, whatever their code. `nextEvaluateAt` and `lastEvaluatedAt` were on the view already. The
  runner-go summary that `watch_list` (and every other watch tool result) prints shows all three. A count that an
  older server does not send is left out of it, not shown as 0.

## 4. Signal (task C2)

Dead-man: whenever a tick comes due, L = the most recent `delivered_at` of this loop (the loop's creation time when
there is none). When `now - L >= max(2 × every, 15 minutes)`, the session has no live IN_FLIGHT turn, and this
failure has not been alerted yet, a compare-and-set on `alerted_at` sends one `PushService.notifyLoopMissed` (the
missed count and the reason: runner offline, session FAILED, or turn queued). `alerted_at` is cleared once delivery
recovers. A one-shot wakeup DROPPED because its session was FAILED is pushed too. A busy turn is not a miss.

As built (task C2):

- L is the `delivered_at` of the turn carrying the loop's latest DELIVERED tick that has one. A tick filed onto a turn
  still queued has not run, and neither has one whose turn was put back in the queue (that clears `delivered_at`).
  The check runs at every due tick before the tick is filed, and not at a tick that ends the loop with its session.
- "Live IN_FLIGHT" is read off the session and its runner: the session is RUNNING, it has an IN_FLIGHT `message` or
  `shell` turn, and its assigned runner is online. `lease_deadline_at` is not used: it is set once when the turn is
  handed out and never renewed, so a long turn outlives it. A turn on a runner that has gone is not running.
- The compare-and-set (`claimLoopAlert`) writes `alerted_at` only while the loop is ACTIVE and `alerted_at` is null or
  older than L, so one caller per silence pushes. The next due tick after a run clears an older `alerted_at`
  (`clearLoopAlert`).
- The missed count is the due times since the last run, this one included: this tick's number minus the last run's
  (minus 0 when the loop never ran). The reason is RUNNER_OFFLINE when the session's runner is not online, else
  SESSION_FAILED when the session is FAILED, else TURN_QUEUED.
- The push is titled with the session's title, routes a tap to the session (`sessionID`), carries no badge, and has
  kind `loop-missed` ("Wakeup loop missed 3 ticks: the runner is offline.") or, for a one-shot wakeup, kind
  `wakeup-dropped` ("Scheduled wakeup dropped: the session failed."). A one-shot dropped because its session ended
  or is gone, or held for an armed retry (§1.6), is not pushed.
- A one-shot wakeup filed onto a queued turn that a drain answers unrun (§1.2) is pushed the same way when the drain
  drops it with its FAILED session, no retry armed (§1.6): `wakeup-dropped`, reason SESSION_FAILED, after the
  drain's transaction commits, once, because only the attempt that committed the drop returns it. A failure to push
  is only logged. The reaper sends it through the PushService RealtimeModule injects
  (`reaper-push-wiring.spec.ts` builds that module and checks); a turn that fails its session and the runner's
  finalize send it through the runner door's.
- The next run of a loop counts a tick dropped by a drain among the ticks missed since the last run, on its `loop:`
  line (§1.5): the last run is read off the DELIVERED ticks only (task F).
- The next turn the loop runs says how many due times were missed, on its `loop:` line (§1.5).

## 5. Watch (task D)

No `poll.command`: the Watch contract says a predicate has no shell in it, and the server has nowhere to run a
command. An external system's stall is caught with `bg_run` running a poll script that prints only when the state
changes, together with `wakeOnStall`; the tool description says so.

A new leaf, `SESSION_JOB_NO_OUTPUT_FOR`: its target is the SESSION that hosts the job (`target_resource_id` is a
uuid and cannot hold a `bgj_` id), its params are `{seconds, jobId?}`, it reads `running_bg_jobs` and
`running_bg_job_activity`, and it is predicateVersion 3. It is wired into `stallDeadline` and scheduled by the
existing `next_evaluate_at`. When the runner stops reporting, the silence grows by itself and the condition holds.
`contracts/watch.contract.json` changes first.

The `predicateVersion` enum in `watch_tools.go` only has 1 today, so an agent cannot reach v2's
`TASK_NO_PROGRESS_FOR`: it opens to [1, 2, 3], and the description adds the leaves.
