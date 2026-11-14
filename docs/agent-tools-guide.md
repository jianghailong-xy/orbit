# How agents use Orbit

> Generated from `src/runner-go/agent_tools_guide.go` — do not edit by hand. Guide 1.0.0, written from Agent Contract 1.8.0, operation catalogue 1.7.0 and primer 1.2.0.

This is the person's side of the [Orbit Agent Contract](orbit-agent-contract.md): what an agent in an Orbit session does with Orbit, and why. The agent learns the same rules from its primer, its tools' descriptions and the `guide` tool. The web console and the macOS app show this guide in **Agent tools**: a session's More actions → Agent tools, and Workspace settings → Agent environment → Agent tools, beside what that session or workspace is actually given. The same rows make the playbooks skill Orbit gives Claude Code and Codex, and a test holds this file, the apps' copy and the skill to them.

## Contents

- [MCP first, the CLI by exception](#mcp-first-the-cli-by-exception)
- [Your record and the agent's private plan](#your-record-and-the-agents-private-plan)
- [Which object a request belongs to](#which-object-a-request-belongs-to)
- [Creating is not starting](#creating-is-not-starting)
- [When the CLI is the right tool](#when-the-cli-is-the-right-tool)
- [When something is missing](#when-something-is-missing)
- [Try asking: four examples](#try-asking-four-examples)
- [Workflows: the guide's recipes](#workflows-the-guides-recipes)
- [What the agent reads, and in what order](#what-the-agent-reads-and-in-what-order)
- [Permission modes and Orbit's calls](#permission-modes-and-orbits-calls)
- [Orbit's tools by family](#orbits-tools-by-family)
- [The playbooks skill](#the-playbooks-skill)

## MCP first, the CLI by exception

An agent reaches Orbit through Orbit's MCP tools whenever its tool list has them: they are checked against their schema, need no shell, and carry this session's identity without an argument.

- Claude Code lists them as mcp__orbit__<tool>; Codex and the other engines show the same server's tools under their own prefix.
- Every write answers with a receipt: ok, outcome, the entity's id and its status. A write happened only when the receipt says ok: true and outcome: written.
- When the agent is unsure which tool fits or how to call it, it calls guide: with no arguments for the routes, with a topic for the recipe. guide is listed in every session, whatever its switches.
- MCP and the CLI reach the same server with the same approvals, attribution and ids: a task created on one is read on the other with no translation.

Try asking: *"Which Orbit tools do you have in this session?"* · *"Call guide and tell me which tool records a follow-up."*

## Your record and the agent's private plan

Orbit is your durable record; the engine's own todo or plan tool is the agent's private scratch.

- A plan the engine keeps lives in this conversation only: nobody else sees it, and a compaction can drop it.
- Work you want kept or followed up goes to Orbit, where it has an id and a status that you, the apps and later sessions can read.
- The agent never calls a private plan a task, and never says it filed something without an id Orbit returned.
- When you say "keep that plan", the plan becomes one task_create_batch: one task per item, its order as dependsOnRefs, its parts as parentRef, in one call and one card.

Try asking: *"Think this migration through first; don't file anything yet."* · *"OK, keep that plan in Orbit."*

## Which object a request belongs to

Each request goes to the object that answers its question; when two fit, the smaller one wins.

- Project: What is the whole thing for, and what settles it?
- Task: What is the one piece of work?
- Task list: How is this class of work dispatched?
- Session: What is running right now?
- Agent: Where does it run, and under which identity?
- Not every request is an Orbit write: answering a question, explaining or editing code records nothing.

| Route | What the person says | Object | Operations |
| --- | --- | --- | --- |
| R1.1 | Remember this, file it, do it later, someone should fix it | task | `task_create` |
| R1.2 | Keep this plan: it is already worked out and counted | task[] | `task_create_batch` |
| R1.3 | Set up this whole body of work, with its own goal and acceptance (4+ dependent steps, or several agents over days) | project | `project_create` |
| R1.4 | Run it now; it is already recorded | task | `task_start` |
| R1.5 | Run it now; it is not recorded yet | task | `task_create` |
| R1.6 | Do it at a set time | task | `task_create`, `task_update` |
| R1.7 | Hand this to another agent as its own conversation | session | `session_create` |
| R1.8 | What is the state of this project, task or session? | none | `project_get`, `task_get`, `task_list`, `session_get` |
| R1.9 | Wait for it to finish | watch | `task_await`, `session_await`, `watch_create` |
| R1.10 | Remember this lesson or pitfall about a file or a pattern | wiki | `wiki_search`, `wiki_propose`, `wiki_note` |
| R1.11 | Keep this file, or read one back | file | `file_upload`, `file_fetch`, `file_list` |
| R1.12 | This class of work needs its own dispatch policy | task_list | `tasklist_create`, `tasklist_update` |
| R1.13 | Which agent should run this, or change an agent's defaults | agent | `agent_list`, `agent_create`, `agent_update` |
| R1.14 | Answer, explain, or edit code | none | nothing to record |

- R2: The smaller object wins: one task beats a project; one task beats a batch of one.
- R3: Never double-record: not a task per step of the current task, not a task for the current task, not a session to do what this turn can do.
- R4: Read before write when the destination is uncertain: task_list --project-id, project_get, or task_create_batch dryRun.
- R5: An engine plan/todo is private scratch; never call it an Orbit record, never claim a task without its id, never refuse to record work because a private plan covers it.

Try asking: *"Remember to rotate the staging key."* · *"What is still open in the agent-contract project?"*

## Creating is not starting

task_create records work and runs nothing in the call; starting it is a decision of its own.

- task_start runs work that is already recorded, on its assignee, once its prerequisites are DONE.
- task_create with startNow: true records the work and starts it on one card.
- runAt starts it once, at a set time; it is not a deadline (that is dueDate).
- autoRunWhenReady defaults to true: an assigned task in a started project starts by itself once every prerequisite is DONE. To hold work until you say so, the agent passes autoRunWhenReady: false.
- Your own "Create and start" on the card starts it even if the agent asked for no start, and the agent does not undo that.

Try asking: *"File this for later; nobody should start it until I say so."* · *"Run the recorded migration task now."*

## When the CLI is the right tool

The Orbit CLI is for what MCP does not do well: pipes and scripts, bulk input from a file or stdin, the few operations with no MCP tool, and commands that must outlive the turn.

- The agent runs it by the absolute path Orbit gives it, never an orbit found on PATH: a project-local binary is not this runner's CLI.
- It finds a command with orbit guide [topic] --json or orbit capabilities --id <id> --json, and runs the argv they return.
- --receipt prints the same receipt the MCP tool answers with, and the command exits 0 exactly when it wrote; --json prints the entity alone.
- Never to get around a card, a refusal or a switch: the CLI reaches the same server under the same approvals, so a declined card or a missing switch there is the same answer.
- Outside a session, a script files work as you, with a personal access token (ORBIT_USER_TOKEN): the runner's own credential has no card-free door.
- The operations with no MCP tool are session_import, wiki_import, wiki_verify; the agent runs them at the CLI.

Try asking: *"File the 30 issues in issues.csv as tasks."* · *"Give me a command I can put in cron that files tomorrow's checklist."*

## When something is missing

Every refusal says why and what to do, and none of them is solved by another door: the switches stay where they are, and Agent tools shows which one is off.

- Agent tools on the session shows whether its engine started Orbit's MCP server, and in the engine's own words why not.
- A missing family of tools is a switch: Session orchestration for sessions, agents and runners; Watch for waits; the wiki for the wiki.
- A refused call answers with a receipt whose error.code and error.retry say what to do; the table below reads them for you.

| What you see | Why | What to do | Receipt code |
| --- | --- | --- | --- |
| The agent has no Orbit tools. | Its engine did not start Orbit's MCP server. Agent tools on the session shows Not connected, with the engine's own reason. | The agent can still use the Orbit CLI by the absolute path in its instructions, under the same approvals. A new session starts the server again. | — |
| No session, agent or runner tools, and a hand-off is filed as a task. | Session orchestration is off for this account. | Turn it on in Settings → Session orchestration. A session started before that gets the tools when its engine next starts; turning it off takes effect at once. | `ORCHESTRATION_OFF` |
| No task_await, session_await or watch tools. | Watch is off for this account on this Orbit server. | Nothing to change in the session: the agent looks again in a later turn instead of waiting. | — |
| No wiki tools. | The wiki is off for this account on this Orbit server. | The agent works from the code and from what you tell it. | — |
| A write is refused with SESSION_IN_PLAN_MODE. | The session is in Plan: Orbit's reads, waits and questions for you run, and every other write waits for the plan's approval. | Approve the plan or change the session's permission mode; the agent makes the write then. | `SESSION_IN_PLAN_MODE` |
| A write is refused with PERMISSION_MODE_UNREADABLE. | The session's process could not read its permission mode from the runner, so it wrote nothing. | The same call is safe to send again. If it keeps happening, the runner restarted under the session: start a new one. | `PERMISSION_MODE_UNREADABLE` |
| The agent says you declined a card. | You answered the card with no. | Nothing was written, and the agent does not create it another way. Ask again in your own words if you change your mind. | `APPROVAL_DECLINED` |
| A write is waiting. | Its card is waiting for your answer; the runner holds the call meanwhile. | Answer the card in the app; the agent is woken with your answer. A card that waits is not a no. | `AWAITING_OWNER` |
| The agent replies to what you wrote on a card instead of filing. | You pressed Chat about this: that is a conversation, not a no, and nothing was written. | Once you agree, the agent calls again, changed as agreed, and you get a new card. | — |
| A call is refused with INVALID_ARGUMENTS. | Its arguments do not fit the tool's schema; the receipt names every field that does not. | The agent fixes the fields it names and calls again: nothing was sent. | `INVALID_ARGUMENTS` |
| A create comes back with outcome unknown. | It was sent and no answer came back, so it may have landed. | The agent reads first (task_list) and only then decides; a create keyed with idempotencyKey is resent by the runner under the same key and cannot file twice. | `NO_RESPONSE` |
| A script on the runner is refused with TASK_WRITE_NEEDS_OWNER_CARD. | Outside a session, the runner's own credential cannot file work: that would be a way around your cards. | Run the script with your personal access token (ORBIT_USER_TOKEN); the work is recorded as you. | `TASK_WRITE_NEEDS_OWNER_CARD` |
| An orbit command behaves unlike the agent's tools. | A different orbit was found on PATH, such as a project-local build. | The agent runs the absolute path in its instructions; capabilities --json names the cliVersion that answered. | — |

Try asking: *"Why can't you start a session for this?"* · *"Call guide and tell me which Orbit tools you have and why any are missing."*

## Try asking: four examples

Each example is what you might say, what the agent does, the calls it makes on each surface and what proves it. The MCP calls pass their tools' own schemas and the command lines their commands' own flag parsers; `<…>` marks a value the agent fills in, and the CLI runs by the absolute path Orbit gives the agent.

### 1. Record a task

> *"File this for later: rotate the staging API key. Nobody should start it until I say so."*

Says what it is about to file, then makes one task_create with autoRunWhenReady: false and a key derived from the work. You answer one card; nothing starts.

MCP `task_create`:

```json
{"acceptanceCriteria":"<what you said would settle it>","autoRunWhenReady":false,"completionCriterion":"EVIDENCE_JUDGMENT","description":"<background, where the key lives, the steps>","idempotencyKey":"rotate-staging-api-key","title":"Rotate the staging API key"}
```

CLI:

```sh
orbit task create --title 'Rotate the staging API key' --description '<background, where the key lives, the steps>' --completion-criterion EVIDENCE_JUDGMENT --acceptance-criteria '<what you said would settle it>' '--auto-run-when-ready=false' --idempotency-key rotate-staging-api-key --receipt
```

**What proves it:** The receipt reads ok: true, outcome: written, with the task's id and status OPEN; the agent links it as the task's name, and no session starts. *(Contract scenarios E1-record-task, E3-create-no-start.)*

### 2. Keep a plan of several steps

> *"Keep that three-step migration plan in Orbit, in order, and hold the last step until I say so."*

Turns its private plan into one task_create_batch: one item per step, each later step dependsOnRefs the one before, the held step with autoRunWhenReady: false. One card covers the whole plan.

MCP `task_create_batch`:

```json
{"dryRun":true,"tasks":[{"acceptanceCriteria":"<what settles it>","completionCriterion":"EVIDENCE_JUDGMENT","description":"<what to do, the files, the steps>","ref":"s1","title":"Add the new columns"},{"acceptanceCriteria":"<what settles it>","completionCriterion":"EVIDENCE_JUDGMENT","dependsOnRefs":["s1"],"description":"<what to do, the files, the steps>","ref":"s2","title":"Backfill the rows"},{"acceptanceCriteria":"<what settles it>","autoRunWhenReady":false,"completionCriterion":"EVIDENCE_JUDGMENT","dependsOnRefs":["s2"],"description":"<what to do, the files, the steps>","ref":"s3","title":"Switch the reads over"}]}
```

MCP `task_create_batch`:

```json
{"idempotencyKey":"orders-migration-plan","tasks":[{"acceptanceCriteria":"<what settles it>","completionCriterion":"EVIDENCE_JUDGMENT","description":"<what to do, the files, the steps>","ref":"s1","title":"Add the new columns"},{"acceptanceCriteria":"<what settles it>","completionCriterion":"EVIDENCE_JUDGMENT","dependsOnRefs":["s1"],"description":"<what to do, the files, the steps>","ref":"s2","title":"Backfill the rows"},{"acceptanceCriteria":"<what settles it>","autoRunWhenReady":false,"completionCriterion":"EVIDENCE_JUDGMENT","dependsOnRefs":["s2"],"description":"<what to do, the files, the steps>","ref":"s3","title":"Switch the reads over"}]}
```

CLI:

```sh
orbit task create-batch --tasks-file - --dry-run --json
orbit task create-batch --tasks-file - --idempotency-key orders-migration-plan --receipt
```

**What proves it:** The receipt reads ok: true, outcome: written, with three ids in input order, each with its ref; the order is visible as dependencies when the tasks are read back. *(Contract scenarios E2-private-plan, E4-batch-plan.)*

### 3. Hand work off now

> *"Have someone fix the flaky watch test right now."*

Recorded work: task_start on it. Work not recorded yet: task_create with startNow: true, one card for both. A conversation of its own: session_create, which needs Session orchestration; without it the agent files a task and tells you where the switch is.

MCP `task_start`:

```json
{"taskId":"<taskId>"}
```

MCP `task_create`:

```json
{"acceptanceCriteria":"<what settles it>","completionCriterion":"EVIDENCE_JUDGMENT","description":"<the failing test, how it fails, where>","idempotencyKey":"fix-flaky-watch-test","startNow":true,"title":"Fix the flaky watch test"}
```

MCP `session_create`:

```json
{"prompt":"<the whole brief: what, where, how to check>"}
```

CLI:

```sh
orbit task start '<taskId>' --receipt
orbit task create --title 'Fix the flaky watch test' --description '<the failing test, how it fails, where>' --completion-criterion EVIDENCE_JUDGMENT --acceptance-criteria '<what settles it>' --start-now --idempotency-key fix-flaky-watch-test --receipt
orbit session create --prompt '<the whole brief: what, where, how to check>' --receipt
```

**What proves it:** A started session's id: task_start's receipt names it, a startNow create carries it as start.sessionId, and session_create's receipt is the session itself. *(Contract scenarios E6-immediate-delegation, E7-no-orchestration.)*

### 4. File many tasks from a script

> *"File the 30 issues in issues.txt as tasks, held until I start them."*

Uses the CLI's bulk door instead of one task_create per line: a script turns the file into one --tasks document (at most 50 items), a dry run shows where it lands, and one create-batch writes it on one card.

CLI:

```sh
jq -R -s 'split("\n") | map(select(length > 0)) | {tasks: map({title: ., description: ("Fix: " + .), completionCriterion: "EVIDENCE_JUDGMENT", acceptanceCriteria: "<what settles it>", autoRunWhenReady: false})}' issues.txt > plan.json
orbit task create-batch --tasks-file - --dry-run --json < plan.json
orbit task create-batch --tasks-file - --idempotency-key issues-txt-part-1 --receipt < plan.json
```

**What proves it:** --receipt prints one receipt with every item's id in input order, and the command exits 0 exactly when it wrote. Outside a session the same command runs with ORBIT_USER_TOKEN and is recorded as you. *(Contract scenarios E4-batch-plan.)*

## Workflows: the guide's recipes

The recipes the `guide` tool hands an agent (guide 1.1.0), generated from the operation catalogue: each step's MCP tool and the CLI command that does the same, and whether a person must answer first. `?` marks a step taken only when it applies. The agent reads the same recipe, with this session's availability, from `guide` with the topic, or `orbit guide <topic> --json`.

### `task-create` — Record one piece of work the user wants kept, followed up or done later

Try asking: *"File this for later: the staging API key needs rotating."* · *"Someone should fix the flaky watch test."*

| Step | MCP | CLI | Approval | Why |
| --- | --- | --- | --- | --- |
| 1? | `task_list` | `orbit task list` | none | When the work may already be recorded, or you are not sure which project it belongs to, read before you write (R4). |
| 2 | `task_create` | `orbit task create` | card | Write it. The call puts a confirmation card in front of the user and waits for their answer; nothing is written if they decline. |
| 3? | `task_get` | `orbit task get` | none | Read it back when the claim matters. |

**Done when:** The task_create receipt reads ok: true and outcome: written, with the task's id and status. Name it to the user as [title](orbit-task:<id>).

### `task-batch` — Keep a plan that is already worked out: several tasks with their order and parts, in one call

Try asking: *"Keep that plan in Orbit, in order."* · *"File these four steps so they run one after another."*

| Step | MCP | CLI | Approval | Why |
| --- | --- | --- | --- | --- |
| 1? | `task_create_batch` | `orbit task create-batch` | card | When you are not sure where the plan files, judge it first: a dry run writes nothing, asks nobody, and answers where every item would land. |
| 2 | `task_create_batch` | `orbit task create-batch` | card | Write the whole plan. One card covers every item, and nothing is written unless every item is valid. |
| 3? | `task_list` | `orbit task list` | none | See the filed plan. |

**Done when:** The receipt reads ok: true and outcome: written, with every item's id and status in input order, each echoing its ref.

### `project-create` — Record a whole body of work with its own goal and acceptance, coordinated from this conversation

Try asking: *"Set up the billing migration as a project, with what settles it."*

| Step | MCP | CLI | Approval | Why |
| --- | --- | --- | --- | --- |
| 1 | `project_create` | `orbit project create` | card | Propose it in a sentence or two first; the card is the user's answer, and a yes makes this conversation the project's coordinator. |
| 2? | `task_create_batch` | `orbit task create-batch` | card | File its worked-out plan under it: give every item the projectId the project's receipt returned. |

**Done when:** The project_create receipt reads ok: true and outcome: written, with the project's id. Name it as [title](orbit-project:<id>).

### `task-start` — Run work now: recorded work on its assignee, or new work created and started on one card

Try asking: *"Run the recorded migration task now."* · *"Fix this now: file it and start it."*

| Step | MCP | CLI | Approval | Why |
| --- | --- | --- | --- | --- |
| 1 | `task_start` | `orbit task start` | none | Recorded work runs now on its assignee; its prerequisites must be DONE. |
| 2? | `task_create` | `orbit task create` | card | Work not recorded yet: create and start it on one card with startNow: true, and do not call task_start after. |
| 3? | `task_await` | `orbit task await` | none | Be woken when the run ends instead of polling; end your turn after it. |

**Done when:** task_start's receipt names the started (or resumed) session's id and status; a startNow create's receipt carries it as start.sessionId.

### `task-schedule` — Have the server start work once, at a set time

Try asking: *"Run the release checklist at 09:00 tomorrow."*

| Step | MCP | CLI | Approval | Why |
| --- | --- | --- | --- | --- |
| 1 | `task_create` | `orbit task create` | card | New work: create it with runAt. |
| 2? | `task_update` | `orbit task update` | none | Recorded work: set its runAt. |

**Done when:** The receipt reads ok: true and outcome: written, and the task carries runAt as written.

### `delegate` — Hand work that should run now to another agent as its own conversation

Try asking: *"Have another agent look into the failing deploy while we keep going."*

| Step | MCP | CLI | Approval | Why |
| --- | --- | --- | --- | --- |
| 1 | `session_create` | `orbit session create` | none | Open the conversation on an agent; the sub-session follows its own permission mode. |
| 2? | `session_await` | `orbit session await` | none | Be woken when it finishes a turn; end your turn after it. |

**Done when:** session_create's receipt names the new session's id and status. Name it as [title](orbit-session:<id>).

### `inspect` — Read the state of a project, a task or a session before deciding anything

Try asking: *"What is still open in the agent-contract project?"* · *"Where is that task now?"*

| Step | MCP | CLI | Approval | Why |
| --- | --- | --- | --- | --- |
| 1? | `project_get` | `orbit project get` | none | A project's goal, acceptance criteria, instructions, blockers and task counts. |
| 2 | `task_get` | `orbit task get` | none | One task in full, with its comments and sessions; with no id, the task this session runs. |
| 3? | `task_list` | `orbit task list` | none | Tasks filtered by project, status, list or label, as compact rows. |
| 4? | `session_get` | `orbit session get` | none | One session's record. |

**Done when:** The document the read returned; quote ids from it, not from memory.

### `wait` — Wait for Orbit work to finish without holding the turn open

Try asking: *"Tell me when those three tasks are done."*

| Step | MCP | CLI | Approval | Why |
| --- | --- | --- | --- | --- |
| 1 | `task_await` | `orbit task await` | none | Tasks reaching a status: create the wait and end your turn; Orbit starts a new one when it holds. |
| 2? | `session_await` | `orbit session await` | none | Sessions finishing a turn. |
| 3? | `watch_create` | `orbit watch create` | none | Any other condition on Orbit's own objects. |

**Done when:** The await's receipt names the watch it created; the wake-up arrives as a new turn saying what changed.

### `wiki` — Find what is already known about a file or a pattern, and keep what you learned

Try asking: *"Remember this pitfall about the migration ledger."*

| Step | MCP | CLI | Approval | Why |
| --- | --- | --- | --- | --- |
| 1 | `wiki_search` | `orbit wiki search` | none | Search by the file's path, or by words, before changing it or proposing: a near neighbour is better reinforced than duplicated. |
| 2? | `wiki_get` | `orbit wiki get` | none | Read an entry in full, with the records it came from. |
| 3? | `wiki_propose` | `orbit wiki propose` | none | Record what you learned; the space's review mode decides, not you. |
| 4? | `wiki_note` | `orbit wiki note` | none | Leave a claim for maintenance to check against the records. |

**Done when:** wiki_propose answers with what the review mode did with the proposal, as its outputSchema states.

### `files` — Keep a screenshot, report or log in Orbit instead of the repository, or read one back

Try asking: *"Keep this screenshot with the task."*

| Step | MCP | CLI | Approval | Why |
| --- | --- | --- | --- | --- |
| 1 | `file_upload` | `orbit file upload` | none | Keep the file; it reads only this session's checkout and uploads directory. |
| 2? | `file_list` | `orbit file list` | none | What this task's sessions have uploaded. |
| 3? | `file_fetch` | `orbit file fetch` | none | Read a file back by id. |

**Done when:** file_upload answers the file's id, sha256, sizeBytes and an orbit-attachment: link to put in a reply.

### `task-list` — Give a class of work its own dispatch policy: a concurrency cap, a pause, standing instructions

Try asking: *"Run at most two of these at a time."*

| Step | MCP | CLI | Approval | Why |
| --- | --- | --- | --- | --- |
| 1? | `tasklist_list` | `orbit task-list list` | none | The lists that exist. |
| 2 | `tasklist_create` | `orbit task-list create` | none | A new list. |
| 3? | `tasklist_update` | `orbit task-list update` | none | Its maxConcurrent, its pause, or the instructions spliced into each run's prompt. |

**Done when:** The receipt reads ok: true and outcome: written, with the list's id.

### `agent` — Choose where work runs and under which identity, or change an agent's defaults

Try asking: *"Which agent should run this?"*

| Step | MCP | CLI | Approval | Why |
| --- | --- | --- | --- | --- |
| 1 | `agent_list` | `orbit agent list` | none | The agents (workspaces) there are, where each runs and under which identity. |
| 2? | `agent_update` | `orbit agent update` | card | Change one's defaults; the owner answers a card first. |
| 3? | `agent_create` | `orbit agent create` | card | A new agent; the owner answers a card first. |

**Done when:** The agent receipt's id and status, once the owner's card answer allowed it.

### `finish-task` — Carry the task this session runs to its end: progress, checks and the evidence its criterion decides by

Try asking: *"Finish the task you are running and submit its evidence."*

| Step | MCP | CLI | Approval | Why |
| --- | --- | --- | --- | --- |
| 1 | `task_get` | `orbit task get` | none | Read the task this session runs (no id needed), its acceptance criteria and its comments, before acting. |
| 2 | `task_progress_report` | `orbit task progress` | none | Report each change of phase or count; Orbit reads progress from this report alone. |
| 3? | `bg_run` | — | none | Run the checks you will cite as runner-hosted jobs, and cite each job id as a TOOL_CALL. |
| 4 | `task_evidence_submit` | `orbit task evidence-submit` | none | Submit claim, checks and gaps; the task's declared criterion decides DONE. |
| 5? | `task_comment` | `orbit task comment` | none | If the work failed or could not be finished, say why first, then set FAILED with task_update. |

**Done when:** task_evidence_submit's receipt echoes every citation with whether it resolved; at least one must.

## What the agent reads, and in what order

In the order each engine puts them in front of its model, with the role it reads them in, as measured on 2026-11-14 by recording each engine's own request (Claude Code 2.1.325, Codex 0.167.2). Agent tools on a session lists the layers that session really has.

### Claude Code

| # | Instructions | Role | Set by | Detail |
| --- | --- | --- | --- | --- |
| 1 | Claude Code's system prompt *(unless the workspace replaces it)* | System | The engine | The engine's own. |
| 2 | This workspace's base instructions *(when the workspace sets base instructions)* | System | The workspace | In place of Claude Code's own system prompt (--system-prompt). |
| 3 | This workspace's runtime instructions *(when the workspace has instructions)* | System · appended | The workspace | Appended to the system prompt (--append-system-prompt), before Orbit's. |
| 4 | Orbit's runtime instructions | System · appended | Orbit | The primer 1.2.0, then the CLI's absolute path, files, evidence, progress, waits and the wiki. Appended to the system prompt, so a compaction does not touch them. |
| 5 | CLAUDE.md files | Project context | The repository | Put by Claude Code at the top of your first message, as a reminder that they override its defaults. Orbit neither reads nor changes them. |
| 6 | Your messages | User | You | With the task or project context Orbit attaches to them. |
| 7 | Orbit MCP server instructions | System message | Orbit | The primer again, in the system message Claude Code adds after your first message, beside the environment and the list of skills. |
| 8 | Orbit playbooks · orbit:playbooks | On demand | Orbit | Listed in that system message by name; its recipes are read only when the agent opens it, and nothing depends on it. |

### Codex

| # | Instructions | Role | Set by | Detail |
| --- | --- | --- | --- | --- |
| 1 | Codex's base instructions *(unless the workspace replaces it)* | Developer | The engine | The engine's own. |
| 2 | This workspace's base instructions *(when the workspace sets base instructions)* | Developer | The workspace | In place of Codex's own base instructions (baseInstructions). |
| 3 | Orbit playbooks · orbit-playbooks | On demand | Orbit | Listed among Codex's skills by name and description; its recipes are read only when the agent opens it, and nothing depends on it. |
| 4 | AGENTS.md files | Project context | The repository | Read by Codex from the checkout. Orbit neither reads nor changes them. |
| 5 | This workspace's runtime instructions *(when the workspace has instructions; Codex 0.135 and later)* | Developer | The workspace | Application context, just before Orbit's. |
| 6 | Orbit's runtime instructions *(Codex 0.135 and later)* | Developer | Orbit | The primer 1.2.0, then the CLI's absolute path, files, evidence, progress, waits and the wiki. Application context, sent with every turn, so a compaction cannot drop them. |
| 7 | This workspace's runtime instructions *(when the workspace has instructions; Codex 0.125 to 0.134)* | Developer | The workspace | In the same developer message as Orbit's, before them. |
| 8 | Orbit's runtime instructions *(Codex 0.125 to 0.134)* | Developer | Orbit | The primer 1.2.0, then the CLI's absolute path, files, evidence, progress, waits and the wiki. One developer message, sent again after a compaction. |
| 9 | This workspace's runtime instructions *(when the workspace has instructions; Codex before 0.125)* | User · turn input | The workspace | In the same block as Orbit's, before them. |
| 10 | Orbit's runtime instructions *(Codex before 0.125)* | User · turn input | Orbit | The primer 1.2.0, then the CLI's absolute path, files, evidence, progress, waits and the wiki. At the top of every turn's input. |
| 11 | Your messages | User | You | Codex's own base instructions put your message ahead of a skill or a repository file. |
| 12 | Orbit MCP server instructions | With the tools | Orbit | Shown with Orbit's tools, cut to their first 250 characters; the runtime instructions above carry the whole primer either way. |

Orbit's own instructions are the same words on every engine: they begin with the primer, and nothing in a repository, a CLAUDE.md or an AGENTS.md, adds to them or takes them away. Where they disagree with your own message, your message steers the turn.

## Permission modes and Orbit's calls

What each mode means for Orbit's own calls; the authority, per engine and surface, is [permission-matrix.md](permission-matrix.md).

| Mode | Orbit's calls |
| --- | --- |
| Plan | Orbit's reads, waits and questions for you run. Every other Orbit write is refused with SESSION_IN_PLAN_MODE until the plan is approved, and background jobs are refused. |
| Default | Orbit's reads and waits run unasked. A create, a batch, a project, a provider or an agent change puts a card in front of you first, and a background job asks before it starts. |
| Accept Edits | As Default for Orbit's calls: a create, a batch or a project still puts a card in front of you, and a background job asks before it starts. |
| Don't Ask | Orbit's reads and writes run unasked, except a write that needs your card, which still asks. Background jobs are refused. |
| Auto | Orbit's calls run, and a write that needs your card still asks; on Codex a destructive call goes to Codex's own review first. Background jobs start without asking. |
| Bypass | Orbit's calls run, and a write that needs your card still asks. Background jobs start without asking. |

**Session orchestration.** Session orchestration is on for this account: the agent may open and steer sessions, and manage this account's agents and runners. A sub-session never gets a wider permission mode than this one. Session orchestration is off for this account, so the agent has no session, agent or runner tools and records a hand-off as a task instead. Turn it on in Settings → Session orchestration.

## Orbit's tools by family

Agent tools on a session counts each family as that session's engine lists it. The orchestration family is every tool the Session orchestration switch gates; the rest go by what the [operation catalogue](operation-catalog.md) says they act on. Claude Code also lists `permission_prompt`, its permission bridge, which is not for the agent to call.

| Family | Tools |
| --- | --- |
| Tasks (21) | `task_attribution`, `task_batch_pin`, `task_comment`, `task_confirmation_return`, `task_confirmation_review`, `task_create`, `task_create_batch`, `task_delete`, `task_dependency_add`, `task_dependency_graph`, `task_dependency_remove`, `task_evidence_decide`, `task_evidence_list`, `task_evidence_submit`, `task_get`, `task_labels`, `task_list`, `task_progress_report`, `task_reopen`, `task_start`, `task_update` |
| Projects (19) | `criterion_check_report`, `criterion_check_start`, `criterion_confirm`, `criterion_confirmation_withdraw`, `integration_abandon`, `integration_observe`, `integration_request_promotion`, `integration_retry`, `integration_skip_merge_check`, `open_item_resolve`, `project_blocker_resolve`, `project_create`, `project_crossings`, `project_delete`, `project_get`, `project_integration_get`, `project_request_done`, `project_request_start`, `project_update` |
| Task lists (6) | `tasklist_create`, `tasklist_delete`, `tasklist_get`, `tasklist_list`, `tasklist_propose_dag`, `tasklist_update` |
| Waits (6) | `task_await`, `watch_cancel`, `watch_create`, `watch_get`, `watch_list`, `watch_update` |
| Files (4) | `file_fetch`, `file_list`, `file_pin`, `file_upload` |
| Background jobs (5) | `bg_kill`, `bg_list`, `bg_output`, `bg_run`, `schedule_wakeup` |
| Questions for you (6) | `ask_owner`, `notify`, `open_item_hand_over`, `request_owner_action`, `task_request_confirmation`, `withdraw_owner_request` |
| Wiki (5) | `wiki_draft`, `wiki_get`, `wiki_note`, `wiki_propose`, `wiki_search` |
| Providers (4) | `provider_create`, `provider_delete`, `provider_list`, `provider_update` |
| Merge receipts (3) | `merge_receipt`, `merge_receipts`, `project_merge_evidence` |
| Guide (1) | `guide` |
| Sessions, agents and runners (22) | `agent_create`, `agent_delete`, `agent_list`, `agent_update`, `project_ensure_coordinator`, `project_send`, `runner_delete`, `runner_engine_install`, `runner_engine_install_status`, `runner_list`, `session_await`, `session_complete`, `session_create`, `session_delete`, `session_end`, `session_get`, `session_interrupt`, `session_list`, `session_merge`, `session_reply`, `session_search`, `session_send` |

## The playbooks skill

Orbit's long recipes: keeping a worked-out plan as one batch, filing many tasks from a file with the CLI, handing work off now, and finding out why an Orbit tool is missing or refused. Optional: guide and the tools' own descriptions are enough for any single call. Claude Code loads it as `orbit:playbooks`, from a plugin the runner writes into the session's own directory and passes with `--plugin-dir`; Codex lists it as `orbit-playbooks`, from a skill root the runner hands its app server (`skills/extraRoots/set`). Neither touches your own Claude Code or Codex configuration, and Agent tools shows whether this session's engine took it. Its recipes, word for word:

### Keep a worked-out plan

When: The person asks you to keep a plan that is already worked out and counted, or several related pieces of work at once.

1. Pick the record. One item is one task_create. Several related items are one task_create_batch (at most 50). A body of work with its own goal and acceptance, 4 or more dependent steps or several agents over days, may be proposed as project_create first; its card is the person's answer, and a no means tasks.
2. Give every item a ref (s1, s2, ...). Order with dependsOnRefs (when an item may run) and nest with parentRef (what it is part of). dependsOnTaskIds and parentTaskId name tasks that already exist.
3. Ask the person what would settle each item and pass their words as acceptanceCriteria; declare completionCriterion on every item. If they have not said, ask and end your turn.
4. Hold what must not start: autoRunWhenReady: false on that item. startNow: true only on an item they want running now.
5. Unsure where it lands? Call task_create_batch with dryRun: true first: it writes nothing and asks nobody.
6. Say in a sentence or two what you are about to file, then call task_create_batch once, keyed with an idempotencyKey derived from the plan.
7. Read the receipt: ok: true, outcome: written, items[] in input order, each with its id. Link each as [title](orbit-task:<id>). A declined card is a refusal: do not file it another way.

### File many tasks from a file

When: The work arrives as a file or a list too long to type: issues in a text file or a CSV, lines of a checklist.

1. Use the CLI's bulk door, by the absolute path your instructions give, never one task_create per line.
2. Build one --tasks document of at most 50 items with a script; every item carries title, description, completionCriterion and acceptanceCriteria, and autoRunWhenReady: false when it must wait.
3. Preview it: orbit task create-batch --tasks-file - --dry-run --json writes nothing and says where every item would land.
4. Write it: orbit task create-batch --tasks-file - --idempotency-key <a slug of the batch> --receipt. Inside a session it puts one card in front of the person; it exits 0 exactly when it wrote.
5. More than 50 items: split them into parts, each with its own key. A part that fails can be sent again with the same key and cannot file twice.
6. Outside a session (cron, CI) run the same command with the person's own token: ORBIT_USER_TOKEN=<token> orbit task create-batch ... is recorded as them and needs no card. The runner's machine credential cannot file work on its own (TASK_WRITE_NEEDS_OWNER_CARD).

```sh
jq -R -s 'split("\n") | map(select(length > 0)) | {tasks: map({title: ., description: ("Fix: " + .), completionCriterion: "EVIDENCE_JUDGMENT", acceptanceCriteria: "<what settles it>", autoRunWhenReady: false})}' issues.txt > plan.json
orbit task create-batch --tasks-file - --dry-run --json < plan.json
orbit task create-batch --tasks-file - --idempotency-key issues-txt-part-1 --receipt < plan.json
```

### Hand work off now

When: The person wants work running now, by another agent or in a conversation of its own.

1. Recorded already, with every prerequisite DONE: task_start on it. Its receipt names the started session.
2. Not recorded yet: task_create with startNow: true. One card covers the create and the start; do not call task_start after it.
3. The person wants a separate conversation rather than a work item: session_create on an agent. It exists only with Session orchestration on, and a sub-session never gets a wider permission mode than yours.
4. No session_* tools in your list: orchestration is off. Record the work as a task, tell the person the switch is in Settings -> Session orchestration, and never claim a delegation.
5. Then wait without polling: task_await or session_await, and end your turn. Orbit starts a new turn in this session when it finishes.

### Find out why an Orbit tool is missing or refused

When: A tool you expected is not in your list, or a call was refused and you are not sure why.

1. Call guide: it is listed in every session and only reads. Its index says, route by route, whether the route is available here and why not.
2. No Orbit tools at all: your engine did not start Orbit's MCP server. Use the CLI at the absolute path your instructions give: orbit guide --json, then orbit capabilities --summary --json, whose unavailable and withheld groups say why each command is missing.
3. A refused call: read its receipt, not its prose. error.code says what happened and error.retry what to do: resend, reread_first, fix_input, do_not_retry or wait.
4. Never get around a refusal by changing surfaces: MCP and the CLI reach the same server under the same approvals, so the answer would be the same, and a second ask without a new question.
5. Tell the person what is missing and where the switch is; the switches are theirs to change.
