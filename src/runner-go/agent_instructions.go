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

// Orbit's instructions to an engine are composed from the unit registry (instruction_units.go, compose). They lead with the agent primer (agent_primer.go), the same words `orbit mcp` sends as its
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

// orbitCLIUseInstructions is the Orbit CLI in one paragraph: what it is for, the resolved binary path, so an agent cannot
// accidentally execute a project-local/PATH-shadowed `orbit` program, and Orbit's tools spelled as the engine shows
// them. It merges the primer's CLI paragraph (primer 1.6.0 and before) with the paragraph that closed the instructions
// (design §6 step 5b). A refusal there is the same answer because the CLI reaches the same server under the same
// approvals (§0 rule 8). It names `guide <topic> --json` and `--receipt` because those are what an agent whose MCP
// server did not start reaches for (X1-mcp-missing-cli-fallback on Codex, 2026-11-24); `capabilities` is in the guide.
const orbitCLIUseInstructions = "The Orbit CLI is for pipes, scripts, bulk input from a file or stdin, the few operations " +
	"with no MCP tool and commands that outlive this turn; otherwise prefer {{orbit_tools}}. Run it as `{{cli}}`: it " +
	"reaches the same server under the same approvals and attributes work to you, so a refusal, a declined card or a " +
	"missing switch there is the same answer. `{{cli}} guide [topic] --json` gives a recipe's argv; `--receipt` prints " +
	"a write's receipt. Never run `{{cli}} mcp`."

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
//
// One sentence since design D5. What the other three said (a link from elsewhere, /tmp included, reaches nobody; copy
// first; unignored files in the checkout can end up in a commit) is now said once and only when it applies: the next
// turn's replyFileCorrection names the path that could not be attached and the directories that work.
// The commit warning is gone with the paragraph: an agent that copies into the checkout is told by the uploads directory
// being named first in the correction, and the evidence unit's file_upload keeps screenshots out of the repository.
const orbitReplyFileInstructions = "Hand the user a file as `[name](path)`, an image as `![name](path)`: copy it into " +
	"your working directory or this session's uploads directory first, and link the copy, never /tmp."

// orbitEvidenceFileInstructions is where the evidence of a piece of work goes, which is what the repository was for
// until file_upload (docs/drive-design.md §2.3): 96% of its history was evidence and mocks. It follows
// orbitReplyFileInstructions and repeats its rule: file_upload reads from the same two directories a reply links from
// (localFileScope), which is why this sentence can lean on the one before it. A log is named as well as the screenshot,
// because the tool call that printed it is already stored. The FILE check is what spares the file a commit: it binds the
// bytes into the evidence the way a commit would, and it is how whoever judges the work gets to read it. ASCII like the rest.
const orbitEvidenceFileInstructions = "Evidence: cite a command's output by its tool call rather than saving a log; " +
	"keep screenshots and reports with file_upload rather than in the repository: it reads those same two " +
	"directories and returns a reply link and the id a FILE check cites."

