package main

import (
	"os"
	"path/filepath"
	"strings"
)

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
// It leads with what separates an Orbit task from an engine's built-in todo/plan
// entry — audience, not tool preference. An agent that never learns the distinction
// records the user's work in session-local scratch that never reaches Orbit, so the
// task silently never appears in the UI. The "returned its id" rule gives the agent
// something it can check itself, which also catches the case where it wrote no task
// at all and merely listed one in its reply.
//
// The reference paragraph exists because the tools answer with base62 ids, and an agent reporting
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
// Kept ASCII and roughly a paragraph long: codex carries this as a single
// application-context value capped at 1,000 tokens (see codexAgentAdditionalContext).
func orbitCLIInstructions(executable string, insideRecordedWork, watches bool) string {
	executable = orbitCLIInstructionExecutable(executable)
	if executable == "" {
		return ""
	}
	command := shellQuote(executable)
	return "Orbit tasks are the user's durable record: visible in Orbit's UI, outliving this session. " +
		"Any built-in todo or plan tool you have is private scratch the user never sees: fine for tracking your own steps, " +
		"but anything the user asked you to record, or follow-up work they should see, MUST go through an Orbit tool. " +
		"Never claim a task was created or updated unless an Orbit tool returned its id.\n\n" +
		"Creating a task, a batch of tasks or a project puts a confirmation card in front of the user and writes nothing " +
		"until they confirm it, so first say in a sentence or two what you are about to create and why. If they decline, " +
		"do not create it another way.\n\n" +
		"When you mention a task, session, project or task list to the user, link it by name instead of pasting its bare id: " +
		"`[Fix login redirect](orbit-task:<id>)`, and likewise `orbit-session:<id>`, `orbit-project:<id>` and `orbit-list:<id>`. " +
		"Orbit shows the user that name, one click from the thing itself; the id alone means nothing to them.\n\n" +
		orbitProjectInstructions(insideRecordedWork) +
		orbitProgressInstructions(insideRecordedWork) +
		orbitWaitInstructionsFor(watches) +
		"Write to Orbit with the `mcp__orbit__*` tools when your tool list has them: their inputs are schema-checked and " +
		"they need no shell. The Orbit CLI at `" + command + "` is for shell composition (pipes, scripts, bulk input) and " +
		"work that outlives this turn. Inside a session both attribute the task to you, so either is fine; the CLI needs " +
		"`" + command + " capabilities --json` first to discover its commands, then run the returned argv with that exact " +
		"absolute path. Use `--json` output. Do not run `" + command + " mcp` directly."
}

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
		// Every task verb the CLI has. An action missing here is pre-approved for nobody: the agent
		// hits a permission prompt for a command `capabilities --json` just told it to run — which is
		// what happened to the twelve this list was short of. Still enumerated rather than `task *`,
		// for the reason the project list gives below, and TestEveryAdvertisedCapabilityIsPreApproved
		// walks baseCLICapabilities and fails when it falls behind it, so the next verb cannot be
		// added to the document and forgotten here.
		for _, action := range []string{
			"list", "get", "create", "update", "delete", "start", "comment", "await", "progress",
			"labels", "attribution", "dependency-graph", "dependency-add", "dependency-remove",
			"evidence-list", "evidence-submit", "evidence-decide",
			"create-batch", "batch-pin", "reopen", "request-confirmation",
		} {
			rules = append(rules, "Bash("+command+" task "+action+" *)")
		}
		// Every task-list subcommand the CLI has. An action missing here is pre-approved for
		// nobody: the agent hits a permission prompt for a command `capabilities --json` just
		// told it to run — which is what happened to get/update when they were added.
		for _, action := range []string{"list", "create", "get", "update", "delete", "propose-dag"} {
			rules = append(rules, "Bash("+command+" task-list "+action+" *)")
		}
		// Every project verb the CLI has. An action missing here is pre-approved for nobody: the
		// agent hits a permission prompt for a command `capabilities --json` just told it to run.
		// Still enumerated rather than `project *`, so a verb added later is a decision somebody
		// makes here rather than one it inherits. Three of them are answers an agent had to be
		// refused to reach: crossings says what a refusal is waiting on, resolve-blocker ends this
		// project's own wait with the owner's answer on a card in front of them, and merge-evidence
		// records what a target branch was observed to contain. The one project verb NOT here is
		// ensure-coordinator, which OPENS a conversation and so rides the orchestration gate below.
		for _, action := range []string{"get", "create", "update", "delete", "crossings", "resolve-blocker", "merge-evidence"} {
			rules = append(rules, "Bash("+command+" project "+action+" *)")
		}
		// Every watch verb: they wait on Orbit's own work for the session they run in, which is the
		// command the instructions send an agent to instead of a sleep loop.
		for _, action := range []string{"create", "get", "list", "update", "cancel"} {
			rules = append(rules, "Bash("+command+" watch "+action+" *)")
		}
		// The two single-command families: `orbit notify` is how a session reaches the human the
		// runner works for — the reader most likely to be stuck without one is the plain
		// single-session agent — and `orbit provider list` answers for the `--provider` field the
		// task commands above take, which need no orchestration to be given one.
		rules = append(rules, "Bash("+command+" notify *)")
		rules = append(rules, "Bash("+command+" provider list *)")
		// The merge receipts are the one pair of session verbs advertised OUTSIDE the orchestration
		// gate (mergeReceiptCLICapabilities, §13.7): recording that a branch was merged is evidence
		// about the caller's own work rather than a power over somebody else's session, and the agent
		// most likely to need it is the plain single-session one with no session_* tools at all.
		for _, action := range []string{"merge-receipt", "merge-receipts"} {
			rules = append(rules, "Bash("+command+" session "+action+" *)")
		}
		if allowOrchestration {
			// The session family as advertised, minus `import`: it is the one session verb that
			// refuses to run in a session at all (cliSessionImport), and the capability document
			// withholds it from a running agent for the same reason (HeadlessOnly), so there is no
			// reader here to pre-approve it for.
			for _, action := range []string{"create", "list", "search", "get", "await", "send", "interrupt", "merge", "end", "complete", "delete"} {
				rules = append(rules, "Bash("+command+" session "+action+" *)")
			}
			// The agent verbs ride the same gate and have no headless form: no service-token scope
			// names them, so they are advertised only where a live session has the grant.
			for _, action := range []string{"list", "create", "update"} {
				rules = append(rules, "Bash("+command+" agent "+action+" *)")
			}
			// The one project verb that OPENS a conversation, and so spends the orchestration
			// credential rather than the machine's own: it is advertised where that grant exists
			// (RequiresOrchestration), which is where its rule belongs too.
			rules = append(rules, "Bash("+command+" project ensure-coordinator *)")
		}
	}
	return rules
}

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
