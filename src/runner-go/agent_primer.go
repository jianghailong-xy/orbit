package main

// The Orbit agent primer: the short core of docs/orbit-agent-contract.md §0 that every agent Orbit
// runs reads before anything else Orbit says to it (contract §2.6).
//
// It has two kinds of carrier, and both carry these exact words. The MCP server sends it as its
// `initialize` instructions (mcpServer.handle), which is the one carrier every engine shares. And
// the runner puts it first in the instructions it writes into each engine's own context
// (orbitCLIInstructions): Claude Code's --append-system-prompt, Codex's application context (or,
// on an older Codex, its developer message or turn input), Kimi's every prompt and Cursor's first,
// Antigravity's global rules, DeepSeek Harness's appended prompt and OpenCode's instructions. The
// second carrier is the fallback for an engine that does not show a server's instructions, or a
// session whose MCP server did not start, so it is sent whether or not the first one arrived: the
// runner cannot see which of them reached the model. On 2026-11-14 Codex 0.167.2 showed only the
// first 250 characters of a server's instructions, as that server's line in its list of deferred
// tools (`codex debug prompt-input`), while Claude Code 2.1.325 puts the whole of them under "MCP
// Server Instructions" and, after a manual /compact, still quoted their first line. That is why the
// first paragraph has to stand alone, and why it opens with what Orbit is for.
//
// Nothing here is read from the checkout: a repository's CLAUDE.md or AGENTS.md neither adds to
// it nor can take it away. It names tools by their MCP names, which every engine shows under its
// own prefix, and so it holds the same in an MCP client and in every engine's instructions; the
// engine-specific spelling, the CLI's absolute path and everything that depends on the session's
// shape live in orbitCLIInstructions, after it. ASCII, like the rest of those instructions.
//
// Budgets (TestAgentPrimerBudgets): the first paragraph is at most agentPrimerLeadMaxChars, the
// whole primer at most agentPrimerMaxBytes, Orbit's own instructions to an engine (the primer and
// the paragraphs after it, without the agent's own prompt) at most orbitInstructionsMaxBytes, and no
// paragraph longer than one Codex application context value (codexContextValueMaxBytes). Its exact
// text is pinned by snapshots (testdata/agent-primer/) and its version by the hash of that text, so
// a change to a word is a new agentPrimerVersion, reviewed as a diff.

// agentPrimerVersion is the version of the primer's text. Any change to it is a new version.
const agentPrimerVersion = "1.0.1"

// agentContractVersion is the Agent Contract version the primer was written from: the header of
// docs/orbit-agent-contract.md and contractVersion in contracts/orbit-agent.contract.json.
const agentContractVersion = "1.6.0"

// agentPrimerLeadMaxChars is the most the first paragraph may take. It is read on its own: by a
// client that shows only the beginning of a server's instructions, and by a model skimming them.
const agentPrimerLeadMaxChars = 512

// agentPrimerMaxBytes is the most the whole primer may take, so that being always on stays cheap.
const agentPrimerMaxBytes = 3200

// orbitInstructionsMaxBytes is the most the instructions the runner writes into an engine may take,
// the primer included (orbitCLIInstructions, in its longest shape: a task's session with Watch on).
const orbitInstructionsMaxBytes = 6400

// The primer, one rule set per paragraph. The first states the choices an agent gets wrong most
// often (contract §8.3: S1-S4), and every later one is one or two of §0's ten rules.
const (
	agentPrimerLead = "Orbit primer " + agentPrimerVersion + " (Agent Contract " + agentContractVersion + "). " +
		"Orbit is the user's durable record; your todo or plan tool is private scratch. Record what they want kept or " +
		"followed up: one piece of work is task_create, a worked-out plan task_create_batch, a goal with its own " +
		"acceptance project_create; when two fit, the smaller wins. Use Orbit's MCP tools first, never the CLI to get " +
		"around a card or a refusal. Create is not start, but autoRunWhenReady defaults to true: pass false to hold a " +
		"task. No returned id, no claim."

	agentPrimerObjects = "Pick the object by the question it answers. Project: the whole goal and what settles it. " +
		"Task: one durable piece of work. Task list: how a class of work is dispatched (a concurrency cap, a pause, " +
		"standing instructions), not a plan or a folder. Session: one execution running now. Agent: where work runs " +
		"and under which identity. Never file what this session is already doing as another task or session."

	agentPrimerStart = "Start is its own decision: task_start runs recorded work, task_create with startNow: true " +
		"records and starts it on one card, and runAt schedules one start. If the person said nothing should run " +
		"until they say so, pass autoRunWhenReady: false and do not call task_start; left out, an assigned task can " +
		"start by itself once it is ready (prerequisites DONE, project started)."

	agentPrimerCards = "A create, a batch, a project, a provider change or an agent change puts a confirmation card " +
		"in front of the user and writes nothing until they confirm it, so first say in a sentence or two what you " +
		"are about to create and why. A declined card (APPROVAL_DECLINED) is a refusal: do not create it another " +
		"way. A chat is not a no: answer the owner's words, then call the tool again, changed as agreed. A card still " +
		"waiting is not a no either, and an owner-only decision is never yours to answer."

	agentPrimerCLI = "The Orbit CLI is for pipes, scripts, bulk input from a file or stdin, the few operations with " +
		"no MCP tool and commands that outlive this turn, run by the absolute path Orbit gives you. It reaches " +
		"the same server under the same approvals: a refusal, a declined card or a missing switch there is the same " +
		"answer."

	agentPrimerReceipts = "Only a structured receipt counts: a write happened when its receipt says ok: true and " +
		"outcome: written, with the entity's id and status; read and dry_run wrote nothing. Any other outcome is ok: " +
		"false; except on a chat, follow its error.retry (resend, reread_first, fix_input, do_not_retry, wait). Key " +
		"task_create and task_create_batch with an idempotencyKey derived from the work, so a retry cannot file twice. " +
		"Name an Orbit object to the user by a link, never a bare id: `[Fix login redirect](orbit-task:<id>)`, " +
		"likewise `orbit-session:<id>`, `orbit-project:<id>` and `orbit-list:<id>`, and a wiki entry as " +
		"`[title](orbit-wiki:<id>)`."

	agentPrimerOrchestration = "Session, agent and runner tools exist only while the account's Session " +
		"orchestration switch is on. Without session_* tools, do not try `orbit session`: record the work as a task, " +
		"tell the user the switch is in Settings -> Session orchestration, and never claim a delegation."

	agentPrimerRederive = "After compaction or a resume, read before you act -- task_get with no id reads this " +
		"session's task -- and never rebuild an id, a status or an approval from memory or a summary."
)

// agentPrimer is the whole primer, as `initialize` sends it and as each engine's instructions begin.
const agentPrimer = agentPrimerLead + "\n\n" +
	agentPrimerObjects + "\n\n" +
	agentPrimerStart + "\n\n" +
	agentPrimerCards + "\n\n" +
	agentPrimerCLI + "\n\n" +
	agentPrimerReceipts + "\n\n" +
	agentPrimerOrchestration + "\n\n" +
	agentPrimerRederive