// orbitDriveGuide is the drive's rule in the guide's files topic: the whole of §7.3, which the drive paragraphs say
// in brief because the guide is read on demand and has no byte budget.
func orbitDriveGuide() string {
	if documentsOffProcess.Load() || !documentsEnabledFromEnv() {
		return ""
	}
	const readOnly = "Verification, judgment and guest-driven turns (a message carrying the ORBIT_GUEST marker) read the drive and do not write it."
	if !driveMounted() {
		return "The owner's Drive is reached with drive_put, drive_get, drive_list, drive_move, " +
			"drive_delete and drive_sync, or `orbit drive put|get|ls|mv|rm|sync`, by drive path (/Proj/r.md). " +
			"drive_put reads only this session's checkout or uploads directory and overwrites with a version; drive_sync " +
			"copies a whole directory from there once, in the background, skipping files already the same; drive_get saves " +
			"into the uploads directory. A delete moves the " +
			"entry to the owner's Trash, which agents cannot see or restore, and no tool shares a drive file. " + readOnly
	}
	return "~/Drive (/home/orbit/Drive, mounted at " + driveMountPath + ") is the owner's permanent Drive, " +
		"shared across sessions and runners; link a drive file in a reply by its path. ~/Drive is a symlink: give ls -l, " +
		"find and du ~/Drive/ with the trailing slash. Copy in with cp -r or rsync -rt: the drive keeps no modes, so cp -a, " +
		"cp -p and rsync -a report an error and exit non-zero for executables, though the contents are copied, and tar x " +
		"extracts them without the executable bit. Not " +
		"supported: hard and symbolic links, mode and owner changes, file locks, shared mmap of a file open for writing, " +
		"writing inside an existing file (write a new file and rename it over), fallocate, executing a file (run it with " +
		"bash), special files and xattrs. Each refusal is logged in " + driveParentPath + "/errors.log; status.json there says " +
		"whether the drive is connected, and unsent/ keeps bytes a failed close could not commit. " + readOnly
}

// orbitWikiPathInstructions sends an agent to the wiki at the moment it can use what is there: searches by
// path found nothing 3 times in 21 up to 2026-11-02, where multi-word ones did 124 times in 188
// (docs/wiki-memory-claims-design.md). "If your tool list has it" because this text goes to every session, and
// an account with the wiki off has no such tool (wikiToolDescriptors). ASCII like the rest of the paragraph.
const orbitWikiPathInstructions = "Before changing a file, use wiki_search with its path to look up known pitfalls. Cite an entry as `[title](orbit-wiki:<id>)`."

// orbitWaitInstructions routes a wait on Orbit's own work to a watch. An agent told to "wait for these
// tasks" otherwise writes the loop it knows, sleep plus task_get or `orbit task get`, which holds its turn
// open for the whole wait and dies with the engine. One line since design step 5e: what the watch does (Orbit holds it
// on its server, wakes this session with a structured payload, survives the engine being recycled) is the await
// tools' descriptions, and their receipt says to end the turn; I1-wait-await passed 10/10 on both engines with the
// paragraph left out altogether (docs/agent-instructions-eval-baseline.md). ASCII like the rest of the paragraph.
const orbitWaitInstructions = "To wait for Orbit work, call task_await or session_await (watch_create for other " +
	"conditions) and end your turn; never poll or sleep for it."

//
// Only a session spawned with Watch on gets it (unit wait.use-await): one spawned with it off (watch_rollout.go) has
// no await tool to send a wait to, and is told what sessions were told before watches.

// orbitNotifyInstructions says when notify is called: when a wait the person asked to hear about ends. On
// 2026-11-17 an agent told "tell me when the upgrade is complete" waited on a bg_run job with wakeOnExit, woke,
// answered in the conversation and stopped: nothing in these instructions named notify, and in Claude Code its
// description, which says exactly this, was behind ToolSearch. Every session is offered notify, so every form of
// these instructions carries it. ASCII like the rest of the paragraph.
const orbitNotifyInstructions = "When the person asked to hear once something is done, tell them with notify when " +
	"it is: an answer in this conversation reaches them only when they next look."

