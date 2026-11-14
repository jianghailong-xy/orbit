# Orbit Agent Contract v1

> **Status:** frozen at v1.3.0, 2026-11-14 (v1.0.0 review record in §11; the 1.1.0, 1.2.0 and 1.3.0
> changes are in §10). v1.1.0 adds the operation catalogue and changes no routing rule; v1.2.0 closes the
> card-free task-write door on the runner's machine credential; v1.3.0 publishes §0 as the always-on
> agent primer (§2.6) and changes no rule. This file is the authority for how an
> in-session Claude or Codex agent uses Orbit: which object an intent belongs to, whether it travels
> over MCP or the CLI, what a person must approve, how failures and retries are handled, and what
> counts as a success receipt. The implementation tasks P0-02 … P2-01 work from this file. If the code
> conflicts with it, change this file first and say why.
>
> **Machine-readable index:** [`contracts/orbit-agent.contract.json`](../contracts/orbit-agent.contract.json)
> carries the same version, the route table, the scenario ids and the baseline verdicts.
> **Baseline recorded:** 2026-11-13, `orbit` 0.1.254 (source `d660dc78`), repository `main` at
> `35fc5b8a0`, server `https://orbitd.io`. Measurements and repro commands are in §8.
> **Not the same document as** [`project-agent-contract.md`](./project-agent-contract.md): that one
> freezes the Project/Task/Agent/Workspace domain for the V1 execution routing (and has no live
> control loop). This one is the agent-facing usage contract: what an agent should call, when, and
> what it may claim afterwards.

---

## 0. One page: the rules an agent must be able to quote

1. **Orbit is the user's durable record; the engine's plan is private scratch.** A built-in todo or
   plan tool is for the agent's own steps. Anything the user asked to record, or follow-up work they
   should see, goes to Orbit. Never present a private plan as an Orbit task, and never claim a task
   exists without an id Orbit returned.
2. **Pick the object by the question it answers.** Project = the whole goal and its acceptance;
   Task = one durable work item; Task list = dispatch policy; Session = one immediate execution;
   Agent = where it runs and under which identity. When two objects both seem to fit, the smaller
   one wins by default, and one task beats a project.
3. **MCP first, CLI for what MCP cannot do.** Use the `mcp__orbit__*` tools when the tool list has
   them. Reach for the CLI for pipes, scripts, bulk stdin, and the few operations with no MCP tool —
   never to get around a card, a refusal, or a missing authorization.
4. **Create is not start — but the default can start it later.** `task_create` does not run anything
   in the call. It records work. Start is a trigger: `task_start`, `startNow: true`, `runAt`, the
   person's own "Create and start" on the card — **and `autoRunWhenReady`, which defaults to true**.
   An in-project task with an assignee therefore starts by itself once the project has started and
   its prerequisites are `DONE`. When the user says nobody should start it, pass
   `autoRunWhenReady: false`; omitting the field is not "do not start".
5. **A person answers the consequential writes.** A create, a batch, a project, a provider change and
   every owner-only decision are cards. The card is the approval; there is no second door. A declined
   card is a refusal, never a success.
6. **Success is a receipt with an id.** A write is done when the call returns the entity's id and
   status. Link it for the user as `orbit-<kind>:<id>`; do not paste bare ids.
7. **Retry only what is safe.** Server-side transient conflicts are retried for you; a caller's retry
   is safe for reads, for operations with a caller idempotency key, and after a re-read proves the
   first attempt did not land. A create answered by nothing is re-read before it is sent twice.
8. **Same semantics on both surfaces.** MCP and the in-session CLI must produce the same
   authorization, approval, attribution, side effects and ids for the same input. A difference is a
   defect in the surface, not a licence for the agent. Since v1.1.0 the rule is enforced in the
   control plane by caller identity, not by whichever surface remembered to ask: see §2.4.
9. **Orchestration is one account switch, and it is not a mode.** With it off there are no session,
   agent or runner tools; file durable work as tasks and say where the switch is; never claim a
   delegation.
10. **After compaction or resume, re-derive.** Read the project, task or session again from a tool;
    never reconstruct an id, a status or an approval from remembered prose.

---

## 1. Object model

### 1.1 The five objects

| Object | Question it answers | What it is | What it is not | Lifecycle |
| --- | --- | --- | --- | --- |
| **Project** | "What is the whole thing for, and what settles it?" | The durable context a body of work is carried out from: `goal`, `acceptanceCriteriaItems`, `instructions`, `status`, optional coordinator session. A Project's acceptance is its own criteria; tasks declare which criterion they serve. | A container for one task; a folder; a plan. A plan is not a project until it is a body of work with its own acceptance. | `OPEN` → `DONE` / `CANCELLED`. Done is derived from criteria (satisfied **and** landed), requested by the coordinator and recorded by the owner; no agent sets it directly. |
| **Task** | "What is the one piece of work?" | The durable work item: title, executable `description`, exactly one `completionCriterion`, `acceptanceCriteria`, status, optional project, list, assignee (Agent), parent, prerequisites, priority, labels, due date, run schedule. | The agent's todo list; a session; a note. | `OPEN` → `IN_PROGRESS` → `DONE` / `FAILED` / `CANCELLED`. Completion is the projection of its declared criterion, never a direct write. |
| **Task list** | "How is this class of work dispatched?" | The dispatch policy: `maxConcurrent`, `paused` (a dispatch hold, not a stop of runs already in flight), standing `instructions` spliced into each run prompt, and the queue in which task `priority` orders what is ready. | A plan; a project; a grouping for display only. It decides *when* work may run, not *what* the work is. | Exists until deleted. A paused list stays paused until someone unpauses it. |
| **Session** | "What is running right now?" | One engine conversation on a runner: task-linked (the run of a task) or standalone (a conversation), with status, engine, provider, model, permission mode, spawn depth. | The durable record of the work. A session can end; the task outlives it. | `PENDING` → `RUNNING` → `AWAITING_INPUT` (turn settled, not terminal) → … → `SUCCEEDED` / `FAILED` / `CANCELLED` / `INTERRUPTED`, then lifecycle `COMPLETED` / `TRASH`. |
| **Agent** | "Where does it run, and under which identity?" | The execution identity and location an operation is attributed to: name, working directory, runner binding, system prompts, environment, effort, and a legacy model pin. A workspace holds no engine or provider of its own — the engine/provider a run uses is bound on the session. In the live product this is the `workspace` row that MCP `agent_*`, CLI `orbit agent` and `task_start` all name. | A permission grant; a project role; the human. (The frozen domain contract separates a future pure-identity `agent` table from the workspace location — see `project-agent-contract.md` §3.1; the agent-facing alias is the workspace row until that split ships.) | Created, configured, deleted by the owner's account; sessions run under it. |

### 1.2 Identity and naming

- Public ids are base62 of a UUID, not the UUID text (`public-id-migration-design.md`). Task
  `34Asaeh8g4zImZsGGIXBy` is a normal id; a 36-character UUID in a tool argument is a mistake.
- MCP tools and CLI commands accept and return public ids. The API also accepts UUIDs in some
  places; the contract only promises public ids.
- When an id is shown to the user, link it by name: `[Fix login redirect](orbit-task:<id>)`, and
  likewise `orbit-session:`, `orbit-project:`, `orbit-list:`, `orbit-wiki:`. The bare id is
  meaningless in prose; clients turn the link text into the name and the click into the object.
- An agent never invents, abbreviates, or reconstructs an id. If it was not read from a tool result
  in this turn or a tool re-read after compaction, it is not known.

### 1.3 Routing: intent → object → operation

**Rule R1 — one answer per intent.** For each intent below, the first matching row wins. "None" is a
valid answer: not every user sentence is an Orbit write. Watch, Wiki and File (R1.9-R1.11) are
auxiliary resources, not part of the five-object work model.

