package main

// The Orbit agent primer: the short core of docs/orbit-agent-contract.md §0 that every agent Orbit
// runs reads before anything else Orbit says to it (contract §2.6).
//
// It has two kinds of carrier, and both carry these exact words. The MCP server sends it as its
// `initialize` instructions (mcpServer.handle), which is the one carrier every engine shares. And
// the runner puts it first in the instructions it writes into each engine's own context
// (compose, instruction_units.go): Claude Code's --append-system-prompt, Codex's application context (or,
// on an older Codex, its developer message or turn input), Kimi's every prompt and Cursor's first,
// Antigravity's global rules, DeepSeek Harness's appended prompt and OpenCode's instructions. The
// second carrier is the fallback for an engine that does not show a server's instructions, or a
// session whose MCP server did not start, so it is sent whether or not the first one arrived: the
// runner cannot see which of them reached the model. The exception is an engine whose own carrier is
// measured to reach the model (EngineProfile.SystemCarrier, so far Claude Code): there `orbit mcp`
// answers initialize with the first paragraph only, and the primer is given once. On 2026-11-14 Codex 0.167.2 showed only the
// first 250 characters of a server's instructions, as that server's line in its list of deferred
// tools (`codex debug prompt-input`), while Claude Code 2.1.325 puts the whole of them under "MCP
// Server Instructions" and, after a manual /compact, still quoted their first line. That is why the
// first paragraph has to stand alone, and why it opens with what Orbit is for.
//
// Nothing here is read from the checkout: a repository's CLAUDE.md or AGENTS.md neither adds to
// it nor can take it away. It names tools by their MCP names, which every engine shows under its
// own prefix, and so it holds the same in an MCP client and in every engine's instructions; the
// engine-specific spelling, the CLI's absolute path and everything that depends on the session's
// shape live in the units compose puts after it. ASCII, like the rest of those instructions.
//
// Budgets (TestAgentPrimerBudgets): the first paragraph is at most agentPrimerLeadMaxChars, the
// whole primer at most agentPrimerMaxBytes, Orbit's own instructions to an engine (the primer and
// the paragraphs after it, without the agent's own prompt) at most orbitInstructionsMaxBytes, and no
// paragraph longer than one Codex application context value (codexContextValueMaxBytes). Its exact
// text is pinned by snapshots (testdata/agent-primer/) and its version by the hash of that text, so
// a change to a word is a new agentPrimerVersion, reviewed as a diff.

// agentPrimerVersion is the version of the primer's text. Any change to it is a new version.
const agentPrimerVersion = "1.8.1"

// agentContractVersion is the Agent Contract version the primer was written from: the header of
// docs/orbit-agent-contract.md and contractVersion in contracts/orbit-agent.contract.json.
const agentContractVersion = "1.15.0"

// agentPrimerLeadMaxChars is the most the first paragraph may take. It is read on its own: by a
// client that shows only the beginning of a server's instructions, and by a model skimming them.
const agentPrimerLeadMaxChars = 512

// agentPrimerMaxBytes is the most the whole primer may take, so that being always on stays cheap. Raised from 3,200 on
// 2026-11-20, with the owner's agreement, for the settings paragraph (agentPrimerSettings, 189 bytes with its break,
// docs/settings-from-conversation-design.md §7): primer 1.4.3 took all 3,200.
const agentPrimerMaxBytes = 3456

