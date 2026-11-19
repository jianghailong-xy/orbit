# Session state: three activity states and the facts beside them

Status: **D1, D5 and D8 decided as recommended by the owner on 2026-11-19; D2, D3, D4, D6 and D7
still open**. Written 2026-11-19 against commit `a1282659a4`.
If accepted it replaces §2.1 of [session-lifecycle-design.md](session-lifecycle-design.md).
The complete list of read sites is in
[session-three-state-read-sites.md](session-three-state-read-sites.md) (442 rows).

## 1. Summary

The owner's proposal: a session has three states, `PENDING`, `RUNNING` and `IDLE`.
`SUCCEEDED`, `FAILED` and `ENDED` are not states of the session; they belong to the task or to
whatever else depends on the session.

The inventory supports most of that and corrects one part.

- **Supported.** `SUCCEEDED`, `FAILED`, `CANCELLED` and `INTERRUPTED` are outcome labels that
  other things have written onto the session: the last turn's result, a task's result, the act
  that ended the run. No behaviour needs the session itself to be "succeeded".
- **Corrected.** Underneath those four labels there is one fact that *is* the session's own:
  **released**. A released session is idle, no runner holds it, it no longer holds its task's
  claim or a project slot, and the next message has to be claimed by a runner again. An idle
  session that is still held is a different thing, and 173 of the 442 inventory rows read that
  difference, including a unique database index that prevents a task from running twice.

So the real shape is three activity states plus one companion fact, which makes four
distinguishable situations: queued, running, idle and held, idle and released. Whether
"released" is spelled as a fourth status value or as a column beside three values is a naming
choice (decision D1). What the redesign removes either way is the outcome vocabulary.

The change is large: 187 rows have to read or write a new home, and three kinds of deployed
software (Apple apps, Android apps, runners) break on a new status word. It can be staged so
that every stage is useful by itself and the wire never changes under an old client (§8).

A separate review (§11) found that the status also misclassifies sessions today, most often
by calling a session idle while a background job, a subagent or a self-started turn is still
running. Renaming `AWAITING_INPUT` to `IDLE` would carry that bug into the new design.

## 2. What exists today

One stored column, five modifiers, four derived enums.

| Layer | Field | Values |
|---|---|---|
| Stored | `session.status` (`run_status`) | `PENDING`, `RUNNING`, `AWAITING_INPUT`, `INTERRUPTED`, `SUCCEEDED`, `FAILED`, `CANCELLED` (plus the dead label `PARKED`) |
| Modifier | `endReason` | `task_done`, `task_cancelled`, `ended`, `completed`, `deleted`, `cancelled` |
| Modifier | `cancelRequestedAt` | an end was requested |
| Modifier | `retryAt` | a retry is armed |
| Modifier | `finishedAt` | written with a terminal status, cleared on revive |
| Modifier | `completedAt` / `archivedAt`, `deletedAt` | filed, trashed |
| Derived | `runState` | `QUEUED`, `RUNNING`, `AWAITING_INPUT`, `INTERRUPTED`, `SUCCEEDED`, `FAILED`, `ENDED` |
| Derived | `lifecycleState` | `OPEN`, `COMPLETED`, `TRASH` |
| Derived, legacy | `sessionState` | ten values |
| Derived, legacy | `filingState` | `OPEN`, `ARCHIVED`, `TRASH` |
| Derived | `capabilities` | `canSend`, `canResume`, `resumeBlockedReason`, `canComplete`, `canRestore` |

Every session payload carries `status`, `runStatus`, `runState`, `sessionState`,
`lifecycleState` and `filingState` together (`src/apiserver/src/sessions/session-state.ts:99`).

## 3. What the seven values really carry

| Value | What it says | Whose fact it is |
|---|---|---|
| `PENDING` | a turn is queued for a runner | session activity |
| `RUNNING` | a turn is executing | session activity |
| `AWAITING_INPUT` | idle, and a runner still holds it | session activity + held |
| `INTERRUPTED` | idle and held; the last turn was stopped by a person | activity + the turn's outcome |
| `FAILED` | released; the last turn failed (or the runner was lost, or setup failed) | released + the turn's outcome |
| `SUCCEEDED` | released; its task finished, its landing settled, or the engine exited cleanly | released + the work's outcome |
| `CANCELLED` | released; someone ended it on purpose | released + the cause |

