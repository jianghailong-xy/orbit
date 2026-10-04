package main

// The private Gemini directory each Antigravity session runs agy with.
//
// agy keeps everything it reads and writes under one directory — settings, MCP servers, hooks, the
// conversation store, logs, the updater's state — which is ~/.gemini unless the hidden
// `--gemini_dir=<absolute path>` names another (docs/antigravity-runtime-contract.md §3). Orbit
// names its own, under the session's scratch directory, so nothing Orbit configures ever lands in
// the user's ~/.gemini, and HOME stays the user's: git, ssh and the caches an agent's commands use
// keep working. Unlike the Kimi overlay (kimi_home.go) nothing is borrowed back from the real
// directory. API-key mode needs no sign-in state, and Google mode brings the runner's own (a copy of
// its token, antigravity_google_session.go); what the user set up for their own agy — rules, skills,
// MCP servers, a sign-in — is theirs, not the agent's: the agent's configuration is the whole of what
// the session sees.
//
// The directory outlives each agy process. agy keeps the conversation in it
// (antigravity-cli/conversations/<id>.db, brain/<id>/), and `--conversation <id>` finds a
// conversation only in the directory it was created in. The scratch directory is reused when the
// session resumes, so the conversation resumes in the same place.
//
// Layout (what Orbit writes; agy adds the rest):
//
//	<dir>/antigravity-cli/settings.json   modelProvider or useG1Credits, telemetry, permission rules
//	<dir>/antigravity-cli/antigravity-oauth-token   Google mode: the runner's sign-in, while an agy runs on it
//	<dir>/config/mcp_config.json          the MCP servers: Orbit's own and the agent's
//	<dir>/GEMINI.md                       the agent's instructions, which agy loads as user rules
//	<dir>/antigravity-cli/bin -> <runner>/antigravity/bin
//	<dir>/config/hooks.json, <dir>/orbit/ Orbit's approval gate, in the modes that ask (antigravity_approval.go)

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

// antigravityGeminiDir is where a session's agy keeps its configuration and its conversations.
func antigravityGeminiDir(scratchDir string) (string, error) {
	return filepath.Abs(filepath.Join(scratchDir, "antigravity"))
}

// prepareAntigravityGeminiDir writes what Orbit owns in a session's Gemini directory, from the
// session as it is now: every spawn rewrites it, so a reload's new permission mode or rules reach
// the next process. What agy wrote there itself is left alone. google is a spawn on the runner's
// Google sign-in, which gets its copy of it here.
func prepareAntigravityGeminiDir(scratchDir string, job *ClaimedSession, orbitExe string, google bool) (string, error) {
	dir, err := antigravityGeminiDir(scratchDir)
	if err != nil {
		return "", err
	}
	for _, sub := range []string{"antigravity-cli", "config"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), machineHomePerm); err != nil {
			return "", err
		}
	}
	// MkdirAll applies the umask; the conversations in here are the session's whole history.
	if runtime.GOOS != "windows" {
		if err := os.Chmod(dir, machineHomePerm); err != nil {
			return "", err
		}
	}
	if err := writeAntigravityJSON(filepath.Join(dir, "antigravity-cli", "settings.json"), antigravitySettings(job, orbitExe, google)); err != nil {
		return "", fmt.Errorf("write settings.json: %w", err)
	}
	mcp := map[string]interface{}{"mcpServers": antigravityMCPServers(job.Agent, orbitExe)}
	if err := writeAntigravityJSON(filepath.Join(dir, "config", "mcp_config.json"), mcp); err != nil {
		return "", fmt.Errorf("write mcp_config.json: %w", err)
	}
	rules := filepath.Join(dir, "GEMINI.md")
	if instructions := antigravityInstructions(job, orbitExe); instructions != "" {
		if err := os.WriteFile(rules, []byte(instructions+"\n"), 0o600); err != nil {
			return "", fmt.Errorf("write GEMINI.md: %w", err)
		}
	} else if err := os.Remove(rules); err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	// Last, so nothing after it can fail and strand the copy. A copy outlives its agy only when the
	// runner did not see it exit (a crash, a restart): whatever this spawn runs on, that one goes.
	if err := removeAntigravityToken(dir); err != nil {
		return "", fmt.Errorf("remove a leftover Google sign-in copy: %w", err)
	}
	if google {
		if err := placeAntigravityToken(dir); err != nil {
			return "", fmt.Errorf("copy the runner's Google sign-in into the session: %w", err)
		}
	}
	linkAntigravitySharedBin(dir)
	return dir, nil
}

