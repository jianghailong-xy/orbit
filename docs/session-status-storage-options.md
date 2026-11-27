# `session.status`: keep seven stored words, or store three

For the owner's decision (project 353SgnUjvamRr06Sho0EZ). Written 2026-11-25 against `9f94177875`.
No code was changed. It closes decision **D6** of [session-three-state-design.md](session-three-state-design.md),
which was deferred until after the wire and client stage; that stage is done.

**Recommendation: A, keep the seven stored words.** The reasoning is in §6.

## 1. What the question is, and what it is not

- Screens do not depend on it. Every session payload already carries `phase` (`PENDING`, `RUNNING`, `IDLE`)
  and the facts beside it (`contracts/session-state.contract.json`). This project's display work reads those.
- **A three-valued column would still not equal `phase`.** The stored word tracks the dispatched turn, which is
  what holds a runner slot. `phase` is also `RUNNING` for the engine's own turn, a sub-agent or a background job,
  while the stored word is `AWAITING_INPUT` (`sessions/session-phase.ts`, `deriveSessionPhase`). Under B such a
  row is stored `IDLE` and shown `RUNNING`.
- Most of B's columns exist already: released is `finished_at`, the last turn's result is `last_turn_outcome`,
  why an end was asked is `end_reason`, a landing container is `kind`. The server's release questions read
  these (`common/session-release.ts`), and the CHECK `session_release_fact_chk` holds the status to
  `finished_at`.

The three stored values of B:

| Today | B stores | Beside it |
|---|---|---|
| `PENDING` | `PENDING` | |
| `RUNNING` | `RUNNING` | |
| `AWAITING_INPUT`, `INTERRUPTED` | `IDLE` | `finished_at` null |
| `SUCCEEDED`, `FAILED`, `CANCELLED` | `IDLE` | `finished_at` set; `end_reason`, `last_turn_outcome`, `kind` |

B here means **storage only**. The server keeps sending `status`, `runStatus`, `runState` and `sessionState`
with the old words, rebuilt from the columns, because this project's instructions require it.

## 2. The seven words cannot all be rebuilt from the columns

This decides what B costs. The rows below have the same columns and different words. They come from
`common/session-release-shapes.fixture.ts` (49 shapes, grouped by released, `end_reason`, outcome and kind) and
from reading the writers. Production rows were **not** queried for this note.

| Case | Same columns as | Written today? |
|---|---|---|
| `INTERRUPTED` (repeated out-of-memory stop, the only writer: `managed-runner-manager.ts:2259`) | `AWAITING_INPUT` after a person's Stop (held, outcome `INTERRUPTED`); only the `error` text differs | yes |
| `FAILED`: an end asked for and not honoured | `CANCELLED`: an end honoured (same `end_reason`, same outcome) | yes |
| `FAILED`: source refused after an end was asked | `CANCELLED`: a turn that failed during an end | yes |
| `CANCELLED`: a landing that did not land | `SUCCEEDED`: a landing that landed; only `project_landing.settled_as` tells | yes |
| `FAILED`: a failed transcript import (in Trash) | legacy `SUCCEEDED` / `CANCELLED` rows with no reason and no outcome | yes |
| legacy `SUCCEEDED` with no end (318 rows in production when measured on 2026-11-21) | the import and legacy `CANCELLED` rows above | old rows |
| legacy `FAILED` rows with an end reason (migration 1262) | honoured ends | old rows |

So B must pick one of these:

- **B1. Accept that these rows change word.** An out-of-memory stop reads "Awaiting reply" instead of
  "Interrupted"; an unhonoured end reads "Ended" instead of "Failed"; the old `SUCCEEDED` rows read "Ended"
  unless backfilled. The landing case needs a join or a new column. This breaks "legacy fields unchanged" for
  those rows, and the golden specs `session-state-legacy-fields.golden.json` and
  `session-payloads-legacy.golden.json` would have to be restated.
- **B2. Add a column that remembers the difference.** If it holds the legacy word, the seven words are still
  stored, under another name; if it holds a failure cause, it reverses the owner's 2026-11-21 ruling (D9) that
  the session carries no failure fact.

## 3. Option A: keep the seven stored words

| For | Effect |
|---|---|
| Deployed Apple apps | Nothing changes, every build. |
| Deployed Android apps | Nothing changes, every build. |
| Deployed runners | Nothing changes, every version. |
| Server code | Nothing changes. The status stays a held-or-released summary beside `finished_at`, kept equal by `session_release_fact_chk`. |
| Migrations | None. |
| Size | Zero. |

What A leaves behind: two spellings of "released" (the status set and `finished_at`); new code can still decide
from a retired word, held back only by the guard spec's allow-list
(`sessions/session-terminal-status-readers.allowed.ts` and its spec); and the database, the API's `?status=`
filter and `orbit session list --status` keep speaking seven words while screens speak three.

## 4. Option B: store `PENDING`, `RUNNING`, `IDLE`

### 4.1 Deployed Apple and Android apps

With the wire words rebuilt (B as proposed), apps keep working, except that the rows of §2 change word under B1.
Newer builds already word those from the facts (Android from `v0.1.261-beta.83`, Apple from `beta.87`).

If the new word ever reached the wire, whether by a later decision or a projector that misses a path:

| Build (`v0.1.261-…`) | What happens on `IDLE` |
|---|---|
| Apple ≤ beta.64 | Strict enum: one row fails the whole decode. Session list, search, detail and control events show nothing new; macOS alerts stop. |
| Apple beta.65–86 | Lists decode. A released session is sent to `/turns` instead of `/resume`; macOS finished/failed alerts are never raised. |
| Android ≤ beta.64 | Lists decode. Without `capabilities`, choosing the send endpoint throws. |
| Android ≤ beta.82 | Finished/failed pushes are dropped; waiting for an end before a move times out. |
| Newest read (beta.95) | Still wrong: Merge/Commit offered while a parked session's sub-agents write; model/mode picks treat an ended session as live; the failed run's error card disappears. |

One server trap: `deriveSessionRunState` (`shared/src/enums.ts:130`) answers `ENDED` for any word it does not
know, and both apps trust `runState` first. The projector must be rewritten **before** the first `IDLE` is
stored, or every parked session reads "Ended" in every build.

No native client sends a status word back to the server.

### 4.2 Deployed runners

Runners read the word in answers, not in the database: reclaim and takeover rows, the turn-complete reply, and
`session list` / `session get`. With **every one of those paths** rebuilt from the columns, no runner changes.
If one path leaks `IDLE`:

- before `beta.65`, reclaim reads it as closed, so the session is not supervised after a restart;
- on any version, a terminal answer replaced by `IDLE` parks the run instead of ending it, and on the
  failed-turn and region-stop paths the run is finalized `FAILED` (`runner-go/session.go:1695-1775`);
- `session import` waits until its timeout; `--status` and the MCP enum refuse the word.

Runners keep **sending** `SUCCEEDED`, `FAILED`, `INTERRUPTED` and `CANCELLED` on turn-complete and finalize, so
the server needs the seven-word type for the protocol whatever is stored. The `--status` filter must also be
translated from a word into column conditions.

### 4.3 The server's code and migrations

Code, from the tables of §7 (one row is roughly one file; some files have two):

| Verdict | apiserver rows outside projects/tasks | projects, tasks, shared |
|---|---|---|
| Writes a retired word, must write facts | 6 | 4 |
| Reads a retired word, must read facts | 27 | 20 |
| Puts the legacy word on a payload, must use a projector | 21 | 14 |
| Unchanged | 31 | 8 |

The risk is not the count. `IDLE` also covers released rows, so every filter that today means "parked" by
listing `AWAITING_INPUT` / `INTERRUPTED` needs `finished_at IS NULL` beside it, and every `notIn` of the open
set stops meaning "released". Missing one counts finished sessions as live: slots, task claims, dispatch.

Database objects (read from a PostgreSQL 16 with all 681 migrations applied,
`scripts/session-status-db-objects.sql`):

- the enum `run_status` (8 labels, `PARKED` already dead) and the column's default;
- CHECK `session_release_fact_chk`, which would have to be dropped: `IDLE` is both held and released;
- 6 indexes on `status` (`session_status_idx`, four composite ones, the partial
  `session_over_capacity_pending_idx`); the planner reads some of them through the held-status list
  (`sessionHeldIndexedSql`), whose replacement has to be measured;
- 12 triggers on `session` that list or test `status`; 3 of their `WHEN` clauses name `INTERRUPTED` or
  `AWAITING_INPUT`;
- 8 functions that name a status word, among them `session_listed_at_on_settle` (terminal words) and
  `session_request_recipient_ended` (writes the word into `session_request.close_reason`);
- no views and no materialized views.

Migration order, with a hand-over between server replicas at each deploy:

1. Add the label `IDLE`; ship a server that reads both spellings and projects the wire words. An older replica's
   Prisma client cannot decode `IDLE`, so nothing writes it yet.
2. Writers write `IDLE`; restate the triggers, functions and CHECK. From here a rollback past deploy 1 is not
   possible.
3. Backfill the five retired words to `IDLE` in batches on the `session` table; apply B1 or B2.
4. Old labels: PostgreSQL cannot drop an enum label. Removing them means rewriting the column's type under an
   exclusive lock; otherwise five dead labels stay beside `PARKED`.

Also to restate: the watch leaves `SESSION_RUN_TERMINAL` / `SESSION_TURN_SETTLED`, the drill and audit scripts
that read the words in SQL, and the Mac app's one locally built row
(`SessionProjectListSupport.swift:12`, `.running` / `.awaitingInput`), which needs no change while the wire is
unchanged.

**Size (estimate, not measured):** XL. A migration plan plus about 5 to 8 tasks across at least three deploys,
with a production-copy rehearsal for the backfill and the indexes. No client or runner release is required for
B itself.

## 5. Side by side

