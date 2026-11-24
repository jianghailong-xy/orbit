# Syncing main into a project line without reopening a DONE task

> Status: proposal for the owner's agreement. Nothing here is built. Written by task T5a (`34xLpUMgrzljIFxyDgRAC`) of
> project `34xLkkpjrrFbUzGhsgy7f` ("Orbit: stop silent stalls in task evidence and landings"). T5b
> (`34xLpUNN9M4gNKL0pyPvn`) builds what the owner agrees to.
> Serves project criterion `7Q2BNgzITOqOjHdj6oVzME`: "A project branch can absorb new upstream (main) commits without
> reopening an already-DONE task: the platform runs the sync itself, or files a dedicated sync task for it, and a
> conflict is delivered to the coordinator as an item that does not require reworking a finished task." This note is
> the design half of its verification; T5b's integration spec is the other half.
> Code baseline: main `a2d45a5dbd` (2026-11-24). Line numbers refer to that commit.
> Builds on `docs/project-integration-line-contract.md` ("the contract"): §3.1 (M1–M4), §4 (exception items), §11.4
> (K4–K5, the red-baseline hold) and §12 (revision 42: a failed landing goes to the task's own session first).

## 0. Summary

**What happens today.** A project line absorbs main only inside a task's landing. When a landing finds main ahead of
the project branch, the runner first merges main into the branch tip (J-S2, `MAIN_SYNC`). When that merge conflicts:

- the landing ends `CONFLICT` at `MAIN_SYNC`, and the item is filed as **that task's** failure, although none of the
  task's commits were looked at;
- every other task's landing on the line waits behind the item (M2);
- the fix has to go through the finished task's own branch. Since revision 42 the task's ended session is revived to
  merge both tips into its branch, and the task's delivered identity is cleared and frozen again. When that does not
  happen, the coordinator's documented remedy is `task_comment` + `task_reopen`;
- a separate fix task does not get around it. Its landing can bring main in, but the item comes back to the coordinator,
  and the conflicted task's landing can only be queued again by reopening it.

In "Session translation" (`34vcDOhN0OCStfnVuTyPq`, 2026-11-11 to 14, before revision 42) the reopen recipe ran every
time main moved, and MAIN_SYNC item `34wS12mhpciMYkJI52eE1` was tied to a finished task while it held the queued
landings of W2, D2, D3 and A3 from 2026-11-12/13 until at least 2026-11-14.

**Recommendation: (a), the platform runs the sync itself.**

1. A clean sync stays where it is: J-S2 inside each landing, checked together with the task, at no extra cost.
2. A conflicting sync stops being a task's failure. It opens one **line-sync item** about the project branch, with no
   task. It is assigned and delivered to the coordinator like every integration item, and escalates to the owner after
   `exceptionEscalationSeconds`.
3. The conflicted task stays DONE and is not touched. Its landing is queued again at once and waits behind the item, the
   way K5 already handles a red baseline. No session is revived, no identity is cleared, nothing is reopened.
4. Every other landing on the line waits behind the same item, as today. All of them go ahead by themselves, in queue
   order, once the line has absorbed main.
5. The coordinator resolves the item by filing one sync task from the item's door (`task_create` with
   `fixesOpenItemId`). That task starts at the project branch tip, merges main and resolves the conflict. The runner
   already lands such a branch correctly, and its landing closes the item.

Option (b), a sync task the platform files for every sync, is not recommended (§3.3).

**Decisions for the owner.**

| # | Question | Recommended | Alternative |
|---|---|---|---|
| D1 | Who brings main into the line? | (a) The platform, as today; only a conflict needs anyone (§3) | (b) A sync task the platform files for every sync |
| D2 | What happens to queued landings while a sync conflict is open? | They wait behind the item and go ahead in order once the line has main (§4.3) | They land on the line without main (§12, item 3) |
| D3 | Who files the sync task when a sync conflicts? | The coordinator, from the item's door (§4.4) | The platform, automatically (§12, item 2) |

No UI is needed (§10).

## 1. How a project line absorbs main today

### 1.1 The sync is a step of a task's landing

`runIntegrationJob` performs a `LAND_TASK` as FETCH → MAIN_SYNC → REBASE or MERGE → CHECK → PUSH → VERIFY
(`src/runner-go/integrate.go`). J-S2 (`integrate.go:452`) runs only on a project branch, and only when the upstream tip
U it fetched is not an ancestor of the target tip T0. It has three paths:

| Path | When | What it does | A conflict there |
|---|---|---|---|
| ① | The source already contains U and T0 (`sourceCarriesTheAbsorb`, `:823`) | Nothing; J-S4 lands the source by MERGE | — |
| ② | The source absorbed an earlier U′ and contains T0 (`sourceCarriesAnEarlierAbsorb`, `:839`) | Merges U into the source | `CONFLICT` at `MAIN_SYNC` |
| ③ | Any other source (`:491`) | Merges U into T0, before the task's commits are looked at | `CONFLICT` at `MAIN_SYNC` |

