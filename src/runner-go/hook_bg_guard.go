package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
)

// `orbit hook bg-guard` — the PreToolUse hook the runner installs into each
// Claude session's private settings (claude_spawn.go). It is the only mechanism
// in this CLI that can refuse *one shape* of a Bash call: --disallowedTools
// matches on tool name and command prefix and cannot see run_in_background, and
// --permission-prompt-tool is never consulted for the calls the auto permission
// mode classifies itself (most of them).
//
// It is a policy, not a gate. A missing hook script fails OPEN — the native
// background shell simply runs — so nothing here may be load-bearing for
// correctness; what it does is route the agent to the tool that gets it a job
// the engine's death cannot take. The refusal text is the whole mechanism: it
// has to say what to use instead, because the model reads it and retries.
//
// Having no objection is not a yes. Claude Code reads a hook's "allow" as approval, ahead of the
// session's own permission flow, so this hook says it only in the modes that do not ask anyway
// (hookModeSkipsAsking). Anywhere else it stays silent and the call takes that flow: a card in
// Default, Accept Edits and Plan, a refusal in Don't Ask.

const bgGuardDenyReason = "Orbit hosts background work for this session. Bash's run_in_background is" +
	" unavailable here: a shell started that way is a child of this coding-engine process, so" +
	" recycling the engine (idle TTL, memory pressure) kills your build with it. Use" +
	" mcp__orbit__bg_run instead — it takes the same command string, and requires kind:" +
	" \"service\" for something valuable while it runs (dev server, watcher), \"job\" for" +
	" something valuable when it finishes (build, test suite), or \"watch\" for a wait on" +
	" something else (CI, a deploy); with wakeOnExit: true you are woken when it ends, even after" +
	" this engine is recycled. Read its output with" +
	" mcp__orbit__bg_output, stop it with mcp__orbit__bg_kill. To wait for Orbit tasks or sessions, run" +
	" nothing: mcp__orbit__task_await and mcp__orbit__session_await wake you when they finish."

const bgGuardForeignJobReason = "That id belongs to an Orbit runner-hosted background job, which is not in" +
	" this CLI's task registry. Use mcp__orbit__bg_output to read it, mcp__orbit__bg_kill to stop it," +
	" and mcp__orbit__bg_list to see them all."

// ScheduleWakeup keeps its timer inside the engine process: recycling the engine or restarting the
// runner loses the wakeup, a resumed engine never re-arms it, and it does not fire while a Monitor or
// background shell is still running (task 34NGdppVIQ5iLJBaHZ406 checked this call by call). No shape
// of the call is worth letting through — stop:true only ends a loop kept by that same timer — so every
// call is routed to the wakeup the control plane holds.
const bgGuardScheduleWakeupReason = "Orbit holds this session's wakeups on its server. Claude's ScheduleWakeup is" +
	" unavailable here: its timer lives inside this coding-engine process, so recycling the engine (idle TTL," +
	" memory pressure) or restarting the runner loses the wakeup, and it does not fire while a Monitor or a" +
	" background task is still running. Use mcp__orbit__schedule_wakeup instead — the same delaySeconds," +
	" reason and prompt, and stop: true cancels the pending one. When it is due, Orbit starts a turn in this" +
	" session even if this engine is gone by then. To wait for Orbit tasks or sessions, use" +
	" mcp__orbit__task_await or mcp__orbit__session_await, which wake you when they finish."

// CronCreate is the same timer for a loop: its jobs live only in this engine process (its own
// description says so) and fire only while the engine is idle, so a loop kept by it dies with the
// first recycle. The loop the control plane holds (schedule_wakeup with recurring, contract §1) is
// what replaces it, and every call is routed there — a one-shot job (recurring: false) included.
const bgGuardCronCreateReason = "Orbit holds this session's loops on its server. Claude's CronCreate is" +
	" unavailable here: its jobs live only inside this coding-engine process, so recycling the engine (idle TTL," +
	" memory pressure) or restarting the runner loses them, and they fire only while the engine is idle. Use" +
	" mcp__orbit__schedule_wakeup with recurring: true instead — everySeconds for the interval (60 to 86400" +
	" seconds), prompt for what each tick's turn is to do, and until (ISO 8601) for when the loop ends: 7 days" +
	" out when omitted, 30 days out at most. Orbit's server schedules every tick itself, even after this engine" +
	" is gone, so nothing has to renew it each turn; stop: true ends it. For a single wakeup, leave recurring out" +
	" and pass delaySeconds and reason. To wait for Orbit tasks or sessions, use" +
	" mcp__orbit__task_await or mcp__orbit__session_await, which wake you when they finish."