func writeAntigravityJSON(path string, value interface{}) error {
	body, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(body, '\n'), 0o600)
}

// antigravitySettings is the session's settings.json (contract §3.1, §5.1, §7, §16):
//
//   - modelProvider "gemini" is API-key mode. Without it agy wants a Google sign-in, and
//     GEMINI_API_KEY alone changes nothing — which is Google mode (google): no modelProvider, and
//     useG1Credits false, so a turn spends the account's own quota and never the paid AI credits
//     beyond it (§16.6).
//   - enableTelemetry false stops agy's error reports. It is the only switch that does anything,
//     and it does not stop the usage statistics agy sends regardless (§7.1).
//   - permissions carries Orbit's rules in agy's grammar.
func antigravitySettings(job *ClaimedSession, orbitExe string, google bool) map[string]interface{} {
	settings := map[string]interface{}{"enableTelemetry": false}
	if google {
		settings["useG1Credits"] = false
	} else {
		settings["modelProvider"] = "gemini"
	}
	allow, deny := antigravityPermissionRules(job, orbitExe)
	permissions := map[string]interface{}{}
	if len(allow) > 0 {
		permissions["allow"] = allow
	}
	if len(deny) > 0 {
		permissions["deny"] = deny
	}
	if len(permissions) > 0 {
		settings["permissions"] = permissions
	}
	return settings
}

// antigravityPermissionRules translates the session's rules into agy's (contract §5.1). Deny rules
// hold in every mode, --dangerously-skip-permissions included. Allow rules matter only in the modes
// that refuse: there Orbit's own MCP server is always allowed — agy treats every MCP call as needing
// approval, and without it the agent could not reach Orbit's tools at all (§10.3). Plan mode grants
// nothing beyond that: a rule that allows a command or a write would let it out of planning.
func antigravityPermissionRules(job *ClaimedSession, orbitExe string) (allow, deny []string) {
	for _, rule := range job.Agent.DisallowedTools {
		deny = appendUnique(deny, antigravityRule(rule, true)...)
	}
	mode := strings.TrimSpace(job.Agent.PermissionMode)
	if !antigravityGuardedMode(mode) {
		return nil, deny
	}
	allow = []string{"mcp(orbit/*)"}
	if mode == "plan" {
		return allow, deny
	}
	rules := appendUnique(job.Agent.AllowedTools, orbitCLIAllowedTools(
		orbitCLIPermissionExecutable(orbitExe),
		job.AllowOrchestration && strings.TrimSpace(job.OrchestrationToken) != "",
	)...)
	for _, rule := range rules {
		allow = appendUnique(allow, antigravityRule(rule, false)...)
	}
	return allow, deny
}