| | A: seven words | B: three values, wire unchanged |
|---|---|---|
| Apple / Android apps | unchanged | unchanged except the §2 rows (B1) |
| Runners | unchanged | unchanged if every answer path is projected |
| Server code | none | about 90 table rows to change |
| Migrations | none | enum, CHECK, triggers, functions, backfill; three deploys |
| Rollback | n/a | not past the first `IDLE` write without a lossy reverse mapping |
| What a person sees | `phase` | `phase`, the same |

## 6. Recommendation

**Keep the seven stored words (A).** The thing the owner noticed, seven states on screen, is fixed by the
display work, which reads `phase` and does not touch storage; B changes nothing anyone sees. The meanings B
wants in columns are already in columns and the server's release rules already read them, so what is left of the
status is a compatibility word that the database holds consistent with `finished_at`. Replacing it would rewrite
about 90 places and the triggers around the claim and slot rules, over three deploys that cannot be rolled back
freely; it still could not drop the seven words, because deployed runners and apps send or read them; some rows
would change word unless the same information is stored again under another name; and the new column still would
not equal `phase`. Revisit only if there is a minimum supported app and runner version, so that the wire words
can be retired too; until then B pays the full cost for none of the simplification.

If B is chosen anyway: take B1, keep the wire words, and file the storage work as its own tasks with the
four-step migration order above.

## 7. Readers and writers

How this list was made: five read-only passes over the tree at `9f94177875` by `git grep` and reading each site,
plus the catalog query above for the database. Nothing was built or run, line numbers may be approximate in the
large files, and a row passed whole into a function without any status word nearby could be missed. A mechanical
check of files matching the state vocabulary against these tables found only comments and same-named fields of
other things (project queue, schedule run, workflow and task `runState`) outside them, and one local writer,
listed in 7.5. **Not verified:** which app builds and runner versions people actually run, any behaviour on an
old build (read from the code of that tag, spot-checked), and production row counts (the one given is from the
earlier design document). The earlier inventory
[session-three-state-read-sites.md](session-three-state-read-sites.md) describes an older tree.

**The last column's premise differs by table.** In 7.1 and 7.2 it says what the server file needs if the
**column** stores three values. In 7.3 to 7.5 it says what the program does if the **wire** words changed, which
B as proposed does not do.

### 7.1 apiserver, outside projects/, tasks/, task-lists/

HEAD 9f94177875. Paths are under src/apiserver/src/. Specs, fixtures, goldens, e2e/it files and test-support are excluded.

Tags: when a file mixes kinds, the tag is the heaviest change it needs (REWRITE-W > PROJECT > REWRITE-R > SAME); extra tags follow with `+`. "idle words" means AWAITING_INPUT/INTERRUPTED; "released words" means SUCCEEDED/FAILED/CANCELLED. `finished_at` filters are mentioned only where they sit beside a status read.

| File (path under src/) | Lines | R/W | Which words/field and what for (max ~25 words) | Under B |
|---|---|---|---|---|
| common/session-release.ts | 21-47, 66-67, 94, 105, 163-169, 248-255 | R | Held/released word sets and helpers; indexed SQL IN list; INTERRUPTED in runIsOver; PENDING in isHeldPastClaim; select includes status | REWRITE-R |
| common/session-scheduling.ts | 10-13, 28, 102-116 | R+W | OPEN = held set; UNSETTLED; AWAITING/INTERRUPTED→PENDING on enqueue; computes RUNNING/AWAITING_INPUT after turn; RUNNING offline-fatal | REWRITE-W |
| common/session-generating.ts | 22-34 | R | AWAITING_INPUT + engine_turn_active means generating (TS and Prisma filter) | REWRITE-R |
| common/session-working.ts | 36, 64-73, 139, 149, 154, 170 | R | RUNNING = dispatched turn; OPEN set gates background facts (not finished_at) | REWRITE-R |
| common/session-tree-sql.ts | 35, 39, 72, 90, 104 | R | RUNNING/PENDING counts; line 90 IN PENDING/AWAITING/INTERRUPTED, with no finished_at condition | REWRITE-R |
| common/runner-drain-waiting.ts | 21-23, 31 | R | PENDING counts; held-indexed helper | SAME |
| common/session-inbox-fence.ts | 131 | R | sessionReleasedSql only (finished_at) | SAME |
| help/help-ask-marker.ts | 54-58 | R | PENDING/RUNNING = working; generating helper | SAME |
| help/help-ask.ts | 51, 174 | R | Selects status to feed helpAskOutcome / generating | SAME |
| help/help-ask-reads.ts | 147, 157-158 | WIRE+R | Raw status word to help model; `paused` = INTERRUPTED | PROJECT + REWRITE-R |
| link-previews/link-previews.service.ts | 155-158, 271-307, 330 | WIRE | status, runStatus, runState, sessionState on preview cards; task lastRun status + derived runState from raw row (SQL 280) | PROJECT |
| managed-runners/managed-runner-manager.ts | 2255-2267 | R+W | OOM stop: RUNNING → INTERRUPTED, last_turn_outcome INTERRUPTED. Only writer of INTERRUPTED | REWRITE-W |
| managed-runners/managed-runner.service.ts | 460, 464 | R | RUNNING running turns; heldStatusFilter() for shells | REWRITE-R |
| managed-runners/managed-runner-work.ts | 61-62, 68, 74 | R | RUNNING/PENDING SQL; executing helpers | SAME |
| metrics/fleet-metrics.ts | 85-93 | R | PENDING/RUNNING; `<> PENDING` over task carriers | SAME |
| providers/active-sessions.ts | 43, 46 | R | PENDING/RUNNING; AWAITING_INPUT/INTERRUPTED recent (no finished_at beside it) | REWRITE-R |
| providers/account-move-capability.ts | 63, 66 | R | Passes status to isSessionGenerating | SAME |
| providers/account-health.service.ts | 450, 465 | R | Trial session RUNNING | SAME |
| providers/providers.service.ts, providers/shared-pools.service.ts | 1402; 625 | R | GENERATING_SESSION_FILTER only | SAME |
| push/push.service.ts | 148-175, 349, 354, 1739-1800 | R | AWAITING_INPUT + engine turn card sessions; RUNNING needs-you; generating helper | REWRITE-R |
| push/settle-alert.ts | 74 | R | Release facts only; no status word | SAME |
| queue/queue.service.ts | 492, 532, 703-730, 763, 780, 812-814, 1251 | R+W | Claim PENDING→RUNNING; refusal RUNNING→PENDING; RUNNING counts | SAME |
| queue/dispatch-pause.service.ts | 40, 112, 123 | R | held-indexed helper (word list lives in session-release.ts); PENDING | SAME |
| realtime/realtime.service.ts | 253-282, 1256-1269 | WIRE | endedSessionStates; session.ended payload status, runStatus, sessionState, runState | PROJECT |
| realtime/realtime.service.ts | 1720-1750 | WIRE | Re-reads runStatus/status from control event, re-derives legacy states | PROJECT |
| realtime/realtime.service.ts | 1783, 1894-1923 | WIRE | Session summary payload: status, runStatus, sessionState, runState | PROJECT |
| realtime/realtime.service.ts | 2129-2130, 2161-2163, 2256, 2271, 2300-2314 | R | Merge/commit claims: OPEN, notIn OPEN (= released), AWAITING_INPUT | REWRITE-R |
| realtime/reaper.service.ts | 208-215, 551-578, 613-644, 715-778, 1024-1085, 1077, 1160-1164, 1227 | R+W+WIRE | Writes released words (default FAILED; CANCELLED/graceful); reads PENDING/RUNNING/AWAITING_INPUT, LIVE set; STATUS event carries word | REWRITE-W + PROJECT |
| realtime/parked-session-end.ts | 41, 105-107, 138 | R+WIRE | AWAITING_INPUT guards end claim; passes AWAITING_INPUT into session.ended event | REWRITE-R + PROJECT |
| realtime/lost-runner-work.ts | 70, 106, 117-121 | R | OPEN set membership; slot/executing helpers | REWRITE-R |
| runner-api/runner-api.controller.ts (writes) | 4465-4490, 6152-6203, 7686-7688, 7764-7779, 8332-8337, 8396-8400, 10438-10444, 10566-10569, 10927-10930, 11022-11049 | R+W | All runner-driven transitions; see Notes 1 | REWRITE-W |
| runner-api/runner-api.controller.ts (reads) | 1143-1178, 1575, 7494, 7610, 7710-7732, 7800-8175, 8262, 8460, 8536-8547, 8657, 8806, 8886, 8973, 10413, 10460-10473, 10721-10797, 11608, 11622 | R | LIVE/TERMINAL sets; runner-reported dto.status words; AWAITING_INPUT gates; effectiveStatus SUCCEEDED/FAILED task effects | REWRITE-R |
| runner-api/runner-api.controller.ts (wire) | 4900, 5365, 5468, 7577-7745, 8029, 8515, 8938, 8951-8955, 10878-10880 | WIRE | status to runner (claim/reclaim/lease answers, turn-complete reply) and STATUS events (FAILED / effective word). Runner protocol | PROJECT |
| runner-api/runner-api.controller.ts (PENDING/RUNNING only) | 4667, 4746, 4783, 6092, 6296, 6423 | R | PENDING/RUNNING gates | SAME |
| runner-api/turn-outcome.ts | 48-62 | R | Maps runner-reported FAILED/INTERRUPTED/CANCELLED/SUCCEEDED to turn outcome (input is dto word, not the column) | REWRITE-R (protocol) |
| runner-api/runner-link-hints.ts | 94, 104, 113-120 | R | IN RUNNING/AWAITING/INTERRUPTED (line 94 has no finished_at); AWAITING + engine turn | REWRITE-R |
| runner-api/link-heartbeat.ts, runner-api/runner-link-welcome.ts | 535, 831; 109 | R | sessionHeldSql (finished_at) only | SAME |
| runner-api/background-job-stops.ts | 16 | R | status IN OPEN set | REWRITE-R |
| runner-api/runner-orchestration-authorizer.ts | 143 | R | status IN OPEN set | REWRITE-R |
| runner-api/runner-sessions.controller.ts | 311 | R | `?status=` filter accepts any RunStatus word | REWRITE-R (API input) |
| runner-api/runner-subagents.controller.ts | 129, 304-308 | R | Selects status for sessionHasEnded (runIsOver reads INTERRUPTED) | REWRITE-R (via helper) |
| runner-api/scheduled-wakeup.ts | 321-331 | R | Release facts + sessionHasEnded | SAME (helper changes) |
| runner-api/scheduled-wakeup.worker.ts | 117, 285, 422, 478, 528 | R | RUNNING; executing helpers; release facts | SAME |
| runner-api/subagent-wake.ts, background-job-wake.ts, subagent-remote.ts | 196; 179 (re-export); 672 | R | sessionHasEnded / sessionReleasedSql; their INTERRUPTED literals are subagent-run status | SAME (helper changes) |
| runners/runners.service.ts | 363 | R | RUNNING turns of draining runners | SAME |
| runners/runners.service.ts | 636, 1720 | WIRE | Raw status on checkout list and account-removal session list | PROJECT |
| runners/claude-account-swap.ts | 278, 301 | R | RETURNING status; skips PENDING | SAME |
| runners/claude-account-swap.ts | 368 | WIRE | Raw status in swap `waitingOn` | PROJECT |
| runners/attention-fix.ts | 276 | WIRE | Released session's word as `handled[].status` | PROJECT |
| runners/runner-background-holders.ts | 79 | R | ACTIVE_TURN (RUNNING) set | SAME |
| runners/runner-executing-sets.ts | 171 | R | sessionHeldSql only | SAME |
| schedules/schedule-runs.service.ts | 745, 787, 794, 933, 1765 | R | PENDING/RUNNING; INTERRUPTED = failed landing; AWAITING_INPUT required to land | REWRITE-R |
| schedules/schedule-runs.service.ts | 227, 676, 693 | R | Release facts / capacity helper | SAME |
| session-guests/session-guests.service.ts | 261, 277, 282 | R+W | PENDING with nothing executable → AWAITING_INPUT | REWRITE-W |
| session-guests/session-guests.service.ts | 322, 333-339 | WIRE | Shared-with-me row: status, sessionState | PROJECT |
| sessions/session-state.ts | 24, 106-124 | WIRE | withSessionState: runStatus, sessionState, runState derived from stored word. The central projector | PROJECT |
| sessions/session-phase.ts | 67-83, 109, 173 | R | Phase RUNNING/PENDING/IDLE; only PENDING literal (execution via helpers) | SAME |
| sessions/sessions.service.ts (writes) | 1879, 2439, 8140-8144, 8416-8418, 8748-8752, 9278-9281, 10657, 11884 | R+W | PENDING creates/revive; enqueue transition; PENDING→AWAITING_INPUT; queued end→CANCELLED | REWRITE-W |
| sessions/sessions.service.ts (wire) | 2064, 2477, 3012-3015, 3331-3334, 3396, 3523, 4002-4005, 4740, 5249-5251, 5700, 5722, 5780-5785, 5840-5862, 6090-6103, 10556, 10619, 10719, 11274, 11323, 12087, 12157, 13110, 13134 | WIRE | Create/list/detail/search payloads, legacy fields, landing-only detail, error `sessionStatus`, session.ended events, open-list token | PROJECT |
| sessions/sessions.service.ts (idle/released reads) | 3362, 6011, 7145, 7666, 9819, 10227, 10258-10260, 10290 | R | `status` list filter; AWAITING_INPUT retry arm, account move, merge deferral, commit gate; notIn LIVE = released | REWRITE-R |
| sessions/sessions.service.ts (PENDING/RUNNING only) | 2873-2879, 4065, 4647, 4746, 4999, 5202-5216, 5839, 5884-5895, 8194-8195, 8423-8427, 8705, 9045, 9271, 10651, 12543, 13500 | R | Counts, turn timing, over-limit, queued/running checks | SAME |
| sessions/auto-retry.service.ts | 243, 326, 1156, 1951 | R | AWAITING_INPUT (or release-failure) = parked | REWRITE-R |
| sessions/auto-retry.service.ts | 391-989 (rearm args), 1633-1843, 1962 | R | Remembers parked word (`parkedAs`, AWAITING_INPUT or FAILED) and compares it under lock | REWRITE-R |
| sessions/auto-retry.service.ts | 2009-2014 | WIRE | STATUS event with stored word of released failure | PROJECT |
| sessions/auto-retry-eligibility.ts | 70, 82 | R | AWAITING_INPUT or release-failure (Prisma + SQL) | REWRITE-R |
| sessions/session-request.ts | 1051 | R | AWAITING_INPUT + no cancel = parked | REWRITE-R |
| sessions/session-request.ts | 1120-1128 | R+W | deriveSessionState word persisted as session_request.close_reason | PROJECT |
| sessions/session-move.ts | 128, 133, 150 | R | PENDING; AWAITING_INPUT retry armed | REWRITE-R |
| sessions/task-work-carrier.ts | 96-97, 130-131, 172-184, 223, 260 | R+WIRE | Carrier = PENDING/RUNNING/AWAITING+wake source (INTERRUPTED excluded); passes status | REWRITE-R |
| sessions/abandoned-approvals.ts | 432-443 | R | Generating helper only | SAME (helper changes) |
| sessions/queued-gate.ts, queued-reason-sql.ts, run-now.ts | 70; 81, 129; 61-91 | R | PENDING only | SAME |
| sessions/sessions.controller.ts | 381 | R | `?status=` accepts any RunStatus word | REWRITE-R (API input) |
| share-links/public-task.ts | 140, 231-235 | WIRE | Public run `state` = runState; QUEUED/RUNNING = live | PROJECT |
| share-links/share-links.service.ts | 710-714 | WIRE | Shared header `status` | PROJECT |
| watches/watch-predicate.ts | 328, 335, 342 | R | UNSETTLED (PENDING/RUNNING); runIsOver reads INTERRUPTED | REWRITE-R (via helper) |
| watches/watch-predicate.ts | 486-491 | WIRE | Observation stores status and runState | PROJECT |
| watches/watch-redaction.ts | 70-86 | WIRE | Passes observed status/runState words | PROJECT |
| watches/watch-evaluator.service.ts | 725 | R | Loads status::text into facts | SAME (value passed on) |
| watches/watches.service.ts | 463, 797 | R | Carrier helper; status into predicate fact | SAME |
| watches/watches.service.ts | 475-482 | WIRE | targetStatus = runState word; running/queued flags | PROJECT |
| watches/watch-delivery.service.ts | 785-788 | R+WIRE | sessionHasEnded; runState word written into refusal sentence | PROJECT |
| wiki/wiki-maintenance.ts | 257, 335 | R | status NOT IN (PENDING, RUNNING) | SAME |
| wiki/wiki-dossier.ts | 272, 1939 | WIRE | `status <word>` in dossier header text for the model | PROJECT |
| wiki/wiki-chat.ts | 49, 176, 233 | R | PENDING / generating | SAME |
| wiki/wiki.service.ts, workspaces/main-checkout.service.ts, owner-requests/owner-secrets.service.ts | 5326; 519; none | R | Generating filter / isHeldPastClaim only; owner-secrets `LIVE` reads no session status | SAME |

