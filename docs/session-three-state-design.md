# Session state: three activity states and the facts beside them

Status: **D1, D5 and D8 decided as recommended by the owner on 2026-11-19; D2 and D9 (no failure fact on
the session, §12) decided by the owner on 2026-11-21; D3, D4, D6 and D7 still open**. Written 2026-11-19 against commit `a1282659a4`.
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
| **Release cause**: why the hold ended (*superseded 2026-11-21 by D9, §12: no cause column; `end_reason` says why an end was asked, the turn outcome says whether the run failed*) | `releaseCause` on `session`: today's `endReason` values plus the causes that have no `endReason` today (turn failed, runner lost, setup failed, engine exited) | which terminal value, and `endReason` |
| **Last turn's outcome** | an outcome and error on `ConversationTurn`; a copy on `session` for list rows | `FAILED` and `INTERRUPTED` as a status, `session.error` |
| **Work outcome** | the record of the work: task status and verdict, `ScheduleRun.state`, `SubagentRun.status`, `project_landing.settled_as`, and `TaskAttempt` if it is switched on (D5) | `SUCCEEDED` / `FAILED` / `CANCELLED` read as a result |
| **End in progress** | `cancelRequestedAt`, unchanged | same |
| **Retry armed** | `retryAt`, unchanged, on a released session | `FAILED` + `retryAt` |
| **Filed, trashed** | `completedAt`, `deletedAt`, unchanged | same |

Invariant: a released session is always `IDLE`. Sending to it clears `releasedAt` and makes it
`PENDING` in one write, as the revive does today.

> **Superseded 2026-11-21 by decision D9 (§12).** The owner decided that the session carries no failure fact:
> `release_cause`, its failure line and `session_release_failure_chk` go. The table below describes the column as
> deploy 1 writes it, until §12.6 removes it.

**The release causes, and which are failures** (`session.release_cause`, values in
`common/session-release.ts` `SESSION_RELEASE_CAUSES`, CHECK `session_release_cause_chk`, migrations
1261 and 1403). Each cause is a failure or not, never both, so "did the run fail" is read off the
cause (`FAILURE_RELEASE_CAUSES`: `isFailedRelease`, `failedReleaseFilter`, `failedReleaseSql`) and
not off the terminal status value. The writers hold the stored status to it: `FAILED` exactly when the cause
is a failure. (A CHECK for it, `session_release_failure_chk` in migrations 1406 and 1407, was removed from the
project branch on 2026-11-21 before it was deployed: §12.6 R1.)

| Cause | Failure | Written when | Status written with it |
|---|---|---|---|
| `task_done` | no | an end for a task that is `DONE` | `SUCCEEDED` |
| `task_cancelled`, `ended` | no | an end for a cancelled task; a person or agent ends the session | `CANCELLED` |
| `completed`, `deleted`, `cancelled` | no | a person completes, deletes or stops it, and it settles as asked (the runner's finalize, or the end found it still queued); `cancelled` too for an end with no reason | `CANCELLED` |
| `idle`, `orphaned` | no | legacy end reasons: no writer, old rows only | as stored |
| `engine_exited` | no | the runner finalized with no end requested and reported `SUCCEEDED` or `CANCELLED` | the runner's word, stored; no reader consults it (see below) |
| `landing_settled` | no | a landing container is created settled, or settles | `SUCCEEDED` or `CANCELLED` |
| `turn_failed` | yes | the runner reports a failed turn; the reaper's API-error backstop | `FAILED` |
| `runner_lost` | yes | the runner holding a running turn went offline (reaper) | `FAILED` |
| `setup_failed` | yes | the runner refused the source; the engine's runtime never initialized (reaper) | `FAILED` |
| `engine_failed` | yes | the runner finalized with no end requested and reported `FAILED` | `FAILED` |
| `end_not_honored` | yes | an end was asked for and the runner never honoured it: the reaper releases it once the cancel grace runs out (`end_reason` keeps the end that was asked for) | `FAILED` |
| `import_failed` | yes | the runner could not import the transcript the session was made from | `FAILED` |

**What became of the work** (decision D5, plan step 4.6, 2026-11-21) is read off the cause too: the work finished
exactly when the cause is `task_done` (or `landing_settled` for a LANDING container; `WORK_FINISHED_RELEASE_CAUSES`,
`isWorkFinishedRelease`). Every other release that is not a failure is a stop: one somebody asked for when an end reason
is recorded, and otherwise one nobody asked for. So the four readers that told `SUCCEEDED` from `CANCELLED` among such
releases (the retry policy's `autoRunEnd`, the retry brake's count of unrequested ends, a schedule run's `landRun`, and
`mergeAfterOwnTurn`) read an `engine_exited` release as an unrequested stop, whatever word the runner reported with it:
the runner's `SUCCEEDED` there is no longer consulted. Until 2026-11-21 those readers took `SUCCEEDED` + `engine_exited`
for finished, landed or merged work. Production then held 318 such rows (created 2026-06-19 to 06-21 by 1262's
backfill, all on DONE tasks, none reachable by the four readers), and the finalize now logs one if a runner ever reports
it.

Before 1403, `engine_exited` was also written for a `FAILED` finalize, and the end's own cause for
the reaper's `FAILED` "cancel not honored". A backfill (migration 1405) was to rewrite those rows (and the
`FAILED` rows 1262 gave an end reason) to the failure cause their own facts name; it was removed on 2026-11-21
before it was deployed (§12.6 R1), so those rows keep their causes (§12.2, B1 and B2).

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

