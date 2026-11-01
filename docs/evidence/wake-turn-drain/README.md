# Wakeups on a drained turn: census, fix, and checks (task F)

Project `34pUaJboWdDFzjftkEso8` ("Long-running loops that do not break silently"), task F
(`34pj6T76KGcbaGgQmrkWW`). Baseline: commit `1031a2052`. Contract: `docs/long-running-loop-contract.md` §1.2, §1.6,
§3, §4.

## The defect

A wakeup that comes due while its session still reads RUNNING is filed onto a queued `bg-wake:` turn and its row is
settled DELIVERED at once. That happens when the runner has just died and the reaper has not run yet (about 90 s), or
when a long turn is running. If that queued turn is then answered together with the rest of the queue when the run
ends, nothing settled the wakeup:

- a one-shot wakeup stayed DELIVERED. The worker only scans PENDING, so it was never filed again, never retried, and
  nobody was told;
- a loop's tick stayed DELIVERED and kept counting as a run. Task E measured this: loop B's tick 9 was filed onto
  turn seq 10, which the reap answered with `delivered_at` null. The next block said 34 ticks missed when 35 had
  not run, and the loop ended at 15 fired / 34 missed when 14 had run and 35 had not.

The two production wakeups never delivered in 30 days may be this, but they were not checked one by one; nothing here
claims they were.

## Census

Every statement at `1031a2052` that writes `conversation_turn`, found by
`git grep -n -E "conversationTurn\.(deleteMany|updateMany|delete|update)\b|UPDATE \"conversation_turn\"|DELETE FROM \"conversation_turn\""`
over `src/apiserver/src` (specs and the inventory excluded). No migration writes `conversation_turn` from a trigger
(`git grep` over `prisma/migrations/*/migration.sql`: 0 files). The two reads the task named are listed as well. A
line number is the statement's first line; the task named the line after it (`reaper.service.ts:895`,
`runner-api.controller.ts:7081` and `8737`, `sessions.service.ts:7754`).

"Reaches a queued `bg-wake:` turn" means it can answer or delete a PENDING turn whose `client_turn_id` starts with
`bg-wake:` while a wakeup or a job's wake is filed onto it.

### Answers or deletes a session's unrun turns: changed

| Site (`1031a2052`) | What it does | Settled wakeups before? | Reaches a queued `bg-wake:` turn? | Now |
| --- | --- | --- | --- | --- |
| `realtime/reaper.service.ts:894` `forceFinalize` | Answers every turn not ANSWERED, as the reap ends the run (runner offline, unhonored cancel/end, runtime not initialized, API-error backstop). | No | Yes: a tick or one-shot wakeup due between the runner's death and the reap is filed behind the turn the runner died in (task E, tick 9). | `settleUnrunWakeTurns(tx, id, { drained: true })` right before the drain; the push after commit. |
| `runner-api/runner-api.controller.ts:7080` `turnComplete`, `failSession` | Answers every turn not ANSWERED when a failed turn fails its session. | No | Yes: a wakeup that came due while the failing turn ran is queued behind it. | Same call before the drain; the push after commit. |
| `runner-api/runner-api.controller.ts:8736` `finalize` | Answers every turn not ANSWERED when the runner finalizes the session (SUCCEEDED, FAILED, CANCELLED). | No | Yes: the same queued wake turn. | Same call before the drain; the push after commit. |
| `sessions/sessions.service.ts:7753` `transitionEnd`, session still PENDING | CANCELLED at once; answers every turn not ANSWERED. | No | Yes: a wakeup due while the session was parked queues the session (PENDING) on a wake turn. | Same call before the drain (the session has ended: dropped, nobody told). |
| `sessions/sessions.service.ts:7769` `transitionEnd`, live session | Answers every PENDING message turn and queues an `end` turn. | No | Yes: a queued wake turn is a PENDING message. | Same call before the answer (ending: dropped, nobody told). |

### Already settled, and the counts now too

