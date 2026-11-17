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
  heldReason?                                          why a HELD run's start checks failed, §6.1
  notBeforeAt?                                         a QUEUED run starts no earlier: a retry's wait, §7.2

ScheduleFinding
  scheduleId, key, firstRunId?, lastSeenRunId?, notifiedAt?, links[]

ScheduleChangeRequest                                  a create, or a change that grows the envelope, waiting for a press
  ownerId, scheduleId?                                 scheduleId is NULL for a CREATE until it is allowed
  kind          CREATE | UPDATE
  state         PENDING → ALLOWED | DECLINED | SUPERSEDED
  askedBy (USER | SESSION | RUN), askedBySessionId?, baseRevision?
  proposed                                             CREATE: the whole input; UPDATE: the patch
  envelopeBefore?, envelopeAsked, widens[]             the card's *now* and *asked*, and the parts that grow
```

A session's `schedule_create` is always a PENDING CREATE request: the card's **Create** is the owner's press that
writes the schedule. A newer UPDATE request for the same schedule supersedes the older one.

Rule encoding: weekdays are `MON` … `SUN`; `ONCE.at` is a local `YYYY-MM-DDTHH:mm` in the schedule's time zone;
`DAILY` and `WEEKLY` take `time` as a local `HH:mm`.

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
  (`PERMISSION_MODE_WIDER_THAN_SESSION`, the rule in `common/permission-mode.ts`). The ceiling holds for ordinary
  sessions only, on create and when a change widens the access level. It does not hold for a schedule's own run
  session, whose mode is its access level's (a CHECK_ONLY run is in Plan), so §8.3's widen card stays reachable;
  what a run asks still applies only on the owner's **Allow**. A change of access level inside the envelope is not
  held to the ceiling.
- A personal access token may use the controls (pause, resume, end, delete, undo, run now, stop) and is recorded as
  the person (`USER`). It may not create, change or decide (`OWNER_INTERACTIVE_CREDENTIAL_REQUIRED`); its undo is
  judged by the rule above like a session's. Only the owner's own undo also restores the envelope.
- A person's narrowing shrinks only the parts the change itself narrowed: rewriting the prompt of a schedule a run
  had backed off leaves the envelope where it was.
- Undo works on any revision whose fields have not changed since (otherwise `SCHEDULE_UNDO_STALE`), once per
  revision (`SCHEDULE_ALREADY_UNDONE`); revision 1, the creation, cannot be undone. Bringing an ENDED schedule back
  counts against `SCHEDULE_LIMIT`.

The budget is counted in runs and minutes, not in money, because a subscription account reports no cost per run.
The inspector shows what was used: "This month: 14 runs · 41 min", with a cost where the engine reports one.

**Runs per week bounds the runs that start, not only the rule.** Moving the time of day or the weekdays is inside
the envelope, and a session that moved its rule to "a few minutes from now" after every run would otherwise run back
to back. So before a run starts (§6.1) the server counts, under the schedule lock the start takes (so two replicas
cannot both pass), **the schedule's runs that actually started, of every trigger, whose planned slot (`plannedAt`; a
MANUAL run's is when it was asked for) lies after the same local time 7 days before this run's own slot, in the
schedule's time zone.** The window is on planned slots, not start times, so how late a start is (the worker's pass,
a runner back after an outage) never moves a run into or out of it: a rule inside its envelope never trips it, and a
rule moved to "a few minutes from now" still gives each run its own slot. It is local time, not 7×24 hours, so a
week across a daylight-saving change is still a week. At `envelope.runsPerWeek` or more, the slot is not started: it is MISSED with
`failureReason = OVER_BUDGET`, the schedule stays ACTIVE (not HELD, not paused) and its next slot is computed as
usual. A start retried because it never reached its engine (§7.2) is one start. The owner is told once, by push,
for a slot over budget, and not again for the next ones in a row; the run list says "Not started: it had already
started as many runs in the past 7 days as you allowed." Run now follows §8.4.

The count is of starts already made, read against the envelope as it is now. When the owner narrows runs per week
mid-week, the runs that already started in the window stay counted against the new, smaller number, so the
next slot may be over budget at once; this is intended: the narrower number is what the owner allows for any 7 days
from now on. A `ONCE` schedule's only slot over budget is MISSED (`OVER_BUDGET`) and follows §5.2's missed-ONCE rule:
one push saying nothing else will run, and the schedule is ENDED (`END_REACHED`) as its only slot has passed.

A run that reaches its limit is interrupted and fails with `RUN_LIMIT`. The schedule goes on.

## 5. Firing

A worker reads `Schedule WHERE state = 'ACTIVE' AND nextDueAt <= now()`. For each due schedule, in one transaction:

1. Insert the run for `plannedAt = nextDueAt`. A conflict on `(scheduleId, plannedAt)` means another worker already
   fired this slot: stop there.
2. Advance `nextDueAt` to the next slot after now, in the schedule's time zone. Past `endAt`, or after a `ONCE`
   rule's only slot, the schedule becomes ENDED (`END_REACHED`).
3. Apply overlap: when a run is RUNNING or AWAITING_APPROVAL, the new run is QUEUED. When one is already QUEUED, the
   older queued run becomes SKIPPED and the new one takes its place. There is never more than one waiting.

A QUEUED run starts when the run ahead of it ends. Starting a run (§6) happens outside this transaction, and is
where the weekly budget is enforced (§4): a slot fires as usual, and its run is MISSED (`OVER_BUDGET`) instead of
started when the schedule already started its runs per week in the 7 days before the slot.

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
- The same holds for a run already written whose start meets the outage. A runner that is offline (a managed runner
  asleep is not: opening the session wakes it) leaves the run QUEUED, without spending an attempt, looking again
  every minute and starting when the runner is back. A run whose first turn never reaches its engine (dispatch
  paused, quota spent, the engine dying before its first turn) is retried as §7.2 says. Either way, once the
  catch-up window has passed the run is MISSED, with the reason in `failureReason`: a slot not run, never a
  failure, and not counted in `consecutiveFailures`.

## 6. Starting a run

### 6.1 Checks, every time

A card is not standing permission for a world that has changed. Before each run starts the server checks again:

- the owner still owns the workspace, the workspace is not deleted, the agent exists and is enabled;
- the schedule is inside its envelope, and the mode for its access level is still within the account's default mode;
- for `OPEN_PR` and `LAND`: the workspace still has a repository;
- for `LAND`: worktrees are enabled, so its sessions can be merged.

When a check fails the run is HELD with the reason, the schedule moves to HELD, and the owner gets an item in
**Waiting on you**. A HELD schedule fires nothing until it is resumed. It is never retried in silence.

The reasons (`heldReason`, on the run and the schedule): `WORKSPACE_NOT_OWNED`, `WORKSPACE_DELETED`,
`WORKSPACE_DISABLED`, `AGENT_MISSING`, `AGENT_DISABLED` (only when the schedule names an agent),
`OUTSIDE_ENVELOPE`, `ACCESS_NOT_ENFORCEABLE` (§6.2, on the engine the run would use), `MODE_WIDER_THAN_ACCOUNT_DEFAULT`
(its on-hold item and its refusal to resume say what to change: "your account's default permission mode is narrower
than its runs use (set it to Default in Settings > General)"),
`NO_REPOSITORY`, `WORKTREE_DISABLED` (LAND needs worktrees), and `SESSION_REFUSED` when the session door refuses the run's session before writing it (a 4xx: the
request cannot be served as it stands, and retrying would not change that). A run uses the engine and credential of
the session that created the schedule while that session exists in the schedule's workspace and is not in Trash,
else what the workspace last ran. Resuming a HELD schedule runs the
same checks and is refused `SCHEDULE_START_CHECK_FAILED` while one still fails.

### 6.2 Access levels

The agent picks the level from what the intent needs: a check, a report or a summary is `CHECK_ONLY`; "open a PR",
"bump it", "fix it" is `OPEN_PR`; an explicit request to land changes on main without a PR is `LAND`.
The order is `CHECK_ONLY` < `OPEN_PR` < `LAND`: creating LAND or widening to it waits on the owner’s Allow card.

| Level | Card says | Session | May not |
| --- | --- | --- | --- |
| `CHECK_ONLY` | "reads and reports, edits nothing" | `plan` mode (`default` on Claude Code, below), no worktree | edit files, create tasks |
| `OPEN_PR` | "edits in its own worktree and opens a PR; can't merge or deploy" | `acceptEdits` mode, own worktree when the workspace has worktrees | `session_merge`, release and deploy tools |
| `LAND` | "Edit and land on main · edits in its own worktree, then Orbit merges it into main after the run. It can't release or deploy." | same modes as `OPEN_PR`, own worktree required | same denied tools as `OPEN_PR`; no PR |

`LAND` uses the same ordered modes as `OPEN_PR`. Both deny `session_merge`, `integration_*`, `gh pr merge`,
`git push` to main, release and deploy tools, `Skill(release)` and `Skill(upgrade)`. A LAND run commits on its branch
and reports; it never opens a PR or merges itself.

The mode each engine gets (`schedules/schedule-access.ts`; measured on the real CLIs, §12):

| Engine | `CHECK_ONLY` | `OPEN_PR` | Measured |
| --- | --- | --- | --- |
| Claude Code | `default`, with its own allow and deny lists; only a shell command asks (below) | `acceptEdits` | 2.1.325 |
| Codex | `plan`, in Codex's read-only sandbox (below) | `acceptEdits` | 0.169.0 |
| Kimi | `plan` | `acceptEdits` | 2.5.3 |
| OpenCode | `plan` (denies everything but reads) | refused: `SCHEDULE_ACCESS_NOT_ENFORCEABLE` | 1.19.5 |
| Antigravity | `plan` | `acceptEdits` | not measured (no signed-in account on the host) |
| DeepSeek Harness | `dontAsk` (its read-only file sandbox) | `default` (asks before each write) | not installed; from `permissionSemantics.ts` |
| Cursor CLI | `plan` | `acceptEdits` | not installed; from `permissionSemantics.ts` |

The rule behind it: each level has its modes in order (`CHECK_ONLY`: `plan`, `dontAsk`; `OPEN_PR`: `acceptEdits`,
`default`). The run gets the first that `derivePermissionSemantics` says the engine honours and that never allows an
unapproved action; for `CHECK_ONLY` a mode that denies every unapproved action counts even where it is not honoured
as asked, because denying is not wider. The `OPEN_PR` run's `disallowedTools` are `mcp__orbit__session_merge`,
`mcp__orbit__integration_request_promotion`, `mcp__orbit__integration_skip_merge_check`, `Bash(gh pr merge:*)`,
`Bash(gh release:*)`, `Bash(npm publish:*)`, `Bash(docker push:*)`, `Skill(release)` and `Skill(upgrade)`, added to
the workspace's own at claim.

A `CHECK_ONLY` run on Claude Code runs in `default`, not `plan`: Claude Code's headless Plan never permission-checks
Bash, so a writing shell command ran there with no ask (§12). In `default` Claude Code's own read-only check runs
`git log`, `ls`, `cat`, `grep` and `git status` with no ask, and **every other shell command asks**: `touch`, a
redirection, `rm`, a test suite, `psql`, `curl`. The ask is the ordinary approval card (§6.4): the run moves to
AWAITING_APPROVAL, the owner is pushed and the card waits in Waiting on you; Allow once runs that command once, Always
allow writes a workspace rule the next run carries, Deny refuses it, and nobody answering in 2 hours is
`APPROVAL_TIMEOUT`. The command does not run before the card is answered (record §9). The owner ruled on 2026-11-15
that a check-only run may ask, as the board shows (`docs/mocks/scheduled-tasks/web/waiting.png`); from S2b until then
it ran in `dontAsk`, where such a command was refused with no card.

Only a shell command can ask. The claim hands the runner, for that run only:

- `allowedTools`: this list, plus the shell rules written by answering Always allow on a `CHECK_ONLY` run's card
  (`Bash(npm test:*)`; `workspace_permission_rule.from_schedule_run`, migration 0860, which marks no existing rule).
  Not a rule an `OPEN_PR` run's card wrote (its rules are whatever the client sent: `Bash(git:*)` for a `git push`),
  not the rules a person's interactive sessions wrote (`Bash(python:*)`, `Bash(git:*)` would run writing commands unasked), no `mcp__orbit__*`
  wildcard, no rule for any other tool (`Edit`, `Write`, an MCP tool), and no rule for the whole shell (`Bash`,
  `Bash(*)`):
  - the run's own schedule: `schedule_run_report`, `schedule_get`, `schedule_list`, `schedule_update`,
    `schedule_end` (the server holds a run to the schedule it serves and to its envelope, §8.3: an update or end of
    any other schedule, and a create, pause, delete or run-now of any, is refused `SCHEDULE_RUN_SESSION_SCOPE`);
    `schedule_create`, `schedule_pause`, `schedule_resume`, `schedule_run_now`, `schedule_run_stop`,
    `schedule_delete` and `schedule_wakeup` are not on the list;
  - `notify`;
  - reads: `task_get`, `task_list`, `session_get`, `session_search`, `project_get`, `wiki_search`, `wiki_get`,
    `file_fetch`, `file_list`;
  - `guide`, which reads the operation catalogue and asks the server nothing (since contract 1.10.0, which merged
    it from the project line);
  - `WebFetch` and `WebSearch`.

  These are the Orbit tools a `CHECK_ONLY` run on Claude Code has (each as `mcp__orbit__<name>`).
- `disallowedTools`, added to the workspace's own: `Edit`, `Write`, `NotebookEdit`; the Orbit CLI
  (`Bash(*/orbit *)`, `Bash('*/orbit' *)`, which the runner replaces, below); **every built-in tool a check does not
  use** (`CHECK_ONLY_CLAUDE_DENIED_BUILTINS`: some act with no ask in Default and Don't Ask alike — `EnterWorktree`
  created a git worktree, `CronCreate` scheduled a prompt, in Don't Ask `Monitor` ran `touch` and `Workflow` ran a
  SubAgent; `EnterPlanMode` would hold back the run's own `schedule_run_report` and `notify`, since in Plan Claude Code
  asks about every Orbit tool not marked read-only and the runner refuses each such ask; record §10.6); and **every other
  Orbit tool by name**, `delegate` included (it is served beside the catalogue) (`bg_run`, `bg_kill`,
  `session_merge`, `task_start`, `task_update`, `session_send`, the create doors, `integration_*`, `provider_*`,
  `agent_*`, `runner_*`, `task_comment`, `file_upload`, … : `CHECK_ONLY_CLAUDE_DENIED_ORBIT_TOOLS`, every tool of
  `docs/operation-catalog.md`'s MCP column the allow list does not name, held to it by `schedule-access.spec.ts`, and
  every tool `orbit mcp` actually serves held to the two lists by runner-go `TestEveryServedOrbitToolIsOnACheckOnlyList`).
  They are denied by name, not merely left off the allow list, because in `default` Claude Code asks about an Orbit
  tool no rule covers and the runner answers that ask itself, allowing it outside Plan (`answerOrbitToolPrompt`):
  measured, `bg_run`, `task_update` and `session_merge` ran with no card when they were only left off (record §9).
  Denied, they are not offered to the model at all. A deny rule also wins over the runner's allow rules for the CLI
  and over a workspace `Bash(…)` rule that covers it.
- On the server, a permission request from such a run's session for anything but a shell command (any tool, an MCP
  server of the workspace's, a SubAgent's question) and a shell command a runner-hosted job asks about is answered
  DENY at once (`checkOnlyRefusesApproval`, in `POST /runner/sessions/:id/approvals`). It is never a card, a Waiting on
  you item or a push, so no press of a card can grant a scheduled check a file tool, `bg_run` or any other tool. The
  engine reads "Not run: this is a check-only scheduled run, which may ask only to run a shell command. …".

`bg_run` on the other engines: their `CHECK_ONLY` mode is `plan` (Codex, Kimi, OpenCode, Antigravity, Cursor) or
`dontAsk` (DeepSeek Harness), and the runner's background-job gate (`background_gate.go`, `admit`) refuses a job in
both, with no card, before anything starts. That is read from the runner's code, not measured on those engines. On
Claude Code `bg_run` is denied by name and is not offered (record §9).

- Always allow on such a card writes only that card's command's rules (`bashCommandRules`, what the card says Always
  allow covers, e.g. `psql:*`): a client sending any other rule (another command's, the whole shell, `Edit`, an Orbit
  tool) is refused `400 SCHEDULE_CHECK_ONLY_RULE_REFUSED` and the card is not decided. The rule is marked as a
  scheduled card's, so later checks carry it; a rule an interactive session wrote first is the same row and is
  marked then.
- The level is the run's own: `schedule_run.access_level` is written when the run starts, and the claim, the reclaim
  and the approval door read it. Moving the schedule to `OPEN_PR`, or deleting it, while a check runs does not give
  that check cards for other tools or hand a reclaim `mcp__orbit__*`.

The runner closes what only it can, for a claim with `agent.scheduledCheckOnly` on Claude Code
(`runner-go/schedule_check_only.go`):

- **Orbit's tools.** Claude Code asks about an Orbit tool its allow rules do not cover, and the runner answers that
  ask itself (`answerOrbitToolPrompt`). In such a run every such ask is refused, with no card, whatever the catalogue
  says of the tool, so a tool on neither of the server's lists (a runner newer than its server) does not run unasked.
  The server's by-name list stays for older runners.
- **The Orbit CLI.** The runner adds no CLI allow rule, and denies its own executable anchored at the start of the
  command, in both quoting forms (`Bash(<exe>)`, `Bash(<exe> *)`, `Bash('<exe>')`, `Bash('<exe>' *)`), in place of the
  server's `*/orbit *` patterns, which also refused `ls /root/orbit src`. A disguised form (a bare `orbit` on `PATH`,
  `env orbit …`, a copy of the binary, `curl` with a token) is a shell command like any other: it asks, and the card
  shows the command the owner would allow. Measured (record §10): `ls ./orbit .` in a checkout holding a directory `orbit` ran unasked (the old patterns refused it), the CLI
  by its path was refused with no request, a bare `orbit …` asked.
- **Claude Code's built-in tools.** Such a run is started with `--tools Bash,Read,Grep,Glob,WebFetch,WebSearch,
  ToolSearch`: no other built-in is offered, including one a later Claude Code adds (the server's by-name list above
  holds the known ones on any runner).
- **Claude Code's own settings files.** With no `--setting-sources`, `permissions.allow` in the checkout's
  `.claude/settings.local.json` and in the user's `settings.json` ran commands unasked (measured, record §10). Such a
  run is started with `--setting-sources ''`: it loads no user, project or local settings file. The runner's own
  `--settings` file (its background-work hooks, fast mode, the account switches) still applies, and carries what of
  the user's `settings.json` (in the config dir the session's engine runs on) the engine needs to reach its endpoint
  the way the runner's region check assumed: its `env` (a proxy, a base URL, a key) and its credential helpers
  (`apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`), never its permissions. Turned off: the project's and the
  local settings files entirely, and the rest of the user's (its hooks, model, plugins, status line). Measured (record
  §10): a proxy and an `apiKeyHelper` set there are still used.

**Runner release, and older runners.** The runner advertises `claude-scheduled-check-only-asks/v1`, and only a run
claimed by such a runner is handed `default` and these lists (`scheduleRunPermissionMode`, on the claim and the
reclaim). A run claimed by any other runner runs exactly as S2b ran it: `dontAsk`, the 17 allowed tools with no
workspace rule, and S2b's deny list (`Edit`, `Write`, `NotebookEdit`, the CLI patterns). It never asks there, every built-in a check does not use is denied by name (S2b's own `dontAsk` let `Monitor` and
`Workflow` act, record §10.6), and nothing else an allow rule does not name runs; the older runner's CLI allow rules lose to the deny patterns. An allow rule
in a settings file the older runner still loads (the checkout's local settings, the user's) is an allow rule there too,
exactly as it was under S2b. The runner changes ship in the first runner release after v0.1.261-beta.8.

**Codex still never asks.** A Codex `CHECK_ONLY` run stays in Codex's read-only sandbox with approvals off (below):
a writing command is refused by the OS, with no card. Kimi's `plan` asks for each command, as before; OpenCode's
refuses commands.

- A level is a claim to the person, so it is enforced, not prompted: the mode above, plus `disallowedTools` on the
  run's session for the *May not* column.
- The mode is resolved per engine through `permissionSemantics.ts`. An engine that cannot enforce a level (DeepSeek
  Harness has no Plan or Accept Edits) gets the nearest mode that is not wider, and when there is none
  `schedule_create` is refused with `SCHEDULE_ACCESS_NOT_ENFORCEABLE`. The agent tells the person which engine
  can.
- Codex reads files only through the shell. Under the `untrusted` policy Plan runs on, it asks about every command,
  `ls` included, and Plan declines them all. So for a `CHECK_ONLY` run only, the claim sets
  `agent.scheduledCheckOnly`, and the runner then starts that Plan session in Codex's own read-only sandbox:
  `approvalPolicy: never`, `sandbox: read-only`, `sandboxPolicy {readOnly, networkAccess: false}`. The run then
  reaches the following, with no card:
  - it can read the checkout (any command runs; the OS refuses every write, shell or file edit);
  - it can fetch a URL with Codex's built-in web tool;
  - it can call Orbit's MCP tools (`schedule_run_report` included; measured: an Orbit MCP read reached the control plane);
  - it cannot reach the network from the shell (`curl` fails) or write anywhere.

  The runner judges no command string itself. Every other Codex Plan session is unchanged and declines every command.
  This needs the first runner release after v0.1.261-beta.5. On an older runner the flag is ignored, and a Codex
  `CHECK_ONLY` run can fetch but not read the checkout, so the card should not promise more there. Measured on
  Linux only; macOS (Seatbelt) is not measured (record §8).
- Deploy is not a level in v1.

### 6.3 Session

The run gets a new session in the schedule's workspace, with `runSource = SCHEDULE` and `scheduleRunId` set. Its
`openedBy` is `SCHEDULE`, so it never becomes the workspace default a person's next session starts from. Its
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

After a `LAND` turn settles and has reported `CHANGED` or `NO_CHANGE`, Orbit lands commits ahead of its base through
SessionsService’s ordinary Merge-to-main path and the same merge check. It waits for the runner’s receipt before
recording the landed SHA (`landedSha`) and appending it to the run summary. No commits means no merge. A FAILED run,
a run stopped at its limit, or an unsuccessful turn lands nothing. A refusal, conflict or red merge check fails the
run (`LANDING_FAILED`) with its reason, through the same push and **Waiting on you** path (§7.3). Landing status
(`WAITING`, `MERGING`, `LANDED`, `NO_COMMITS`, `FAILED`) survives restarts; replays do not land or notify twice.

### 6.4 Approvals while nobody is watching

- A run that hits an approval card moves to AWAITING_APPROVAL and the card goes to **Waiting on you**.
- Answering it with "don't ask again" writes a `WorkspacePermissionRule`, as it does in any session. Rules are
  workspace-scoped and handed to every session of the workspace, so **the next run does not stop there**. The card
  says so: "Later runs won't ask for this." A `CHECK_ONLY` run on Claude Code is handed only the workspace's narrow
  `Bash(…)` rules, and only a shell command of it can be a card (§6.2).
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
| `RUNNER_UNAVAILABLE`, `QUOTA`, `ENGINE_CRASHED_BEFORE_START` | yes, then MISSED (§5.2) | the run never reached the engine (no `delivered_at` on its first turn) |
| `LANDING_FAILED`, `REPORTED_FAILED`, `NO_REPORT`, `ENGINE_CRASHED`, `APPROVAL_TIMEOUT`, `RUN_LIMIT` | no | the work started and may have had effects |
| `CANCELLED_BY_OWNER` | no | the owner stopped this run |

- Retry: after 1, 5 and 15 minutes, then once an hour, for as long as the catch-up window lasts; a retry that would
  start past it makes the run MISSED instead (§5.2). A retry on a schedule paused, held or deleted meanwhile is
  CANCELLED (a MANUAL run on a paused schedule still retries), and one with a newer run already waiting is SKIPPED.
- One run never has two live sessions. Before a run that never reached its engine is put back, its session is
  retired: auto-retry cancelled, then ended; if that fails the run is left as it is for the next pass. Before a
  QUEUED run opens a session, any live session still naming it (`scheduleRunId`) is retired first. A create that
  fails after its INSERT committed keeps that session as the run's. A report from a session that no longer serves
  its run is refused (`SCHEDULE_RUN_REPORT_NOT_A_RUN`).
- A QUEUED run whose start throws is put aside for 5 minutes, so the runs behind it start, and is MISSED once its
  window has passed; a schedule or run whose pass throws is left out of that replica's passes for 5 minutes.
- `consecutiveFailures` counts FAILED runs in a row and resets on NO_CHANGE or CHANGED. At 3 the notification says
  "failed 3 runs in a row". The schedule is **not** paused.
- Whether a run reached its engine is its first turn's `delivered_at`. A run whose first turn is not delivered 10
  minutes after it started is `RUNNER_UNAVAILABLE` (its session is ended); a session that FAILED before delivery is
  `QUOTA` when its error is a usage-limit message, else `ENGINE_CRASHED_BEFORE_START`; after delivery it is
  `ENGINE_CRASHED`. A session that ended before delivery is `RUNNER_UNAVAILABLE`, after it `NO_REPORT`. A retry is the same run row back in QUEUED with `attempt + 1` and `notBeforeAt`, and a new
  session; a newer run already waiting takes its place instead.
- The run limit counts the engine's working time from `delivered_at`: time a card kept the run waiting is left out,
  so the 2-hour approval timeout can be reached under a run limit of at most 2 hours.
- SKIPPED, MISSED and HELD runs are not failures.

### 7.3 Who hears

| Run ends | Notified | Where |
| --- | --- | --- |
| NO_CHANGE | no | |
| CHANGED, new key | once | push, opens the run's session |
| CHANGED, known key | no; `lastSeenRunId` moves and `links` merge | |
| FAILED (including `LANDING_FAILED`) | yes | push and **Waiting on you** |
| HELD, AWAITING_APPROVAL | yes | push and **Waiting on you** |
| the run ended its own schedule (§8.3) | once | push, opens the schedule |
| a slot MISSED over the weekly budget (§4) | once, not for the next slots in a row | push, opens the schedule |

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
- `readBack` is optional: one first-person sentence (at most 500 characters) describing the schedule after the
  change. It applies at once inside the envelope, including by itself, and is recorded in the revision’s before /
  after and undoable. Pass it when the prompt or access changes as well as the time; a rule or time-zone change
  without it clears the old read-back so the read derives it.
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
| Run now | Writes a MANUAL run under the overlap rule. Allowed when PAUSED; refused when ENDED. Only the owner's own press (the owner-interactive channel) starts over the weekly budget. A session's or a personal access token's Run now is refused over budget (`SCHEDULE_OVER_BUDGET`): a token is what an agent with a shell on the runner holds, so exempting it would let the budget be passed without the owner. Inside the budget both work as before. Either counts as a start toward later automatic runs (§4), and that is the cost of the press: the owner's Run now inside a full week starts, and the next automatic slot is then MISSED (`OVER_BUDGET`). |
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
- The cards (S4, 2026-11-15): a card is its `ScheduleChangeRequest` row. `schedule_create` returns at once with the
  PENDING create card (and says in words that nothing is scheduled yet); `schedule_update` returns APPLIED with the
  change's record (its Undo is `POST /api/schedules/:id/undo`) or PENDING with the envelope card. The owner's press is
  `POST /api/schedule-requests/:id/allow` (Create or Allow; a create card that names no time zone takes the pressing
  device's `timezone`, one that names a zone refuses another) and `.../decline` (Not now or Decline), owner channel
  only: a personal access token, a request with an acting session and anything under `/runner` are refused. Allow
  re-judges a card: an envelope card asked of an older revision, or any card naming a workspace no longer the owner's,
  is SUPERSEDED (`SCHEDULE_REQUEST_STALE`, `reason` REVISION_MOVED or WORKSPACE_GONE), not applied.
  `GET /api/schedule-requests` lists the cards (PENDING by default; a run's widen request is one, `askedBy` RUN), and
  `GET /api/sessions/:id/schedule-cards` gives one session's cards and change records, for drawing them in it.
- A run's session may update and end only the schedule it serves; anything else, including the controls on its own
  schedule and creating one, is refused `SCHEDULE_RUN_SESSION_SCOPE`; it may not change the intent either
  (`SCHEDULE_RUN_MAY_NOT_RESTATE_INTENT`, §8.2). `schedule_run_report` is listed only in a run's
  session (claim field `scheduleRun`, `ORBIT_SCHEDULE_RUN=1`).
- The quick-add line: `POST /api/schedules/drafts {workspaceId, text}` opens an ordinary session with the sentence;
  `GET /api/schedules/drafts` lists the account's PENDING create cards, each naming the session that put it up.
- Tokens: the reads take `sessions:read`, the controls `sessions:write`; no token reaches a card press.

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

## 12. Open points for P1, settled (S2, 2026-11-15)

**1. The queries that must leave `SCHEDULE` sessions out** (S3 implements them; `runSource = 'SCHEDULE'`, or
`schedule_run_id IS NOT NULL`):

- `SessionsService.list` (`GET /sessions`: Open, Completed and Trash, every filter and folder view);
- `SessionsService.listOpenSince` and `listRowsByIds` (the list's delta and the rows pushed to clients);
- `SessionsService.search` and `searchEvents` (session search, by title and by transcript);
- `SessionsService.workspaceSessionCounts` (a workspace's session count in the sidebar);
- `SessionsService.listForOrchestration` (MCP `session_list` and `orbit session list`);
- the project sessions view (`sessions/session-project-membership.ts`) and session-folder counts;
- the realtime `session.created` push, so a run's session does not appear in an open list.

A run's session stays reachable by id (`GET /sessions/:id`, `session_get`), which is how the schedule's history and
the notification open it.

*Implemented in S3 (2026-11-15).* Every session query was read and is one of three kinds.

- **Filtered** (`run_source <> 'SCHEDULE'`): `SessionsService.list` in every view, folder and project read, and so
  `listOpenSince`; every branch of `search` (title, metadata, transcript, recents); `workspaceSessionCounts`;
  `listForOrchestration`; the folder counts of `moveTargets`; the realtime `session.created`;
  `workspace-usage.ts` (`workspaceSessionCount`, the "N sessions" of a workspace's page, and `lastActiveByWorkspace`);
  the wiki's maintenance facts (`session_settled`, `approval_answered`, `merge_receipt`) and `wikiSessionsOfSpace`, since
  v1 feeds no run to the wiki.
- **Already unreachable:** `lastProviderByWorkspace` (`opened_by = 'PERSON'`, so a run never seeds the workspace
  default); every raw-SQL session join in `tasks.service.ts`, `project-list-rollup.ts` and the project parts of
  `wiki-docs-material.ts` (all through `task_id`, which a run does not have).
- **By id, left as it is:** `GET /sessions/:id`, `session_get`, `listRowsByIds` (link cards and wiki chats name their
  sessions: an `orbit-session:` link to a run gets its card), `searchEvents` (find inside one session),
  `wiki-docs-material.ts`'s cited sessions, `attention-fix.ts`'s fix entries, `reaper.service.ts`'s finalize reads.
- **Internal, left as it is:** the claim and capacity counts (`session-tree-sql.ts`, `tasks.service.ts`
  `materialisationBudget`; a run holds a runner slot), the reaper's sweeps, `attention-fix.ts`'s `mostRecentWorkspaces`
  (picks a workspace for a fix; it lists no session), and `runners.service.ts` `updateTurnsOf`, which lists a draining
  runner's RUNNING sessions by title on the Update card and its confirm: a run there is named because the update will
  interrupt it, which is what the card is for.

**Needs you.** A run that needs the owner is counted once. The badge (`PushService.needsYouSessions`, and the Feishu
`status` list that reads it) is a set of sessions waiting for a reply: a run's session waiting on a card is in it, once,
and leaves it when the card is answered. No owner request is a badge source, of any kind. A session row's needs-you count
(`readOwnerDecisionsBySession`) counts the card as the pending approval it is and leaves the `SCHEDULE_APPROVAL` item that
points at the same card out, so one card is one count; the other three items count on the row they are shown beside.

**Who hears.** The push side of §7.3 lives in `schedules/schedule-attention.ts`. A run's session rings no "finished" or
"needs your reply" banner of its own (`PushService.notifySessionSettled`, `notifyApprovalRequest`); what it found, how it
failed or what it waits on is pushed by the schedule (`PushService.notifySchedule`), after the transaction that decided
it commits: at most once, so a crash between the two loses the push, and the Waiting on you item is the durable record.
Waiting on you carries four owner-request kinds no session can file (they are not in `OWNER_REQUEST_KINDS`, which is
what a session may file; `owner_request_kind_chk` takes all nine) — `SCHEDULE_FAILED` (one per schedule, the newest
failure; none for a schedule already ended or deleted), `SCHEDULE_HELD`, `SCHEDULE_APPROVAL` (one per card),
`SCHEDULE_WIDEN` — with `schedule_id`, `schedule_run_id`, `approval_id` and `schedule_change_request_id` on the row
(migration 0840). They close by themselves (WITHDRAWN, with why) when a later run succeeds, the run ends, the schedule is
resumed or ends, or a newer request replaces one; DONE when the card or request they point at is answered. Only a failure
is ended from Waiting on you itself (done or declined); the other three are refused there, since their card, request or
hold has its own door. Closing one delivers no turn to the run's session. A run's history
(`ScheduleRunsService.history`) gives each run's session id with OPEN, COMPLETED, TRASH or GONE.

**2. The mode each engine runs for each access level**, measured on the real CLIs on 2026-11-15; the full record,
with the commands and their output, is [scheduled-tasks-engine-modes.md](./scheduled-tasks-engine-modes.md). The
table in §6.2 is the result. What the measurement found:

- *Claude Code 2.1.325*, `claude -p … --permission-mode plan` with the runner's flags: `WebFetch`, `curl`,
  `git log --oneline -1` and `ls` ran with no ask; `Write` was refused ("Cannot write to …/probe.txt while in plan
  mode."). **But a writing shell command also ran with no ask**: `date > probe3.txt; ls` and `touch probe2.txt`
  created both files (`DENIALS []`), where `--permission-mode default` asked ("Output redirection to … needs
  approval"). So on Claude, Plan blocks file tools but leaves "edits nothing" for the shell to the model. **Settled
  the same day** (record §7): `CHECK_ONLY` on Claude Code ran in `dontAsk` with its own lists (S2b; now `default`,
  revised by S2e below). With the
  runner's flags, `WebFetch`, `git log`, `ls`, `cat`, `grep`, `git status` and `git diff` ran with no ask, and
  `date > probe3.txt`, `touch`, `rm`, `echo >>`, `sed -i`, `find -delete`, `cp`, `tee`, `git commit`, a `python3`
  write, `curl -o` and `orbit task create` were all refused, with no file changed and the permission prompt tool
  never called. With the run's explicit Orbit allow list, `bg_run` (with `touch`/`date >`), `session_merge`,
  `task_start`, `task_update`, `session_send` and the Orbit CLI were refused before the tool was called, while
  `task_get` and `schedule_run_report` ran.
  `acceptEdits`: `Write` ran; `git add`/`git commit` and `curl` asked, so an `OPEN_PR` run stops on a card at its
  commit unless a workspace rule (Always allow) covers it.
- *Codex 0.169.0* (app-server, `approvalPolicy: untrusted`, runner answers as for Plan): the built-in web search
  opened `https://example.com` with no request; `git log` and even `ls` came as `commandExecution/requestApproval`,
  which in Plan the runner declined with no card; the patch was declined. Plan was enforced, but a check that needed
  to read the checkout could not: reads go through the shell. **Settled by a runner change for scheduled runs only**
  (owner, 2026-11-15; record §8). A `CHECK_ONLY` run's Plan (`agent.scheduledCheckOnly` on the claim) runs in Codex's
  own read-only sandbox with `approvalPolicy: never`. Measured on the real app-server with the runner's own
  parameters, with 0 approval requests reaching the runner:
  - `ls`, `cat README.md` and `git log` ran;
  - the built-in web tool opened `https://example.com`;
  - Orbit's MCP `task_get` returned its task;
  - `curl` had no network;
  - `touch x`, `date > x` and an apply_patch edit were refused by the OS.

  A runner-side parser of command strings was tried first and dropped: under Plan's `danger-full-access` an approved
  `touch x` writes, so the parser would have been the only guard (record §8.2). Every other Codex Plan session is
  unchanged. It needs the first runner release after v0.1.261-beta.5.