| Site | Writes | Release cause (failure in bold) | Trigger |
|---|---|---|---|
| `apiserver/src/runner-api/runner-api.controller.ts:7818` | `FAILED`, `finishedAt`, `cancelRequestedAt` | **`turn_failed`** | the runner reports a failed turn |
| `apiserver/src/runner-api/runner-api.controller.ts:9824` | `SUCCEEDED` / `FAILED` / `CANCELLED`, `finishedAt` | end requested: the end reason's (`task_done` with `SUCCEEDED`, else `CANCELLED` with that reason or `cancelled`); none requested: `engine_exited`, or **`engine_failed`** when the runner reported `FAILED` (`finalizeReleaseCause`) | runner finalize; the value is the runner's, or the end reason's when an end was requested |
| `apiserver/src/runner-api/runner-api.controller.ts:10234` | `FAILED`, `deletedAt` | **`import_failed`** | a transcript import failed |
| `apiserver/src/realtime/reaper.service.ts:890` | `FAILED`, `CANCELLED` or `SUCCEEDED` | an unacknowledged graceful end and a cancel on a queued row: the end reason's; cancel not honoured: **`end_not_honored`**; runner offline: **`runner_lost`**; runtime never initialized: **`setup_failed`**; API-error reply: **`turn_failed`** | six cases: cancel not honoured, cancel on a queued row, an unacknowledged graceful end, runner offline, runtime never initialized, an idle task session whose last reply is an API error |
| `apiserver/src/sessions/sessions.service.ts:9731` | `CANCELLED` | the end reason's | end, complete or delete of a queued session |
| `apiserver/src/projects/landing-session.ts:256`, `:373` | `SUCCEEDED` or `CANCELLED` | `landing_settled` | a landing container is created settled, or settles |
| `apiserver/src/projects/session-source.ts:692` | `FAILED`, `finishedAt` | **`setup_failed`** | the runner refuses the source |
| `apiserver/src/sessions/sessions.service.ts:10942` | back to `PENDING` | cleared | the revive: a person, an agent, the auto-retry sweep, merge repair, a scheduled wake-up |

Each writer decides the cause in the statement that writes the status, and `FAILED` is written with a
failure cause and nothing else (§4.2; the CHECK that was to hold it, `session_release_failure_chk`, was removed on
2026-11-21 before it was deployed, §12.6 R1).

*Superseded 2026-11-21 by D9 (§12):* the "Release cause" column of this table is what deploy 1 writes. Under D9
no writer records a cause; a failure writer records the outcome of the turn that carried the failure instead
(§12.1 gives the turn for each of these writers).

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

Decided on 2026-11-19, each as recommended below: **D1**, **D5** and **D8**. Decided by the owner on
2026-11-21: **D2** (below) and **D9**, which this document had not proposed. The others are open.

- **D1. Four situations, not three.** Accept that "released" is the session's own fact, kept
  beside three activity states. Recommended: yes, as a column, so that the status says only
  what the session is doing.
- **D2. A plain conversation that "succeeded".** With no task behind it, what should the green
  "Succeeded" and the "Finished" push mean? Options: the last turn was answered and the engine
  exited; or drop the word for plain conversations and show "Ended". Not recommended either
  way until it is known when a runner finalizes a plain session as `SUCCEEDED`.

  Traced 2026-11-19 (plan step 0.2): **a plain conversation is never stored as `SUCCEEDED` by
  current code.** It always ends `CANCELLED` (or `FAILED`). The chain:
  - Every session the runner runs is interactive: `runInteractiveSession` is the only caller
    of `finalizeRun` (`runner-go/runloop.go:2766`, `runner-go/session.go:1936`), so there is
    no separate one-shot mode to look at.
  - The runner reports `SUCCEEDED` in a finalize only when the engine returned with an inbox
    `end` turn. For Claude: `case "end": endSession()` (`session.go:2984-2985`), then
    `case <-endedCh: return stSucceeded, true, false // user ended the session`
    (`session.go:3329-3330`), then `if ended { status = st }` (`session.go:1758-1760`) and
    `RunFinalizeRequest{Status: status, ...}` (`session.go:1913`). The other engines return
    `stSucceeded` only from their own `case "end"`: `codex.go:229-230`,
    `codex_appserver.go:865-871`, `kimi_acp.go:2198-2200`, `cursor_acp.go:1555-1561`,
    `dsh_acp.go:913-919`, `opencode.go:259` and `:268`/`:278`/`:319`,
    `antigravity.go:1244-1245` and `:1260`. Every other exit path (crash after the respawn
    budget, startup refusal, missing engine, region refusal, given-up events) is `FAILED`,
    and a cancel or shutdown is `CANCELLED`. Even an `end` is overwritten on the runner if
    the heartbeat's cancel for the same end lands first: `snapshot.cancel()`
    (`runloop.go:2124-2127`) makes `if ctx.Err() != nil ... status = stCancelled`
    (`session.go:1813-1815`).
  - The server writes an `end` turn in exactly two places, and both set `cancelRequestedAt`
    in the same transaction: the person/agent end path (`sessions/sessions.service.ts:9759`
    and `:9774`) and the reaper's `endParked`, which requires the session's task to be
    terminal (`realtime/reaper.service.ts:1045`) and so never runs for a plain session.
  - The finalize handler ignores the runner's status whenever `cancelRequestedAt` is set:
    `current.cancelRequestedAt ? (gracefulEndStatus(current.endReason) ?? RunStatus.CANCELLED)
    : dto.status` (`runner-api/runner-api.controller.ts:9748-9750`). `gracefulEndStatus`
    answers `SUCCEEDED` only for `TASK_DONE` (`shared/src/enums.ts:238-241`), a reason
    written only by the reaper for a session whose task is `DONE` (`reaper.service.ts:515-517`,
    `:1051`).
  - `/turn-complete` never writes `SUCCEEDED` to the session: its next status is `FAILED`,
    `PENDING` or `AWAITING_INPUT` (`runner-api.controller.ts:7776-7780`).

  So the green "Succeeded" on a plain conversation can only be an old row or a landing
  container (`sessions/sessions.service.ts:5141`), and D2 is a question about wording for
  `CANCELLED` with `endReason` `ENDED`/`CANCELLED`, not about a success path. Not checked: how
  many stored plain rows read `SUCCEEDED` today. For plan step 4.6: no plain-session
  `SUCCEEDED` case needs to be kept.

  **Decided by the owner on 2026-11-21:** as the plan says, success and finish are not states of a
  session, so there is nothing special to decide for plain conversations. A plain conversation is
  ended, or failed when its release was a failure; it is never succeeded or finished. Only a
  session that did a task's work finishes, and that is read from the release cause (`task_done`,
  or `landing_settled` for a landing container). Plan step 4.8 moved the three readers that
  waited on it onto the release fact: the settle push (`push/settle-alert.ts`: "Finished" for a
  release that finished the work, the failed alert for a failure cause, nothing for any other
  release), the `SESSION_RUN_TERMINAL` watch leaf (released, or interrupted with an end
  recorded; its stored meaning unchanged), and the wiki's settled-session feed
  (`wiki/wiki-maintenance.ts`), which already read activity only and needed no change.
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

  *Superseded 2026-11-21 by D9 (§12) where it reads the cause:* "the work finished" becomes `end_reason =
  'task_done'` (or a `LANDING` container with no end reason) on a released session, and "the run failed" becomes the
  released session's last turn outcome with no end asked (§12.2). "One released session is one attempt" stands.

  As built in plan step 4.6 (2026-11-21): a failure is a failure cause (`isFailedRelease`), the work finished exactly
  when the cause is `task_done` (`isWorkFinishedRelease`; `landing_settled` for a landing container), and any other
  release is a stop, asked for when an end reason is recorded. For `engine_exited` the runner's status word is stored
  but no longer consulted (§4.2).