| Site (`1031a2052`) | What it does | Settled wakeups before? | Reaches a queued `bg-wake:` turn? | Now |
| --- | --- | --- | --- | --- |
| `sessions/sessions.service.ts:6232` `interrupt` | Deletes every PENDING message, shell and steer turn behind the interrupted one. | Yes: `settleUnrunWakeTurns({ interrupted: true })` at 6205, CANCELLED. | Yes | Unchanged state (CANCELLED). The tick also leaves its loop's runs: fired − 1, missed + 1 per loop and turn. |
| `sessions/sessions.service.ts:6221` `interrupt` | Retires a PENDING CURRENT_WORK target in place. | Yes, the same call runs before it. | Only a target that is a requeued wake turn; covered by the same call. | Same as above. |
| `sessions/sessions.service.ts:6604` `cancelQueuedTurn` | Deletes the one queued turn its owner withdrew. | Yes: `settleUnrunWakeTurns({ turnId })` at 6598, CANCELLED. | Yes | Unchanged state; the tick leaves its loop's runs. |
| `runner-api/runner-api.controller.ts:1318` (from `turnComplete`) | Writes off wake steers a Stop overtook after a runner took them. | Yes: `settleUnrunWakeTurns({ steerTurnIds })`. | Steers only. A tick is filed onto message turns only, so there is no count to correct. | Unchanged. |

### Moves the payload first, no wakeup left behind: unchanged

| Site (`1031a2052`) | What it does | Why no change |
| --- | --- | --- |
| `runner-api/background-job-wake.ts:261` `foldQueuedWakeTurnsInto` | Deletes the other unannounced queued wake turns after a missed steer is requeued. | It moves their job wakes and their DELIVERED wakeups onto the kept turn first, so nothing is left pointing at a deleted turn. |
| `runner-api/background-job-wake.ts:302` `takeJobOffNextTurnQueue` | Deletes a queued wake turn that was left carrying nothing. | It deletes the turn only when no job wake and no DELIVERED wakeup is left on it. |

### Reaches no queued `bg-wake:` turn: unchanged

| Site (`1031a2052`) | What it does | Why no change |
| --- | --- | --- |
| `sessions/sessions.service.ts:6621`, `:6648` `cancelQueuedTurn` | Deletes one steer the reader typed (undelivered, or still PENDING). | Orbit-authored turns are refused before this point (`isOrbitAuthoredTurn`). |
| `sessions/sessions.service.ts:6729` `awaitSteerWithdrawal` | Deletes a PENDING `withdraw` control turn nobody answered. | Kind `withdraw`, never a wake. |
| `sessions/sessions.service.ts:6821` `steerQueuedTurn` | Turns a PENDING message into a steer, by id. | Refuses an Orbit-authored turn; it answers nothing. |
| `sessions/sessions.service.ts:4883`, `:4985` | Expires or re-queues one `artifact` turn. | Kind `artifact`. |
| `sessions/steer-withdraw.ts:95`, `:100` `settleSteerWithdrawal` | Deletes one IN_FLIGHT steer the engine gave back; writes the withdraw turn's outcome. | A typed steer, by id. |
| `sessions/current-work-delivery.ts:109` `requeueUnreadCurrentWorkSteers` | Turns unread steers back into queued messages. | Answers nothing; the row and its key stay, so a wake on it is still delivered. |
| `sessions/current-work-delivery.ts:212` `terminalizePendingCurrentWorkSteers` | Answers CURRENT_WORK steers undelivered (FAILED, UNCONFIRMED). | Steers only, and a wakeup is never filed onto a steer. A job's wake on a wake steer keeps its row, as it did under an interrupt before; the job wake itself being lost is the residual the task accepts. |
| `sessions/session-request.ts:1213` `foldQueuedReplyTurnsInto` | Deletes queued reply turns after moving their outcomes. | Reply turns (`SESSION_REPLY_TURN_PREFIX`), not wakes. |
| `runner-api/runner-api.controller.ts:4185`, `:4344`, `:4455` (lease takeover, activation, release) | Expire the lease of IN_FLIGHT turns. | Re-delivery, not an answer. |
| `runner-api/runner-api.controller.ts:4618`, `:4631` `artifactResult` | Answer one `artifact` turn. | Kind `artifact`. |
| `runner-api/runner-api.controller.ts:4840`, `:4972` `dequeueTurn` | Renew a lease; the claim (IN_FLIGHT). | The claim is the delivery itself. |
| `runner-api/runner-api.controller.ts:4903` `dequeueTurn` pause | Puts expired IN_FLIGHT messages back to PENDING. | Still queued, same key: the wakeup on it is delivered later. |
| `runner-api/runner-api.controller.ts:5279`, `:5290`, `:5304` `dequeueTurn` | Context key; acks control turns on delivery; un-stamps a refused reload. | Not wake turns (message turns are not acked here). |
| `runner-api/runner-api.controller.ts:6249` `turnComplete` steer requeue | One leased steer back to a queued message. | Still queued (then folded, see above). |
| `runner-api/runner-api.controller.ts:6297`, `:6526` `turnComplete` | Ack of the completed steer, or of the completed turn (by id, `delivered_at` not null). | That turn was handed to the engine, so its wakeups ran. A turn put back in the queue keeps its key and its wakeups. |
| `runner-api/runner-api.controller.ts:6788` `turnComplete` | Legacy steers with no intent become messages. | Answers nothing. |
| `runner-api/runner-api.controller.ts:7991` events | Acks CURRENT_WORK steers the engine confirmed. | Delivered. |

