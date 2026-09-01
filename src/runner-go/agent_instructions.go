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
// Kept ASCII and roughly a paragraph long: codex carries this as a single
// application-context value capped at 1,000 tokens (see codexAgentAdditionalContext).
func orbitCLIInstructions(executable string) string {
	executable = orbitCLIInstructionExecutable(executable)
	if executable == "" {
		return ""
	}
	command := shellQuote(executable)
	return "Orbit tasks are the user's durable record: visible in Orbit's UI, outliving this session. " +
		"Any built-in todo or plan tool you have is private scratch the user never sees: fine for tracking your own steps, " +
		"but anything the user asked you to record, or follow-up work they should see, MUST go through an Orbit tool. " +
		"Never claim a task was created or updated unless an Orbit tool returned its id.\n\n" +
		"Before offering or creating an Orbit task for newly discovered work, judge its scope. If it spans dependent phases, " +
		"will need more than this session or context window, or needs several agents, you MUST proactively propose recording it " +
		"as an Orbit Project, explain why, and wait for an explicit yes before calling project_create. A single reported bug can " +
		"still have that shape. Do not offer or create a standalone task as a substitute while waiting. After yes, create the " +
		"Project from this same session so the conversation becomes its coordinator; do not switch or open a session for it.\n\n" +
		"Write to Orbit with the `mcp__orbit__*` tools when your tool list has them: their inputs are schema-checked and " +
		"they need no shell. The Orbit CLI at `" + command + "` is for shell composition (pipes, scripts, bulk input) and " +
		"work that outlives this turn. Inside a session both attribute the task to you, so either is fine; the CLI needs " +
		"`" + command + " capabilities --json` first to discover its commands, then run the returned argv with that exact " +
		"absolute path. Use `--json` output. Do not run `" + command + " mcp` directly."
}

func withOrbitCLIInstructions(configured, executable string) string {
	orbit := orbitCLIInstructions(executable)
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
		for _, action := range []string{"list", "get", "create", "update", "delete", "start", "comment"} {
			rules = append(rules, "Bash("+command+" task "+action+" *)")
		}
		// Every task-list subcommand the CLI has. An action missing here is pre-approved for
		// nobody: the agent hits a permission prompt for a command `capabilities --json` just
		// told it to run — which is what happened to get/update when they were added.
		for _, action := range []string{"list", "create", "get", "update", "delete"} {
			rules = append(rules, "Bash("+command+" task-list "+action+" *)")
		}
		// Every project verb the CLI has. An action missing here is pre-approved for nobody: the
		// agent hits a permission prompt for a command `capabilities --json` just told it to run.
		// Still enumerated rather than `project *`, so a verb added later is a decision somebody
		// makes here rather than one it inherits.
		for _, action := range []string{"get", "create", "update", "delete"} {
			rules = append(rules, "Bash("+command+" project "+action+" *)")
		}
		if allowOrchestration {
			for _, action := range []string{"create", "list", "search", "get", "send", "interrupt", "merge", "end", "complete", "delete"} {
				rules = append(rules, "Bash("+command+" session "+action+" *)")
			}
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
func appendClaudeAgentInstructionArgs(args []string, agent AgentExecConfig, executable string, allowOrchestration bool) []string {
	// The raw absolute path remains safe for direct exec/MCP configuration. Only
	// inject and auto-allow the CLI when it is also unambiguous in Claude's
	// comma-separated Bash(...) permission grammar.
	executable = orbitCLIPermissionExecutable(executable)
	if agent.SystemPrompt != "" {
		args = append(args, "--system-prompt", agent.SystemPrompt)
	}
	if appendPrompt := withOrbitCLIInstructions(agent.AppendSystemPrompt, executable); appendPrompt != "" {
		args = append(args, "--append-system-prompt", appendPrompt)
	}
	allowed := appendUnique(agent.AllowedTools, orbitCLIAllowedTools(executable, allowOrchestration)...)
	if len(allowed) > 0 {
		args = append(args, "--allowedTools", strings.Join(allowed, ","))
	}
	return args
}
