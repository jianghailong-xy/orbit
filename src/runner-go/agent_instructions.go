package main

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Delivery is handled by the runner and may not be visible in Codex's tool result.
// Keep this in Codex's application context so an upload failure never asks the model to redraw.
const codexImageDeliveryInstructions = "After generating an image, preserve the original file. " +
	"Do not regenerate it solely because Orbit could not attach or upload it. " +
	"Only claim that the image is attached or delivered when Orbit explicitly confirms attachment delivery; " +
	"successful generation alone is not delivery confirmation. " +
	"If delivery fails, report that the image was generated but delivery failed, keep the original file available, " +
	"and let Orbit retry delivery. If delivery status is unavailable, report only generation success " +
	"without claiming delivery success or failure."

func orbitCLIExecutable() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if !filepath.IsAbs(exe) || strings.ContainsAny(exe, "\x00\r\n") {
		return ""
	}
	return filepath.Clean(exe)
}

func orbitCLIPermissionExecutable(exe string) string {
	if !filepath.IsAbs(exe) {
		return ""
	}
	exe = filepath.Clean(exe)
	// Claude's allowlist syntax wraps shell prefixes in Bash(...), and the full
	// list is comma-separated. Fail closed for unusual executable paths that
	// could change the meaning of that policy.
	if strings.ContainsAny(exe, "\x00\r\n,()[]{}*?\\'`<>") {
		return ""
	}
	return exe
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'"'"'`) + "'"
}

func orbitCLIInstructionExecutable(exe string) string {
	if !filepath.IsAbs(exe) || strings.ContainsAny(exe, "\x00\r\n`<>") {
		return ""
	}
	return filepath.Clean(exe)
}

// orbitCLIInstructions is generated with the resolved binary path so an agent
// cannot accidentally execute a project-local/PATH-shadowed `orbit` program.
//
// It leads with the agent primer (agent_primer.go), the same words `orbit mcp` sends as its
// instructions: what separates an Orbit task from an engine's built-in todo/plan entry — audience,
// not tool preference — which object an intent belongs to, the CLI's place, create versus start,
// the cards, and what counts as a receipt. An agent that never learns the first distinction
// records the user's work in session-local scratch that never reaches Orbit, so the task silently
// never appears in the UI. Everything after it is what only the runner knows: how this engine
// spells Orbit's tools, the CLI's absolute path, which files a reply can hand over, and the
// paragraphs that depend on the session's shape.
//
// The primer's link sentence exists because the tools answer with base62 ids, and an agent reporting
// what it did pastes them into prose, where they are the one spelling the user cannot read. The
// `orbit-<kind>:<id>` link is the shape the composer's #-references already use: clients draw its
// text and route the click (web referenceRoute, OrbitKit ReferenceLink), so the id stays checkable.
//
// The project paragraph states the default first ("one task") and only then the
// shape worth proposing, because the previous form stated only triggers, and one
// of them -- "will not finish in this session" -- is arguable about any non-trivial
// work, so it fired on nearly everything. The bar is now a plan ALREADY worked out
// and counted, not a forecast the model can talk itself into. Deliberately lopsided:
// missing a body of work that deserved a project costs a plan that stays in the
// conversation, while proposing one every time costs the user's attention on every
// turn, and only the second is paid whether or not the judgement was right.
//
// Kept ASCII and in paragraphs no longer than one Codex application-context value: codex carries
// each value capped at 1,000 tokens, and codexAgentAdditionalContext sends these paragraphs packed
// into values of at most codexContextValueMaxBytes.
func orbitCLIInstructions(executable string, insideRecordedWork, watches bool) string {
	executable = orbitCLIInstructionExecutable(executable)
	if executable == "" {
		return ""
	}
	command := shellQuote(executable)
	return agentPrimer + "\n\n" +
		orbitReplyFileInstructions +
		orbitEvidenceFileInstructions +
		orbitProjectInstructions(insideRecordedWork) +
		orbitProgressInstructions(insideRecordedWork) +
		orbitWaitInstructionsFor(watches) +
		orbitWikiPathInstructions +
		"Write to Orbit with the `mcp__orbit__*` tools when your tool list has them: they are schema-checked and need " +
		"no shell. Inside a session the Orbit CLI at `" + command + "` takes the same approvals and attributes the work " +
		"to you: find a command with `" + command + " guide [topic] --json` or `" + command + " capabilities --id <id> " +
		"--json`, then run the argv it returns with that exact absolute path. Pass `--receipt` to read the receipt its " +
		"MCP tool answers with; `--json` prints the entity alone. Do not run `" + command + " mcp` directly."
}