Evidence that the terminal values are not terminal and not the session's own outcome:

- Every terminal session can be resumed. The revive resets `status` to `PENDING` and clears
  `endReason`, `finishedAt`, `error`, `result` and `completedAt` in one write
  (`src/apiserver/src/sessions/sessions.service.ts:10942`).
- A failed turn writes `FAILED` because otherwise "the failure is invisible until you open the
  session", and the same comment says "the session stays resumable, so retrying is still one
  message away" (`src/apiserver/src/runner-api/runner-api.controller.ts:7250`). The turn itself
  has no outcome field: `ConversationTurn.status` is `PENDING | IN_FLIGHT | ANSWERED | HELD`.
- At finalize, a session being ended becomes `SUCCEEDED` only when its `endReason` is
  `task_done` (`gracefulEndStatus`, `src/shared/src/enums.ts:238`).
- The runner already hides engine presence: an idle session with a warm engine and one with no
  engine are both `AWAITING_INPUT` (`src/runner-go/session_pool.go:61`).

That one failed-turn write is three facts at once: the turn's outcome, the release of the
runner's hold, and the reclaim of the slot. It also sets `cancelRequestedAt` only to make the
runner tear the engine down (`runner-api.controller.ts:7810-7832`).

## 4. Proposed model

### 4.1 Activity

| State | Meaning |
|---|---|
| `PENDING` | a turn is queued, waiting for a runner to claim it |
| `RUNNING` | a turn is executing |
| `IDLE` | nothing queued or running |

### 4.2 The facts beside it

| Fact | Proposed home | Replaces |
|---|---|---|
| **Released**: no runner holds the session; it holds no task claim and no slot; the next message must be claimed again | `releasedAt` on `session` (null while held). Must be a column on `session`, because a partial unique index reads it. `finishedAt` is nearly this already; see §9 | "status is terminal" |
| **Release cause**: why the hold ended | `releaseCause` on `session`: today's `endReason` values plus the causes that have no `endReason` today (turn failed, runner lost, setup failed, engine exited) | which terminal value, and `endReason` |
| **Last turn's outcome** | an outcome and error on `ConversationTurn`; a copy on `session` for list rows | `FAILED` and `INTERRUPTED` as a status, `session.error` |
| **Work outcome** | the record of the work: task status and verdict, `ScheduleRun.state`, `SubagentRun.status`, `project_landing.settled_as`, and `TaskAttempt` if it is switched on (D5) | `SUCCEEDED` / `FAILED` / `CANCELLED` read as a result |
| **End in progress** | `cancelRequestedAt`, unchanged | same |
| **Retry armed** | `retryAt`, unchanged, on a released session | `FAILED` + `retryAt` |
| **Filed, trashed** | `completedAt`, `deletedAt`, unchanged | same |

Invariant: a released session is always `IDLE`. Sending to it clears `releasedAt` and makes it
`PENDING` in one write, as the revive does today.

### 4.3 Today's rows in the new model

| Today | Activity | Released | Cause | Last turn |
|---|---|---|---|---|
| `PENDING` | `PENDING` | no | | |
| `RUNNING` | `RUNNING` | no | | |
| `AWAITING_INPUT` | `IDLE` | no | | answered |
| `INTERRUPTED`, no `endReason` | `IDLE` | no | | interrupted |
| `FAILED` after a failed turn | `IDLE` | yes | turn failed | failed |
| `FAILED`, runner lost / setup failed | `IDLE` | yes | runner lost, setup failed | failed or none |
| `SUCCEEDED`, `task_done` | `IDLE` | yes | task done | answered |
| `CANCELLED` / `INTERRUPTED` with an `endReason` | `IDLE` | yes | that reason | as it was |

