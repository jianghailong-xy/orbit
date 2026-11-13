package main

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
)

// A Claude Code session on a local model server (a runner-scoped Ollama provider,
// docs/ollama-local-provider-contract.md §7) must reach that server and nothing else. The control
// plane hands the job the server's base URL, the model and a placeholder token, marks it with
// localProviderMarkerVar, and sends every cloud-routing variable it knows of as an explicit empty
// value. That is not enough on its own, because a claude process reads routing from three places:
//
//  1. this process's environment (launchd, the shell that started the runner, a systemd unit);
//  2. the `env` block of the settings files it loads: the user's CLAUDE_CONFIG_DIR/settings.json, the
//     checkout's .claude/settings.json and .claude/settings.local.json, then the --settings file the
//     runner writes (the FLAG layer, which outranks the other three);
//  3. the job's own env.
//
// Any of them could turn on Bedrock, Vertex or Foundry, or name another base URL or key, and a switch
// like CLAUDE_CODE_USE_BEDROCK sends the request to a cloud however ANTHROPIC_BASE_URL is set. So
// for a local job the runner (a) drops every cloud-routing variable from the inherited environment
// unless the job sets it, and (b) pins every routing variable in the flag settings layer: the job's
// value where it sets one, and the empty string for each routing variable a lower settings file sets.
// An ordinary job, marked or not by an older control plane, is left exactly as before.

// localProviderMarkerVar marks a job on a local provider. It is read here and never reaches the engine.
const localProviderMarkerVar = "ORBIT_LOCAL_PROVIDER"

// localProviderRunCapabilityV1 is declared by a runner that applies this isolation. The control plane
// hands a local provider's session only to a runner that declares it (LOCAL_PROVIDER_RUNNER_OUTDATED).
const localProviderRunCapabilityV1 = "ollama-run/v1"

// isLocalProviderJob reports whether the job's env marks it as running on a local provider.
func isLocalProviderJob(agentEnv map[string]string) bool {
	return strings.TrimSpace(agentEnv[localProviderMarkerVar]) == "1"
}

// claudeRoutingKey reports whether a variable decides where a claude process sends its model requests,
// or with which credential: Anthropic's own endpoint, key and models, the cloud platforms Claude Code
// can run through (every CLAUDE_CODE_USE_* switch, its SKIP_*_AUTH sibling, and their base URLs,
// regions and credentials), and the OAuth token. Matched by prefix, so a platform added later is
// covered the day it appears.
func claudeRoutingKey(key string) bool {
	upper := strings.ToUpper(key)
	switch upper {
	case "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_SUBAGENT_MODEL", "CLOUD_ML_REGION",
		"GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "VERTEX_REGION_CLAUDE_CODE":
		return true
	}
	for _, prefix := range []string{"ANTHROPIC_", "CLAUDE_CODE_USE_", "AWS_", "VERTEX_REGION_"} {
		if strings.HasPrefix(upper, prefix) {
			return true
		}
	}
	return strings.HasPrefix(upper, "CLAUDE_CODE_SKIP_") && strings.HasSuffix(upper, "_AUTH")
}

// localProviderProcessEnv is env (a claude's whole environment, built by envWithAgent) with every
// cloud-routing variable the job does not set itself taken out, and the marker taken out. An
// unmarked job's env is returned as it was.
func localProviderProcessEnv(env []string, agentEnv map[string]string) []string {
	if !isLocalProviderJob(agentEnv) {
		return env
	}
	// Last one wins in exec, so the job's own values (appended after the inherited ones) are kept,
	// and an inherited one the job does not name is dropped.
	out := make([]string, 0, len(env))
	for _, entry := range env {
		key, _, _ := strings.Cut(entry, "=")
		if strings.EqualFold(key, localProviderMarkerVar) {
			continue
		}
		if claudeRoutingKey(key) {
			if _, set := agentEnv[key]; !set {
				continue
			}
		}
		out = append(out, entry)
	}
	return out
}

// localProviderPinnedEnv is the `env` the flag settings file carries for a local job: every routing
// variable the job sets, at its value, and every routing variable a lower settings file sets
// (settingsEnvs, in any order) that the job does not, at "". Nil for an unmarked job.
func localProviderPinnedEnv(agentEnv map[string]string, settingsEnvs ...map[string]string) map[string]string {
	if !isLocalProviderJob(agentEnv) {
		return nil
	}
	pinned := map[string]string{}
	for _, lower := range settingsEnvs {
		for key := range lower {
			if claudeRoutingKey(key) {
				pinned[key] = ""
			}
		}
	}
	for key, value := range agentEnv {
		if claudeRoutingKey(key) || key == claudeNonessentialTrafficVar {
			pinned[key] = value
		}
	}
	return pinned
}

// localProviderLowerSettingsEnvs reads the `env` of every settings file below the flag layer that a
// claude started in execDir with agentEnv would load: the user's, the checkout's shared one, and its
// local one. A file that is missing or unreadable contributes nothing.
func localProviderLowerSettingsEnvs(agentEnv map[string]string, execDir string) []map[string]string {
	var out []map[string]string
	if dir, err := claudeSessionAccountDir(agentEnv, execDir); err == nil {
		out = append(out, claudeSettingsEnv(dir))
	}
	if execDir != "" {
		project := execDir + string(os.PathSeparator) + ".claude"
		out = append(out, claudeSettingsEnv(project), claudeSettingsFileEnv(project+string(os.PathSeparator)+"settings.local.json"))
	}
	return out
}

// pinLocalProviderSettings writes localProviderPinnedEnv into the flag settings file args name
// (--settings), for a local job. It fails closed: a local job whose flag settings file is missing or
// cannot be rewritten is not started, since a lower settings file could otherwise route it to a cloud.
// An unmarked job is left untouched.
func pinLocalProviderSettings(args []string, agentEnv map[string]string, execDir string) error {
	if !isLocalProviderJob(agentEnv) {
		return nil
	}
	path := ""
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "--settings" {
			path = args[i+1]
		}
	}
	if path == "" {
		return errLocalProviderUnpinned
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	settings := map[string]interface{}{}
	if err := json.Unmarshal(b, &settings); err != nil {
		return err
	}
	settings["env"] = localProviderPinnedEnv(agentEnv, localProviderLowerSettingsEnvs(agentEnv, execDir)...)
	out, err := json.Marshal(settings)
	if err != nil {
		return err
	}
	return os.WriteFile(path, out, 0o600)
}

var errLocalProviderUnpinned = errors.New("a local provider session needs its own settings file, and this one has none")