// orbitReplyFileInstructions says which files a reply can really hand over. The runner uploads a linked
// file only out of the session's own directories (reply_attachments.go), so an agent that leaves its
// screenshot in /tmp and links it there has given the user a label nothing can open: a session on
// 2026-10-29 did that with a copy of the same file already in its checkout. The last sentence is the
// price of the copy this asks for: commitWorktree and finalizeWorktree stage with `git add -A`, so a
// file dropped into the checkout ships with the work unless git ignores it, which is why uploads lives
// outside the checkout (writeUpload). It says "can end up in a commit" rather than "gets committed"
// because an agent must not read it as the runner committing for it. The uploads path is not spelled
// out because this text is the same for every session, and "a git-ignored path" is there for the
// engines that do not show it to the agent. ASCII like the rest of the paragraph.
const orbitReplyFileInstructions = "To hand the user a file, link it in your reply as `[name](path)`, or `![name](path)` " +
	"to show an image. Orbit attaches a linked file only if it is inside your working directory or this session's " +
	"uploads directory; from anywhere else, /tmp included, the user cannot open it, so copy the file there first and " +
	"link the copy. Whatever git does not ignore in your working directory can end up in a commit, so a file that " +
	"does not belong in the repository goes in the uploads directory or a git-ignored path.\n\n"

// orbitEvidenceFileInstructions is where the evidence of a piece of work goes, which is what the repository was for
// until file_upload (docs/orbit-files-design.md §2.3): 96% of its history was evidence and mocks. It follows
// orbitReplyFileInstructions and repeats its rule: file_upload reads from the same two directories a reply links from
// (localFileScope), which is why this sentence can lean on the one before it. A log is named as well as the screenshot,
// because the tool call that printed it is already stored. The FILE check is what spares the file a commit: it binds the
// bytes into the evidence the way a commit would, and it is how whoever judges the work gets to read it. ASCII like the rest.
const orbitEvidenceFileInstructions = "For evidence, cite a command's output by its tool call rather than saving a log, " +
	"and keep screenshots and reports with file_upload rather than in the repository: it reads those same two " +
	"directories and returns a link that also works in a reply, and an id to cite as a FILE check.\n\n"

// orbitWikiPathInstructions sends an agent to the wiki at the moment it can use what is there: searches by
// path found nothing 3 times in 21 up to 2026-11-02, where multi-word ones did 124 times in 188
// (docs/wiki-memory-claims-design.md). "If your tool list has it" because this text goes to every session, and
// an account with the wiki off has no such tool (wikiToolDescriptors). ASCII like the rest of the paragraph.
const orbitWikiPathInstructions = "Before changing a file, use wiki_search with its path to look up known pitfalls, " +
	"if your tool list has it.\n\n"

// orbitWaitInstructions routes a wait on Orbit's own work to a watch. An agent told to "wait for these
// tasks" otherwise writes the loop it knows, sleep plus task_get or `orbit task get`, which holds its turn
// open for the whole wait and dies with the engine. ASCII like the rest of the paragraph.
const orbitWaitInstructions = "To wait for Orbit work -- tasks reaching a status, sessions finishing a turn -- do not " +
	"poll with sleep, Bash loops, background jobs or schedule_wakeup: call task_await or session_await (watch_create for " +
	"other conditions) and end your turn. Orbit holds the watch on its server and starts a turn in this session with a " +
	"structured payload when the condition holds, even if this engine was recycled in the meantime.\n\n"

// orbitWaitInstructionsFor is that paragraph for a session spawned with Watch on, and nothing for one spawned
// with it off (watch_rollout.go): it has no await tool to send a wait to, and is told what sessions were told
// before watches.
func orbitWaitInstructionsFor(watches bool) string {
	if !watches {
		return ""
	}
	return orbitWaitInstructions
}

// orbitProgressInstructions tells a session running a task how its progress reaches Orbit. A watch on the
// task decides from task_progress_report alone, so "3 of 8 done" written into a reply or printed by a shell
// has reported nothing, and a report that changes only its message has not progressed. Only the task form
// carries it: without a taskId the tool reports on the task being run. ASCII like the rest of the paragraph.
func orbitProgressInstructions(insideRecordedWork bool) string {
	if !insideRecordedWork {
		return ""
	}
	return "When this task's position changes -- a new phase, or another item of a known total done -- report it " +
		"with task_progress_report. Orbit reads progress only from that report, never from your Bash output or " +
		"transcript, and only a change of phase, current or total counts as progress; a message alone does not. If a " +
		"report is refused with 409 PROGRESS_REVISION_CONFLICT, read the progress again, then report.\n\n"
}