### Reads only

| Site (`1031a2052`) | What it does | Why no change |
| --- | --- | --- |
| `projects/attempt-ended-unsettled.producer.ts:264` `readSession` | Reads whether the session has a turn not ANSWERED (`hasUnansweredTurn`). | It writes nothing. The settlement runs inside the drains, before them, and writes no turn, so what it reads is unchanged. |
| `sessions/abandoned-approvals.ts:153` `reapApprovalsOfEndedTurns` | Reads the live turns, to abandon approvals whose turn ended; runs after each drain. | It writes approvals only. The turns it reads are the drain's, which the settlement does not change. |

### Deleting the session

`ReaperService.purgeTrash` (`reaper.service.ts:344`) and `SessionsService` purge (`sessions.service.ts:10123`) delete
the session row. `session_scheduled_wakeup`, `session_wakeup_loop` and `background_job_wake` cascade with it, so no
wakeup is left pointing anywhere.

## The fix

`src/apiserver/src/runner-api/wake-turn-withdraw.ts`: `settleUnrunWakeTurns` gains a fourth door, `{ drained: true }`.
It reads the PENDING `bg-wake:` turns while they are still PENDING, deletes their job wakes, takes their ticks out of
their loops' runs (`uncountUnrunTicks`), and settles every DELIVERED wakeup on them by the session as the drain has
just written it (`scheduled-wakeup.ts` `tickStanding`, moved there unchanged from the worker so that both read one
definition):

| On the drained turn | Session | Settled to |
| --- | --- | --- |
| loop tick | any | DROPPED; its loop's `ticks_fired − 1`, `ticks_missed + 1` once per loop and turn |
| one-shot | FAILED, retry armed, no newer one waiting | SUPERSEDED, plus a PENDING copy (reason, prompt, delay, due time, request time). The worker holds it while the retry is armed and files it once the session is back. |
| one-shot | FAILED, retry armed, a newer one waiting | SUPERSEDED; the newer one untouched |
| one-shot | FAILED, no retry armed | DROPPED; returned to the caller, which pushes `wakeup-dropped` (SESSION_FAILED) after the commit |
| one-shot | ended or ending | DROPPED; no push |
| job wake | any | deleted, as a withdrawal deletes it |

A turn already handed to the engine (IN_FLIGHT) is never read, so the ticks on it stay DELIVERED and counted.

**Why a copy and not the same row back to PENDING.** The task asked for the row itself to go back to PENDING with
`client_turn_id` and `settled_at` cleared. That does not deliver it. The worker files a one-shot under the turn key
`bg-wake:wakeup:<its id>`, the drained turn keeps that key (unique on session and key), and `createTurn` answers a key
it has already seen by replaying that turn (`sessions.service.ts:5722`). The first run of `wake-turn-drain.pg.spec`
showed it: after the session came back the worker answered DELIVERED and the row stayed PENDING. So the wakeup waits
again as a copy, and the original row says SUPERSEDED with the turn it had been filed onto.

**The push.** `ReaperService` gets `@Optional() push?: PushService` like its other optional collaborators. RealtimeModule
already imports PushModule, so Nest injects the application's PushService.
`src/apiserver/src/realtime/reaper-push-wiring.spec.ts` builds RealtimeModule with `NestFactory` and asserts that the
reaper holds that very instance. `RunnerApiController` already had `push`. `signalDrainedWakeups` sends after the
commit and only logs a failure.