### 7.2 apiserver projects/, tasks/, task-lists/, and shared

Paths are under `src/`. `P/` = `apiserver/src/projects/`, `T/` = `apiserver/src/tasks/`, `L/` = `apiserver/src/task-lists/`, `S/` = `shared/src/`.
"Held set" = PENDING, RUNNING, AWAITING_INPUT, INTERRUPTED. Where a file has several kinds of site, the row takes the heaviest one (REWRITE-W > REWRITE-R > PROJECT > SAME) and says which lines are which.

| File (path under src/) | Lines | R/W | Which words/field and what for (max ~25 words) | Under B |
|---|---|---|---|---|
| P/landing-session.ts | 69-74, 269, 285, 396 | W | Writes AWAITING_INPUT (open), SUCCEEDED / CANCELLED (settled) on LANDING container rows | REWRITE-W |
| P/session-source.ts | 704, 706 | R+W | CAS on held set; writes FAILED when runner refuses source (already writes finishedAt, lastTurnOutcome FAILED) | REWRITE-W |
| P/attempt-ended-unsettled.producer.ts | 67, 88, 257, 282, 141, 154, 187, 290, 390, 462-464 | R+WIRE | Raw word into wake fact, signal, human comment ("terminal state X"). Decisions already use finishedAt | PROJECT |
| P/task-exception-input.producer.ts | 41, 102, 105, 126 | R+WIRE | Raw SQL `status::text` of released run into wake fact detail `sessionStatus` | PROJECT |
| P/coordinator-wake.ts | 363, 375 | WIRE | `sessionStatus` pass-through in ATTEMPT_ENDED_UNSETTLED detail | PROJECT |
| P/coordinator-evidence-queue.service.ts | 76 | R | Idle coordinator = status in AWAITING_INPUT, INTERRUPTED; **no finishedAt filter** | REWRITE-R |
| P/pending-addressees.ts | 168, 180, 323-325 | R | Coordinator busy unless AWAITING_INPUT/INTERRUPTED (180); ended-run filter via helper (323-325) | REWRITE-R |
| P/task-run-idle.ts | 57, 71, 94, 106 | R | Idle task run = AWAITING_INPUT (excludes INTERRUPTED); no finishedAt filter in query | REWRITE-R |
| P/task-run-stopped.producer.ts | 118, 129, 145, 152 | R | Stopped/idle fact only for AWAITING_INPUT runs | REWRITE-R |
| P/open-item-escalation.service.ts | 226, 256 | R | Raw SQL `status <> 'INTERRUPTED' OR end_reason IS NULL`: live fix run / coordinator | REWRITE-R |
| P/projects.service.ts | 529, 724-725, 869, 907-908, 6409-6414 | R+WIRE | AWAITING_INPUT + subagents = working (725, REWRITE); coordinator status emits runStatus/runState (907, 6413); selects 529, 869 | REWRITE-R |
| P/criterion-move.ts | 70, 90, 275-276, 335 | R | Live runs = held set (`status IN`, no finishedAt) block a criterion move | REWRITE-R |
| P/live-session-status.ts | 12-15 | R | Held-set helper `isLiveSessionStatus`; no importer found (dead) | REWRITE-R |
| P/project-open-item.ts | 800-810, 813, 828, 875-882, 1151, 1509, 1742, 1872, 2382 | R | `SESSION_ENDING_SELECT` selects status; `sessionHasEnded` → common `runIsOver` reads INTERRUPTED (helper outside scope) | SAME |
| P/project-ready-to-run.ts | 222-236 (+234, 337 helper) | R | Raw SQL: PENDING→QUEUED else RUNNING; RUNNING sorts first. Its `runState` is a task field, not the session one | SAME |
| P/project-done-request.ts | 227, 237, 240 | R | PENDING / RUNNING runs → task queued / running | SAME |
| P/coordinator-fact-queue.service.ts | 47-50 | R | heldFilter + status notIn PENDING, RUNNING = idle held | SAME |
| P/project-tasks-settled.producer.ts | 168 | R | Same as above | SAME |
| T/tasks.service.ts (retired-word reads) | 3912, 3927-3934, 15217, 15257-15258, 15276-15277, 15595-15601, 15661 | R | 15661 raw `IN ('AWAITING_INPUT','INTERRUPTED')` = paused run to resume (no finishedAt); 15257/15276 SessionsService.LIVE; 3912 error text names SUCCEEDED/FAILED/CANCELLED/INTERRUPTED | REWRITE-R |
| T/tasks.service.ts (held set) | 13919, 14087, 17316 | R | `status IN TASK_OCCUPYING`: reach check, delete stops runs, batchStop | REWRITE-R |
| T/tasks.service.ts (replacement) | 12052 | R | Selects status for `replacementOf` (needs FAILED) | REWRITE-R |
| T/tasks.service.ts (wire) | 865, 1517, 9726, 9747, 9813-9817, 9943, 12028, 13485, 14324, 14336, 14843, 14896-14900, 15295 | R+WIRE | Task detail runs via withSessionState; autoRunSkipped.sessionStatus; 409 holder status (fallback RUNNING); logs/ledger text | PROJECT |
| T/tasks.service.ts (PENDING/RUNNING) | 8351, 8460, 8465-8466, 8606, 12534, 12540, 15258, 15277 | R | Relation filters `sessions.some.status`, slot budget raw SQL `IN ('RUNNING','PENDING')` | SAME |
| T/reclaim-stalled-task.ts | 16, 48 | R | Defines TASK_OCCUPYING (held set); occupied count before reopening task | REWRITE-R |
| T/verification-dependency.ts | 135, 180 | R | `TASK_OCCUPYING.includes(runStatus)` = check still live (383/423/429 already release column) | REWRITE-R |
| T/verification-liveness.ts | 73, 79 | R | Held set = live run (73); `!== PENDING` = ever ran (79, SAME) | REWRITE-R |
| T/verification-epoch-read.ts | 88, 96 | R+WIRE | Selects status into `runStatus` fact for the two rows above (goes away with them) | REWRITE-R |
| T/refused-run-replacement.ts | 26, 50 | R | `status !== 'FAILED'` → no replacement | REWRITE-R |
| T/evidence-review.service.ts | 107 | R | Idle creator session = AWAITING_INPUT, INTERRUPTED; **no finishedAt filter** | REWRITE-R |
| T/owner-confirmation-if-confirmed.ts | 272 | R | `status IN TASK_OCCUPYING`: other live runs of task | REWRITE-R |
| T/reference-expansion.ts | 167, 176 | R | Last run's raw word written into agent prompt text | PROJECT |
| T/task-run-receipt.ts | 462, 476, 490, 522, 545 | WIRE | `conflictingSessionStatus` in 409 bodies and message | PROJECT |
| T/task-route-decision.ts | 416, 443 | R+WIRE | Raw status into ModelRoutingRun (stored route input); failure already from release facts | PROJECT |
| T/model-routing.ts | 305 | WIRE | `ModelRoutingRun.status: string`; no reader of it found | PROJECT |
| T/task-retry-policy.ts | 62, 72 | R | `sessionStatus == null` only means row purged | SAME |
| L/task-lists.service.ts | 515, 858 (151, 219, 582 helper) | R | `status IN TASK_OCCUPYING`: re-stamp batch cap; stop list runs | REWRITE-R |
| S/enums.ts (enum) | 5-15 | WIRE | RunStatus definition, mirrors Prisma enum | REWRITE-W |
| S/enums.ts (derivers) | 51-62, 77-86, 121-157, 188-228 | R | deriveSessionRunState / deriveSessionState read all seven words + endReason; produce runState/sessionState. This is the projector to replace | REWRITE-R |
| S/enums.ts (gracefulEndStatus) | 238-245 | W | Returns SUCCEEDED / CANCELLED that finalize and reaper write (callers outside scope) | REWRITE-W |
| S/dto.ts (search hit) | 4597-4604, 4624-4625 | WIRE | SessionSearchHit status, runStatus, sessionState, runState | PROJECT |
| S/dto.ts (other session status) | 2920, 4018, 4036, 4051 | WIRE | RunnerAccountRemoveSession.status (client); takeover/reclaim status read by runner | PROJECT |
| S/dto.ts (runner verdicts) | 4140, 4341 | WIRE | TurnComplete/Finalize request `status: RunStatus`: runner→server verdict, not the column | SAME |
| S/realtime.ts | 243-250, 426-433 | WIRE | status, runStatus, sessionState, runState on session summary and session.ended | PROJECT |
| S/link-preview.ts | 69-72, 106-107 | WIRE | status, runStatus, runState, sessionState on session card; status, runState on task's newest run | PROJECT |
| S/session-guests.ts | 39-40 | WIRE | Guest list status, sessionState | PROJECT |
| S/watch.ts | 209-211, 278-279 | WIRE | Watch observed status/runState; target standing = SessionRunState word | PROJECT |