## 5. What the inventory changed in the first sketch

An earlier sketch of this design said: collapse the terminal values into `IDLE`, treat "the
runner let go" as a capability, make `endReason` history, put a retry on hold as `PENDING`, and
read task results from `TaskAttempt`. Reading every site showed five of those are wrong.

1. **Idle-and-held and idle-released are different rows.** Eight live database objects use the
   set `PENDING, RUNNING, AWAITING_INPUT, INTERRUPTED` as "holds its task": the partial unique
   index `session_task_execution_claim_idx`
   (`src/apiserver/prisma/migrations/0130_task_supersession_dispatch_guard/migration.sql:610`),
   six guard functions and the runner acquisition guards. Collapsing terminal into `IDLE`
   without a released column would leave every finished session holding its task's claim and
   its project slot for ever. The same split decides who may run a merge or commit, which
   sessions the reaper sweeps, whether a session can be moved without ending it first, and
   whether the runner makes a permanent commit or an undoable checkpoint
   (`src/runner-go/worktree.go:1071`).
2. **`endReason` is a live fact.** Machine deliveries refuse a session that has ended
   (`sessionHasEnded`, `src/apiserver/src/runner-api/background-job-wake.ts:184`), while a
   scheduled wake-up revives one that failed
   (`src/apiserver/src/runner-api/scheduled-wakeup.worker.ts:443-505`). Three database triggers
   decide "this session has ended" from the status and `end_reason` together (migrations 0350,
   0366, 0507). Two provider gateways issue engine credentials only while `endReason` is null.
   So the cause has to stay a queryable column; it cannot become history.
3. **`TaskAttempt` holds nothing.** Its only insert, `SessionAttemptService.open`
   (`src/apiserver/src/projects/session-attempt.service.ts:130`), has no product caller, so the
   table is empty, and its outcome set has no `CANCELLED`. 38 files under `projects/` and
   `tasks/` read the session's terminal status as the task's result today. The task code also
   states a rule the first sketch would have broken: a released session is the record of one
   finished attempt, and a new attempt gets a new session
   (`src/apiserver/src/tasks/tasks.service.ts:15262`). Retry limits and model escalation count
   released `FAILED` sessions per task.
4. **A retry on hold is not `PENDING`.** A `FAILED` session with `retryAt` holds no claim, is
   not claimable by a runner, counts against no slot budget and can still be sent to by a
   person. A `PENDING` row is the opposite on all four. The retry also exists in a second
   spelling, `AWAITING_INPUT` with `retryAt`, which is deliberately not announced as a failure
   (`src/apiserver/src/sessions/auto-retry.service.ts:2054`). The hold stays where it is:
   `retryAt` on an idle session.
5. **A plain conversation has no other record.** A session with no task, schedule or subagent
   that the runner finalizes as `SUCCEEDED` shows a green "Succeeded", rings the "Finished"
   push (`src/apiserver/src/push/settle-alert.ts:61`) and satisfies the published wait
   condition `SESSION_RUN_TERMINAL`. Nothing else carries that outcome (D2).

Two smaller points:

- `cancelRequestedAt` is not only "an end in progress". Turn-complete and the reaper set it on
  rows they have already released, to tell a runner to stop.
- `finishedAt` is read as a work fact: the landing queue waits for every work session to have
  it (`src/apiserver/src/projects/project-integration-job.ts:741`).

## 6. Inventory

### 6.1 Method and codes

A `git grep` over `src/` for the session-state vocabulary gave 2,324 product lines in 337
files, and 5,636 lines in 945 test files. Seven readers then classified every product file in
their area, added the sites the pattern missed (bare literals, raw SQL, enum cases in Swift and
Kotlin), and replayed all 588 migrations to find the database objects still live. The result
is 442 rows: 425 files and 17 database objects.

Facts a row reads or writes:

| Code | Meaning | Rows |
|---|---|---|
| `ACT` | activity only: queued, running, idle | 164 |
| `REL` | terminal as "no runner holds it": resume gate, live sets, slots, claims, cleanup | 173 |
| `TURN` | the last turn's outcome and error | 92 |
| `WORK` | a task, schedule run, subagent, landing or handoff result read off the status | 37 |
| `RETRY` | `FAILED` + `retryAt`, auto-retry, quota hold | 76 |
| `CAUSE` | `endReason` | 40 |
| `ENDING` | `cancelRequestedAt` | 40 |
| `LIFE` | filed or trashed only | 99 |
| `SHOW` | display only | 67 |
| `WIRE` | a type, decoder or pass-through | 80 |
| `NONE` | false positive | 59 |

What the change means for a row:

| Code | Meaning |
|---|---|
| `MOVE` | must read or write a new home |
| `COMPAT` | a legacy wire field or decoder that has to keep working |
| `RENAME` | mechanical: a terminal value becomes idle, or `AWAITING_INPUT` is renamed |
| `SAME` | untouched |

### 6.2 Counts

| Area | Rows | New home | Wire only | Rename | Untouched | False positive |
|---|---|---|---|---|---|---|
| Database objects live at HEAD | 17 | 14 | 0 | 1 | 2 | 0 |
| apiserver: sessions, realtime, queue, runners, managed-runners | 24 | 17 | 3 | 1 | 2 | 1 |
| apiserver: runner-api, schedules, watches, providers and the rest | 54 | 38 | 0 | 7 | 7 | 2 |
| apiserver: projects, tasks, task-lists | 64 | 38 | 1 | 1 | 17 | 7 |
| shared package | 11 | 1 | 5 | 2 | 2 | 1 |
| Web client | 52 | 20 | 2 | 9 | 15 | 6 |
| Published contracts | 9 | 0 | 2 | 0 | 0 | 7 |
| Scripts | 29 | 16 | 0 | 9 | 0 | 4 |
| Apple clients (OrbitKit, macOS, iOS) | 79 | 21 | 10 | 12 | 28 | 8 |
| Android client | 66 | 20 | 5 | 9 | 13 | 19 |
| Runner (Go) | 31 | 2 | 7 | 3 | 17 | 2 |
| Link gateway | 6 | 0 | 0 | 1 | 3 | 2 |
| **Total** | **442** | **187** | **35** | **55** | **106** | **59** |

"New home" counts every row marked `MOVE`, including 14 that are also `COMPAT`. 38 rows write
the status or one of its modifiers.

### 6.3 Where a terminal status is written

| Site | Writes | Trigger |
|---|---|---|
| `apiserver/src/runner-api/runner-api.controller.ts:7818` | `FAILED`, `finishedAt`, `cancelRequestedAt` | the runner reports a failed turn |
| `apiserver/src/runner-api/runner-api.controller.ts:9824` | `SUCCEEDED` / `FAILED` / `CANCELLED`, `finishedAt` | runner finalize; the value is the runner's, or the end reason's when an end was requested |
| `apiserver/src/runner-api/runner-api.controller.ts:10234` | `FAILED`, `deletedAt` | a transcript import failed |
| `apiserver/src/realtime/reaper.service.ts:890` | `FAILED`, `CANCELLED` or `SUCCEEDED` | six cases: cancel not honoured, cancel on a queued row, an unacknowledged graceful end, runner offline, runtime never initialized, an idle task session whose last reply is an API error |
| `apiserver/src/sessions/sessions.service.ts:9731` | `CANCELLED` | end, complete or delete of a queued session |
| `apiserver/src/projects/landing-session.ts:256`, `:373` | `SUCCEEDED` or `CANCELLED` | a landing container is created settled, or settles |
| `apiserver/src/projects/session-source.ts:692` | `FAILED`, `finishedAt` | the runner refuses the source |
| `apiserver/src/sessions/sessions.service.ts:10942` | back to `PENDING` | the revive: a person, an agent, the auto-retry sweep, merge repair, a scheduled wake-up |

The runner sends `SUCCEEDED`, `FAILED` or `INTERRUPTED` on turn-complete (and `CANCELLED` from
two engines), and `SUCCEEDED`, `FAILED` or `CANCELLED` on finalize
(`src/runner-go/session.go:1911`).

