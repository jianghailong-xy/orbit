package main

import (
	"fmt"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// dshOrbitMCPCommand is how the session's Orbit MCP server is started: this runner's own
// executable in `mcp` mode, resolved per launch so it survives self-update.
var dshOrbitMCPCommand = func() (string, []string) { return orbitCLIExecutable(), []string{"mcp"} }

// dshMCPServers is the mcpServers list for session/new and every session/resume (dsh keeps no
// MCP connection across a process). Orbit's own server always comes first. dsh accepts a
// declaration it then cannot honor in two ways P0 measured: an SSE entry is dropped by the ACP
// SDK while session/new still succeeds, and MCP tool annotations never raise an approval. So
// every entry is validated here, and anything dsh would drop, or that would act outside the
// session's permission mode, is refused before the process starts rather than mounted silently.
func dshMCPServers(job *ClaimedSession, policy dshPermissionPolicy) ([]interface{}, error) {
	command, args := dshOrbitMCPCommand()
	if !filepath.IsAbs(command) {
		return nil, fmt.Errorf("DSH_MCP_UNAVAILABLE: cannot resolve the orbit executable for the Orbit MCP server")
	}
	servers := []interface{}{map[string]interface{}{
		"name": "orbit", "command": command, "args": args, "env": dshOrbitMCPEnv(job),
	}}
	names := make([]string, 0, len(job.Agent.McpConfig))
	for name := range job.Agent.McpConfig {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if name == "orbit" {
			continue // Orbit's own server is not the agent's to replace, as on every runtime
		}
		entry := mapValue(job.Agent.McpConfig[name])
		if strings.TrimSpace(name) == "" || entry == nil {
			return nil, fmt.Errorf("DSH_MCP_INVALID: MCP server %q has no usable declaration", name)
		}
		if command := firstString(entry, "command"); command == "" {
			transport := strings.ToLower(firstString(entry, "type", "transport"))
			if transport == "sse" {
				return nil, fmt.Errorf("DSH_MCP_UNSUPPORTED: SSE MCP server %q would be dropped silently by DeepSeek Harness %s", name, dshSupportedVersion)
			}
			return nil, fmt.Errorf("DSH_MCP_UNSUPPORTED: remote MCP server %q is not verified on DeepSeek Harness %s; only stdio servers are mounted", name, dshSupportedVersion)
		} else if !filepath.IsAbs(command) {
			return nil, fmt.Errorf("DSH_MCP_INVALID: MCP server %q must name an absolute command", name)
		}
		if !policy.ThirdPartyMCP {
			return nil, fmt.Errorf("DSH_MCP_UNENFORCEABLE: MCP server %q would act without approval; DeepSeek Harness never asks before MCP tools, so it runs only in Auto", name)
		}
		var argv []string
		for _, value := range sliceValue(entry["args"]) {
			text, ok := value.(string)
			if !ok {
				return nil, fmt.Errorf("DSH_MCP_INVALID: MCP server %q has a non-string argument", name)
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
				return nil, fmt.Errorf("DSH_MCP_INVALID: MCP server %q sets %s, which Orbit does not let it set", name, key)
			}
			env = append(env, map[string]string{"name": key, "value": value})
		}
		servers = append(servers, map[string]interface{}{"name": name, "command": firstString(entry, "command"), "args": argv, "env": env})
	}
	return servers, nil
}

// dshMCPToolCallTimeout is how long dsh lets one MCP tool call run before it tells the model the call
// timed out: @deepseek-ai/dsh-mcp-client's default toolCallTimeoutMs, which the ACP mcpServers
// declaration has no field for. Measured on the pinned version, it also sends the server
// notifications/cancelled. `orbit mcp` is told, so a call that waits for a person returns before it
// (handOffOwnerWait) rather than being reported failed while its write still happens.
const dshMCPToolCallTimeout = 60 * time.Second

// dshOrbitMCPEnv is the whole environment `orbit mcp` reads its session from. dsh starts stdio
// servers from the declared env, not from its own, so nothing is inherited implicitly.
func dshOrbitMCPEnv(job *ClaimedSession) []map[string]string {
	pairs := []string{
		"ORBIT_SESSION_ID=" + publicID(job.SessionID),
		"ORBIT_AGENT_ID=" + publicID(job.AgentID),
		"ORBIT_TASK_ID=" + publicID(job.TaskID),
		envMCPOrchestration + "=" + orchestrationEnv(job.AllowOrchestration),
		envWatches + "=" + watchesEnv(job.WatchesDisabled),
		envWiki + "=" + wikiEnv(job.WikiDisabled),
		envMCPPermissionPrompt + "=0",
		envSpawnDepth + "=" + strconv.Itoa(job.SpawnDepth),
		envMCPCallTimeout + "=" + strconv.Itoa(int(dshMCPToolCallTimeout/time.Second)),
		envRunnerChild + "=1",
	}
	// Where the runner's own config lives, so the server authenticates as this runner.
	if home := machineHome(); filepath.IsAbs(home) {
		pairs = append(pairs, "ORBIT_HOME="+home)
	}
	pairs = append(pairs, bgJobEnvPairs(job.SessionID)...)
	env := make([]map[string]string, 0, len(pairs))
	for _, pair := range pairs {
		key, value, _ := strings.Cut(pair, "=")
		env = append(env, map[string]string{"name": key, "value": value})
	}
	return env
}

func sliceValue(value interface{}) []interface{} {
	switch v := value.(type) {
	case []interface{}:
		return v
	case []string:
		out := make([]interface{}, len(v))
		for i, s := range v {
			out[i] = s
		}
		return out
	}
	return nil
}

// dshToolPolicyError refuses strict tool restrictions dsh cannot enforce. A denylist would have to
// stop tools dsh runs without asking (reads, sandboxed commands, MCP calls); allowedTools only
// ever pre-approve and are not used to widen anything, so escalations still reach a person.
func dshToolPolicyError(agent AgentExecConfig) error {
	for _, rule := range agent.DisallowedTools {
		if strings.TrimSpace(rule) != "" {
			return fmt.Errorf("DSH_TOOL_POLICY_UNSUPPORTED: DeepSeek Harness cannot enforce disallowedTools (%s); remove the denylist or use another runtime", rule)
		}
	}
	return nil
}
