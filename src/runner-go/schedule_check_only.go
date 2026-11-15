package main

// A scheduled CHECK_ONLY run on Claude Code (docs/scheduled-tasks-design.md §6.2; the claim's agent.scheduledCheckOnly).
// It runs in Default, where only a shell command may ask the owner. The control plane hands it its allow and deny
// lists; the runner closes what only it can:
//
//   - Orbit's own tools: Claude Code asks about an Orbit tool its allow rules do not cover, and answerOrbitToolPrompt
//     would allow any catalogue tool outside Plan. In such a run every such ask is refused, so a tool on neither of
//     the server's lists (a runner newer than its server) does not run unasked either.
//   - the Orbit CLI: the runner does not allow its own executable for such a run, and denies it anchored at the
//     start of the command, instead of the server's `*/orbit *` patterns, which also refused `ls /root/orbit`. A
//     disguised form (a bare `orbit` on PATH, `env`, a copy) is a shell command like any other: it asks, and the card
//     shows the command.
//   - Claude Code's own settings files: with no --setting-sources, permissions.allow in the checkout's
//     .claude/settings.local.json and in the user's settings ran commands unasked (measured on 2.1.325,
//     docs/scheduled-tasks-engine-modes.md §10). Such a run loads none of them; the runner's own --settings file
//     still applies.

import (
	"os"
	"strings"
)

// envScheduledCheckOnly marks the engine of a scheduled CHECK_ONLY run on Claude Code, for `orbit mcp`.
const envScheduledCheckOnly = "ORBIT_SCHEDULED_CHECK_ONLY"

func scheduledCheckOnlyEnv(on bool) string {
	if on {
		return "1"
	}
	return "0"
}

// scheduledCheckOnlyFromEnv reads ORBIT_SCHEDULED_CHECK_ONLY: only an explicit 1 is such a run.
func scheduledCheckOnlyFromEnv() bool {
	return strings.TrimSpace(os.Getenv(envScheduledCheckOnly)) == "1"
}

// checkOnlyOrbitToolRefusal is what the engine reads when it asks to use an Orbit tool in such a run.
const checkOnlyOrbitToolRefusal = "Not run: this is a check-only scheduled run, and this Orbit tool is not one it " +
	"may use. Nothing was written. Read with the tools you have, and say in your report what you could not check."

// serverOrbitCLIDenials are the control plane's deny rules for the Orbit CLI in such a run
// (apiserver schedule-access.ts CHECK_ONLY_CLAUDE_DISALLOWED_TOOLS), written for a runner that does not anchor them.
var serverOrbitCLIDenials = map[string]bool{"Bash(*/orbit *)": true, "Bash('*/orbit' *)": true}

// checkOnlyDisallowedTools is such a run's deny list: the claim's, with the server's CLI patterns replaced by this
// runner's own executable, anchored at the start of the command in both quoting forms. An executable the rule
// grammar cannot carry keeps the server's patterns.
func checkOnlyDisallowedTools(configured []string, executable string) []string {
	exe := orbitCLIPermissionExecutable(executable)
	if exe == "" {
		return configured
	}
	out := make([]string, 0, len(configured)+4)
	for _, rule := range configured {
		if !serverOrbitCLIDenials[rule] {
			out = append(out, rule)
		}
	}
	for _, form := range []string{exe, shellQuote(exe)} {
		out = append(out, "Bash("+form+")", "Bash("+form+" *)")
	}
	return out
}