// orbitHandoffInstructions is how work goes to another agent: the engine's own sub-agents, task_start, task_create
// and delegate in one paragraph (design §6 step 5). It was three: a sub-agents paragraph (task_start what task_list
// shows recorded, else task_create or session_create), a delegate paragraph (delegate whenever you would start a
// subagent) and the hand-off half of the orchestration-off paragraph. Each gave its own answer to "have another agent
// do this", and on 2026-11-24 Claude Code answered E6 and E7 with delegate in every run, never starting the work
// already recorded (docs/agent-instructions-eval-baseline.md). The paragraph puts the three in one order: look first,
// start what is recorded, delegate a piece whose result comes back here, create and start new work of its own.
//
// What each part was measured to need. The engine's own sub-agents run inside this session, so the person cannot see
// them and they end with it (E6/E7 on Claude Code 2.1.325, 2026-11-14: the agent launched a background sub-agent and
// said the work was handed off, with no record). Told "task_start if task_list shows it recorded", claude-sonnet-5-5
// called no task_list in six runs of six (2026-11-16), so it says to look first. A request to work in the background
// or to "use a subagent" went to the engine's Agent tool until the text claimed both for delegate (2026-11-19), and
// agents asked to read another machine's data used session_create with that agent until the text named workspace
// (2026-11-15). What delegate does (Orbit picks the model, records the cost, brings the result back) is its
// description's. Only a session that writes to Orbit gets it (unit handoff.use-orbit): a SubAgent is served neither
// delegate nor the task writes, and a check-only run's writes are refused. Its Claude Code sentence,
// {{toolsearch:delegate}}, is left out for Cursor, which never shows mcp__orbit__* names (cursorProfile). ASCII.
const orbitHandoffInstructions = "Hand work to another agent through Orbit{{own_subagents}}. Look with task_list first: task_start work already recorded, never " +
	"file it twice. Otherwise use delegate for a piece whose result you need back, in the background, on a cheaper or " +
	"stronger model or on another machine (needs: [\"os:darwin\"], or workspace: an agent's name from agent_list); new " +
	"work of its own is task_create with startNow.{{toolsearch:delegate}}"

// workflowsOn reports whether this claimed session is spawned with the workflow tool offered.
func (s *ClaimedSession) workflowsOn() bool {
	return s == nil || !s.WorkflowsDisabled
}

// agentDelegates reports whether a session run with this agent is offered delegate: every one but a SubAgent's
// (subagentChildJob marks it with envSubagentRunID, which its `orbit mcp` reads).
func agentDelegates(agent AgentExecConfig) bool {
	return agent.Env[envSubagentRunID] == ""
}

// orbitProgressInstructions tells a session running a task how its progress reaches Orbit. A watch on the
// task decides from task_progress_report alone, so "3 of 8 done" written into a reply or printed by a shell
// has reported nothing. Only the task form carries it (unit progress.report): without a taskId the tool reports on the
// task being run. What a report's answer means is said in its receipt since primer 1.5.0 (design step 4): its note says
// whether it counted as progress (taskProgressLead), and a 409 PROGRESS_REVISION_CONFLICT says to read it again
// (progressConflictNote). ASCII like the rest of the paragraph.
const orbitProgressInstructions = "When this task's position changes -- a new phase, or another item of a known total done -- report it " +
	"with task_progress_report: Orbit reads progress from that report alone, not from your output or replies."

// orbitProjectInsideInstructions and orbitProjectProposeInstructions are the paragraph about what deserves an Orbit
// Project, in the two forms a session can be in (units project.inside-recorded-work and project.propose).
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
const (
	orbitProjectProposeInstructions = "Most newly discovered work is one task: record it and move on. When you have already worked out a plan for it and " +
		"that plan comes to 4 or more steps that depend on one another, or the work plainly needs several agents on different " +
		"parts of it over days, you may propose recording it as an Orbit Project instead -- say why in a sentence or two, then " +
		"call project_create from this same session so the conversation becomes its coordinator; do not switch or open a " +
		"session for it. Its confirmation card is the user's answer: if they decline, a task is the right record, and do not " +
		"propose the same body of work twice."
)

// insideRecordedWork reports whether this session is already executing something Orbit has
// recorded. Today that is exactly "was dispatched for a task" -- which covers a conversation
// ABOUT a task as well, since the claim carries contextTaskId in the same field. A project's
// coordinator is the other session this is true of, and it is told so by the coordinator context
// the server attaches to its turns, which is where its role-specific instructions already live.
func (s *ClaimedSession) insideRecordedWork() bool {
	return s != nil && s.TaskID != ""
}