### 7.3 Runner, link gateway, drive mount, scripts, contracts

HEAD 9f94177875. Non-test files. "If wire words changed" assumes option B (IDLE replaces AWAITING_INPUT/INTERRUPTED/SUCCEEDED/FAILED/CANCELLED); for scripts it also covers the stored DB words. S/R rows in scripts/ are drills and audits, not production paths.

| File | Lines | R/W | Which words/field and what for | If the server's wire words changed |
|---|---|---|---|---|
| src/runner-go/types.go | 1907,1971,2032-2038,2089,2271-2278 | WIRE | ReclaimSession.status; TurnComplete request/response status, sessionStatus; RunFinalizeRequest.status; the seven constants (no PARKED, no IDLE). | See rows below |
| src/runner-go/transport.go | 745-751,806,840,861-896,904-924 | R/W | Reads takeover(-batch) status; sends turn-complete; reads status/sessionStatus, empty ⇒ AWAITING_INPUT. finalizeRun (610) sends status; reads only keepCheckout. | OK (pass-through; consumers below) |
| src/runner-go/runloop.go | 689-725,776-795,976,1062-1070,1133-1143,3275-3276 | R | Reclaim/takeover status: RUNNING or "" takes permit; seven words open/closed; unknown open iff lease held; start-order tiers. | OK for IDLE since beta.65. BREAKS older: unknown ⇒ not supervised. Renaming RUNNING/PENDING would break |
| src/runner-go/reclaim_starter.go | 276-288,527 | R | Idle takeover answer: open? active? Snapshot row ended (SUCCEEDED/FAILED/CANCELLED) ⇒ give up. | OK; a new word for an ended row is dropped only when takeover is refused |
| src/runner-go/session.go | 658-665,712,1415-1417,1524-1536 | R | Turn-complete answer: SUCCEEDED/FAILED/CANCELLED ⇒ stop engine/end run; RUNNING ⇒ keep permit; anything else ⇒ park. | AWAITING_INPUT/INTERRUPTED→IDLE OK. BREAKS: terminal word→IDLE parks instead of ending the run |
| src/runner-go/session.go | 1695-1739,1763-1775 | R | Failed-turn ack must be terminal; region refusal/stop also accepts PENDING/AWAITING_INPUT as "held in queue". | BREAKS: IDLE ⇒ "non-terminal status" error, run finalized FAILED (region hold lost) |
| src/runner-go/session.go | 728,1280,1317,1521-1629,1722-1865,1905-1965; also 2086-3414 | W | Sends turn outcome (SUCCEEDED/FAILED/INTERRUPTED) and finalize status SUCCEEDED/FAILED/CANCELLED; branches on its own local values. | OK (outbound) |
| src/runner-go/session_release.go | 76,100,131-146 | R/W | Answer RUNNING to a declared failed turn = held. Release body strips status; sends cutOffTurnOutcome FAILED. | OK while a hold still answers RUNNING; any other word reads as "no hold" |
| src/runner-go/worktree.go | 1106,1131 | R | Local run status CANCELLED ⇒ undoable park checkpoint, else permanent commit. | n/a (local value) |
| src/runner-go/antigravity.go | 588,590,1063,1067,1069,1078 … 1404 (22 lines) | W | Builds turn-complete status / process-end status: SUCCEEDED/FAILED/INTERRUPTED/CANCELLED. | OK (outbound; only if server still accepts these inbound words) |
| src/runner-go/claude.go | 244,445,447,449 | W | Builds turn-complete status / process-end status: SUCCEEDED/FAILED/CANCELLED. | OK (outbound; only if server still accepts these inbound words) |
| src/runner-go/claude_delivery.go | 384,403,424,471,476,507 | W | Builds turn-complete status / process-end status: SUCCEEDED/FAILED. | OK (outbound; only if server still accepts these inbound words) |
| src/runner-go/claude_setconfig.go | 307 | W | Builds turn-complete status / process-end status: SUCCEEDED. | OK (outbound; only if server still accepts these inbound words) |
| src/runner-go/claude_withdraw.go | 119 | W | Builds turn-complete status / process-end status: SUCCEEDED. | OK (outbound; only if server still accepts these inbound words) |
| src/runner-go/codex.go | 51,85,171,183,237,246 … 726 (21 lines) | W | Builds turn-complete status / process-end status: SUCCEEDED/FAILED/CANCELLED. | OK (outbound; only if server still accepts these inbound words) |
| src/runner-go/codex_appserver.go | 190,193,212,297,319,322 … 2363 (31 lines) | W | Builds turn-complete status / process-end status: SUCCEEDED/FAILED/INTERRUPTED/CANCELLED. | OK (outbound; only if server still accepts these inbound words) |
| src/runner-go/cursor_acp.go | 1107,1338,1351,1441,1446,1472 … 1587 (11 lines) | W | Builds turn-complete status / process-end status: SUCCEEDED/FAILED/INTERRUPTED/CANCELLED. | OK (outbound; only if server still accepts these inbound words) |
| src/runner-go/cursor_events.go | 472,476,478,482,484,506 … 552 (8 lines) | W | Builds turn-complete status / process-end status: SUCCEEDED/FAILED/INTERRUPTED. | OK (outbound; only if server still accepts these inbound words) |
| src/runner-go/cursor_usage.go | 320,322 | W | Tests own outgoing turn outcome (SUCCEEDED/FAILED) for quota bookkeeping. | OK (outbound; only if server still accepts these inbound words) |
| src/runner-go/dsh_acp.go | 539,752,776,876,881,904 … 1014 (15 lines) | W | Builds turn-complete status / process-end status: SUCCEEDED/FAILED/INTERRUPTED/CANCELLED. | OK (outbound; only if server still accepts these inbound words) |
| src/runner-go/dsh_events.go | 255,260,265,267,269,271 … 279 (8 lines) | W | Builds turn-complete status / process-end status: SUCCEEDED/FAILED/INTERRUPTED. | OK (outbound; only if server still accepts these inbound words) |
| src/runner-go/engine_failure.go | 146 | W | Tests own turn outcome FAILED before attaching the failure class. | OK (outbound; only if server still accepts these inbound words) |
| src/runner-go/kimi_acp.go | 1710,1714,1720,1724,1738,1744 … 2260 (32 lines) | W | Builds turn-complete status / process-end status: SUCCEEDED/FAILED/INTERRUPTED/CANCELLED. | OK (outbound; only if server still accepts these inbound words) |
| src/runner-go/opencode.go | 224,235,268,271,278,314 … 648 (19 lines) | W | Builds turn-complete status / process-end status: SUCCEEDED/FAILED/INTERRUPTED/CANCELLED. | OK (outbound; only if server still accepts these inbound words) |
| src/runner-go/shell.go | 351 | W | Builds turn-complete status / process-end status: SUCCEEDED. | OK (outbound; only if server still accepts these inbound words) |
| src/runner-go/mcp.go | 3480-3499 | R | sessionSettled(status from session get): PENDING/RUNNING/"" not settled; every other word settled. | OK (IDLE = settled) |
| src/runner-go/mcp.go | 1801-1855 | WIRE | session_list/search/get pass server JSON through to the agent (list takes status filter, 3529). | OK (agents see new word) |
| src/runner-go/session_wait.go | 141,165,196,384-390 | R | session_create(wait) reads body .status through sessionSettled. (session_await itself uses a server watch.) | OK |
| src/runner-go/session_cli.go | 1323-1331 | R | CLI create --wait polls .status through sessionSettled. | OK |
| src/runner-go/session_cli.go | 819-830 | R | session import wait: FAILED/CANCELLED/INTERRUPTED ⇒ "import failed". | BREAKS: IDLE ⇒ failure unnoticed, ends in timeout (unless events were stored) |
| src/runner-go/session_cli.go | 157,575-590,845-868 | W | --status validator and help: seven words minus PARKED; value sent as ?status= filter. | BREAKS: --status IDLE refused client-side; old words depend on server still accepting them |
| src/runner-go/session_cli.go | 164-175,448,931 | WIRE | session get prints server JSON; help names status, phase, released, lastTurnOutcome, waitingOn. | OK (help text "status and its values are unchanged" goes stale) |
| src/runner-go/operation_catalog.go | 39,2895,2958,2970,4244 | WIRE | session_list MCP schema enum of seven words; note on status vs phase/released; CLI catalog usage. | BREAKS: strict MCP clients reject status=IDLE; docs stale |
| src/runner-go/mcp_help_ask.go | 28 | WIRE | help_sessions description lists PENDING, RUNNING, AWAITING_INPUT, INTERRUPTED, COMPLETED, FAILED. | OK (text only, stale) |
| src/runner-go/watch_tools.go | 278-300 | WIRE | Predicate descriptions: settled = not PENDING/RUNNING; run terminal = SUCCEEDED/FAILED/ended. Server evaluates. | n/a (text) |
| src/runner-go/tool_receipt.go | 498 | WIRE | Copies a session doc's status into the tool receipt. | OK |
| src/link-gateway/client_drills.go | 417 | W | Drill client sends turn-complete status AWAITING_INPUT (after_seq test). | BREAKS only if server validation rejects the word |
| src/link-gateway/welcome.go | 80-83 | WIRE | Passes server's per-session durableSeq/leaseHeld; no status word (proto SessionState has none). | n/a |
| src/drive-mount/ | — | — | No session status (drivefs "runStatus" is a goroutine writing status.json). | n/a |
| contracts/session-state.contract.json | 68,82-91 (vectors) | WIRE | Names legacyFields status/runStatus/runState/sessionState/filingState; vectors map each stored status to phase/released. | BREAKS: parity specs/vectors need rewrite |
| contracts/watch.contract.json | 18-30,97-99,232,272,321,333,563-664,877-962 | WIRE | Predicate definitions and vectors over session.status / run state. | BREAKS: SESSION_* definitions and vectors |
| contracts/session-list-order.fixtures.json | 43-359 | WIRE | Fixture rows with status AWAITING_INPUT/INTERRUPTED/SUCCEEDED. | BREAKS fixtures if consumers drop the words |
| contracts/orbit-agent.contract.json | 184 | WIRE | task_start receipt must carry "session status" (no words). | OK |
| scripts/session-status-db-objects.sql | 25-80 | R | Catalog audit of DB objects naming any of the eight status words. | BREAKS if stored words change: regex finds nothing for IDLE |
| scripts/session-claim-index-precheck.sql | 24-37 | R | SQL: PARKED count, live set per task, terminal rows without finished_at. | BREAKS if stored words change: live/terminal sets miss IDLE (one-off precheck) |
| scripts/session-claim-index-drop-precheck.sql | 48-52 | R | Regex over pg_stat_statements for the old `status IN` query shape; no words. | n/a |
| scripts/session-release-cause-drop-precheck.sql | 55-86 | R | SQL: status = / <> 'FAILED' on released rows. | BREAKS if stored words change: FAILED gone (one-off) |
| scripts/session-release-cause-drop-postcheck.sql | 14,22-32 | R | Same FAILED checks; trigger scan for SUCCEEDED\|FAILED\|CANCELLED. | BREAKS if stored words change: (one-off) |
| scripts/project-liveness-audit.sql | 51 | R | Live session = PENDING/RUNNING/AWAITING_INPUT/INTERRUPTED. | BREAKS if stored words change: idle sessions not counted live |
| scripts/launch-metrics/partner-funnel.sql | 59,61 | R | Counts status = 'SUCCEEDED' sessions. | BREAKS if stored words change: metric silently zero/errors |
| scripts/wiki-phase1-metrics.sql | 235-245 | — | Joins session but reads no session status. | n/a |
| scripts/runner-link/reconnect-probe.sh | 85,96,211 | R | Live-session SQL (four open words). | BREAKS if stored words change: invalid enum literal / misses IDLE |
| scripts/runner-link/welcome-walk-cost.sh | 60 | R | Mirrors leaseHeld SQL: status IN four open words (a credential-style gate). | BREAKS if stored words change: diverges from server |
| scripts/runner-link/loadgen-seed.sh | 97,110-111,150-151 | R/W | Inserts AWAITING_INPUT rows; sets SUCCEEDED where RUNNING/PENDING/INTERRUPTED. | BREAKS if stored words change: writes invalid words |
| scripts/runner-link/drills/mass-disconnect-drill.sh | 309,333,421,674,746-759 | R | DB status, asserts AWAITING_INPUT / RUNNING. | BREAKS if stored words change: assertions fail |
| scripts/runner-link/drills/release-outage-drill.sh | 159,205-239 | R | DB status; expects AWAITING_INPUT (checks FAILED). | BREAKS if stored words change: fails |
| scripts/runner-link/drills/durable-events-drill.sh | 244,480-755 | R | DB status; RUNNING, then AWAITING_INPUT. | BREAKS if stored words change: final verdict fails |
| scripts/runner-link/staging-check-link.sh | 148 | R | API status === "PENDING". | OK |
| scripts/test-dsh-dispatch.mjs | 228,284-285,324-326,366,413 | R | DB status: AWAITING_INPUT, terminal set, PENDING, CANCELLED. | BREAKS if stored words change: waits time out |
| scripts/test-dsh-executable-acceptance.mjs | 368-370,424-425 | R | DB status AWAITING_INPUT/FAILED/CANCELLED; compares statuses. | BREAKS if stored words change: wait times out |
| scripts/test-dsh-install-gate.mjs | 227-228,264,306,335-366 | R | DB status: AWAITING_INPUT, FAILED, PENDING, CANCELLED. | BREAKS if stored words change: fails |
| scripts/test-merge-recovery-server.mjs | 54-62 | WIRE | Comments naming statuses beside pinned PG case names. | n/a |
| scripts/owner-secret-e2e/run.mjs | 104,221-226 | R | DB status::text: FAILED/INTERRUPTED/CANCELLED fatal; AWAITING_INPUT settled. | BREAKS if stored words change: times out / misses failure |
| scripts/task-fork-drill/run.mjs | 167-171 | R | Same statusOf/settled logic from DB. | BREAKS if stored words change: same |
| scripts/task-codeless-drill/run.mjs | 157-161 | R | Same statusOf/settled logic from DB. | BREAKS if stored words change: same |
| scripts/long-running-loops/drill.py | 411,470-472,606,677 | R | DB status AWAITING_INPUT, FAILED+retryAt. | BREAKS if stored words change: waits fail |
| scripts/long-running-loops/verdicts.py | 210-212 | R | Records sampled DB status history. | OK (records any word) |
| scripts/acceptance/session-release/scenario.mjs | 10,98-107,119,197,274-276 | R | SQL status = AWAITING_INPUT / RUNNING / FAILED; compares old vs new rows. | BREAKS if stored words change: fails |
| scripts/acceptance/landing-fix-own-session/cases.mjs | 100,145,402,485,493 | R | API status in AWAITING_INPUT/RUNNING/IDLE/COMPLETED/SUCCEEDED. | OK (already lists IDLE) |
| scripts/acceptance/landing-measured/a-ops.mjs | 101 | R | API status in AWAITING_INPUT/RUNNING/IDLE. | OK |
| scripts/acceptance/landing-measured/b-mixed.mjs | 78 | R | Same. | OK |
| scripts/acceptance/landing-measured/queries.mjs | 12 | R | Dumps s.status as evidence. | OK |
| scripts/acceptance/landing-reliability-recheck.sh | 110 | R | Prints work session status::text. | OK |
| scripts/acceptance/lib/integration-line-fixture.sh | 511-521 | W | Inserts a session with status 'SUCCEEDED'. | BREAKS if stored words change: invalid enum value |
| scripts/managed-runner/image-smoke.py | 52,60 | W | Fake server: reclaim row and turn answer AWAITING_INPUT. | OK (stub; still tests the old word) |
| scripts/managed-runner/lab/scenarios/session.py | 42-46 | R | API runStatus not PENDING/RUNNING/QUEUED, or status FAILED/AWAITING_INPUT/ENDED = settled. | OK via runStatus fallback |
| scripts/managed-runner/lab/scenarios/browser_sign_in_banner.sh | 50,114-116 | R | Reads runStatus; passes when it is not FAILED. | BREAKS if FAILED leaves runStatus: check passes vacuously |
| scripts/managed-runner/lab/runner-image.py | 533-544,676-677 | R | Polls status, default --status AWAITING_INPUT. | BREAKS: wait times out on IDLE |
| scripts/managed-runner/lab/login-lab.py | 283,443-451 | R | status/runStatus/runState/sessionState; settled test like session.py. | OK via runStatus fallback |
| scripts/managed-runner/lab/durability-lab.py | 788-790 | R | Polls status FAILED/AWAITING_INPUT/CANCELLED. | BREAKS if an idle/failed answer is reworded |
| scripts/managed-runner/lab/wake-lab.py | 297,444-450 | R | Records status/runStatus; DB s.status dump. | OK (records) |
| scripts/managed-runner/lab/acceptance-lab.py | 1679-1681 | R | DB s.status != 'FAILED'. | BREAKS if stored words change: check passes vacuously |
| scripts/kimi-accounts-stack/scenario5.mjs | 96-97 | R | Live = status not ENDED/COMPLETED/FAILED/CANCELLED. | OK unless ended rows read IDLE (counted live) |
| scripts/kimi-accounts-stack/scenario2.mjs | 74 | R | Prints API status (scenario3.mjs:22 likewise). | OK |