// orbitInstructionsMaxBytes is the most the instructions the runner writes into an engine may take,
// the primer included (compose, in its longest shape: a task's session with Watch on). Raised from
// 6,400 on 2026-11-15, with the owner's agreement, for the delegate paragraph (orbitDelegateInstructions, 440
// bytes): the longest shape was already 6,309 bytes without it. On the project line Agent Contract 1.9.0 had
// raised it to 6,656 for the paragraph on an engine's own sub-agents (orbitSubAgentInstructions), which the
// agent-contract eval measured agents need. Merged in contract 1.10.0, the instructions carry both paragraphs and
// the longest shape is 7,178 bytes, so the budget is 7,424 (7.25 KiB); reconciling the two paragraphs, which both
// speak of handing work to another agent, is P2-01's follow-up, not the merge's. Raised to 7,680 on 2026-11-20, with
// the owner's agreement, for the primer's settings paragraph: the longest shape went from 7,236 bytes to 7,425.
// Raised to 8,192 on 2026-11-23 for the workflow paragraph (orbitWorkflowInstructions, 416 bytes): the longest shape
// went from 7,582 bytes to 7,998. A session whose Agent has Workflows off, or a SubAgent, does not carry it.
const orbitInstructionsMaxBytes = 8192

// The primer, one rule set per paragraph. The first states the choices an agent gets wrong most
// often (contract §8.3: S1-S4), and every later one is one or two of §0's ten rules.
const (
	agentPrimerLead = "Orbit primer " + agentPrimerVersion + " (Agent Contract " + agentContractVersion + "). " +
		"Orbit is the user's durable record; your todo or plan tool is private scratch. Record what they want kept or " +
		"followed up: one piece of work is task_create, a worked-out plan task_create_batch, a goal with its own " +
		"acceptance project_create; when two fit, the smaller wins. Use Orbit's MCP tools first, never the CLI to get " +
		"around a card or a refusal. No returned id, no claim."

	agentPrimerObjects = "Pick the object by the question it answers. Project: the whole goal and what settles it. " +
		"Task: one durable piece of work. Task list: how a class of work is dispatched, " +
		"not a plan or a folder. Session: one execution running now. Agent: where work runs and under which identity. " +
		"Never file what this session is already doing as another task or session. Unsure which fits, or how to call " +
		"it? Call guide: no arguments for the routes, a topic for the recipe."

	agentPrimerStart = "Start is its own decision: task_start runs recorded work, task_create with startNow: true " +
		"records and starts it on one card, and runAt schedules one start. If the person said nothing should run " +
		"until they say so, pass autoRunWhenReady: false and do not call task_start."

	agentPrimerCards = "A create, a batch, a project, a provider or agent change can put a confirmation card in front of " +
		"the user, which writes nothing until they confirm it, so first say in a sentence or two what you will create " +
		"and why. A refusal or a declined card is final on every surface; a chat or a card still waiting is not a no, " +
		"and its receipt says what to do next."

	agentPrimerReceipts = "Only a structured receipt counts: a write happened when it says ok: true and outcome: written; " +
		"read and dry_run wrote nothing. Any other outcome is ok: false; except on a chat, follow its error.retry " +
		"(resend, reread_first, fix_input, do_not_retry, wait) and its notes. Name an Orbit object to the user by its receipt's link, never a bare " +
		"id: `[Fix login redirect](orbit-task:<id>)`."

	// Its hand-off half (task_start what task_list shows recorded, else record it) is the handoff unit's since 1.6.0.
	agentPrimerOrchestration = "Session, agent and runner tools exist only while the account's Session " +
		"orchestration switch is on. Without session_* tools, do not try `orbit session` and never claim a delegation: " +
		"tell the user the switch is in Settings -> Session orchestration."

	agentPrimerSettings = "When a person's problem is one of their own Settings, call settings_get, then settings_propose " +
		"the change; for a key it refuses, link the row it returns instead of describing where it is."

	agentPrimerRederive = "After compaction or a resume, read before you act -- task_get with no id reads this " +
		"session's task -- and never rebuild an id, a status or an approval from memory or a summary."
)

// agentPrimer is the whole primer, as `initialize` sends it and as each engine's instructions begin.
const agentPrimer = agentPrimerLead + "\n\n" +
	agentPrimerObjects + "\n\n" +
	agentPrimerStart + "\n\n" +
	agentPrimerCards + "\n\n" +
	agentPrimerReceipts + "\n\n" +
	agentPrimerOrchestration + "\n\n" +
	agentPrimerSettings + "\n\n" +
	agentPrimerRederive