// appendSystemPrompt is what a session's engine is given after its system prompt, ahead of Orbit's own
// instructions (withOrbitInstructions): the agent's appended prompt, then what the runner has to say about the
// checkout the session runs in (checkoutInstructions). It is read from the checkout each time an engine's
// instructions are built, so a checkout made or brought back since the last spawn is described as it now is.
func (s *ClaimedSession) appendSystemPrompt() string {
	wt := s.WT
	if wt == nil {
		// A codeless run's detached checkout is left out the same way (codeless_checkout.go).
		wt = s.Detached
	}
	note := checkoutInstructions(wt)
	if commits := branchCommitInstructions(s.WT); commits != "" && agentDelegates(s.Agent) && !s.Agent.ScheduledCheckOnly {
		note = strings.TrimSpace(commits + "\n\n" + note)
	}
	repo := s.WorkDir
	if wt != nil && wt.RepoDir != "" {
		repo = wt.RepoDir
	}
	if github := githubWorkspaceInstructions(repo); github != "" {
		note = strings.TrimSpace(note + "\n\n" + github)
	}
	if note == "" {
		return s.Agent.AppendSystemPrompt
	}
	if strings.TrimSpace(s.Agent.AppendSystemPrompt) == "" {
		return note
	}
	return strings.TrimRight(s.Agent.AppendSystemPrompt, "\r\n") + "\n\n" + note
}

// branchCommitInstructions asks the agent of a session on its own branch to commit each step itself. The person reads
// that branch as a list of commits (docs/mocks/session-commits-first), and only the agent knows why a change was made,
// so a commit it writes says what the runner's end-of-session commit cannot. It is said outright that no one has to
// ask first, because an engine's own rules otherwise hold commits back until the user asks for one. "" for a session
// with no branch of its own. ASCII, like the rest of the instructions it goes out with.
func branchCommitInstructions(wt *Worktree) string {
	if wt == nil || wt.Branch == "" {
		return ""
	}
	return "This session works on its own branch, `" + wt.Branch + "`, and the person reads its work as a list of " +
		"commits. Commit each logical step when it is done, without being asked: a subject that says what changed and " +
		"a body that says why in a sentence or two. Whatever is left uncommitted is " +
		"saved when the session ends, under a generic message."
}

// instructionAgent is the session's agent as an engine's instructions are built from it: its appended prompt is
// the session's (appendSystemPrompt).
func (s *ClaimedSession) instructionAgent() AgentExecConfig {
	agent := s.Agent
	agent.AppendSystemPrompt = s.appendSystemPrompt()
	return agent
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
func orbitCLIAllowedTools(executable string, allowOrchestration, allowBrowser bool) []string {
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
			// Off means absent (browser_tools.go): a session spawned with the browser off is pre-approved nothing of it.
			if cli.browser && !allowBrowser {
				continue
			}
			// browser_request_sign_in is the Orbit Cloud runner's sessions' only (browser_tools.go).
			if cli.tool == browserRequestSignInTool && !onOrbitCloudRunner() {
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
	// browser: one of the Orbit Cloud browser's commands, which exist only while its switch is on.
	browser bool
	tool    string
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
			browser:       op.Object == objectBrowser,
			tool:          op.Tool,
		})
	}
	return commands
})

// Why a command is left out of orbitCLIAllowedTools: every `orbit` command is pre-approved there or
// named in orbitCLIAllowlistExclusions with one of these and its reason
// (TestEveryOrbitCommandIsPreApprovedOrExcludedWithAReason).
const (
	// A person's own act at their own terminal: their login, the machine's registration, credentials.
	allowlistHumanOnly = "human_only"
	// Started by the runner, its service manager or the engine itself, never typed into an agent's shell.
	allowlistHeadlessOnly = "headless_only"
	// Runs a command line of the caller's choosing, so a rule for it would pre-approve any command.
	allowlistArbitraryCommand = "arbitrary_command"
	// Looks after this machine's runner install rather than calling Orbit: not a catalogue operation.
	allowlistRunnerLocal = "runner_local"
)