- **D6. Storage collapse.** Defer the decision to after stage 5.
- **D7. Published wait condition.** `SESSION_RUN_TERMINAL` keeps its name and comes to mean
  "released". Recommended: yes; renaming it breaks stored watches.

- **D8. Does `RUNNING` include work outside a turn?** Today the status is `AWAITING_INPUT`
  while a background job, a subagent or a turn the engine started for itself is still going,
  and seven readers each patch that differently (§11). Recommended: the `activity` that
  people and agents see is computed from one shared definition and reads `RUNNING` while
  anything is executing for the session; the scheduler keeps reading turns, because a slot
  is held by a dispatched turn only.

- **D9. No failure fact on the session.** Decided by the owner on 2026-11-21, in their words: "failure is a
  task state, not a session state", and "Let's do it by removing this column from the session." So
  `session.release_cause` is removed; a failure is recorded on the turn that carried it, and questions about the
  work read the task's records or `end_reason = 'task_done'`; the session keeps `finished_at` and `end_reason`.
  The trace, the reader table and the removal plan are §12. It supersedes the release-cause row of §4.2, the cause
  table after it, the cause column of §6.3 and the as-built note of D5.

## 10. What was not verified

- The classification was done by seven parallel readers. Their key claims were spot-checked
  against the source (the unique index, the empty `TaskAttempt`, the strict Swift enum, the
  runner's reclaim fence and terminal-answer rule, `sessionHasEnded`, the settle alert). The
  other rows were not re-read.
- The largest files were read around their status sites, not end to end:
  `sessions.service.ts`, `runner-api.controller.ts`, `tasks.service.ts`,
  `projects.service.ts`, `WorkspaceView.tsx`, `ConsoleModel.swift`.
- Whether `finishedAt` is set by every terminal write and by nothing else was not audited. If
  it is, it can be the release column and stage 2 needs only `releaseCause`.
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
   left to wake it.

   Traced 2026-11-19 (plan step 0.3). **A runner that comes back reports nothing for the work
   it lost; the server clears all three sets anyway, at the takeover. A runner that never
   comes back leaves them set.**
   - On start the runner reclaims every open session assigned to it, `AWAITING_INPUT`
     included (`status: { in: OPEN }`, `runner-api/runner-api.controller.ts:4196`), and takes
     the idle ones over in the background (`runner-go/reclaim_starter.go:22-25`,
     `runloop.go:2837`). The takeover, single or batched, writes `running_bg_shells`,
     `running_bg_jobs`, `running_bg_job_activity` and `running_subagents` empty and
     `engine_turn_active = false` while the session stays `AWAITING_INPUT`
     (`runner-api.controller.ts:4743-4749`, `:4952-4956`). That is the message that clears
     them: `POST /runner/sessions/:id/takeover-leases` or its batch form, not an end report.
   - `bg_run` jobs: after a crash or reboot no end report is sent. Only a self-update hands
     jobs on; a recorded job whose pid is not the new process's child is dropped with "not
     adopted, no end report" (`background_job_adopt_unix.go:17-23`, `:33-37`). A job that
     was adopted re-reports `running` and goes back into `running_bg_jobs`
     (`runner-api.controller.ts:9428-9435`, `:9504`). No wake is owed for a lost job.
   - Background shells: they died with the engine; the takeover clears them and nothing puts
     them back (an engine shell's report carries no `kind`, `runner-api.controller.ts:9434-9435`).
   - Subagents: the set is cleared by both takeover forms, but only the single
     `takeover-leases` also ends the `subagent_run` rows still `RUNNING` as `INTERRUPTED` and
     files the parent's wake (`runner-api.controller.ts:4776`, `:4779-4787`). The batch form
     the startup reclaim uses for idle sessions does not (`:4985-4989` reaps approvals only),
     so those runs stay `RUNNING` with no wake. Not checked whether another sweep ends them.
   - What the task reads afterwards: the carrier counts an `AWAITING_INPUT` session only with
     a wake source (`sessions/task-work-carrier.ts:91-95`); with the sets empty and
     `engine_turn_active` false (`:48-55`), and no watch, wake-up or retry, the task is no
     longer carried and reads Ready, and Run continues that session.
   - The runner never comes back: no takeover happens, `runnerOfflineIsFatal` is `RUNNING`
     only (`common/session-scheduling.ts:114-116`), so the reaper leaves the session
     (`realtime/reaper.service.ts:532-535`) and the task reads running with reason `TURN`
     or `BACKGROUND_JOB` for good.

   For plan step 1.7: a runner that comes back already clears the sets; 1.7 has to cover the
   runner that stays offline, and the batch takeover leaving subagent runs `RUNNING`.
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
- **Why idle, as its own fact.** A session may be waiting on a person (an approval card or an owner
  decision it asked for), waiting to be woken (watch, timer, retry), or on hold (a queued turn kept
  from starting by the dispatch pause, its runner offline or updating, or a hold notice such as a
  paused account). A `RUNNING` one may be waiting on a person too. An idle session that asked for
  nothing waits on nothing. That is one more field, `waitingOn`, and it replaces the overlays.

  > **Corrected 2026-11-22 (the coordinator's ruling, plan step 5.1).** This read "An idle session
  > is waiting on a person, waiting to be woken, or on hold", which made every parked conversation
  > wait on a person. `PERSON` means somebody owes the session an answer it asked for, in any phase.
  > A parked conversation asked for nothing: its next message is owed by nobody, so `waitingOn` is
  > null. As built (`src/apiserver/src/sessions/session-phase.ts`), in this order: `PERSON` when an
  > answer is owed; null for a `RUNNING` session otherwise; `HOLD` for a held `PENDING` one; `WAKE`
  > for an `IDLE` one a watch, wake-up or armed retry will wake; null otherwise. That covers a released
  > session with no retry armed, and an `IDLE` session waiting only on a session request it sent or an
  > `ask_owner` question, because neither is a wake fact of `sessionWillWake`. Waiting on a sub-agent
  > or a background job is `RUNNING`.
  >
  > **Corrected 2026-11-26.** On a released session `WAKE` read any of the three facts, but only an
  > armed retry, or a scheduled wake-up on a release by a failure still filed in Open, revives one; a
  > watch never does. `sessionWakes` (`session-phase.ts`) now reads only those there, so a crash with a
  > leftover `task_await` watch reads null rather than a wake that never comes. A scheduled run asks
  > `sessionWakes` beside `PERSON`, so an owner request it filed does not hide its wake.
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

## 12. No failure fact on the session (decision D9, 2026-11-21)

Traced 2026-11-21 against the project branch tip `260a93a9d6` (`origin/project/3508bDBDE5xPH43TYuiqP`).
Paths are under `src/` unless they start with `prisma/`, which is `src/apiserver/prisma/`. The data
questions were answered on a throwaway PostgreSQL 16 with all 628 migrations of the tip applied in order
(each in one transaction, as Prisma applies them; the fixture is called "the migrated fixture" below). It
holds no rows, so the row shapes were written out as a `VALUES` list and the live CHECK expressions read
from `pg_constraint` on it.

**The owner's decision, 2026-11-21:** "failure is a task state, not a session state", and then, at 12:05Z,
"Let's do it by removing this column from the session." That is direction C below. `session.release_cause`
goes. A failure is recorded on the turn, and a question about the work reads the task's records. The
session keeps only `finished_at` (released or held) and `end_reason` (why an end was asked for).

**Does it hold? Yes, with one case that has neither a turn nor a task, and one behaviour change.**

- Every failure release has a turn to carry it, except a failed **transcript import**. An import is a
  claim with no engine and no turn; the session it was making is put in Trash in the same write
  (`apiserver/src/runner-api/runner-api.controller.ts:10621-10633`). Nothing failed in a conversation,
  because there never was one. No reader asks about it: every failure reader also requires the session to
  be unfiled, have a task, or have a retry armed, and an import has none of these. It keeps its `error`
  and its `deleted_at`, and that is all it needs.
- An **end that was asked for and not honoured** (`end_not_honored`) stops reading as a failure. Somebody
  asked for the end and the session ended; the runner's silence is not something the conversation or the
  task did. Today a scheduled wake-up would revive such a session (it revives every failure release), which
  contradicts the end that was asked for. The change is intended, but it is a change.
- Today the turn outcome is **not** a usable replacement: the turn-complete handler is the only writer of
  `conversation_turn.outcome` and `session.last_turn_outcome`, so 12 of the 15 failure shapes below carry no
  `FAILED` on any turn. C therefore starts with writers, not readers.

### 12.1 The failure writers

"The carrying turn" is the turn that has to record `outcome = 'FAILED'` and the error, with the copy on
`session.last_turn_outcome`. "Work turn" means `kind IN ('message', 'shell')`, the only kinds that get an
outcome today (`apiserver/src/runner-api/turn-outcome.ts:36-37`).

| # | Writer, cause today | Turn at that moment | The carrying turn under C | Outcome recorded today? |
|---|---|---|---|---|
| W1 | turn-complete, a failed turn: `turn_failed` (`runner-api.controller.ts:8143-8171`) | always: the completed turn `dto.turnId` | that turn; already written (`:7762-7772`, `:7804-7809`, `:8171`) | **yes** for a work turn that failed or was swallowed |
| W1a | turn-complete, EXECUTABLE exit code mismatch (`:7860-7884`) | the reserved acceptance shell turn, which the runner reports `SUCCEEDED` with its exit code (`runner-go/shell.go:346`) | that turn, as `FAILED` with the comparison as its error (`acceptanceFailureReason`). Recommended: the reserved turn is the task's own check, not a person's message, and its job was the comparison | **no**: it is recorded `ANSWERED`, while the session is released `turn_failed` and the task `FAILED` |
| W1b | turn-complete, acceptance result unavailable (`:7896-7900`) | the reserved shell turn | that turn, `FAILED`, error as written to the session | **no** when the runner said `SUCCEEDED` |
| W1c | turn-complete, a failed turn of another kind, or a completion naming no turn | the completed turn, if any | that turn, whatever its kind | **no**: `turnOutcomeOf` answers null for it (`turn-outcome.ts:37`), and the session keeps its previous `last_turn_outcome`. Not seen in practice; the runner fails only work turns |
| W2 | reaper, runner offline while `RUNNING`: `runner_lost` (`realtime/reaper.service.ts:614-635`) | always one: the work turn `IN_FLIGHT`, or, lost between claim and inbox, the oldest `PENDING` work turn that the claim was for | that turn, error `runner offline` | **no**: `forceFinalize` marks every unanswered turn `ANSWERED` with no outcome (`reaper.service.ts:1056-1060`) and writes no `last_turn_outcome` (`:993-1016`) |
| W3 | reaper, runtime never initialized: `setup_failed` (`:667-694`) | always: `RUNNING` with no runtime id; the turn is `IN_FLIGHT` or still `PENDING` | that turn, error `<engine> runtime not initialized` | **no**, same drain |
| W4 | the runner refuses the source: `setup_failed` (`projects/session-source.ts:684-703`) | never one in flight: the runner pins the source right after the claim, before any worktree, engine or inbox read (`runner-go/runloop.go:2693-2709`); the turn that caused the dispatch is still `PENDING` | the oldest `PENDING` work turn, error `<code>: <reason>`. The writer must also drain it, which it does not do today (the turn stays `PENDING` on a released session) | **no** |
| W5 | transcript import failed: `import_failed` (`runner-api.controller.ts:10621-10633`) | never: an import spawns no engine and has no turn; a message sent during the import can be queued | **none.** Nothing failed in a conversation; the session is released and in Trash, with its error | **no**, and none is needed |
| W6 | runner finalize, no end asked, runner said `FAILED`: `engine_failed` (`:10186-10200`, `common/session-release.ts:208-216`) | almost always: the runner fails a session only while it is active (crash past the respawn budget, `runner-go/session.go:1803-1810`; a spawn failure, `:2277`), so a work turn is `IN_FLIGHT` or the claimed one is `PENDING`. Unsure: events the link gave up (`:1825`) may end an idle session | the `IN_FLIGHT` work turn, else the oldest `PENDING` one, error the runner's `error`. If neither exists (the given-up case), the latest work turn, because the events lost were its own | **no**: the finalize drain marks every turn `ANSWERED` with no outcome (`runner-api.controller.ts:10303-10306`) |
| W6a | the engine dies between turns with nothing queued | none | **no release at all.** An idle engine that exits becomes cold and the session stays `AWAITING_INPUT` (`runner-go/session.go:1797-1804`); the next message starts a new engine | nothing to record |
| W7 | reaper, an end asked for and not honoured in the grace: `end_not_honored` (`reaper.service.ts:514-541`) | sometimes: `RUNNING` has a turn in flight; `AWAITING_INPUT` or `INTERRUPTED` has none | **none as a failure.** The turn in flight, if any, ends `CANCELLED` (an end was asked for); `end_reason` already records the end (every end request writes one: `sessions/sessions.service.ts:10507-10508`, `reaper.service.ts:1171-1172`) | no, and under C it is `CANCELLED`, not `FAILED` |
| W8 | reaper, API-error backstop on an idle task session: `turn_failed` (`:704-722`) | none in flight: the last work turn completed and its reply was the API error. Only a runner older than the in-source flag leaves this | the latest work turn, rewritten from `ANSWERED` to `FAILED` with the reply text as error | **no**: that turn says `ANSWERED` |

The rule the writers need, in one sentence: the carrying turn is the `IN_FLIGHT` work turn, else the oldest
`PENDING` work turn, else (W6 given-up and W8 only) the latest work turn; it gets `outcome = 'FAILED'` and the
error the session gets today, in the transaction that writes the release, and `session.last_turn_outcome =
'FAILED'` rides on the same session write. Every other queued turn is drained as today, with no outcome: it never
ran.

### 12.2 Three readings of "did it fail", on every row shape

Query run on the migrated fixture (`shapes.sql` in this task's evidence): for each shape a writer or a backfill
leaves, today's reading (`release_cause` is a failure cause), `status = 'FAILED'`, and `last_turn_outcome =
'FAILED'` as written **today**. `passes 1406` evaluates `session_release_failure_chk` as `pg_constraint` gives it.

| Shape | today | `status = 'FAILED'` | turn outcome today | passes 1406 |
|---|---|---|---|---|
| W1 failed work turn; swallowed delivery | t | t | t | t |
| W1a exit mismatch; W1b result unavailable; W1c other kind | t | t | **f** | t |
| W2 runner lost (first turn, or a later one) | t | t | **f** | t |
| W3 runtime never initialized; W4 source refused | t | t | **f** | t |
| W5 import failed | t | t | **f** | t |
| W6 engine failed (mid-turn, or never started) | t | t | **f** | t |
| W7 end not honoured (`completed`; no reason) | t | t | **f** | t |
| W8 API-error backstop | t | t | **f** | t |
| N1 end asked (`ended`), `CANCELLED` | f | f | f | t |
| N2 a turn failed while its session was being ended (turn-complete still copies the outcome, `runner-api.controller.ts:8221-8236`), then `CANCELLED` | f | f | **t** | t |
| N3 `task_done`; N4 `engine_exited` + `CANCELLED`; N5 landing settled | f | f | f | t |
| B1 1262: an old `FAILED` row with an end reason, cause = that reason (production: 85 rows) | f | **t** | **t** | **f** |
| B2 1262: an old `FAILED` "cancel not honored", cause `cancelled` | f | **t** | **t** | **f** |
| B3 1262: an old `SUCCEEDED` with no end, `engine_exited` (production: 318 rows) | f | f | f | t |
| B4 1405: B1 rewritten to `end_not_honored` | t | t | t | t |
| R1 revived after a failed turn, not yet answered (`PENDING`) | f | f | **t** | t |

What follows from it:

- `status = 'FAILED'` gives today's answer on every row the tip's writers produce, which is what 1406
  states. It is the one reading that is right during a hand-over, because every writer in deploy 1 and
  deploy 2 writes the status. That makes it the bridge (§12.6). It is not the end state: the project's
  criterion forbids server code that decides from a terminal status value.
- The turn outcome needs W1a-W1c, W2-W4, W6 and W8 to record it (§12.1) and a backfill for the rows
  released before they do (§12.6). R1 and N2 show that a reader must also ask "released, and no end asked".
- **The reading under C** for "released by a failure" is
  `finished_at IS NOT NULL AND end_reason IS NULL AND last_turn_outcome = 'FAILED'`. Once the writers
  record the outcome it equals today's reading on every shape above except W7 (an end was asked: not a
  failure, as intended), W5 (no turn: not a failure; no reader sees the difference, see 12.1), and B1/B2.
  B1 then reads as today in production (not a failure: 1405 never ran), and B2 reads as a failure, as 1405
  would have made it. "An end was asked" is `end_reason IS NOT NULL`, because every end request on the tip
  writes a reason with `cancel_requested_at` (`sessions.service.ts:10507-10508`, `:10540-10541`,
  `reaper.service.ts:1171-1172`); `cancel_requested_at` alone is also the teardown signal turn-complete and
  the reaper set on rows they release (`runner-api.controller.ts:8159`, `reaper.service.ts:1009`), so it
  cannot be read as "asked".
- **"The work finished"** under C is `finished_at IS NOT NULL AND (end_reason = 'task_done' OR (kind =
  'LANDING' AND end_reason IS NULL))`. `task_done` is written exactly when `end_reason` is `task_done`
  (`common/session-release.ts:196-200`, `:215`), and `landing_settled` only by the landing writer, which writes
  no end reason (`projects/landing-session.ts:286`, `:380`), and by 1262 for every `LANDING` row first. On the
  rows 1262 left it equals today's production reading, B1-style `FAILED` + `task_done` included (both say
  finished; 1405 would have said not).

### 12.3 The readers

"Asks" uses the task's terms: **turn** = did the last turn fail; **attempt** = did this task's attempt fail;
**wake** = may a machine wake revive it; **standing** = how the session stood, told to someone; **retry** = is
it parked under an armed retry. "Under C" names what it reads; `failed` is the reading of 12.2 and `finished`
the work reading. "Differs" lists the shapes of 12.2 whose answer changes, once the writers of 12.1 record the
outcome; W7 and W5 are left out of a row when the reader's other guards already exclude them.

| Reader | Asks | Under C | Differs |
|---|---|---|---|
| `sessions/auto-retry.service.ts:373` `releaseHeldRetries`, `:470` `sweep` | retry | `failed` + its `retry_at` guards; W2's armed retry needs W2 to record the outcome | none (W7 never has `retry_at`) |
| `auto-retry.service.ts:1206` `stoppedOnFailure` | retry: may the failure card re-send now | `failed` | none |
| `auto-retry.service.ts:1995` `releaseExpiredClaims` | retry | `AWAITING_INPUT` or `failed` | none |
| `auto-retry.service.ts:2050` `announceSettled` | turn: final `FAILED` event or a refresh | `failed` | none |
| `sessions/sessions.service.ts:5800` `startMergeRepair` | turn: reuse the repair conversation unless its last run failed | `failed` | none |
| `sessions.service.ts:5970` `armAutoRetry` | retry: may the owner arm one | `failed` or idle | none |
| `sessions.service.ts:9803` `mergeAfterOwnTurn` | the work: did the released session's work finish | `finished` | none |
| `sessions/session-move.ts:148` `sessionMoveVerdict` | retry: would a move break an armed retry | `failed` + `retry_at` | none |
| `sessions/session-request.ts:1052` `awaitsAutoRetry`, and its callers in `session-request.service.ts:298`, `:335`, `:380`, `:428` | standing: wait for the asker's retry before telling it | `failed` + retry guards | none |
| `runner-api/scheduled-wakeup.ts:325` `tickStanding`, `scheduled-wakeup.worker.ts:118`, `:529` | wake: revive a failed release, or wait for its retry | `failed` | **W7**: today revived although an end was asked; under C ended |
| `help/help-ask-marker.ts:57` | turn: show the ask as failed | `failed`, or `last_turn_outcome = 'FAILED'` on a released row | none |
| `projects/coordinator-handoff.service.ts:271`, `:274` | standing: did the coordinator fail or stop before acknowledging | `failed` | **W7**: today `TURN_FAILED`, under C `TURN_STOPPED` (an end was asked) |
| `projects/project-open-item.ts:866` `conversationIsDown`, `:962` `projectCoordinatorCanTake` | standing: is the coordinator down and recoverable; can it take an item after its retry | `failed` (`:866` already requires no end reason) | none |
| `schedules/schedule-runs.service.ts` `mayStillRun` (was `LIVE_SESSION`) | retry: may a prior session still run | the phase fields and `sessionWakes` (2026-11-26): held, or released with a revive coming | none |
| `schedule-runs.service.ts` `reconcileRun` | attempt: did the run's session fail before reporting (engine crash, quota) | the phase fields and `sessionWakes` (`schedule-run-session-reading.ts`, 2026-11-26); `error` only for the QUOTA label | **W7**: an end asked for and not honoured reads as a stop |
| `schedule-runs.service.ts` `landRun` | the work: did the session finish | the phase fields' `workFinished`, `released` and `endReason` (2026-11-26) | none |
| `tasks/tasks.service.ts:13095` `autoRunHoldOff`, failures | attempt: the retry brake | `failed` on the task's sessions | **W7** stops counting as a failure; **W1a** counts only if W1a records `FAILED` (recommended) |
| `tasks.service.ts:13131`, unrequested stops | attempt: the brake's count of stops nobody asked for | released, no end reason, not `failed`, not `finished` | **W7** moves out of both counts (it has an end reason) |
| `tasks.service.ts:13162`, quota | attempt: newest usage-limit failure | `failed` + `error` match | none |
| `tasks.service.ts:13197` `endedAutoRunMoments` → `tasks/task-retry-policy.ts:75` `autoRunEnd` | attempt: how the receipt's session ended | project `finished_at`, `kind`, `end_reason`, `last_turn_outcome`; `FINISHED` when `finished` | none |
| `tasks/task-route-decision.ts:425` `readRunHistory` | attempt: escalate the model after a failed run | `failed`, `error` as today | **W7**; **W1a** as above |
| `tasks/task-model-routing-report.service.ts:68`, `:80` | attempt: did the routed run fail | `failed` | **W7**; **W1a** as above |
| `tasks/verification-dependency.ts:186`, `:432` (`VERIFICATION_RUN_RELEASE_CAUSE`) and `verification-epoch-read.ts:88-97` | the work: did the verifier's run settle by its task finishing | `finished_at IS NOT NULL AND end_reason = 'task_done'` | none |
| `common/session-release.ts:247` `sessionHasEnded` | wake: has the session ended | unchanged: it reads no cause | none |
| `releaseCauseOfEndReason`, `finalizeReleaseCause`, `reportsSuccessWithNoEnd` (`session-release.ts:196-229`) | writer helpers | removed; the finalize's log of a runner reporting success with no end stays, on `cancel_requested_at` | none |
| Trigger `session_request_recipient_ended` (1425, `prisma/migrations/1425_ended_triggers_read_release/migration.sql:89`) | standing: close the request when the recipient ended, unless a failure retry may bring it back | released and (not `failed` or no retry armed) | none |
| Trigger `session_request_asker_stopped` (1425 `:105`) | standing: the asker stopped, so the reply goes to its task | same | none |
| Trigger `task_owner_confirmation_review_reviewer_ended` (1425 `:125`) | standing: the reviewer ended without a verdict | released and (not `failed` or an end reason) = released and not `failed` | none |

No reader tells one failure cause from another: the six failure literals appear only in
`common/session-release.ts` and in the writers (grep of `src/apiserver/src` on the tip), and the fixture has no
function body that names a failure cause. The only per-cause reads are `task_done` and `landing_settled`, which
the work reading above replaces. Readers that pick a failure *kind* read `session.error` (quota, capacity,
`ACCEPTANCE_FAILED`, `runner offline`) and keep doing so; that text can move to the carrying turn's `error`
later, but nothing about removing `release_cause` needs it.

Why the task readers read the attempt's session and not a task record: the task's failure record
(`recordTaskFailure`, a project exception item with the `how`) is written only when the task moved out of
`IN_PROGRESS` and a project owns it (`tasks/reclaim-stalled-task.ts:35-63`), so it misses runs of tasks outside
a project and runs that failed while the task was not `IN_PROGRESS`. The released session is the record of one
attempt (D5), and its carrying turn says whether the attempt failed. That is the hypothesis's "through its runs".

### 12.4 A plain conversation whose turn fails

Today, for a conversation with no task:

- **Stored.** turn-complete writes `FAILED`, `finished_at`, `release_cause = 'turn_failed'`, the error, and
  `cancel_requested_at` so the runner tears the engine down; the turn gets `outcome = 'FAILED'` and its error,
  and `last_turn_outcome = 'FAILED'` (`runner-api.controller.ts:7804-7809`, `:8143-8171`). Queued turns are
  drained (`:8371-8374`). An engine crash mid-turn is respawned up to the budget and then finalized `FAILED`
  `engine_failed`, with no turn outcome (`runner-go/session.go:1803-1810`, `runner-api.controller.ts:10303`). An
  engine that dies while idle changes nothing (`session.go:1797-1804`).
- **Shown.** Web: "Failed" (`web/src/lib/sessionState.ts:238`), or "Retrying" while a retry is armed and not
  stale (`:290-297`); Apple: `.failed` (`macos/OrbitKit/Sources/OrbitKit/Models/Enums.swift:93`). No client reads
  `releaseCause`; it reaches only the detail, create and merge-repair responses because they spread the row.
- **Auto-retry.** Armed only for failures the server can undo by itself: a usage limit or a pool credential
  (`runner-api.controller.ts:7700-7760`), a swallowed delivery (`:7752-7756`), a lost runner (`reaper.service.ts:632`,
  plain sessions always), a quota at finalize (`:10138-10154`). The sweep re-sends the message by reviving the
  session. Other failures (an API error that is not retryable, a crash) wait for a person; the failure card's
  re-send is gated by `stoppedOnFailure` (`auto-retry.service.ts:1206-1219`).
- **A new message.** The revive puts the session back to `PENDING` and clears `finished_at`, `release_cause`,
  `end_reason`, `cancel_requested_at`, `error`, `result` and `retry_at` in one write
  (`sessions/sessions.service.ts:11724-11762`). `last_turn_outcome` stays until the next turn completes.

"The session is released; its last turn failed; a retry may be armed" describes it completely. The session's
own facts are `finished_at` and `retry_at`; the failure is the turn's. The one gap today is the engine crash
(W6): the turn that died says nothing, which is the writer change of 12.1.

### 12.5 What goes with `release_cause`

- **No reader distinguishes failure causes** (12.3). Nothing is lost there.
- **Diagnostics.** The cause was an enum for "why released". The same facts stay readable: `error` (`runner
  offline`, `<engine> runtime not initialized`, `<code>: <reason>`, `cancel not honored`, the engine's words),
  `source_state = 'REFUSED'`, `import_source_cwd` (still set on a failed import), `end_reason`, the carrying turn's
  outcome and error, and the task's failure record with its `how` (`ATTEMPT_LOST_RUNNER_OFFLINE`,
  `ATTEMPT_LOST_RUNTIME_NOT_INITIALIZED`, `REAPED_API_ERROR`, `ACCEPTANCE_EXIT_MISMATCH`). 1262 and 1405 derived the
  cause from exactly those columns, so the cause never held anything they do not.
- **`engine_exited`** exists only so that every released row has a cause: the second clause of
  `session_release_fact_chk` (1401) demands one, and a finalize with no end asked and no failure has no other
  name. Since 2026-11-21 no reader consults it (§4.2). It goes with the column.
- **Wire.** `releaseCause` leaves the three responses that spread the row. No client and no published contract
  reads it.

### 12.6 Plan for removing `release_cause`

What is live: production runs deploy 1 (the column, `session_release_cause_chk` from 1261 widened by
1403/1404, the 1262 backfill, and writers that set the column; **no reader**: on `origin/main`,
`isFailedRelease`, `failedReleaseFilter`, `failedReleaseSql` and `isWorkFinishedRelease` have no caller outside
`common/session-release.ts`). A deploy-1 server keeps writing the column during the next hand-over, and its
reaper, finalize, source refusal and import record no turn outcome. Not deployed, free to change: 1401/1402,
1405-1407, 1421-1426.

Two facts fix the order:

1. A deploy-2 reader cannot depend on the turn outcome for a row a deploy-1 replica released during the
   hand-over. The status can bridge it: every writer of both releases writes `FAILED` exactly for a failure (the
   deploy-1 writers of 1403/1404 already do), so deploy 2's `failed` reads `finished_at IS NOT NULL AND end_reason
   IS NULL AND (last_turn_outcome = 'FAILED' OR status = 'FAILED')`. Deploy 3 backfills the hand-over rows and drops
   the status arm. **No extra deploy**: deploy 3 is needed anyway, see 2.
2. Prisma selects every column of a model unless told otherwise, so a column can be dropped only one release
   after the field leaves `schema.prisma`. Deploy 2 removes the field and stops writing; deploy 3 drops the
   column. A deploy-1 replica writing it during deploy 2's hand-over is harmless: nothing reads it, and its CHECK
   still holds.

| # | Task | Changes | Depends on | Proven by | Deploy |
|---|---|---|---|---|---|
| R1 | Take the failure constraint off the project branch | delete 1405, 1406, 1407; restate 1401 as `(status terminal) = (finished_at IS NOT NULL)` only, and 1402's backfill without `release_cause` (its `finished_at` half stays). The spec cases that assert the cause (`sessions/session-release.pg.spec.ts`) go with them | nothing | the migrated fixture lists no constraint naming `release_cause` except `session_release_cause_chk`, and `session_release_fact_chk` validated; the release spec passes | 2 |
| R2 | Failure writers record the carrying turn | W1a-W1c in turn-complete (`turnOutcomeOf` takes the acceptance failure and fails any kind); W2, W3 and W8 in `forceFinalize` (the carrying-turn rule of 12.1; W7 writes `CANCELLED`); W4 in `session-source.ts` (and drains the turn); W6 in finalize. W5 records nothing. Each writes `last_turn_outcome` in the statement that writes the release | nothing | a PG spec per writer: the carrying turn and the session read `FAILED` with the error; a W7 row reads `CANCELLED`; a W5 row has no outcome | 2 |
| R3 | One module for the three questions | replace `FAILURE_RELEASE_CAUSES` / `isFailedRelease` / `failedReleaseFilter` / `failedReleaseSql` and `WORK_FINISHED_RELEASE_CAUSES` / `isWorkFinishedRelease` with `failed` (with the status bridge arm) and `finished` of 12.2, each as predicate, Prisma filter and SQL fragment; `VERIFICATION_RUN_RELEASE_CAUSE` becomes `end_reason = 'task_done'`. The guard spec's allow-list names the bridge arm | R2 | a spec over every shape of 12.2: equal to today's reading except W7 and W5, as stated | 2 |
| R4 | Move the readers | every row of 12.3 to R3's module; the three triggers of 1425 restated on it, with `last_turn_outcome` added to their `UPDATE OF` lists | R3 | the readers' own specs unchanged except the W7 cases, which change as 12.3 says; the PG suite for the SQL readers and triggers | 2 |
| R5 | Stop writing the column | remove `releaseCause` from every writer, from `schema.prisma`, and with it from the three spread responses; drop `releaseCauseOfEndReason`, `finalizeReleaseCause`, `SESSION_RELEASE_CAUSES`. The deadlock fixture's SQL (`deadlock/lock-order-fixture.ts:420`, `:468`) loses the column | R4 | `git grep releaseCause\|release_cause` over `src/` finds only migrations; the contract and OrbitKit parity specs pass | 2 |
| R6 | Backfill the turn outcome | a migration, in batches: `last_turn_outcome = 'FAILED'` where `finished_at IS NOT NULL AND end_reason IS NULL AND status = 'FAILED' AND last_turn_outcome IS DISTINCT FROM 'FAILED' AND deleted_at IS NULL`; the carrying turn too where 12.1's rule finds one. Old turns with no outcome stay null; 1202 already covered the `FAILED` rows that existed before 1201. Run it in deploy 3, when no deploy-1 replica can release a row without an outcome | R2 live everywhere | the count of that predicate is zero on a production copy after it; the count before it is the number of rows the bridge was carrying | 3 |
| R7 | Drop the bridge | `failed` loses `OR status = 'FAILED'`; the guard allow-list shrinks | R6 | R3's spec without the bridge arm; the guard spec | 3 |
| R8 | Drop the column | `DROP CONSTRAINT session_release_cause_chk`, `DROP COLUMN release_cause` | R5 live everywhere (deploy 2 fully handed over) | the fixture: no `pg_depend` row on the column before the drop except that CHECK and the three triggers' column dependencies, which R4 removed | 3 |

The fixture shows what R8 has to clear today: `pg_depend` on `session.release_cause` lists three constraints
(the value CHECK, 1401's clause, 1406) and three triggers (the 1425 WHEN clauses). R1 and R4 remove all but the
value CHECK.

As built for deploy 3 (2026-11-22, task 351QPAh8wuz6nl3n1ghm2): R6 is migration 1441 (one statement per table,
not batches: the FAILED rows are a few hundred at most; trashed rows are not written, and the residual shape A2 gets
`CANCELLED` by the coordinator's ruling), R7 is the release module without the arm plus migration 1442 for the three
triggers, R8 is migration 1443, which checks `pg_depend` itself before it drops anything. The read-only checks to
run before and after are `scripts/session-release-cause-drop-precheck.sql` and `-postcheck.sql`;
`common/session-release-backfill.pg.spec.ts` runs all three migrations through prisma on a populated database at
deploy 2's state.

Optional, not needed for the drop: give B2 rows (an old "cancel not honored" with no end reason) `end_reason =
'cancelled'` from their `error`, so they read as an end that was asked for rather than a failure. Their number
was not measured.

### 12.7 Directions not taken

- **A. Keep `release_cause`.** Ship 1405-1407 and 1425 as they are; the session keeps a 16-value cause with a
  failure line held to the status. It worked, and production already writes it, but it is a failure fact on the
  session, which is what the owner ruled out.
- **B. A failure-only column on the session.** Replace the cause with a smaller failure field. It keeps the
  same objection with less information, and still needs every writer of 12.1 to fill it.

### 12.8 What I am unsure of

- Whether the link's "events given up" (`runner-go/session.go:1825`) can end a session that is idle. If it can,
  W6's carrying turn is the latest work turn by assumption, not by evidence.
- Whether `retry_at` is ever left set on a released row that did not fail. If never, the retry readers could
  read `finished_at` and `retry_at` alone and need no failure reading at all. Not checked.
- How many production rows R6 touches, and how many B2 rows exist. The production figures above (85, 318,
  6,880 of 12,072 sessions with a `last_turn_outcome`) were measured earlier in the project, not by this trace.
- W1a's recommendation (the reserved acceptance turn records `FAILED`) is a choice. The alternative is to leave
  it `ANSWERED` and have the attempt readers also read `error` for `ACCEPTANCE_FAILED`, as `readRunHistory`
  already does.
- The reader table rests on reading each site around its call; the large files were not read end to end.
