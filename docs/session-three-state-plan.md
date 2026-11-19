# Session state: modification plan

Status: **proposal, nothing decided or started**. Written 2026-11-19 against commit
`a1282659a4`. It implements
[session-three-state-design.md](session-three-state-design.md) and uses the read-site list in
[session-three-state-read-sites.md](session-three-state-read-sites.md). Section and decision
numbers (§n, Dn) refer to the design document.

## 1. Shape of the plan

Six phases. Each ships alone, leaves the system consistent, and can be the last one done.

| Phase | What it delivers | Depends on | Size |
|---|---|---|---|
| 0. Groundwork | decisions, three traces, a guard test, lenient decoders in clients and runners | nothing | S |
| 1. One definition of "working" | fixes the misclassification of §11, the owner's background-process example included | 0 | M |
| 2. Turn outcome | a failed or interrupted turn is recorded on the turn | 0 | S |
| 3. Release fact | "released" and its cause are columns, held equal to the status by a constraint | 0 | M |
| 4. Server readers | no server code asks which terminal value a session has | 2, 3 | XL |
| 5. Wire and clients | web, Apple, Android and agents read the new fields | 1, 4 | L |
| 6. Runner protocol | the runner reports a turn's outcome and a release as two things | 4 | M |

Storing only three values in `status` (§8 stage 6) is not planned here. D6 recommends deciding
it after phase 5.

Phases 1, 2 and 3 do not depend on each other and can run in parallel. Phase 1 has the most
visible effect and the least risk, so it goes first if only one thing is started.

## 2. Assumptions

The plan takes the recommended answer to every open decision. A different answer changes the
plan as shown.

| Decision | Assumed | If the owner decides otherwise |
|---|---|---|
| D1 released is a column beside three states | yes | a fourth status value instead: phase 3 writes a status, phase 4 is unchanged |
| D5 a task's result is read from the release cause and turn outcome on its session | yes | switching `TaskAttempt` on becomes a phase of its own before 4.5, with a backfill |
| D8 `RUNNING` includes work outside a turn | yes | phase 1 shrinks to steps 1.1 to 1.5; the new wire field in 5.1 is turn-only |
| D2 plain conversation "Succeeded" | undecided | phase 4.6 and the web/app wording wait for it; nothing else does |
| D3, D4, D7 | yes | small wording or rule changes inside phases 4 and 5 |

New findings since the design document, both from reading the code:

- **`finishedAt` can be the release column.** Five of the eight terminal writers already set
  it and the revive clears it. The three that do not are the two landing-container writes
  (`src/apiserver/src/projects/landing-session.ts:256`, `:373`) and the failed transcript
  import (`src/apiserver/src/runner-api/runner-api.controller.ts:10234`). So phase 3 adds one
  column, `release_cause`, not two.
- **The name `activity` is taken.** Session payloads already carry
  `activity: 'TURN' | 'BACKGROUND_JOB' | 'WAITING' | null`
  (`src/shared/src/task-run-reason.ts:28`). The three-state field needs another name; this
  plan calls it `phase` until the owner names it.

## 3. Phase 0: groundwork

No behaviour changes.

| Step | Work | Done when |
|---|---|---|
| 0.1 | Owner decides D1, D5 and D8; the others may wait | recorded in the design document |
| 0.2 | Trace when a runner finalizes a plain conversation as `SUCCEEDED` (D2) | the answer is written into §9 |
| 0.3 | Trace what a restarted runner reports for background jobs it lost (§11.3 item 4) | the answer is written into §11 |
| 0.4 | Dump the status-dependent functions, triggers and indexes from a migrated database and compare with appendix section A | the 17 rows are confirmed or corrected |
| 0.5 | Guard test: a spec that lists the files allowed to name a terminal status value or a hand-written live set, seeded from the appendix, failing on a new one (same idea as `src/web/src/copyLanguage.test.ts`) | the spec passes on main and fails on a planted new reader |
| 0.6 | Apple: give `RunStatus` an unknown case so one unexpected value no longer fails the whole list (`src/macos/OrbitKit/Sources/OrbitKit/Models/Enums.swift:7`) | a decoding test with an unknown value passes |
| 0.7 | Android: `SessionSummary.status` gets a default; an unknown status no longer throws when `capabilities` is absent | a decoding test passes |
| 0.8 | Runner: an unknown status on a reclaimed row is treated as open when the server says the lease is held (`src/runner-go/runloop.go:696`) | a unit test passes |

Steps 0.6 to 0.8 change nothing today. They start the clock: every release after them is a
build that survives a new status word, which is what makes D6 decidable later.