### 6.4 The hardest sites

1. **One live run per task.** The unique index at migration 0130:610 and its mirrors in code:
   `tasks/reclaim-stalled-task.ts:15`, `projects/live-session-status.ts:8`,
   `projects/criterion-move.ts:69`, `tasks/tasks.service.ts:14945`. Dispatch states the index
   predicate in `ON CONFLICT ... WHERE`, so an old replica fails every dispatch once the
   predicate changes; 0130:596-609 documents the two-phase swap this needs.
2. **Dispatch sweeps in raw SQL.** `tasks/tasks.service.ts:1364-1587`, `:11767`, `:12257`,
   `:15225-15298`, and `sessions/task-work-carrier.ts:91-131`, which is spliced into every
   reader of "is this task being worked on".
3. **The claim.** `queue/queue.service.ts:468-741`: `status = 'PENDING' AND
   cancel_requested_at IS NULL` is the whole dispatch predicate, and slot counts read
   `status = 'RUNNING'`. This part is unchanged by the redesign and must stay so.
4. **Retry and its brake.** `sessions/auto-retry.service.ts` compares-and-sets on the parked
   status in five places; `tasks/tasks.service.ts:13025-13144` counts released failures per
   task; `tasks/task-route-decision.ts:397` escalates the model after one.
5. **Turn-complete and finalize.** `runner-api/runner-api.controller.ts:7257-7868` and
   `:9703-9968`: billing, retry arming, task reclaim and check settlement all hang off the one
   status write. About 25 further lease gates in that file use `OPEN` / `LIVE` / `TERMINAL`
   sets.
6. **Verification gate.** `tasks/verification-dependency.ts:379-428`: a pass needs
   `SUCCEEDED` + `end_reason = 'task_done'` + filed, in SQL spliced into dispatch.
7. **Stored and published grammar.** The watch leaves `SESSION_RUN_TERMINAL` and
   `SESSION_TURN_SETTLED` (`watches/watch-predicate.ts:155`, `contracts/watch.contract.json`)
   are stored on watch rows and published to agents. `session_request.close_reason` stores
   `status || ':' || end_reason`.

## 7. Constraints from deployed software

| Who | What breaks on a new status word | Source |
|---|---|---|
| Shipped Apple apps | `RunStatus` has no unknown case and `status` is required, so one row with a new value fails the whole session list | `macos/OrbitKit/Sources/OrbitKit/Models/Enums.swift:7`, `Net/APIClient.swift:254` |
| Shipped Apple apps | the raw status, not `capabilities`, picks `/resume` or `/turns`, stops the wait after End, and fires the finished notification | `App/Composer.swift:133`, `App/SessionWorkspaceMove.swift:125`, `App/Notifications.swift:48` |
| Shipped Android apps | an unknown status reads "Ended"; sending is safe only when `capabilities` is present; the push is dropped unless the status is exactly `SUCCEEDED` or `FAILED` | `SessionLine.kt:204`, `composer/ComposerData.kt:648`, `push/PushAuthority.kt:98` |
| Deployed runners | a reclaimed row whose status is not one of the four live words gets no supervisor, so `IDLE` would drop every idle session at a runner restart | `runner-go/runloop.go:696` |
| Deployed runners | a failed turn must be answered with a terminal status, and finalize must send one | `runner-go/session.go:727`, `runner-api.controller.ts:9703` |
| Agents | `session_list` and the CLI `--status` flag list all seven values; `session_await` waits on "run terminal" | `runner-go/operation_catalog.go:2786`, `runner-go/session_cli.go:581` |
| Postgres | an enum label cannot be dropped. Retiring four values leaves five dead labels, or needs a rewrite of `session` under an exclusive lock. Renaming `AWAITING_INPUT` breaks every function body that names it | migration 0071 declined the rewrite for `PARKED` |

Consequence: `status` on the wire and in storage keeps its seven words for as long as old
builds and runners exist. The new model arrives as new fields, and `status` becomes a
projection of them.

