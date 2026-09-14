package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
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

// hookInput is the PreToolUse payload Claude Code writes on the hook's stdin.
type hookInput struct {
	HookEventName string                 `json:"hook_event_name"`
	ToolName      string                 `json:"tool_name"`
	ToolInput     map[string]interface{} `json:"tool_input"`
}

// cmdHookBgGuard reads one hook invocation and writes one decision.
func cmdHookBgGuard(stdin io.Reader, stdout io.Writer) {
	var in hookInput
	// A hook that cannot parse its input must not block the session: allow, and
	// let the fallback path in background.go record that an engine-owned shell
	// happened.
	_ = json.NewDecoder(io.LimitReader(stdin, 1<<20)).Decode(&in)
	_ = json.NewEncoder(stdout).Encode(bgGuardDecision(in))
}

func bgGuardDecision(in hookInput) map[string]interface{} {
	decision, reason := "allow", ""
	switch in.ToolName {
	// Only Bash. run_in_background also appears on sub-agent launches, which are
	// engine-internal work the runner cannot host — denying those would remove a
	// working capability to no end.
	case "Bash":
		if asBool(in.ToolInput["run_in_background"]) {
			decision, reason = "deny", bgGuardDenyReason
		}
	// Every call, whatever it asks for: see bgGuardScheduleWakeupReason.
	case "ScheduleWakeup":
		decision, reason = "deny", bgGuardScheduleWakeupReason
	// The readers for the engine's own background tasks (old names and new). A
	// runner-hosted job is not one, and the id says so — the runner issued that
	// prefix itself, so this is not a guess about who owns what.
	case "BashOutput", "KillShell", "TaskOutput", "TaskStop":
		if strings.HasPrefix(bgGuardTaskID(in.ToolInput), "bgj_") {
			decision, reason = "deny", bgGuardForeignJobReason
		}
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
	default:
		fmt.Fprintf(os.Stderr, "unknown hook: %q (known: bg-guard)\n", name)
		os.Exit(1)
	}
}