// orbitProjectInstructions is the paragraph about what deserves an Orbit Project, in the two
// forms a session can be in.
//
// A session already running inside recorded work -- the task it was dispatched for, or a project
// it coordinates -- gets the second form. It used to withhold the proposal altogether: work such
// a session turns up either belongs to the body of work it is in (and `task_create` files it
// there by itself, since the server derives the project from the session's scope) or is a
// separate undertaking that is the user's to start. What that reasoning priced was the wrong
// thing. The card is the ask, so a proposal costs the user one keystroke; and the write binds the
// project to THIS conversation, so the coordinator knows the work firsthand. What the form says
// instead is the default it would be trading away, and what agreeing costs. Offering both forms
// of the same paragraph to both kinds of session is what made the proposal read as something to
// do on every turn rather than something to do rarely, and that is still why the two differ.
func orbitProjectInstructions(insideRecordedWork bool) string {
	if insideRecordedWork {
		return "You are running one task Orbit has already recorded, so newly discovered work has somewhere to go: file it " +
			"as a task, saying first what you are filing. It lands under the same project this one belongs to, without your naming it. " +
			"Work that is a separate undertaking is the user's to start, and you may put it in front of them rather than " +
			"starting it yourself: project_create raises a confirmation card and waits for the answer, and on a yes this " +
			"conversation becomes that project's coordinator -- opening the project later comes back here rather than " +
			"starting a stranger. Filing the task is still the default, and the cheaper one. Nothing is created without " +
			"the user's yes, and the card is the only place that yes comes from: never create a project another way.\n\n"
	}
	return "Most newly discovered work is one task: record it and move on. When you have already worked out a plan for it and " +
		"that plan comes to 4 or more steps that depend on one another, or the work plainly needs several agents on different " +
		"parts of it over days, you may propose recording it as an Orbit Project instead -- say why in a sentence or two, then " +
		"call project_create from this same session so the conversation becomes its coordinator; do not switch or open a " +
		"session for it. Its confirmation card is the user's answer: if they decline, a task is the right record, and do not " +
		"propose the same body of work twice.\n\n"
}

// insideRecordedWork reports whether this session is already executing something Orbit has
// recorded. Today that is exactly "was dispatched for a task" -- which covers a conversation
// ABOUT a task as well, since the claim carries contextTaskId in the same field. A project's
// coordinator is the other session this is true of, and it is told so by the coordinator context
// the server attaches to its turns, which is where its role-specific instructions already live.
func (s *ClaimedSession) insideRecordedWork() bool {
	return s != nil && s.TaskID != ""
}

// appendSystemPrompt is what a session's engine is given after its system prompt, ahead of Orbit's own
// instructions (withOrbitCLIInstructions): the agent's appended prompt, then what the runner has to say about the
// checkout the session runs in (checkoutInstructions). It is read from the checkout each time an engine's
// instructions are built, so a checkout made or brought back since the last spawn is described as it now is.
func (s *ClaimedSession) appendSystemPrompt() string {
	wt := s.WT
	if wt == nil {
		// A codeless run's detached checkout is left out the same way (codeless_checkout.go).
		wt = s.Detached
	}
	note := checkoutInstructions(wt)
	if note == "" {
		return s.Agent.AppendSystemPrompt
	}
	if strings.TrimSpace(s.Agent.AppendSystemPrompt) == "" {
		return note
	}
	return strings.TrimRight(s.Agent.AppendSystemPrompt, "\r\n") + "\n\n" + note
}

// instructionAgent is the session's agent as an engine's instructions are built from it: its appended prompt is
// the session's (appendSystemPrompt).
func (s *ClaimedSession) instructionAgent() AgentExecConfig {
	agent := s.Agent
	agent.AppendSystemPrompt = s.appendSystemPrompt()
	return agent
}

func withOrbitCLIInstructions(configured, executable string, insideRecordedWork, watches bool) string {
	orbit := orbitCLIInstructions(executable, insideRecordedWork, watches)
	if orbit == "" {
		return configured
	}
	if strings.TrimSpace(configured) == "" {
		return orbit
	}
	return strings.TrimRight(configured, "\r\n") + "\n\n" + orbit
}