type orbitCLIAllowlistExclusion struct {
	kind, reason string
}

// orbitCLIAllowlistExclusions are the `orbit` commands outside the operation catalogue, by their first
// word, and why none is pre-approved. The catalogue's own human-only commands (HeadlessOnly) are
// excluded by orbitCLICommands and carry their catalogue reason (catalogMCPExemptions); `capabilities`
// is pre-approved only as `capabilities --json`.
var orbitCLIAllowlistExclusions = map[string]orbitCLIAllowlistExclusion{
	"register":      {allowlistHumanOnly, "registers this machine as a runner, approved in a person's browser"},
	"unregister":    {allowlistHumanOnly, "deletes this runner and its local config"},
	"token":         {allowlistHumanOnly, "mints, lists and revokes credentials for headless processes: a credential is the owner's to hand out"},
	"terminal":      {allowlistHumanOnly, "approves or signs out a person's terminal in the Orbit app"},
	"resume":        {allowlistHumanOnly, "reopens a session in the interactive Orbit terminal client"},
	"host":          {allowlistHumanOnly, "sets the machine up for runners, as root, once per host"},
	"upgrade":       {allowlistHumanOnly, "force-reinstalls the runner binary the session itself runs on"},
	"run":           {allowlistHeadlessOnly, "the runner loop: the service manager starts it"},
	"hostd":         {allowlistHeadlessOnly, "the machine broker: systemd starts it"},
	"mcp":           {allowlistHeadlessOnly, "the MCP server the engine starts from its own configuration, never through the shell"},
	"hook":          {allowlistHeadlessOnly, "the engine's hook entry point, run by the engine on its own events"},
	"engine-update": {allowlistRunnerLocal, "updates this machine's coding-engine CLIs"},
	"status":        {allowlistRunnerLocal, "shows this directory's runner status; not an Orbit operation"},
	"doctor":        {allowlistRunnerLocal, "checks this machine's engine install and sign-in; not an Orbit operation"},
	"version":       {allowlistRunnerLocal, "prints the binary's version, which `capabilities --json` already carries as cliVersion"},
	"secret":        {allowlistArbitraryCommand, "`secret exec NAME -- COMMAND` runs COMMAND, so each run stays with the engine's own permission check"},
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
func appendClaudeAgentInstructionArgs(args []string, agent AgentExecConfig, shape SessionShape) []string {
	// The raw absolute path remains safe for direct exec/MCP configuration. Only
	// inject and auto-allow the CLI when it is also unambiguous in Claude's
	// comma-separated Bash(...) permission grammar.
	shape.CLI = orbitCLIPermissionExecutable(shape.CLI)
	if agent.SystemPrompt != "" {
		args = append(args, "--system-prompt", agent.SystemPrompt)
	}
	if appendPrompt := withOrbitInstructions(agent.AppendSystemPrompt, claudeOrbitInstructions(shape)); appendPrompt != "" {
		args = append(args, "--append-system-prompt", appendPrompt)
	}
	allowed := agent.AllowedTools
	// A scheduled CHECK_ONLY run does not get the CLI: it reads Orbit through the tools the claim allows, and its
	// deny list names this executable (schedule_check_only.go).
	if !agent.ScheduledCheckOnly {
		allowed = appendUnique(allowed, orbitCLIAllowedTools(shape.CLI, shape.Orchestration, shape.Browser)...)
	}
	if len(allowed) > 0 {
		args = append(args, "--allowedTools", strings.Join(allowed, ","))
	}
	return args
}

// claudeOrbitInstructions is Orbit's own text in Claude Code's --append-system-prompt for this shape: "" when the CLI
// path cannot be printed into it.
func claudeOrbitInstructions(shape SessionShape) string {
	shape.CLI = orbitCLIPermissionExecutable(shape.CLI)
	return compose(shape, claudeCodeProfile).System
}