**The counts after an interrupt and a withdrawal.** These doors already called `settleUnrunWakeTurns`, and their ticks
stay CANCELLED, but the ticks used to keep counting as runs. They now leave the runs the same way, so `ticks_fired`
says what ran whichever door took the turn. This goes past the four drains the task named; contract §1.2 states it.

**Lock order.** Every caller holds the session row already: FOR UPDATE (interrupt, withdrawal, `turnComplete`,
`finalize`, `transitionEnd`) or FOR NO KEY UPDATE through its status UPDATE (`forceFinalize`). The settlement takes no
session lock of its own and writes only rank-60 children: loop rows (sorted by id) before tick rows, which is the order
of `settleLoopTick` and `endWakeupLoop`. `common/lock-order.ts` (the `session_wakeup_loop` paragraph) and
`common/db-write-inventory.ts` (the four units, `settleUnrunWakeTurns`, the new `uncountUnrunTicks`) say so.

There is one race. A one-shot moved into PENDING and a concurrent runner-door request (which holds the session FOR KEY
SHARE only) meet on `session_scheduled_wakeup_one_pending_key`, and whichever commits second fails with 23505. One
wakeup waits either way. It can only happen in a drain whose session has just FAILED with a retry armed, when no engine
of that session is running to ask.

## Checks

Every run below is a `bg_run` job on runner `workstation-gpu`; its output is stored under the job id. The fix is
commit `f981f8e28`, and `4559a8367` adapts three unit doubles (below). Spec files:

- `src/apiserver/src/runner-api/wake-turn-drain.pg.spec.ts`: nine cases, listed in the file's header. Every drain goes
  through its real door: `ReaperService.tick` → `forceFinalize`, `RunnerApiController.turnComplete` and `finalize`,
  `SessionsService.end` → `transitionEnd`, `interrupt`, `cancelQueuedTurn`. Rows are set up with SQL only where a
  case needs a precondition, such as a runner that died or an end that was never honored.
- `src/apiserver/src/realtime/reaper-push-wiring.spec.ts`: builds the production `RealtimeModule` with `NestFactory`
  and asserts that the `ReaperService` it constructed holds the application's `PushService` instance.

### The new specs: green on the fix, red on the baseline

| Run | Job | Result |
| --- | --- | --- |
| `scripts/run-pg-spec.sh` on commit `f981f8e28` (fresh container; a skip counts as red): `wake-turn-drain`, `scheduled-wakeup-loop`, `scheduled-wakeup` | `bgj_f121dddba2ca` | exit 0. `wake-turn-drain` 10/10 (9 cases and their parent), `scheduled-wakeup-loop` 19/19, `scheduled-wakeup` 8/8, 0 skipped |
| `wake-turn-drain` on the fix, final spec text (dev PostgreSQL) | `bgj_1419ea49f679` | 10/10 |
| The same spec against `1031a2052`'s production code: `baseline.sh` puts the six changed runtime files back with `git show` and keeps the new specs | `bgj_1419ea49f679` | `wake-turn-drain` 0/10, `reaper-push-wiring` 0/1. Afterwards the working tree's diff was byte-identical to the fix again. The baseline build exits 4 on one type error only: the spec passes `ReaperService` a sixth argument, `push`, which the baseline constructor does not take, and tsc emits anyway. |

The first assertion each case fails on the baseline (`baseline-result.txt`):