| # | The user says / the situation | Object | MCP operation | CLI equivalent | Human gate |
| --- | --- | --- | --- | --- | --- |
| R1.1 | "Remember this / file it / do it later / someone should fix it" | Task | `task_create` | `orbit task create` | Create card |
| R1.2 | "Here is a plan we should keep" — the plan is already worked out and counted | Tasks (batch) | `task_create_batch` with `ref` / `dependsOnRefs` / `parentRef` | `orbit task create-batch --tasks-file -` | One batch card |
| R1.3 | "Set up / record this whole body of work, with its own goal and acceptance" — 4+ dependent steps, or several agents over days | Project | `project_create` | `orbit project create` | Project card; a yes makes this conversation the coordinator |
| R1.4 | "Run it now" — work already recorded | Task | `task_start` | `orbit task start` | None once recorded; prerequisites and assignee must hold |
| R1.5 | "Run it now" — work not recorded yet | Task | `task_create` with `startNow: true` | `orbit task create --start-now` | One card covers create **and** start |
| R1.6 | "Do it at 09:00 / tomorrow" | Task | `task_create` / `task_update` with `runAt` | `--run-at` | Create/update card |
| R1.7 | "Hand this to another agent / start a conversation for it" | Session | `session_create` (orchestration only) | `orbit session create` | None on the call; the sub-session follows its own permission mode |
| R1.8 | "What is the state of this project / task / session?" | none (read) | `project_get`, `task_get`, `task_list`; `session_get` only with orchestration | `orbit project get`, `orbit task get/list` | None |
| R1.9 | "Wait for it to finish" | Watch | `task_await` / `session_await` / `watch_create` | `orbit task await`, `orbit watch` | None |
| R1.10 | "Remember this lesson / this pitfall" (about a file or a pattern) | Wiki | `wiki_search` then `wiki_propose` / `wiki_note` | `orbit wiki …` | Wiki review mode, not the agent |
| R1.11 | "Keep this file / check my screenshot" | File | `file_upload` / `file_fetch` / `file_list` | `orbit file …` | None; scope is the session's directories |
| R1.12 | "This class of work needs its own dispatch policy" — a concurrency cap, a pause, standing instructions | Task list | `tasklist_create` / `tasklist_update` | `orbit task-list create/update` | None; most tasks need no list (R2) |
| R1.13 | "Which agent should run this / change an agent's defaults" | Agent | `agent_list` (read) and `agent_create` / `agent_update` — **the whole family needs orchestration** | `orbit agent …` (orchestration) | Agent writes: a card; agent reads: none |
| R1.14 | "Tell me / explain / edit this code / answer a question" | none | none | none | — |

**Rule R2 — the smaller object wins.** If R1.3 and R1.1 both fit, file the task. If R1.2 and R1.1
fit (one item), file one task. A project needs a worked-out plan, not a forecast.

**Rule R3 — never double-record.** The work this session is already doing is recorded already: do
not create a task per step, a task for the current task, or a session to do what this turn can do.

**Rule R4 — read before write when the destination is uncertain.** `task_list --project-id` and
`project_get` answer "does this already exist / where does it belong"; a `create-batch --dry-run`
answers "where would this plan land" without writing. Use them instead of guessing an id.

### 1.4 The private plan vs the durable record

This is the contract's most consequential distinction:

| | Engine plan / todo (`TodoWrite`, plan mode, a numbered list in the reply) | Orbit record |
| --- | --- | --- |
| Who can see it | only this conversation, until it is compacted away | the user, the UI, other agents, later sessions |
| Lifetime | the turn / the context window | durable |
| What it proves | nothing outside the conversation | an id and a status |
| When to use it | the agent's own steps inside the current turn | work the user asked to keep, follow-up work, anything that must survive this conversation |
| How to persist it | — | `task_create_batch` (a plan) or `project_create` (a body of work) |

**Rule R5.** An agent may keep any private plan it likes. It must not (a) call a private plan a
task, (b) answer "filed it" without an id, or (c) refuse to record work because its own plan said
it would do it later. When the user says "save this plan", the plan is `task_create_batch` — one
task per item, dependencies as `dependsOnRefs`, subtasks as `parentRef`, in one atomic call.

---

## 2. Surfaces: MCP first, the CLI by exception

### 2.1 The default

