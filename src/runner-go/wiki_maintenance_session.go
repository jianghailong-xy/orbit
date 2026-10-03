package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// A Wiki maintenance session's clean start (contracts/wiki.contract.json `maintenance.run`, design §8.2).
//
// WHAT THE SERVER SAYS. A session whose task is in a space's hidden «Wiki maintenance» list is claimed with
// `wikiMaintenance`: the space, the provider and workspace the space's maintenance settings pin it to, 120
// model turns, the tools it may not have, and cleanStart. Everything else about how it is started is this
// file's: a runner that sees cleanStart starts Claude Code as the maintenance run needs it, not as its
// workspace starts every other session.
//
// WHY CLEAN (project instructions, "本地模型与干净 Claude Code"). An Orbit session's Claude Code carries some
// sixty thousand tokens into every request — its system prompt, fifty-odd MCP tools, the memory index and
// CLAUDE.md — which on the local model is a minute and a half of prefill before a word is read, every turn.
// A maintenance run needs a shell for `orbit wiki …` and a way to say how it went. So: `--bare` (no hooks,
// memory, CLAUDE.md or plugins), `--setting-sources ''` (a workspace's .claude/settings.json is read even
// under --bare, and its env block outranks the provider's), an empty HOME and CLAUDE_CONFIG_DIR of the
// session's own, Bash as the only built-in tool, and the orbit MCP server alone (`--strict-mcp-config`),
// serving only the three task tools a run reports with. What it may not do is said twice — left out of
// the tools, and named in --disallowedTools — so a CLI that ignored the one still meets the other.
//
// THE TOKEN GOES THROUGH apiKeyHelper. A bare run authenticates with ANTHROPIC_API_KEY, sent as x-api-key
// alone, which the local vLLM answers 401. An apiKeyHelper's output goes out as a Bearer token, so the
// helper prints the ANTHROPIC_AUTH_TOKEN the provider injected, and the key variable never reaches the
// engine. And thinking is off: Claude Code sends a model it does not know `effort: high` and adaptive
// thinking of its own accord, which CLAUDE_CODE_EFFORT_LEVEL=unset and MAX_THINKING_TOKENS=0 take out.
//
// A RUN CUT SHORT FAILED. The CLI ends a turn that reached --max-turns with `error_max_turns`: the turn is
// FAILED like any error, and the runner says so on the space's cursor as `truncated` — one more of the
// space's consecutive failures, with the cursor no further than past the ops the run had recorded (criterion
// 3, revision 4), and where it was when it was cut short before that — because the run itself can no longer
// say anything.

// wikiMaintenanceRunV1 is contracts/wiki.contract.json `maintenance.run.capability`: declared on every call
// (runnerCapabilitiesV1), it is what gets this runner handed maintenance sessions at all.
const wikiMaintenanceRunV1 = "wiki-maintenance-run/v1"

// WikiMaintenanceRun is `wikiMaintenance` on a claimed or reclaimed session.
type WikiMaintenanceRun struct {
	SpaceID           string   `json:"spaceId"`
	WorkspaceID       string   `json:"workspaceId"`
	Provider          string   `json:"provider"`
	ProviderFallbacks []string `json:"providerFallbacks"`
	MaxTurns          int      `json:"maxTurns"`
	DisallowedTools   []string `json:"disallowedTools"`
	CleanStart        bool     `json:"cleanStart"`
	// Refusal is why the run may not start: it ends FAILED with this, and no engine is started.
	Refusal string `json:"refusal,omitempty"`

	// The session's own HOME and CLAUDE_CONFIG_DIR, made by prepareWikiMaintenanceStart. Runner-internal.
	home, config string
}

// wikiMaintenanceTools is contracts/wiki.contract.json `maintenance.run.cleanStart.mcpTools`: what the orbit
// MCP server serves a maintenance run — reading its task, and the two ways it reports. Not task_update: its
// schema alone is some four thousand tokens on every request, and a run's outcome is its task's
// acceptance command's to decide, not the run's.
var wikiMaintenanceTools = []string{"task_get", "task_comment", "task_progress_report"}

