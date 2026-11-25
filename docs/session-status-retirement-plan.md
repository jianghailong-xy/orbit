# Retiring `session.status`: the migration plan

For the owner's approval before any migration task is filed (project 353SgnUjvamRr06Sho0EZ, criterion
2DEMvJ1uM8Bx2Uu9FoXW9B). Written 2026-11-25 against `6f127f0a33`, the project branch. The server, shared and runner
code there is the code of `9f94177875`, where [session-status-storage-options.md](session-status-storage-options.md)
("the note") was written (`git diff 9f94177875 6f127f0a33 -- src/apiserver src/shared src/runner-go` is empty), so the
note's line numbers still hold. **This is a plan: no product code was changed.**

It follows three owner rulings of 2026-11-25 on the project:

- `353V5TK8fxzXRtLRxom0X`: stop reading `session.status`; reads go to `session.phase`.
- `353V7WNzh377J93efTjJ4`: the server reads `phase` too, with one more explicit fact for "a dispatched turn holds a
  runner slot", because `phase` is RUNNING for background jobs and sub-agents as well.
- `353V98YS1zSj3ugrGpclE`: `session.status` is retired, neither read nor written; the server derives the legacy wire
  words from the facts; a few kinds of row may change word ("Accept those few word changes").

Paths are under `src/apiserver/src/` unless they start with `src/`, `prisma/` (= `src/apiserver/prisma/`), `scripts/`,
`contracts/` or `docs/`. `ctl` is `runner-api/runner-api.controller.ts`. "The catalog" is a PostgreSQL 16 with all 681
migrations of this tree applied, read with `scripts/session-status-db-objects.sql` and the queries beside it (§9).

## 0. The plan on one page

**End state (after deploy 4).** There is no column `session.status` and no type `run_status`. Beside the facts that
exist today the session stores two:

| Column | Values | Means | Kept by |
|---|---|---|---|
| `phase` | `PENDING`, `RUNNING`, `IDLE` | The session's state: today's `deriveSessionPhase` (`sessions/session-phase.ts:65-69`), stored | one database trigger, from the facts; no writer sets it |
| `turn_state` | `QUEUED`, `IN_FLIGHT`, `ABANDONED`, or null | Where the session's turn stands for the runner: waits for a claim; **a dispatched turn holds a runner slot** (the explicit slot fact); its runner was stopped under it | the writers that move a turn: create, enqueue, claim, turn-complete, the stops, the releases |

Released stays `finished_at`; the last turn's result stays `last_turn_outcome`; why an end was asked stays
`end_reason`; a landing container stays `kind = 'LANDING'` with its `project_landing` row. The server words `status`,
`runStatus`, `runState` and `sessionState` for deployed apps and runners from those facts, through one projector
(§3.1).

**Behaviour.** Each word the claim, slot, dispatch, reclaim and takeover rules read today becomes exactly one value of
`turn_state` (PENDING = QUEUED, RUNNING = IN_FLIGHT, INTERRUPTED = ABANDONED, AWAITING_INPUT = held with none), and a
CHECK holds the two spellings to the same rows while both exist. Every rewritten rule therefore selects the same rows
as before (§1.4). Phase never decides a slot.

**Deploys.** Four, each handing over between server replicas, plus a batched backfill between the first two (§4.1):

| Deploy | What decides | Database | Code |
|---|---|---|---|
| D1 | the stored word | `turn_state`, `phase` added; a trigger derives them from the word | unchanged |
| (backfill) | the stored word | every row's `turn_state` and `phase` written, in batches | — |
| D2 | the stored word, the facts equal to it by CHECK | CHECKs, partial indexes, the triggers and functions read the facts | every reader on the facts; writers write both |
| D3 | the facts | a trigger derives the word from the facts, for rollback only | writers write the facts only; `status` leaves the Prisma model |
| D4 | the facts | `status` and `run_status` dropped | unchanged |

**What a person or runner sees change.** Seven kinds of released row read another legacy word (§3.4), each between
terminal words (mostly Failed or Succeeded becoming Ended): the end the runner did not honour and the old SUCCEEDED
rows with no end, which the owner accepted, and five the owner has not seen yet (one current writer, one legacy set,
three expected to hold no rows or very few). The out-of-memory stop keeps "Interrupted" (`ABANDONED`), a failed import
and a landing container keep their words, and every held session keeps its word exactly. No runner or app release is
needed.

**Work.** 17 tasks (§8.2): 2 S, 8 M, 7 L.

## 1. What the stored word means today, and what replaces each meaning

### 1.1 The meanings

| # | Meaning | Spelled today | Replaced by |
|---|---|---|---|
| M1 | Held (a runner holds it, or a message waits for one) or released | the four held words against SUCCEEDED, FAILED, CANCELLED (`common/session-release.ts:21-33`); CHECK `session_release_fact_chk` makes a word terminal exactly when `finished_at` is set (catalog; migration 1401) | `finished_at` alone. Most readers already ask it (`isReleased` / `isHeld`, `common/session-release.ts:56-63`); the execution claim index already keys on it (`session_task_execution_claim_idx_finished_at`, catalog; migration 1426) |
| M2 | A turn waits for a claim | PENDING: the claim takes `s.status = 'PENDING'` (`queue/queue.service.ts:532`) | `turn_state = 'QUEUED'` |
| M3 | **A dispatched turn holds a runner slot** | RUNNING: "the one fact that holds a runner slot" (`common/session-working.ts:63-73`), `ACTIVE_TURN_STATUSES` (`common/session-scheduling.ts:10`), the slot counts (`common/session-tree-sql.ts:35, 72, 104`, `queue/queue.service.ts:763`) | `turn_state = 'IN_FLIGHT'`, the explicit runner-slot fact |
| M4 | Parked: held, no turn queued or running | AWAITING_INPUT | `finished_at IS NULL AND turn_state IS NULL` |
| M5 | The runner was stopped under the turn | INTERRUPTED; its only writer is the repeated out-of-memory stop (`managed-runners/managed-runner-manager.ts:2254-2267`) | `turn_state = 'ABANDONED'` |
| M6 | How the release went | SUCCEEDED, FAILED, CANCELLED | no stored word. The server's questions already read facts: released by a failure (`releaseWasFailure`, `common/session-release.ts:177-182`), the work finished (`releaseFinishedTheWork`, 206-211); the rest is `end_reason`, the landing's `settled_as`, the import marker. The legacy word is derived (§3.1) |
| M7 | Activity | `phase`, derived from the word and the execution facts (`sessions/session-phase.ts:65-69`) | `phase`, stored (§1.2) |

`last_turn_outcome` (`ANSWERED`, `FAILED`, `INTERRUPTED`, `CANCELLED`; CHECK `session_last_turn_outcome_chk`, catalog)
and `end_reason` (`prisma/schema.prisma:2306-2311`) stay as they are: no meaning of the word moves into them.

### 1.2 `phase` is stored, and kept by the database rather than by the writers

Decision: `session.phase` becomes a column, written by one BEFORE INSERT OR UPDATE trigger (`session_zz_phase`, named to
fire after every other BEFORE trigger) from five columns of the same row:

```sql
CASE WHEN finished_at IS NOT NULL THEN 'IDLE'
     WHEN turn_state = 'IN_FLIGHT' THEN 'RUNNING'
     WHEN engine_turn_active OR cardinality(running_subagents) > 0 OR cardinality(running_bg_jobs) > 0 THEN 'RUNNING'
     WHEN turn_state = 'QUEUED' THEN 'PENDING'
     ELSE 'IDLE' END
```

This is today's rule: released reads IDLE (`sessions/session-phase.ts:66`); executing is a dispatched turn or, on a held
session, the engine's own turn, a sub-agent or a background job (`common/session-working.ts:147-149`) and reads RUNNING
(`session-phase.ts:67`); a queued turn with nothing executing reads PENDING (68). It reads nothing outside the row.

Why stored, and why by a trigger:

- The owner's ruling names `session.phase` as what is read and written. Stored, it is literally that, and a list
  filter or a count can index it.
- Its inputs are written by different writers: `turn_state` by the claim and turn-complete, `finished_at` by every
  release, `engine_turn_active`, `running_subagents` and `running_bg_jobs` by event ingestion and the runner's reports
  (`prisma/schema.prisma:2377-2424`). A column each of them had to recompute is one forgotten write away from a wrong
  state; a trigger cannot forget it, and a TS write of it is overwritten.
- `deriveSessionPhase` stays in TypeScript as the reference that a PG spec holds the trigger to, over every row shape
  (`common/session-release-shapes.fixture.ts`) and every combination of the execution facts, and for rows that do not
  come from the database (fixtures).

`phase` never decides a slot, a claim or dispatch: it is RUNNING for a parked session's sub-agent or background job
(`common/session-working.ts:19-21, 141-149`), which holds no slot (a self-driven turn "acquired no permit",
`common/session-generating.ts:12-13`). Those rules read `turn_state` (§1.4), and the guard (§5) keeps `phase` out of
them.

`waitingOn` stays derived: it reads approvals, watches, wake-ups and the dispatch pause, which live in other tables
(`sessions/session-phase.ts:100-110, 166-198`).

### 1.3 `turn_state`: the explicit fact for runner slots and claims

Decision: one nullable text column with a CHECK, values `QUEUED`, `IN_FLIGHT`, `ABANDONED`.

- **Why the slot needs it.** `phase` RUNNING covers work that holds no slot (above), so the slot counts cannot read it;
  `IN_FLIGHT` is exactly today's RUNNING, which every slot rule reads (§1.4).
- **Why the claim needs it.** A turn queued while a background job runs is phase RUNNING with the word PENDING
  (`sessions/session-phase.ts:67-68`), and the claim must still take it. `QUEUED` is exactly today's PENDING.
- **Why ABANDONED.** About a dozen server rules tell the out-of-memory stop (INTERRUPTED) from a person's Stop
  (AWAITING_INPUT with outcome INTERRUPTED; the two differ only in `error`, note §2): the task carrier leaves it out
  (`sessions/task-work-carrier.ts:96-97`), "the run is over" counts it with an end reason (`common/session-release.ts:252-255`
  and three trigger WHEN clauses, §4.2), and the idle and stopped producers, open-item escalation, schedule runs and the
  help model read it (rows in §2). Folding it into "parked" would change those rules for those rows, which the owner's
  card did not put to them. With the value they keep their behaviour, and the row keeps its word (§3.5).
- **Why one column.** The three are exclusive by construction; the claim stays one compare-and-set on one column
  (QUEUED to IN_FLIGHT, as PENDING to RUNNING today); the five engine guards keep testing one transition.
- **Why text and a CHECK, not a Prisma enum.** As `last_turn_outcome` and `kind` are (catalog: `session_last_turn_outcome_chk`,
  `session_kind_check`): no `ALTER TYPE`, and an older replica's Prisma client never meets a label it cannot decode,
  the trap of note §4.3 step 1.

### 1.4 Slot, claim, dispatch, reclaim and takeover keep exactly today's behaviour

The rewrite renames conditions; it does not restate rules. From deploy 2 until deploy 4 a CHECK
(`session_turn_state_agrees_chk`, §4.1) holds `status = 'PENDING'` and `turn_state = 'QUEUED'` to the same rows, and
likewise RUNNING with IN_FLIGHT and INTERRUPTED with ABANDONED, beside `session_release_fact_chk` for the released words.
So every reader below selects the same rows before and after its rewrite, in whichever deploy from D2 on it ships. Where today's
predicate leans on the CHECK for "held" (a word list with no `finished_at` beside it), the rewrite states
`finished_at IS NULL` explicitly.