Contract M4: a move of main triggers nothing by itself. The sync happens at the next landing or the next promotion
check. A conflict therefore lands on whichever task happens to land next.

### 1.2 The conflict is filed as that task's failure

The result transaction (`applyIntegrationJobResult`, `src/apiserver/src/runner-api/integration-job-relay.ts:2157`):

- offers the failure to the task's own work session first, when W4's four conditions hold (`:3190`,
  `landingFixWorkSession` in `project-integration-job.ts:1227`). `HANDED_OFF_FAILURE_CLASSES` (`:1202`) holds
  `CONFLICT` in any phase, `MAIN_SYNC` included, as the contract's §12.3 table says;
- opens `INTEGRATION_CONFLICT` with `task_id` = the task and a dedupe key per job (`integrationDedupeKey(state,
  job.id)`, `:3213`).

### 1.3 Every other landing waits (M2)

`claimOne`'s M2 clause (`integration-job-relay.ts:785`–`822`) claims no `LAND_TASK` on the same serial key while an OPEN
`INTEGRATION_CONFLICT` exists whose job stopped at `MAIN_SYNC`. Two kinds of landing are exempt: the conflicted task's own
later landings, and the landings of a task whose `fixes_open_item_id` names the item. The task and line readers report
the wait as `WAITING_MAIN_SYNC` from the same predicate (`project-task-integration.ts:625`,
`project-integration-line.ts:1098`).

### 1.4 Why a finished task ends up reworked or reopened

| Step | What the code does | Consequence |
|---|---|---|
| Revision 42, W5–W7 (on main) | The item is offered to the task's work session. The landing-fix turn revives a session that ended with its task's DONE and clears the task's delivered identity; the session's finish freezes it again | A finished task's branch takes new commits for a conflict that is not in its work |
| Handed back (`NO_NEW_COMMIT`, `TURN_FAILED`, `SESSION_ENDED`, `ROUNDS_EXHAUSTED`) | The MAIN_SYNC cell's doors are `task_comment` + `task_reopen` (`open-item-doors.ts:719`), and the item's message gives the same recipe (`project-open-item.ts:2829`, `mainSyncNextStep`) | The coordinator reopens a DONE task: a new epoch, new evidence, a new judgment, and its dependents are blocked again |
| `integration_retry` | Refuses a `CONFLICT` (`project-integration-retry.ts:393`), except a MAIN_SYNC conflict whose branch has moved since (`:167`) | Only the task's own session can move its branch, so this is the same rework |
| A separate fix task (`fixesOpenItemId`) | Exempt from M2, so its landing can bring main in. But it does not close the item: `rearmItemFixedBy` (`project-open-item.ts:1624`) delivers it to the coordinator again, because the item also records that the conflicted task's work is not on the line | The conflicted task's landing still has to be queued again, and only `task_reopen` can do that, because its branch did not move |

The root cause is that one item records two facts. "The line cannot absorb main" is a fact about the line, and it is
the real one. "This task's landing failed" is an accident of which task landed next.

### 1.5 What already works

- **A sync task's branch lands correctly.** A task cut from the line tip that merges main and resolves the conflict is
  landed by J-S4 MERGE with its resolution intact: `TestIntegrationNewSyncTaskResolvesPromotionMergeConflict`
  (`src/runner-go/integrate_test.go:385`). If main moves on in the meantime, path ② merges the newer main into it:
  `TestIntegrationLandsASourceWhoseAbsorbedUpstreamMovedOn`.
- **A sync task starts in the right place.** A code task's work session forks from the line's current tip (contract
  §1.5, L10).
- **The hold already lets a fix task through** (`integration-job-relay.ts:800`–`821`).
- **K4/K5 is the shape this design needs, already built for a red baseline** (contract §11.4). It has one item about
  the line (`ICB:<serial>:<U>:<T0>`, with `heldTaskIds`). The red landing is queued again at once with cause
  `BASELINE_HELD` (`queueBaselineHeld`, `project-integration-job.ts:1110`). Every other landing is held
  (`baselineHoldSql`, `baseline-hold.ts`) except the fix task's. The fix's landing closes the item `LANDED` by
  `PLATFORM` (`rearmItemFixedBy`), and the held landings then go in order. Its pg cases in `integration-retry.pg.spec.ts`
  assert "baseline red is a queue hold, not a task failure".

## 2. Goals and non-goals

Goals:

- **G1.** No DONE task is reopened, revived, or has its delivered identity cleared because the line could not absorb main.
- **G2.** A sync conflict reaches the coordinator as one item about the project line, with doors that do not touch
  finished tasks.
