# Scheduled tasks: design (v1, revision 4)

**Status:** **decided** (owner, 2026-11-14), nothing built. Boards: `docs/mocks/scheduled-tasks/`.

Owner decisions of 2026-11-14, all kept:

- no deploy level in v1;
- repeated failures notify and never pause the schedule by themselves;
- run sessions stay out of the session list, and a run that finds nothing new completes its session;
- scheduled tasks live in the left drawer, next to Projects, Tasks, Waiting on you and Wiki, across every workspace;
  nothing about them appears in a workspace's session list;
- there is no form: a person says what they want and an agent fills in the schedule;
- the Scheduled page follows macOS Reminders' *Scheduled* list: a timeline grouped by day, past runs ticked off, an
  inspector instead of a page, a quick-add line that takes a sentence;
- revision 4's D1–D4, all as recommended (§13).

**Revision 4** derives the whole design from one rule (§2) instead of applying it surface by surface. What that
adds to revision 3:

| | Addition | Section | Decision |
| --- | --- | --- | --- |
| 1 | The schedule keeps the person's own words (`intent`) next to the prompt the agent wrote | §3, §8.1 | |
| 2 | An **envelope**: workspace, access, runs per week, run limit. One rule decides every card | §4 | D1 |
| 3 | The creating agent does the check once and hands over a **baseline**, shown on the card | §8.1 | D2 |
| 4 | A one-off rule (`ONCE`) | §5.1 | D3 |
| 5 | A run leaves a **note** for the next run, and may tune or end its own schedule inside the envelope | §7.1, §8.3 | D4 |
| 6 | Approvals answered with "don't ask again" hold for later runs (existing workspace rules) | §6.4 | |
| 7 | Which of Orbit's four timers an agent should reach for | §1 | |

## 1. Why, and which timer

A user wants recurring work that outlives any conversation:

> Every day at 10:00 Beijing time, check the Codex stable release against the version the apiserver pins. Stay
> silent when nothing changed; when there is a new release, report the version and its release notes.

Orbit already has three timers. An agent picks among four, and the tool descriptions say so in these words:

| The person wants | Use | Why not a schedule |
| --- | --- | --- |
| "keep checking while we work on this" | `schedule_wakeup({recurring: true})` ([long-running-loop-contract.md](./long-running-loop-contract.md)) | it belongs to this conversation and should end with it |
| "tell me when that task or session gets there" | `task_await`, `session_await`, `watch_create` ([watch-contract.md](./watch-contract.md)) | it waits for a state, not for a time |
| "start this task on Friday" | `Task.runAt` | the work is a deliverable: it wants evidence, a verdict and a landing |
| "do this every morning", "check at 18:00 and tell me" | **a schedule** | |

`Task.runAt` cannot become the fourth: the first accepted run sets it back to NULL, and its schema comment says it
"can never become a recurrence by accident". A Task per run would also fill task lists with work that is mostly
"nothing changed".

So a schedule is its own object. A session is only where one run happens. Closing the chat that created a schedule,
or archiving or deleting a run's session, never cancels the schedule.

## 2. Agent-first, applied

The rule, in the owner's words: a person answers only for the goal, the risk, the budget and the authority that
cannot be delegated; inside that envelope the agent is free; what a person has allowed once is not asked again.

Every part of a schedule belongs to one side:

| | The person | Where it shows |
| --- | --- | --- |
| Goal | says it once, in their own words | kept verbatim as `intent`; the card reads it back |
| Risk | agrees to an access level | one line on the card |
| Budget | agrees to how often and how long | one line on the card |
| Authority | presses **Create**, and **Allow** when the envelope grows | the only two presses |

| | The agent | Where it shows |
| --- | --- | --- |
| Wording | title, prompt, the key that tells "new" from "seen" | inspector, *What it does* |
| Rhythm | rule, time zone, first run | card, *When* |
| Starting point | does the check once and records the baseline | card, *Today* |
| Memory | a note from each run to the next | inspector, *Notes for the next run* |
| Tuning | rewrites its prompt, backs off, ends itself when the goal is reached | history, each with **Undo** |
| Telling | decides whether a run found something new | push only then |

Three consequences follow, and the rest of the document is their detail:

1. **Said, not configured.** No surface has a field. Changes are said in any session ("make it 9:00", "only on
   weekdays", "stop opening PRs"). The page is for reading and stopping.
2. **One rule for cards.** A change that stays inside the envelope applies at once, is recorded and can be undone. A
   change that grows it waits for one press (§4). Nothing else asks.
3. **A person hears from a schedule only when it found something new or needs them** (§7.3). There is no notify
   setting.

## 3. Concepts and model

- **Schedule:** a goal, a rhythm and an envelope. It lives until paused, ended or deleted.
- **Run:** one firing. Every firing writes a run, including the ones skipped, missed or held, so a gap is visible.
- **Finding:** something a run reported as new, under a key the run chose (`codex@0.48.1`). One finding per key per
  schedule. It is what makes "tell me once" possible.

```text
Schedule
  id, ownerId, workspaceId, agentId?                   from the session that created it
  intent                                               the person's words, verbatim
  title, prompt                                        written by the agent
  rule          { kind: ONCE, at }
                { kind: DAILY, time }
                { kind: WEEKLY, time, weekdays[] }
                { kind: CRON, expr }                   P3
  timezone      IANA name
  startAt, endAt?
  accessLevel   CHECK_ONLY | OPEN_PR
  runLimitMinutes                                      default 30
  envelope      { workspaceId, accessLevel, runsPerWeek, runLimitMinutes }     §4, written only by a press
  state         ACTIVE | PAUSED | HELD | ENDED
  heldReason?, endedReason?                            DELETED | END_REACHED | GOAL_REACHED
  note?                                                the last run's note to the next, at most 2000 characters
  revision                                             +1 on every change
  nextDueAt                                            NULL unless ACTIVE
  consecutiveFailures
  createdFromSessionId?                                provenance only

ScheduleRevision                                       one row per change, shown in the history
  scheduleId, revision, changedBy (USER | SESSION | RUN), sessionId?, fields{before, after}, createdAt

ScheduleRun
  id, scheduleId, scheduleRevision
  plannedAt                                            the slot it fires for (UTC)
  trigger       SCHEDULED | CATCH_UP | MANUAL
  state         QUEUED | RUNNING | AWAITING_APPROVAL
                | NO_CHANGE | CHANGED | FAILED          ended by a report or by failing
                | SKIPPED | MISSED | HELD | CANCELLED   ended without a session doing the work
  attempt
  startedAt?, endedAt?, sessionId?
  key?, summary?, links[]                              from the run's report
  failureReason?                                       closed set, §7.2

ScheduleFinding
  scheduleId, key, firstRunId?, lastSeenRunId?, notifiedAt?, links[]
```

There is no notify field and no runner field: §7.3 decides who hears, and a run goes to any online runner the
workspace can use.

Constraints:

- `unique(scheduleId, plannedAt)` for SCHEDULED and CATCH_UP runs: two workers, or one worker after a restart, write
  one run for a slot. MANUAL runs are left out of the index.
- At most one run in `RUNNING | AWAITING_APPROVAL` and at most one `QUEUED` per schedule (partial unique indexes).
- `unique(scheduleId, key)` on findings.
- `SessionRunSource` gains `SCHEDULE` (today: `MANUAL`, `TASK_LIST_AUTO`, `PROJECT_COORDINATOR`), and `Session`
  gains `scheduleRunId?`.
- At most 50 schedules that are not ENDED per account (`SCHEDULE_LIMIT`).

## 4. The envelope

The envelope is what a person agreed to on a card. It has four parts and nothing else is in it:

| Part | Wider means | On the card |
| --- | --- | --- |
| workspace | a different workspace | *Runs in* |
| access level | `CHECK_ONLY` → `OPEN_PR` | *May* |
| runs per week | more of them (weekly → daily is 1 → 7) | *Costs* |
| run limit | a longer run (default 30 minutes, at most 2 hours) | *Costs* |

The rule, checked by the server on every `schedule_create` and `schedule_update`:

- **Inside the envelope:** the change applies at once. It writes a `ScheduleRevision` naming who made it, shows in
  the history, and has **Undo**. Prompt, title, time of day, weekdays, time zone, end time, fewer runs, a shorter
  limit and a narrower access level are always inside.
- **Outside:** the change waits on a card that shows *now* and *asked*. Pressing **Allow** applies the change and
  writes the new envelope. Nothing but a press writes the envelope, and the press is an owner-channel action: a
  session or a personal access token cannot make it.
- **A person's narrowing shrinks the envelope; a run's own narrowing does not.** "Stop opening PRs", said in a
  conversation, sets the envelope's access to `CHECK_ONLY`: going back needs a card. A run that backs its own
  schedule off from daily to weekly (§8.3) leaves the envelope at 7 runs a week, so it, or any session, may return
  to daily without asking. What was allowed is not asked twice; what was taken back is.
- A session cannot ask for an envelope wider than its own permission mode
  (`PERMISSION_MODE_WIDER_THAN_SESSION`, the rule in `common/permission-mode.ts`).

The budget is counted in runs and minutes, not in money, because a subscription account reports no cost per run.
The inspector shows what was used: "This month: 14 runs · 41 min", with a cost where the engine reports one.

A run that reaches its limit is interrupted and fails with `RUN_LIMIT`. The schedule goes on.

## 5. Firing

A worker reads `Schedule WHERE state = 'ACTIVE' AND nextDueAt <= now()`. For each due schedule, in one transaction:

1. Insert the run for `plannedAt = nextDueAt`. A conflict on `(scheduleId, plannedAt)` means another worker already
   fired this slot: stop there.
2. Advance `nextDueAt` to the next slot after now, in the schedule's time zone. Past `endAt`, or after a `ONCE`
   rule's only slot, the schedule becomes ENDED (`END_REACHED`).
3. Apply overlap: when a run is RUNNING or AWAITING_APPROVAL, the new run is QUEUED. When one is already QUEUED, the
   older queued run becomes SKIPPED and the new one takes its place. There is never more than one waiting.

A QUEUED run starts when the run ahead of it ends. Starting a run (§6) happens outside this transaction.

### 5.1 Time

- `nextDueAt` is computed from `rule` and `timezone`, never as a number of seconds, so 10:00 stays 10:00 across DST.
- A local time that does not exist that day moves to the first valid minute after it. A time that happens twice
  fires on the first one.
- The time zone is the one the person named ("Beijing time"); when they named none, the one of the device that
  pressed **Create**.
- `ONCE` is a schedule with one slot: "check at 18:00 whether the deploy is healthy and tell me". It differs
  from `Task.runAt` in what it produces: a report, not a deliverable.

### 5.2 Missed slots

A slot is missed when its run could not start near its time: the runner was offline, the apiserver was down,
dispatch was paused, the account's quota was exhausted.

- On recovery only the **latest** missed slot runs (`CATCH_UP`, with its original `plannedAt`). Earlier ones are
  recorded MISSED. Nothing replays a backlog.
- Catch-up reaches back one period (24 hours for `ONCE`). An older slot is recorded MISSED and the schedule waits
  for its next slot. A missed `ONCE` notifies, because nothing else will run.
- A run shows both `plannedAt` and `startedAt`, so a late run says it was late.

## 6. Starting a run

### 6.1 Checks, every time

A card is not standing permission for a world that has changed. Before each run starts the server checks again:

- the owner still owns the workspace, the workspace is not deleted, the agent exists and is enabled;
- the schedule is inside its envelope, and the mode for its access level is still within the account's default mode;
- for `OPEN_PR`: the workspace still has a repository.

When a check fails the run is HELD with the reason, the schedule moves to HELD, and the owner gets an item in
**Waiting on you**. A HELD schedule fires nothing until it is resumed. It is never retried in silence.

### 6.2 Access levels

The agent picks the level from what the intent needs: a check, a report or a summary is `CHECK_ONLY`; "open a PR",
"bump it", "fix it" is `OPEN_PR`.

| Level | Card says | Session | May not |
| --- | --- | --- | --- |
| `CHECK_ONLY` | "reads and reports, edits nothing" | `plan` mode, no worktree | edit files, create tasks |
| `OPEN_PR` | "edits in its own worktree and opens a PR; can't merge or deploy" | `acceptEdits` mode, own worktree | `session_merge`, release and deploy tools |

- A level is a claim to the person, so it is enforced, not prompted: the mode above, plus `disallowedTools` on the
  run's session for the *May not* column.
- The mode is resolved per engine through `permissionSemantics.ts`. An engine that cannot enforce a level (DeepSeek
  Harness has no Plan or Accept Edits) gets the nearest mode that is not wider, and when there is none
  `schedule_create` is refused with `SCHEDULE_ACCESS_NOT_ENFORCEABLE`. The agent tells the person which engine
  can.
- Deploy is not a level in v1.

### 6.3 Session

The run gets a new session in the schedule's workspace, with `runSource = SCHEDULE` and `scheduleRunId` set. Its
first turn carries a block written by the control plane, then the prompt:

```text
<scheduled-run>
  Run 41 of "Codex stable check", planned 2026-11-15T02:00:00Z (10:00 Asia/Shanghai), started 02:00:07Z.
  The person asked: "每天北京时间 10 点检查 Codex 官方稳定版…"
  Last run: NO_CHANGE on 2026-11-14.
  Already reported (do not report again; link these instead of opening new ones):
    codex@0.48.0  baseline
  Note from the last run: release notes moved to github.com/openai/codex/releases, the old changelog URL is 404.
  Access: CHECK_ONLY. Limit: 30 minutes.
  When you are done, call mcp__orbit__schedule_run_report exactly once.
</scheduled-run>
<the schedule's prompt>
```

A fresh session per run keeps each run's context small. What carries over is on the schedule: the intent, the
findings and the note.

### 6.4 Approvals while nobody is watching

- A run that hits an approval card moves to AWAITING_APPROVAL and the card goes to **Waiting on you**.
- Answering it with "don't ask again" writes a `WorkspacePermissionRule`, as it does in any session. Rules are
  workspace-scoped and handed to every session of the workspace, so **the next run does not stop there**. The card
  says so: "Later runs won't ask for this."
- When nobody answers within 2 hours the run fails with `APPROVAL_TIMEOUT` and its session is interrupted. A run
  never hangs on a card.

## 7. Ending a run

### 7.1 The report

`schedule_run_report({outcome, key?, summary, links?, note?})`, only from a session serving a run, once per run.

- `outcome`: `NO_CHANGE`, `CHANGED` or `FAILED`. `CHANGED` requires a `key`.
- `note` replaces the schedule's note. It is for what the next run should know and the prompt does not say: a moved
  URL, a rate limit, where it left off.
- The report ends the run. The session's turn may go on, but nothing after it changes the run.
- A session that ends or settles idle without a report fails the run with `NO_REPORT`. Silence never reads as "no
  change".

### 7.2 Failure reasons and retries

| `failureReason` | Retried | Meaning |
| --- | --- | --- |
| `RUNNER_UNAVAILABLE`, `QUOTA`, `ENGINE_CRASHED_BEFORE_START` | yes | the run never reached the engine (no `delivered_at` on its first turn) |
| `REPORTED_FAILED`, `NO_REPORT`, `ENGINE_CRASHED`, `APPROVAL_TIMEOUT`, `RUN_LIMIT` | no | the work started and may have had effects |
| `CANCELLED_BY_OWNER` | no | the owner stopped this run |

- Retry: up to 3 attempts (after 1, 5 and 15 minutes), inside the catch-up window.
- `consecutiveFailures` counts FAILED runs in a row and resets on NO_CHANGE or CHANGED. At 3 the notification says
  "failed 3 runs in a row". The schedule is **not** paused.
- SKIPPED, MISSED and HELD runs are not failures.

### 7.3 Who hears

| Run ends | Notified | Where |
| --- | --- | --- |
| NO_CHANGE | no | |
| CHANGED, new key | once | push, opens the run's session |
| CHANGED, known key | no; `lastSeenRunId` moves and `links` merge | |
| FAILED | yes | push and **Waiting on you** |
| HELD, AWAITING_APPROVAL | yes | push and **Waiting on you** |
| the run ended its own schedule (§8.3) | once | push, opens the schedule |

- "Tell me every day" needs no setting: the agent writes a prompt that reports each run as CHANGED with a key per day
  (`summary@2026-11-15`).
- A run that creates a task uses `idempotencyKey = schedule:<scheduleId>:<key>`, so one release never gets a second
  upgrade task.
- Agents read the same record: `schedule_get` returns the last result, the findings and the note, so any session can
  answer "what did the nightly check find this week?".

### 7.4 The run's session afterwards

- Run sessions do not appear in the session list. They are reached from the schedule's history and from the
  notification.
- A NO_CHANGE run completes its session. CHANGED and FAILED runs leave it open for follow-up questions.
- Archiving or deleting a run's session keeps the run row; the run shows its session as gone.

## 8. Creating and changing

### 8.1 Creating

1. The person says it, in any session.
2. When the session can, the agent **does the check once, right there**, and answers with today's result. This is
   the baseline.
3. The agent calls `schedule_create({intent, title, prompt, rule, timezone?, accessLevel, runLimitMinutes?,
   baseline?: {key, summary, links?}})`. Workspace and agent are the calling session's. It asks back only when
   something a person owns is missing ("how often?"), never for a field.
4. The session shows one card. It has no fields and one press:

   ```text
   Create scheduled task?
   Codex stable check
   Every day at 10:00 Beijing time I check the latest stable Codex against the version the apiserver pins,
   and tell you only when there is a new one.

   When      Daily 10:00 · Asia/Shanghai · first run tomorrow
   Runs in   apiserver · Codex agent
   May       Check only · reads and reports, edits nothing
   Costs     Up to 7 runs a week, 30 min each
   Today     Codex 0.48.0, same as pinned. Nothing to report.

   You'll hear about new versions and failures only.            [Not now]  [Create]
   ```

5. **Create** writes the schedule and its envelope. The baseline becomes a finding already marked as told, so the
   first run does not announce today's state as news.

A baseline is optional: a session that cannot do the check (wrong workspace, no network) leaves it out, the card
has no *Today* line, and the first run's finding notifies like any other.

Agents propose schedules too: a coordinator that needs a nightly check, or a session that sees the person asking
for the same thing a third time. The proposal is the same card.

From the Scheduled page, the quick-add line does the same without leaving it: the sentence starts a session in the
workspace shown on the line, that session calls `schedule_create`, and the proposal appears as a draft row whose
inspector carries the card (**Create** / **Not now** / **Open conversation**). The session is an ordinary one and
stays in its workspace's session list, because the person started it.

### 8.2 Changing

Any session of the owner may call `schedule_update`. §4 decides whether it applies at once or waits on a card. A run
in progress keeps the revision it started with.

- `intent` changes only when the person restates the goal. An agent rewriting its `prompt` leaves the intent as it
  was, so the history always shows what was asked next to what is being done.
- In the inspector, **Change…** opens a new session in the schedule's workspace with the schedule attached, and the
  person types what to change.

### 8.3 A run changing its own schedule

A run's session may call `schedule_update` and `schedule_end` on the schedule it serves, inside the envelope:

- rewrite the prompt ("the changelog moved; check the releases page");
- run less often, and later return to anything up to the envelope;
- end the schedule when the goal is reached ("the migration shipped; nothing left to watch"): ENDED
  (`GOAL_REACHED`), one notification, **Undo** resumes it.

Each is a `ScheduleRevision` with `changedBy = RUN` and **Undo**. A run asking to widen its envelope gets the card of
§4 in **Waiting on you**, and finishes under the access it has.

### 8.4 Direct controls

| Action | Effect |
| --- | --- |
| Pause | ACTIVE → PAUSED, `nextDueAt` = NULL, a QUEUED run becomes CANCELLED. A RUNNING run continues. |
| Resume | PAUSED or HELD → ACTIVE, next slot after now. From HELD the §6.1 checks run first. Slots missed while paused are not caught up. |
| Run now | Writes a MANUAL run under the overlap rule. Allowed when PAUSED; refused when ENDED. Does not count against runs per week. |
| Stop this run | Interrupts the run's session, run → CANCELLED (`CANCELLED_BY_OWNER`). The schedule is unchanged. |
| Delete | ENDED (`DELETED`), a QUEUED run is cancelled, a RUNNING one continues. Runs and findings are kept. |

Agents have the same five as tools, so "pause the Codex check until Monday" works from a chat.

## 9. Surfaces

### 9.1 API and tools

- MCP: `schedule_create`, `schedule_update`, `schedule_list`, `schedule_get`, `schedule_pause`, `schedule_resume`,
  `schedule_run_now`, `schedule_run_stop`, `schedule_end`, `schedule_delete`, and `schedule_run_report` (run
  sessions only). The descriptions of `schedule_create` and `schedule_wakeup` carry the table of §1.
- REST: `GET /api/schedules`, `GET /api/schedules/:id`, `GET /api/schedules/:id/runs`,
  `POST /api/schedules/:id/{pause,resume,run,undo}`, `DELETE /api/schedules/:id`, `POST /api/schedule-runs/:id/stop`.
  There is no REST door that creates or changes a schedule: those go through a session and its card.

### 9.2 Clients

As decided in revision 3, modelled on Reminders' *Scheduled* list:

- **Left drawer:** a **Scheduled** item with a count of schedules that need the person (failing or held).
- **Timeline:** occurrences grouped as **Needs you**, **Today**, **Tomorrow**, the rest of the week, **Later**,
  **Paused**. A row is a circle that carries the state, the title, a line with the rule, the workspace and the
  access, and the time. **Show past runs** puts earlier runs back, ticked off. A workspace filter sits in the header.
- **Inspector** (beside the list on web and macOS, a sheet on iOS): the read-back sentence, next run, last result,
  *What was asked* (the intent), *Notes for the next run*, this month's use, history (runs and revisions with
  **Undo**, each naming who made it: you, a session, or a run), the controls of §8.4 and **Change…**.