// A poll of Orbit's own work is refused wherever it is started from — a Bash call in the turn, a background
// shell, a Monitor, a runner-hosted job — because the wait it keeps is one the control plane holds for nothing:
// task_await and session_await ask it to. Only while Watch is on for the session (watch_rollout.go): with
// Watch off there is nothing to route the wait to, and polling is what waiting was before watches.
const bgGuardOrbitPollReason = "This command waits on Orbit's own work by polling it: it reads an Orbit task or session" +
	" and sleeps between reads. Orbit holds that wait on its server instead, so nothing has to keep polling: call" +
	" mcp__orbit__task_await for tasks or mcp__orbit__session_await for sessions (mcp__orbit__watch_create for other" +
	" conditions), then end your turn. Orbit starts a turn in this session when the condition holds, even after this" +
	" engine is recycled or the runner restarts. A single read without a wait (task_get, session_get) is fine, and" +
	" real background work still goes to mcp__orbit__bg_run: builds, test suites, dev servers, and waits on something" +
	" outside Orbit such as CI."

// A poll of Orbit's work, as one command shows it: a read of an Orbit task or session, and a wait between reads.
// The reads are the CLI's get and list of tasks, sessions, task lists and projects, the REST routes behind them,
// and SQL on Orbit's tables through psql; the wait is a sleep, a `watch -n` or Python's time.sleep. Both halves
// have to be in the command itself. A script run by its path is not opened, because what an arbitrary script
// does is not something a hook can read reliably, and a single read is not a wait (docs/watch-rollout.md §4).
var (
	orbitWorkReadPattern  = regexp.MustCompile(`(?i)\borbit\b[^|;&\n]*\s(?:task|session|tasklist|task-list|project)\s+(?:get|list)\b|/api/(?:runner/)?(?:tasks|sessions)\b`)
	orbitSQLClientPattern = regexp.MustCompile(`(?i)\bpsql\b`)
	orbitSQLReadPattern   = regexp.MustCompile(`(?i)\b(?:from|join)\s+"?(?:task|session|conversation_turn|task_progress)\b`)
	pollDelayPattern      = regexp.MustCompile(`(?i)\bsleep\s+[0-9$({"']|time\.sleep\s*\(|\bwatch\s+(?:-[a-z]+\s+)*-n\b`)
)

// pollsOrbitWork reports whether a tool input's command polls Orbit's own work.
func pollsOrbitWork(input map[string]interface{}) bool {
	command, _ := input["command"].(string)
	if !pollDelayPattern.MatchString(command) {
		return false
	}
	if orbitWorkReadPattern.MatchString(command) {
		return true
	}
	return orbitSQLClientPattern.MatchString(command) && orbitSQLReadPattern.MatchString(command) &&
		strings.Contains(strings.ToLower(command), "orbit")
}

// bgGuardAwaitAdvice is a refusal as a session with Watch reads it, and without its closing advice to await
// Orbit's work in a session spawned with Watch off, which has no await tool to be pointed at.
func bgGuardAwaitAdvice(reason string, watches bool) string {
	if watches {
		return reason
	}
	if cut := strings.Index(reason, " To wait for Orbit tasks or sessions"); cut >= 0 {
		return reason[:cut]
	}
	return reason
}

// subagentAsksNobodyReason is what a SubAgent is told when it tries to ask the user a question or to have a plan
// approved (docs/subagent-design.md §5.3): nobody is there to answer it, so its question goes into its result.
const subagentAsksNobodyReason = "You are a SubAgent, so you cannot ask the user anything or have a plan approved:" +
	" no person reads your questions. Decide sensibly and carry on, or stop and put your question (or your plan)" +
	" in your result, so the agent that sent you can answer it or ask the user."

// isSubagentEngine reports whether this process runs inside an engine started as a SubAgent.
func isSubagentEngine() bool {
	return strings.TrimSpace(os.Getenv(envSubagentRunID)) != ""
}

// hookInput is the PreToolUse payload Claude Code writes on the hook's stdin. PermissionMode is the mode
// the CLI is in at this call, so a change of mode during the session counts from the next call.
type hookInput struct {
	HookEventName  string                 `json:"hook_event_name"`
	ToolName       string                 `json:"tool_name"`
	ToolInput      map[string]interface{} `json:"tool_input"`
	PermissionMode string                 `json:"permission_mode"`
}

// hookModeSkipsAsking reports whether a session's mode already lets a call run without asking anybody,
// so that this hook's "allow" takes nothing away from it. In Auto it also keeps Claude Code's classifier
// out of a call this hook has no objection to: a provider's endpoint that cannot give the classifier a
// verdict would otherwise block every command. An unknown or missing mode is not one of them.
func hookModeSkipsAsking(mode string) bool {
	return mode == "auto" || mode == "bypassPermissions"
}

// cmdHookBgGuard reads one hook invocation and writes one decision.
func cmdHookBgGuard(stdin io.Reader, stdout io.Writer) {
	var in hookInput
	// A hook that cannot parse its input must not block the session: it gives no verdict, and
	// the fallback path in background.go records that an engine-owned shell happened.
	_ = json.NewDecoder(io.LimitReader(stdin, 1<<20)).Decode(&in)
	_ = json.NewEncoder(stdout).Encode(bgGuardDecision(in))
}