// wikiMaintenanceBuiltinTools is the only built-in tool a maintenance run has: the shell `orbit wiki` runs in.
const wikiMaintenanceBuiltinTools = "Bash"

// wikiMaintenanceHelper is the whole of the settings a clean start is given.
const wikiMaintenanceHelper = `{"apiKeyHelper":"printenv ANTHROPIC_AUTH_TOKEN"}`

// wikiMaintenanceEnvPass is what of the runner's own environment a clean start is handed: what a process
// needs to run at all. wikiMaintenanceProviderEnv is what of the session's: the endpoint the provider
// injected and how to talk to it. Nothing else of either reaches the engine — not the runner's
// ANTHROPIC_API_KEY or CLAUDE_CODE_*, not the workspace's own variables.
var (
	wikiMaintenanceEnvPass = []string{
		"PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR",
		"SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
		"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
	}
	wikiMaintenanceProviderEnv = []string{
		"ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL", "ANTHROPIC_CUSTOM_HEADERS",
		"CLAUDE_CODE_MAX_CONTEXT_TOKENS",
	}
)

// wikiMaintenanceCleanStart reports whether this session is to be started clean.
func (s *ClaimedSession) wikiMaintenanceCleanStart() bool {
	return s != nil && s.WikiMaintenance != nil && s.WikiMaintenance.CleanStart
}

// wikiMaintenanceRefusal is why a maintenance run may not start here, or "": the server's refusal, or a
// runtime other than Claude Code, whose clean start and disallowedTools the run relies on.
func wikiMaintenanceRefusal(job *ClaimedSession) string {
	run := job.WikiMaintenance
	switch {
	case run == nil:
		return ""
	case run.Refusal != "":
		return run.Refusal
	case runtimeProvider(job) != providerClaude:
		return "This Wiki maintenance run did not start: it runs on the Claude Code runtime only, and this session " +
			"was dispatched on " + runtimeProvider(job) + "."
	}
	return ""
}

// wikiMaintenanceSystemPrompt is the whole system prompt of a maintenance run: what it is for, and how it
// says how it went. The command itself, and what it does, belong to `orbit wiki maintain`.
func wikiMaintenanceSystemPrompt(orbitExe string, maxTurns int) string {
	cli := "the Orbit CLI"
	if exe := orbitCLIInstructionExecutable(orbitExe); exe != "" {
		cli = "the Orbit CLI at `" + shellQuote(exe) + "` (run it by that path)"
	}
	return "You are a Wiki maintenance run of Orbit: an unattended run that keeps one space's wiki up to date " +
		"from what happened in it since the last run, or drafts the space's plan. Your task says which space, and which " +
		"one command. Do exactly this: run the command your task names — `orbit wiki maintain`, or `orbit wiki plan " +
		"draft` or `orbit wiki plan revise` — with " + cli + " as your task says, with the Bash tool and `timeout: " +
		strconv.FormatInt(wikiMaintainRunBudget.Milliseconds(), 10) + "`, never a shorter one; it does the whole " +
		"run and prints what it did. Then report it: task_progress_report for where the run ended, and one task_comment " +
		"with the outcome, what it printed of what was done, and the token spend it printed; if it failed, its last " +
		"lines. Run nothing else, write no files, and do not retry a failed run more than once; a command the Bash tool " +
		"came back from before it ended — it timed out, or was cut off — is never run again: report what it printed " +
		"up to there. You have " +
		strconv.Itoa(maxTurns) + " turns; a run cut short by them counts as failed."
}

// wikiMaintenanceDirs are the session's own HOME and CLAUDE_CONFIG_DIR, beside its other scratch.
func wikiMaintenanceDirs(scratchDir string) (home, config string) {
	return filepath.Join(scratchDir, "clean-home"), filepath.Join(scratchDir, "clean-config")
}