- **G3.** Every landing the conflict held up goes ahead by itself once the line has absorbed main, in queue order,
  without anybody queuing it again.
- **G4.** The platform never decides what a conflict resolution contains. The gates stay the platform's and the judgment
  stays with agents (contract §12.2, W0).
- **G5.** The runner's git steps change only if they must, and older runners keep working.

Non-goals:

- Making a move of main trigger a sync by itself (M4 stays).
- MAIN lines: they have no project branch and no MAIN_SYNC.
- A promotion's MERGE conflict, which already has a sync-task door.
- Notices for a line that stays held too long. That is T4, under criterion `7Jlfoe3v4RVDHgXHsT2aqy` (§11).

## 3. The two options

### 3.1 (a) The platform runs the sync itself

The sync stays the platform's own git work. Two ways to run it were weighed:

- **(a1) Inside each landing, as today (J-S2).** Main and the task are checked together in one run of the landing
  check, and the merge commit lands with the task. Nothing is added.
- **(a2) A job of its own (`SYNC_UPSTREAM`).** Fetch, merge, check and push, with no task. Not adopted: main moves
  many times a day in this repository, so most landings would come after a move, and each of those would cost one more
  full landing-check run. The line is serial (J1), so the queue would move up to twice as slowly. It also needs a new
  job kind, a new runner capability, and a trigger that M4 says does not exist.

Under (a) the platform cannot resolve a conflict (G4), so a conflict needs an agent. The platform stops, puts the
line-sync item in front of the coordinator, and the coordinator files a sync task from the item. The platform lands that
task like any other.

### 3.2 (b) The platform files a dedicated sync task

Every sync is an agent's work. When the line needs main, the platform files a task "Sync main into the project branch"
in the project and starts it. Its run merges main into a branch cut from the line tip, resolves what conflicts, and
commits. The platform lands it through J-S2 ①. Landings stop merging main themselves; otherwise (b) is only (a)'s
conflict path.

What it would take:

- **A trigger for "the line needs main".** No fact says so except a job's own fetch, so every landing would report
  "upstream is ahead" and the platform would file a task then.
- **The platform as a task author.** `CreatorType` is `USER | AGENT` (`schema.prisma:280`): the platform has never
  filed a task. It would need a new creator value, a rule for the owner's task-creation card (an engine run the owner
  never approved), a model choice, and a slot in the project's `maxConcurrentTasks`.
- **An agent run, evidence and a judgment for every move of main the line absorbs**, clean or not.
- **Landings checked against an older main** until the next sync task lands.

### 3.3 Comparison