## 8. Stages

Each stage ships alone and leaves the system consistent. Nothing before stage 6 changes a
value an old client reads.

1. **Turn outcome.** Add the outcome and error to `ConversationTurn` and the copy on
   `session`. Turn-complete writes both. Additive.
2. **Release fact.** Add `releasedAt` and `releaseCause` (or adopt `finishedAt`, §9), written
   by the eight writers in §6.3 and cleared by the revive. Backfill from `status` and
   `endReason`.
3. **Server readers.** Move the `REL` readers to the release fact, the `TURN` readers to the
   turn outcome, and the `WORK` readers to the work's own record. Replace the six guard
   functions and three ended-triggers, then swap the unique index in two phases. After this
   stage no server code asks which terminal value a session has.
4. **Wire.** Add `activity`, `released`, `releaseCause` and `lastTurnOutcome` to every session
   payload and to the agent contract. Web, Apple and Android read the new fields. The old
   fields keep being sent, unchanged.
5. **Runner protocol.** A new runner reports a turn's outcome and a release as two things. The
   server accepts both protocols.
6. **Storage, later and optional.** Store three values in `status`. This needs a minimum
   client version and a minimum runner version, and pays the enum cost in §7. Once stages 1 to
   5 are done the stored column is only a compatibility projection, so the remaining benefit
   is small. Recommendation: decide after stage 5, not now (D6).

## 9. Decisions for the owner

Decided on 2026-11-19, each as recommended below: **D1**, **D5** and **D8**. The others are open.

- **D1. Four situations, not three.** Accept that "released" is the session's own fact, kept
  beside three activity states. Recommended: yes, as a column, so that the status says only
  what the session is doing.
- **D2. A plain conversation that "succeeded".** With no task behind it, what should the green
  "Succeeded" and the "Finished" push mean? Options: the last turn was answered and the engine
  exited; or drop the word for plain conversations and show "Ended". Not recommended either
  way until it is known when a runner finalizes a plain session as `SUCCEEDED`.
- **D3. Failed badge.** A session whose last turn failed keeps a visible "Failed" mark in
  lists, drawn from the turn outcome. Recommended: yes.
- **D4. Machine wake-ups.** Keep today's rule, expressed on the cause: a released session
  refuses machine deliveries, except that a scheduled wake-up revives one released by a failed
  turn with no retry armed. Recommended: keep.
- **D5. Where a task's result lives.** Either switch `TaskAttempt` on (open at dispatch, close
  at release, add `CANCELLED`, backfill history for the retry counts and the routing report),
  or have task code read `releaseCause` and the turn outcome on the session that carried the
  attempt. The second is far smaller and keeps "one released session is one finished attempt".
  Recommended: the second now; `TaskAttempt` as its own project.
- **D6. Storage collapse.** Defer the decision to after stage 5.
- **D7. Published wait condition.** `SESSION_RUN_TERMINAL` keeps its name and comes to mean
  "released". Recommended: yes; renaming it breaks stored watches.

- **D8. Does `RUNNING` include work outside a turn?** Today the status is `AWAITING_INPUT`
  while a background job, a subagent or a turn the engine started for itself is still going,
  and seven readers each patch that differently (§11). Recommended: the `activity` that
  people and agents see is computed from one shared definition and reads `RUNNING` while
  anything is executing for the session; the scheduler keeps reading turns, because a slot
  is held by a dispatched turn only.

## 10. What was not verified