### 7.4 Web

**Premise for the last column (option B on the wire):** `status`/`runStatus` carry only PENDING/RUNNING/IDLE; RUNNING still means a dispatched turn; `runState`, `sessionState`, `phase`, `released`, `lastTurnOutcome`, `endReason`, `activity` keep today's meaning. If the server keeps sending the seven words on the wire, every row is OK.
"derived" = reads through `lib/sessionState.ts` (phase+released first, then `runState`, then raw status).

| File (path under src/) | Lines | R/W | Which field and what for | If the legacy wire words changed |
|---|---|---|---|---|
| web/src/lib/sessionState.ts | 53-60, 154-229, 249-256, 267-278, 364-449, 458 | R | The resolver: all four fields → run state, words, live/busy/queued/slot predicates. Line 249: raw status tells a turn from outside-turn work | DEGRADES: IDLE with phase RUNNING + activity TURN (engine's own turn, sub-agent) reads RUNNING. Without phase/runState, IDLE → ENDED |
| web/src/lib/sessionGrouping.ts | 27-28, 72-87 | R | status/runStatus: failed fallback; working fallback; `FAILED && retryAt` counts as working even with phase | BREAKS: auto-retrying failed rows leave the Working section (line 87) |
| web/src/lib/useSessionStream.ts | 199, 234, 1475-1493 | R | runStatus AWAITING_INPUT → idle=true, clear live output (missed turn_end fallback); RUNNING → idle=false | BREAKS: a held IDLE session never matches AWAITING_INPUT, and runTerminal covers released only |
| web/src/lib/sessionImport.ts | 28-29 | R | status FAILED/CANCELLED/INTERRUPTED ends the import poll with its error | BREAKS: failure is seen only as a timeout, error text lost |
| web/src/lib/useControlPlane.tsx | 152, 163-171, 181, 189, 400-407 | R/W | runStatus/status + released → sidebar tally class; W: local tally cache keeps status (not the query cache) | OK with `released` (IDLE is one class). Without it, released set never matches |
| web/src/lib/runnerSlots.ts | 12-14, 25, 160-165 | R | RUNNING counts runner slots (fallback for runner.activeSessions); derived compacting/starting | OK |
| web/src/lib/sessionTurnIntent.ts | 14 | R | status RUNNING, or PENDING with 0 turns → send into current work | OK |
| web/src/lib/cursorRuntime.ts | 125-128 | R | RUNNING, or AWAITING_INPUT+engineTurnActive → Cursor conversation started (blocks account move) | DEGRADES: second clause dead; numTurns/runtimeSessionId mostly cover |
| web/src/lib/taskRunHandoff.ts | 305-307 | R | task.sessions[].status RUNNING/PENDING → "Open the run" instead of Run/Retry | OK |
| web/src/lib/sessionCapabilities.ts | 70-81 | R | derived live → SEND vs RESUME/CREATE endpoint choice | OK (`released`) |
| web/src/lib/sessionDetailPolling.ts | 14-18 | R | derived live → poll detail | OK |
| web/src/lib/transcriptPaint.ts | 34, 50 | R | derived runState QUEUED → queued placeholder | OK |
| web/src/lib/claudeRegion.ts | 59 | R | derived QUEUED + error → region hold words | OK |
| web/src/lib/watches.ts | 399-420, 1030-1036 | R | targetStatus (SessionRunState) counts/words; wake `observed.status` (raw RunStatus) parsed | targetStatus OK; wake status passes IDLE on (see Transcript, WatchWakeCard) |
| web/src/lib/queries.ts | 415 (fields via api types) | WIRE | List cache holds the rows; reads lifecycle only. No status query parameter is sent | OK |
| web/src/lib/openListDelta.ts | whole | WIRE | Merges changed list rows into cache; no field read | OK |
| web/src/lib/sessionExport.tsx | 119 | R | `status` printed in HTML export header (caller passes derived runState) | OK |
| web/src/lib/sessionPhaseFields.fixture.ts | 28-124 | WIRE | Non-test-named test fixture with all seven words (not product) | OK (needs update) |
| web/src/api.ts | 592, 1572-1578, 1973 ff. (1987-1992, 2018-2022, 2079-2088), 2336 | WIRE | Types: SharedSession, SessionListItem, MergeRepairSession, SessionDetail, import reply, AbandonedCheckout | OK (typed as string) |
| web/src/components/WorkspaceView.tsx (derived) | 1237, 1258, 1414-1505, 1855-2060, 3536, 4536, 4744, 4772, 5148-5161, 5380, 7938, 8025, 10562, 11839-11842 | R | Derived state: glyphs, words, row lines, placeholders, live/busy gates, ended banner, task-run-going | DEGRADES only via the resolver's line 249 case |
| web/src/components/WorkspaceView.tsx (raw) | 4840-4846, 7649-7659, 8608, 10185 | R | runStatus → stream idle fallback, default send intent, Steer offered, Cursor placeholder | RUNNING checks OK; idle fallback BREAKS (useSessionStream) |
| web/src/components/WorkspaceView.tsx (raw) | 10213 | R | runStatus FAILED suppresses the prompt suggestion | BREAKS: suggestion offered after a failed turn |
| web/src/components/WorkspaceView.tsx (raw) | 3343-3346, 5567, 8561, 9260, 9709 | R | field presence; runState as refetch key; busy/running = RUNNING; Cursor move gate | OK (9709: see cursorRuntime) |
| web/src/components/WorkspaceView.tsx (writes) | 6306, 6519, 7047, 7525 | W | Puts fetched detail in cache; primes a row with no status; export `status`=runState; config merge. No local status value is invented | OK |
| web/src/components/WikiChatPanel.tsx | 1150-1155, 1253-1276, 1431, 1491 | R | derived live/generating/ended; runStatus → idle fallback, send intent, Steer; FAILED flag | BREAKS: idle fallback; FAILED flag (1431) |
| web/src/components/help/HelpAsk.tsx | 372-391 | R | derived live/queued polling; runStatus → stream idle fallback | BREAKS: idle fallback |
| web/src/components/SessionSettingsDrawer.tsx | 341 | R | RUNNING → "Restart after this turn" | OK |
| web/src/components/settings/WorkspaceSettingsPage.tsx | 304 | R | runState??runStatus??status = RUNNING → session busy for main checkout | OK |
| web/src/components/MergeRecoveryPanel.tsx | 9, 19, 54-82 | R | runState first: PENDING/QUEUED/RUNNING = repair running, FAILED = failed step | OK while runState sent; without it FAILED is lost |
| web/src/components/ProjectCoordinatorCard.tsx | 53-54, 181-182 | R | server runState RUNNING, or AWAITING_INPUT+engineTurnActive → "Working" | OK while runState sent (does not use phase) |
| web/src/components/RunnerEngines.tsx | 1755-1756 | R | blocking sessions' raw status: running vs waiting label (account removal) | DEGRADES: AWAITING_INPUT label disappears |
| web/src/components/Transcript.tsx (wake) | 2311 | R | wake `observed.status`==FAILED → entry dropped from the event summary | BREAKS: failed wakes no longer excluded |
| web/src/components/Transcript.tsx (card) | 5921 | R | session_create result card prints raw status lowercased | DEGRADES: shows "idle" |
| web/src/components/WatchWakeCard.tsx | 49, 89 | R | observed status: FAILED styling, "is now X" | DEGRADES: no failure mark, says IDLE |
| web/src/components/WatchCard.tsx | 345-355 | R | snapshot observed.status (raw) and runState printed | DEGRADES: prints IDLE |
| web/src/components/WatchParts.tsx | 46-50 | R | runState??status → "now …" text | OK (runState) |
| web/src/components/WatchRelations.tsx | 296-305 | R | session targetStatus (a run state) → tone and word | OK |
| web/src/components/TaskDetailPanel.tsx | 143, 822, 1466-1511, 1595, 2043, 2510 | R | derived: run badge, busy polling, live run, queued text | OK/DEGRADES via resolver (payload facts unverified) |
| web/src/pages/TaskListView.tsx | 1169 | R | taskRunEntry(row): task status only, no session rows | OK |
| web/src/components/RunNeverStartedCard.tsx | 117-120, 284, 301, 427, 452, 489 | R | derived QUEUED/RUNNING/FAILED → which card | OK |
| web/src/components/OrbitLinkCard.tsx | 206-209, 309-320 | R | link-preview session/lastRun/coordinator → derived tone and word (payload has no phase) | OK while runState sent |
| web/src/components/CoordinatorChange.tsx | 144 | R | derived: wait until ended | OK |
| web/src/components/SessionMoveModal.tsx | 197 | R | derived: wait until ended | OK |
| web/src/components/SessionSearch.tsx | 426 (StatusIcon too) | R | statusLabel(hit), derived | OK/DEGRADES via resolver |
| web/src/components/SharedWithMe.tsx | 104 | R | sessionStateWord | OK |
| web/src/pages/SharedSessionPage.tsx | 64-65, 137-143, 580 | R | derived: poll cadence, tone, word | OK/DEGRADES via resolver |
| web/src/pages/GuestSessionPage.tsx | 276, 502, 637 | R | derived live and word | OK |
| web/src/pages/SharedSessionPage.fixtures.ts | 8 hits | WIRE | Fixture data, not behaviour | OK |
| web/src/pages/SharedLinksPage.tsx | 57 | WIRE | link.root.status read, but used only for TASK/PROJECT; sessions use lifecycle | OK |

### 7.5 Apple and Android

**Premise of the last column.** `status` and `runStatus` send a new word `IDLE` in place of AWAITING_INPUT / INTERRUPTED / SUCCEEDED / FAILED / CANCELLED; `PENDING` and `RUNNING` are unchanged; the server still sends correct `runState`, `sessionState`, the facts and `capabilities`. The verdict is for the newest release (v0.1.261-beta.95). Older builds are in Notes.

W rows: **none**. No native client sends a session status value, either as a body field or as a query filter.

Paths: `K/` = macos/OrbitKit/Sources/OrbitKit/, `A/` = macos/OrbitApp/Sources/OrbitApp/, `an/` = android/app/src/main/kotlin/io/orbitd/android/, `ac/` = android/core/src/main/kotlin/io/orbitd/android/core/. There is no status reader in `ios/` (Sources, OrbitShare) or in A/../OrbitShare.

One local writer outside the tables: `macos/OrbitApp/Sources/OrbitApp/Views/SessionProjectListSupport.swift:12`
builds a `Session` row with status `.running` or `.awaitingInput`; nothing is sent to the server.

#### Apple (shared by the macOS and iOS apps)

| File (path under src/) | Lines | R/W | Which field and what for | If the legacy wire words changed |
|---|---|---|---|---|
| K/Models/Enums.swift | 7-42, 85-165, 294-315 | WIRE | `RunStatus`, `SessionRunState`, `SessionState` decoders (unknown → `.unknown`); `resolve` order: runState, status+endReason | DEGRADES: without runState, IDLE reads Ended |
| K/Models/DTOs.swift | 538-557, 818-836, 897-906, 2011-2031, 2045-2175, 2419-2484 | WIRE/R | status/runStatus/runState/sessionState on Session, MergeRepairSession, SessionDetail, search hit; `isReleased`, `effectiveRunState` | OK: `released` and runState come first |
| K/Models/ControlEvent.swift | 123-240, 310-348 | WIRE | Same fields on control-stream session events and `session.ended` | OK |
| K/Models/SessionPhase.swift | all | WIRE | Lenient decoders for phase / lastTurnOutcome / waitingOn | OK |
| K/Models/SessionGuests.swift | 69-161 | WIRE | Guest payload status/runStatus/sessionState/runState as strings | OK |
| K/Models/LinkPreviews.swift | 83-160 | WIRE/R | Link-card session status → run state | OK (runState) |
| K/Models/Tasks.swift | 336-373 | WIRE/R | Task's session refs; `resolvedRunState`; raw status breaks the tie for phase RUNNING | OK: unknown word falls to `activity` |
| K/Models/Runners.swift | 697-713 | WIRE | Session in a refused account removal (tolerant; unknown → nil) | DEGRADES (see RunnerPageFormat) |
| K/Models/ProjectDetail.swift | 1097-1128 | WIRE | Coordinator session `runState` | OK |
| K/Models/Watches.swift | 285-290 | WIRE | Watch observation: raw `status` + runState; no client logic reads raw status | OK |
| K/App/Composer.swift | 101-143, 154-170 | R | Status decides queue vs send now; `released ?? isTerminal` decides /resume vs /turns | OK for send with `released`; unknown = sendNow |
| K/App/Composer.swift | 201-214 | R | `reconcileStatus` (REST terminal overrides stream; no `released` passed); `isLive` = !terminal | **BREAKS**: released IDLE session counts as live |
| K/App/Composer.swift | 238-300 | R | Stop button and prompt suggestion: runState, else stream awaitingInput/running | OK with record loaded |
| K/App/WorktreeBarLogic.swift | 161-166 | R | `turnActive(status)`: awaitingInput/interrupted + sending/sub-agents; `.unknown` → false | **BREAKS**: Merge/Commit offered while a parked session's sub-agents still write |
| K/App/Notifications.swift | 20-95 | R | macOS local alerts; `released` / `releasedRunState`, status only if `released` absent | OK |
| K/App/OpenListRowUpdate.swift | 22-29 | R | `released ?? isTerminal` → refetch list | OK |
| K/App/SessionUpsert.swift | 43-45, 102-107, 167-221, 303-308 | WIRE | Copies status fields and facts into rows | OK |
| K/App/SessionStatusGlyph.swift | 59-135 | R | Row glyph from `displayRunState`; legacy overload from status | OK |
| K/App/SessionHeader.swift | 14-28, 64-95, 185 | R | Status word; released facts, else runState | OK |
| K/App/SessionLine.swift | 86, 110 | R | Row subtitle from `effectiveRunState` | OK |
| K/App/SessionGrouping.swift | 49-66 | R | Needs-you/Working from `phase`, else run state | OK |
| K/App/SessionTimeGrouping.swift | 62-77 | R | Failed/Working sections from run state | OK |
| K/App/MenuBar.swift | 68-78 | R | Menu-bar subtitle switches on `effectiveRunStatus` | DEGRADES: idle rows lose "Awaiting input"; fall to `statusWord` |
| K/App/ClaudeRegion.swift | 62-73 | R | Held when runState queued / status pending | OK |
| K/App/SessionRunStart.swift | 129, 137-162 | R | Machine error card only when status is failed or pending | **BREAKS**: failed run loses its error/fix card |
| K/App/WikiChatLogic.swift | 1235-1239 | R | Wiki chat "ended" line when status not live/pending | **BREAKS**: an idle, open chat reads as ended |
| K/App/RunnerPageFormat.swift | 784-795 | R | Account-removal session list: running/pending vs awaitingInput | DEGRADES: "waiting" label and tone lost |
| K/App/ProjectPage.swift | 1059-1060 | R | Coordinator pill from runState | OK |
| K/App/GuestSession.swift | 59-114, 138 | R | Guest word/tone/live: facts, runState, runStatus, sessionState | OK |
| K/App/ShareMarkdown.swift | 88-101 | R | Run label from run state | OK |
| K/App/OrbitLinkCard.swift | 281-312 | R | Card status from run state | OK |
| K/App/WatchProjection.swift | 557, 582-584 | R | Watch `targetStatus.status` parsed as SessionRunState (server-derived, not the column) | OK if server keeps deriving it |
| K/App/TaskRunHandoff.swift | 308 | R | Busy run = status running/pending | OK |
| K/App/TaskListLogic.swift | 149-156 | R | `resolvedRunState` running/queued | OK |
| K/App/TaskDetailAgentFirst.swift | 115-116 | R | Same | OK |
| K/App/RecapCard.swift | 53 | R | run state != queued | OK |
| K/App/QueuedCapacity.swift, QueuedClone.swift, QueuedDiskLow.swift, RunnerUpdating.swift | 28 / 20 / 16 / 67 | R | run state == queued | OK |
| K/App/SessionWorkspaceMove.swift | 127 | R | Waits for `isReleased` | OK |
| K/App/LaunchSnapshot.swift | 137 | WIRE | On-disk list cache re-encodes rows | OK (unknown word cached as "UNKNOWN") |
| K/Transcript/TranscriptReducer.swift | 28, 114 | WIRE | Persisted transcript `status` | OK |
| K/Transcript/TranscriptReducer.swift | 1615, 1641, 2420 | R | **Run-event** `status` (runner events, not the column); `RunStatus(rawValue:)`, unknown ignored | OK unless events change too; then stream stays "running" |
| A/ConsoleModel.swift | 526-527, 2234, 2319-2368, 3349-3443 | R | serverStatus + serverReleased drive send, queue, resume | OK for send/resume |
| A/ConsoleModel.swift | 913, 945, 1401, 2554, 2663, 2929, 3047, 3134 | R | `isLive` (status only): config applied live vs carried on next resume | **BREAKS**: released session treated as live for model/provider/mode picks |
| A/ConsoleModel.swift | 216-256, 1010 | R | pending / running checks (repair cards, region held, Cursor started) | DEGRADES: failed-run card as in SessionRunStart |
| A/ConsoleModel.swift | 1410 | R | Worktree poll cadence from `status.isLive` | DEGRADES: parked session polls as ended |
| A/ConsoleModel.swift | 2742, 2753 | R | Clear stale tool output when awaitingInput or terminal | DEGRADES: IDLE matches neither |
| A/ConsoleModel.swift | 3819 | R | `/status` card prints `sessionStatus.rawValue` | DEGRADES: shows "UNKNOWN" |
| A/Views/ComposerView.swift | 342-378, 824-947, 1820 | R | Running checks; passes `effectiveRunStatus` to send | OK |
| A/Views/Console/ConsoleView.swift | 282, 889-897, 1632-1775, 2128 | R | `== .running`; `effectiveRunState.isLive` | OK |
| A/Views/WorktreeBar.swift | 156-170 | R | `committed = !status.isLive`; turnActive | **BREAKS**: parked IDLE session reads committed (Merge instead of Commit when dirtiness unknown or dirty) |
| A/Views/Console/FoldedBandBar.swift | 49, 184 | R | Same two rules | **BREAKS** (same) |
| A/Views/MainCheckoutViews.swift | 32, 576 | R | turnActive from status | **BREAKS** (parked with sub-agents not busy) |
| A/Views/MergeRecoverySheet.swift | 92 | R | turnActive from status | **BREAKS** (same) |
| A/WorktreeModel.swift | 84-85, 156 | R | Repair running (run state); live diff refresh = status.isLive | DEGRADES: no live diff while parked |
| A/AppModel.swift | 1607-1610 | R | `released` / `workFinished` on `session.ended` | OK |
| A/Views/WikiChatViews.swift | 814 | R | Passes status to `endedLine` | **BREAKS** (see WikiChatLogic) |
| A/Views/SessionSearchView.swift | 159 | R | Glyph from run state | OK |
| A/Views/TasksView.swift | 1909, 2921-3012 | R | `resolvedRunState` | OK |
| A/Views/GuestSessionView.swift | 35 | WIRE | Empty guest state | OK |

#### Android

| File (path under src/) | Lines | R/W | Which field and what for | If the legacy wire words changed |
|---|---|---|---|---|
| an/directory/DirectoryModels.kt | 37-46, 77, 151 | WIRE | status (default "UNKNOWN"), runState, runStatus, facts; strings | OK |
| an/directory/DirectoryModels.kt | 202, 217, 221 | R | Folder running; failed section (facts first); Working = RUNNING/PENDING/FAILED+retryAt | DEGRADES: retrying failed rows leave Working (status != "FAILED") |
| an/directory/SessionLine.kt | 193-346 | R | Words/marks: runState, then runStatus ?: status; facts for released | OK |
| an/directory/SessionListPage.kt | 155-164 | R | Row mark from run state | OK |
| an/directory/SessionProjects.kt | 118 | R | Builds a local status string for grouping; not wire | OK |
| an/directory/DirectoryScreen.kt | 357 | R | Search hit shows runState ?: status | OK |
| an/directory/DirectoryActions.kt | 303-309 | R | Wait for end: `released`, else terminal status | OK |
| an/directory/RecapCard.kt | 40 | R | run state != queued | OK |
| an/MainActivity.kt | 448 | R | Drawer running count: runState or status RUNNING | OK |
| an/composer/ComposerData.kt | 650-672 | R | `sendEndpoint`: released first, capabilities, legacy words only without both | OK |
| an/composer/ComposerData.kt | 650-651 | R | `terminal()` = status/runStatus in ENDED/FAILED/CANCELLED/COMPLETED | **BREAKS**: released IDLE session not terminal |
| an/composer/ComposerData.kt | 700-724 | R | Stop and suggestion: runState first | OK |
| an/composer/ComposerModel.kt | 235, 549, 577 | R | `/status` prints raw status; `terminal()` picks resume config vs live PATCH | **BREAKS** (config on ended session) |
| an/composer/SessionComposer.kt | 158, 270, 511 | R | RUNNING checks; "will resume" note uses `terminal()` | **BREAKS**: note and Check Again missing for ended |
| an/composer/ComposerUsage.kt | 42 | R | RUNNING | OK |
| an/composer/CursorRuntime.kt | 140-142 | R | Conversation started: RUNNING, or AWAITING_INPUT + engine turn | DEGRADES |
| an/reader/WorktreeBarLogic.kt | 66-70 | R | turnActive: AWAITING_INPUT/INTERRUPTED + sending/sub-agents | **BREAKS**: IDLE → false, Merge not held |
| an/reader/WorktreeBarLogic.kt | 77-79 | R | committed: facts first | OK |
| an/reader/WorktreeBar.kt | 149-153 | R | runStatus ?: status feeds the two rules | **BREAKS** (turnActive) |
| an/reader/WorktreeBar.kt | 541 | R | Live diff when RUNNING/AWAITING_INPUT/INTERRUPTED | DEGRADES |
| an/reader/BackgroundTray.kt | 73-74 | R | sessionLive = not SUCCEEDED/FAILED/CANCELLED | **BREAKS**: ended sessions show background work as live |
| an/reader/MainCheckoutModel.kt | 174-175 | R | Move target busy = PENDING/RUNNING | OK |
| an/reader/SessionReader.kt | 252, 556, 805, 1017 | R | Queued/running; PENDING repair cards | OK |
| an/reader/SessionMenu.kt | 29-61 | R | "Stops the current run" from resolved run state | OK |
| an/reader/SessionSettingsPage.kt | 85 | R | Resolved RUNNING | OK |
| an/reader/MergeRecovery.kt | 41, 176, 262 | R | Repair runState ?: runStatus | OK (runState) |
| an/reader/TranscriptRows.kt | 74 | R | Seven known words on `turn_end` **event** status, not the column | OK unless events change |
| an/tasks/TaskLogic.kt | 138-178, 610, 929 | R | `resolvedRunState`: facts, runState, status, sessionState; busy = RUNNING/PENDING | OK |
| an/tasks/TaskDetail.kt, TaskDetailAgentFirst.kt | 820, 985 / 66-73 | R | Resolved run state | OK |
| an/projects/ProjectPage.kt | 516-517 | R | Coordinator pill runState | OK |
| an/management/RunnerPage.kt | 1560, 1653-1656 | R | In-use session: RUNNING/PENDING, AWAITING_INPUT | DEGRADES: no "waiting" label |
| an/push/PushAuthority.kt | 177-178 | R | Requires session `status` present | OK |
| an/push/PushAuthority.kt | 205-210 | R | Stale finished/failed push: facts, else exact SUCCEEDED/FAILED | OK |
| an/watch/WatchWire.kt, WatchLogic.kt | 195-206 / 114-137 | WIRE/R | Watch observed facts; target glyph from server-derived run state | OK |
| ac/protocol/DirectoryDtos.kt | 16-32 | WIRE | `SessionSummary` (its only caller `OrbitApi.sessions` is unused by the app) | OK |
| ac/protocol/SessionFacts.kt | all | R | The facts' lenient reader | OK |
| ac/guests/GuestLogic.kt, GuestSessions.kt | 46-115 / 37-104 | WIRE/R | Guest state: runState, runStatus, sessionState, facts | OK |
| ac/cards/ClaudeRegion.kt | 120-130 | R | Held: runState, else status PENDING | OK |
| ac/cards/SessionRunStart.kt | 45-46 | R | Machine error card only on failed/queued status | **BREAKS**: card gone for failed runs |

### 7.6 Database objects and raw SQL

Raw SQL inside TypeScript is in the rows of 7.1 and 7.2. Prisma migrations hold history; the live objects are:

| Object | Names | What for |
|---|---|---|
| type `run_status`, column `session.status` (default `PENDING`) | all 8 labels | storage |
| CHECK `session_release_fact_chk` | `SUCCEEDED`, `FAILED`, `CANCELLED` | status is one of them exactly when `finished_at` is set |
| indexes `session_status_idx`, `session_assigned_runner_id_status_idx`, `session_batch_id_status_idx`, `session_owner_status_task_idx`, `session_root_session_id_status_idx` | column | access paths |
| partial index `session_over_capacity_pending_idx` | `PENDING` | over-capacity queue |
| functions `guard_antigravity_runner_claim`, `guard_opencode_runner_claim`, `guard_cursor_runner_acquisition`, `guard_dsh_runner_acquisition`, `guard_session_engine_acquisition` (and their `session` triggers) | `PENDING`, `RUNNING` | claim and acquisition guards |
| function `open_list_bump_owner` | `PENDING` | open-list epoch |
| function and trigger `session_listed_at_on_settle` / `session_listed_at_settle` | `SUCCEEDED`, `FAILED`, `CANCELLED` | list order when a session settles |
| function `session_request_recipient_ended` | `status::text` | writes the word into `session_request.close_reason` |
| trigger `session_request_recipient_ended` (WHEN) | `INTERRUPTED` | the recipient ended |
| trigger `session_request_asker_stopped` (WHEN) | `INTERRUPTED`, `AWAITING_INPUT` | the asker stopped |
| trigger `task_owner_confirmation_review_reviewer_ended` (WHEN) | `INTERRUPTED` | the reviewer ended |
| triggers `session_admission_lock_order_update`, `session_project_capacity_serialize_update`, `session_superseded_task_revive_guard` | column list only | fire on a status update |

No view or materialized view reads `session`'s status.