| | (a) The platform runs the sync | (b) The platform files a sync task |
|---|---|---|
| Clean sync (most moves of main) | The runner merges inside the landing; one check run; no agent | One task per sync: an agent run, evidence, a judgment, a landing |
| Conflicting sync | A line-sync item for the coordinator, who files one sync task from it | The same sync task, filed by the platform; the coordinator is told |
| DONE tasks touched | None | None |
| Queued landings while it is open | Wait behind the item, then go in order (§4.3) | The same |
| Who decides what the resolution contains | The sync task's agent, judged | The sync task's agent, judged |
| What is new | One item shape (K4's) and one enqueue cause | Platform-filed tasks: a creator value, an approval rule, a budget slot, a trigger |
| Migration | Widen one CHECK constraint (§5) | An enum value, plus task approval and budget rules, plus the same CHECK |
| runner-go | No change to the git steps; tool text only (§6) | Landings report "upstream is ahead" and stop merging main |
| Agent cost | Only for conflicts | One run for every move of main the line takes in |

### 3.4 Recommendation

**(a1).** The clean case is already the platform's, and it costs nothing. Every change is in what a conflict becomes:
a fact about the line, in front of the coordinator, resolved by one task that is about the sync and nothing else. (b)
pays an agent run for every clean merge in order to get the same conflict path. Section 4 is the design for (a1).

## 4. The design

### 4.1 The line-sync item

A `LAND_TASK` that ends `CONFLICT` at `MAIN_SYNC` (J-S2 paths ② and ③) opens, or adds to, the line-sync item:

| Field | Value |
|---|---|
| `kind` | `INTEGRATION_CONFLICT` (the closed set does not change) |
| `task_id` | NULL: the subject is the project branch. Observation items (`OBSERVE_LANDING`) already name no task |
| `integration_job_id` | The job that found the conflict. The hold joins through it to read `serial_key` and `phase` |
| `session_id` | That job's session (a history reference) |
| `dedupe_key` | `IMS:<serial_key>`: at most one OPEN line-sync item per line, enforced by the existing `project_open_item_open_dedupe_key` index (0278) |
| `assignee` | As §4.2 of the contract assigns every integration item: the coordinator in an Automatic project, otherwise the owner (`NO_COORDINATOR`) |
| Delivery and escalation | As every integration item: delivered to the coordinator's conversation as a turn (X-D4), or put in front of the owner when the owner holds it; escalates to the owner after `exceptionEscalationSeconds` (§4.6) |
| Work session | Never offered to a task's work session (§4.2 below) |
| `title` | `Merge conflict: syncing <upstream> into the project branch`, in `integrationItemTitle`'s pattern |
| `payload` | `phase: MAIN_SYNC`, `subject: LINE`, `targetRef`, `upstreamRef`, `upstreamSha` (U), `targetSha` (T0), `conflicts[]`, `landingSessionId`, `heldTaskIds[]` (append-only, as K4) and `attempts[]` (append-only: `{ jobId, taskId, upstreamSha, targetSha, sourceSha, conflicts }` for each conflict reported while the item is open) |

The item's message replaces `mainSyncNextStep` for these items. A draft for T5b (product copy, English):

```text
The project branch <line> could not absorb <upstream> at <U7>: merging <upstream> into its tip <T07> conflicted in
<file>, <file>, …

The conflict is between the project branch and <upstream>. No task's work caused it, and no task needs reopening or
rework: every DONE task stays as it was judged. The landings of <n> tasks wait until the project branch has absorbed
<upstream> (<title>, <title>, …). Then they go ahead by themselves, in order.

To resolve it, file one sync task with task_create, fixesOpenItemId: <itemId>. It starts from the tip of <line>,
merges <upstream> into its branch, resolves the conflicts in the files above, and commits that merge and nothing else.
Its evidence says how each file was resolved. Its landing is the only one allowed through while this item is open;
when it lands, this item closes and the waiting landings go ahead.
[Only after a failed attempt:] Start it by merging <sourceSha7>, the earlier sync task's commit: it already holds a
resolution.

If <upstream> is about to change these files itself, you can close this item instead (open_item_resolve, with your
reason). The next waiting landing then tries the sync again, and if it still conflicts, this item comes back.
```

Doors (`open-item-doors.ts`): a new source job, `LINE_SYNC`, with two cells.

- CONFLICT × COORDINATOR: open the coordinator conversation, `ask_owner`, `task_create` (non-resolving: the landing
  resolves the item), `open_item_resolve`, `open_item_hand_over`, open the landing.
- CONFLICT × OWNER: ask the coordinator again, `task_create`, `open_item_resolve`, open the landing.

The cells hold no `task_reopen`, `task_comment`, task cancel or `integration_retry`: there is no task to act on.
`sourceJobForOpenItem` maps a task-less `INTEGRATION_CONFLICT` whose phase is `MAIN_SYNC` to `LINE_SYNC`.

### 4.2 The conflicted landing is held, not failed

In the same result transaction:

- The job row stays exactly as the runner reported it (`CONFLICT`, `MAIN_SYNC`). Final rows are never rewritten (J4).
- Nothing is handed to the task's work session. `landingFixWorkSession` returns null for `phase = MAIN_SYNC`, and
  §12.3's MAIN_SYNC row goes. The task's `delivered_*` columns are not cleared, its session is not revived, and no
  landing-fix turn is sent.
- The task's next `LAND_TASK` generation is queued at once from the same source: `queueMainSyncHeld`, the twin of
  `queueBaselineHeld`, with cause `MAIN_SYNC_HELD`. The task is added to `heldTaskIds`. The new generation stays QUEUED
  under the hold (§4.3), so it never spins (the same argument as K5).
- **Exception:** a task that is itself a fix of the open line-sync item gets no queued generation. That is a sync task
  whose landing conflicted again. Its branch cannot change without a new commit, so a queued generation would meet the
  same conflict at once. The attempt is added to the item and the item is delivered again (§4.5, L-T2).

What the task looks like meanwhile:

- It is DONE.
- Its integration view reads `QUEUED`, with blocking reason `WAITING_MAIN_SYNC` naming the item (that reader exists
  today).
- `integration_retry` answers `INTEGRATION_RETRY_IN_FLIGHT`, because a generation is already queued.
- Its criterion's landing reads as in flight, not failed.
- Its dependents wait for its landing as they do for any landing (J9). No reopen blocks them again.

### 4.3 Queued landings meanwhile

While a line-sync item is OPEN on a serial key, `claimOne` claims no `LAND_TASK` on that key unless its task's
`fixes_open_item_id` names that item. Compared with M2 today:

- The exemption for the conflicted task's own later landings goes. Its held generation would meet the same conflict.
- The exemption for the item's fix tasks stays. That is how the sync lands.
- The predicate becomes a shared SQL helper, `lineSyncHoldSql`, beside `baselineHoldSql`. `claimOne` and both readers
  use it, so the reader and the claim always say the same thing (the contract's T17 rule).

When the item closes, the held landings are claimed in enqueue order (`claimOne` orders by `created_at`). Each then
finds U already in the line, so J-S2 skips, or takes a newer main in cleanly. If a newer main conflicts again, the first
landing claimed opens a new line-sync item and the rest wait again. There is never more than one item.

**Why hold the queue rather than let landings through without main (D2):**

1. **The sync is sure to land.** Under a hold the line tip does not move while the sync task works, so its branch (T0
   plus U plus the resolution) still contains T0 when it lands, and J-S2 ① lands it as it is. If landings went on, the
   line would move under it. These conflicts are most often in the append-only ledgers and inventories that every task
   edits (the migration ledger on 2026-10-03, the inventory files on 2026-11-12), so the sync task's merge onto a moved
   line would tend to conflict again: a sync that might never land while the line is busy.
2. **No runner change.** Landing without main needs a fallback path in J-S2, a new result field and a new capability,
   and older runners would still need the hold.
3. **M1 stays true.** Every landing on a project branch carries the main it fetched, so every landed task was checked
   against current main.

The cost is the wait. The line waits while the coordinator files the sync task and that task runs, is judged and lands.
That wait is no longer silent: the item reaches the coordinator as a turn, escalates to the owner after
`exceptionEscalationSeconds`, and T4 adds a notice when the line stays held past 60 minutes with the run that must act
idle (§11).

### 4.4 The sync task

The coordinator files it from the item (`task_create` with `fixesOpenItemId` = the item). Nothing about it is new:

- Its session forks from the line tip (L10). It merges `origin/<upstream>`, resolves the listed files, and commits the
  merge and nothing else.
- It is judged like any other task in its project. Its evidence lists each conflicting file and what was kept.
  Resolving a conflict is where work can be lost, so a judgment is worth its time here.
- When it is DONE, J-T1a queues its landing, and `claimOne` claims it despite the hold because it fixes the item.
- The runner lands it by J-S2 ① (both tips are in its branch) or ② (main moved on; the newer main is merged into its
  branch, and lands if clean), then J-S4 MERGE. The landing check runs on the merged tree.
- Its `LANDED` closes the item (§4.5, L-T3).

One sync task per item: the message says so, and names any fix task already filed against it (`fixingTasks`).

### 4.5 How the item ends

| # | Fact | Item | Queue |
|---|---|---|---|
| L-T1 | No OPEN line-sync item on the serial key, and a `LAND_TASK` ends `CONFLICT` at `MAIN_SYNC` | Opened (§4.1), with the task in `heldTaskIds` | The task's next generation is queued and held (§4.2); every other landing is held |
| L-T2 | The item is OPEN, and a claimed landing ends `CONFLICT` at `MAIN_SYNC` (only a fix can be claimed) | The attempt is added and the item is delivered to its holder again: `assigned_at` moves, `waiting_since` and `escalate_at` stay, because the line has been held since L-T1 | Nothing is queued for a fix task (§4.2) |
| L-T3 | The item is OPEN, and a `LAND_TASK` on the serial key ends `LANDED` | `RESOLVED`, `LANDED`, by `PLATFORM`, with `resolved_by_job_id` = that job | The hold lifts; the held landings are claimed in enqueue order |
| L-T4 | The item is OPEN, and the coordinator or the owner calls `open_item_resolve` | `RESOLVED`, `HANDLED` | The hold lifts; the first landing claimed tries the sync again, and L-T1 follows if it still conflicts |
| L-T5 | The item is OPEN, and the sync task's landing ends `CHECK_FAILED` or `ERROR` | Unchanged. The failure opens its own item about the sync task, as today | Still held |

**Why L-T3 is a sound close without git on the server.** Every `LANDED` `LAND_TASK` on a project branch contains the
upstream tip its own fetch read: J-S2 makes sure of it on all three paths. That fetch came after the fetch that
conflicted, and main only moves forward. While the item is open, only its fix tasks are claimed. `ALREADY_LANDED` and
`NOTHING_TO_LAND` push nothing, so they do not close the item.

### 4.6 Edge cases

1. **Main moves again and touches the resolution while the sync task lands.** J-S2 ② conflicts, which is L-T2. The
   coordinator files a new sync task with `supersedesTaskId` = the old one, whose delivery never landed. The new task
   starts by merging the old one's commit (`attempts[].sourceSha`), so the resolution is reused rather than redone. No
   DONE task is reopened.
2. **Main fixes the conflict itself.** The coordinator closes the item (L-T4), and the next held landing takes main in
   cleanly. The platform does not watch main for this (M4).
3. **A red-baseline item (K4) is open at the same time.** Each hold exempts only its own item's fix tasks. A baseline
   fix whose landing needs main conflicts and is held by the sync item; a sync task whose landing is red on the
   baseline is held by K4 (K5). Each item waits on the other's fix, and the coordinator holds both. It gets out by
   closing one of them by hand, or by filing one task that does both jobs against the sync item after closing the
   baseline item. Nothing loops, because T5b keeps one invariant: a held generation is never queued for a task that the
   hold in question exempts. **Check this before copying K5:** K5 appears to queue the next generation of a baseline fix
   task whose own landing is still red, although K4 exempts that task (`integration-job-relay.ts:3274`,
   `baseline-hold.ts`). If so, that generation is claimed at once and runs the same red check again. No spec covers the
   case. T5b confirms it with a spec, and must not repeat it for `MAIN_SYNC_HELD`.
4. **Somebody reopens or cancels a held task.** J-T8 ends its queued generation, as today. The item stays, because it is
   about the line. `heldTaskIds` is history; the number of waiting landings the message and card show is read from the
   QUEUED rows the hold holds.
5. **A promotion while the item is open.** A PROJECT_BRANCH candidate's check would meet the same conflict and open the
   promotion's own CONFLICT item, whose door is also a sync task. K7 builds candidates only when the project's criteria
   are met or on the coordinator's request, so the two rarely meet. When they do, the sync task's landing makes the next
   candidate by itself. T5b leaves promotions as they are.
6. **Two projects on one repository.** The serial key includes the target ref (`project/<id>`), so items and holds are
   per line.
7. **Items opened before T5b deploys.** These are task-level MAIN_SYNC items. They keep their cell, their doors and the
   old M2 predicate, with its same-task exemption, until they close. Two bridge rules keep them from needing a reopen.
   First, a line-sync fix task is also exempt from a legacy MAIN_SYNC hold on its serial key. Second, whenever a
   `LAND_TASK` on a serial key ends `LANDED`, the platform queues the next landing generation of each task whose OPEN
   legacy MAIN_SYNC item is on that key: the line now has main, so that landing no longer meets the conflict, and when
   it lands the existing rule closes the legacy item. With these, a sync task filed against a legacy item resolves it
   too. T5b first runs the read-only query in Appendix A on production. If it returns no rows, the bridge is not built,
   and the deploy note says so.

### 4.7 What does not change

- J-S2's clean sync, checked together with the task (M1).
- M4: there is no clock, and a move of main does nothing until the next landing.
- J1, J2 and W0: the platform pushes only what it tested.
- K3, K4 and K5 for a red baseline.
- W4–W7 for REBASE and MERGE conflicts and for red checks. Those are in the task's own work, and still go to its session
  first.
- Promotion conflicts and their sync-task door.
- MAIN lines.

## 5. Migration impact

One migration. Its number comes from the collision scan at implementation time (main, `project/*` and pushed `orbit/*`;
main is at 1560 on the baseline). It changes two constraints, the way 0518 and 1101 did:

- `project_integration_job_event_enqueue_cause_chk`: add `MAIN_SYNC_HELD` (drop and re-add).
- New `project_integration_job_event_main_sync_held_chk`: the cause `MAIN_SYNC_HELD` appears only on a `LAND_TASK`'s
  `ENQUEUED` event, the twin of 0518's `project_integration_job_event_baseline_held_chk`.

Nothing else:

- `project_open_item` already allows a NULL `task_id` on integration kinds and already has the unique open-dedupe index.
- `INTEGRATION_CONFLICT`, and the job kinds, states and phases, are unchanged.
- `retry_failure_class_chk` is untouched: a held generation writes no `retry_*` columns, as in K5.
- No backfill (legacy items: §4.6, item 7).

The `schema.prisma` comments on `project_open_item.task_id` and `dedupe_key` gain the line-sync case.

For comparison: (a2) would widen `project_integration_job_kind_chk` and add a unique index for one queued sync per
serial key. (b) would add a `CreatorType` value, which is an enum migration, plus rules for platform-filed tasks.

## 6. runner-go impact

- **`integrate.go`: no change.** Paths ① and ② already land a sync task's branch by MERGE, and the item and the hold are
  the server's. Older runners behave the same, so no capability is needed.
- **Tool text.** `operation_catalog.go:2209`, the `integration_retry` description, tells agents to `task_reopen` for a
  MAIN_SYNC conflict. It must describe the line-sync item and its sync task instead. `task_create`'s `fixesOpenItemId`
  text already fits ("an OPEN integration … item").
- **Tests.** One new case in `integrate_test.go` (§9, R1), then the full `go test ./...`. The apiserver specs that read
  runner-go sources pin catalog text, so they run too, and any server-mirrored fixtures are regenerated.

## 7. Contract changes

One new revision of `docs/project-integration-line-contract.md` (45, unless another lands first):

- §3.1 M2: the hold belongs to the line-sync item; no same-task exemption; one item per line (`IMS:<serial_key>`).
- §3.1 M3: replaced. A conflict opens the line-sync item, the conflicted landing is held, and a sync task resolves it.
  "The coordinator writes `task_comment`, then `task_reopen`" and the 2026-11-18 `integration_retry` exception apply to
  legacy items only.
- §4.2: the item's row (a task-less `INTEGRATION_CONFLICT`, its key and payload) and its closing edges (L-T3, L-T4).
- §4.7: the `LINE_SYNC` cells. The first of "the two conflict remedies" becomes the sync task.
- §2.3 J-T1a: `MAIN_SYNC_HELD` beside `BASELINE_HELD`.
- §12.3: the `LAND_TASK · CONFLICT · MAIN_SYNC` row now goes to the coordinator, as a line-sync item.
- Appendix B: the revision entry, naming this note.

## 8. What T5b builds

apiserver:

1. `runner-api/integration-job-relay.ts`, `applyIntegrationJobResult` (`:2157`; its item code is at `:3150`–`:3300`).
   For a `LAND_TASK` `CONFLICT` at `MAIN_SYNC`: skip `landingFixWorkSession`; call `recordLineSyncConflict` to open the
   item or add to it; call `queueMainSyncHeld` unless the task fixes the open item. On `LANDED`, call
   `resolveLineSyncOnLanding` (L-T3) beside `resolveIntegrationItemsOnLanding`.
2. `runner-api/integration-job-relay.ts`, `claimOne` (`:785`–`:822`): replace the M2 clause by `lineSyncHoldSql('c')`
   for task-less items, and keep the old clause for task-level (legacy) items.
3. New `projects/line-sync-hold.ts` with `lineSyncHoldSql`, shared with `project-task-integration.ts` (the `sync_block`
   at `:539`/`:625`) and `project-integration-line.ts` (`:1098`).
4. `projects/project-integration-job.ts`: `queueMainSyncHeld` beside `queueBaselineHeld` (`:1110`).
   `landingFixWorkSession` (`:1227`) takes the job's phase and returns null for `MAIN_SYNC`.
5. `projects/project-integration-event.ts`: `EnqueueCause` (`:179`) gains `MAIN_SYNC_HELD`, with its enqueued text.
6. `projects/project-open-item.ts`: `recordLineSyncConflict`, `resolveLineSyncOnLanding`, the title, `lineSyncNextStep`
   (the message in §4.1), the card's facts, and the count of waiting landings.
7. `projects/open-item-doors.ts`: the `LINE_SYNC` source job, its two cells, and `sourceJobForOpenItem`.
8. `projects/project-integration-retry.ts`: the refusal for a task whose landing is held behind a line-sync item names
   the item, and says the landing goes ahead by itself once the sync lands.
9. `common/db-write-inventory.ts`: the new write sites.
10. `prisma/schema.prisma` comments and the migration (§5).

runner-go: §6. Docs: the contract revision (§7). The bridge for legacy items only if Appendix A finds any (§4.6, item 7).

## 9. Specs

The criterion's verification asks for an integration spec where main moves, a conflicting file is resolved through the
new path, and the original task stays DONE. It has two halves:

- **R1, runner-go** (`integrate_test.go`; the name is indicative: `TestIntegrationHeldLandingLandsAfterSyncTask`).
  Use the `contestedLine` fixture. Task X's landing ends `CONFLICT` at `MAIN_SYNC`, with the ledger in `Conflicts`. A
  sync branch cut from the line tip merges main and resolves it (`absorbMain`). Its landing is `LANDED` by MERGE, with
  no MAIN_SYNC phase. X's landing then runs again with the same command, the same source SHA and X's branch untouched,
  and is `LANDED` with no MAIN_SYNC phase. The line holds X's work, main's tip and the resolution, and the old line tip
  is an ancestor.
- **P1, apiserver**: a new `line-sync-hold.pg.spec.ts`, modeled on the K4/K5 cases in `integration-retry.pg.spec.ts`.
  1. X is DONE and its landing reports `CONFLICT` at `MAIN_SYNC`. Exactly one OPEN `INTEGRATION_CONFLICT` exists, with
     `task_id` NULL, key `IMS:<serial>` and assignee `COORDINATOR`, delivered to the coordinator.
  2. X is still DONE, its `deliveredSha` is unchanged, and it has the same epoch and `attemptGeneration`. No work
     session was offered, no landing-fix turn sent, and no `task_reopen` recorded.
  3. X's next generation is QUEUED with cause `MAIN_SYNC_HELD`. Y's DONE landing is QUEUED and not claimed. Both read
     `WAITING_MAIN_SYNC`, naming the item.
  4. The item's doors hold no `task_reopen` and no `task_comment`. `integration_retry` on X answers
     `INTEGRATION_RETRY_IN_FLIGHT`.
  5. A sync task S filed with `fixesOpenItemId` is claimed despite the hold and reports `LANDED`. The item is now
     `RESOLVED`, `LANDED`, by `PLATFORM`.
  6. X's and Y's landings are claimed in enqueue order and land. X is DONE throughout, and its criterion's landing reads
     `LANDED`.
- **P2**, same file: S's landing conflicts at `MAIN_SYNC` against a newer main. No second item opens, the attempt is
  added, the item is delivered again, nothing is queued for S, and nothing can be claimed.
- **P3**: closing the item by hand releases the queue. When the next landing conflicts, a new item opens; there is never
  more than one OPEN.
- **P4**: a K4 item and a line-sync item open together. No job is claimed twice with the same source (no spin), and the
  K5 question of §4.6, item 3, is answered.
- **P5**: a legacy task-level MAIN_SYNC item keeps its old predicate, cell and doors, and the bridge if it is built.
- **Unit specs**: `open-item-doors.spec.ts` (the census gains `LINE_SYNC`), `project-integration-retry.spec.ts`,
  `open-item-required-action.spec.ts`.
- **Existing specs that pin today's MAIN_SYNC path**, to be updated or narrowed to legacy items:
  `reopen-landing-handling.pg.spec.ts`, `landing-fix-work-session.pg.spec.ts`, `integration-retry.pg.spec.ts`,
  `project-exception-todos.pg.spec.ts`, `project-task-integration.pg.spec.ts`, `project-task-integration.spec.ts`,
  `project-integration-inflight.pg.spec.ts`, `codex-capacity-retry.pg.spec.ts` and `landing-fix-turn.pg.spec.ts`.
- **T4's pg spec, run with a line-sync item** (§11).

The merge check is the project's (`bash scripts/worktree-overlay.sh && npm run build && npm run test -w
@orbit/apiserver`). The pg specs need a real Postgres (`scripts/run-pg-spec.sh`), or a PostgreSQL shard of `ci.yml` on a
probe branch.

## 10. UI

None is needed, so there is no design board:

- Task-less integration items already render on all three clients. Observation items name no task; web reads
  `row.taskId` as optional, the Apple model decodes `taskId` as optional, and Android checks it before each task verb.
- The card is drawn from the server's title, message, facts and doors.
- Waiting landings already read `WAITING_MAIN_SYNC`.
- No new action type is added.

If the owner later wants the waiting tasks listed as links on the card, the way the baseline card lists `heldTaskIds`,
that is a separate design board.

## 11. Interaction with T4

T4 notifies the coordinator when an open item holds other landings and the run that must act has been idle for more than
60 minutes, and the owner after `exceptionEscalationSeconds`. A line-sync item names no task, so for it "the run that
must act" is the work session of its newest open fix task, or the coordinator before any is filed. The item's delivery
has already woken the coordinator by then. Whichever of T4 and T5b lands second runs T4's spec with a line-sync item.

## 12. Alternatives not adopted

1. **(b): every sync is a platform-filed task.** See §3.
2. **The platform files the sync task itself when a sync conflicts (D3).** It saves one coordinator turn. But it needs
   the platform as a task author, which does not exist; it spends an agent run that nobody approved, going around the
   owner's task card; and it takes the choice away from the coordinator, which may prefer to wait for main or to combine
   the sync with other work. The item reaches the coordinator as a turn within minutes, so little is saved. It can be
   reconsidered once T4's notices show how long coordinators take.
3. **Landing queued work without main while a conflict is open (D2).** See §4.3.
4. **A `SYNC_UPSTREAM` job of its own (a2).** See §3.1.
5. **Keeping revision 42's hand-off for MAIN_SYNC.** It reworks a finished task's branch and identity for a conflict
   that is not in its work; the criterion rules that out.
6. **The platform resolving conflicts itself** (`git rerere`, `-X ours`/`-X theirs`). Against G4 and W0: the platform
   never decides what a resolution contains, and a wrong resolution would land checked but silently wrong.
7. **Syncing late** (never take main in until the promotion). The line would drift for days, and ledgers and migration
   numbers would collide late. It contradicts K7's premise that each landing keeps the line close to main.
8. **Letting `integration_retry` rerun the conflicted task's landing once a sync has landed.** Somebody would still have
   to remember to press it, once for each held task. The held generation does it from a committed fact.

## Appendix A. Read-only query: legacy MAIN_SYNC items still open

Run before T5b deploys (§4.6, item 7). It reads only.

```sql
SELECT i.id, i.project_id, i.task_id, i.assignee, i.created_at
  FROM project_open_item i
  JOIN project_integration_job f ON f.id = i.integration_job_id
 WHERE i.kind = 'INTEGRATION_CONFLICT'
   AND i.state = 'OPEN'
   AND f.kind = 'LAND_TASK'
   AND f.phase = 'MAIN_SYNC'
 ORDER BY i.created_at;
```
