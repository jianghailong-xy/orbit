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
func orbitCLIInstructions(executable string) string {
	executable = orbitCLIInstructionExecutable(executable)
	if executable == "" {
		return ""
	}
	command := shellQuote(executable)
	return "Orbit CLI is available in this session at `" + command + "`. Run `" + command + " capabilities --json` to discover the commands currently available, then execute the returned argv with that exact absolute path. Prefer native `mcp__orbit__*` tools when present. Use `--json` output for Orbit CLI commands. Do not run `" + command + " mcp` directly."
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

func orbitCLIAllowedTools(executable string) []string {
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
		for _, action := range []string{"list", "get", "create", "update", "start", "comment"} {
			rules = append(rules, "Bash("+command+" task "+action+" *)")
		}
		for _, action := range []string{"list", "create"} {
			rules = append(rules, "Bash("+command+" task-list "+action+" *)")
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
// the owner's tool policy. Only the resolved executable's Phase 1 command
// prefixes are added; arbitrary orbit subcommands and PATH-resolved binaries do
// not become approval-free.
func appendClaudeAgentInstructionArgs(args []string, agent AgentExecConfig, executable string) []string {
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
	allowed := appendUnique(agent.AllowedTools, orbitCLIAllowedTools(executable)...)
	if len(allowed) > 0 {
		args = append(args, "--allowedTools", strings.Join(allowed, ","))
	}
	return args
}