// prepareWikiMaintenanceStart makes the session's HOME and CLAUDE_CONFIG_DIR — empty but for the onboarding
// mark when first made, and the session's own transcript after that — and points the session's environment
// at the config directory, so everything that asks where this session's conversation lives (the rebuild
// before a --resume, the session's meta) asks the clean one.
func prepareWikiMaintenanceStart(job *ClaimedSession, scratchDir string) error {
	home, config := wikiMaintenanceDirs(scratchDir)
	for _, dir := range []string{home, config} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
		mark := filepath.Join(dir, ".claude.json")
		if _, err := os.Stat(mark); errors.Is(err, os.ErrNotExist) {
			if err := os.WriteFile(mark, []byte(`{"hasCompletedOnboarding":true}`), 0o600); err != nil {
				return err
			}
		}
	}
	job.WikiMaintenance.home, job.WikiMaintenance.config = home, config
	env := make(map[string]string, len(job.Agent.Env)+1)
	for k, v := range job.Agent.Env {
		env[k] = v
	}
	env["CLAUDE_CONFIG_DIR"] = config
	job.Agent.Env = env
	return nil
}

// wikiMaintenanceClaudeArgs is claudeCommandArgs for a maintenance run: the same stream-json transport and
// the same conversation (--session-id, then --resume), started clean.
func wikiMaintenanceClaudeArgs(job *ClaimedSession, scratchDir string, firstSpawn bool) []string {
	a, run := job.Agent, job.WikiMaintenance
	orbitExe := orbitCLIExecutable()
	args := []string{
		"-p",
		"--bare",
		"--setting-sources", "",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--include-partial-messages",
		"--replay-user-messages",
		"--verbose",
		"--model", a.Model,
		"--permission-mode", a.PermissionMode,
		"--tools", wikiMaintenanceBuiltinTools,
		"--system-prompt", wikiMaintenanceSystemPrompt(orbitExe, run.MaxTurns),
		"--max-turns", strconv.Itoa(run.MaxTurns),
	}
	disallowed := withBuiltinTaskToolsDisallowed(appendUnique(a.DisallowedTools, run.DisallowedTools...))
	args = append(args, "--disallowedTools", strings.Join(disallowed, ","))
	// Pre-approved, because nobody is asked: the three tools the run reports with, and the `orbit wiki`
	// commands the platform pre-approves for every session — no other command of the CLI.
	allowed := []string{}
	for _, tool := range wikiMaintenanceTools {
		allowed = append(allowed, "mcp__orbit__"+tool)
	}
	for _, rule := range orbitCLIAllowedTools(orbitCLIPermissionExecutable(orbitExe), false) {
		if strings.Contains(rule, " wiki ") {
			allowed = append(allowed, rule)
		}
	}
	args = append(args, "--allowedTools", strings.Join(allowed, ","))
	servers := map[string]interface{}{}
	if orbitExe != "" {
		servers["orbit"] = map[string]interface{}{
			"command": orbitExe,
			"args":    []string{"mcp"},
			"env":     map[string]string{envMCPTools: strings.Join(wikiMaintenanceTools, ",")},
			"timeout": mcpToolTimeoutMs,
		}
	}
	mcpPath := filepath.Join(scratchDir, "mcp.json")
	b, _ := json.Marshal(map[string]interface{}{"mcpServers": servers})
	_ = os.WriteFile(mcpPath, b, 0o644)
	args = append(args, "--strict-mcp-config", "--mcp-config", mcpPath)
	settings := filepath.Join(scratchDir, "settings.json")
	if err := os.WriteFile(settings, []byte(wikiMaintenanceHelper), 0o600); err == nil {
		args = append(args, "--settings", settings)
	}
	if firstSpawn {
		args = append(args, "--session-id", job.SessionUUID)
	} else {
		args = append(args, "--resume", job.SessionUUID)
	}
	return args
}