// antigravityRule translates one rule from the grammar Orbit stores them in (claude's:
// `Bash(git commit:*)`, `Read(/repo/docs)`, `WebFetch(domain:go.dev)`, `mcp__docs__*`, a bare `Edit`)
// into agy's: command(<prefix>), read_file(<path>), write_file(<path>), read_url(<domain>),
// mcp(<server>/<tool>).
//
// The two directions fail differently on purpose. agy matches command rules by word prefix, so an
// exact claude command allow (`Bash(npm test)`) would come out wider than what was granted: it is
// dropped, and the call keeps being refused. A deny may widen — refusing a little more than asked
// is the safe side — so the same exact command is denied as a prefix, and a scoped deny agy has no
// form for denies the whole permission.
func antigravityRule(rule string, deny bool) []string {
	rule = strings.TrimSpace(rule)
	if rule == "" {
		return nil
	}
	name, content, scoped := rule, "", false
	if open := strings.IndexByte(rule, '('); open > 0 && strings.HasSuffix(rule, ")") {
		name = strings.TrimSpace(rule[:open])
		content = strings.TrimSpace(rule[open+1 : len(rule)-1])
		scoped = content != ""
	}
	if strings.HasPrefix(name, "mcp__") {
		if scoped {
			return nil
		}
		return antigravityMCPRule(strings.TrimPrefix(name, "mcp__"))
	}
	whole := func(permission string) []string {
		return []string{permission + "(*)"}
	}
	switch name {
	case "Bash":
		if !scoped {
			return whole("command")
		}
		if prefix, ok := claudeBashRulePrefix(content); ok {
			if prefix == "" {
				return whole("command")
			}
			return []string{"command(" + prefix + ")"}
		}
		if deny {
			return []string{"command(" + content + ")"}
		}
		return nil
	case "Read":
		return antigravityPathRule("read_file", content, scoped, deny)
	case "Edit", "Write", "MultiEdit", "NotebookEdit":
		return antigravityPathRule("write_file", content, scoped, deny)
	case "WebFetch":
		if !scoped {
			return whole("read_url")
		}
		if domain, ok := strings.CutPrefix(content, "domain:"); ok && strings.TrimSpace(domain) != "" {
			return []string{"read_url(" + strings.TrimSpace(domain) + ")"}
		}
		if deny {
			return whole("read_url")
		}
		return nil
	}
	return nil
}

// claudeBashRulePrefix reads the command prefix a claude Bash rule grants: `git commit:*` and the
// `git commit *` form Orbit's own CLI rules use are both "git commit"; a bare `*` is every command.
// False for an exact command.
func claudeBashRulePrefix(content string) (string, bool) {
	content = strings.TrimSpace(content)
	if content == "*" {
		return "", true
	}
	for _, suffix := range []string{":*", " *"} {
		if prefix, ok := strings.CutSuffix(content, suffix); ok && !strings.Contains(prefix, "*") {
			return strings.TrimSpace(prefix), true
		}
	}
	return "", false
}

// antigravityPathRule is read_file/write_file for a path rule. An allow is passed through as written:
// a pattern agy cannot match grants nothing, which fails closed. A deny is passed through only for
// an absolute path, the form measured to hold (contract §5.3); a relative or globbed one agy might
// not match, so it denies the whole permission instead.
func antigravityPathRule(permission, path string, scoped, deny bool) []string {
	if !scoped || path == "*" || path == "**" {
		return []string{permission + "(*)"}
	}
	if deny && (!filepath.IsAbs(path) || strings.ContainsAny(path, "*?[")) {
		return []string{permission + "(*)"}
	}
	return []string{permission + "(" + path + ")"}
}

// antigravityMCPRule is mcp(<server>/<tool>) for a claude MCP name: `docs__search`, `docs__*`, or a
// bare `docs`, which claude reads as the whole server.
func antigravityMCPRule(rest string) []string {
	server, tool, hasTool := strings.Cut(rest, "__")
	server = strings.TrimSpace(server)
	if server == "" {
		return nil
	}
	if !hasTool || strings.TrimSpace(tool) == "" {
		tool = "*"
	}
	if server == "*" {
		return []string{"mcp(*)"}
	}
	return []string{"mcp(" + server + "/" + strings.TrimSpace(tool) + ")"}
}

// antigravityMCPServers is the mcpServers body of the session's mcp_config.json, whose entries are
// shaped like Kimi's mcp.json (command, args, env — contract §10.3). Orbit's own server is always
// among them, under the name the permission rules allow. Its env is empty on purpose: `orbit mcp`
// reads which session it belongs to from ORBIT_SESSION_ID and friends, which it inherits through
// agy from the environment the session's process is started with.
//
// Only stdio servers: what agy expects for a remote one is unmeasured, and an entry it cannot parse
// could cost the session every server in the file, Orbit's included.
func antigravityMCPServers(agent AgentExecConfig, orbitExe string) map[string]interface{} {
	servers := map[string]interface{}{}
	names := make([]string, 0, len(agent.McpConfig))
	for name := range agent.McpConfig {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if entry := kimiMCPConfigEntry(name, agent.McpConfig[name]); entry != nil {
			servers[name] = entry
		} else {
			logln("antigravity: MCP server", name, "is not a stdio server; agy is not given it")
		}
	}
	if orbitExe != "" {
		servers["orbit"] = map[string]interface{}{
			"command": orbitExe,
			"args":    []string{"mcp"},
			"env":     map[string]string{},
		}
	}
	return servers
}