An in-session agent uses the Orbit MCP tools when its tool list carries them (Claude Code names them
`mcp__orbit__*`; each engine spells the same server's tools in its own way). Reasons, in the order
that matters: their inputs are schema-checked, they need no shell and no path, they cannot
accidentally be a different `orbit` binary, and they carry this session's identity without an
argument.

### 2.2 When the CLI is the right surface

| Situation | Why the CLI | Example |
| --- | --- | --- |
| Bulk input from a file or stdin | the MCP schema takes a JSON array, but a plan is easier to write and review as a file | `orbit task create-batch --tasks-file - < plan.json` |
| Shell composition / pipelines | the result feeds another command | `orbit task list --json \| jq '.[].id'` |
| An operation with no MCP tool | the MCP surface is smaller than the CLI in a few places | `session_import`, `wiki_import`, `wiki_verify` (baseline §8.2) |
| Headless or service-token automation | there is no live session to attribute to or to card; the machine credential cannot write carded work without one | `ORBIT_USER_TOKEN=… orbit task create …` |
| A command that must outlive the turn | a long build/test is a background job, whichever surface starts it | `bg_run` (MCP) or `orbit …` inside it |

### 2.3 When the CLI is *not* allowed

- **Not to get around a card.** If `task_create` is declined, `orbit task create` is the same write
  and the same person; using it to try again is a second ask without a new question.
- **Not to get around the orchestration switch.** Session, agent and runner commands are hidden when
  the switch is off; their absence is the answer.
- **Not by a PATH-resolved `orbit`.** A project-local or PATH-shadowed binary is not this runner's
  CLI. Use the absolute path the runner advertises (the instruction text carries it), and
  `orbit capabilities --json` for discovery.
- **Not as a second opinion on a refusal.** The server is the same server; a refusal is the answer.

### 2.4 Invariants both surfaces share

| Invariant | Meaning |
| --- | --- |
| Authorization | The same credential, account, live session and orchestration evaluation. No surface is a wider door. |
| Approval | Inside a session, a create/batch/project/provider write files the same card and waits for the same answer. The runner's machine credential has no card-free write of its own; a headless process that must file work acts as the owner with a personal access token (§4.5). |
| Attribution | Inside a session, the write is attributed to this agent and linked to this session; a person's own credential is recorded as the person. The model never invents an author. |
| Identity and ids | Same entity, same public id, same status. A task created over the CLI is fetchable by the MCP `task_get` with no translation. |
| Output | `--json` emits the entity document on stdout and nothing else; hints go to stderr. MCP returns the entity document as the tool result text. |
| Failure | A refusal is a refusal on both surfaces, and a declined card is ONE document: `{"refused":true,"code":"APPROVAL_DECLINED","tool":…,"message":…,"decidedBy":…}`. MCP returns it as the tool result text; the CLI returns it as the command's error (stderr, non-zero exit). The transport differs because a tool result is not a process; the outcome does not. |

**Since v1.1.0 the approval row is enforced by the control plane, by caller; since v1.2.0 it has no
session-less exception on the machine credential.** The runner's machine credential is the agent's
credential: `POST /runner/tasks`, `POST /runner/tasks/batch-create` and
`POST /runner/task-lists/:id/dag-apply` each require a usable acting session (this runner's, this
account's, not ended) and an ALLOWED approval card filed by that session covering the exact write
(its items, its edges, its body); otherwise they refuse with `TASK_WRITE_NEEDS_OWNER_CARD` and write
nothing. A request that names no session is refused too — the header is attribution, not
authentication, so "no session" may be an agent that unset it. The card-free door belongs to the
person's own credential on the user routes (`POST /api/tasks`, `/api/tasks/batch-create`), which is
deliberate and is stated in §4.5.

### 2.5 Discovery

- MCP: the tool list is the catalogue. Read a tool's description before choosing it; descriptions
  state the defaults, the required declarations and the dangerous combinations.
- CLI: `orbit capabilities --json` is the catalogue (`id`, `argv`, `helpArgv`, `usage`, `arguments`,
  `description`, `mcpInputSchema`, `mutates`, `available`, plus `cliVersion`, `sourceSha`, `context`,
  `identity`). Run the returned `argv` with the absolute path, never a hand-written guess. Since
  v1.1.0 every entry also states `object`, `intent`, `risk`, `approval` (with `approvalKey` and
  `approvalDetail`), `destructive`, `idempotency`, `retry`, `successEvidence`, `nextStep`, `returns`
  and `availability`, and the document carries `catalogVersion` and `catalogHash` naming the
  operation catalogue it was projected from (`src/runner-go/operation_catalog.go`, rendered for a
  person as [`operation-catalog.md`](./operation-catalog.md)). The same catalogue produces the MCP
  `tools/list` payload and records why an operation is deliberately absent from one surface; a
  mandatory test executes every advertised `argv` and `helpArgv` through the CLI's own router. There
  is still no graded discovery — the document remains one ~300 KB blob in the fullest context
  (§8.2), which is why P1-01 exists.

### 2.6 The always-on primer

§0 is also the first thing every agent Orbit runs reads, as one short text: the **agent primer**
(`src/runner-go/agent_primer.go`; primer `1.0.0`, written from contract `1.3.0`). Its first line names
both versions. It says the ten rules in eight paragraphs, names tools by their MCP names, and carries
no engine's spelling of them and no path, so the same words are true in every client. The same text
travels by two kinds of carrier:

| Carrier | Engine | When it is there |
| --- | --- | --- |
| MCP `initialize` → `instructions` | every engine, through `orbit mcp` | whenever the engine starts the server; Claude Code 2.1.325 shows the whole of it under "MCP Server Instructions" and attaches it again after a compaction (measured 2026-11-14: after a manual `/compact` it still quoted the primer's first line) |
| `--append-system-prompt` | Claude Code | every spawn, `--resume` included; a compaction does not touch the system prompt |
| application context (`additionalContext`), whole paragraphs in values of at most 900 bytes | Codex ≥ 0.135 | every turn, under keys whose generation advances after a compaction, so Codex adds them again |
| one developer message (`thread/inject_items`) | Codex 0.125–0.134 | at thread start, and again before the first turn after a compaction |
| the turn's own input, in `<orbit_application_context>` | Codex < 0.125 | every turn |
| the prompt, in `<orbit-agent-instructions>` | Kimi Code; Cursor CLI | Kimi: every prompt; Cursor: the conversation's first |
| global rules (`GEMINI.md` in the runner's own Gemini directory); appended system prompt; instructions file | Antigravity; DeepSeek Harness; OpenCode | every process the runner starts |

The engine-side carriers open with the primer and go on with what only the runner knows: how this
engine spells Orbit's tools, the CLI's absolute path, which files a reply can hand over, where
evidence goes, the project paragraph for the session's shape, progress, waits and the wiki. They are
sent whether or not the MCP instructions arrived, because the runner cannot see which reached the
model: on 2026-11-14 Codex 0.167.2 showed only the first **250 characters** of a server's
instructions, as that server's line in its list of deferred tools (`codex debug prompt-input` with a
probe server), and a session whose MCP server did not start has none at all. Claude Code therefore
reads the primer twice, about 3 KB, which is the price of a fallback that does not depend on the
carrier it backs up. Nothing in either carrier is read from the checkout: a repository's `CLAUDE.md`
or `AGENTS.md` neither adds to the primer nor changes it.

What the text is held to (`src/runner-go/agent_primer_test.go`):

- **The first paragraph stands alone, in at most 512 characters**: what is a record and what is
  scratch, which create answers which intent, MCP before the CLI, create versus start
  (`autoRunWhenReady` defaults to true), and that only a returned id is a success. A client may show
  no more than that, and Codex shows less, so it opens with what Orbit is for.
- **Budgets**: the primer at most 3,200 bytes; Orbit's own instructions to an engine (the primer and
  the paragraphs after it, without the agent's own prompt) at most 6,400 bytes; no paragraph longer
  than one Codex context value (900 bytes, under Codex's 1,000-token cap whatever the tokenizer);
  ASCII.
- **Versioned and snapshotted**: the exact text of the primer and of the four shapes of the engine
  instructions are snapshots (`src/runner-go/testdata/agent-primer/`), and the primer's hash is
  recorded per version, so a changed word is a new primer version and a reviewed diff.
- **Every §0 rule is said**: a rule added to §0 fails the test until the primer says it too.

`orbit mcp help` (also `orbit mcp --help`, `orbit help mcp`) names the runtimes the runner starts the
server on and the objects its tools act on, read from the runner's runtime table and from the
operation catalogue, and the primer version `initialize` answers with.

---

## 3. Create, start and schedule

### 3.1 The rule

**Create records. Start runs.** They are separate writes, separate approvals in general, and separate
receipts. The one trap is `autoRunWhenReady`, which is **true by default**.

| Call | Writes | Dispatches a run | Receipt proves |
| --- | --- | --- | --- |
| `task_create` (no start field) | one task, `OPEN` | not in the call; **can start later** — with `autoRunWhenReady` defaulting to true, an in-project task starts once the project has started and its prerequisites are `DONE` | the record exists (task id + status) |
| `task_create` `autoRunWhenReady: false` | one task, `OPEN` | no: the task waits for a human or agent to start it | the record, and that it will not start itself |
| `task_create` `startNow: true` | one task, scheduled to start now | yes — the runner starts it at once after the create (the server's once-a-minute scan is the fallback) | the record **and** the start (created task + the started run/session) |
| card answer "Create and start" | one task | yes, even if the agent asked for no start | as above; this is the person's override |
| `task_create` `runAt: <time>` | one task, scheduled | at that time, once | the record and the schedule |
| `task_create` `autoRunWhenReady: true` (the default) | one task | when an assignee is bound and **all prerequisites are DONE**, and for a project task once the project has started; a task in no project with no prerequisites is never started by it | the record and the trigger, not a run |
| `task_start` | no task | yes — creates or resumes the task's session and queues it | the run (session id) |
| `task_create_batch` | up to 50 tasks, atomically | per item, by that item's `startNow` / `runAt` / `autoRunWhenReady` (default true) | every item's id/status; per-item start outcomes |
| `task_create_batch` `dryRun: true` | nothing | nothing | where each item **would** land; never a success receipt for a write |

### 3.2 Consequences an agent must respect

1. **"Do not start it" means `autoRunWhenReady: false`.** A create does not run work in the call, but
   with the default true an in-project task with an assignee can start by itself the moment the
   project is started and its prerequisites are done. Omitting the field is not a promise of rest.
   Do not tell the user it is running, and do not call `task_start` "to be safe" — that is a second
   decision they did not make. The other exception is the person's own card answer "Create and
   start", which the agent must not undo.
2. **`autoRunWhenReady` starts on readiness, not on a clock.** It waits for every prerequisite to
   reach `DONE`; for a project task it also waits for the project to have started; and a task in no
   project with no prerequisites is never started by it.
3. **`startNow` and `runAt` are mutually exclusive.** `startNow` sets the run time to now; do not
   pass both.
4. **A start needs a live target:** the task has an assignee bound to a runner and every
   prerequisite is `DONE`; `task_start` creates the task-linked session or resumes it. A refusal
   names what is missing; fix that, do not route around it.
5. **A batch is one unit.** It is all-or-nothing on validation, its items are created in order, a
   later item may depend on an earlier one by `ref`, and the whole batch is one card. `autoRunWhenReady`
   is true per item unless the item sets false. Use `dryRun` before filing a plan whose attribution
   or landing you are not sure of.

---

## 4. Permissions, approvals and identity

### 4.1 Permission modes and what they mean for Orbit calls

A session's mode decides what runs without a person. The shell and background-job columns are the
product's (`runner-cli.md` §Permission modes, `background_gate.go`). The Orbit column is split by
engine because the two engines enforce it differently, and that difference is part of this contract.

| Mode | Claude shell (`Bash`/`Monitor`) | Background jobs (`bg_run`) | Orbit MCP / CLI calls — Claude | Orbit MCP / CLI calls — Codex | Target (P1-02) |
| --- | --- | --- | --- | --- | --- |
| `plan` | a card per command; the Auto classifier is off | **refused**, with what to do instead | no runner gate; a consequential write still files its card (whether Claude's own plan policy refuses an MCP call is not measured) | **refused**: Codex's MCP consent is answered `false` automatically, reads included | reads allowed on both engines, writes refused without leaving plan |
| `default`, `acceptEdits` | a card per command not already allowed | a card showing what would run | no runner gate; a consequential write still files its card | **every MCP call raises a consent card** (Codex asks per call; acceptEdits auto-answers only file changes) | no card for routine Orbit reads; writes keep their own card |
| `dontAsk` | refused unless already allowed | refused | no runner gate; the create cards still ask (a question is not a job) | MCP consents auto-approved (the `never` policy); writes keep their own card | unchanged, but state it |
| `auto` | runs without asking (Auto's own classifier decides) | started | no runner gate | Orbit's own MCP server auto-approved; third-party servers still reach the person | unchanged |
| `bypassPermissions` | runs without asking | started | no runner gate | MCP consents auto-approved | unchanged |

The person, not the mode, is the stop for a create/batch/project/provider write: the create card is
filed even in `auto`. What the mode changes is whether the *engine's shell* is allowed to run the same
thing another way, and whether a background job starts.

Codex's consent rule is implemented in the runner (`codexAutomaticApproval`,
`bridgeCodexApprovalWithContext`): `plan` denies, `auto` approves Orbit's own server, the `never`
modes approve every MCP consent, and `default`/`acceptEdits` hand each call to the person. This is why
the same Codex session can be unusable in `default` (a card per `task_list`) and silent in `auto`, and
why P1-02's matrix must be per engine rather than one table.

### 4.2 The human gates

| Gate | What it covers | Who answers | A "no" means |
| --- | --- | --- | --- |
| Task create card | one task (and, if chosen, its start) | the account owner, in the session's conversation | nothing is written; do not create it another way |
| Batch card | up to 50 tasks and their edges | the account owner | no item is written |
| Project card | a new project and its goal/acceptance | the account owner; a yes binds this conversation as coordinator | do not propose the same body of work twice |
| Provider create/update card | credentials and defaults | the account owner | nothing changes |
| Agent write card | `agent_create`, `agent_update`, `agent_delete` (orchestration only) | the account owner | nothing changes |
| DAG proposal card | a task-list plan | the account owner | nothing is written |
| Owner-only decisions | `OWNER_CONFIRMED` confirmation, project start/done requests, cross-project moves, go-live, the orchestration switch | **only the account owner**, in the app | it did not happen; no agent can confirm on their behalf |
| Permission prompt (Claude) | a tool call the engine would otherwise ask about | the account owner | the call is refused |

Rules: a card may wait indefinitely — a person may be asleep. Do not treat a pending card as a no,
do not re-file the same question, and do not sign the person's answer for them.

### 4.3 Orchestration

One account-level switch (Settings → Session orchestration). It gates the `session_*`, `agent_*` and
`runner_*` tool families, `project_send`, `project_ensure_coordinator`, and the same CLI commands.
It requires an exact live session; ending the session, reassigning it, or turning the switch off
revokes access immediately, without waiting for a proof to expire.

With it **off**, an agent has no delegation surface at all. The correct behaviour is: file the work
as a task (durable), tell the user where the switch is if they asked for delegation, and never claim
a session was started.

### 4.4 Attribution and identity

- In a session, writes are attributed to the session's agent and linked to the session. The runner
  and MCP read the same `ORBIT_AGENT_ID`; the two write paths must not disagree on who created a task.
- A person's own credential (`orbit login` or a personal access token) is recorded as the person:
  `creatorType: USER` with the account as the author and no session link.
- Other headless mutations made on the runner credential (a comment, a policy update) fall back to
  the runner owner; the carded task writes do not have that fallback (§4.5).
- A sub-session created with `session_create` runs under the named agent; it can never have a wider
  permission mode than its parent, and an agent cannot grant itself a mode it does not hold.
- The human is never impersonated: no tool lets an agent answer an owner-only decision, and no
  agent writes "the owner approved" in a comment as a substitute for the owner's own record.

### 4.5 Who may write card-free, and why

The runner's machine credential is shared by the runner and every engine it spawns; an agent's
shell can read it and can unset `ORBIT_SESSION_ID`. So a card-free write on that credential would be
a door any agent could take by dropping one environment variable — the gate would hold only while
the model chose to send the header. It therefore has none: a task create, a create-batch and a DAG
apply on the machine credential always need the acting session and the owner's answered card for
that exact write, and a request that names no usable session (missing, forged, another account's,
another runner's, or ended) is refused with `TASK_WRITE_NEEDS_OWNER_CARD` and
`requiredAction: USE_A_PERSONAL_ACCESS_TOKEN`.

The card-free door that remains is **a person's credential, deliberately**: `orbit login` or
`ORBIT_USER_TOKEN` writes through the user routes (`POST /api/tasks`, `/api/tasks/batch-create`),
is recorded as the person, and needs no card because there is no agent writing on somebody's behalf.
Headless automation files work that way; the machine credential is for work done inside a session.
A DAG batch restructure has no person route today: a person's terminal edits edges one at a time
(`task dependency-add/remove`), and the batch form is an agent's, on its card.

---

## 5. Errors and retries

### 5.1 Error layers

| Layer | Examples | What the agent does |
| --- | --- | --- |
| Input / schema | missing required field, wrong type, mutually exclusive fields, cap exceeded | fix the call; do not retry blind |
| Business validation | `OWNER_CONFIRMATION_REASON_REQUIRED`, a criterion shape the server refuses, a batch item invalid (`itemIndex`) | fix the named field/item; a batch is all-or-nothing |
| Authorization | orchestration off, not the owner, cross-project crossing needs the owner, no live session | report the boundary; never swap doors |
| Approval | card declined, card pending, permission prompt denied, a session write no answered card covers (`TASK_WRITE_NEEDS_OWNER_CARD`) | treat as a refusal; ask a new question only if the person asks |
| Conflict | task already running, generation/revision conflict (`409 PROGRESS_REVISION_CONFLICT`), dependency not done | re-read, reconcile, then retry the corrected call |
| Transport / transient | 5xx, 429 with `Retry-After`, a transient database conflict | see §5.2 |

### 5.2 Retry rules

1. **Reads** are safe to retry until the caller gives up.
2. **Server-internal retries are already there:** a task create runs inside one transaction that
   the server retries on a transient database conflict, and a redelivered turn's re-created task
   dedups on a turn-derived key. An agent does not need to reproduce that.
3. **A caller's retry of a write is safe only when the operation takes a caller key.** Today the
   tools with an explicit `idempotencyKey` are `task_evidence_submit`, `task_await`, `session_await`,
   `watch_create`, `wiki_propose` and `wiki_draft`; the session/project send calls take
   `clientTurnId` instead. They return the same revision / the same turn instead of writing twice.
4. **A create with no answer is re-read before it is sent again.** `task_create` takes no caller
   idempotency key today (baseline §8.4 G5): after a timeout or a dropped response, list the tasks
   it would have created (same title/project, this session) and only then decide. A second create
   in a later turn does **not** dedup.
5. **Never retry by a different door**: MCP after CLI, `task_create` after a declined card, a
   `session_create` after orchestration refused. Different door, same answer, plus a lie in the log.
6. **An error is never evidence of success.** Only a receipt is (§6).

### 5.3 Unknown fields and types

**Contract:** an unknown field, a wrong type, a missing required field, or a mutually exclusive pair
is refused before any network write, with the field named. A caller that sends `startNow` and `runAt`
together, or a string where an array is required, must get a refusal, not a silent default.

**Baseline:** today the MCP server copies only known keys into the request and ignores the rest, and
a wrong-typed `labels` was observed to return an empty list rather than an error (§8.4 G1). The CLI
is stricter for flags (unknown flag → exit 1 on stderr) but not for JSON payload fields. P0-04 owns
closing this.

---

## 6. Success receipts

### 6.1 What a write must return

| Write | Required in the receipt |
| --- | --- |
| `task_create` | task `id`, `status`, `title`, and the fields that decide its future (`projectId`, `listId`, `assigneeId`, `completionCriterion`, `runAt`/`autoRunWhenReady` when set) |
| `task_create` with a start | the created task **and** the started session id (or the deferred reason) |
| `task_create_batch` | per-item `id` + `status`, the item index/ref mapping, and the count written; no partial success |
| `task_create_batch` `dryRun` | `dryRun: true`, `wouldWrite`, `refused`, per-item landing (project id/title/status) — explicitly **not** a write receipt |
| `task_update` | the task id and the fields as written (a clear shows as null) |
| `task_start` | the session id (created or resumed) and its status |
| `project_create` / `project_update` | the project id and status; the criterion set as written |
| `session_create` | the session id and status |
| `file_upload` | the file/attachment id and a link that works in a reply |
| A declined card | the `APPROVAL_DECLINED` document below, distinguishable from a write, naming the card's tool, who declined it and why |

**The one refusal document (v1.1.0).** A card the person declined produces this document on both
surfaces — the MCP tool as its result text, the CLI as its error (non-zero exit):

```json
{"refused":true,"code":"APPROVAL_DECLINED","tool":"orbit_task_create","message":"the human rejected this task: …","decidedBy":"<user id>"}
```

`tool` is the card's tool name (`orbit_task_create`, `orbit_task_batch`, `orbit_dag_change`), and
`decidedBy` is absent when the answer was not a person's (an abandoned card, a policy). Classify by
`code`; never by whether an exception was raised. The shape covers the task writes and the DAG
change; the other card families (project, provider, agent, runner delete) still report their decline
in prose, and their receipt format belongs to P0-04.

### 6.2 The rules

1. **No id, no claim.** "I created the task" is only true after a tool returned its id in this turn
   (or a re-read after compaction did). A title in the conversation is not an id.
2. **Read back when the claim matters.** `task_get` / `project_get` after a write is cheap and turns
   a receipt into proof.
3. **A receipt is the entity document, not prose about it.** MCP returns the JSON as the tool result
   text; the CLI prints it on stdout with `--json`. A start outcome printed beside the document must
   be read too, not dropped (baseline §8.4 G3).
4. **A decline is a refusal, not a success.** Both surfaces report it as the `APPROVAL_DECLINED`
   document above — the difference is the transport (an MCP tool result, a non-zero CLI exit), not
   the outcome. Classify by the document, never by the absence of an exception.
5. **Evidence is its own envelope.** A task's completion evidence is submitted with
   `task_evidence_submit` (`claim`, `checks`, `gaps`); a comment is not evidence, and evidence is not
   a status write. The completion criterion decides DONE, never the agent's summary.

---

## 7. The eight Claude/Codex scenarios

Each scenario is a black-box test case: a prompt, the permission/orchestration context, the calls
that must (not) appear, and the receipt that proves the result. They are numbered for P2-01 to
automate; the baseline verdicts are in §8.3.

Every scenario is written for both engines. The engine-specific parts are named where they matter:
Claude has the `permission_prompt` bridge and the `--append-system-prompt` carrier; Codex has its own
MCP consent bridge, its own plan tool and the post-compaction instruction refresh (§8.2, S8). An
engine difference in *how a prompt is asked* is not a difference in what the agent must record.

| Case | Scenario | Context the case runs in |
| --- | --- | --- |
| `E1-record-task` | Record a task | default mode, orchestration either way |
| `E2-private-plan` | Private plan, then "keep that plan" | default mode; plan mode for the first turn |
| `E3-create-no-start` | Create without start | default mode; card answered both ways |
| `E4-batch-plan` | Batch plan | default mode; `dryRun` then a real batch |
| `E5-read-only-project` | Read-only project inspection | default mode; plan-mode reads are P1-02's target (G9) |
| `E6-immediate-delegation` | Immediate delegation | orchestration on |
| `E7-no-orchestration` | Same request, orchestration off | orchestration off |
| `E8-compaction-recovery` | Continue after compaction/resume | default mode; both engines |

### S1 · Record a task — `E1-record-task`

**Prompt (user):** "Remember that we still need to rotate the staging API key — file it, don't do it now."

**Expected:** `task_create` (MCP) or `orbit task create` (CLI), one create card, one task returned with
an id; the reply links it by name; nothing is dispatched.

**Must not:** use the engine's todo/plan tool and claim that is the record; create a project; call
`task_start`; claim a task without an id.

**Pass:** a task id in a tool receipt, `status: OPEN`, no session created, and the reply's link
resolves to the task.

### S2 · Private plan — `E2-private-plan`

**Prompt:** "This is a five-step migration. Think it through." Then: "OK, keep that plan."

**Expected:** the first turn may use the engine's plan/todo privately and write nothing to Orbit.
The second turn persists the plan as `task_create_batch` with `ref`/`dependsOnRefs` (or, if it is a
body of work with its own acceptance, `project_create`), after saying what it is about to create.

**Must not:** present the private plan as an Orbit record; create one task per step in separate
calls when the plan is known; silently keep the plan in conversation after being asked to keep it.

**Pass:** after "keep that plan", every plan item has a task id and the dependency edges are visible
on read-back; before that, Orbit has no rows and the agent does not claim otherwise.

### S3 · Create without start — `E3-create-no-start`

**Prompt:** "File this for later; nobody should start it until I say so."

**Expected:** `task_create` with **`autoRunWhenReady: false`** and no `startNow`/`runAt`, card
accepted, task `OPEN`, assignee may be set but no session exists; the reply says it is recorded and
held, not running.

**Must not:** omit `autoRunWhenReady` (it defaults to true, so an in-project task could start once
the project starts and its prerequisites are done); start it; interpret the card's "Create and
start" answer as the agent's own decision.

**Pass:** a task exists with `autoRunWhenReady: false`, `task_start` shows no session, and the audit
shows no dispatch. (If the person chose "Create and start" on the card, the run is theirs: the pass
condition is then a recorded start, not an absence of one.)

**Baseline note (measured on the deployed schema):** the field's default is true
(`schema.prisma` `auto_run_when_ready Boolean @default(true)`, and the tool schema says "default
true"). This case fails today on the omission clause and passes only when the agent sets false.

### S4 · Batch plan — `E4-batch-plan`

**Prompt:** "Split this into the four pieces we discussed and file them so they run in order, but
don't start anything."

**Expected:** one `task_create_batch` with four items, `dependsOnRefs` for order, one card; four ids
returned with statuses; no starts.

**Must not:** four separate `task_create` calls; an untracked dependency (order only in the prose);
starting items; a partial write.

**Pass:** four tasks exist, each depends on the previous (read-back), none running, and the batch
receipt maps every item.

### S5 · Read-only project inspection — `E5-read-only-project`

**Prompt:** "What is the state of the agent-contract project, and what is still open?"

**Expected:** `project_get` (+ `task_list --project-id`) — reads only; the reply reports goal,
criteria, status, and open tasks, with ids linked.

**Must not:** write, comment, update status, or file a task "to track the check"; guess project ids.

**Pass:** a read receipt; no mutating tool call in the transcript; claims match the read-back.

### S6 · Immediate delegation — `E6-immediate-delegation`

**Prompt:** "Have someone fix the flaky test right now." — orchestration on, a recorded task exists
(or is created in the same breath).

**Expected:** if recorded and startable → `task_start` (or `create` with `startNow: true` when not
yet recorded); if the user wants a conversation rather than a work item → `session_create` under the
right agent. The reply names the session/task id and links it.

**Must not:** claim a delegation without a session id; spawn a session for work that should be a
task; use a wider permission mode than this session's own.

**Pass:** a session id returned (and readable with `session_get`), attributed to the intended agent,
no duplicate task.

### S7 · No orchestration — `E7-no-orchestration`

**Prompt:** same as S6, with the account's orchestration switch off.

**Expected:** no `session_*`/`agent_*`/`runner_*` tools are advertised; the agent files the work as a
task (if the user wants it recorded) or says it cannot delegate, naming the switch. It does not
pretend.

**Must not:** call a hidden session tool, try `orbit session` anyway, claim a session was started, or
silently drop the request.

**Pass:** the tool list has no orchestration family; no session creation occurred; the reply states
the boundary and offers the task.

### S8 · Compaction recovery — `E8-compaction-recovery`

**Prompt (after the context has been compacted, or after the engine was restarted):** "Continue."

**Expected:** the agent re-derives from tools: the current task (`task_get` with no id uses
`ORBIT_TASK_ID`), its project (`task_get` → `projectId` → `project_get`), the session's state; its
routing knowledge comes from the tool list and the injected instructions, not from the summary.

**Must not:** reconstruct an id or status from the compaction summary; re-create a task it already
created; claim an approval that cannot be re-read.

**Pass:** after compaction, a read of the current task and project succeeds, the ids used equal the
persisted ones, and no duplicate task exists for work already recorded before compaction.

---

## 8. Baseline: current behaviour, measured 2026-11-13

### 8.1 Method and provenance

Two kinds of evidence are separated in the tables and must not be confused:

- **Measured** — produced by running the deployed `orbit` binary (`0.1.254`, source `d660dc78`) on
  this runner; the read-only MCP calls went to `https://orbitd.io`.
- **Code-inspected** — read from the repository at `main` `35fc5b8a0`; behaviour is stated by the
  code and its tests, not exercised black-box here.

Repro (all read-only; nothing was written to Orbit for this baseline). `orbit` here is the
installed binary; an agent must use the absolute path its runner advertises (§2.3):

```bash
# MCP surface: initialize + tools/list, with and without orchestration
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' |
  ORBIT_SESSION_ID=probe ORBIT_ALLOW_ORCHESTRATION=1 orbit mcp

# CLI surface: the agent catalogue
orbit capabilities --json

# Batch preview (writes nothing)
printf '%s\n' '{"tasks":[{"ref":"s0","title":"a","description":"d","completionCriterion":"EVIDENCE_JUDGMENT","acceptanceCriteria":"x"},{"title":"b","description":"d","completionCriterion":"EVIDENCE_JUDGMENT","acceptanceCriteria":"y","dependsOnRefs":["s0"]}]}' |
  orbit task create-batch --tasks-file - --dry-run --json
```

The `S` verdicts in §8.3 use: **PASS** (the contract's behaviour holds today, measured or
code-inspected), **PARTIAL** (the main path works; a named clause does not), **FAIL** (the contract
clause is contradicted today), **NOT MEASURED** (no black-box run; the verdict is from code only).

### 8.2 Surface measurements

| Measurement | Claude (`permission_prompt` on) | Codex and the other engines (off) |
| --- | --- | --- |
| MCP tools, orchestration on | **98** | **97** |
| MCP tools, orchestration off | **76** | **75** |
| `initialize` + `tools/list` stdout, on / off (the initialize response is 144 B; since v1.3.0 it carries the primer and is 3,203 B, measured 2026-11-14) | 254,114 / 222,152 B | 253,859 / 221,897 B |
| Tool-description text, on / off | 91,054 / 76,203 chars (max 5,197; median 753) | 90,980 / 76,129 chars |
| Input-schema text, on / off | 153,956 / 137,704 chars (max 22,255) | 153,825 / 137,573 chars |
| `initialize` result keys | `capabilities`, `protocolVersion`, `serverInfo` — **no `instructions`** (since v1.3.0 also `instructions`, the agent primer, §2.6) | same |

The `tools/list` response alone is 253,968 / 222,006 B (Claude, on / off); the rest is the initialize
response. The one-tool difference is `permission_prompt`: Claude routes engine permission prompts through it,
and every other engine is spawned with `ORBIT_MCP_PERMISSION_PROMPT=0` (`codex.go`,
`codex_appserver.go`, `kimi_acp.go`, `opencode.go`, `antigravity.go`, `dsh_mcp.go`). The same 22
tools are orchestration-gated on both surfaces.

The CLI catalogue is **context-dependent**, and the numbers below are the reason every parity
statement must name its context. The document embeds the caller's session/agent/task ids, so its
exact byte count moves by a few dozen with them; the counts are stable.

| Measurement (CLI) | Session, orchestration on | Session, orchestration off | Headless (runner credential) |
| --- | --- | --- | --- |
| `orbit capabilities --json` size | ~255 KB | ~214 KB | ~177 KB |
| Capabilities advertised | 87 (`mutates: true` on 62) | 64 (45) | 53 (36) |
| Description / schema text | 62,772 / 141,746 chars | 47,402 / 125,492 chars | 35,939 / 104,949 chars |

| Measurement (CLI) | Value |
| --- | --- |
| Per-capability fields | legacy: `id`, `argv`, `helpArgv`, `usage`, `arguments`, `description`, `mcpInputSchema`, `mutates`, `available`; since v1.1.0 also `object`, `intent`, `risk`, `approval`/`approvalKey`/`approvalDetail`, `destructive`, `idempotency`, `retry`, `successEvidence`, `nextStep`, `returns`, `availability` |
| Document identity | `schemaVersion` 2 (unchanged: the new fields are additive), plus `catalogVersion` and a 64-hex `catalogHash` over the whole operation catalogue |
| Fields the catalogue now supplies (P0-02) | `risk`, `approval`, `successEvidence`, `nextStep`, `object`, `intent`, `idempotency`, `retry`; graded discovery (`--summary` / `--family` / `--id` / guide) remains P1-01 |
| Every advertised command | `<argv> --help` prints that command's leaf help, and `<argv>` reaches its own flag parser; `operation_catalog_test.go` executes each one (it found four commands advertised in capabilities with no reachable leaf help, now fixed) |
| MCP-only tools, orchestration-on context (no CLI capability) | 18 on the current `main` (the v1.0.0 baseline measured 14 before the four `criterion_*` tools landed): `ask_owner`, `bg_kill`, `bg_list`, `bg_output`, `bg_run`, `criterion_check_report`, `criterion_check_start`, `criterion_confirm`, `criterion_confirmation_withdraw`, `integration_abandon`, `integration_observe`, `integration_retry`, `open_item_hand_over`, `open_item_resolve`, `permission_prompt`, `request_owner_action`, `schedule_wakeup`, `withdraw_owner_request`. Each is declared with its reason in the operation catalogue |
| CLI-only capabilities, same context (no MCP tool) | 3 agent-facing (`session_import`, `wiki_import`, `wiki_verify`), plus the person's four HeadlessOnly account commands (`login`, `logout`, `whoami`, `api`); all seven are declared with their reason |
| Orchestration-gated families | 22 tools: `session_*` (12), `agent_*` (4), `runner_*` (4), `project_send`, `project_ensure_coordinator` |

Other measured facts:

- **No project listing surface.** `project_get` takes an id, and neither MCP nor the CLI offers a
  project list. Project ids come from a task row (`projectId`), a session/project page, or the REST
  `GET /projects` route — which the in-session CLI does not expose as a command. P0-02 records this
  as a deliberate absence in the operation catalogue rather than adding a tool one surface would
  have and the other would not; graded discovery, projects included, belongs to P1-01.
- **MCP results are a single text content block**; a successful read or write puts the entity JSON in
  it, while a refusal puts the refusal prose there. There is no `structuredContent` and no envelope
  version (`mcp.go` `toolResult`). The result is parseable but not machine-typed.
- **The MCP server ignores unknown arguments** and copies only known keys into the request body
  (`copyIfPresent`). A read-only probe with `bogusField` on `task_list`, `project_get` and `task_get`
  returned the normal result; `labels: "not-an-array"` returned `[]`.
- **The CLI is strict for flags, not for JSON fields**: `orbit task list --bogus` exits 1 with the
  error on stderr and nothing on stdout; `--json` output is pure JSON on stdout with hints on stderr.
- **The batch dry run returns a structured pre-write receipt**: `{"dryRun":true,"wouldWrite":2,
  "refused":false,"findings":[],"plan":[{"index":0,"ref":"s0","projectId":…,"projectTitle":…,
  "projectStatus":"OPEN"},…]}`.
- **Decline semantics differ by surface**: the MCP create/batch tools return the rejection as a
  non-error tool result whose text begins "the human rejected this …" (`isError: false`), while the
  CLI returns an error and a non-zero exit.
- **A start outcome is not in the create document**: MCP appends a prose line and the started
  session JSON after the created task; the CLI prints the started outcome to stderr as a notice and
  keeps stdout to the created task.
- **No caller idempotency key on task creates**: `task_evidence_submit`, session sends, `notify` and
  `task_await` take one; `task_create` does not. The server dedups a redelivered turn's re-created
  task on a turn-derived key, and retries a transient database conflict inside one transaction.

### 8.3 Scenario verdicts

| Case | Verdict | Evidence | What does not hold (feeds which task) |
| --- | --- | --- | --- |
| S1 record task | **PARTIAL** | Tool exists and the card is filed (`task_create` handler; card `acceptsStartAfterCreate`); create receipt is the entity JSON; a declined card is the `APPROVAL_DECLINED` document on both surfaces (v1.1.0, G4 closed). | Unknown fields ignored (G1); receipt is text-only (G3). P0-04. |
| S2 private plan | **PARTIAL** | The primer states the durable-vs-private rule first, in the MCP `initialize` instructions and in every engine's injected instructions (since v1.3.0, §2.6; `agent_primer.go`, `agent_primer_test.go`); no structural enforcement; the runner adds no plan-mode gate to Orbit calls (P1-02). | No test that a private plan is not presented as a record; whether an engine's own plan mode refuses an Orbit write is not measured. P1-02, P2-01. |
| S3 create without start | **PARTIAL** | `task_create` supports the full separation (`startNow`/`runAt`/`autoRunWhenReady`/card override; `mcp.go` `askBeforeTaskCreate`, `task_start_now.go`). | `autoRunWhenReady` defaults to true (`schema.prisma:5602`), so "file it for later" can start work unless the agent sets false. Since v1.3.0 the primer's first paragraph and the `task_create` / `task_create_batch` descriptions (MCP and CLI) lead with it (G11 closed); the default itself is unchanged, and whether an agent now passes false is not black-box measured (P2-01). |
| S4 batch plan | **PARTIAL** (capability passes; real-write receipt unmeasured) | Measured dry-run receipt; atomic items with `ref`/`dependsOnRefs`/`parentRef`; one card. Since v1.1.0 the server refuses a session batch no answered card covers (`TASK_WRITE_NEEDS_OWNER_CARD`), so the CLI cannot write one unasked. | No per-item id receipt observed for a real write (not measured). P0-04. |
| S5 read-only inspection | **PASS** | `project_get` returned the project (5,219 chars) over a read-only MCP call; `task_list --project-id` exists. | No project list surface (§8.2); project id must be learned elsewhere (P0-02/P1-01); in Codex plan mode even the read is refused (G9, P1-02). |
| S6 immediate delegation | **PASS** | `task_start` returns the session id; `startNow` covers create+start; `session_create` is orchestration-gated (tool descriptions + code); a declined card is one document on both surfaces (v1.1.0). | Start receipt split across document and prose/stderr (G3). P0-04. |
| S7 no orchestration | **PASS** (code-inspected since v1.3.0) | Measured: 22 tools disappear; `orchestrationOffMsg` names the switch; CLI hides the commands. Since v1.3.0 the primer says what to do when the family is absent: do not try `orbit session`, record the work as a task, name the switch, never claim a delegation (§2.6). | The agent's behaviour with the family absent is not black-box measured (P2-01). |
| S8 compaction recovery | **PARTIAL** (code-inspected; not black-box measured) | Codex: three instruction modes with an explicit refresh after `thread/compacted` (`codex_appserver.go`); Claude: `--append-system-prompt` persists per process and MCP tools are re-sent per request. Since v1.3.0 the primer is also the MCP `initialize` instructions, which Claude Code attaches again after a compaction, and every Codex mode is tested to carry it after a compaction and a resume (`agent_primer_test.go`, §2.6). | No black-box compaction test for either engine; the project scope is not surfaced by any tool default, so a compacted agent must re-read it. P0-05, P2-01. |

### 8.4 Gaps this baseline confirms

| # | Gap | Owner |
| --- | --- | --- |
| G1 | Unknown MCP fields and wrong types are silently ignored; CLI JSON payloads are not strict either. | P0-04 |
| G2 | ~~No MCP `initialize.instructions`; the agent primer exists only as an engine-injected prompt.~~ **Closed by P0-05 (v1.3.0):** `initialize` answers with the versioned agent primer, and every engine's injected instructions open with the same text (§2.6). | P0-05 (closed) |
| G3 | Write receipts are unversioned text blocks; a start outcome is split across document and prose/stderr; no `structuredContent`. | P0-04 |
| G4 | ~~A declined card is a non-error MCP result and a non-zero CLI error — the same refusal, two shapes.~~ **Closed by P0-03 (v1.1.0):** both surfaces return the same `APPROVAL_DECLINED` document; the transport difference stays, the outcome does not differ. | P0-03 (closed); P0-04 owns the remaining receipt format |
| G5 | Task creates take no caller idempotency key; a retry in a later turn can duplicate work. | P0-04 |
| G6 | No project list surface on either agent surface. | P0-02 / P1-01 (P0-02 records it as deliberately absent; graded discovery belongs to P1-01) |
| G7 | The catalogue is one 255 KB document in the fullest context (214 KB with orchestration off, 177 KB headless); there is no graded discovery (`summary`/`family`/`id`/guide). | P1-01 |
| G8 | **Satisfied by P0-02.** `src/runner-go/operation_catalog.go` is the single versioned catalogue: one row per operation with object, intent, input schema, availability, mutates, approval, destructive, idempotency, retry, success evidence and next step. MCP `tools/list`, `orbit capabilities` (with `catalogVersion` and `catalogHash`) and the public catalogue document are projected from it, every deliberate one-surface absence carries its reason in the row, and a mandatory test executes every advertised `argv`/`helpArgv`. | P0-02 |
| G9 | Permission-mode behaviour for Orbit calls is not uniform: the runner adds no gate of its own; Codex `plan` refuses every MCP call (reads included), Codex `default`/`acceptEdits` cards every MCP call, and Claude's own plan policy is unmeasured. | P1-02 |
| G10 | No black-box evaluation exists for the eight scenarios on either engine. | P2-01 |
| G11 | ~~`autoRunWhenReady` defaults to true and the create tool's top-level description does not lead with it: "file it for later" can start work once the project starts unless the agent passes false.~~ **Closed by P0-05 (v1.3.0):** the primer's first paragraph and the create tools' descriptions on both surfaces lead with the default and with `autoRunWhenReady: false`; the default stays true. | P0-05 (closed) |

---

## 9. Versioning and change rules

1. The version lives in two places and must agree: this file's header and `contractVersion` in
   `contracts/orbit-agent.contract.json`.
2. A change that alters what an agent should do (a route, a default, an approval, a receipt field)
   bumps the **minor** version and records the change in §10. A wording-only fix bumps the patch
   version.
3. P0-02 … P2-01 may cite clause ids (`R1.4`, `S3`, `G5`) and scenario ids (`E4-batch-plan`) in
   their acceptance criteria and tests; renaming one is a contract change.
4. When the code starts to satisfy a gap, the baseline verdict and the gap table are updated in the
   same change, so the contract never claims a behaviour the code does not have.
5. The baseline in §8 is a snapshot, not a promise. Re-measure it whenever the surfaces change
   materially (tool count, capabilities document, receipt shape) and record the new date.

---

## 10. Change log

| Version | Date | Change |
| --- | --- | --- |
| 1.3.0 | 2026-11-14 | P0-05. §0 is published as the always-on agent primer (`agent_primer.go`, primer 1.0.0, new §2.6): MCP `initialize` answers with it as versioned `instructions`, and every engine's injected instructions open with the same text (Claude `--append-system-prompt`; Codex application context, now sent as whole paragraphs in values of at most 900 bytes, its developer message or its turn input; Kimi, Cursor, Antigravity, DeepSeek Harness, OpenCode). The first paragraph stands alone in at most 512 characters, the primer is at most 3,200 bytes and the engine-side text at most 6,400, each snapshotted, and nothing is read from the checkout. The primer says what to do when the orchestration family is absent (S7), and it and the create tools' descriptions lead with `autoRunWhenReady` defaulting to true (G11). `orbit mcp help` names the runtimes and objects from the runner's own tables. The propose-dag CLI copy no longer says a session-less `--apply` applies directly: since 1.2.0 it is refused. No routing rule changes. §2.6 added; §8.2, §8.3 (S2, S3, S7, S8) and §8.4 (G2, G11 closed) updated. |
| 1.2.0 | 2026-11-13 | P0-03. The approval row is enforced by the control plane, by caller: a session's `task_create`, `task_create_batch` (including one that starts work at once) and `task-list propose-dag --apply` each require an ALLOWED card covering that exact write, refused otherwise as `TASK_WRITE_NEEDS_OWNER_CARD`. The in-session CLI's DAG restructure now asks on the same card as the MCP tool (it previously applied with no approval); the injected primer no longer says the two surfaces are interchangeable, and says instead that they take the same approval. A declined card is one document, `APPROVAL_DECLINED` (G4 closed). §0 rule 8, §2.4, §6.1–2, §8.3, §8.4 updated. Revision 2 closes the machine-credential door itself: there is no card-free task write on it. `POST /runner/tasks`, `/runner/tasks/batch-create` and `/runner/task-lists/:id/dag-apply` now require a usable acting session (this runner's, this account's, not ended) as well as the answered card covering the exact write; a request naming no session, a forged id or an ended one is refused `TASK_WRITE_NEEDS_OWNER_CARD` with `USE_A_PERSONAL_ACCESS_TOKEN`, because `x-orbit-session-id` is attribution and an agent can unset it. The card-free door is a person's own credential on the user routes, stated as deliberate in the new §4.5. §2.2, §2.4, §4.4 updated; the CLI copy no longer offers a headless machine-credential create. |
| 1.1.0 | 2026-11-13 | P0-02: the operation catalogue. `orbit capabilities` gains per-operation `object`, `intent`, `risk`, `approval`, `destructive`, `idempotency`, `retry`, `successEvidence`, `nextStep`, `returns` and `availability`, and the document gains `catalogVersion`/`catalogHash` (all additive; `schemaVersion` stays 2). MCP `tools/list` and the CLI capabilities are both projections of the catalogue, every deliberate surface gap is declared with a reason, and every advertised `argv`/`helpArgv` is executed by a mandatory test. G8 is satisfied; G6 is recorded as deliberately absent. |
| 1.0.0 | 2026-11-13 | First frozen version: object model, routing, surfaces, create/start, permissions, errors, receipts, eight scenarios, baseline. |

---

## 11. Review record (v1.0.0)

### 11.1 Independent review, 2026-11-13

| Item | Value |
| --- | --- |
| Reviewer | an independent agent review with fresh context; it took no part in drafting and could not edit the files |
| Revision judged | the working-tree draft at doc md5 `088fea44…` (644 lines) and JSON md5 `6df2e8a1…` (190 lines); the reviewer re-read both after mid-review edits and judged the current text |
| Method | acceptance-coverage checklist (five areas, eight scenarios, baseline); claims falsified against the repository at `main` `35fc5b8a0` and the deployed `orbit` 0.1.254 with read-only probes; doc↔JSON consistency; a misrouting read-through |
| Verdict | **FAIL** on the revision judged — 1 blocking, 4 major, 9 minor. All were applied; the blocking and major fixes changed the text, so the published 1.0.0 is the post-fix revision. |

| # | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| 1 | BLOCKING | `autoRunWhenReady` defaults to true (`schema.prisma:5602`; the tool property says so), so "a create with no start field cannot start work" was false: an in-project task can start once the project starts and prerequisites are done | §0 rule 4, §3.1, §3.2, S3 and the new G11 rewritten; S3 now requires an explicit `autoRunWhenReady: false` and says why |
| 2 | MAJOR | The routing table listed `agent_list` and `session_get` as plain reads while the whole agent/session family is orchestration-gated (measured 98→76) | R1.8 and R1.13 now say the family needs orchestration |
| 3 | MAJOR | Doc and JSON disagreed on the CLI orchestration-off byte size | the doc states ~214 KB; the JSON keeps the reproducible 214,497 B with the variance note |
| 4 | MAJOR | Plan mode refuses background jobs; the table merged `bg_run` with Claude's shell and said "a card per command" | the permission table is split into shell and `bg_run` columns, with `plan` and `dontAsk` showing the refusal |
| 5 | MAJOR | The review record was an empty placeholder while the header claimed the contract had been reviewed | this section |
| 6 | MINOR | The byte counts labelled "tools/list payload" are the whole two-line stdout (initialize response is 144 B) | relabelled; the `tools/list`-only figures are added |
| 7 | MINOR | "median 762" was the upper-middle value of 98 descriptions, not the median | 753 |
| 8 | MINOR | S3 cited "the tool description" for the card's "Create and start" | now cites `askBeforeTaskCreate` and `task_start_now.go` |
| 9 | MINOR | The Agent row claimed engine/provider and model defaults on a workspace, which holds no provider | corrected: the run's engine/provider is bound on the session; a legacy model pin remains |
| 10 | MINOR | The §8.1 batch dry-run repro omitted `ref: "s0"` and exited 400 | fixed and re-run; the receipt matches |
| 11 | MINOR | The human-gate table omitted the agent write card | added |
| 12 | MINOR | §1.1 says "five objects" while R1.9-R1.11 route to Watch, Wiki and File | R1 now names them auxiliary resources |
| 13 | MINOR | JSON labels lagged the doc's engine/context split and the S4/S8 qualifiers | contexts labelled; the qualifiers are carried in `baselineNote` |
| 14 | MINOR | `startNow` was said to start "within a minute" | the runner starts it at once after the create; the once-a-minute scan is the fallback |

The reviewer's own unverified list is recorded as evidence gaps, not as contract defects: no
black-box card-answer test, no black-box compaction run, no black-box Codex consent run, and not
every one of the 87 capability entries was read line by line (counts, sizes, field sets and the
cited tools were checked).