// orbitCLIAllowedTools is Claude Code's allowlist for the Orbit CLI: `capabilities --json` and its graded views
// (`capabilities *`), and one Bash rule per command the operation catalogue offers an agent's session. It is generated from the catalogue (orbitCLICommands)
// rather than enumerated, so no command `capabilities --json` tells an agent to run is pre-approved for nobody: a
// command missing here is one the agent hits a permission prompt for, which is what happened to every verb the
// hand-written list fell behind on. Each rule is still one command, never `task *`, so a verb added to the CLI is
// pre-approved only once the catalogue declares it.
//
// A rule takes the command past Claude Code's own permission check and no further. Whether it then writes is still
// Orbit's to say, by the same rules the MCP tools are held to: a consequential write files its card, and in Plan
// mode every write is refused by Orbit's Plan gate (plan_gate.go), which reads the session's live mode. That is why
// the list does not shrink in Plan: Claude Code honours these rules there too (measured on 2.1.325), and a list
// chosen when the process starts could not follow a mode that changes under it — Claude Code entering Plan by
// itself, or leaving it once a plan is approved — while a refused write that went to a card first would only put a
// question in front of the owner that has one answer.
func orbitCLIAllowedTools(executable string, allowOrchestration bool) []string {
	if executable == "" {
		return nil
	}
	commandForms := []string{shellQuote(executable)}
	if shellWordSafe(executable) {
		// Claude's Bash matcher compares the rendered command literally instead
		// of normalizing optional quotes. Accept both forms for ordinary paths so
		// argv copied from the capability document remains usable.
		commandForms = append(commandForms, executable)
	}
	rules := []string{}
	for _, command := range commandForms {
		rules = append(rules, "Bash("+command+" capabilities --json)")
		// The graded views of the same document (--summary, --family, --id): reads of the catalogue that ask the
		// server nothing, and where the instructions send an agent instead of the whole document. The guide is a
		// catalogued command, so its rule comes from the loop below like every other.
		rules = append(rules, "Bash("+command+" capabilities *)")
		for _, cli := range orbitCLICommands() {
			if cli.orchestration && !allowOrchestration {
				continue
			}
			rules = append(rules, "Bash("+command+" "+cli.words+" *)")
		}
	}
	return rules
}

// orbitCLICommand is one catalogue command as the allowlist names it: its words after `orbit`, and whether the
// capabilities document offers it only where the orchestration grant exists.
type orbitCLICommand struct {
	words         string
	orchestration bool
}

// orbitCLICommands is every command the catalogue offers an agent's session, in catalogue order: each CLI command
// but the person's own account commands (HeadlessOnly), which no running agent is offered. The orchestration
// families — session, agent, runner, and the two project deliveries that open a conversation — are marked, since
// `capabilities --json` offers them only with the grant, and that is where their rules belong. The watch and wiki
// commands are not: their rules cost nothing in a session spawned with the switch off, and a missing one costs the
// prompt this list exists to remove. Built once: none of it depends on the environment the catalogue is otherwise
// projected for.
var orbitCLICommands = sync.OnceValue(func() []orbitCLICommand {
	var commands []orbitCLICommand
	for _, op := range operationCatalog().Ops {
		if op.CLI == nil || op.CLI.HeadlessOnly || len(op.CLI.Argv) < 2 {
			continue
		}
		commands = append(commands, orbitCLICommand{
			words:         strings.Join(op.CLI.Argv[1:], " "),
			orchestration: strings.HasPrefix(op.availability().CLI, "orchestration"),
		})
	}
	return commands
})

func shellWordSafe(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			continue
		}
		switch r {
		case '/', '_', '+', '.', '-':
			continue
		default:
			return false
		}
	}
	return true
}

func appendUnique(values []string, additions ...string) []string {
	result := append([]string{}, values...)
	seen := make(map[string]bool, len(result))
	for _, value := range result {
		seen[value] = true
	}
	for _, value := range additions {
		if !seen[value] {
			result = append(result, value)
			seen[value] = true
		}
	}
	return result
}

// appendClaudeAgentInstructionArgs adds discovery instructions while preserving
// the owner's tool policy. Session command prefixes are added only when the
// current claimed session may orchestrate; arbitrary orbit subcommands and
// PATH-resolved binaries do not become approval-free.
func appendClaudeAgentInstructionArgs(
	args []string,
	agent AgentExecConfig,
	executable string,
	allowOrchestration bool,
	insideRecordedWork bool,
	watches bool,
) []string {
	// The raw absolute path remains safe for direct exec/MCP configuration. Only
	// inject and auto-allow the CLI when it is also unambiguous in Claude's
	// comma-separated Bash(...) permission grammar.
	executable = orbitCLIPermissionExecutable(executable)
	if agent.SystemPrompt != "" {
		args = append(args, "--system-prompt", agent.SystemPrompt)
	}
	if appendPrompt := withOrbitCLIInstructions(agent.AppendSystemPrompt, executable, insideRecordedWork, watches); appendPrompt != "" {
		args = append(args, "--append-system-prompt", appendPrompt)
	}
	allowed := appendUnique(agent.AllowedTools, orbitCLIAllowedTools(executable, allowOrchestration)...)
	if len(allowed) > 0 {
		args = append(args, "--allowedTools", strings.Join(allowed, ","))
	}
	return args
}