- The classification was done by seven parallel readers. Their key claims were spot-checked
  against the source (the unique index, the empty `TaskAttempt`, the strict Swift enum, the
  runner's reclaim fence and terminal-answer rule, `sessionHasEnded`, the settle alert). The
  other rows were not re-read.
- The largest files were read around their status sites, not end to end:
  `sessions.service.ts`, `runner-api.controller.ts`, `tasks.service.ts`,
  `projects.service.ts`, `WorkspaceView.tsx`, `ConsoleModel.swift`.
- Which database objects are live comes from replaying the migration files, not from a real
  database catalog. Triggers in migrations 0350, 0352 and 0366 were read by one reader only.
- Whether `finishedAt` is set by every terminal write and by nothing else was not audited. If
  it is, it can be the release column and stage 2 needs only `releaseCause`.
- When a runner finalizes a plain conversation as `SUCCEEDED` was not traced (D2).
- Nothing was built or run; this is a reading of the code.

## 11. Review: where the status misclassifies a session

Added 2026-11-19 after the owner's example: a session with a background process running is
counted as `AWAITING_INPUT`, which would be `IDLE` in the new design. The example is right and
it is one of seven kinds. All of it is from reading the code at `a1282659a4`; none of the
failures below was reproduced.

### 11.1 The cause

`status` moves only when a turn is dispatched through the inbox and when the runner reports
that turn complete. Three kinds of work never pass through either, so the session stays
`AWAITING_INPUT` for their whole life:

- a turn the engine starts for itself (a background task reporting in, the engine's own
  wake-up): `Session.engineTurnActive` (`src/apiserver/src/common/session-generating.ts:4-9`);
- a subagent still running after its parent's turn ended: `Session.runningSubagents`;
- a background job or shell: `Session.runningBgJobs`, `runningBgJobActivity`,
  `runningBgShells`.

A fourth case is a session that ended its turn to wait: a watch from `task_await` /
`session_await`, a scheduled wake-up, an armed retry. Nothing is executing, but the session
is not waiting for a person either.

The code knows this. `src/apiserver/src/sessions/task-work-carrier.ts:11-21` records the
incident of 2026-10-02: a work session at `AWAITING_INPUT` with a job running, its task
offered in the Run queue as ready, and Run handing the whole task brief to the waiting
session as a new turn. The fix there, and every fix since, was a new hand-written predicate
beside the status.

### 11.2 Seven answers to "is this session working?"

| Reader | Dispatched turn | Engine's own turn | Subagent | Background job | Background shell | Waiting to be woken |
|---|---|---|---|---|---|---|
| `status`, the claim, slot counts | yes | no | no | no | no | no |
| `isSessionGenerating`: the "working" wording, which approvals are collected, account moves (`common/session-generating.ts:17`) | yes | yes | no | no | no | no |
| Workspace rail "working" tally (`sessions/sessions.service.ts:3858`) | yes | yes | yes | separate mark, only while the job wrote output in the last 10 minutes | no | no |
| Task carrier: is the task running, may Run start it (`sessions/task-work-carrier.ts:46`) | yes | yes | yes | yes, any job | no | yes |
| Managed runner sleep (`managed-runners/managed-runner-work.ts:57`) | yes | yes | yes | yes | yes | only when already due |
| Approval alert and the Needs-you badge (`push/push.service.ts:301`, `:1637`) | yes | no | yes | no | no | no |
| `session_await` default, `session_create(wait)`, spawn-tree allowance (`watches/watch-predicate.ts:266`, `common/session-scheduling.ts:27`) | yes | no | no | no | no | no |

Seven readers, six different sets. Each row is defensible alone; together they mean the same
session is working on one screen and idle on another.

### 11.3 Wrong results that follow

1. **A parent is told its child has settled while the child is still working.**
   `SESSION_TURN_SETTLED` is `status` not in `PENDING, RUNNING`
   (`watches/watch-predicate.ts:266-272`). A child that ended its turn to wait for its own
   background job or subagent satisfies it at once, so `session_await` and
   `session_create(wait)` hand the parent an unfinished result.
2. **A card nobody is told about.** `notifyApprovalRequest` returns unless the session is
   `RUNNING` or has a running subagent (`push/push.service.ts:296-309`), and the Needs-you set
   has the same two cases (`:1634-1668`). An approval raised by a background job, or during a
   turn the engine started itself, on an `AWAITING_INPUT` session sends no alert and is not in
   the badge. `session-generating.ts:12-13` says such a prompt "needs answering exactly as
   much". Sessions with an owner item reach the badge another way (`readOwnerItemSessionIds`).
3. **A scheduled run can land while its session still has a job running.** `landRun` treats
   `AWAITING_INPUT` as "the turn is over, land" (`schedules/schedule-runs.service.ts:685-691`)
   and reads none of the background sets. Only that gate was read.
4. **A lost runner fails only `RUNNING` sessions.** `runnerOfflineIsFatal`
   (`common/session-scheduling.ts:138`) leaves an `AWAITING_INPUT` session alone as "idle,
   consumes no slot" (`realtime/reaper.service.ts:532-535`). If that session had a job or a
   subagent on the lost machine, its sets are cleared only when the session leaves the open
   statuses (`sessions/running-work.ts`), so its task can keep reading as running with nothing
   left to wake it. Whether a restarted runner reports those jobs as ended was not traced.
5. **One job, two verdicts.** The task carrier counts any job in `runningBgJobs`; the session
   row and the workspace rail count only jobs that wrote output in the last ten minutes
   (`sessions/background-job-activity.ts`). After ten quiet minutes the task says running and
   the session says idle. The carrier's "stalled" flag exists to soften this
   (`task-work-carrier.ts:153-169`).

### 11.4 The other kinds

| The status says | What is true | Where |
|---|---|---|
| `RUNNING` | the turn is blocked on a person: an approval or a question is open. It holds a slot and counts as running; the wait is an overlay from `pendingApprovals` | `push/push.service.ts:1637` |
| `AWAITING_INPUT` | a coordinator conversation waiting for the owner's answer, shown through owner items | `push/push.service.ts:1630` |
| `PENDING` | nothing will claim it: the account or dispatch is paused, the runner is offline or draining, a region stop | `runner-api/runner-api.controller.ts:5648`, `:5693`, `:7224` |
| `AWAITING_INPUT` | a landing container with no engine and no turns, parked for as long as its landing is open; the watch grammar special-cases it | `watches/watch-predicate.ts:268-271` |
| `AWAITING_INPUT` | a quota-stopped turn with a retry armed | `sessions/auto-retry.service.ts:2054` |
| `FAILED` | nothing in the session failed: a message was not delivered and is reported `FAILED` so the list shows it; or the reaper read an API error in an idle task session's last reply | `runner-go/claude_delivery.go:376`, `realtime/reaper.service.ts:657` |

### 11.5 What the new design has to do about it

Renaming `AWAITING_INPUT` to `IDLE` fixes none of this, and makes the first kind read worse:
"idle" is a stronger claim than "awaiting input".

- **One definition, on the server.** `activity` is computed in one place and every reader in
  §11.2 except the scheduler uses it: `RUNNING` while a dispatched turn, an engine turn, a
  subagent or a background job is executing; `PENDING` while a turn is queued and nothing is
  executing; `IDLE` otherwise.
- **The scheduler reads turns.** A runner slot is held by a dispatched turn. The claim and
  slot counts read that fact and nothing wider, so a background job never blocks dispatch.
- **Why idle, as its own fact.** An idle session is waiting on a person, waiting to be woken
  (watch, timer, retry), or on hold (pause, runner offline). A `RUNNING` one may be waiting on
  a person too. That is one more field, `waitingOn`, and it replaces the overlays.
- **The background sets must become exact first.** They are inferred today: an id goes in
  when a launch is seen and out when an end is reported, and the ten-minute freshness rule
  exists because that drifts. A state that people and agents rely on cannot rest on them
  until the runner's beat states the full set each time, as it already does for the sessions
  whose jobs hold slots (`runners/runner-background-holders.ts`).
- **A new wait condition for agents.** `SESSION_TURN_SETTLED` is stored on watch rows and
  published, so it keeps its meaning. `session_await` needs a second condition, "nothing
  executing and nothing armed to wake it", and should default to it.

This belongs before stage 4 of §8: the wire field `activity` should be born with the one
definition, not with the turn-only one. The three diagrams drawn from this document predate
this section and show `RUNNING` as "a turn is executing".