## 4. Phase 1: one definition of "working"

Goal: the seven hand-written answers of §11.2 become three named questions asked in one
module, and the five wrong results of §11.3 are fixed.

| Step | Work | Files | Done when |
|---|---|---|---|
| 1.1 | New module with three questions, each as a TypeScript predicate, a Prisma filter and a SQL fragment: **executing** (dispatched turn, engine turn, subagent, background job), **willWake** (watch, scheduled wake-up, armed retry), **holdsSlot** (dispatched turn only). Built from `task-work-carrier.ts` and `session-generating.ts`, which then import it | `apiserver/src/common/` | the two existing modules give the same answers as before, by their own specs |
| 1.2 | Approval alert and Needs-you badge use **executing**, and count a card raised by a background job | `push/push.service.ts:296-309`, `:1634-1668` | new spec: a card from a background job on an idle-looking session rings and is in the badge |
| 1.3 | New watch condition "nothing executing and nothing armed to wake it"; `session_await` and `session_create(wait)` default to it. `SESSION_TURN_SETTLED` keeps its meaning | `watches/watch-predicate.ts`, `contracts/watch.contract.json`, `runner-go/watch_tools.go`, `runner-go/mcp*.go` | new spec: a child that ended its turn with a job running does not satisfy the default; full CI, because JS specs read the Go descriptors |
| 1.4 | A scheduled run lands only when its session is not **executing** | `schedules/schedule-runs.service.ts:685-691` | new spec: a run with a job still going does not land |
| 1.5 | The workspace rail, the session row and the task carrier use one rule for a quiet job | `sessions/sessions.service.ts:3858`, `:4710`, `sessions/task-work-carrier.ts` | one job gives the same verdict on the task and on the session |
| 1.6 | The runner's beat states, per session, the full set of what is executing (engine turn, subagents, jobs, shells); the server replaces its inferred sets from it | `runner-go/` heartbeat, `runner-api/link-heartbeat.ts`, `runners/runner-background-holders.ts` | a job whose end report was lost disappears at the next beat; older runners keep today's inference |
| 1.7 | A lost runner: an idle-looking session that was **executing** on it has its sets cleared and is treated as 0.3 found it should be | `realtime/reaper.service.ts:532-560` | new spec; no task reads as running with nothing left to wake it |

Order: 1.1 first, then 1.2 to 1.5 in any order, then 1.6, then 1.7. Step 1.3 changes the
published agent contract and needs a contract version bump. Step 1.6 needs a runner release.

## 5. Phase 2: turn outcome

| Step | Work | Done when |
|---|---|---|
| 2.1 | Migration: `conversation_turn.outcome` (`ANSWERED`, `FAILED`, `INTERRUPTED`, `CANCELLED`) and `error`; `session.last_turn_outcome` | additive, no reader yet |
| 2.2 | Turn-complete writes both, in the same statement that writes the status today (`runner-api/runner-api.controller.ts:7810-7832`) | spec: the three runner outcomes each land on the turn and the session |
| 2.3 | Backfill `session.last_turn_outcome` from `status` and `end_reason`; old turns stay null | counts match per status |

## 6. Phase 3: release fact

| Step | Work | Done when |
|---|---|---|
| 3.1 | The three writers that skip `finishedAt` set it (§2) | spec per writer |
| 3.2 | Migration: `session.release_cause`; the eight writers of §6.3 write it; the revive clears it | spec per writer |
| 3.3 | Backfill `finished_at` on terminal rows that lack it and `release_cause` on all terminal rows, in batches | zero terminal rows without both; zero open rows with either |
| 3.4 | CHECK, added `NOT VALID` then validated: the status is terminal exactly when `finished_at` is set | validated in production |
| 3.5 | One module for "released" and "held": a predicate, a Prisma filter, a SQL fragment. The hand-copied live and terminal sets import it (`common/session-scheduling.ts`, `sessions/sessions.service.ts:6340-6352`, `runner-api/runner-api.controller.ts:1069-1075`, and the others the guard test lists) | the guard test's allow-list shrinks to this module |

After 3.4 the two spellings are provably equal, so every later swap from "status is terminal"
to "`finished_at` is set" changes no behaviour and can be reviewed mechanically.

## 7. Phase 4: server readers

The largest phase: 93 server rows and 14 database objects marked `MOVE` in the appendix
(sections A to D). Split by risk, lowest first.

