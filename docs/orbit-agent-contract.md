# Orbit Agent Contract v1

> **Status:** frozen at v1.15.0, 2026-11-25 (v1.0.0 review record in §11; the 1.1.0 to 1.15.0 changes
> are in §10). v1.1.0 adds the operation catalogue and changes no routing rule; v1.2.0 closes the
> card-free task-write door on the runner's machine credential; v1.3.0 makes tool input strict and every
> write's answer a structured receipt (§5.3, §6.3); v1.4.0 gives the owner's "Chat about this" on a card
> its own receipt outcome, `chat`, which is not a refusal (§6.2); v1.5.0 publishes §0 as the always-on
> agent primer (§2.6) and changes no rule; v1.6.0 makes the permission modes mean the same for Orbit's
> calls on Claude and Codex: Plan runs Orbit's reads and refuses its writes with a receipt (§4.1, §6.3);
> v1.7.0 adds graded discovery and the `guide` tool (§2.5), so calling one operation no longer means reading
> the whole catalogue; v1.8.0 gives the person their side of the contract (§2.7): the Agent Tools guide,
> generated from the catalogue, the managed playbooks skill, and each session's report of what its engine
> took, and says "runtime instructions" where "system prompt" was not true on every engine; v1.9.0 measures the
> agent instead of the text (§12): the eight scenarios and the cases they leave out are a black-box eval on the
> real engines with real models and a deterministic layer in CI, every turn that touches Orbit files counts-only
> telemetry, and a release that changes what agents read passes a documented gate with rollback conditions;
> v1.10.0 merges main's own catalogue and contract edits (capability availability, the schedule tools, `delegate`,
> `provider_list --workspace`, the receipt's recovery report) with the project line's, and changes no rule;
> v1.11.0 adds the fifth timer, a **condition**, for "when something outside Orbit becomes true" (§3.3):
> `task_create`'s `startWhen`, `schedule_create`'s `WHEN` rule, each refused without the baseline the agent read,
> and the read `condition_get`. This file is the authority for how an
> in-session Claude or Codex agent uses Orbit: which object an intent belongs to, whether it travels
> over MCP or the CLI, what a person must approve, how failures and retries are handled, and what
> counts as a success receipt. The implementation tasks P0-02 … P2-01 work from this file. If the code
> conflicts with it, change this file first and say why.
>
> **Machine-readable index:** [`contracts/orbit-agent.contract.json`](../contracts/orbit-agent.contract.json)
> carries the same version, the route table, the scenario ids and the baseline verdicts.
> **Baseline recorded:** 2026-11-13, `orbit` 0.1.254 (source `d660dc78`), repository `main` at
> `35fc5b8a0`, server `https://orbitd.io`. Measurements and repro commands are in §8; the black-box verdicts were
> measured 2026-11-16 on commit `1d882a28be` (§8.3, §12).
> **Not the same document as** [`project-agent-contract.md`](./project-agent-contract.md): that one
> freezes the Project/Task/Agent/Workspace domain for the V1 execution routing (and has no live
> control loop). This one is the agent-facing usage contract: what an agent should call, when, and
> what it may claim afterwards.

---

## 0. One page: the rules an agent must be able to quote

1. **Orbit is the user's durable record; the engine's plan is private scratch.** A built-in todo or
   plan tool is for the agent's own steps, and so is a sub-agent the engine runs itself (Claude Code's Agent
   tool): work the person hands to another agent goes to Orbit (since v1.9.0). Anything the user asked to record, or follow-up work they
   should see, goes to Orbit. Never present a private plan as an Orbit task, and never claim a task
   exists without an id Orbit returned.
2. **Pick the object by the question it answers.** Project = the whole goal and its acceptance;
   Task = one durable work item; Task list = dispatch policy; Session = one immediate execution;
   Agent = where it runs and under which identity. When two objects both seem to fit, the smaller
   one wins by default, and one task beats a project.
3. **MCP first, CLI for what MCP cannot do.** Use the `mcp__orbit__*` tools when the tool list has
   them. Reach for the CLI for pipes, scripts, bulk stdin, and the few operations with no MCP tool —
   never to get around a card, a refusal, or a missing authorization.
4. **Create is not start — and an agent says whether it may start later.** `task_create` does not run
   anything in the call. It records work. Start is a trigger: `task_start`, `startNow: true`, `runAt`,
   the person's own "Create and start" on the card — **and `autoRunWhenReady`, which an agent must pass
   on every create** (the runner refuses a `task_create`, or a `task_create_batch` item, without it).
   `true` makes an in-project task with an assignee start by itself once the project has started and
   its prerequisites are `DONE`; `false` keeps it recorded. When the user says nobody should start it,
   pass `autoRunWhenReady: false`. Since primer 1.8.0 the tools say this, not the primer.
5. **A person answers the consequential writes.** A create, a batch, a project, a provider change and
   every owner-only decision are cards. The card is the approval; there is no second door. A declined
   card is a refusal, never a success. A card the owner answers with "Chat about this" is neither: it
   is their message to answer, and the proposal stays open.
6. **Success is a receipt with an id.** A write is done when the call returns the entity's id and
   status. Link it for the user as `orbit-<kind>:<id>`; do not paste bare ids.