- *Kimi 2.5.3* (ACP, mode `plan`): `FetchURL` ran with no ask; `Bash` asked (`session/request_permission`), so each
  command is a card; the write was refused by Kimi ("Plan mode is active…").
- *OpenCode 1.19.5* (`opencode run` with the runner's permission map): in plan, `webfetch` and `bash` were
  auto-rejected ("permission requested: webfetch …; auto-rejecting") and no write tool was offered; reads worked.
  In acceptEdits the write worked but every command was auto-rejected, so it cannot commit or open a PR: `OPEN_PR`
  is refused there.
- *Antigravity 1.5.9*: not signed in on the measuring host ("error: authentication failed or timed out"); its row
  follows the runner (`--mode plan`, the approval hook in Accept Edits) and is to be measured on a signed-in runner.
- *DeepSeek Harness*, *Cursor CLI*: not installed on the measuring host; their rows follow `permissionSemantics.ts`.

So `plan` lets a `CHECK_ONLY` run fetch a URL **and** run read-only commands without a card only on Claude Code;
on Kimi each command is a card (answered "Always allow" once, the workspace rule carries it to later runs, §6.4),
and on OpenCode a `CHECK_ONLY` run can read but not fetch. Codex fetches and, in a scheduled run on a runner with
record §8, also reads the checkout in its read-only sandbox with no card (on an older runner it can fetch but not
read). Two follow-ups were filed and both are done: Claude's shell-write gap is closed by running its `CHECK_ONLY` in
`dontAsk` (§6.2, record §7), and Codex Plan reads the checkout in scheduled runs with Codex's read-only sandbox
(record §8).
What `dontAsk` gave up on Claude, against Plan: `curl` (use `WebFetch`); and an account whose default mode is Plan
holds a Claude `CHECK_ONLY` run as `MODE_WIDER_THAN_ACCOUNT_DEFAULT` (`dontAsk` is wider than Plan by name), as it
already did on DeepSeek Harness. Orbit's writes, which Plan's runner gate refused, stay refused: the run's allow list
names only the Orbit tools a check needs, and the Orbit CLI is denied (record §7, *Orbit's own tools*).

*Revised by S2e (owner, 2026-11-15: "may ask, as the board shows"; record §9).* `CHECK_ONLY` on Claude Code now runs
in `default`. Measured on 2.1.325 with the runner's flags and the lists the claim now hands it: `git log`, `ls`, `cat`,
`grep` and `git status` ran with no request; `touch`, `date >`, `rm`, `npm test`, `psql` and `curl -o` each reached
the runner's permission prompt as a request and did not run while it was unanswered (denied: no file changed; allowed:
each ran); a workspace rule `Bash(touch carried.txt)` ran its command with no request; `Edit`, `Write` and
`NotebookEdit` were not offered, the Orbit CLI was refused by the deny rule though a workspace rule and the runner's
rules allowed it, and `bg_run`, `task_update`, `session_merge` and `task_start` were not offered, with no request
reaching the prompt tool. The server answers any request of such a run that is not a shell command DENY at once (§6.2).
An account whose default mode is Plan still holds such a run (`default` is wider than Plan); `default`, `dontAsk` and
the wider modes do not. Codex still never asks: its `CHECK_ONLY` run stays in its read-only sandbox (record §8).
Revision 2 of S2e (review, 2026-11-16; record §10) closed five more ways such a run could run something unasked:
rules a person's interactive sessions wrote are no longer carried, Always allow on its card is held to that card's
command, the run keeps the level it started with, and the runner refuses every Orbit tool prompt, denies the CLI by
its own path and loads no settings file of the checkout's or the user's. Those three runner changes need the first
runner release after v0.1.261-beta.8 (§6.2).

**Weekly budget (S2d, 2026-11-15).** The envelope's runs per week was first enforced only on the rule
(`judgeEnvelopeChange` and the start check compare `runsPerWeek(rule)` with the envelope), so a rule moved inside
the envelope after every run started without limit. It is now also a count of real starts whose planned slots lie in
the 7 local days before the slot being started (a first version windowed on `startedAt`, and start latency tripped a
schedule whose rule filled its envelope),
read at each start under the schedule lock (`scheduleOverBudget` in `schedule-start-check.ts`, §4): a slot over it
is MISSED (`OVER_BUDGET`), told once, and the schedule goes on; the owner's own Run now starts over it and counts; a
session's or a personal access token's Run now over it is refused (`SCHEDULE_OVER_BUDGET`); a retried undelivered start is one start (the retry
reuses the run row and clears `startedAt`). No migration: `schedule_run.planned_at`, `started_at` and `failure_reason` carry it.

**3. The defaults** stay: approval timeout 2 hours; retries after 1, 5 and 15 minutes, then hourly inside the
catch-up window (§5.2, §7.2); run limit 30 minutes, at most 120. One change: the run limit counts working time only, without
the time a card waited (§7.2), or the approval timeout could never fire. A first turn not delivered within 10
minutes is `RUNNER_UNAVAILABLE`; a slot fired within 10 minutes of its time is SCHEDULED, later it is CATCH_UP.

## 13. Decisions (owner, 2026-11-14: A on all four)

| | Question | A (decided) | B (not taken) |
| --- | --- | --- | --- |
| D1 | Is the budget part of what a person agrees to? | Yes: runs per week and a run limit are one line on the card, and growing either needs **Allow** (§4) | No budget in v1: only access and workspace are in the envelope |
| D2 | Does the creating agent do the check once first? | Yes: the card shows today's result and the first run stays quiet about it (§8.1) | No: the first run's finding is announced as new |
| D3 | One-off schedules? | Yes: `ONCE` in v1 (§5.1) | Recurring only; one-offs stay on `Task.runAt` |
| D4 | May a run change its own schedule? | Yes, inside the envelope, recorded with Undo; ending itself notifies once (§8.3) | No: a run only reports, and changes come from conversations |