- **Quick-add line** at the end of the list: "Describe a scheduled task…" with the workspace it will use.
- **Sessions:** the create card, the change line with Undo, the widen card; on a run's session a header naming the
  schedule and the report card.
- **Waiting on you:** failed runs, held schedules, run approvals and widen cards asked by a run.

Mocks first, with iOS as the reference. Client work starts after the owner approves them.

## 10. Out of scope for v1

- A deploy access level. Pausing automatically after failures. A form.
- Cron and sub-daily rules (P3). The envelope already counts runs per week, so they need no new rule.
- Pinning a runner.
- A cheap pre-check before starting a model ("only start a session if this URL's hash changed"). The Watch contract
  keeps shell out of the server; if wanted later it belongs on the runner.
- Schedules owned by a project, and delivering a finding to a project's coordinator instead of the owner.

## 11. Delivery

| Phase | Scope |
| --- | --- |
| P1 server | migration and model; envelope rule; firing worker with overlap, catch-up and retry; start checks; run block; report, note and findings; run limit; notifications into push and Waiting on you; run sessions hidden and completed; revisions with undo; MCP tools with the create and widen cards; read-only REST and controls; pg specs for every rule in §4–§8 |
| P2 clients | boards → owner approval → left-drawer page, inspector and session cards on iOS, then web, macOS, Android |
| P3 | cron and sub-daily rules |

## 12. Open points for P1

- Every query that must leave `SCHEDULE` sessions out: the session list, search, a workspace's session count.
- The mode each engine runs for each access level, measured on the real CLIs: whether `plan` lets a `CHECK_ONLY` run
  fetch a URL and run read-only commands without a card on each engine.
- The 2-hour approval timeout, the retry backoff and the 30-minute run limit are first guesses.

## 13. Decisions (owner, 2026-11-14: A on all four)

| | Question | A (decided) | B (not taken) |
| --- | --- | --- | --- |
| D1 | Is the budget part of what a person agrees to? | Yes: runs per week and a run limit are one line on the card, and growing either needs **Allow** (§4) | No budget in v1: only access and workspace are in the envelope |
| D2 | Does the creating agent do the check once first? | Yes: the card shows today's result and the first run stays quiet about it (§8.1) | No: the first run's finding is announced as new |
| D3 | One-off schedules? | Yes: `ONCE` in v1 (§5.1) | Recurring only; one-offs stay on `Task.runAt` |
| D4 | May a run change its own schedule? | Yes, inside the envelope, recorded with Undo; ending itself notifies once (§8.3) | No: a run only reports, and changes come from conversations |
