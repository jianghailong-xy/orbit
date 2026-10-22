package main

// Orbit's MCP server in a Cursor CLI session, and the configuration Cursor CLI would run without asking
// anyone (docs/cursor-runtime-contract.md §6, §7).
//
// MCP servers reach Cursor CLI as the mcpServers of session/new and session/load: stdio entries it starts
// with no approval, handing each HOME, PATH and the env it declares and nothing else (§6). So `orbit mcp`
// is declared with every variable it reads its session from, and each of its tools is called through the
// permission request every MCP call sends (§5.1), which the bridge allows unasked (cursor_permissions.go).
//
// The rest that Cursor CLI runs unasked comes from two places only (§7.2): the user-level configuration
// under its HOME — mcp.json, whose servers start with session/new, and hooks.json, run on every tool —
// and the project directory under CURSOR_DATA_DIR — its hooks.json, and the approvals that would load the
// checkout's own .cursor/mcp.json (§6). Both are the session's own directories (cursor_launch.go), into
// which Orbit writes none of these. The checkout's .cursor/hooks.json and .cursor/mcp.json, its .claude/
// settings and its .envrc do not run over ACP (DIRENV_DISABLE), and its .cursor/cli.json allowlist is
// switched off with --disable-project-configs (cursorPermissionArgs). A file of that kind in the session's
// directories could only have been written there since, and nothing makes Cursor CLI ignore it, so in a
// mode that holds the session to anything a process does not start over one (guardCursorUserConfig).

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"time"
)

// cursorOrbitMCPCommand is how the session's Orbit MCP server is started: this runner's own executable in
// `mcp` mode, resolved per launch so it survives self-update.
var cursorOrbitMCPCommand = func() (string, []string) { return orbitCLIExecutable(), []string{"mcp"} }

// cursorMCPToolCallTimeout is how long Cursor CLI lets one MCP tool call run: it calls through the MCP
// SDK with no request options of its own (index.js@4887029, sendToolCall), whose default is 60 s. `orbit
// mcp` is told, so a call that waits for a person hands off before it (handOffOwnerWait).
const cursorMCPToolCallTimeout = 60 * time.Second

// cursorMCPServerName is a server name that stays one word of an Orbit tool name, mcp__<server>__<tool>:
// no "__", which would let a server pass for another one's tools.
var cursorMCPServerName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]*$`)

// cursorMCPServers is the mcpServers list for session/new and every session/load: Orbit's own server
// first, then the stdio servers the agent configured. A declaration Cursor CLI would drop or misread is
// refused before the process starts rather than mounted silently: a remote server, which is not verified
// on the pinned build (§6), a command that is not absolute, an env value that is not text or that would
// set the session's own variables.
func cursorMCPServers(job *ClaimedSession) ([]interface{}, error) {
	command, args := cursorOrbitMCPCommand()
	if !filepath.IsAbs(command) {
		return nil, errors.New("CURSOR_MCP_UNAVAILABLE: cannot resolve the orbit executable for the Orbit MCP server")
	}
	servers := []interface{}{map[string]interface{}{
		"name": "orbit", "command": command, "args": args, "env": orbitMCPDeclaredEnv(job, cursorMCPToolCallTimeout),
	}}
	names := make([]string, 0, len(job.Agent.McpConfig))
	for name := range job.Agent.McpConfig {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if strings.EqualFold(name, "orbit") {
			continue // Orbit's own server is not the agent's to replace, as on every runtime
		}
		entry := mapValue(job.Agent.McpConfig[name])
		if !cursorMCPServerName.MatchString(name) || strings.Contains(name, "__") || entry == nil {
			return nil, fmt.Errorf("CURSOR_MCP_INVALID: MCP server %q has no usable declaration", name)
		}
		command := firstString(entry, "command")
		switch {
		case command == "":
			return nil, fmt.Errorf("CURSOR_MCP_UNSUPPORTED: remote MCP server %q is not verified on Cursor CLI %s; only stdio servers are mounted",
				name, cursorSupportedVersion)
		case !filepath.IsAbs(command):
			return nil, fmt.Errorf("CURSOR_MCP_INVALID: MCP server %q must name an absolute command", name)
		}
		argv := []string{}
		for _, value := range sliceValue(entry["args"]) {
			text, ok := value.(string)
			if !ok {
				return nil, fmt.Errorf("CURSOR_MCP_INVALID: MCP server %q has a non-string argument", name)
			}
			argv = append(argv, text)
		}
		env := []map[string]string{}
		vars := mapValue(entry["env"])
		keys := make([]string, 0, len(vars))
		for key := range vars {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			value, ok := vars[key].(string)
			if !ok || sessionContextEnvKey(key) {
				return nil, fmt.Errorf("CURSOR_MCP_INVALID: MCP server %q sets %s, which Orbit does not let it set", name, key)
			}
			env = append(env, map[string]string{"name": key, "value": value})
		}
		servers = append(servers, map[string]interface{}{"name": name, "command": command, "args": argv, "env": env})
	}
	return servers, nil
}

// guardCursorUserConfig refuses to start Cursor CLI over configuration it would run without asking: a
// user-level MCP server or hook under its HOME, or a project hook or MCP approval under its data
// directory (§6, §7.2). A link counts as the file it names, dangling or not. Claude-format settings are
// refused there too: their hooks are read from the same directories (190.index.js@74185), whether or not
// they run over ACP has not been measured.
func guardCursorUserConfig(spec CursorLaunchSpec) error {
	paths := []string{
		filepath.Join(spec.Home, ".cursor", "mcp.json"),
		filepath.Join(spec.Home, ".cursor", "hooks.json"),
		filepath.Join(spec.Home, ".claude", "settings.json"),
		filepath.Join(spec.Home, ".claude", "settings.local.json"),
	}
	projects := filepath.Join(spec.DataDir, "projects")
	entries, err := os.ReadDir(projects)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("CURSOR_CONFIG_CONFLICT: cannot inspect %s: %w", projects, err)
	}
	for _, entry := range entries {
		dir := filepath.Join(projects, entry.Name())
		paths = append(paths,
			filepath.Join(dir, "mcp-approvals.json"),
			filepath.Join(dir, ".cursor", "hooks.json"),
			filepath.Join(dir, ".cursor", "mcp.json"),
			filepath.Join(dir, ".claude", "settings.json"),
			filepath.Join(dir, ".claude", "settings.local.json"))
	}
	for _, path := range paths {
		_, err := os.Lstat(path)
		switch {
		case err == nil:
			return fmt.Errorf("CURSOR_CONFIG_UNSAFE: refusing to start Cursor CLI: %s would run commands outside Orbit's permission mode, "+
				"and Cursor CLI loads it without asking. Remove it, or start a new session", path)
		case errors.Is(err, os.ErrNotExist), errors.Is(err, syscall.ENOTDIR):
			continue
		default:
			return fmt.Errorf("CURSOR_CONFIG_CONFLICT: cannot inspect %s: %w", path, err)
		}
	}
	return nil
}