| Rule | Today | After |
|---|---|---|
| Runner slots (`max_concurrent`) | `active.status = 'RUNNING'` per runner (`common/session-tree-sql.ts:68-74`), the claim gate (`queue/queue.service.ts:700-704`) | `active.turn_state = 'IN_FLIGHT'` |
| Batch cap | `ba.status = 'RUNNING'` (`common/session-tree-sql.ts:99-106`; gate `queue/queue.service.ts:707-710`) | `ba.turn_state = 'IN_FLIGHT'` |
| Spawn-tree cap and its supervisor exemption | tree rows RUNNING, a child PENDING or RUNNING exempts its parent (`common/session-tree-sql.ts:30-42`) | IN_FLIGHT; a child `turn_state IN ('QUEUED', 'IN_FLIGHT')` |
| Claim order | RUNNING rows per tree first-come (`queue/queue.service.ts:760-765`) | IN_FLIGHT |
| Run now's overflow | turns plus held non-RUNNING sessions the runner's beat names (`common/session-tree-sql.ts:86-96`, `queue/queue.service.ts:724-733`) | IN_FLIGHT plus `finished_at IS NULL AND turn_state IS DISTINCT FROM 'IN_FLIGHT'` |
| The claim | `UPDATE … SET status = 'RUNNING' WHERE id = (SELECT … WHERE s.status = 'PENDING' … FOR UPDATE NOWAIT LIMIT 1)` (`queue/queue.service.ts:489-533`) | `SET turn_state = 'IN_FLIGHT'`, `WHERE s.turn_state = 'QUEUED'` |
| Claim replay, overflow probe | `status = 'RUNNING'` (477), `status = 'PENDING'` (780) | IN_FLIGHT, QUEUED |
| Claim undone (credential refused) | RUNNING to PENDING (`queue/queue.service.ts:812-818`) | IN_FLIGHT to QUEUED |
| Engine claim guards (5 triggers) | `OLD.status = 'PENDING' AND NEW.status = 'RUNNING'` (catalog) | `OLD.turn_state = 'QUEUED' AND NEW.turn_state = 'IN_FLIGHT'` |
| Slot kept or freed at turn end | `statusAfterTurnCompleted` RUNNING when a turn is queued, else AWAITING_INPUT (`common/session-scheduling.ts:108-111`; `ctl:8313-8337`), on `status = RUNNING` (`ctl:8396-8401`) | IN_FLIGHT kept, or null; on `turn_state = 'IN_FLIGHT'` |
| A failed turn held under release v1 | stays RUNNING until its release (`ctl:8322-8325`) | stays IN_FLIGHT |
| Runner offline is fatal | only for RUNNING (`common/session-scheduling.ts:113-116`; reaper `realtime/reaper.service.ts:618`) | only for IN_FLIGHT |
| Dispatch (enqueue on a parked session) | AWAITING_INPUT or INTERRUPTED to PENDING (`common/session-scheduling.ts:101-106`; callers `sessions/sessions.service.ts:8140, 8416, 8748`) | null or ABANDONED to QUEUED |
| Reclaim set and answer | `status IN OPEN` (`ctl:4603`), answered `s.status` (`ctl:4900`) | `finished_at IS NULL`; answered the projected word (§3.2) |
| Takeover answers | the word read `FOR UPDATE` (`ctl:5117, 5207, 5365, 5407`); a released row refused 409 (`ctl:5112-5114`) | the projected word of the same locked row; refusal unchanged |
| Heartbeat ownership fence | `status IN OPEN` (`ctl:2735`) | `finished_at IS NULL` |
| Task execution claim | unique index on `finished_at` (migration 1426) | unchanged |
| Task occupancy (`TASK_OCCUPYING`) | the four held words (`tasks/reclaim-stalled-task.ts:16, 48`, and 9 more readers, §2) | `finished_at IS NULL` |
| Task carrier | `finished_at IS NULL AND status IN (PENDING, RUNNING, AWAITING_INPUT) AND (status <> AWAITING_INPUT OR a wake source)` (`sessions/task-work-carrier.ts:92-98`) | `finished_at IS NULL AND turn_state IS DISTINCT FROM 'ABANDONED' AND (turn_state IN ('QUEUED','IN_FLIGHT') OR a wake source)` |

Runners keep receiving the same words (§3.2), so their own permit, reclaim and takeover logic is untouched.

### 1.5 Invariants at the end

| CHECK | Holds | Replaces |
|---|---|---|
| `session_turn_state_chk` | `turn_state IS NULL OR turn_state IN ('QUEUED', 'IN_FLIGHT', 'ABANDONED')` | the enum's labels |
| `session_turn_state_released_chk` | `finished_at IS NULL OR turn_state IS NULL`: a released session holds no turn, slot or claim | `session_release_fact_chk` |
| `session_phase_chk`, and `phase` NOT NULL | `phase IN ('PENDING', 'RUNNING', 'IDLE')` | — |

During the transition only, `session_turn_state_agrees_chk` (D2 to D4) ties the two spellings together (§4.1).

## 2. Every reader and writer, mapped

Sources: the rows of note §7, each re-read at its lines (112 of the 131 rows of §7.1 and §7.2 hold as written; the
other 19 are given below with corrected lines), a sweep of all 1,043 product files of `src/apiserver/src` and
`src/shared/src` for uses the note does not list (§2.5), and an inventory of every statement that writes the column
(§2.2). How each was made is in §9.

### 2.1 The translations

A row below names one of these instead of spelling its predicate out. Each is exact under the transition CHECKs
(§1.4); where today's predicate leaves "held" to the CHECK, the translation states `finished_at IS NULL` (risk R1).

| Code | Today | After |
|---|---|---|
| **H** | a held set: the four held words, `OPEN_SESSION_STATUSES`, `TASK_OCCUPYING`, `SWEPT`, `heldStatusFilter()`, `HELD_SESSION_STATUSES` | `finished_at IS NULL` (`heldFilter()`, `sessionHeldSql`) |
| **L** | `LIVE` (held without PENDING), `isHeldPastClaim` | `finished_at IS NULL AND turn_state IS DISTINCT FROM 'QUEUED'` |
| **X** | the released set, `notIn` a held set, `isReleasedStatus` | `finished_at IS NOT NULL` |
| **Q** | PENDING | `turn_state = 'QUEUED'` |
| **F** | RUNNING, `ACTIVE_TURN_STATUSES`, `DISPATCHED_TURN`, `sessionHoldsSlot`, `runnerOfflineIsFatal` | `turn_state = 'IN_FLIGHT'` |
| **U** | PENDING or RUNNING (`UNSETTLED_SESSION_STATUSES`) | `turn_state IN ('QUEUED', 'IN_FLIGHT')`; "settled" is its null-safe negation |
| **A** | AWAITING_INPUT | `finished_at IS NULL AND turn_state IS NULL` |
| **I** | INTERRUPTED | `turn_state = 'ABANDONED'` |
| **AI** | AWAITING_INPUT or INTERRUPTED (held and idle) | `finished_at IS NULL AND (turn_state IS NULL OR turn_state = 'ABANDONED')` |
| **QAI** | held and not RUNNING | `finished_at IS NULL AND turn_state IS DISTINCT FROM 'IN_FLIGHT'` |
| **W** | a released word read for what it says about the release | the release question it answers for that reader: `releaseWasFailure`, `releaseFinishedTheWork`, the source refusal, the landing |
| **G** | through a common helper: the generating, executing, carrier, eligibility helpers | the helper's own rewrite; the call site does not change |
| **E** | through `sessionHasEnded`, `runIsOver`, `conversationIsOver/Down/Paused` | the helper's own rewrite (`runIsOver`: released, or ABANDONED with an end reason); the call site does not change |
| **P** | the stored word put on a payload, an event, a text or a stored record | the projected word, `legacySessionStatus` (§3.1) |
| **V** | the word a runner reports (turn-complete, finalize) | unchanged: protocol, not the column |

### 2.2 The writers

Every statement that writes `session.status` today: 24 Prisma calls and one raw `UPDATE` (the claim); no database
function or trigger assigns it. Paths under `src/apiserver/src/`; the line is the `status` assignment.

| # | file:line | Path | Guard on the old word | Writes today | D2 (writes both) | D3 (facts only) | Task |
|---|---|---|---|---|---|---|---|
| 1 | managed-runners/managed-runner-manager.ts:2259 | the out-of-memory stop | RUNNING | INTERRUPTED, outcome INTERRUPTED | + `turn_state = 'ABANDONED'` | guard F; ABANDONED | T7 |
| 2 | projects/landing-session.ts:280 | landing container opened (insert) | — | AWAITING_INPUT, or SUCCEEDED / CANCELLED with `finished_at` if settled | + `turn_state` null | `turn_state` null; `finished_at` as today | T11 |
| 3 | projects/landing-session.ts:396 | landing settled | — (locks the landing row) | SUCCEEDED / CANCELLED with `finished_at` | + `turn_state` null | `finished_at` alone (the word is P3) | T11 |
| 4 | projects/session-source.ts:706 | the runner refused the source | held set | FAILED, `finished_at`, outcome FAILED | + `turn_state` null | guard H; release facts as today | T11 |
| 5 | queue/queue.service.ts:493 | the claim | `s.status = 'PENDING'` (532) | RUNNING | + `turn_state = 'IN_FLIGHT'` | guard Q; IN_FLIGHT | T7 |
| 6 | queue/queue.service.ts:815 | claim undone | RUNNING (813) | PENDING | + QUEUED | guard F; QUEUED | T7 |
| 7 | realtime/reaper.service.ts:1086 | `forceFinalize`, from the sweep at 557 (an end not honoured), 643 (runner offline), 734 (never initialized), 764 (API-error backstop) | `status IN expectedStatuses` (1077): the row's own word, RUNNING, or AWAITING_INPUT | the released word (FAILED by default; `gracefulEndStatus` at 545) with `finished_at` | + `turn_state` null | guard on the remembered `turn_state` (F, A, or the row's own); release facts | T9 |
| 8 | runner-api/runner-api.controller.ts:6155 | inbox fetch: account paused or a removed Default | RUNNING (in code, row locked) | PENDING | + QUEUED | F; QUEUED | T8 |
| 9 | ctl:6200 | inbox fetch under the dispatch pause | RUNNING | PENDING | + QUEUED | F; QUEUED | T8 |
| 10 | ctl:7688 | a steer re-filed as a message | AWAITING_INPUT | PENDING | + QUEUED | A; QUEUED | T8 |
| 11 | ctl:7767 | Claude region refused | RUNNING | PENDING | + QUEUED | F; QUEUED | T8 |
| 12 | ctl:8403 | turn complete: park, keep the slot, or a failed turn | RUNNING (8400) | `nextStatus` (8333-8337): RUNNING, AWAITING_INPUT, PENDING, or FAILED with `finished_at` | + the matching `turn_state` (IN_FLIGHT, null, QUEUED, null) | F; the turn state | T8 |
| 13 | ctl:10569 | finalize and release | `status IN LIVE` (10567) | `effectiveStatus` (10438-10444) with `finished_at` | + `turn_state` null | L; release facts; `effectiveStatus` still computed for what else it decides (§3.2) | T8 |
| 14 | ctl:10931 | finalize of a region-gated run | `status IN LIVE` (10929) | AWAITING_INPUT or PENDING | + null or QUEUED | L; the turn state | T8 |
| 15 | ctl:11029 | import ok | RUNNING and the import marker (11023) | PENDING or AWAITING_INPUT | + QUEUED or null | F; the turn state | T8 |
| 16 | ctl:11048 | import failed | — (by id) | FAILED, `finished_at`, into Trash | + `turn_state` null | release facts; the marker stays (P2) | T8 |
| 17 | session-guests/session-guests.service.ts:282 | a guest's queued turns withdrawn | PENDING (in code) | AWAITING_INPUT | + null | Q; null | T10 |
| 18 | sessions/sessions.service.ts:1879 | create (every new session) | — | PENDING | + QUEUED | QUEUED | T10 |
| 19 | sessions/sessions.service.ts:2439 | transcript import creates the row | — | PENDING | + QUEUED | QUEUED | T10 |
| 20 | sessions/sessions.service.ts:8144 | enqueue a turn | in code: held, no cancel | `statusAfterTurnEnqueued` | + its turn state | the turn state | T10 |
| 21 | sessions/sessions.service.ts:8418 | a held (translation) message released | in code | AWAITING_INPUT or INTERRUPTED to PENDING | + QUEUED | QUEUED | T10 |
| 22 | sessions/sessions.service.ts:8752 | interrupt with a follow-up | held past claim | as #20 | + its turn state | the turn state | T10 |
| 23 | sessions/sessions.service.ts:9281 | the last queued message withdrawn | PENDING (in code) | AWAITING_INPUT | + null | Q; null | T10 |
| 24 | sessions/sessions.service.ts:10657 | end of a queued session | PENDING (in code) | CANCELLED, `finished_at`, end reason | + null | Q; release facts | T10 |
| 25 | sessions/sessions.service.ts:11884 | revive a released session | `finished_at` set | PENDING, `finished_at` cleared | + QUEUED | QUEUED | T10 |