// antigravityInstructions is the agent's configured prompt and Orbit's own instructions, written
// where agy loads a user's global rules. agy has no system-prompt flag; its rules arrive in the
// system instruction under "user-defined rules that you MUST ALWAYS FOLLOW", ahead of the
// workspace's own GEMINI.md/AGENTS.md (measured on 1.2.16).
func antigravityInstructions(job *ClaimedSession, orbitExe string) string {
	text := strings.Join(nonEmptyStrings(
		job.Agent.SystemPrompt,
		withOrbitCLIInstructions(job.Agent.AppendSystemPrompt, orbitExe, job.insideRecordedWork(), job.watchesOn()),
	), "\n\n")
	// agy reaches an MCP tool through its generic call_mcp_tool rather than by the tool's own name.
	return strings.Replace(text, "the `mcp__orbit__*` tools", "the tools of the `orbit` MCP server (call_mcp_tool with ServerName \"orbit\")", 1)
}

// linkAntigravitySharedBin points a Gemini directory's bin/ at one runner-wide directory. agy unpacks
// a 17MB webm_encoder into the bin/ of every Gemini directory it starts in; shared, it is unpacked
// once (contract §3.1). Best effort: without the link agy unpacks its own copy, nothing worse.
func linkAntigravitySharedBin(geminiDir string) {
	shared, err := filepath.Abs(filepath.Join(machineHome(), "antigravity", "bin"))
	if err != nil {
		return
	}
	if err := os.MkdirAll(shared, machineHomePerm); err != nil {
		return
	}
	link := filepath.Join(geminiDir, "antigravity-cli", "bin")
	if _, err := os.Lstat(link); err == nil {
		return // the link from an earlier spawn, or a directory agy made itself: either works
	}
	_ = os.Symlink(shared, link)
}

// guardAntigravityProjectConfig refuses to start agy in a guarded mode on a checkout that brings its
// own hooks or MCP servers. agy runs a workspace's .agents/hooks.json before every tool call and
// starts the servers in its .agents/mcp_config.json as it starts, in every permission mode — headless
// agy has no "trust this workspace?" question to ask (contract §3.5) — so loading them is running
// whatever command the checkout names, outside Orbit's policy. Plugins can carry both, so
// plugins.json and a plugins/ directory count too. Same reasoning and shape as guardKimiProjectMCP.
//
// Every .agents/ from the session's directory up to its repository root is checked: agy 1.2.16 reads
// manifests from all of them.
func guardAntigravityProjectConfig(cwd, mode string) error {
	if !antigravityGuardedMode(mode) {
		return nil
	}
	root, err := kimiFindProjectRoot(cwd)
	if err != nil {
		return fmt.Errorf("cannot safely inspect the checkout's .agents configuration: %w", err)
	}
	dir := filepath.Clean(cwd)
	for {
		for _, name := range []string{"hooks.json", "mcp_config.json", "plugins.json", "plugins"} {
			path := filepath.Join(dir, ".agents", name)
			// Lstat: a dangling link is refused like the file it would become.
			_, err := os.Lstat(path)
			switch {
			case err == nil:
				return fmt.Errorf("refusing to start Antigravity: the checkout's %s may run commands outside Orbit's permission policy (agy runs it in every mode). Remove it, or run this session in Auto or Bypass permissions", path)
			case !errors.Is(err, os.ErrNotExist):
				return fmt.Errorf("cannot safely inspect %s: %w", path, err)
			}
		}
		parent := filepath.Dir(dir)
		if dir == root || parent == dir {
			return nil
		}
		dir = parent
	}
}