// wikiMaintenanceEnv is a clean start's whole environment, built from nothing (see wikiMaintenanceEnvPass).
// The session context is what the orbit MCP server and the `orbit` CLI need to act for this session, and
// ORBIT_HOME is said outright: under the clean HOME they would otherwise look for the runner's
// configuration in the wrong place.
func wikiMaintenanceEnv(job *ClaimedSession) []string {
	run := job.WikiMaintenance
	env := []string{
		"HOME=" + run.home,
		"CLAUDE_CONFIG_DIR=" + run.config,
		"CLAUDE_CODE_EFFORT_LEVEL=unset",
		"MAX_THINKING_TOKENS=0",
		"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
		"DISABLE_AUTOUPDATER=1",
		"ORBIT_HOME=" + machineHome(),
	}
	env = append(env, wikiMaintainBashEnv()...)
	for _, key := range wikiMaintenanceEnvPass {
		if value, ok := os.LookupEnv(key); ok {
			env = append(env, key+"="+value)
		}
	}
	for _, key := range wikiMaintenanceProviderEnv {
		if value, ok := job.Agent.Env[key]; ok {
			env = append(env, key+"="+value)
		}
	}
	return append(env,
		"ORBIT_SESSION_ID="+publicID(job.SessionID),
		"ORBIT_AGENT_ID="+publicID(job.AgentID),
		"ORBIT_TASK_ID="+publicID(job.TaskID),
		"ORBIT_ALLOW_ORCHESTRATION="+orchestrationEnv(false),
		envWatches+"="+watchesEnv(job.WatchesDisabled),
		envWiki+"="+wikiEnv(job.WikiDisabled),
		"ORBIT_SPAWN_DEPTH="+strconv.Itoa(job.SpawnDepth),
	)
}

// envMCPTools names the only tools `orbit mcp` serves, comma-separated, when it is set: a clean start sets
// it on the orbit server alone (wikiMaintenanceTools), which --strict-mcp-config makes the only server there is.
const envMCPTools = "ORBIT_MCP_TOOLS"

// mcpToolsFromEnv is ORBIT_MCP_TOOLS as a set, or nil when it is not set: every tool.
func mcpToolsFromEnv() map[string]bool {
	raw, ok := os.LookupEnv(envMCPTools)
	if !ok {
		return nil
	}
	only := map[string]bool{}
	for _, name := range strings.Split(raw, ",") {
		if name = strings.TrimSpace(name); name != "" {
			only[name] = true
		}
	}
	return only
}

// onlyMCPTools keeps the tools `only` names, in the order they are listed.
func onlyMCPTools(tools []map[string]interface{}, only map[string]bool) []map[string]interface{} {
	kept := make([]map[string]interface{}, 0, len(only))
	for _, tool := range tools {
		if name, _ := tool["name"].(string); only[name] {
			kept = append(kept, tool)
		}
	}
	return kept
}

// claudeMaxTurnsSubtype is the result the CLI ends a turn with when it reached --max-turns.
const claudeMaxTurnsSubtype = "error_max_turns"

// reportWikiMaintenanceTruncated says on the space's cursor that the run was cut short: a failure, and one
// that moves the cursor no further. Best-effort — the turn itself is already FAILED, which is the record that stays.
func reportWikiMaintenanceTruncated(t *Transport, job *ClaimedSession) {
	run := job.WikiMaintenance
	why := fmt.Sprintf("the run reached its limit of %d model turns and was cut short, so it failed and moved the cursor no "+
		"further than past the ops it had recorded", run.MaxTurns)
	if _, err := t.advanceWikiCursor(job.SessionID, run.SpaceID, map[string]interface{}{"outcome": "truncated", "error": why}); err != nil {
		logln("wiki maintenance: could not record the truncated run of", job.SessionID+":", err)
	}
}