// bgGuardDecision is what the hook writes for one call: a refusal with its reason, an allow in a mode
// that does not ask, or no verdict at all.
func bgGuardDecision(in hookInput) map[string]interface{} {
	decision, reason := "allow", ""
	watches := watchesEnabledFromEnv()
	switch in.ToolName {
	// A SubAgent asks nobody, in every mode: a hook is consulted where the permission prompt is not (Auto,
	// Bypass). Anywhere else this hook has no say about them — an "allow" would answer a person's question
	// with nothing.
	case "AskUserQuestion", "ExitPlanMode":
		if !isSubagentEngine() {
			return map[string]interface{}{}
		}
		decision, reason = "deny", subagentAsksNobodyReason
	// Only Bash. run_in_background also appears on sub-agent launches, which are
	// engine-internal work the runner cannot host — denying those would remove a
	// working capability to no end.
	case "Bash":
		switch {
		// First: a poll of Orbit's work in the background is sent to the wait itself, not on to bg_run.
		case watches && pollsOrbitWork(in.ToolInput):
			decision, reason = "deny", bgGuardOrbitPollReason
		case asBool(in.ToolInput["run_in_background"]):
			decision, reason = "deny", bgGuardAwaitAdvice(bgGuardDenyReason, watches)
		}
	// Both keep something running, which is how a poll outlives the call that started it.
	case "Monitor", "mcp__orbit__bg_run":
		if watches && pollsOrbitWork(in.ToolInput) {
			decision, reason = "deny", bgGuardOrbitPollReason
		}
		// The runner's gate refuses it too (background_gate.go). Said here as well so that Claude Code's
		// Plan does not first ask a person about a call that would then be refused.
		if decision == "allow" && in.ToolName == "mcp__orbit__bg_run" && in.PermissionMode == "plan" {
			decision, reason = "deny", bgGatePlanRefusal
		}
	// Every call, whatever it asks for: see bgGuardScheduleWakeupReason.
	case "ScheduleWakeup":
		decision, reason = "deny", bgGuardAwaitAdvice(bgGuardScheduleWakeupReason, watches)
	// Every call too: see bgGuardCronCreateReason.
	case "CronCreate":
		decision, reason = "deny", bgGuardAwaitAdvice(bgGuardCronCreateReason, watches)
	// The readers for the engine's own background tasks (old names and new). A
	// runner-hosted job is not one, and the id says so — the runner issued that
	// prefix itself, so this is not a guess about who owns what.
	case "BashOutput", "KillShell", "TaskOutput", "TaskStop":
		if strings.HasPrefix(bgGuardTaskID(in.ToolInput), "bgj_") {
			decision, reason = "deny", bgGuardForeignJobReason
		}
	}
	if decision == "allow" && !hookModeSkipsAsking(in.PermissionMode) {
		return map[string]interface{}{}
	}
	out := map[string]interface{}{
		"hookEventName":      "PreToolUse",
		"permissionDecision": decision,
	}
	if reason != "" {
		out["permissionDecisionReason"] = reason
	}
	return map[string]interface{}{"hookSpecificOutput": out}
}

// bgGuardTaskID reads whichever spelling of the id this CLI version sends.
func bgGuardTaskID(input map[string]interface{}) string {
	for _, key := range []string{"task_id", "bash_id", "shell_id", "taskId", "shellId"} {
		if s, ok := input[key].(string); ok && s != "" {
			return s
		}
	}
	return ""
}

func asBool(v interface{}) bool {
	switch value := v.(type) {
	case bool:
		return value
	case string:
		return value == "true"
	}
	return false
}

// cmdHook dispatches `orbit hook <name>`. Not in `orbit help`: like `orbit mcp`,
// it is a wire between the runner and the engine, not something a person types.
func cmdHook(args []string) {
	name := ""
	if len(args) > 0 {
		name = args[0]
	}
	switch name {
	case "bg-guard":
		cmdHookBgGuard(os.Stdin, os.Stdout)
	// Antigravity's approval gate (antigravity_approval.go). Unlike bg-guard these fail CLOSED: agy
	// refuses a tool call whose hook exits non-zero.
	case "antigravity-approval":
		os.Exit(cmdHookAntigravityApproval(args[1:], os.Stdin, os.Stdout))
	case "antigravity-heartbeat":
		os.Exit(cmdHookAntigravityHeartbeat(args[1:], os.Stdin, os.Stdout))
	default:
		fmt.Fprintf(os.Stderr, "unknown hook: %q (known: bg-guard, antigravity-approval, antigravity-heartbeat)\n", name)
		os.Exit(1)
	}
}