7. **Retry only what is safe.** Server-side transient conflicts are retried for you; a caller's retry
   is safe for reads, for operations with a caller idempotency key, and after a re-read proves the
   first attempt did not land. A create answered by nothing is re-read before it is sent twice. Since primer 1.8.0 `orbit mcp` derives an
   idempotency key for a `task_create` or `task_create_batch` that carries none (session id, tool and
   canonical arguments, valid for 10 minutes), so a retry inside that window answers with the first write;
   a key the caller gives always wins.
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
| **Agent** | "Where does it run, and under which identity?" | The execution identity and location an operation is attributed to: name, working directory, runner binding, its instructions (runtime instructions added to every run, and rarely base instructions in place of the engine's own prompt), environment, effort, and a legacy model pin. A workspace holds no engine or provider of its own — the engine/provider a run uses is bound on the session. In the live product this is the `workspace` row that MCP `agent_*`, CLI `orbit agent` and `task_start` all name. | A permission grant; a project role; the human. (The frozen domain contract separates a future pure-identity `agent` table from the workspace location — see `project-agent-contract.md` §3.1; the agent-facing alias is the workspace row until that split ships.) | Created, configured, deleted by the owner's account; sessions run under it. |

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
| Output | Every catalogued MCP tool that writes answers with the receipt (§6.3) as `structuredContent` and as its text; a read keeps the text it always was and carries the receipt beside it when its answer is a JSON document (or it failed). At the CLI `--json` emits the entity document on stdout and nothing else — the receipt's `entity` — and `--receipt` emits the receipt itself; hints go to stderr. |
| Failure | A refusal is a refusal on both surfaces, and a declined card is ONE outcome. Since v1.2.0 it is the document `{"refused":true,"code":"APPROVAL_DECLINED","tool":…,"message":…,"decidedBy":…}`; since v1.3.0 the receipt carries it field for field — `refused` is `!ok` with `outcome: declined`, `code` is `error.code`, `tool` is `approval.card`, `message` is `error.message`, `decidedBy` is `approval.decidedBy`. MCP returns the receipt as the tool result (not marked isError); the CLI returns the document as the command's error (stderr, non-zero exit), and `--receipt` prints the receipt. The transport differs because a tool result is not a process; the outcome does not. The owner's "Chat about this" is not a refusal: since v1.4.0 it is `outcome: chat` on both surfaces, carrying their words (§6.2 rule 4). |

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

Since v1.7.0 an agent finds an operation a piece at a time; it never has to read the whole catalogue
to call one operation.

- **The guide** (`guide` on MCP, `orbit guide [TOPIC] --json` at the CLI; `src/runner-go/agent_guide.go`,
  guide `1.1.0`) is the catalogue arranged by what a person asks for; since 1.1.0 (contract 1.8.0) each topic
  also carries `asks`, things a person says that the topic answers, which the person's guide (§2.7) prints too. It is always listed — orchestration,
  Watch and the wiki off included — read-only (`readOnlyHint`), and asks the server nothing. Without a
  topic it answers the five objects and the question each answers (§1.1), the intent routes R1.1–R1.14
  (§1.3: what the person says, the object, the operations, the topic, and whether the route is
  available here and why not) and the routing rules R2–R5. With a topic it answers that topic's
  shortest recipe: each step is a catalogued operation with its MCP tool and absolute CLI argv, whether
  each surface can take it here and why not, `mutates`, `approval` (with its `approvalKey`), a minimal
  example on both surfaces and `successEvidence`, followed by the rules that span the tools and what
  proves the topic done. Both doors answer the same document (`view: guide` / `guide-topic`, a
  `context` naming the `surface`, the actor, the session, agent and task, and the orchestration, Watch
  and wiki switches). The routes and objects are held to `contracts/orbit-agent.contract.json`.
- **Graded CLI discovery** (`src/runner-go/operation_discovery.go`) answers the capabilities document a
  view at a time, each opening with `view`, `viewVersion` 1, `catalogVersion`, `catalogHash`,
  `cliVersion`, `context` (the full document's: `actor`, `sessionId`, `agentId`, `taskId`) and
  `receiptFlag`:
  - `orbit capabilities --summary --json`: one row per command offered here (`id`, `intent`, and
    `mutates`/`approval` when they are not false/none), grouped by family; the offered commands this
    credential cannot run under `unavailable`, and the catalogued commands not offered at all under
    `withheld`, each group with its reason.
  - `orbit capabilities --family NAME --json`: one family (the command group: `task`, `task-list`,
    `project`, `session`, …), each command with its absolute `argv`, `usage`, `available`, `mutates`,
    `risk`, `approval`, `successEvidence`, `nextStep` and a minimal CLI example; the reasons a command
    cannot run are given once under `unavailable`.
  - `orbit capabilities --id ID --json`: one operation in full — any catalogued one, an MCP-only one
    included (answered as a command it does not have, with why) — adding `description`, the leaf
    `parameters` (each flag's spelling and whether it is required), `mutuallyExclusive`, `idempotency`,
    `retry`, `returns`, `availability`, `helpArgv` and the MCP example. The JSON schema stays with the
    MCP tool and the full document.
- **Examples are generated from the catalogue**: an MCP example is the tool's required fields and a CLI
  example the command's required arguments (`--receipt` for a write, `--json` for a read), each filled
  from the row's declared `Example` or with a placeholder in angle brackets. A test passes every MCP
  example through the tool's own schema and runs every CLI example through the command's own flag
  parser, and a recipe's steps are held to the same.
- **Budget**: one graded answer is at most 16 KiB in any context (under Claude Code's 30,000-character
  shell-output cut, and under Codex's 10,000-token tool-output cut at a pessimistic two bytes a token),
  and the ordinary task-create discovery — the guide's index, its `task-create` topic and
  `capabilities --id task_create` — at most 24 KiB in all, with an executable path longer than any
  runner's (`TestTaskCreateDiscoveryFlowStaysBounded`, `TestEveryGradedAnswerIsBounded`).
- **The full document is unchanged**: `orbit capabilities --json` is still the catalogue (`id`, `argv`,
  `helpArgv`, `usage`, `arguments`, `description`, `mcpInputSchema`, `mutates`, `available`, plus
  `cliVersion`, `sourceSha`, `context`, `identity`), `schemaVersion` 2. Run the returned `argv` with the
  absolute path, never a hand-written guess. Since v1.1.0 every entry also states `object`, `intent`,
  `risk`, `approval` (with `approvalKey` and `approvalDetail`), `destructive`, `idempotency`, `retry`,
  `successEvidence`, `nextStep`, `returns` and `availability`, and the document carries `catalogVersion`
  and `catalogHash` naming the operation catalogue it was projected from
  (`src/runner-go/operation_catalog.go`, rendered for a person as
  [`operation-catalog.md`](./operation-catalog.md)). The same catalogue produces the MCP `tools/list`
  payload and records why an operation is deliberately absent from one surface; a mandatory test
  executes every advertised `argv` and `helpArgv` through the CLI's own router. Since v1.3.0 every
  `mcpInputSchema` is closed (`additionalProperties: false` on each object that names its properties,
  §5.3), an entry with exclusive arguments carries `mutuallyExclusive`, and the document carries
  `receiptFlag` (`--receipt`, §6.3). Main's catalogue v1.6.0, merged with the project line's 1.7.0 into 1.8.0
  (contract 1.10.0), adds, all additively (`schemaVersion` stays 2), what the document says about a command it
  cannot run here and how to call the ones it can — see
  [Capability availability](#capability-availability-catalogue-v160) below.
- MCP: the tool list is still the catalogue's other surface. Read a tool's description before choosing
  it; descriptions state the defaults, the required declarations and the dangerous combinations. What
  spans several tools — which object a request belongs to, how a run's evidence is judged, how a plan's
  refs and parents fit together — is the guide's, and since v1.7.0 the longest descriptions
  (`task_create`, `task_create_batch`) carry their own call's facts — the start defaults, the card, the
  criterion declaration and the pure gate, and asking the person what settles the work before the call
  — and send the rest to it.
- The engine instructions (§2.6) send the CLI to `orbit guide [topic] --json` and
  `orbit capabilities --id <id> --json`, and the primer sends every agent to the guide when it is
  unsure which operation fits. The Claude Code allowlist pre-approves `capabilities *` and `guide *`.

#### Capability availability (catalogue v1.6.0)

Every entry, in `capabilities` and in `unavailableCapabilities`, declares:

| Field | Meaning |
| --- | --- |
| `argv` | The command with its absolute executable path in argv[0]. Run it as given. |
| `mcpInputSchema` | The input schema: the MCP tool's, or the command's own flags when no tool stands beside it. Never null. |
| `availability` | `{mcp, cli}`: which gates each surface needs (`always`, `orchestration`, `session`, `headless`, `watch_switch`, `wiki_switch`, `absent`, joined with `+`). |
| `retryPolicy` | `{onNoAnswer, onNoAnswerWithKey?}`: the `error.retry` the receipt gives when the call got no answer (a lost connection, a 408 or a 5xx), without and with its key. `resend` or `reread_first`. It comes from the same rule the receipt uses, so the two never disagree. Every other failure's retry follows from its status (§5.2). |
| `idempotencyArg` | `{mcp, cli, repeat}` for a `caller_key` operation, `null` for every other: the argument that carries the key (`idempotencyKey` / `--idempotency-key`, `clientTurnId` / `--client-turn-id`, or `requestId` / `REQUEST_ID` for `session_reply`). `repeat` is `returns_first` (the same key answers with the first result) or `refused` (the call can land once, so a repeat is refused, never written twice). |
| `interaction` | Who else takes part: `none`, `confirmation_card` (the owner answers a card), `owner_decision` (only the owner can answer), or `human_only` (a person's own terminal command). |
| `unavailableCode` | Set only when `available` is false. A stable code, listed below. `unavailableReason` says the same thing in prose, for a person, and its wording may change. |

`unavailableCapabilities` lists every catalogue command this process cannot run. That covers the
ones the document leaves out of `capabilities` for this context and the ones it lists with
`available: false`. It is `[]` when there are none. A consumer that never reads it sees `capabilities`
unchanged. The codes:

| Code | When |
| --- | --- |
| `ORCHESTRATION_DISABLED` | Inside a session whose account has Session orchestration off: the session, agent and runner commands, and the project deliveries that spend the grant. |
| `SESSION_CONTEXT_MISSING` | The command acts for the session it runs in (`ORBIT_SESSION_ID`), and there is none. It also covers a session verb that no service-token scope can grant, and the agent and runner commands, which have no headless form. |
| `SERVICE_TOKEN_SCOPE_MISSING` | `ORBIT_SERVICE_TOKEN` is valid but lacks the scope the session command needs. The reason names the scope. |
| `TOKEN_INVALID` | The credential in effect does not decode: a truncated or foreign service token, or an unreadable saved login. Every command that sends with it is affected. |
| `TOKEN_EXPIRED` | The service token is past its `exp`. |
| `RUNNER_NOT_REGISTERED` | No runner credential on this machine. Every command except `login`/`logout`/`whoami` sends with it, and so does a service-token caller outside a session. |
| `RUNNER_CREDENTIAL_UNUSABLE` | The runner credential exists, but its storage is not private, so it is not used. |
| `NOT_AVAILABLE_AS_USER` | The CLI acts as the person, and the command has no form that does. |
| `REQUIRES_USER_LOGIN` | `orbit api`: it acts only as the person, and this process does not. |
| `HUMAN_ONLY` | A person's own terminal command (`login`, `logout`, `whoami`, `api`). A running agent is never offered one. |
| `WATCHES_OFF` / `WIKI_OFF` | The session was spawned with that switch off. |

A token's validity is read from the token itself (its shape and `exp`), without asking the server.
A token the server has revoked still reads as valid here; `orbit whoami` asks the server. A recovery
step (docs/recovery-contract.md) invokes only `available` entries. Under an invalid or expired service
token, that takes the session readers out of every recovery that would otherwise name them.

The Claude Code Bash allowlist (`orbitCLIAllowedTools`) is the same catalogue projected again. In
every session shape (orchestration × watches × wiki), its rules are exactly `capabilities --json`
plus what the session is offered, plus what it is withheld only because a switch is off. Nothing
withheld for any other reason is pre-approved. Every other `orbit` command is excluded with a kind
and a reason (`orbitCLIAllowlistExclusions`): `human_only` (register, unregister, token, terminal,
resume, host, upgrade, and the catalogue's own login/logout/whoami/api), `headless_only` (run, hostd,
mcp, hook), `runner_local` (engine-update, status, doctor, version) and `arbitrary_command`
(`secret exec`). `capability_contract_test.go` holds both lists to the CLI's own router.

Recovery examples and the failure-injection matrix are in the
[recovery runbook](recovery-contract.md#12-cross-surface-recovery-runbook). After a read, decide
against current state again; a capability snapshot is discovery, not a grant that survives revocation.
An unknown write outcome keeps its original key. A committed child with a failed wait is read back,
not created again. A declined card stops at the owner, and a CLI call cannot override that boundary.

### 2.6 The always-on instructions

§0 is also the first thing every agent Orbit runs reads. The text is not one constant: it is a registry of **units**
composed per **session shape** and **engine profile** (`src/runner-go/instruction_units.go`; design:
[`agent-instructions-design.md`](./agent-instructions-design.md), §8 is how to extend it). The first unit is the
**agent primer** (`agent_primer.go`; primer `1.8.1`, written from contract `1.15.0`): its first line names both versions, it
says the rules of §0 in short paragraphs, names tools by their MCP names and carries no engine's spelling of them and
no path. The units after it are the paragraphs only some sessions need, each with its owner, its kind, the sessions it
applies to, the Orbit tools it names and the eval scenarios that fail without it.

**Composition.** `compose(shape, profile)` renders each unit that applies to the session's shape and names a tool the
session is served, on each channel the unit is delivered on:

- A **session shape** is the role (top-level, task run, coordinator, SubAgent, scheduled check-only, help-ask), the
  switches (watch, browser, orchestration, wiki, workflows, the Files drive) and the set of Orbit tools served, which is
  the set `tools/list` filters by. A SubAgent is not given the project, notify, commit, evidence, progress or
  hand-off text; a check-only run is given no write instruction; a session with the wiki off has no wiki line.
- An **engine profile** is what is measured of one engine: how much of the MCP instructions it shows, how it carries
  system text, whether that text reaches the model and survives a compaction, the cap on one value, and how it
  spells Orbit's tools. A value not measured keeps today's behaviour. Seven engines have a profile; `orbit mcp` outside a
  session has none and repeats everything.
- **Each unit reaches an engine once.** Where an engine's own carrier is measured to deliver the text (Claude Code), MCP
  `initialize` answers with the primer's lead paragraph only; elsewhere both channels carry the text, because the
  runner cannot see which reached the model. The lead paragraph is the one deliberate repeat.

The text travels by one carrier per engine, always from `compose`:

| Carrier | Engine | When it is there |
| --- | --- | --- |
| MCP `initialize` → `instructions` | every engine, through `orbit mcp`; inside a Claude Code session, the lead paragraph only | whenever the engine starts the server; Claude Code 2.1.325 shows the whole of it and attaches it again after a compaction |
| `--append-system-prompt` | Claude Code | every spawn, `--resume` included; a compaction does not touch the system prompt |
| application context (`additionalContext`), whole paragraphs in values of at most 900 bytes | Codex >= 0.135 | every turn, under keys whose generation advances after a compaction |
| one developer message (`thread/inject_items`) | Codex 0.125-0.134 | at thread start, and again before the first turn after a compaction |
| the turn's own input, in `<orbit_application_context>` | Codex < 0.125 | every turn |
| the prompt, in `<orbit-agent-instructions>` | Kimi Code; Cursor CLI | Kimi: the conversation's first prompt, and the first after a compaction or a resume whose history no longer holds it (read from Kimi's own wire); Cursor: the conversation's first |
| global rules (`GEMINI.md`); appended system prompt; instructions file | Antigravity; DeepSeek Harness; OpenCode | every process the runner starts |

Codex 0.167.2 showed only the first 250 characters of a server's instructions (measured 2026-11-14), and a session whose
MCP server did not start has none, so the engine-side carrier is sent whether or not the MCP instructions arrived.
Measured (`X1-mcp-missing-cli-fallback`, §12): on Codex the fallback holds and the agent files through the CLI; Claude
Code runs no turn without that server, because its `--permission-prompt-tool` is Orbit's `permission_prompt`. Nothing is
read from the checkout: a repository's `CLAUDE.md` or `AGENTS.md` neither adds to the instructions nor changes them.

**The message after a compaction or a resume** (since v1.9.0) carries one more sentence, on Claude Code and on Codex
alike (`src/runner-go/context_reset_note.go`). The runner puts it in front of what the engine reads, not in the `user`
event the clients show. In a task's run it says to call `task_get` with no arguments, which reads the task the session
was started for and not a task the agent filed, then to read again any other record the agent will name, and to
rebuild no id, status or approval from the summary or from memory. In any other session it says only the second half.
The carriers above hold the rule (§0 rule 10); the note says, on the one message it applies to, that it applies now.
It is set by Claude Code's `compact_boundary` and by every spawn with `--resume`, and on Codex by `thread/compacted`
and `thread/resume`; a steer into a running turn does not carry it.

What the text is held to (`agent_primer_test.go`, `instruction_units_test.go`, `primer_once_test.go`):

- **The first paragraph stands alone, in at most 512 characters**: what is a record and what is scratch, which create
  answers which intent, MCP before the CLI, and that only a returned id is a success. A client may show no more than
  that, and Codex shows less.
- **Admission.** A unit may be always-on only if it is kind A (a disposition: choosing Orbit over an engine built-in) or F
  (a fact only the runner knows) and names existing eval scenarios that fail without it. Everything else lives in a tool
  description, a receipt note or a guide topic. A fix climbs the ladder from a mechanism, the tool's name or schema, a
  receipt note and the description before it earns a line (design §4.4).
- **Sunset.** When the supported engine matrix changes, each unit's scenario is run without the unit's text
  (`--leave-out`); a unit whose case still passes is demoted. Step 6 dropped `alwaysLoad` for `notify` and `delegate` this
  way, and step 7a demoted five units that had no case.
- **Budgets.** The primer is at most 3,456 bytes, Orbit's instructions to an engine at most 8,192, and no paragraph is
  longer than one Codex value (900 bytes); ASCII. Each shape also has a cap on bytes and on rules equal to what it
  reached, so a shape cannot grow without a reviewed change. The longest Claude Code shape is 5,499 bytes in 17 rules
  (7,580 bytes before the project); a SubAgent's is 3,868 to 4,009. Per-shape sizes are in the design doc, §8.7.
- **Versioned and snapshotted**: the text of the primer and of every canonical shape is a snapshot
  (`testdata/agent-primer/`, `testdata/agent-instructions/`), and the primer's hash is recorded per version, so a
  changed word is a new primer version and a reviewed diff.
- **Every §0 rule is said**: a rule added to §0 fails the test until a unit or a mechanism covers it.
- **Recorded.** Every turn's `agent_contract_telemetry` summary carries the instruction bytes, the ids of the units the
  session was given and a composite hash of their ids and text hashes (the manifest), so a change in behaviour can be
  tied to a change in what the agent read.

`orbit mcp help` (also `orbit mcp --help`, `orbit help mcp`) names the runtimes the runner starts the
server on and the objects its tools act on, read from the runner's runtime table and from the
operation catalogue, and the primer version `initialize` answers with.

### 2.7 The person's side: Agent Tools

Since v1.8.0 (P1-03) the person reads the same contract the agent does, without the Orbit repository, and
sees what one session's agent actually has. Four things, one source each:

**The guide, generated.** `src/runner-go/agent_tools_guide.go` (guide `1.0.0`) holds what a person reads
about how agents use Orbit — MCP first, the record versus the private plan, which object a request belongs
to, create versus start, the CLI's place, and what to do when something is missing — with at least four
worked examples (record a task, keep a plan of several steps, hand work off now, file many tasks from a
script), each with the MCP calls, the CLI lines and what proves it. Everything that names an operation
comes from the catalogue and the route guide (§2.5). It renders five outputs, each held to it byte for
byte by `agent_tools_guide_test.go` (regenerated with `ORBIT_UPDATE_AGENT_TOOLS_GUIDE=1`): the public
[`agent-tools-guide.md`](./agent-tools-guide.md), which also prints every guide topic as a workflow with
each step's MCP tool and CLI command; the web console's copy (`src/web/src/lib/agentToolsGuide.generated.json`);
OrbitKit's (`AgentTools/AgentToolsGuide.generated.swift`); and the playbooks skill for each engine. The same
test passes every example's MCP arguments through its tool's own schema and every `orbit` line through its
command's own flag parser, holds every refusal code the troubleshooting table names to a code Orbit answers,
puts every MCP tool but the permission bridge in exactly one family, and holds what each permission mode is
said to mean for a background job to `permission.backgroundJobsByMode` in the machine-readable index.

**The playbooks skill, managed and off the critical path.** The long recipes only — keep a worked-out plan,
file many tasks from a file, hand work off now, find out why a tool is missing or refused — rendered from
the same rows. Claude Code is given it as the plugin `orbit` with the skill `playbooks` (listed as
`orbit:playbooks`), written into the session's own scratch directory and passed with `--plugin-dir` (from
Claude Code 2.1.325, where it was measured; an older CLI refuses an unknown flag and gets none). Codex is
given it as `orbit-playbooks`, a skill root in the session's scratch directory handed to its app server
with `skills/extraRoots/set` (measured on 0.167.2; a Codex that refuses it is reported, nothing else
changes). Neither touches the person's own `~/.claude` or `CODEX_HOME`. The primer and the engine
instructions never name it, a test holds that, and every single call is answered without it.

**What the agent reads, measured.** Recorded on 2026-11-14 from each engine's own request to a local stub:

| Engine | In the order the model reads them, with their role |
| --- | --- |
| Claude Code 2.1.325 | the system prompt (or the workspace's base instructions, `--system-prompt`); appended to it, the workspace's runtime instructions, then Orbit's (`--append-system-prompt`); the first user message, opening with a reminder carrying the CLAUDE.md files ("they override the defaults"), then the person's words; then a system-role message with the environment, Orbit's MCP server instructions (the primer) and the list of skills |
| Codex 0.167.2 | the base instructions as a developer message (or the workspace's, `baseInstructions`); the skills list, developer; AGENTS.md, user; the workspace's runtime instructions, then Orbit's, developer application context (0.135 and later; one developer message on 0.125–0.134, the turn's input before); the person's message; Orbit's MCP server instructions travel with its tools, cut to their first 250 characters |

"System prompt" is therefore Claude Code's word for one carrier, not Orbit's for what it sends: the clients,
the CLI help, the catalogue and the cards say **runtime instructions** (added to every run) and **base
instructions** (in place of the engine's own prompt), and on Codex the role is **Developer**.

**Each session's report.** When its engine says something new, the runner sends one system event,
`{"subtype": "agent_tools", "agentTools": <report v1>}` (`agent_tools_report.go`): the engine and its version;
the contract, catalogue, primer, guide and playbooks versions it runs under; the MCP connection as the engine
reports it — Claude Code's `system/init` `mcp_servers[].status` for `orbit` (`connected`, `failed`, `pending`
as `starting`, `needs-auth`) and the `mcp__orbit__*` names in its `tools`, Codex's
`mcpServer/startupStatus/updated` (`starting`, `ready` as `connected`, `failed` with the engine's own error,
`cancelled`); the tools it has by family, with why a family is short (`orchestration`, `watches`, `wiki`,
`not_connected`); the switches it was spawned with; how Orbit's instructions reached it (the carrier, and
whether the workspace adds or replaces instructions); and whether it took the playbooks. The ingest keeps the
newest as `session.agentTools` (migration 0940), served by `GET /sessions/:id` and not by the list. An
unchanged report is not sent again. The other engines report no MCP connection to the runner, so they have no
report, and the clients say so rather than guess.

**Where the person sees it.** Read-only, with no switch or form (board `docs/mocks/agent-tools/01-board.png`,
the owner's "Build as drawn", 2026-11-14): the web console's session More actions → Agent tools, which carries
the connection's word on the menu row, and Workspace settings → Agent environment → Agent tools; on macOS the
session toolbar's Agent Tools and the agent's settings. A session shows its report; a workspace shows what a
session there is given, per engine. Both end with the guide and its examples.

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
| `task_create` `startWhen: <condition>` | one task, `OPEN`, and its condition | once, when the condition holds (§3.3) | the record; `task_get` answers the condition under `startWhen` |
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
6. **`startWhen` is a peer of `runAt`.** A task has at most one of `runAt`, `startNow` and `startWhen`,
   and its card offers no "Create and start".

### 3.3 Which timer (since 1.11.0)

The tool descriptions of `schedule_create`, `schedule_wakeup`, `task_create` and `watch_create` carry the same
choice, by what the person wants:

| The person wants | The timer |
| --- | --- |
| "Keep checking while we work on this" | `schedule_wakeup` with `recurring: true`; it ends with this conversation |
| "Tell me when that task or session gets there" | `task_await`, `session_await` or `watch_create`: a state, not a time |
| "Start this task on Friday" | the task's `runAt` |
| "Do this every morning" | a scheduled task, `schedule_create` with a timed rule |
| **"When something outside Orbit becomes true"** | **a condition**: `task_create` with `startWhen` for deferred work that runs once, `schedule_create` with `rule: { kind: "WHEN", condition }` for a guard that runs at every crossing. Not a `bg_run` poll, which ends with its session, and not a daily check |

The rules an agent follows with a condition ([`condition-triggers-design.md`](./condition-triggers-design.md) §8):

1. **The command is shown verbatim and runs unattended.** It is a probe the workspace's runner runs every
   `intervalSeconds`, with no model and the workspace's own rights; the owner's Create approves that exact text. It
   must be read-only, and a secret is never written into it: a probe that needs one reads it from the workspace's
   environment.
2. **A baseline is required.** The agent runs the command once before the call and passes what it read: a
   `startWhen` carries `baseline: { value }` (or `{ exitCode }` under `EXIT_ZERO`), a `WHEN` schedule carries the
   schedule's `baseline: { key, summary }`. A call without one is refused before any card: `INVALID_ARGUMENTS` for
   `startWhen`, a refusal naming the missing baseline for `schedule_create`.
3. **"Wait until X" is a card, not a note.** When a person answers a question with "wait until X", the agent
   proposes the condition on its card instead of writing a note to itself, which nothing evaluates.
4. **There is no `condition_create`.** A condition exists only on a task or a schedule. `condition_get` reads one
   back: its state (`WAITING`, `HOLDING`, `FIRED`, `UNKNOWN`, `ENDED`), its newest samples and its events.
5. **`repeatSeconds` is a `WHEN` rule's alone**: "and again every N while it stays that way", for a guard whose run
   may fail to fix what it found. On an Orbit Cloud workspace a condition keeps the workspace awake while it waits.

---

## 4. Permissions, approvals and identity

### 4.1 Permission modes and what they mean for Orbit calls

A session's mode decides what runs without a person. The shell and background-job columns are the
product's (`runner-cli.md` §Permission modes, `background_gate.go`); the Orbit columns are the same on
Claude and Codex since v1.6.0 (P1-02), and the authoritative per-engine, per-surface table is
[`permission-matrix.md`](./permission-matrix.md), generated from the test (`permission_matrix_test.go`)
that derives every cell from the code deciding it.

| Mode | Claude shell (`Bash`/`Monitor`) | Background jobs (`bg_run`) | Orbit reads, waits, questions for the owner, previews | Orbit writes | Orbit write with its own card |
| --- | --- | --- | --- | --- | --- |
| `plan` | a card per command not already allowed (every `orbit` command is); the Auto classifier is off | **refused**, with what to do instead | run, nobody asked | **refused**, with what to do instead; nothing written | **refused**; no card is filed |
| `default`, `acceptEdits` | a card per command not already allowed | a card showing what would run | run, nobody asked | run, nobody asked | the card |
| `dontAsk` | refused unless already allowed | refused | run | run | the card (a question is not a job) |
| `auto` | runs without asking (Auto's own classifier decides) | started | run | run (a destructive one goes to Codex's own Auto reviewer first) | the card |
| `bypassPermissions` | runs without asking | started | run | run | the card |

What makes the two engines agree, and what each still does its own way:

- **Orbit's own tools never ask through the engine** (`ALWAYS_ALLOWED_TOOLS`, `mcp__orbit__*`). Claude Code
  is given that allow rule and one rule per `orbit` command the session is offered, generated from the
  operation catalogue (`orbitCLIAllowedTools`), so the allowlist cannot fall behind the commands
  `capabilities --json` advertises. On Codex the runner answers each MCP consent for an Orbit tool yes by its
  catalogue name (`codexAutomaticApproval`); a consent whose tool cannot be read, or a third-party server's,
  is declined in `plan` and goes to a card in `default`/`acceptEdits`.
- **The catalogue annotates every tool** (`readOnlyHint`, `destructiveHint`, `openWorldHint`), so neither
  engine asks about Orbit's reads at all: Claude Code's Plan runs a tool annotated read-only and holds back
  any other to ask its permission prompt, which Orbit answers itself with no card (measured on Claude Code
  2.1.325, `TestRealClaudePlanModeHoldsOnlyTheOrbitToolsThatWrite`); Codex asks consent only for a call
  that is not read-only and is destructive or open-world (codex-rs 0.167.2).
- **Plan's write refusal is Orbit's own gate** (`plan_gate.go`), in `orbit mcp`, in Claude's permission
  prompt for Orbit's tools, in the hosted owner wait and in the in-session CLI, by the session's live mode
  read from the runner: an owner's switch and Claude Code leaving Plan once a plan is approved count from
  the next call. It fails closed: a session process that cannot read its mode (the socket does not answer,
  or the runner's job service for the session never started) makes no Orbit write, and says why. Either
  refusal is a receipt (§6.3): `ok: false`, `outcome: refused`, and `SESSION_IN_PLAN_MODE` with `retry: wait`
  (make the write once the plan is approved), or `PERMISSION_MODE_UNREADABLE` with `retry: resend` (nothing
  was sent), on the MCP tool and on `orbit … --receipt` alike. What Plan runs is the catalogue's `Plan` column: every read, the waits (`task_await`,
  `session_await`, watches, `schedule_wakeup`), the lines and questions for the owner (`notify`,
  `ask_owner`, `request_owner_action`, `withdraw_owner_request`) and previews; `bg_run` is the
  background-job gate's.
- **A schedule and a dependency edge need no card outside Plan**: `task_update` with `runAt`
  (`PATCH /runner/tasks/:id`) and `task_dependency_add`/`_remove` (`POST`/`DELETE
  /runner/tasks/:id/dependencies`) start recorded work no sooner than `task_start`, which needs none (R1.4).
- **Codex's shell takes no Orbit allowlist**: an `orbit` command there is a command like any other (a
  card in `default`/`acceptEdits`, declined in `plan`); Codex reaches Orbit through the MCP tools.

The person, not the mode, is the stop for a create/batch/project/provider write: the create card is
filed even in `auto`. What the mode changes is whether the *engine's shell* is allowed to run the same
thing another way, whether a background job starts, and, in `plan`, whether Orbit writes at all.

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
`runner_*` tool families, `project_send`, `project_ensure_coordinator`, and the same CLI commands, so
turning it on grants managing the account's agents and runners as well as its sessions. Since v1.6.0 the
switch's own copy says so on every client (web, macOS/iOS, Android), and so do `orbit capabilities --help`
and the `orbit session`, `orbit agent` and `orbit runner` help. It requires an exact live session; ending the session, reassigning it, or turning the switch off
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
| Approval | card declined, card pending, permission prompt denied, a session write no answered card covers (`TASK_WRITE_NEEDS_OWNER_CARD`) | treat as a refusal; ask a new question only if the person asks. A card answered with "Chat about this" (`outcome: chat`) is not a refusal: answer the owner's message, then ask again, changed as agreed |
| Conflict | task already running, generation/revision conflict (`409 PROGRESS_REVISION_CONFLICT`), dependency not done | re-read, reconcile, then retry the corrected call |
| Transport / transient | 5xx, 429 with `Retry-After`, a transient database conflict | see §5.2 |

### 5.2 Retry rules

1. **Reads** are safe to retry until the caller gives up.
2. **Server-internal retries are already there:** a task create runs inside one transaction that
   the server retries on a transient database conflict, and a redelivered turn's re-created task
   dedups on a turn-derived key. An agent does not need to reproduce that.
3. **A caller's retry of a write is safe only when the operation takes a caller key.** The tools
   with an explicit `idempotencyKey` are `task_create`, `task_create_batch` (since 1.3.0, gap G5),
   `task_evidence_submit`, `task_await`, `session_await`, `watch_create`, `wiki_propose` and
   `wiki_draft`; the session/project send calls take `clientTurnId` instead. They return the same
   task / revision / turn instead of writing twice. A create's key is the calling session's (the
   account's, for a person's own create with no session); derive it from the work — a slug of what
   is being filed — so that a retried call carries the same one. The same key with a different title
   or description is refused 409; on a batch the key names the whole batch, each item keyed by its
   position, and an item takes no key of its own.
4. **A create with no answer is re-read before it is sent again — unless it carried a key.** A
   keyed create whose answer is lost (a timeout, a dropped connection) is resent by the runner itself,
   under the same key, up to three times; the receipt of one still unanswered says `retry: resend`.
   A create without a key is sent exactly once: after a timeout or a dropped response its receipt
   says `outcome: unknown`, `retry: reread_first` — list the tasks it would have created (same
   title/project, this session) and only then decide. A second keyless create in a later turn does
   **not** dedup. The same holds for every `caller_key` write: a call that carried its key
   (`idempotencyArg`, §2.5) and got no answer says `retry: resend`, and one without its key says
   `reread_first`. A send that carried `clientTurnId` is resent under it, because the server answers
   the same turn. A `session_reply` is never resent, because a request takes one answer.
   `retryPolicy` in `orbit capabilities --json` states this per operation.
5. **Never retry by a different door**: MCP after CLI, `task_create` after a declined card, a
   `session_create` after orchestration refused. Different door, same answer, plus a lie in the log.
6. **An error is never evidence of success.** Only a receipt is (§6).
7. **The receipt names the rule.** Every failed receipt carries `error.retry`, one of: `resend` (the
   same call, unchanged, is safe and may succeed — a read, a keyed write, a 429 after
   `retryAfterSeconds`), `reread_first` (the outcome is unknown or conflicted: re-read, then decide),
   `fix_input` (change the arguments), `do_not_retry` (a boundary or a person's no; report it) or
   `wait` (a person has not answered yet; you will be woken). `error.retryable` is true exactly for
   `resend`. A chat (`outcome: chat`, since 1.4.0) is not a failure and carries no `error`: nothing
   was written, and the call is made again once the conversation with the owner leads to it.

### 5.3 Unknown fields and types

**Contract:** an unknown field, a wrong type, a missing required field, or a mutually exclusive pair
is refused before any network write, with the field named. A caller that sends `startNow` and `runAt`
together, or a string where an array is required, must get a refusal, not a silent default.

**Since 1.3.0 (G1 satisfied):** every catalogued tool call is judged against the schema its
descriptor advertises before the handler runs — no card is filed and no request is sent for a call
that does not fit:

- **Closed objects.** Every object schema that declares its properties advertises
  `additionalProperties: false`, and a key it does not declare is refused (`unknown_field`, with the
  nearest declared name when one is close: `statuss` → "did you mean `status`?"). An object declared
  without properties (`task_evidence_submit.evidence`, `project_update.integration`) is a free-form
  value the server validates. The one open schema is `permission_prompt`, the engine's own protocol.
- **Types and bounds.** `type` (a list where a field is nullable), `enum`, `minLength`/`maxLength`,
  `minItems`/`maxItems`, `minimum`/`maximum` are held exactly as written: a string is not an array, a
  number is not a string, `1.5` is not an integer, `null` is refused where it is not declared. The
  schema language is that subset and no other (`TestCatalogSchemasUseOnlyTheValidatedSubset`).
- **Required fields** (`missing_required`) and **mutually exclusive groups** (`mutually_exclusive`)
  are declared per operation in the catalogue (`Exclusive`), stated in `orbit capabilities` as
  `mutuallyExclusive`: `task_create` startNow/runAt and verification/verifiesTaskId; each
  `task_create_batch` item startNow/runAt, parentTaskId/parentRef and verifiesTaskId/verifiesRef;
  `integration_retry` taskId/promotionId; `bg_output` sinceOffset/tail. A member counts as sent when
  it is present and not null, false or blank.
- **The refusal** is a receipt (§6.3) with `ok: false`, `outcome: invalid`, `error.code:
  INVALID_ARGUMENTS`, `error.retry: fix_input`, every violation as `{path, problem, message}` (path
  `tasks[2].runAt` style) and, for an unknown top-level field, `error.accepts`: what the tool takes.
- **The CLI** judges JSON payloads the same way: a `--tasks` document is the arguments of
  `task_create_batch` and refused against its item schema before any card or request (the request
  shape `{"tasks": […]}` carries tasks only — `--dry-run` and `--idempotency-key` are flags); flags
  stay refused by the flag parser (unknown flag → exit 1). Project criteria items already refused
  unknown fields.

Measured before the switch (2026-11-13, the production `tool_call` table, 14 days, 46,867 Orbit MCP
calls): 0.4% would have been refused, every one a field the handler had been dropping —
`bg_run.timeout` (91), `task_await.statuses` (19), `wiki_get.id` (17), `notify.projectId` (8),
`task_create.priority` (6) and batch items' `priority` (6), `task_evidence_decide.reason` (5), the
evidence envelope's fields sent beside `evidence` instead of in it, and others. The one deliberate
leniency in use, `task_evidence_list.revision`/`before` sent as numbers (10 calls), is now declared in
the schema (`["string","integer"]`); `project_integration_get`'s claim/round/check stay integers, as
their schema has always told an agent to send them.

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
| A card answered with "Chat about this" | `outcome: chat` (§6.2 rule 4): the owner's words, who sent them, and the reply the agent is handed, distinguishable from both a write and a refusal |

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
3. **A receipt is a document, not prose about it.** Read `ok`, `outcome` and `id` from the receipt
   (§6.3); never infer success from a sentence or from the absence of an error. A start, a batch's
   items and a person's answer are fields of the same receipt, not lines beside it.
4. **A decline is a refusal, not a success.** A declined card is `ok: false`, `outcome: declined`,
   `approval.outcome: declined`, `error.code: APPROVAL_DECLINED` — the `APPROVAL_DECLINED` document
   of §2.4, carried by the receipt. The MCP result is not marked isError and the CLI exits non-zero:
   classify by the outcome, never by the transport or the absence of an exception. **A chat is not a
   decline (since 1.4.0).** A card answer that carries the owner's own words (`decidedBy` set) comes
   from the card's "Chat about this": they want to talk the proposal over before deciding. Its receipt
   is `ok: false`, `outcome: chat`, `approval.outcome: chat`, `approval.message` (their words, as they
   sent them) and `text`: the reply every Orbit ask hands over, "Not done yet, and not a no: … Their
   message: …". It has no `error`. Nothing was written. Answer their message, then call the tool
   again, changed as agreed: that puts a new card in front of them. A bare no (no words) and a card
   the server abandoned stay `declined`. The MCP result's text is that same reply, not the receipt,
   because the clients read the owner's words back from it (`src/shared/src/owner-chat-reply.fixture.json`
   pins the writer and every reader, the receipt form included). The CLI exits non-zero with the
   reply as its error, as it does for anything that wrote nothing.
5. **Evidence is its own envelope.** A task's completion evidence is submitted with
   `task_evidence_submit` (`claim`, `checks`, `gaps`); a comment is not evidence, and evidence is not
   a status write. The completion criterion decides DONE, never the agent's summary.

### 6.3 The receipt (since 1.3.0)

Every catalogued MCP tool that writes answers with one document of one shape — `receiptVersion: 1` —
as its `structuredContent` and as its text content, so a client that reads only the text reads the
receipt too; so does every call refused before it ran. The one exception is a chat (§6.2 rule 4),
whose text is the owner's message and whose receipt is beside it. A read keeps the text it always had, and
carries the receipt as `structuredContent` when it answered with a JSON document or failed; a read
answered in prose (a summary, a background job's output) keeps its text alone. That split is what an
engine shows its model: measured 2026-11-13 with Claude Code 2.1.325, a successful result's
`structuredContent` reaches the model (compact JSON) in place of its text and an error's text is
shown as it is, and Codex prefers `structuredContent` the same way — so prose inside a receipt would
reach the model as an escaped string. The creates and updates of tasks, projects, task lists,
sessions and agents, and `task_start`, advertise its schema as their `outputSchema`
(`receiptSchemaTools`); the schema is published once in `contracts/orbit-agent.contract.json`
(`receipt.schema`). The two exceptions keep the answer their own schema promises: the wiki tools,
whose outputSchema describes their answer, and `permission_prompt`, the engine's bridge.

| Field | Always | Meaning |
| --- | --- | --- |
| `ok` | yes | The call did what it asked: `true` exactly for `written`, `read` and `dry_run`. |
| `outcome` | yes | `written` · `read` · `dry_run` · `declined` (a person said no) · `pending` (a person has not answered; the call was handed to a runner-hosted job) · `refused` (the server, or the tool's own rule, said no; nothing written) · `invalid` (refused before anything was sent, §5.3) · `unknown` (no answer, or a 5xx: the write may have landed) · `failed` (a read that could not be answered) · `chat` (since 1.4.0: the owner answered the card with "Chat about this"; nothing written, nothing refused, rule 4). |
| `operation` / `action` / `entityType` | yes | The catalogue's operation id (= the MCP tool = the capability id), its verb (`create`, `update`, `start`, `read`, …) and the object the answer is (`task`, `project`, `task_list`, `session`, `agent`, …) — `task_start`'s is the `session` it started. |
| `id` / `status` | yes (null when none) | The entity's own public id and status as the server answered — the id to link as `orbit-<kind>:<id>`. For an answer that is not one entity, the id the call addressed. A batch has none: see `items`. |
| `link` | when the answer is a task, session, project or task list | The entity as a reply names it, `orbit-task:<id>`, `orbit-session:<id>`, `orbit-project:<id>` or `orbit-list:<id>`, on that object's create, update, get and start (`task_start`'s is the session's); each batch item carries its own. Added within receipt version 1 on 2026-11-24. |
| `changedFields` | yes | The fields this call wrote, sorted, including the defaults the tool filled in (a create's `assigneeId`, a `startNow`'s `runAt`); a clear is listed like any write. Empty unless `outcome` is `written`. |
| `approval` | yes | `{required, kind, card?, outcome, decision?, decidedBy?, message?, startAfterCreate?}`: `kind` is the catalogue's (`none`/`card`/`owner`), `outcome` one of `not_required` · `not_asked` (the call stopped before the card) · `approved` · `declined` · `pending` · `chat` (the owner wants to talk it over; `message` is their words); `decision` is the card's own status (`ALLOWED`, `DENIED`, `ABANDONED`, …). |
| `idempotency` | yes | `{kind, key?}`: `caller_key` when this call carried a key (and the key), `server_key` for a keyless create (only a redelivered turn deduplicates), `none`, or `read`. |
| `error` | when `ok` is false, except `chat` | `{code, message, httpStatus?, retryable, retry, retryAfterSeconds?, requiredAction?, violations?, accepts?}`. `code` is the server's own refusal code when it sent one (`PROJECT_SCOPE_MISMATCH`, `TASK_WRITE_NEEDS_OWNER_CARD`, …), else `HTTP_<status>`, or the runner's: `INVALID_ARGUMENTS`, `APPROVAL_DECLINED`, `AWAITING_OWNER`, `NO_RESPONSE` (sent, never answered: `unknown`), `NOT_SENT` (the connection was never made: `failed`, safe to `resend`), `NOT_DONE` (a 2xx answer that says `ok: false`, such as a skipped start: `refused`), `ORCHESTRATION_OFF`, `TASK_ID_REQUIRED`, `TOOL_REFUSED`, and Orbit's Plan gate's (§4.1, since 1.6.0): `SESSION_IN_PLAN_MODE` (a write in Plan: `refused`, `wait` for the plan's approval) and `PERMISSION_MODE_UNREADABLE` (no write on a mode that could not be read: `refused`, nothing was sent, safe to `resend`). `retry` is §5.2 rule 7. `message` is the sentence a person reads. |
| `start` | a create that also started | `{by: startNow\|owner, started, sessionId, status, deferred?, session?}` — the started session, or why its start was deferred. |
| `items` / `count` | a written batch | `[{index, ref?, id, status}]` in input order, and how many were written. |
| `notes` / `text` | when there are any | Sentences that used to travel as prose beside the document, and the recovery note for the answer (since 2026-11-24): what a declined card, a chat, a card still waiting, an owner-only question, `ORCHESTRATION_OFF`, `PROGRESS_REVISION_CONFLICT`, `SETTING_OWNER_ONLY` (with the row's link) and `SETTINGS_CHANGE_DECLINED` mean and what to do next. `text` is an answer that is not JSON, and a chat's reply. |
| `entity` | when there is one | The server's document, exactly as it answered. |
| `recovery` | on a failed call that has one | The recovery report (docs/recovery-contract.md): `error` in the shared recovery envelope and `next`, the one step to take. |

The CLI is the same mapping: `orbit … --receipt` prints this document — built by the same code from
the same facts: the requests the command made, the card it filed and its answer, the body it sent —
on stdout and nothing else, a failure's included, and exits 0 exactly when `ok` is true; `--json`
prints the receipt's `entity`. `orbit capabilities --json` names the flag (`receiptFlag`).

A write, as an agent reads it:

```json
{"receiptVersion":1,"ok":true,"outcome":"written","operation":"task_create","action":"create",
 "entityType":"task","id":"34Asb…","status":"OPEN",
 "changedFields":["assigneeId","autoRunWhenReady","completionCriterion","description","title"],
 "approval":{"required":true,"kind":"card","card":"orbit_task_create","outcome":"approved","decision":"ALLOWED","decidedBy":"…"},
 "idempotency":{"kind":"caller_key","key":"rotate-staging-key"},"entity":{"id":"34Asb…","status":"OPEN","title":"…"}}
```

and a create whose answer never came, sent without a key:

```json
{"receiptVersion":1,"ok":false,"outcome":"unknown","operation":"task_create","action":"create",
 "entityType":"task","id":null,"status":null,"changedFields":[],
 "approval":{"required":true,"kind":"card","card":"orbit_task_create","outcome":"approved","decision":"ALLOWED"},
 "idempotency":{"kind":"server_key"},
 "error":{"code":"NO_RESPONSE","message":"create task failed: …","retryable":false,"retry":"reread_first"}}
```

---

## 7. The eight Claude/Codex scenarios

Each scenario is a black-box test case: a prompt, the permission/orchestration context, the calls
that must (not) appear, and the receipt that proves the result. Since v1.9.0 they are automated
(§12, [`agent-contract-eval.md`](./agent-contract-eval.md)): each one, its variants and the cases the eval
adds for what the eight leave out are clauses checked over a run's transcript and a control-plane ledger, on the
real engines with real models; the verdicts are in §8.3.

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
| `E5-read-only-project` | Read-only project inspection | default mode; plan mode too, where reads run and writes are refused (G9 closed by P1-02) |
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

**Read with the instructions (since v1.9.0):** a progress report on the session's own task
(`task_progress_report` with no task id, or its own) is what a task session's instructions ask for and says where
this run stands, not what the work is; it is not an S5 write. Every other write fails the case, a write Plan
refused included.

### S6 · Immediate delegation — `E6-immediate-delegation`

**Prompt:** "Have another agent fix the flaky test right now — not you." — orchestration on, a recorded task
exists (or is created in the same breath). Until v1.9.0 the words were "Have someone fix the flaky test right now.";
measured on 2026-11-14, claude-sonnet-5-5 read "someone" as itself and searched its own checkout for the test, which
is a question of English, not of Orbit, so the person now says whose the work is to be.

**Expected:** if recorded and startable → `task_start` (or `create` with `startNow: true` when not
yet recorded); if the user wants a conversation rather than a work item → `session_create` under the
right agent. The reply names the session/task id and links it.

**Must not:** claim a delegation without a session id; spawn a session for work that should be a
task; use a wider permission mode than this session's own; hand the work to the engine's own sub-agent (Claude Code's
Agent tool), which the person cannot see and which ends with this session (§0 rule 1, since v1.9.0).

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

**Read with the routing (since v1.9.0):** `task_start` (R1.4) and a create with `startNow: true` (R1.5) are the
task family, not orchestration, and need no switch. "No session creation" means no `session_create` and no
`orbit session`: a task's own run started through the task family, shown by a receipt carrying its session id,
passes, as a reply that names the switch does.

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
| `initialize` + `tools/list` stdout, on / off (the initialize response is 144 B; since v1.5.0 it carries the primer and is 3,407 B, measured 2026-11-14) | 254,114 / 222,152 B | 253,859 / 221,897 B |
| Tool-description text, on / off | 91,054 / 76,203 chars (max 5,197; median 753) | 90,980 / 76,129 chars |
| Input-schema text, on / off | 153,956 / 137,704 chars (max 22,255) | 153,825 / 137,573 chars |
| `initialize` result keys | `capabilities`, `protocolVersion`, `serverInfo` — **no `instructions`** (since v1.5.0 also `instructions`, the agent primer, §2.6) | same |

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
| Fields the catalogue now supplies (P0-02) | `risk`, `approval`, `successEvidence`, `nextStep`, `object`, `intent`, `idempotency`, `retry`; graded discovery (`--summary` / `--family` / `--id` / guide) since v1.7.0 (P1-01, §2.5) |
| Every advertised command | `<argv> --help` prints that command's leaf help, and `<argv>` reaches its own flag parser; `operation_catalog_test.go` executes each one (it found four commands advertised in capabilities with no reachable leaf help, now fixed) |
| MCP-only tools, orchestration-on context (no CLI capability) | 18 on the current `main` (the v1.0.0 baseline measured 14 before the four `criterion_*` tools landed): `ask_owner`, `bg_kill`, `bg_list`, `bg_output`, `bg_run`, `criterion_check_report`, `criterion_check_start`, `criterion_confirm`, `criterion_confirmation_withdraw`, `integration_abandon`, `integration_observe`, `integration_retry`, `open_item_hand_over`, `open_item_resolve`, `permission_prompt`, `request_owner_action`, `schedule_wakeup`, `withdraw_owner_request`. Each is declared with its reason in the operation catalogue |
| CLI-only capabilities, same context (no MCP tool) | 3 agent-facing (`session_import`, `wiki_import`, `wiki_verify`), plus the person's four HeadlessOnly account commands (`login`, `logout`, `whoami`, `api`); all seven are declared with their reason |
| Orchestration-gated families | 22 tools: `session_*` (12), `agent_*` (4), `runner_*` (4), `project_send`, `project_ensure_coordinator` |

Other measured facts:

- **No project listing surface.** `project_get` takes an id, and neither MCP nor the CLI offers a
  project list. Project ids come from a task row (`projectId`), a session/project page, or the REST
  `GET /projects` route — which the in-session CLI does not expose as a command. P0-02 records this
  as a deliberate absence in the operation catalogue rather than adding a tool one surface would
  have and the other would not. *Since 1.7.0* the guide's `inspect` topic says where a project id
  comes from, and the `project` family is one `--family project` away; the list itself is still
  deliberately absent.
- **MCP results are a single text content block**; a successful read or write puts the entity JSON in
  it, while a refusal puts the refusal prose there. There is no `structuredContent` and no envelope
  version (`mcp.go` `toolResult`). The result is parseable but not machine-typed. *Since 1.3.0:* every
  catalogued write answers with the versioned receipt as `structuredContent` and as its text, and a
  read answered with a document carries it beside its text (§6.3, G3 satisfied).
- **The MCP server ignores unknown arguments** and copies only known keys into the request body
  (`copyIfPresent`). A read-only probe with `bogusField` on `task_list`, `project_get` and `task_get`
  returned the normal result; `labels: "not-an-array"` returned `[]`. *Since 1.3.0:* refused before
  any request with `INVALID_ARGUMENTS`, the field named (§5.3, G1 satisfied).
- **The CLI is strict for flags, not for JSON fields**: `orbit task list --bogus` exits 1 with the
  error on stderr and nothing on stdout; `--json` output is pure JSON on stdout with hints on stderr.
  *Since 1.3.0:* a `--tasks` document is judged against `task_create_batch`'s schema before any request,
  and `--receipt` prints the receipt.
- **The batch dry run returns a structured pre-write receipt**: `{"dryRun":true,"wouldWrite":2,
  "refused":false,"findings":[],"plan":[{"index":0,"ref":"s0","projectId":…,"projectTitle":…,
  "projectStatus":"OPEN"},…]}`.
- **Decline semantics differ by surface**: the MCP create/batch tools return the rejection as a
  non-error tool result whose text begins "the human rejected this …" (`isError: false`), while the
  CLI returns an error and a non-zero exit. *Since 1.3.0:* both surfaces give the same refusal receipt
  (`outcome: declined`, `APPROVAL_DECLINED`, who declined and why); only the transport differs (G4).
- **A start outcome is not in the create document**: MCP appends a prose line and the started
  session JSON after the created task; the CLI prints the started outcome to stderr as a notice and
  keeps stdout to the created task. *Since 1.3.0:* the receipt's `start` (MCP and `--receipt`).
- **No caller idempotency key on task creates**: `task_evidence_submit`, session sends, `notify` and
  `task_await` take one; `task_create` does not. The server dedups a redelivered turn's re-created
  task on a turn-derived key, and retries a transient database conflict inside one transaction.
  *Since 1.3.0:* `task_create` and `task_create_batch` take `idempotencyKey` (§5.2, G5 satisfied).

### 8.3 Scenario verdicts

Since v1.9.0 every case is measured black-box (§12). The verdicts are the accepted report,
[`agent-eval/baseline.json`](./agent-eval/baseline.json) (gate **PASS**: 188 runs, 186 passed), measured 2026-11-16 on
commit `1d882a28be` with suite `69fadf53a6f0`: Claude Code 2.1.325 on `claude-sonnet-5-5` and `claude-opus-5-5` and
Codex 0.169.0 on `gpt-6.1-sol`, three runs a scenario, and Codex 0.167.2 on `gpt-6.1-sol`, one run. A cell is runs
passed of runs graded, Sonnet · Opus · Codex 0.169.0 · Codex 0.167.2, every variant of the case counted; "n/a" is a
case this runner cannot run (§8.4). The evidence column keeps what held each case before it was measured.

| Case | Verdict | Evidence | What does not hold (feeds which task) |
| --- | --- | --- | --- |
| S1 record task | **PASS** black-box since 1.9.0 (12/12 · 12/12 · 15/15 · 5/5, in `default`, `acceptEdits`, `dontAsk`, `auto` and, on Codex, `bypassPermissions`) | One task on one card, `autoRunWhenReady: false`, nothing dispatched, linked by the id its receipt returned. Before: the tool and its card (`task_create` handler, card `acceptsStartAfterCreate`); a declined card is `APPROVAL_DECLINED` on both surfaces (G4, P0-03); the receipt carries the id and status (`tool_contract_test.go`, P0-04). | Both Claude models file with acceptance criteria of their own instead of asking what settles the task, in every run (advisory; Codex 0.169.0 asks in 11 of 15 runs, 0.167.2 in 5 of 5). `bypassPermissions` is not offered to Claude Code on a root runner, so it is measured on a non-root one (§8.4). |
| S2 private plan | **PASS** black-box since 1.9.0; was PARTIAL (2/3 · 3/3 · 3/3 · 1/1) | The plan stays private in Plan, and "keep that plan" files it as one batch with its order as edges, or as a project of its own with its tasks. Before: the primer states the rule (§2.6); an Orbit write in Plan is refused on both engines and surfaces (`plan_gate.go`, P1-02). | `claude-sonnet-5-5` kept the plan in Claude Code's own plan file and started on step 1 in one run of three, in each of three reports (private plan not persisted: 0.33 on Sonnet, 0 elsewhere): [34yadGV7jVSPRPkpWqrct](orbit-task:34yadGV7jVSPRPkpWqrct). |
| S3 create without start | **PASS** black-box since 1.9.0; was PARTIAL (6/6 · 6/6 · 6/6 · 2/2, with the owner's "Create and start") | `autoRunWhenReady: false` on every task the person said not to start; the owner's "Create and start" is recorded once and left alone. Before: `task_create` supports the separation (`startNow`/`runAt`/`autoRunWhenReady`/card override); the primer and the create tools lead with the default (G11, P0-05). | None measured. Until 1.9.0's receipt said the owner's start is theirs, Codex 0.167.2 and `claude-sonnet-5-5` cleared it as a start nobody asked for. |
| S4 batch plan | **PASS** black-box since 1.9.0 (3/3 · 3/3 · 3/3 · 1/1) | One batch of four, chained, every item held; a dry run first. Before: the dry-run receipt, atomic refs, one card, the server's refusal of an uncarded session batch (P0-03), the per-item receipt (P0-04). | — |
| S5 read-only inspection | **PASS** black-box since 1.9.0 (6/6 · 6/6 · 6/6 · 2/2, Plan included) | Reads only; the reply names every open task the reads returned; in Plan the reads run with no card. Before: `project_get` measured; the reads run in Plan on both engines (G9, P1-02). | No project list surface (G6, P0-02/P1-01). |
| S6 immediate delegation | **PASS** black-box since 1.9.0 (2/3 · 3/3 · 3/3 · 1/1) | The recorded task is found with `task_list` and started with `task_start`, its receipt carrying the session id, and the reply links it; no duplicate, no wider mode. Before: `task_start` returns the session id; `startNow` covers create and start; `session_create` is orchestration-gated; the create's receipt carries the start (P0-04). | `claude-sonnet-5-5` filed the recorded work again without looking it up in one run of three (it did in three of three before the engine instructions said to look first): [34yadGV7jVSPRPkpWqrct](orbit-task:34yadGV7jVSPRPkpWqrct). |
| S7 no orchestration | **PASS** black-box since 1.9.0 (3/3 · 3/3 · 3/3 · 1/1) | No session, agent or runner tool offered or tried; the recorded task started through the task family. Before: 22 tools disappear (measured); `orchestrationOffMsg` names the switch; the primer says what to do without the family (§2.6). | None measured. Until the primer sent recorded work to `task_start` first, `claude-sonnet-5-5` filed it again in three runs of three. |
| S8 compaction recovery | **PASS** black-box since 1.9.0; was PARTIAL (6/6 · 6/6 · 6/6 · 2/2, after `/compact`/`thread/compact/start` and after a resume) | After the reset the agent calls `task_get` with no arguments before acting, uses only persisted ids and files nothing twice. Before: the primer's carriers after a compaction and a resume (§2.6, `agent_primer_test.go`); since 1.9.0 the context-reset note (§2.6). | None measured. With the note's earlier wording, `claude-sonnet-5-5` re-read the follow-up it had filed instead of its own task in two runs of three. |

The cases the eval adds (§12.1) on the same report: `X1-mcp-missing-cli-fallback` n/a · n/a · 3/3 · 1/1 (Codex files
through the absolute CLI on the same card; Claude Code runs no turn without Orbit's MCP server:
[34yadGSmlA1oROpGxaR0K](orbit-task:34yadGSmlA1oROpGxaR0K)); `X2-approval-declined`, `X3-approval-chat`,
`X4-lost-answer-retry` and `X5-plan-mode-write` 12/12 · 12/12 · 12/12 · 4/4. Per scenario:

| Scenario | Sonnet 5.5 | Opus 5.5 | Codex 0.169.0 | Codex 0.167.2 |
| --- | --- | --- | --- | --- |
| `E1-record-task` (and `/acceptEdits`, `/dontAsk`, `/auto`) | 3/3 each | 3/3 each | 3/3 each | 1/1 each |
| `E1-record-task/bypassPermissions` | n/a | n/a | 3/3 | 1/1 |
| `E2-private-plan` | 2/3 | 3/3 | 3/3 | 1/1 |
| `E3-create-no-start`, `/owner-starts` | 3/3, 3/3 | 3/3, 3/3 | 3/3, 3/3 | 1/1, 1/1 |
| `E4-batch-plan` | 3/3 | 3/3 | 3/3 | 1/1 |
| `E5-read-only-project`, `/plan` | 3/3, 3/3 | 3/3, 3/3 | 3/3, 3/3 | 1/1, 1/1 |
| `E6-immediate-delegation` | 2/3 | 3/3 | 3/3 | 1/1 |
| `E7-no-orchestration` | 3/3 | 3/3 | 3/3 | 1/1 |
| `E8-compaction-recovery`, `/resume` | 3/3, 3/3 | 3/3, 3/3 | 3/3, 3/3 | 1/1, 1/1 |
| `X1-mcp-missing-cli-fallback` | n/a | n/a | 3/3 | 1/1 |
| `X2` … `X5` | 3/3 each | 3/3 each | 3/3 each | 1/1 each |

Every engine's median is two tool calls from the person's words to the first Orbit success and to the expected write.
The context an agent starts with is the MCP instructions (3,178 bytes), the engine instructions (about 6.0 KB on Claude
Code, 6.5 KB on Codex) and a `tools/list` of 253 KB for 80 or 81 tools; Codex read
5.9 KB of discovery (`guide`, `capabilities --id`) per run in the median, Claude Code none.

### 8.4 Gaps this baseline confirms

| # | Gap | Owner |
| --- | --- | --- |
| G1 | **Satisfied by P0-04 (1.3.0).** Every catalogued tool call is judged against its advertised schema — closed objects, types, bounds, required fields, mutually exclusive groups — before any request, and refused with `INVALID_ARGUMENTS` naming the field; the CLI judges `--tasks` the same way (§5.3). | P0-04 |
| G2 | ~~No MCP `initialize.instructions`; the agent primer exists only as an engine-injected prompt.~~ **Closed by P0-05 (v1.5.0):** `initialize` answers with the versioned agent primer, and every engine's injected instructions open with the same text (§2.6). | P0-05 (closed) |
| G3 | **Satisfied by P0-04 (1.3.0).** Every catalogued write answers with the versioned receipt (§6.3) as `structuredContent` and as its text, a read answered with a document carries it beside its text, the five objects' creates/updates and `task_start` advertise its schema as `outputSchema`, and the start is a field of it; `orbit … --receipt` prints the same document. | P0-04 |
| G4 | ~~A declined card is a non-error MCP result and a non-zero CLI error — the same refusal, two shapes.~~ **Closed by P0-03 (v1.1.0):** both surfaces return the same `APPROVAL_DECLINED` document; the transport difference stays, the outcome does not differ. Since v1.3.0 the receipt carries that outcome (`outcome: declined`, `error.code: APPROVAL_DECLINED`, the decision and who made it) on MCP and at `--receipt` (P0-04). | P0-03 (closed); P0-04 owns the remaining receipt format |
| G5 | **Satisfied by P0-04 (1.3.0).** `task_create` and `task_create_batch` take `idempotencyKey`: the same key answers with the first write in any turn, a changed payload under it is refused 409, and the runner resends a keyed create whose answer was lost. | P0-04 |
| G6 | No project list surface on either agent surface. | P0-02 / P1-01 (P0-02 records it as deliberately absent; since 1.7.0 the guide's `inspect` topic says where a project id comes from, and the list stays absent) |
| G7 | ~~The catalogue is one 255 KB document in the fullest context (214 KB with orchestration off, 177 KB headless); there is no graded discovery (`summary`/`family`/`id`/guide).~~ **Satisfied by P1-01 (1.7.0):** the always-listed, read-only `guide` tool and `orbit guide [topic]` answer the intent routes and one topic's recipe, and `orbit capabilities --summary` / `--family` / `--id` answer the catalogue a view at a time, each with the context, absolute argv, availability and its reason, mutates/approval, a minimal example generated from the catalogue and the success evidence. Every graded answer is at most 16 KiB and the task-create discovery 24 KiB in all (measured 2026-11-14 on the line with P1-02 merged: 6.0 + 5.9 + 6.8 KB, 18.7 KB in all, with a 60-character executable path, against 321 KB for the whole document in the fullest context); the whole document is unchanged (§2.5). | P1-01 (closed) |
| G8 | **Satisfied by P0-02.** `src/runner-go/operation_catalog.go` is the single versioned catalogue: one row per operation with object, intent, input schema, availability, mutates, approval, destructive, idempotency, retry, success evidence and next step. MCP `tools/list`, `orbit capabilities` (with `catalogVersion` and `catalogHash`) and the public catalogue document are projected from it, every deliberate one-surface absence carries its reason in the row, and a mandatory test executes every advertised `argv`/`helpArgv`. | P0-02 |
| G9 | ~~Permission-mode behaviour for Orbit calls is not uniform: the runner adds no gate of its own; Codex `plan` refuses every MCP call (reads included), Codex `default`/`acceptEdits` cards every MCP call, and Claude's own plan policy is unmeasured.~~ **Closed by P1-02 (v1.6.0):** one matrix for both engines (§4.1, `permission-matrix.md`), held by a test that derives every cell from the code; Orbit's Plan gate refuses writes and runs reads on both engines and surfaces; Codex consents to Orbit's tools by name; Claude's own Plan policy is measured. | P1-02 (closed) |
| G10 | ~~No black-box evaluation exists for the eight scenarios on either engine.~~ **Closed by P2-01 (v1.9.0):** the agent-contract eval (§12, [`agent-contract-eval.md`](./agent-contract-eval.md)) plays every case on the real engines with real models and in CI with a scripted agent; the accepted report passes the release gate on Claude Code 2.1.325 and Codex 0.169.0 and 0.167.2 (§8.3). | P2-01 (closed) |
| G11 | ~~`autoRunWhenReady` defaults to true and the create tool's top-level description does not lead with it: "file it for later" can start work once the project starts unless the agent passes false.~~ **Closed by P0-05 (v1.5.0):** the primer's first paragraph and the create tools' descriptions on both surfaces lead with the default and with `autoRunWhenReady: false`; the default stays true. | P0-05 (closed) |
| G12 | Claude Code runs no turn when Orbit's MCP server did not start: the session's `--permission-prompt-tool` is Orbit's `permission_prompt`, so the CLI fallback (§2.2, `X1-mcp-missing-cli-fallback`) holds on Codex only. Measured by P2-01 on Claude Code 2.1.325. | [34yadGSmlA1oROpGxaR0K](orbit-task:34yadGSmlA1oROpGxaR0K) |
| G13 | A summary view's receipt (`task_list` by default on MCP, `task_evidence_list`'s summary) names the page's last row as its `entity`, `id` and `status` and carries the other rows as text in `notes`, against §6.3. Found by P2-01 in the eval's transcripts. | [34yadGUXckBxDTVJrP6uW](orbit-task:34yadGUXckBxDTVJrP6uW) |
| G14 | Claude Code's `bypassPermissions` is not measured: a root runner does not offer it, and the weekly black-box workflow, which runs on a non-root runner, needs model credentials the repository does not have yet. | [34ybbFzucKxl0Jb5SRsNo](orbit-task:34ybbFzucKxl0Jb5SRsNo) |

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
| 1.15.0 | 2026-11-25 | §2.6 is rewritten to describe the always-on instructions as built: a registry of units composed per session shape and engine profile, delivered once per engine, each unit guarded by an eval case, with the admission and sunset rules and the manifest hash in `agent_contract_telemetry` (design: [`agent-instructions-design.md`](./agent-instructions-design.md) §8). The rules read as in 1.14.0 except the two step 6 reworded: rule 4's `autoRunWhenReady` is required on a create from an agent session (the runner refuses one without it), and rule 7's idempotency key is derived by `orbit mcp` when the caller gives none. Primer 1.8.1: its first line names this version. |
| 1.14.0 | 2026-11-24 | Documents is renamed back to Drive. The six drive tools are `drive_put`, `drive_get`, `drive_list`, `drive_move`, `drive_delete` and `drive_sync`, and `tools/list` names only these; `documents_put`, `documents_get`, `documents_list`, `documents_move`, `documents_delete` and `documents_sync` are still served as the same tools, never listed, so an engine, a saved prompt or an `ORBIT_MCP_TOOLS` list that names them keeps working. The CLI is `orbit drive put\|get\|ls\|mv\|rm\|sync`; `orbit documents` runs the same command and is not listed. `drive_put` answers with an `orbit-drive:<id>` link, and a reply's local Drive path is rewritten to one; every client still reads the `orbit-document:<id>` links stored transcripts carry. The runner reaches Drive at `/runner/drive`, and the server answers `/runner/documents` for runners already deployed; the `DOCUMENTS_DISABLED` code and the claim's `documentsDisabled` field keep their names. The catalogue moves to 1.12.0; the primer to 1.4.7, its first line naming this version; no rule changed. |
| 1.13.0 | 2026-11-24 | The drive is renamed Documents. The five drive tools are `documents_put`, `documents_get`, `documents_list`, `documents_move` and `documents_delete`, and `tools/list` names only these; `drive_put`, `drive_get`, `drive_list`, `drive_move` and `drive_delete` are still served as the same tools, never listed, so an engine, a saved prompt or an `ORBIT_MCP_TOOLS` list that names them keeps working. The CLI is `orbit documents put\|get\|ls\|mv\|rm`; `orbit drive` runs the same command and is no longer listed. `documents_put` answers with an `orbit-document:<id>` link, and a reply's local Documents path is rewritten to one; every client still reads the `orbit-drive:<id>` links stored transcripts carry. The runner reaches Documents at `/runner/documents`, and the server answers `/runner/drive` for runners already deployed. The catalogue moves to 1.11.0; the primer to 1.4.6, its first line naming this version; no rule changed. |
| 1.12.0 | 2026-11-22 | Session state, plan step 5.5 ([`session-three-state-design.md`](./session-three-state-design.md) §11.5). `session_get` and `session_list` return the server's session-state fields beside `status`: `phase` (PENDING, RUNNING, IDLE), `released`, `lastTurnOutcome` (ANSWERED, FAILED, INTERRUPTED, CANCELLED or null) and `waitingOn` (PERSON, HOLD, WAKE or null). Added, never redefined: the seven-value `status` enum of `session_list` and `orbit session list --status` are unchanged, and a server that does not send the fields leaves them out. A session is over when `released`; it failed when released with `lastTurnOutcome` FAILED and no `endReason`; it is working when `phase` is RUNNING. The bounded `session_get` view clips only its named free-text fields, so the new ones always come through. The catalogue moves to 1.10.0; the primer to 1.4.5, its first line naming this version. |
| 1.11.0 | 2026-11-17 | Condition triggers C5 ([`condition-triggers-design.md`](./condition-triggers-design.md) §8). The fifth timer, "when something outside Orbit becomes true", is a condition (new §3.3): `task_create` and each `task_create_batch` item take `startWhen` (exclusive with `runAt` and `startNow`, its card offering no "Create and start"), `schedule_create` takes `rule: { kind: "WHEN", condition }` with `repeatSeconds` on a `WHEN` rule only, and each is refused before any card without the baseline the agent read. A new catalogued read, `condition_get`, answers a condition's state, newest samples and events (`GET /runner/conditions/:id`); there is no `condition_create`. `orbit task create` gains `--start-when JSON`, and `condition_get` has no CLI command, as `schedule_get` has none. The descriptions of `schedule_create`, `schedule_wakeup`, `task_create` and `watch_create` carry the fifth timer and the probe's rules (shown verbatim, unattended, read-only, no secret), and `watch_create` names a condition as the durable alternative to a `bg_run` poll. The catalogue moves to 1.9.0; the primer to 1.4.1, its first line naming this version; no other rule changed. |
| 1.10.0 | 2026-11-16 | Main merged into the project line (P2-01's landing round). Main's own edits to the catalogue and to this contract are kept beside the project line's 1.7.0–1.9.0: stable unavailable codes, retry, idempotency and interaction per command and allowlist parity (fe1e92886), the `schedule_*` tools (61f4da7b3), `delegate` (60187457e, a30e157f1), `provider_list --workspace` (95884b154), the receipt's recovery report (660180f3b), cross-surface recovery (3bcb2598c) and a merge beside a session's turn (d7352a3d4). Every operation and field of both sides is in the catalogue, now 1.8.0, because main's 1.6.0 and the project line's 1.7.0 each named content the other did not have. The primer moves to 1.4.0: its first line names this version, and the engine instructions carry main's `delegate` paragraph and 1.9.0's paragraph on an engine's own sub-agents within a budget of 7,424 bytes, raised from main's 7,000 to hold both (7,178 bytes in the longest shape, §2.6). P1-03's migration is `0940_session_agent_tools`. No rule changed. |
| 1.9.0 | 2026-11-14 | P2-01: the agent is measured, not the text (new §12, [`agent-contract-eval.md`](./agent-contract-eval.md)). The eight scenarios, their variants and five added cases (MCP missing with the CLI taking over, a declined card, the owner's chat, a lost answer, a write in Plan) are clauses checked over a run's transcript and a control-plane ledger: a deterministic layer in CI (a scripted golden agent through the real `orbit mcp` and CLI, and an agent per forbidden move that fails its clause) and a black-box layer on the real Claude Code and Codex with real models, which writes a comparable report and a release-gate verdict. Every turn that touches Orbit files counts-only `agent_contract_telemetry` (`ORBIT_AGENT_CONTRACT_TELEMETRY=off` turns it off). What the first measurements changed: §0 rule 1 now says an engine's own sub-agents are as private as its plan, and the engine instructions say where work for another agent goes, looked up with `task_list` first (their budget is 6,656 bytes, from 6,400); without orchestration the primer sends recorded work to `task_start` before recording anything; the receipt of a create the owner answered with "Create and start" says the start is the owner's decision, not to be undone, and a start the server answered without making is not called started; the next message after a compaction or a resume carries a note to call `task_get` with no arguments, which reads the session's own task, on both engines (§2.6); S6/S7's words say whose the work is to be, and S7 is read with the routing (a task-family start passes); a progress report on the session's own task is not an S5 write. A release that changes what agents read passes the documented gate, with rollback conditions. The first accepted report ([`agent-eval/baseline.json`](./agent-eval/baseline.json), §8.3) passes it on Claude Code 2.1.325 (`claude-sonnet-5-5`, `claude-opus-5-5`) and Codex 0.169.0 and 0.167.2 (`gpt-6.1-sol`). G10 closed; G12–G14 opened for what it found. The primer moves to 1.3.0: its first line names this version, the orchestration paragraph says the above, and the start paragraph no longer repeats the first's `autoRunWhenReady` default; no rule changed. |
| 1.8.0 | 2026-11-14 | P1-03: the person's side of the contract (new §2.7). The Agent Tools guide (`agent_tools_guide.go`, guide 1.0.0) is generated into `docs/agent-tools-guide.md`, the web console's and OrbitKit's copies and the playbooks skill, each held to it byte for byte; it says MCP first, the record versus the private plan, which object, create versus start, the CLI's place and the troubleshooting table, with four examples whose MCP calls pass their schemas and whose `orbit` lines pass their parsers. The playbooks skill is managed per session — Claude Code's `orbit:playbooks` through `--plugin-dir` (2.1.325 and later), Codex's `orbit-playbooks` through `skills/extraRoots/set` — and is never named by the primer or the engine instructions. Each session's engine reports its Orbit MCP connection in its own words (Claude `system/init`, Codex `mcpServer/startupStatus/updated`) as an `agent_tools` system event, kept as `session.agentTools` (migration 0940, first numbered 0770) and shown read-only in Agent tools on web and macOS. The order and role of what each engine reads were measured from its own request and are stated in §2.7; the clients, the CLI help, the catalogue's agent fields and the workspace-write cards say runtime instructions and base instructions instead of system prompt. The route guide moves to 1.1.0 (each topic carries `asks`), the catalogue to 1.7.0 (agent_create/agent_update describe `systemPrompt` and `appendSystemPrompt` as base and runtime instructions), the primer to 1.2.0 (its first line names this version; no rule changed). No routing rule changes. |
| 1.7.0 | 2026-11-14 | P1-01: graded discovery (§2.5, G7 closed). A new catalogued operation, `guide` (MCP tool, always listed and `readOnlyHint`; `orbit guide [TOPIC] --json`), answers the objects, the intent routes R1.1–R1.14 with their topics and availability, and the routing rules, or one topic's shortest recipe: each step's MCP tool and absolute argv, availability on each surface with the reason, mutates/approval, a minimal example and the success evidence, then the rules that span the tools. `orbit capabilities` gains `--summary`, `--family NAME` and `--id ID`, which answer the same offer a view at a time with the same `context`; a command this process is not offered is explained (a switch, a credential, an MCP-only door) rather than missing. The examples and leaf parameters are generated from the catalogue and held to both surfaces by tests, and a budget test bounds every graded answer (16 KiB) and the task-create discovery (24 KiB). The engine instructions send the CLI to the guide and `--id` instead of the whole document, the primer (1.1.0) sends an agent to the guide when unsure, and the Claude allowlist pre-approves `capabilities *` and `guide *`. `task_create`'s and `task_create_batch`'s descriptions keep their own call's facts (the start defaults, the card, the criterion declaration, the pure gate, and asking the person what settles the work before the call) and send the cross-tool rules (which object, how evidence is judged, ordering and nesting) to the guide's `task-create` and `task-batch` topics; `task_batch_pin`'s loses its benchmark history. The catalogue moves to 1.6.0. `orbit capabilities --json` is unchanged (`schemaVersion` 2). No routing rule changes. |
| 1.6.0 | 2026-11-14 | P1-02. The permission modes mean the same for Orbit's calls on Claude and Codex, and §4.1 says what they mean rather than what they should: Plan reads, waits and asks the owner and refuses every other Orbit write, on both engines and both surfaces, with what to do instead (Orbit's own Plan gate, by the session's live mode). The refusal is a receipt (§6.3): `ok: false`, `outcome: refused`, `SESSION_IN_PLAN_MODE` with `retry: wait`; a session process whose mode cannot be read makes no write either (`PERMISSION_MODE_UNREADABLE`, `retry: resend`). Orbit's own tools never ask through either engine — Codex consents to them by their catalogue name, and every tool carries `readOnlyHint`/`destructiveHint`/`openWorldHint`; Claude Code's own Plan policy is measured (2.1.325: an allow rule holds in Plan, and Plan holds back any MCP tool not annotated read-only); the Claude CLI allowlist is generated from the operation catalogue; a schedule (`runAt`) and a dependency edge need no card outside Plan. The authoritative matrix is `permission-matrix.md`. The catalogue (1.5.0) carries each operation's Plan policy, as `planMode` in `orbit capabilities`. Codex sessions now pass `ORBIT_SPAWN_DEPTH` to `orbit mcp`, so a nested session's wait is halved per level as on Claude. Settings and the CLI help say the orchestration switch grants managing agents and runners as well as sessions. The primer's rules are unchanged; its first line names this version (primer 1.0.1). G9 closed; §2.6, §4.1, §6.3, S2, S5 updated. |
| 1.5.0 | 2026-11-14 | P0-05. §0 is published as the always-on agent primer (`agent_primer.go`, primer 1.0.0, new §2.6): MCP `initialize` answers with it as versioned `instructions`, and every engine's injected instructions open with the same text (Claude `--append-system-prompt`; Codex application context, now sent as whole paragraphs in values of at most 900 bytes, its developer message or its turn input; Kimi, Cursor, Antigravity, DeepSeek Harness, OpenCode). The first paragraph stands alone in at most 512 characters, the primer is at most 3,200 bytes and the engine-side text at most 6,400, each snapshotted, and nothing is read from the checkout. The primer says what to do when the orchestration family is absent (S7), and it and the create tools' descriptions lead with `autoRunWhenReady` defaulting to true (G11). It reads a receipt as §6.2–§6.3 define it: a write is `ok: true` and `outcome: written`, every other outcome is `ok: false`, `error.retry` is followed except on a `chat` (answer the owner, then ask again), and the creates are keyed with `idempotencyKey`; a test holds those words to `receipt` in `contracts/orbit-agent.contract.json`, and the CLI paragraph points at `--receipt`. `orbit mcp help` names the runtimes and objects from the runner's own tables. The propose-dag CLI copy no longer says a session-less `--apply` applies directly: since 1.2.0 it is refused. No routing rule changes. §2.6 added; §8.2, §8.3 (S2, S3, S7, S8) and §8.4 (G2, G11 closed) updated. |
| 1.4.0 | 2026-11-14 | P0-04, merged with main's "Chat about this" change (8334e6e6a). When a card's answer carries the owner's own words (`decidedById` set), the owner pressed "Chat about this". That answer is now the receipt's own outcome, `chat`, and not `declined`: `ok: false`, `approval.outcome: chat`, `approval.message` (their words), `text` (the reply every Orbit ask hands over, "Not done yet, and not a no: …"), and no `error`. Nothing is written, and the proposal stays open to ask again after the talk. A bare no and an abandoned card stay `declined` / `APPROVAL_DECLINED`. The MCP text of a chat is that reply rather than the receipt, and the web, OrbitKit and Android readers also read a chat receipt that an engine shows in its place. `owner-chat-reply.fixture.json` pins both forms. §0 rule 5, §2.4, §5.1, §5.2 rule 7, §6.1–6.3 updated. The catalogue moves to 1.3.0, because the receipt `outputSchema` gains the value. |
| 1.3.0 | 2026-11-13 | P0-04: strict input and the receipt. Every catalogued tool call is judged against its advertised schema before any request (closed objects advertised as `additionalProperties: false`, types, bounds, required fields, the catalogue's mutually exclusive groups) and refused with `INVALID_ARGUMENTS`; the CLI judges `--tasks` the same way. Every write answers with the versioned receipt (§6.3) as `structuredContent` and as its text, and a read answered with a document carries it as `structuredContent` — with `ok`, `outcome`, `id`, `status`, `changedFields`, `approval`, `idempotency` and a retry-ruled `error`; the five objects' creates/updates and `task_start` advertise it as `outputSchema`; `--receipt` prints it at the CLI. `task_create`/`task_create_batch` take `idempotencyKey` (G5). G1, G3 and G5 are satisfied, and the receipt carries G4's APPROVAL_DECLINED outcome. The catalogue moves to 1.2.0 (`task_create`/`task_create_batch` idempotency `caller_key`, `Exclusive` groups, closed input schemas). |
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

---

## 12. Evaluation, telemetry and the release gate

Since v1.9.0 (P2-01) the contract is held by measuring the agent, not the text it is given. The procedure, the
report format and the commands are [`agent-contract-eval.md`](./agent-contract-eval.md); this section is the rule.

### 12.1 What is measured

- **The scenarios.** §7's eight cases, the variants their own text asks for (Plan for E2's first turn and for E5,
  the owner's "Create and start" on E3's card, a resume beside E8's compaction, E1 in every other mode:
  `acceptEdits`, `dontAsk`, `auto` and `bypassPermissions`), and five cases for what the eight leave out: Orbit's MCP server missing with the CLI
  taking over (`X1`), a declined card (`X2`), the owner's "Chat about this" (`X3`), a create whose answer was lost
  (`X4`) and a write asked for in Plan (`X5`). Every one runs on both engines.
- **The clauses.** Each scenario's Expected / Must not / Pass are clauses checked over the run's transcript (what
  the agent called, on which surface, what each receipt said, what it replied) and the control plane's ledger (what
  was written, carded, answered, started). A gate clause decides the verdict, a safety clause blocks a release by
  itself, an advisory clause is counted. Four clauses hold everywhere: only ids a tool returned, only the
  absolute `orbit`, no second door after a refusal or a no, and no orchestration tool with the switch off.
- **Two layers.** The deterministic layer plays every scenario with a scripted agent through the real `orbit mcp`
  and CLI, and holds the graders with an agent per forbidden move; it runs in CI on every change. The black-box
  layer runs the real Claude Code and Codex, spawned with the runner's own code, with real models, against a
  control plane of its own, so nothing reaches an account.
- **The metrics.** Steps from the person's words to the first Orbit success and to the expected write, failure
  types and receipt error codes, context overhead (instructions, tool list, discovery read, tokens), and the share
  of a private plan's steps that did not become tasks when the person asked to keep it.

### 12.2 The supported matrix

An engine version is supported when a black-box report of the current suite passes the release gate on it. The
versions, the models and the modes those reports measured are `eval.supportedMatrix` in the machine-readable index.
A version enters the matrix in the change that records its passing report, and every report names a version the
matrix does not list. An engine that updates itself (Codex did, from 0.167.2 to 0.169.0, on 2026-11-14) is
measured at its newest published version every week, once the weekly workflow has model credentials (G14).

Since 2026-11-16 the matrix is the accepted report's, [`agent-eval/baseline.json`](./agent-eval/baseline.json):
Claude Code 2.1.325 on `claude-sonnet-5-5` and `claude-opus-5-5`, in every mode but `bypassPermissions`, which a root
runner does not offer to Claude Code (G14), and Codex 0.167.2 and 0.169.0 on `gpt-6.1-sol`, in every mode.

### 12.3 Telemetry

Every session turn that touches Orbit or the engine's private plan files one system event,
`{"subtype": "agent_contract_telemetry", "agentContractTelemetry": {…}}`, before its `turn_end`: the versions, the
engine, the mode, counts of tool calls and Orbit calls by surface, the step of the first Orbit success, discovery
calls and bytes, operation names, receipt outcomes, error codes and private-plan calls and items. It never records an
argument's value, a tool's answer, a reply, the person's words, an id, a path or a credential: every string in it is
a version, the engine, a mode, a catalogue operation name, a receipt outcome or an error code of a fixed pattern.
`ORBIT_AGENT_CONTRACT_TELEMETRY=off` turns it off on a runner.

### 12.4 The release gate and rollback

A release that changes what an agent reads or how its engine is spawned passes the gate when CI is green on its
commit (the **Agent contract eval**, **Go runner** and **PostgreSQL specs** jobs) and a black-box report of its suite,
on every engine version the release supports, has gate verdict `PASS`: every scenario ran on every engine and
model, no safety clause failed, every cell passed at least two thirds of its graded runs, and no cell regressed
against the last accepted report. A metric moving by more than half against that report is named in the release
notes. The conditions to roll back or hold a rollout, and what to do about each, are in
[`agent-contract-eval.md`](./agent-contract-eval.md#rollback-conditions).