Only #16 can write over a row that is already released (its WHERE is the id); every other writer guards on a held word
or on `finished_at`. That matters once: `session_listed_at_on_settle` moves `listed_at` today when #16 turns a released
word into FAILED, and on `finished_at` it would not (§4.2). The census counts such rows.

Three writers set the word to the value it already has: #12 (RUNNING kept for a queued follow-up or the release-v1
hold), #20 and #22 (PENDING or RUNNING kept). Every trigger `UPDATE OF status` fires on those statements today, because
it fires on the columns a statement names, not on a changed value. So the D2 and D3 writers name `turn_state` in the
same statements, unchanged value included, and the triggers fire where they fire now. (Their functions are idempotent
on such a rewrite anyway: the guards and the two serializers compare OLD with NEW, and the AFTER triggers close only
what is still open.)

Two helpers return the word a writer stores, and become helpers that return a turn state:
`statusAfterTurnEnqueued` and `statusAfterTurnCompleted` (`common/session-scheduling.ts:101-111`, used by #12, #20,
#21, #22). `gracefulEndStatus` (`src/shared/src/enums.ts:238-248`) stays, read by the finalize's `effectiveStatus`
and the projector (P4). One database trigger copies the word elsewhere: `session_request_recipient_ended` into
`session_request.close_reason` (§4.2).

### 2.3 Readers and payloads: apiserver outside projects/, tasks/, task-lists/ (note §7.1)

| File | Lines | What it decides | After | Task |
|---|---|---|---|---|
| common/session-release.ts | 21-47, 66-67, 94-106, 163-169, 248-255 | the held and released sets; `isHeldPastClaim`; `sessionHeldIndexedSql`; `runIsOver`; `RELEASE_FAILURE_SELECT` carries the word | H, X, L, E; the sets and `sessionHeldIndexedSql` are deleted when unread; the select drops `status` | T7 |
| common/session-scheduling.ts | 10-13, 28, 101-116 | slot, open and unsettled sets; the two transition helpers; runner offline | F, H, U; the helpers return a turn state | T7 |
| common/session-generating.ts | 21-34 | generating: RUNNING, or AWAITING_INPUT with the engine's own turn | F, or A with `engine_turn_active` | T7 |
| common/session-working.ts | 36, 63-73, 139, 147-172, 209-216 | `DISPATCHED_TURN`, the slot fact; the open set gates the outside-turn facts | F; H | T7 |
| common/session-tree-sql.ts | 35, 39, 72, 90, 104 | slot counts; the supervisor exemption; background holders (no `finished_at`) | F; U; QAI | T7 |
| common/runner-drain-waiting.ts | 21-23, 31 | queued counts; held helper | Q; H | T7 |
| common/session-inbox-fence.ts | 131 | `sessionReleasedSql` only | unchanged | — |
| help/help-ask-marker.ts | 54-58 | PENDING or RUNNING = working; generating | U; G | T12 |
| help/help-ask.ts | 174, 195 | selects the word for `helpAskOutcome` (51 is the runner's status) | the facts | T12 |
| help/help-ask-reads.ts | 147, 157-158 | the word to the help model; "paused" = INTERRUPTED | P; I | T12 |
| link-previews/link-previews.service.ts | 155-158, 271-304 | the four fields on a session card; a task's last run (SQL 280) (330 is a project's status) | P | T12 |
| managed-runners/managed-runner-manager.ts | 2256-2266 | the out-of-memory stop (writer #1) | §2.2 | T7 |
| managed-runners/managed-runner.service.ts | 455, 460 | turns Update Now would stop; held shells | F; H | T7 |
| managed-runners/managed-runner-work.ts | 61-62, 68, 74 | an active turn, a queued turn, background work, a due retry | F; Q; G; G | T7 |
| metrics/fleet-metrics.ts | 85-93 | fleet counts | Q; F | T7 |
| providers/active-sessions.ts | 43, 46 | the claim's account pick: PENDING or RUNNING; recent AWAITING_INPUT or INTERRUPTED with no `finished_at` | U; AI | T12 |
| providers/account-move-capability.ts | 63, 66 | the word into `isSessionGenerating` | G | T12 |
| providers/account-health.service.ts | 450, 465 | a trial session RUNNING | F | T12 |
| providers/providers.service.ts, providers/shared-pools.service.ts | 1402; 625 | `GENERATING_SESSION_FILTER` | G | — |
| push/push.service.ts | 148-175, 349, 357, 1739-1800 | cards outside a dispatched turn (AWAITING_INPUT with the engine's own turn); RUNNING needs-you; generating | A with `engine_turn_active`; F; G | T12 |
| push/settle-alert.ts | 74 | release facts only | unchanged | — |
| queue/queue.service.ts | 245, 388, 477, 493, 532, 703-733, 763, 780, 813-815, 1251 | the claim and its caps, replay, hold notices, refusal, the overflow probe and pass | §1.4; writers #5 and #6 | T7 |
| queue/dispatch-pause.service.ts | 40, 112, 123 | turns a cut-over waits for; runners to hint; inboxes to wake | H; Q; H | T7 |
| realtime/realtime.service.ts | 253-282, 1256-1269 | `endedSessionStates`; the `session.ended` payload | P | T9 |
| realtime/realtime.service.ts | 1720-1750 | legacy words re-derived from a control event | P | T9 |
| realtime/realtime.service.ts | 1834, 1894-1923 | the session summary payload | P | T9 |
| realtime/realtime.service.ts | 1781-1783 | approval events: the word into `countLiveApprovals` | G | T9 |
| realtime/realtime.service.ts | 2129-2130, 2161-2163, 2256, 2271, 2300-2314 | merge and commit claims: the open set, `notIn` it, AWAITING_INPUT | H; X; A | T9 |
| realtime/reaper.service.ts | 208-215, 471-476, 545-578, 613-644, 687, 715-778, 1024-1086, 1160-1164, 1225-1229 | the `LIVE` and `SWEPT` sets; the sweep (no `finished_at`); graceful words; runner offline; never initialized; the backstop; `forceFinalize` (writer #7); the STATUS event | L; H; writer #7; F; G; A; P | T9 |
| realtime/parked-session-end.ts | 41, 105-107, 138 | AWAITING_INPUT guards an end's claim; the word into `session.ended` | A; P | T9 |
| realtime/lost-runner-work.ts | 70, 106, 117-121, 187 | the open set (no `finished_at`); slot and executing helpers; an ended session refuses a wake | H; F; G; E | T9 |
| runner-api/runner-api.controller.ts (writes) | 6152-6203, 7686-7689, 7764-7779, 8332-8337, 8396-8403, 10438-10444, 10566-10569, 10927-10931, 11022-11054 | every runner-driven transition | writers #8-#16 | T8 |
| ctl (reads) | 1143-1178, 1575, 2735, 2766, 4603, 7198, 7494, 7610, 7710-7732, 7800-8175, 8262, 8460, 8536-8547, 8657, 8688, 8700, 8753, 8806, 8886, 8973, 10413, 10454, 10460-10473, 10645, 10721-10797, 11101-11119, 11608, 11622, 12335, 12364, 12383 | `LIVE`, `TERMINAL` and `OPEN` (no `finished_at` at 2735, 2766, 4603, 12335, 12364, 12383); the runner's words; AWAITING_INPUT gates; `effectiveStatus` task effects; `restsResumableOn` | L, H, X, A, U; V for the runner's words | T8 |
| ctl (wire) | 4900, 5117, 5207, 5240, 5365, 5407, 5468, 7577-7745, 8029, 8515, 8734, 8934, 8966, 8980, 8949-8964, 10876-10887; text 10671, 10678, 10707 | the words answered to runners (reclaim, takeover, turn-complete reply); STATUS events; the released word in notices | P (§3.2) | T8 |
| ctl (PENDING or RUNNING only) | 4465, 4482, 4667, 4746, 4783, 6092, 6276, 6296, 6424 | upgrade notices; reclaim notices; steer and message delivery need RUNNING | Q; F | T8 |
| runner-api/turn-outcome.ts | 48-62 | the runner's word to the turn outcome | V | — |
| runner-api/runner-link-hints.ts | 94, 104, 113-120 | RUNNING, AWAITING_INPUT or INTERRUPTED (no `finished_at`); AWAITING_INPUT with the engine's turn | L; A with `engine_turn_active` | T8 |
| runner-api/link-heartbeat.ts, runner-api/runner-link-welcome.ts | 535, 831; 109 | `sessionHeldSql` only | unchanged | — |
| runner-api/background-job-stops.ts | 16 | the open set | H | T8 |
| runner-api/runner-orchestration-authorizer.ts | 143 | the open set | H | T8 |
| runner-api/runner-sessions.controller.ts | 300-321 | `?status=` | §6 | T10 |
| runner-api/runner-subagents.controller.ts | 304-308 (129 selects it unread) | `sessionHasEnded` | E; 129 drops `status` | T8 |
| runner-api/scheduled-wakeup.ts | 321-331 | release facts, `sessionHasEnded` | E | — |
| runner-api/scheduled-wakeup.worker.ts | 117, 285, 422, 478, 528 | RUNNING; `sessionHasEnded` | F; E | T8 |
| runner-api/subagent-wake.ts, background-job-wake.ts, subagent-remote.ts | 196; 179; 672 | `sessionHasEnded`, `sessionReleasedSql` | E | — |
| runners/runners.service.ts | 363 | RUNNING turns of draining runners | F | T7 |
| runners/runners.service.ts | 636, 1720 | the word on the checkout and account-removal lists | P | T7 |
| runners/claude-account-swap.ts | 278, 301 | skips PENDING | Q | T7 |
| runners/claude-account-swap.ts | 368 | the word in the swap's `waitingOn` | P | T7 |
| runners/attention-fix.ts | 276 | a released session's word as `handled[].status` | P | T7 |
| runners/runner-background-holders.ts | 79 | the slot set | F | T7 |
| runners/runner-executing-sets.ts | 171 | `sessionHeldSql` only | unchanged | — |
| schedules/schedule-runs.service.ts | 745, 787, 794, 933, 1765 | PENDING or RUNNING; INTERRUPTED = a failed landing; AWAITING_INPUT to land | U; I; A | T12 |
| schedules/schedule-runs.service.ts | 227, 676, 693 | release facts; the capacity helper | unchanged | — |
| session-guests/session-guests.service.ts | 261, 277, 282 | PENDING with nothing executable (writer #17) | Q; §2.2 | T10 |
| session-guests/session-guests.service.ts | 322, 333-339 | the shared-with-me row | P | T10 |
| sessions/session-state.ts | 21, 103-127 | `withSessionState`, the central projector | P: the derived word | T4 |
| sessions/session-phase.ts | 67-83, 109, 173 | phase from the word; PENDING | read the stored `phase`; Q | T10 |
| sessions/sessions.service.ts (writes) | 1879, 2439, 8140-8144, 8416-8418, 8748-8752, 9278-9281, 10657, 11884 | writers #18-#25 | §2.2 | T10 |
| sessions/sessions.service.ts (wire) | 2064, 2477, 3012-3015, 3331-3334, 3396, 3523, 4002-4005, 4740, 5249-5251, 5700, 5722, 5780-5785, 5840-5862, 6090-6103, 10556, 10619, 10719, 11274, 11323, 12087, 12157, 13110, 13134 | create, list, detail, search, landing-only detail, `sessionStatus` in errors, `session.ended`, the open-list token | P | T10 |
| sessions/sessions.service.ts (idle and released reads) | 3362, 6011, 7145, 7666, 9819, 10227, 10258-10260, 10290 | the list filter; the AWAITING_INPUT retry arm; account move; merge deferral; commit gate; `notIn LIVE` | §6; A; L; X | T10 |
| sessions/sessions.service.ts (PENDING or RUNNING only) | 2873-2879, 4065, 4647, 4746, 4999, 5202-5216, 5839, 5884-5895, 8194-8195, 8423-8427, 8705, 8767, 9045, 9271, 10651, 12543, 13500 | counts, turn timing, over-limit, queued or running | Q; F; U | T10 |
| sessions/sessions.service.ts (helpers) | 4072, 4095, 5393, 7106, 7177, 7184, 8628, 10211, 10817, 11474, 11522, 12052, 12790, 12899, 13485 | executing, generating, `isHeldPastClaim` | G; L | — |
| sessions/auto-retry.service.ts | 243, 326, 422, 1156, 1951 | AWAITING_INPUT (or released by a failure) = parked | A; G | T10 |
| sessions/auto-retry.service.ts | 342, 391-989, 441, 1152, 1633-1843, 1891, 1955-1962, 1987 | remembers the parked word (`parkedAs`, AWAITING_INPUT or FAILED) and compares it under lock | remember and compare (`finished_at` set or not, `turn_state`) | T10 |
| sessions/auto-retry.service.ts | 2009-2014 | the STATUS event with a released failure's word | P | T10 |
| sessions/auto-retry-eligibility.ts | 70, 82 | AWAITING_INPUT or released by a failure (Prisma and SQL) | A | T10 |
| sessions/session-request.ts | 1051 | AWAITING_INPUT and no cancel = parked | A | T10 |
| sessions/session-request.ts | 1120-1128 | `deriveSessionState`'s word stored as `close_reason` | P | T10 |
| sessions/session-move.ts | 128, 133, 150 | PENDING; AWAITING_INPUT with a retry armed | Q; A | T10 |
| sessions/task-work-carrier.ts | 92-98, 117, 128-134, 172-184, 223, 260 | the carrier; `sessionActivitySql` (PENDING or RUNNING = TURN; not AWAITING_INPUT = none) | §1.4 carrier; activity: U = TURN, not A = none | T10 |
| sessions/abandoned-approvals.ts | 432-443 | the generating helper | G | — |
| sessions/queued-gate.ts, queued-reason-sql.ts, run-now.ts | 70; 81, 129; 61-91 | PENDING only | Q | T10 |
| sessions/sessions.controller.ts | 373-382 | `?status=` | §6 | T10 |
| share-links/public-task.ts | 140, 231-235 | a public run's `state` = its runState | P | T12 |
| share-links/share-links.service.ts | 710-714 | the shared header's `status` | P | T12 |
| watches/watch-predicate.ts | 166, 178, 196, 322-342, 486-505 | the leaves; executing; wake armed; the observation | §6; G; E; P | T12 |
| watches/watch-redaction.ts | 70-88 | observed `status` and `runState` passed to the agent | P | T12 |
| watches/watch-evaluator.service.ts | 725, 892-914 | `status::text` into the facts; snapshots | the facts; P | T12 |
| watches/watches.service.ts | 451, 463, 475-485, 738-800, 797, 987-1001 | carrier helper; the target's run state; facts at creation | G; P; the facts | T12 |
| watches/watch-delivery.service.ts | 196-204, 771-794 | `sessionHasEnded`; the run-state word in a refusal sentence | E; P | T12 |
| wiki/wiki-maintenance.ts | 257, 335 | not PENDING or RUNNING | not U | T12 |
| wiki/wiki-dossier.ts | 272, 1939 | `status <word>` in the dossier header | P | T12 |
| wiki/wiki-chat.ts | 49, 176, 233, 275 | PENDING; generating; the word on `WikiChatRow` | Q; G; P | T12 |
| wiki/wiki.service.ts, workspaces/main-checkout.service.ts, owner-requests/owner-secrets.service.ts | 5326; 519; — | the generating filter, `isHeldPastClaim` | G | — |

### 2.4 Readers and payloads: projects/, tasks/, task-lists/ and shared (note §7.2)

`P/` = `projects/`, `T/` = `tasks/`, `L/` = `task-lists/`, `S/` = `src/shared/src/`.

| File | Lines | What it decides | After | Task |
|---|---|---|---|---|
| P/landing-session.ts | 69-74, 269, 280, 396 | the container's word (writers #2, #3) | §2.2; the word is P3 | T11 |
| P/session-source.ts | 704, 706 | held-set guard; FAILED on refusal (writer #4) | H; §2.2 | T11 |
| P/attempt-ended-unsettled.producer.ts | 67, 88, 141, 154, 187, 257, 290, 390, 462-464 | the word into a wake fact, a signal and a comment ("terminal state X"); decisions already on `finishedAt` | P | T11 |
| P/task-exception-input.producer.ts | 41, 102, 105, 126 | `status::text` into the wake detail `sessionStatus` | P | T11 |
| P/coordinator-wake.ts | 363, 375 | `sessionStatus` passed through | P | T11 |
| P/coordinator-evidence-queue.service.ts | 76, 105, 110 | an idle coordinator = AWAITING_INPUT or INTERRUPTED (no `finished_at`); over or paused | AI; E | T11 |
| P/pending-addressees.ts | 168, 179-180, 323-325, 359 | the coordinator busy unless idle; paused; ended | AI; E | T11 |
| P/task-run-idle.ts | 57, 71, 94, 106 | an idle task run = AWAITING_INPUT (INTERRUPTED excluded; no `finished_at`) | A | T11 |
| P/task-run-stopped.producer.ts | 118, 129, 145, 152 | the stopped fact only for AWAITING_INPUT runs | A | T11 |
| P/open-item-escalation.service.ts | 226, 256 | `status <> 'INTERRUPTED' OR end_reason IS NULL` | `turn_state IS DISTINCT FROM 'ABANDONED' OR end_reason IS NULL` | T11 |
| P/projects.service.ts | 526, 724-725, 868, 907-908, 3926-3934, 6287, 6409-6414 | AWAITING_INPUT with sub-agents = working; the coordinator's words; overlays | A with sub-agents; P; G | T11 |
| P/criterion-move.ts | 70, 90, 275-276, 335 | live runs = the held set (no `finished_at`) block a criterion move | H | T11 |
| P/live-session-status.ts | 12-15 | a held-set helper nothing imports | deleted | T11 |
| P/project-open-item.ts | 800-812, 828, 875-882, 1151, 1509, 1742, 1872, 2382 | `SESSION_ENDING_SELECT`; `sessionHasEnded`; `conversationIsOver/Down` | E; the select drops `status` | T11 |
| P/project-ready-to-run.ts | 222-236, 337 | PENDING reads QUEUED, else RUNNING; RUNNING sorts first | Q; F | T11 |
| P/project-done-request.ts | 227, 237, 240 | PENDING or RUNNING runs | Q; F | T11 |
| P/coordinator-fact-queue.service.ts | 47-50, 56, 60 | held and not PENDING or RUNNING = idle; over or paused | AI; E | T11 |
| P/project-tasks-settled.producer.ts | 168, 220, 223 | the same | AI; E | T11 |
| T/tasks.service.ts (retired-word reads) | 3912, 3927-3934, 15217, 15257-15258, 15276-15277, 15595-15601, 15661 | a paused run to resume (`IN (AWAITING_INPUT, INTERRUPTED)`, no `finished_at`); `LIVE`; an error text naming words | AI; L; the text is unchanged | T11 |
| T/tasks.service.ts (held sets) | 13919, 14087, 15316, 17316 | `TASK_OCCUPYING` and `heldStatusFilter()`: reach check, delete, mention delivery, batch stop | H | T11 |
| T/tasks.service.ts (replacement) | 12052 | the word for `replacementOf` | W | T11 |
| T/tasks.service.ts (wire) | 865, 1517, 9726, 9747, 9813-9817, 9943, 12028, 13485, 14282, 14324, 14336, 14843, 14896-14900, 15295 | task detail runs; `autoRunSkipped.sessionStatus`; the 409 holder; logs | P | T11 |
| T/tasks.service.ts (PENDING or RUNNING) | 8351, 8460, 8465-8466, 8606, 12534, 12540, 15258, 15277 | relation filters; the slot budget | Q; F; U | T11 |
| T/tasks.service.ts (carrier) | 1859, 8806-8815, 15665, 16930 | through the carrier helper | G | — |
| T/reclaim-stalled-task.ts | 16, 48 | `TASK_OCCUPYING`, the occupied count before a task goes back | H | T11 |
| T/verification-dependency.ts | 135, 180 | `TASK_OCCUPYING.includes(runStatus)` | H | T11 |
| T/verification-liveness.ts | 73, 79 | held = a live run; `!== PENDING` = ever ran | H; not Q | T11 |
| T/verification-epoch-read.ts | 88, 96 | the word into a `runStatus` fact for the two rows above | the facts | T11 |
| T/refused-run-replacement.ts | 26, 50 | `status !== 'FAILED'` means no replacement | W: `releaseWasFailure`, exact, because the other columns it reads (failure kind, health effect, admission) are written only by a failure release | T11 |
| T/evidence-review.service.ts | 107 | an idle creator = AWAITING_INPUT or INTERRUPTED (no `finished_at`) | AI | T11 |
| T/owner-confirmation-if-confirmed.ts | 272 | `TASK_OCCUPYING`: other live runs of the task | H | T11 |
| T/reference-expansion.ts | 100, 167, 176 | the carrier count; the last run's word in the agent's prompt | G; P | T11 |
| T/task-run-receipt.ts | 462, 476, 490, 522, 545 | `conflictingSessionStatus` in 409 bodies | P | T11 |
| T/task-route-decision.ts | 416, 443 | the word into the stored route input | P | T11 |
| T/model-routing.ts | 305 | `ModelRoutingRun.status: string`, read by nothing | P (type) | T11 |
| T/task-retry-policy.ts | 62, 72 | `sessionStatus == null` only means a purged row | unchanged (presence) | — |
| L/task-lists.service.ts | 515, 858 (helpers 151, 219, 582) | `TASK_OCCUPYING`: the batch cap re-stamp; stopping a list's runs | H | T11 |
| S/enums.ts (enum) | 5-15 | `RunStatus` | stays, as the protocol's and the wire's type | — |
| S/enums.ts (derivers) | 51-62, 77-86, 121-157, 188-228 | `runState` and `sessionState` from the word and the end reason | unchanged, fed the derived word | T4 |
| S/enums.ts (`gracefulEndStatus`) | 238-248 | the word the finalize and the reaper write after an asked end | read by the projector (P4) and `effectiveStatus`; no longer stored | T4 |
| S/dto.ts (search hit) | 4597-4604 | `SessionSearchHit` fields | P | T12 |
| S/dto.ts (other) | 2920, 4018, 4036, 4051 | the account-removal list; takeover and reclaim answers | P | T12 |
| S/dto.ts (runner verdicts) | 4140, 4341 | turn-complete and finalize `status: RunStatus` | V | — |
| S/realtime.ts | 243-250, 426-433 | summary and `session.ended` fields | P | T12 |
| S/link-preview.ts | 69-72, 106-107 | card fields | P | T12 |
| S/session-guests.ts | 39-40 | guest fields | P | T12 |
| S/watch.ts | 209-211, 278-279 | observed `status` and `runState` | P | T12 |

### 2.5 Uses the note's tables do not list

Found by the coverage sweep (§9). In files the tables list, the extra lines are folded into the rows above. In files
they do not name:

| File:line | What it decides | After | Task |
|---|---|---|---|
| feishu/feishu-group.service.ts:269 | a group chat's running Feishu threads, `IN ('PENDING','RUNNING')` | U | T12 |
| feishu/feishu-open-limits.ts:99 | the per-person and account-wide running-thread limits, same | U | T12 |
| sessions/open-list-version.ts:125-127 | the list version's foreign-running part: RUNNING on runners where the owner has PENDING sessions | F; Q | T10 |
| realtime/open-list-hints.ts:276 | workspaces with queued sessions | Q | T9 |
| github/github-workspace.service.ts:272 | queued sessions republished when a clone moves | Q | T12 |
| providers/pool-pause.ts:19 | a relation filter `session: { status: 'RUNNING' }` on turns delivered before a pool pause | F | T12 |
| sessions/session-reach.ts:246 | `TASK_OCCUPYING`: every live run must be reachable before a verdict | H | T10 |
| projects/coordinator-handoff.service.ts:221-233, 259 | the runner's turn word decides the handoff note; `RELEASE_FAILURE_SELECT` | V; the select drops `status` | T11 |
| src/shared/src/wikiChat.ts:1304 | `WikiChatRow.status` | P | T12 |
| 16 files that read only through `sessionHasEnded` or `conversationIsOver/Down/Paused` (`projects/coordinator-evidence-queue.ts`, `coordinator-delivery.service.ts`, `completion-evidence.producer.ts`, `project-looks-finished.ts`, `project-open-item.service.ts`, `project-orphan-sweep.service.ts`, `project-started.ts`, `run-item-hold.ts`; `sessions/run-question.ts`, `session-request.service.ts`; `tasks/evidence-review.ts`, `owed-task-turn.ts`, `owner-confirmation-review.service.ts`, `owner-confirmation-review.ts`, `task-evidence-decision.ts`, `undecidable-evidence.ts`) | whether a session has ended or its coordinator is paused | E: `SESSION_ENDING_SELECT` and `COORDINATOR_PAUSE_SELECT` drop `status`; the callers do not change | T7 (`runIsOver`), T11 (the two selects and `conversationIsPaused`) |
| 4 files that read only through the carrier helper (`projects/project-list-rollup.ts:119, 268`, `project-task-work-state.ts:76, 264`; `tasks/manual-runnable-task-sql.ts:44`, `session-created-tasks.service.ts:136`) | tasks being worked on | G | — |

### 2.6 Runner, link gateway, drive mount, scripts and contracts (note §7.3)

- **`src/runner-go/`**: no change. Every word it reads keeps its meaning (§3.2), and it sends the same words; the
  `--status` validator, the MCP enum and their help stay (§6).
- **`src/link-gateway/client_drills.go:417`** sends AWAITING_INPUT as a turn-complete word in a drill; the server takes
  any word there as it does today (turn-complete does not validate it: runner report, Table B2). No change.
- **`src/drive-mount/`**: no session status.
- **`contracts/session-state.contract.json`** (68, 82-91), **`contracts/watch.contract.json`** (18-30, 97-99, 232,
  272, 321, 333, 563-664, 877-962) and **`contracts/session-list-order.fixtures.json`** (43-359): the server-side
  vectors are restated over the facts (`turn_state`, `finished_at`, the release facts) in T13. What they say about the
  wire (the legacy fields and their words) does not change, so the clients' readings of them do not either.
- **Scripts that read the column in SQL** (catalog audits, prechecks, `project-liveness-audit.sql`,
  `launch-metrics/partner-funnel.sql`, the runner-link drills, the dsh and fork drills, `long-running-loops`,
  `acceptance/session-release`, `acceptance/lib/integration-line-fixture.sh`, `managed-runner/lab/acceptance-lab.py`,
  and the rest of note §7.3 marked "BREAKS if stored words change"): T13 moves them to the facts, or to
  `session_legacy_status` where they report a word, before D4. `scripts/session-status-db-objects.sql` gains the new
  objects. Scripts that read the API's words need nothing.

### 2.7 Web, Apple and Android (note §7.4, §7.5)

No change for storage. Every row there reads the wire fields, which keep today's words but for §3.4, or the facts,
which do not change; no client sends a word back (note §7.5). The display tasks of this project move them onto `phase`
and the facts, separately. The one local writer, `src/macos/OrbitApp/Sources/OrbitApp/Views/SessionProjectListSupport.swift:12`,
builds a row on the device and sends nothing.

### 2.8 Database objects (note §7.6)

In §4.2.

## 3. Wire compatibility

The server keeps sending `status`, `runStatus`, `runState` and `sessionState` (project instructions), and keeps
accepting the words runners send. After D3 it has no stored word to copy, so it derives one.

### 3.1 The projector

One function, `legacySessionStatus(facts, landing?)` in a new `sessions/session-legacy-words.ts`, with an SQL twin
`session_legacy_status(...)` for the two database functions that need a word (§4.2). `withSessionState`
(`sessions/session-state.ts:103-128`) takes the derived word where it copies the stored one today (`runStatus:
session.status`, 122); `runState` and `sessionState` keep coming from the existing derivers, `deriveSessionRunState`
and `deriveSessionState` (`src/shared/src/enums.ts:130-158, 188-228`), fed the derived word, so their mapping does not
change.

Held rows (`finished_at IS NULL`), exact:

| `turn_state` | Word |
|---|---|
| `QUEUED` | PENDING |
| `IN_FLIGHT` | RUNNING |
| `ABANDONED` | INTERRUPTED |
| null | AWAITING_INPUT |

Released rows, first match wins:

| # | Facts | Word | Why |
|---|---|---|---|
| P1 | `end_reason IS NULL AND last_turn_outcome = 'FAILED'` | FAILED | released by a failure (`common/session-release.ts:177-182`); every failure writer records the outcome, and migration 1441 wrote it for the rows that lacked it (its header) |
| P2 | `end_reason IS NULL AND last_turn_outcome IS NULL AND import_source_cwd IS NOT NULL` | FAILED | a failed transcript import: it is released FAILED into Trash and keeps its pending-import marker (`ctl:11044-11054`), which only a successful import clears (`ctl:11022-11025`) |
| P3 | `kind = 'LANDING' AND end_reason IS NULL` | SUCCEEDED or CANCELLED by `landingContainerStatus` of its `project_landing` row | the writer's own rule (`projects/landing-session.ts:59-74`); `project_landing.session_id` is unique (catalog) |
| P4 | `end_reason = 'task_done' AND started_at IS NOT NULL` | SUCCEEDED | `gracefulEndStatus` (`src/shared/src/enums.ts:238-248`), which the finalize writes when an end was asked (`ctl:10442-10443`); a session ended before it ever started is written CANCELLED (`sessions/sessions.service.ts:10651-10667`) |
| P5 | anything else | CANCELLED | every other end and stop |

The projector is pinned by a golden over every shape of `common/session-release-shapes.fixture.ts` (stored word,
derived word, and the four wire fields), and its SQL twin by a PG spec over the same rows.

### 3.2 Runners

**Words runners send.** Turn-complete carries SUCCEEDED, FAILED, INTERRUPTED or CANCELLED (`src/runner-go/types.go:1971`;
per engine in the runner report, §9) and finalize SUCCEEDED, FAILED or CANCELLED (`types.go:2089`, built at
`src/runner-go/session.go:1960`). Nothing changes for them: the server already reads them as the runner's verdict and
never stores them as they come. Turn-complete maps them to the turn outcome (`runner-api/turn-outcome.ts:46-76`) and to
the next turn state; finalize to `effectiveStatus` (`ctl:10438-10444`), which today it also writes. Afterwards it is
still computed for everything else it decides: whether the checkout is kept (`ctl:10447-10454`), the log of a success
with no end (`ctl:10645-10647`), the STATUS event (`ctl:10876-10887`) and the task's effects. Finalize keeps refusing
a non-terminal word with 400 (`ctl:10413-10415`). The type stays as the protocol's, `RunStatus` in `src/shared/src/enums.ts:5-15`; the
Prisma enum of the same name goes with the column (D3).

**Words runners read**, each answered from the projector over the row the answer reads today:

| Answer | Today (server) | What the runner does with the word |
|---|---|---|
| Reclaim rows | the stored word of held rows (`ctl:4600-4606`, `4900`) | "" or RUNNING: start active with a permit; PENDING: priority phase; others: idle; terminal words are closed (`src/runner-go/runloop.go:690-723, 780-797, 975-977`) |
| Takeover, single and batch | the word read `FOR UPDATE` (`ctl:5117, 5207, 5240, 5365, 5407`) | RUNNING or "" active; PENDING, AWAITING_INPUT, INTERRUPTED cold; terminal closed (`runloop.go:707-716, 1133-1143, 3275-3276`; `src/runner-go/reclaim_starter.go:276-288`) |
| Turn-complete reply | the stored word, a constant, or the computed next word (`ctl:8734, 8934, 8966, 8980`; values in the runner report) | terminal: stop the engine; RUNNING: keep the permit; else park (`src/runner-go/session.go:656-663, 712, 1413-1420`); on a failed turn a terminal word or, declared v1, RUNNING (`session.go:1697-1738`) |
| Session get / list (runner) | `withSessionState` over the stored word (`sessions/sessions.service.ts:3395-3396, 3523`) | create-wait: PENDING, RUNNING or "" not settled (`src/runner-go/mcp.go:3492-3500`); import wait: FAILED, CANCELLED, INTERRUPTED fail (`src/runner-go/session_cli.go:826-829`) |

Held rows answer exactly today's words, so every runner behaves as it does today; that includes runners before
`v0.1.261-beta.65`, which close a session on a word they do not know (today's `reclaimStatusOpen` keeps such a row open
only since `a7a341811d`, `src/runner-go/runloop.go:699-716`), because no new word reaches them.
The released kinds of §3.4 change only between terminal words, which every runner treats alike, except the import
wait, where SUCCEEDED and CANCELLED differ; no row of §3.4 is a session an import wait polls (an import that fails is
P2, and keeps FAILED).

Three answers need care in the rewrite (task T8):

- the turn-complete reply of the steer paths answers the word **as read before** the steer's own move to PENDING
  (`ctl:7701` after `7686-7689`): the projector reads the same snapshot;
- a batch takeover row with neither `status` nor `error` reads RUNNING on the runner (`src/runner-go/transport.go:800-840`):
  every row keeps one of the two;
- the server never sends `sessionStatus` (runner report): it stays unsent.

### 3.3 Apple and Android apps

They read `status`, `runStatus`, `runState` and `sessionState` (note §7.5) and send none back (note §4.1). With the
projector they receive today's words for every held row and every released row outside §3.4. The facts they read
first in newer builds (`phase`, `released`, `lastTurnOutcome`, `waitingOn`, `endReason`, `workFinished`,
`contracts/session-state.contract.json`) do not change. The traps of note §4.1 (strict decoders before `beta.65`, the
unknown-word fall to Ended in `deriveSessionRunState`, `src/shared/src/enums.ts:155-156`) are not reached, because no
new word goes on the wire.

### 3.4 Row kinds that cannot get today's word back

From the shapes of `common/session-release-shapes.fixture.ts` (as migration 1441 left them) and the writers of §2.
"Rows" are production counts where they were measured (design and fixture notes); the rehearsal counts every kind
(§7.2) before deploy 2, and a kind not in this table stops it.

| Kind | Writer | `status` | `runState` | `sessionState` | Production rows | Handling |
|---|---|---|---|---|---|---|
| C1. An end asked for and not honoured, released by the reaper (shapes W7 running, W7 idle, W7 after a failed turn: reasons `cancelled`, `completed`, `deleted`) | the reaper's `forceFinalize`: `gracefulEndStatus` gives nothing for those reasons, so FAILED (`realtime/reaper.service.ts:545-557, 1077-1092`) | FAILED → CANCELLED | FAILED → ENDED | FAILED → CANCELLED (batch stop) or COMPLETED (filed in Completed); DELETED (Trash) unchanged | not measured | **accepted** by the owner (ruling `353V98YS1zSj3ugrGpclE`: "an end the runner did not honour would read Ended instead of Failed") |
| C2. The runner refused the source after an end was asked (W4 after an end) | `projects/session-source.ts:704-706` | FAILED → CANCELLED | FAILED → ENDED | FAILED → DORMANT (reason `ended`), or as C1 for the other reasons | not measured | the same principle as C1, but **not on the owner's card**: put to the owner with this plan |
| C3. Old FAILED rows with an end reason (B1 completed, B1 task_done) | migration 1262 | FAILED → CANCELLED (`completed`) or SUCCEEDED (`task_done`) | FAILED → ENDED or SUCCEEDED | FAILED → COMPLETED when filed in Completed, as both reasons normally are; an unfiled `completed` row reads CANCELLED | 13 of 85 for `completed` (fixture note); `task_done` not measured | **not on the owner's card**: put to the owner. No backfill can keep FAILED without also turning honoured ends (N1, N2) to FAILED |
| C4. Old SUCCEEDED rows with no end (B3) | migration 1262 | SUCCEEDED → CANCELLED | SUCCEEDED → ENDED | COMPLETED → DORMANT; unchanged when filed (COMPLETED) or in Trash (DELETED) | 318 (2026-11-21) | **accepted** ("old SUCCEEDED rows read Ended unless backfilled"). No backfill offered: the only facts that could say SUCCEEDED would say it for N4 too, a current writer |
| C5. A finalize reporting SUCCEEDED with no end asked (N4 SUCCEEDED) | `ctl:10444`, logged at `ctl:10645-10647` | SUCCEEDED → CANCELLED | SUCCEEDED → ENDED | as C4 | expected 0: no runner the server accepts sends it (`common/session-release.ts:233-243`) | put to the owner with its count |
| C6. A cancel with no end reason, not honoured (W7 no reason) | the reaper; no current writer leaves one (fixture) | FAILED → CANCELLED | FAILED → ENDED | FAILED → DORMANT | expected 0 | put to the owner with its count |
| C7. A session that had started, ended while queued with reason `task_done` | `sessions/sessions.service.ts:10651-10667` writes CANCELLED for any reason | CANCELLED → SUCCEEDED | ENDED → SUCCEEDED | DORMANT → COMPLETED; unchanged when filed | not measured; P4's `started_at` keeps the never-started ones exact | put to the owner with its count |

`runState` and `sessionState` follow from the word, the end reason and the filing through the unchanged derivers
(`src/shared/src/enums.ts:130-158, 188-228`): Trash reads DELETED first, Completed reads COMPLETED unless the word is
FAILED, then the word decides. The same kinds change wherever the server stores the word or something made from it,
for what is written from D2 on (what is stored stays as it is):

- `session_request.close_reason`, from the trigger (§4.2) and from `sessions/session-request.ts:1128`;
- watch observations (`watches/watch-predicate.ts:486-505`) in `watch_match.per_target_snapshot`,
  `watch_delivery.expiry_snapshot` and the RESUME_SESSION wake message (`watches/watch-delivery.service.ts:838-872`);
- the coordinator's wake facts that carry `sessionStatus` (`projects/task-exception-input.producer.ts:41-126`,
  `projects/coordinator-wake.ts:363-375`), the task comment of an attempt that ended unsettled, and its blocker's
  `detail.sessionStatus`, whose sha256 is the blocker's `condition_version`
  (`projects/attempt-ended-unsettled.producer.ts:390-409, 443-464`): a blocker raised again across D2 for a row of
  these kinds gets a new version;
- the wiki dossier header (`wiki/wiki-dossier.ts:1939`), whose hash is stored (`wiki/wiki-maintenance.ts:772`): a
  dossier that names a session of these kinds is rebuilt once.

The sentences the reaper and the finalize write into `conversation_turn.delivery_failure_reason`,
`watch_delivery.last_error` and `project_criterion_confirmation.note` (`realtime/reaper.service.ts:1129, 1136, 1161`;
`ctl:10671, 10678, 10707`) carry the word those writers compute, not the stored one; they keep computing it, so the
sentences do not change.

The goldens that pin today's words, `sessions/session-state-legacy-fields.golden.json` and
`sessions/session-payloads-legacy.golden.json`, are restated in the projector task (T4) for exactly these kinds and no
other row; project criterion 6 ("unchanged values") is read with this table as its list of exceptions, which the
coordinator takes to the owner with C2, C3, C5, C6 and C7.

### 3.5 Kinds that keep their word only because of a fact

| Kind | Fact that keeps it | Without it |
|---|---|---|
| The out-of-memory stop (INTERRUPTED) | `turn_state = 'ABANDONED'` | Awaiting reply (the owner's card accepted it; not needed) |
| A failed transcript import (W5) | `import_source_cwd IS NOT NULL` (P2) | Ended |
| A landing container (N5, N5 not landed, B7) | its `project_landing.settled_as` (P3) | one word for both |
| A session ended before it ever started with reason `task_done` (N1 queued) | `started_at IS NULL` (P4) | Succeeded |

## 4. Database

### 4.1 Deploy order, hand-over and rollback

Every deploy is a two-replica hand-over: the new apiserver runs `prisma migrate deploy` as it starts
(`src/apiserver/Dockerfile:98`) while the old one still serves, and both serve until the old one stops
(`.agents/skills/upgrade/SKILL.md:121`). So each migration must be right for the code before it, and each code for the
rows the code before it writes. The upgrade skill hands over without a gap unless a migration is one the running code
"cannot run against", such as "a constraint or trigger its writes break" (`.agents/skills/upgrade/SKILL.md:123`); none
of the four is, by the hand-over column below, and the rehearsal runs both replicas against each to show it. Each
deploy needs the owner's go, and the next starts only when the previous one is live on every replica (the rule 1401
and 1443 state in their headers).

The storage tasks reach production as four promotions of the project branch, in this order; the display tasks do not
depend on them (project goal) and may ride any of them.

| Step | Migrations | Code | During the hand-over | Rollback |
|---|---|---|---|---|
| **D1** | add `turn_state` and `phase` (nullable, value CHECKs NOT VALID then validated, both trivially true); `session_turn_state_of_status(run_status)` and `session_phase_of(…)`; trigger `session_aa_turn_state_from_status` (BEFORE INSERT OR UPDATE OF status: the facts follow the word) and `session_zz_phase` (BEFORE INSERT OR UPDATE OF status, turn_state, finished_at and the three execution columns) | none: the Prisma model does not declare the two columns yet (T4 adds them, for D2), so no payload carries them while they are unfilled | both replicas write the word; the trigger keeps the facts | free: the columns are unused; a down script drops them |
| **Backfill** | — (runbook, §4.4) | — | — | nothing to undo: the facts are derived from the word |
| **D2** | assert no row disagrees (refuse otherwise); `session_turn_state_agrees_chk`, `session_turn_state_released_chk`, `phase` NOT NULL, each NOT VALID then validated in a file of its own; the partial indexes, concurrently (§4.5); the triggers and functions restated to read the facts (§4.2) | every reader reads the facts; every writer writes the word **and** `turn_state` with the matching value; the wire words come from the projector; the `?status=` filter translates (§6) | D1 code writes the word only; the trigger derives the facts; the CHECK keeps the two spellings equal for both replicas | free, to D1 code: it reads and writes the word, the trigger and CHECK keep the facts equal to it, and the restated database functions read facts equal to it |
| **D3** | replace `session_aa_turn_state_from_status` with `session_aa_status_from_facts`: BEFORE INSERT OR UPDATE OF the facts (not of `status`), the word follows the facts through `session_legacy_status` | writers write the facts only; the field `status` and the Prisma enum `RunStatus` leave `schema.prisma`; nothing in the server reads or writes the column | D2 code writes both, consistently (its rule, guarded and spec'd); a stray D2 write of the word alone fails the CHECK loudly instead of being undone silently | to D2 code only: the trigger keeps the word valid and the CHECKs hold. Not to D1 code: it writes the word alone |
| **D4** | one DO block: drop the trigger and the two transition CHECKs, recreate the 12 triggers whose column lists name `status` without it, check that nothing else depends on the column (pg_depend and function bodies, as 1443 does), `DROP COLUMN status` (its six indexes go with it), `DROP TYPE run_status` | none | D3 code neither selects nor writes the column | **irreversible**: to D3 code only; the stored words are gone |

From D3 on, "the column is no longer written" holds for all code; the D3 trigger writes it for rollback alone, and D4
removes it. The criterion's end state is D4.

Why the word must decide until D2's readers are live: a reader moved before the backfill would read a null
`turn_state` on an old row as AWAITING_INPUT. Why D2 writers write both: during D3's hand-over the D2 replica still
serves, and with the D3 trigger deriving the word from the facts, a D2 write of the word alone would be lost.

### 4.2 Database objects restated

From the catalog (`9 counts`: 1 column of the type, 12 triggers on `session` naming status, 6 indexes, 1 partial, 1
CHECK, no view, no generated column):

| Object | Reads today | Restated in D2 (task T6) | D4 |
|---|---|---|---|
| `guard_session_engine_acquisition`, `guard_opencode_runner_claim`, `guard_antigravity_runner_claim`, `guard_cursor_runner_acquisition`, `guard_dsh_runner_acquisition`, and their triggers `BEFORE UPDATE OF status[, inbox_lease_owner, inbox_lease_generation]` | the claim transition `OLD.status = 'PENDING' AND NEW.status = 'RUNNING'`; the revive `NEW.status = 'PENDING'` | `OLD.turn_state = 'QUEUED' AND NEW.turn_state = 'IN_FLIGHT'`; revive `NEW.turn_state = 'QUEUED'`; column lists gain `turn_state` (a D3 writer sets only it, and `UPDATE OF` fires on the columns a statement names) | lists lose `status` |
| `session_listed_at_on_settle`, trigger `BEFORE UPDATE OF status, completed_at` | `NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN (released words)` | `NEW.finished_at IS NOT NULL AND OLD.finished_at IS NULL` (every release writes `finished_at` in the same statement: `session_release_fact_chk`); list gains `finished_at`. The one difference: a released row that writer #16 turns into FAILED moves `listed_at` today and would not (§2.2); the census counts such rows, and T6 keeps today's behaviour for them if any exist | list loses `status` |
| `session_request_recipient_ended` (function and trigger) | writes the word, then `':'` and the end reason, into `session_request.close_reason` (`NEW.status::text` concatenated); WHEN `new.status = 'INTERRUPTED' AND end_reason <> ''` | `session_legacy_status(…)` for the word; WHEN `new.turn_state = 'ABANDONED' AND …`; list gains `turn_state` | list loses `status` |
| `session_request_asker_stopped` (trigger WHEN) | INTERRUPTED with an end; `new.status = 'AWAITING_INPUT' AND retry disarmed` | ABANDONED with an end; `new.finished_at IS NULL AND new.turn_state IS NULL AND …` | list loses `status` |
| `task_owner_confirmation_review_reviewer_ended` (trigger WHEN) | INTERRUPTED with an end | ABANDONED with an end | list loses `status` |
| `open_list_bump_owner` (runs on workspace rows) | `s.status = 'PENDING' AND s.started_at IS NULL` | `s.turn_state = 'QUEUED' AND s.started_at IS NULL` | — |
| `session_admission_lock_order_update`, `session_project_capacity_serialize_update`, `session_superseded_task_revive_guard` | column lists only; the bodies already read `finished_at` | unchanged | lists lose `status` |
| `session_release_fact_chk` | word ⇔ `finished_at` | kept until D4 | dropped |
| indexes `session_status_idx`, `session_assigned_runner_id_status_idx`, `session_batch_id_status_idx`, `session_owner_status_task_idx`, `session_root_session_id_status_idx`, partial `session_over_capacity_pending_idx` | `status` | replacements built beside them (§4.5); the old ones stay, unused, for D1 code | dropped with the column |
| `open_list_bump_session` (statement trigger) | no word; compares rows minus its skip list | unchanged: `turn_state` and `phase` change only with drawn columns | — |

Each `CREATE OR REPLACE FUNCTION` body is taken, when the task writes it, from the function as a freshly migrated
database holds it (`pg_get_functiondef`), and its PG spec compares the restated text: a body written from an older
main silently reverts later changes to the function (wiki pitfall `34WsH2gujacTuVvbF90Lo`).

### 4.3 The column and the type

The column is dropped, in D4. It is the only column of type `run_status` (catalog section 1), so the whole type is
dropped with it and the dead labels (`PARKED`, and with it every other) go too: the "PostgreSQL cannot drop an enum
label" limit (`prisma/schema.prisma:25-28`) does not apply to dropping the type. Prisma selects every field it declares,
so the column can go only one deploy after the field left `schema.prisma` (1443's header; `sessions/session-release-column-compat.pg.spec.ts:1-17`),
which is why D3 removes the field and D4 the column. A trigger whose `UPDATE OF` list names the column blocks
`DROP COLUMN` with 2BP01 (wiki pitfall `34Z1E0hrFULQcOjixarV7`), and function bodies are not tracked by pg_depend,
hence the explicit restating
and the body scan in D4's DO block.

### 4.4 Backfill, in batches

Between D1 and D2, with the owner's go (it writes production), task T3 runs `scripts/session-turn-state-backfill.sql`
until it reports 0 rows:

```sql
SET lock_timeout = '2s';
UPDATE "session" s
   SET "turn_state" = session_turn_state_of_status(s."status")      -- names turn_state: session_zz_phase recomputes phase
 WHERE s."id" IN (SELECT "id" FROM "session"
                   WHERE "turn_state" IS DISTINCT FROM session_turn_state_of_status("status")
                      OR "phase" IS DISTINCT FROM session_phase_of("finished_at", session_turn_state_of_status("status"),
                                                                    "engine_turn_active", "running_subagents", "running_bg_jobs")
                   ORDER BY "id" LIMIT 500
                   FOR UPDATE SKIP LOCKED);
```

- 500 rows a batch, each its own transaction, by id (UUIDv7, so oldest first); a lock timeout skips the batch to the
  next run. Production had 12,201 sessions on 2026-11-22 (header of migration 1441): about 25 batches.
- Each batch fires `session_open_list_epoch_update` once: its function bumps on any column outside its skip list
  (catalog, `open_list_bump_session`; the list is `OPEN_LIST_UNDRAWN_SESSION_COLUMNS`,
  `sessions/open-list-version.ts:223`), and the two new columns are not in it. So each owner with a row in the batch
  gets one list-changed hint: about 25 hints per owner in all, spread over the run.
- The census (§7.2) runs after it; D2's first migration asserts that no row disagrees and refuses to run otherwise.

### 4.5 Partial indexes, and the query plans to re-measure

Candidates (task T5 builds the ones the measurements keep, each `CREATE INDEX CONCURRENTLY` in a file of its own,
after a `DROP INDEX IF EXISTS` under a 2 s lock timeout, as `1426_session_task_execution_claim_finished_at_idx` does):

| Index | For | Replaces the access path of |
|---|---|---|
| `(assigned_runner_id, turn_state) WHERE turn_state IS NOT NULL` | claim candidate, slot count, replay, hold notices, upgrade notices | `session_assigned_runner_id_status_idx` |
| `(assigned_runner_id) WHERE finished_at IS NULL` | reclaim set, heartbeat fence, managed runner sleep, lost runner work: the held sessions of one runner | `sessionHeldIndexedSql`'s status list (`common/session-release.ts:96-106`), which exists only so the planner can use a status index |
| `(batch_id) WHERE turn_state = 'IN_FLIGHT'` | batch cap | `session_batch_id_status_idx` |
| `(root_session_id) WHERE turn_state = 'IN_FLIGHT'` | tree cap, claim order | `session_root_session_id_status_idx` |
| `(assigned_runner_id) WHERE over_capacity_turn_id IS NOT NULL AND turn_state = 'QUEUED'` | Run now's probe | `session_over_capacity_pending_idx` |
| `(owner_id, task_id) WHERE finished_at IS NULL` | task occupancy by owner, the carrier | `session_owner_status_task_idx` (named for the carrier at `sessions/task-work-carrier.ts:82-86`) |

Plans to measure, `EXPLAIN (ANALYZE, BUFFERS)` on the rehearsal copy before (word) and after (facts), for the runner
with the most sessions:

1. the claim (`queue/queue.service.ts:489-770`), alone and with a batch and a tree;
2. `runnerActiveTurns`, `batchActiveTurns`, `treeActiveTurns`, `runnerBackgroundHeldSessions` (`common/session-tree-sql.ts`);
3. every `sessionHeldIndexedSql` reader: managed runner sleep (`managed-runners/managed-runner-work.ts:68`), the dispatch
   pause (`queue/dispatch-pause.service.ts:40, 123`), and the case measured at step 4.3 of the earlier plan (44,000
   index entries for 73 rows, `common/session-release.ts:100-102`);
4. the reclaim `findMany` (`ctl:4599-4640`) and the heartbeat fence (`ctl:2735`);
5. task occupancy (`tasks/tasks.service.ts:13919, 14087, 17316`; `task-lists/task-lists.service.ts:515, 858`;
   `tasks/reclaim-stalled-task.ts:48`) and the carrier (`sessions/task-work-carrier.ts:92-98`);
6. the auto-run slot budget (`tasks/tasks.service.ts:12534, 12540`) and the reaper's sweep (`realtime/reaper.service.ts:471`);
7. `listForOrchestration` with each `?status=` word (`sessions/sessions.service.ts:3348-3364`);
8. the writes: the hottest update (event ingestion moving the running sets) with and without `session_zz_phase`, and
   the share of HOT updates on `session` before and after.

A plan that reads more buffers than today's stops T5 until an index answers it.

### 4.6 Migration mechanics

- Locks on `session` are asked for 2 s at a time, 1 s apart, up to 45 tries, in one DO statement (1261, 1401, 1443;
  wiki pitfall `34tAIeWfI8PIORcRie8kO`);
  a validating scan never runs under that lock, so each `VALIDATE CONSTRAINT` is in a file with no DO, which Prisma
  7.10 sends a statement at a time (header of `0479_wiki_chat_session_checks_index`), and so is each concurrent build.
- `SET NOT NULL` on `phase` follows a validated `CHECK (phase IS NOT NULL)`, so it does not scan.
- Migration numbers are chosen when each task is written, above everything on main, `project/*` and pushed `orbit/*`
  branches (main's highest today: 1600).
- Every trigger added, restated or dropped (T2, T6, T14, T15) also changes its entry in `TRIGGER_WRITE_SOURCES`
  (`common/db-write-inventory.ts:4582`), which `common/db-write-inventory.spec.ts:557` holds to the triggers the
  migrations install.

## 5. The guard

A unit spec, `sessions/session-status-column.spec.ts`, with its allow-list `sessions/session-status-column.allowed.ts`,
in the shape of `sessions/session-terminal-status-readers.spec.ts` (comments stripped by its `stripComments`, product
files only, counts that may only fall). It lands first (task T1), seeded from the tree, so no new reader can appear
while the others move.

What counts as a hit, each reported as `file:line: reads|writes session.status (<how>)`:

- **Prisma.** A property `status` in the `where`, `data`, `create`, `update`, `select`, `omit`, `orderBy`, `distinct`,
  `by` or `cursor` argument of a call on `.session.<method>` (any receiver), or under a relation filter that leads to
  `Session` from another model (relation names read from `schema.prisma`, e.g. `sessions: { some: … }`); in an
  object typed or `satisfies` `Prisma.Session…Input`; `Prisma.SessionScalarFieldEnum.status`; a read `x.status`
  where `x` is bound, in the same function, from a session query.
- **Raw SQL.** In a template or string literal that names the table `session` after FROM, JOIN, UPDATE or INTO:
  `<alias>."status"` or `<alias>.status` for that statement's session alias, `status` or `"status"` in the SET or
  WHERE of a single-table session statement, and a cast to `run_status`.
- **The enum.** `RunStatus` imported from `@prisma/client`, which is the column's type (the protocol's lives in
  `@orbit/shared`).
- **Dual write (D2 only).** A session `data` object that writes `status` without `turnState` beside it.
- **Phase where slots are decided.** `phase` read in `queue/`, `common/session-tree-sql.ts`, `common/session-scheduling.ts`
  or the slot counts of `runners/` and `managed-runners/`.

The allow-list holds, per file, a read count and a write count. T7 to T12 take the reads to 0; T14 takes the writes to
0 and deletes the list. A file not listed must have none.

Fails by name: the spec runs its scanner over planted snippets, one per kind of hit, and asserts each is reported at
its line; each migration task's evidence also plants one in a product file and shows the spec failing with that
file and line.

What text cannot see is closed by two more checks:

- in D3 the field leaves `schema.prisma`, so `tsc` rejects every Prisma read or write the scanner missed;
- the database side, `sessions/session-status-column.pg.spec.ts`: on a migrated database, no function body, trigger
  column list or WHEN clause, index, CHECK or view names `session.status` (the catalog queries of
  `scripts/session-status-db-objects.sql`) but the transition's own objects, which it lists. T1 seeds it with today's
  objects, T6 takes out the restated ones, and T15 makes it the column-less check: the column and the type are gone,
  and the writers and a model read of every kind the compat spec of 1443 runs work on a database without them.

The existing guard, `sessions/session-terminal-status-readers.spec.ts`, stays; its counts fall with the same tasks, and
T14 deletes the rows of the release writers it allows today.

## 6. The `--status` / `?status=` filters and the MCP enum

Today `GET /sessions/compact?status=` (`sessions/sessions.controller.ts:373-382`) and the runner's `GET
/runner/sessions?status=` (`runner-api/runner-sessions.controller.ts:300-321`) accept exactly one of the seven words,
case-sensitive; anything else is ignored and the list comes back unfiltered, with no 400. Both end in
`listForOrchestration`, `...(status ? { status } : {})` (`sessions/sessions.service.ts:3348-3364`). The CLI's
`orbit session list --status` validates the seven words before sending (`src/runner-go/session_cli.go:580-590`), and
the MCP `session_list` schema carries the same enum (`src/runner-go/operation_catalog.go:2895`), passed through
unchanged (`src/runner-go/mcp.go:3526-3539`).

After: the same seven words are accepted, unknown words are still ignored, and each word becomes the condition that
selects exactly the rows the projector gives that word (one function beside the projector, `statusWordFilter(word)`,
pinned by a PG spec that checks, for every shape, filter membership against the projector's answer):

| Word | Condition |
|---|---|
| PENDING | `turn_state = 'QUEUED'` |
| RUNNING | `turn_state = 'IN_FLIGHT'` |
| INTERRUPTED | `turn_state = 'ABANDONED'` |
| AWAITING_INPUT | `finished_at IS NULL AND turn_state IS NULL` |
| FAILED | released and P1 or P2 |
| SUCCEEDED | released, not P1/P2, and P3 landed or P4 (the list shows CONVERSATION rows only, so P3 never applies there) |
| CANCELLED | released and neither of the two above |

No runner release is needed: the CLI and the MCP enum keep their seven words, and "status and its values are
unchanged" (`src/runner-go/operation_catalog.go:39`) stays true but for §3.4. A `?phase=` filter is not proposed.

Watches read the word through three leaves (`watches/watch-predicate.ts:322-342`): `SESSION_TURN_SETTLED` (not
PENDING or RUNNING, 328) becomes `turn_state IS DISTINCT FROM 'QUEUED' AND turn_state IS DISTINCT FROM 'IN_FLIGHT'`;
`SESSION_QUIESCENT` is that settled test plus the executing and wake facts (334-337), which read `finished_at` and
the execution columns; `SESSION_RUN_TERMINAL` is `runIsOver` on the facts (released, or ABANDONED with an end reason,
341). Observations keep a `status`, the projected word: Android drops the whole observed block without one
(`src/android/app/src/main/kotlin/io/orbitd/android/watch/WatchWire.kt:205-206`).

## 7. Rehearsal and real-stack walk

### 7.1 The copy

A production-shaped copy is the newest nightly backup (`docs/postgres-backup-restore.md`) restored into a throwaway
PostgreSQL 16 on the host that keeps the backups, with the owner's go, because it holds people's data. It stays on that
host; only counts, timings and plans leave it. Before any server runs on it, its outbound doors are shut: the email
outbox, push, Feishu and GitHub tokens are blanked, and no production runner is pointed at it.

### 7.2 Rehearsal (tasks T16 and T17)

On the copy, timed, with a writer loop updating sessions the way event ingestion does (to see the lock tries work):

1. D1's migrations; then the backfill, batch count and duration;
2. **the census**: for every row, the stored word against `legacySessionStatus`, and `phase` against `deriveSessionPhase`;
   one line per (stored word, derived word, end reason, outcome, kind, import marker, trashed) with its count. Every
   mismatch must be a kind of §3.4, with its count reported to the owner; any other stops D2;
3. D2's migrations: the assertion, each `VALIDATE`, `SET NOT NULL`, each concurrent build, with their lock waits;
4. the plans of §4.5, before and after;
5. (T17, before D3) D3's and D4's migrations on the same copy, with D2 code and D3 code serving it in turn, and the
   dependency check of D4 run once with a trigger left naming `status` to see it refuse.

### 7.3 The walk

A real stack built from the branch (apiserver, web, link gateway and a current runner, `src/runner-go`) on the migrated
copy, under a test owner and runner registered there, at D1 code, D2 code with a D1 replica beside it, and (T17) D3
code with a D2 replica beside it, then D4. Each scenario is run at every step, and what the runner was answered and
did is recorded and compared with D1:

| # | Scenario | What must be the same as D1 |
|---|---|---|
| S1 | `max_concurrent` 2, three sessions sent at once; one finishes | two run, one queued, then claimed; slot counts on the runner page and the runner's permits |
| S2 | a batch with a cap of 1; a spawn tree at its ceiling with a waiting supervisor | the caps and the exemption |
| S3 | Run now past a full runner | the overflow claim and its bound |
| S4 | a message to a parked session whose background job runs | phase RUNNING, turn queued, claimed; no slot until claimed |
| S5 | a parked session with a running sub-agent | no slot; runner slot count unchanged; Merge held as today |
| S6 | restart the runner with sessions RUNNING, PENDING, AWAITING_INPUT and one ABANDONED (through the out-of-memory stop, or its statement, writer #1, where no managed runner is at hand) | the reclaim and takeover words, which start active and which cold |
| S7 | a turn completing with a follow-up queued, without one, a failed turn on the old protocol and on release v1 (the server switch `ORBIT_SESSION_RELEASE_V1=on`, `runner-api/run-release.ts:32-48`) | the turn-complete reply words, the permit kept or parked |
| S8 | ends: parked, running, queued, task done, not honoured (reaper) | releases; the C1 word changes as §3.4 says and nothing else |
| S9 | a task run, Run on a parked task, batch stop, task delete | the execution claim, occupancy, reach checks |
| S10 | the dispatch pause on and off | nothing claimed while on; the hints when off |
| S11 | `orbit session list --status` with each word; `session_create --wait`; an import | the filtered rows; the waits settle as today |
| S12 | the payloads of every row walked | `status`, `runStatus`, `runState`, `sessionState` equal to D1's but for §3.4 |

## 8. Risks and the task list

### 8.1 Risks

| # | Risk | Carried by |
|---|---|---|
| R1 | A reader that meant "held" by listing held words, with no `finished_at` beside it, is rewritten to a `turn_state` value and loses "held": released rows count as live in slots, claims or dispatch. Seven groups of such reads: the reaper's sweep and its `forceFinalize` guard, lost runner work, the reclaim set and the heartbeat fence, Run now's overflow count, `TASK_OCCUPYING`, mention delivery, the resume candidate (§2.3, §2.4). | T7-T12: each states `finished_at IS NULL` where the old list leaned on the CHECK; the CHECK `session_turn_state_released_chk` makes `turn_state` null on released rows anyway; their PG specs run with released rows present |
| R2 | `phase` read for a slot or claim decision: a sub-agent or background job would take a slot. | T1 (guard kind "phase where slots are decided"), T7 |
| R3 | A D2 writer writes the word without `turn_state`, masked by the D2 trigger, and fails in D3's hand-over. | T1 (dual-write kind), T7-T12, and T14's compat spec, which runs every writer with the D2 trigger absent |
| R4 | A response that returned a raw session row loses `status` when the field leaves the model (D3): a runner's create-wait reads "" as not settled and waits to its timeout (`src/runner-go/mcp.go:3492-3500`); Android drops watch observations. | T10, T12 (every session-bearing response through the projector), T14 (a D3-shaped run of the payload goldens and the runner's own e2e), T17 (S11) |
| R5 | A trigger listing only `status` stops firing once writers set only `turn_state` (D3). | T6 adds `turn_state` to every list in D2 |
| R6 | A function body naming `status` fails at run time after the drop (bodies are not in pg_depend). | T6 restates them in D2; T15's DO block scans bodies and refuses |
| R7 | The Prisma enum `RunStatus` leaves `@prisma/client` with the field (D3): every import of it breaks. | T14 moves them to `@orbit/shared` (guard kind "the enum" counts them from T1) |
| R8 | A query plan regresses with the new indexes. | T5, T16 (§4.5); the old indexes stay until D4 |
| R9 | A migration on the hot `session` table queues every writer behind its lock. | T2, T5, T6, T14, T15 (§4.6) |
| R10 | A restated function reverts a later main change to it. | T6 (§4.2) |
| R11 | Migration numbers collide with another line. | every migration task (§4.6) |
| R12 | Wire words change beyond §3.4. | T4 (goldens over every shape), T16 (census), T17 (S12) |
| R13 | The backfill's list hints refetch every client's open list. | T3 (batches, §4.4) |
| R14 | Rollback past a point of no return: to D1 code after D3, or to any code that declares `status` after D4. | the coordinator's deploy notes (§4.1) |
| R15 | The rehearsal stack on a copy of production reaches real people (mail, push, Feishu) or real runners. | T16, T17 (§7.1) |
| R16 | Stored `phase` and `deriveSessionPhase` disagree, and the wire's `phase` moves. | T2 (PG spec over every shape and fact combination), T16 (census) |
| R17 | A trigger change lands without its entry in the write inventory, and the unit suite fails on the landed commit (`common/db-write-inventory.spec.ts:557`). | T2, T6, T14, T15 (§4.6) |

### 8.2 Tasks

None is filed yet: the coordinator puts this plan to the owner first. Deploy is the first deploy that needs the task.

| # | Task | Deploy | Depends on | Size |
|---|---|---|---|---|
| T1 | Guard spec: apiserver code neither reads nor writes `session.status` (allow-list per file, numbers only fall) | lands first | plan approved | M |
| T2 | Store `turn_state` and `phase`, kept from the word by triggers (D1 migration only; no Prisma field); the PG spec holding the phase trigger to `deriveSessionPhase`; backfill and census scripts | D1 | plan approved | M |
| T3 | Run the backfill on production in batches, and the census | between D1 and D2 | T2 live everywhere; owner's go | S |
| T4 | One projector for the legacy wire words from the facts, its SQL twin and `statusWordFilter`, pinned over every row shape; the two columns join the Prisma model (`withSessionState` keeps `turnState` off the wire); goldens restated for §3.4 only | D2 | T2 | M |
| T5 | The CHECKs, `phase` NOT NULL, the partial indexes and the query-plan script | D2 | T2 | M |
| T6 | Restate the session triggers and functions on the facts | D2 | T2, T4 | L |
| T7 | Claim, slot and dispatch on the facts: `queue/`, `common/`, `managed-runners/`, `runners/`, `metrics/` (reads; writes both) | D2 | T1, T2, T4 | L |
| T8 | Runner API on the facts: reads, writes both, the words answered to runners | D2 | T1, T2, T4 | L |
| T9 | Reaper, lost runner work, and realtime claims, events and hints on the facts | D2 | T1, T2, T4 | M |
| T10 | Sessions and session guests on the facts: reads, writes both, payloads, the `?status=` translation | D2 | T1, T2, T4 | L |
| T11 | Projects, tasks and task lists on the facts | D2 | T1, T2, T4 | L |
| T12 | The remaining modules on the facts: feishu, github, help, link previews, providers, push, schedules, share links, watches, wiki, workspaces, shared types | D2 | T1, T2, T4 | M |
| T13 | Scripts, drills and contracts on the facts | before D4 | T4 | M |
| T14 | Writers stop writing `session.status`; the field and the Prisma enum leave the model; the word follows the facts (D3 migration) | D3 | D2 live everywhere (T5-T12) | L |
| T15 | Drop `session.status` and `run_status`; the column-less PG spec | D4 | D3 live everywhere (T14), T13 | M |
| T16 | Rehearsal on a production-shaped copy and real-stack walk, D1 to D2 | before D2 | T2, T4, T5, T6, T7-T12 | L |
| T17 | Rehearsal and real-stack walk, D3 to D4 | before D3 | T14, T15, T16 | S |

T17 is S because it reruns T16's harness on the next two steps.

## 9. How this plan was made, and what it did not verify

### 9.1 What was read

- The note, the project's instructions and its three storage rulings (top of this file).
- Read directly, at `6f127f0a33`: `sessions/session-phase.ts`, `common/session-release.ts`, `common/session-working.ts`,
  `common/session-scheduling.ts`, `common/session-generating.ts`, `common/session-tree-sql.ts`,
  `sessions/session-state.ts`, `tasks/refused-run-replacement.ts` and `common/session-release-shapes.fixture.ts`
  whole; `src/shared/src/enums.ts:1-260`; `queue/queue.service.ts:420-560, 690-830`; `realtime/parked-session-end.ts:1-145`;
  `sessions/sessions.service.ts:10600-10740`; `sessions/task-work-carrier.ts:60-135`;
  `managed-runners/managed-runner-manager.ts:2225-2280`; `ctl` at 1170-1180, 4600-4606, 4898-4901, 5110-5118,
  7670-7785, 8394-8402, 10395-10470, 10564-10568, 11015-11060; `projects/landing-session.ts:59-80, 255-300, 385-400`;
  `watches/watch-predicate.ts:320-344`; the `Session` model and `enum RunStatus` of `prisma/schema.prisma`
  (2044-2809, 16-28); the headers of migrations 0479, 1401, 1441 and 1443, of
  `sessions/session-release-column-compat.pg.spec.ts` and of the existing guard
  (`sessions/session-terminal-status-readers.spec.ts` and its allow-list); `src/runner-go/runloop.go:680-800, 960-990,
  1055-1075, 1125-1150, 3265-3285`; `src/android/app/src/main/kotlin/io/orbitd/android/watch/WatchWire.kt:200-208`.
- **The catalog**: a throwaway `postgres:16-alpine` with all 681 migration directories of the tree applied by psql
  (each file as one transaction, and statement at a time for the three files Prisma 7.10 sends that way: 0479, 1426,
  1444), then `scripts/session-status-db-objects.sql` and a supplement (every index, constraint and trigger on
  `session`, every function naming the table and a status, the fact columns' types and defaults), and the bodies of
  the eight functions read with `pg_get_functiondef`. Background job `bgj_bccd5565131e`; the scripts and their output
  are kept with this plan's upload, not in the repository. Counts: 1 column of `run_status`, 12 triggers on `session`
  naming status, 6 indexes, 1 partial, 1 CHECK, no view, no generated column — as the note found.
- **Five read-only inventories** by sub-agents, each kept as a file with the upload: every statement that writes the
  column (§2.2); the runner protocol both ways, with the server's answers and the runner versions that read them
  differently (§3.2); every read that decides slots, claims, dispatch, reclaim and takeover, with the index DDL
  (§1.4, §4.5); the filters, the MCP enum and the watch leaves (§6); a row-by-row re-reading of note §7.1-7.2 and a
  sweep of all 1,043 product files for uses the note does not list (§2). Their citations used here were spot-checked
  at the lines above.

### 9.2 What it does not establish

1. **No production row was read.** The counts in §3.4 come from the fixture's notes (2026-11-21) and migration 1441's
   header (2026-11-22). C1, C2, C3 (`task_done`), C5, C6, C7, the B7 landing rows and any row rewritten by writer #16
   are not counted; the census of T16 counts them, and a kind it finds that §3.4 does not name stops deploy 2.
2. **No query plan.** The catalog database is empty, so §4.5 names candidate indexes and the queries to measure, not
   measurements.
3. **Nothing was built, written or run against the code**: no migration, spec or `tsc`. Lock waits, the trigger's
   write cost and the backfill's duration are unmeasured until T16.
4. **Deployed runners and apps** are read from their code and git tags (runner inventory; note §7.5), not run.
5. **The coverage sweep is textual.** A status read reached only by handing a whole row to a function with no status
   word or helper name nearby could be missed (the sweep's own limit). The guard (§5), `tsc` once the field leaves the
   model (D3), and the column-less PG spec (T15) are what close it.
6. **One-to-one turn states rest on the 25 writers of §2.2.** From the moment `session_turn_state_agrees_chk` is valid
   in production (D2), the database itself proves it for every row written.
7. **The replay used psql**, not `prisma migrate deploy`; it is good for catalog facts and nothing else.
8. **The client verdicts of note §7.4-7.5** were not re-checked; this plan sends them no new word, so they matter only
   for the kinds of §3.4.