| Step | Work | Rows | Done when |
|---|---|---|---|
| 4.1 | `TURN` readers read the turn outcome: failed badge inputs, merge-repair child, help marker, the "failed" settle alert | appendix B, C | specs unchanged |
| 4.2 | `REL` readers in TypeScript read the release module: lease gates, resume gate, merge and commit drains, session move, reaper sweep | appendix B, C | specs unchanged |
| 4.3 | `REL` readers in raw SQL: dispatch sweeps, the task carrier, runner link hints, capacity counts | appendix C, D; hardest sites 2 of §6.4 | specs unchanged; the PG suite, because unit specs do not run this SQL |
| 4.4 | Database functions: the six guards, the three acquisition guards and the three ended-triggers read `finished_at` and `release_cause`; `finished_at` joins their trigger column lists | appendix A | 0.4's dump re-run shows no status literal for a terminal value |
| 4.5 | The unique index, in two releases. Release A: build `... WHERE task_id IS NOT NULL AND deleted_at IS NULL AND finished_at IS NULL` concurrently beside the old index; dispatch states the new predicate. Release B: drop the old index | hardest site 1 | no replica states the old predicate before B |
| 4.6 | `WORK` readers read the cause and turn outcome (D5): retry counts and model escalation, the verification gate, schedule runs, coordinator handoff, the ended-attempt producers | appendix C, D | specs unchanged; retry counts on a production copy match before and after |
| 4.7 | Wake rules and credential gates read `release_cause` (D4) | appendix C | specs unchanged |
| 4.8 | The legacy fields (`status`, `runState`, `sessionState`) are produced by one projector from the new facts | `sessions/session-state.ts` | the guard test allows a terminal value in the projector, the eight writers and nowhere else |

Step 4.5 is the one that can double-run a task if it is wrong. It gets its own task, its own
review and a rehearsal on a production copy.

## 8. Phase 5: wire and clients

| Step | Work | Done when |
|---|---|---|
| 5.1 | Every session payload gains `phase` (`PENDING`, `RUNNING`, `IDLE`, from phase 1's **executing**), `released`, `releaseCause`, `lastTurnOutcome`, `waitingOn`. Old fields unchanged | shared DTOs, the contract spec and the OrbitKit parity spec pass |
| 5.2 | Web reads the new fields: 20 rows, almost all through `web/src/lib/sessionState.ts` and `sessionCapabilities.ts` | mocks first for any visible change, then the web suites |
| 5.3 | Apple: 21 rows. Send-or-resume, the wait after End and the finished notification read `released`, not the raw status | `swift test`, and a `client.yml` probe build |
| 5.4 | Android: 20 rows, the same three behaviours plus the push filter | the Android unit suite |
| 5.5 | Agents: `session_get` and `session_list` return the new fields; the seven-value `--status` filter stays | contract version bump; full CI |

Visible wording changes (a "Failed" mark from the turn outcome, "Working" while a job runs)
need the owner's look at mocks before 5.2.

## 9. Phase 6: runner protocol

| Step | Work | Done when |
|---|---|---|
| 6.1 | Server: turn-complete accepts an outcome without ending the run, and a separate release call carries the cause. The old calls keep working | both protocols pass the runner-API specs |
| 6.2 | Runner: a failed turn is reported as an outcome; release is its own call with a cause, which also decides permanent commit or undoable checkpoint (`src/runner-go/worktree.go:1071`) | Go suite; a real-stack walk with an old and a new runner against one server |

## 10. Risks

| Risk | Where | Guard |
|---|---|---|
| A task runs twice | 4.5 | two releases, rehearsal on a production copy, the CHECK of 3.4 |
| The new columns drift from the status | phases 2 to 4 | the CHECK of 3.4; writers set both in one statement |
| An old client or runner meets a value it cannot read | phases 5, 6 | old fields never change; 0.6 to 0.8 ship first |
| New readers of the old vocabulary appear while the work is in flight | all | the guard test of 0.5 |
| A slow statement on the `session` table | 3.3, 3.4, 4.5 | batches, `NOT VALID` then validate, concurrent index build |
| The published agent contract changes meaning | 1.3, 5.5 | a new condition beside the old one, never a redefinition |

## 11. What to start with

If one thing is started now: phase 0, then steps 1.1 and 1.2. That is small, fixes a real
defect (an approval nobody is told about), and needs only D8.

If two lines of work run: add phase 3 up to step 3.4. It changes no behaviour and is the
foundation everything in phase 4 stands on.

## 12. Not verified

- Sizes are estimates from the read-site counts, not from doing any of the work.
- Steps 0.2 to 0.4 are in the plan because their answers are not known yet; steps 1.7, 4.4
  and 4.6 may change when they are.
- The `finishedAt` finding comes from reading the eight writers, not from production data.
  Step 3.3's counts are the real check.
- Nothing here was built or run.
