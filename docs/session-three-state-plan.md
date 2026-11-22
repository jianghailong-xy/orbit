# Session state: modification plan

Status: **D1, D5 and D8 decided as recommended on 2026-11-19; tracked as Orbit project
`3508bDBDE5xPH43TYuiqP`**. Written 2026-11-19 against commit
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

The owner took the recommended answer on D1, D5 and D8 on 2026-11-19. For the decisions still
open the plan takes the recommended answer. A different answer changes the
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

**Step 4.5, release B.** Release A is migration 1426 and the readers that state `finished_at IS NULL`. It shipped
in deploy 2 (`a7f28ff0ac`). Release B is migration 1444, `DROP INDEX CONCURRENTLY IF EXISTS
"session_task_execution_claim_idx"`, alone in its file because Prisma sends a file holding that statement as
one string (the header says why). It changes no server code that reads the claim, and it rides deploy 3.

The rehearsal is `apiserver/src/sessions/session-claim-index-release-b.pg.spec.ts`. It runs on a database at
deploy 2's migration state, populated with more than 2,000 synthetic sessions. It drives the auto-run sweep,
manual start, resume and the auto-retry revive from two service stacks at once, before and after the drop.
Every statement is watched at the pg driver, and it counts 42P10 errors and tasks with two unreleased
sessions. It also drills an interrupted drop: INVALID index, P3009, `migrate resolve --rolled-back`, redeploy.

Before deploy 3, confirm that no running replica states the old predicate. Two checks, both read-only:

1. **The containers.** On the deploy host, list every running container of the apiserver image:
   `docker ps --format '{{.Names}} {{.Image}}' | grep orbit-apiserver`. That covers the
   apiserver, any `-next` left by a deploy and the wiki-worker, which runs the same image. Each tag must be
   `a7f28ff0ac` or a commit that contains it (`git merge-base --is-ancestor a7f28ff0ac <tag>`). A deploy-1
   image (`45c327a903`) means the drop must wait.
2. **The database.** Run `psql "$DATABASE_URL" -X -f scripts/session-claim-index-drop-precheck.sql` twice, at
   least five minutes apart. It must show 1426 applied, 1426's index valid and unique, no INVALID index on
   `session`, and no task with two live runs. `old_carrier_calls` must not grow between the two runs.
   `old_carrier_calls` counts calls in `pg_stat_statements` to deploy 1's form of the task carrier:
   `deleted_at IS NULL` followed directly by the status list, with no `finished_at IS NULL` between them.
   Deploy 1's capacity counts, ready-to-run reads and project rollups send that form; release A sends none of
   it. The spec proves the fingerprint against both.

No statement names either index's predicate in `ON CONFLICT ... WHERE` (none since `2133b988ed`, which deploy 1
already contains), so no server can raise 42P10 from the drop. A deploy-2 server serving beside the deploy-3 one
during the hand-over sees the new index alone. Its inserts and revives are refused by that index, its P2002
classifiers match the new name (it begins with the old one), and its claim reads are planned through it.

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

Step 6.1 as built (2026-11-22, the coordinator's ruling on the failed turn). Under D9 there is no cause, so the
release carries none.

- **Declaration.** The runner sends the capability token `session-release/v1` (`SESSION_RELEASE_V1`,
  `src/shared/src/dto.ts`) in `X-Orbit-Runner-Capabilities`. The server reads it on each request. Without it, the
  old protocol applies unchanged.
- **Turn-complete.** `status` is still the turn's outcome word. With the token, a FAILED turn does everything the
  old failed-turn write does except release the session:
  - it records the turn outcome and error and copies them to `last_turn_outcome` and the session error;
  - it drains the queue, arms any retry and settles the checks;
  - the session stays held (RUNNING, on the runner's slot), with `cancel_requested_at` set as the teardown signal
    and no `end_reason`;
  - the answer is RUNNING, where the old protocol answers FAILED.

  Status FAILED, `finished_at`, the cleared running work, the inbox generation retirement, the delivered-identity
  settlement and the task's reclaim with its comment all wait for the release. The reclaim has to wait:
  `reclaimStalledTask` reclaims nothing while a session of the task is held.
- **Release.** `POST /runner/sessions/:id/release` takes the finalize body with no status word. The server reads the
  release from the locked row (`runner-api/run-release.ts`):

  | Reading | When | Result |
  |---|---|---|
  | `FAILED_TURN` | the hold above | FAILED; the task is told as the old failed turn tells it; nothing is armed again |
  | `END_ASKED` | an end reason, or a cancel without a failed turn | settles as the old finalize settles a cancel |
  | `FAILED_CUT_OFF` | `cutOffTurnOutcome: 'FAILED'` with no end asked (an engine that died before any turn it could report) | the old finalize's W6 FAILED |
  | `STOPPED` | none of the above | CANCELLED; the turn it cuts off ends CANCELLED |

  The old finalize reads the hold as `FAILED_TURN` too, so a runner that mixes the two protocols still ends failed.
- **Backstop.** If no release follows a failed turn, the reaper's cancel-grace sweep releases the session FAILED and
  keeps `last_turn_outcome` FAILED and the session's error (the failure's own words, since step 6.2), so the row reads
  as a failure and an armed retry fires. With no retry armed,
  the sweep sets the task FAILED with the run-failure comment.
- **Commit or checkpoint.** The runner chooses from what it knows itself: a failure it reported gets the permanent
  commit, and a stop it was told to make gets the undoable checkpoint.
- **Version skew.**
  - A new runner against an older server is answered FAILED on its failed turn (the old release) and 404 on
    `/release`. It should read both as the old protocol and finalize.
  - An older server meeting a held row (deploy skew of the apiserver itself): its finalize reads the cancel and
    settles CANCELLED. `releaseWasFailure` still reads the row as a failure through `last_turn_outcome`, and the
    status bridge does not.

Step 6.2 as built (2026-11-22, the coordinator's choice A).

- **How a runner learns the server offers it.** The apiserver's switch `ORBIT_SESSION_RELEASE_V1=on` is off by default.
  While it is on, every heartbeat answer carries `sessionReleaseV1: true`, the full answer and the link's quiet answer
  alike. A runner declares the protocol only while its latest successful heartbeat answer says so. It declares on
  nothing before its first answer, and it stops at the first answer without the word. The operator turns the switch on
  once every replica serves the protocol, and off before rolling back past that release (`docs/configuration.md`,
  `docs/self-hosting.md` "The runner protocol switch").
- **Where it is declared.** In the body, as `releaseProtocol: 'session-release/v1'`, because the runner link carries no
  request header. It goes only on a failed turn's report that ends the run, and on the release. A turn reported
  SUCCEEDED can still fail its session at the server (an acceptance mismatch, a swallowed delivery), and its RUNNING
  answer could not be told from a permit handed to a follow-up. Those stay on the old path.
- **A hold ends by the release alone.** It is sent again past a replica without the route, for a window longer than the
  cancel grace, and never as the old finalize, which a replica without the protocol would read as a stop. A failed
  turn's report whose answer never came is ended the same way, with `cutOffTurnOutcome: 'FAILED'`.
- **Commit or checkpoint** follows the runner's own status: a failed turn it reported keeps FAILED (the permanent
  commit), even though the hold's teardown cancel ends its context. A stop it was told to make gets the checkpoint.
- **Proof.** Go: `session_release_test.go`. The walk: `scripts/acceptance/session-release/`, one server with an old
  and a new runner, the switch on and off.

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
