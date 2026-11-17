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
//     still applies, and carries what of the user's settings.json the engine needs to reach Anthropic the way the
//     region check assumed: its env (a proxy, a base URL, a key) and its credential helpers, never its permissions.
//   - Claude Code's other built-in tools: such a run is offered only checkOnlyBuiltinTools.
//
// The runner advertises claudeScheduledCheckOnlyAsksCapabilityV1; the control plane hands Default only to such a
// runner, and runs the check in Don't Ask with S2b's lists on any other.

import (
	"encoding/json"
	"os"
	"path/filepath"
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

// checkOnlyBuiltinTools is the whole of Claude Code's built-in tool set such a run is started with (--tools): reading,
// the shell (every command it does not judge read-only asks), fetching, and loading the deferred Orbit tools. Every
// other built-in is not offered, so none of those that act without a permission ask (EnterWorktree created a git
// worktree, CronCreate scheduled a prompt: measured on 2.1.325, docs/scheduled-tasks-engine-modes.md §10) can run.
// Orbit's tools come through MCP and are not governed by this list.
var checkOnlyBuiltinTools = []string{"Bash", "Read", "Grep", "Glob", "WebFetch", "WebSearch", "ToolSearch"}

// claudeScheduledCheckOnlyAsksCapabilityV1 declares that this runner closes the above for a scheduled CHECK_ONLY run
// on Claude Code (apiserver schedule-access.ts CLAUDE_SCHEDULED_CHECK_ONLY_ASKS_V1).
const claudeScheduledCheckOnlyAsksCapabilityV1 = "claude-scheduled-check-only-asks/v1"

// checkOnlyInheritedSettingKeys are the user settings.json keys such a run keeps through the runner's --settings file:
// how the engine reaches and authenticates to its endpoint. Never permissions, hooks or anything else.
var checkOnlyInheritedSettingKeys = []string{"env", "apiKeyHelper", "awsAuthRefresh", "awsCredentialExport"}

// checkOnlyUserSettings reads those keys from the settings.json in the config dir the session's engine runs on (the
// account slot's CLAUDE_CONFIG_DIR, else ~/.claude): nil when the file is missing or says none of them.
func checkOnlyUserSettings(agentEnv map[string]string) map[string]json.RawMessage {
	dir, err := claudeSessionAccountDir(agentEnv, "")
	if err != nil {
		return nil
	}
	b, err := os.ReadFile(filepath.Join(dir, "settings.json"))
	if err != nil {
		return nil
	}
	var all map[string]json.RawMessage
	if json.Unmarshal(b, &all) != nil {
		return nil
	}
	out := map[string]json.RawMessage{}
	for _, key := range checkOnlyInheritedSettingKeys {
		if v, ok := all[key]; ok {
			out[key] = v
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// mergeIntoSettingsFile adds keys to the runner's own settings file, keeping every key the runner wrote.
func mergeIntoSettingsFile(path string, extra map[string]json.RawMessage) error {
	if len(extra) == 0 {
		return nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var settings map[string]json.RawMessage
	if err := json.Unmarshal(b, &settings); err != nil {
		return err
	}
	for key, value := range extra {
		if _, own := settings[key]; !own {
			settings[key] = value
		}
	}
	out, err := json.Marshal(settings)
	if err != nil {
		return err
	}
	return os.WriteFile(path, out, 0o644)
}