| Case | Baseline failure |
| --- | --- |
| 1 reap, retry armed | the wakeup filed onto the drained turn was not replaced (`DELIVERED`, expected `SUPERSEDED` plus its PENDING copy) |
| 2 reap, no retry | the wakeup on the drained turn was not dropped (`DELIVERED`); no `wakeup-dropped` push; the job wake survives |
| 3 newer one waiting | the drained wakeup was not superseded (`DELIVERED`) |
| 4 session ended (4 ways) | all four `DELIVERED`, expected `DROPPED` |
| 5 task E's loop B | tick 9 `DELIVERED`, expected `DROPPED` |
| 6 tick handed to the engine | the two queued ticks `DELIVERED`, expected `DROPPED` (the in-flight tick's own assertion holds on both trees; mutant M6 shows it is checked) |
| 7 turn-complete drain | the one-shot `DELIVERED`, expected `DROPPED` |
| 8 finalize FAILED | `DELIVERED`, expected `DROPPED` |
| 9 interrupt, withdrawal | counts `[2, 0]`, expected `[1, 1]` |

What case 5 shows on the fix: tick 9 is filed behind the turn the runner died in (turn seq 10, PENDING, behind seq 9
IN_FLIGHT), and the reap answers seq 10 with `delivered_at` null. Tick 9 is DROPPED, tick 8 stays DELIVERED, and the
counts drop from 9/0 to 8/1. Ticks 10–38 are missed while the retry waits for the runner. The auto-retry then gives up
after MAX_OFFLINE_WAIT_MS, and ticks 39–43 are missed because their revives are refused with the runner away. This
follows task E's log: `reaped … (runner offline)` at 21:19:07, then `could not revive … the runner is offline` from
21:49:31. Tick 44 then revives the session, and its block says `loop: tick 44, every 60 seconds until …; 35 ticks
missed since the last run`. The loop row and session_get both read 9 fired and 35 missed, which is ticks 1–8 and 44
run and 9–43 not. `loop.lastFiredAt` is tick 44's `delivered_at`, as `lastLoopRun` reads it.

### Mutation check

`mutants.mjs` makes 22 mutants by editing the compiled `build/` tree. For each it runs `wake-turn-drain.pg.spec` and
`reaper-push-wiring.spec`, then restores the bytes. Job `bgj_fb7b2ffe094e`, on the final spec text: all 22 killed,
and the compiled files were restored byte for byte. The killers of each mutant are in `mutants-result.txt`. Among
them:

- M1–M5: each drain without the settlement (reap, failed turn, finalize, End of a queued session, End of a running
  session).
- M6: settling IN_FLIGHT turns too. Killed by cases 5, 6 and 9.
- M7–M9: counts never corrected; one run fewer per tick instead of per turn (case 6); only drains correcting counts
  (case 9).
- M12: the task's literal semantics, the drained row itself back to PENDING. Killed by case 1: it is never filed again.
- M14: a copy made although a newer wakeup waits. The unique index refuses it and the reap fails (case 3).
- M15–M20: a drop with a FAILED session not told; a drop with an ended session told; each of the three doors not
  pushing; a drop pushed twice.
- M21: a job's wake kept on the drained turn (case 2).
- M22: the reaper discarding the PushService it is given. Killed by case 2 and by the wiring spec.

### Regressions, the unit suite and the censuses

| Run | Job | Result |
| --- | --- | --- |
| 26 pg specs around wake turns, the reaper, completion and finalize (`pgset.sh`) | `bgj_81f208641ed8` | all green, 0 skipped: `related-specs-result.txt`. Includes `scheduled-wakeup-loop` (A1/C1/C2), `scheduled-wakeup`, the five `background-wake-*`, `background-job-wake`, `session-request`, `control-plane-leader`, `runner-presence`, the four watch specs that build a reaper, `turn-complete-unanswered`, `auto-retry-startup-failure`, `kept-turn-completion`, `deadlock/lock-order` (16/16) and `managed-runner-wake`. |
| apiserver unit suite (`npm test`) on `f981f8e28` | `bgj_12d279480dd9` | 5749/5753. The four failures were three hand-made transaction doubles whose `conversationTurn.findMany` ignores its filter, so the settlement found "queued wake turns" there and called a method the double lacked (`backgroundJobWake.deleteMany`, `sessionScheduledWakeup.findMany`). |
| The same after `4559a8367`, whose doubles answer those reads with nothing filed | `bgj_fb7b2ffe094e` | 5753/5753. This includes `db-write-inventory.spec`, `lock-order.spec` and `reaper-push-wiring.spec`. |
| `db-write-inventory.spec`, `lock-order.spec`, `reaper-push-wiring.spec` on their own | `bgj_84ea0c014fa7` | 18/18 |
| `npm run build -w @orbit/apiserver` (production tsc) | `bgj_12d279480dd9` | exit 0 |

## Limits

- One process and one PostgreSQL per run. No isolated stack with a real runner and a real engine was run for this
  task; case 5 replays task E's sequence through the production code instead.
- The race between a re-armed copy and a concurrent runner-door request is argued, not forced in a spec.
- A fold of two queued turns that each carry a tick of one loop (`foldQueuedWakeTurnsInto`, rare) already counted two
  runs before this change. A drain of the merged turn takes one of them back, not two.
- The two production wakeups that never arrived were not checked one by one against this cause.
