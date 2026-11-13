package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// The job env a control plane hands a Claude Code session on a local Ollama (custom-provider.ts).
func localJobEnv(configDir string) map[string]string {
	return map[string]string{
		localProviderMarkerVar:       "1",
		"ANTHROPIC_BASE_URL":         "http://127.0.0.1:11434",
		"ANTHROPIC_AUTH_TOKEN":       "ollama",
		"ANTHROPIC_MODEL":            "qwen3.8:27b",
		"ANTHROPIC_API_KEY":          "",
		"CLAUDE_CODE_USE_BEDROCK":    "",
		claudeNonessentialTrafficVar: "1",
		"CLAUDE_CONFIG_DIR":          configDir,
		"KEEP_ME":                    "yes",
	}
}

// exactEnv runs /usr/bin/env with env and returns what the child actually received: exec's own
// last-one-wins resolution of duplicate keys, not a reading of the slice.
func exactEnv(t *testing.T, env []string) map[string]string {
	t.Helper()
	if _, err := os.Stat("/usr/bin/env"); err != nil {
		t.Skip("no /usr/bin/env")
	}
	cmd := exec.Command("/usr/bin/env")
	cmd.Env = env
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("env: %v", err)
	}
	got := map[string]string{}
	for _, line := range strings.Split(strings.TrimRight(string(out), "\n"), "\n") {
		if key, value, ok := strings.Cut(line, "="); ok {
			got[key] = value
		}
	}
	return got
}

func TestClaudeRoutingKey(t *testing.T) {
	for _, key := range []string{
		"ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_VERTEX_PROJECT_ID",
		"ANTHROPIC_FOUNDRY_RESOURCE", "ANTHROPIC_CUSTOM_HEADERS", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
		"CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_SKIP_BEDROCK_AUTH", "CLAUDE_CODE_SKIP_VERTEX_AUTH",
		"AWS_BEARER_TOKEN_BEDROCK", "AWS_PROFILE", "AWS_REGION", "CLOUD_ML_REGION", "GOOGLE_APPLICATION_CREDENTIALS",
		"GOOGLE_CLOUD_PROJECT", "VERTEX_REGION_CLAUDE_4_0_OPUS", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_SUBAGENT_MODEL",
	} {
		if !claudeRoutingKey(key) {
			t.Errorf("%s is a routing variable", key)
		}
	}
	for _, key := range []string{"PATH", "HOME", "KEEP_ME", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_MAX_CONTEXT_TOKENS", "ORBIT_SESSION_ID"} {
		if claudeRoutingKey(key) {
			t.Errorf("%s is not a routing variable", key)
		}
	}
}

// What the claude child receives, built exactly as spawnClaude builds it: envWithAgent over this
// process's environment, then the local filter.
func TestLocalProviderEnvOverridesTheRunnersAmbientRouting(t *testing.T) {
	t.Setenv("CLAUDE_CODE_USE_BEDROCK", "1")
	t.Setenv("CLAUDE_CODE_USE_VERTEX", "1")
	t.Setenv("AWS_BEARER_TOKEN_BEDROCK", "ambient-bedrock-token")
	t.Setenv("ANTHROPIC_VERTEX_PROJECT_ID", "ambient-project")
	t.Setenv("ANTHROPIC_API_KEY", "ambient-anthropic-key")
	t.Setenv("ANTHROPIC_BASE_URL", "https://api.anthropic.com")
	t.Setenv("CLAUDE_CODE_OAUTH_TOKEN", "ambient-oauth")
	t.Setenv("RUNNER_OWN", "kept")
	agent := localJobEnv(t.TempDir())

	got := exactEnv(t, localProviderProcessEnv(envWithAgent(agent), agent))
	for key, want := range map[string]string{
		"ANTHROPIC_BASE_URL": "http://127.0.0.1:11434", "ANTHROPIC_AUTH_TOKEN": "ollama", "ANTHROPIC_MODEL": "qwen3.8:27b",
		"ANTHROPIC_API_KEY": "", "CLAUDE_CODE_USE_BEDROCK": "", claudeNonessentialTrafficVar: "1",
		"KEEP_ME": "yes", "RUNNER_OWN": "kept",
	} {
		if v, ok := got[key]; !ok || v != want {
			t.Errorf("%s = %q (set %v), want %q", key, v, ok, want)
		}
	}
	for _, key := range []string{"CLAUDE_CODE_USE_VERTEX", "AWS_BEARER_TOKEN_BEDROCK", "ANTHROPIC_VERTEX_PROJECT_ID", "CLAUDE_CODE_OAUTH_TOKEN", localProviderMarkerVar} {
		if v, ok := got[key]; ok {
			t.Errorf("%s reached the local claude as %q", key, v)
		}
	}
}

// An ordinary job — a cloud key, the runner's own sign-in — keeps every ambient variable exactly as before.
func TestCloudJobEnvIsUnchanged(t *testing.T) {
	t.Setenv("CLAUDE_CODE_USE_BEDROCK", "1")
	t.Setenv("AWS_PROFILE", "corp")
	agent := map[string]string{"ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic", "ANTHROPIC_AUTH_TOKEN": "sk-x"}
	env := envWithAgent(agent)
	if got := localProviderProcessEnv(env, agent); !reflect.DeepEqual(got, env) {
		t.Fatal("an unmarked job's environment changed")
	}
	got := exactEnv(t, env)
	if got["CLAUDE_CODE_USE_BEDROCK"] != "1" || got["AWS_PROFILE"] != "corp" || got["ANTHROPIC_AUTH_TOKEN"] != "sk-x" {
		t.Fatalf("cloud job env: %v", got)
	}
	if path, err := writeClaudeSettings(t.TempDir(), "", false); err != nil {
		t.Fatal(err)
	} else {
		before, _ := os.ReadFile(path)
		if err := pinLocalProviderSettings([]string{"--settings", path}, agent, t.TempDir()); err != nil {
			t.Fatal(err)
		}
		after, _ := os.ReadFile(path)
		if string(before) != string(after) {
			t.Fatal("an unmarked job's settings file was rewritten")
		}
	}
}

// The flag settings layer outranks the user's settings.json and the checkout's: every routing
// variable those set is pinned empty, the job's own are pinned at its values, and the rest of the file
// (hooks, connectors) is kept.
func TestLocalProviderPinsRoutingOverLowerSettings(t *testing.T) {
	configDir := t.TempDir()
	execDir := t.TempDir()
	write := func(path string, env map[string]interface{}) {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		b, _ := json.Marshal(map[string]interface{}{"env": env})
		if err := os.WriteFile(path, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(configDir, "settings.json"), map[string]interface{}{
		"CLAUDE_CODE_USE_VERTEX": "1", "ANTHROPIC_BASE_URL": "https://cloud.example", "UNRELATED": "x",
	})
	write(filepath.Join(execDir, ".claude", "settings.json"), map[string]interface{}{"CLAUDE_CODE_USE_FOUNDRY": true})
	write(filepath.Join(execDir, ".claude", "settings.local.json"), map[string]interface{}{"AWS_BEARER_TOKEN_BEDROCK": "t"})
	agent := localJobEnv(configDir)

	path, err := writeClaudeSettings(t.TempDir(), "/usr/local/bin/orbit", false)
	if err != nil {
		t.Fatal(err)
	}
	if err := pinLocalProviderSettings([]string{"-p", "--settings", path}, agent, execDir); err != nil {
		t.Fatal(err)
	}
	var settings struct {
		Env                       map[string]string `json:"env"`
		Hooks                     interface{}       `json:"hooks"`
		DisableClaudeAiConnectors bool              `json:"disableClaudeAiConnectors"`
	}
	b, _ := os.ReadFile(path)
	if err := json.Unmarshal(b, &settings); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"ANTHROPIC_BASE_URL": "http://127.0.0.1:11434", "ANTHROPIC_AUTH_TOKEN": "ollama", "ANTHROPIC_MODEL": "qwen3.8:27b",
		"ANTHROPIC_API_KEY": "", "CLAUDE_CODE_USE_BEDROCK": "", claudeNonessentialTrafficVar: "1",
		"CLAUDE_CODE_USE_VERTEX": "", "CLAUDE_CODE_USE_FOUNDRY": "", "AWS_BEARER_TOKEN_BEDROCK": "",
	}
	if !reflect.DeepEqual(settings.Env, want) {
		t.Fatalf("pinned env = %v, want %v", settings.Env, want)
	}
	if settings.Hooks == nil || !settings.DisableClaudeAiConnectors {
		t.Fatal("pinning dropped the rest of the flag settings")
	}
	if err := pinLocalProviderSettings([]string{"-p"}, agent, execDir); err == nil {
		t.Fatal("a local job with no flag settings file would start unpinned")
	}
}

func TestRunnerDeclaresLocalProviderRun(t *testing.T) {
	if !strings.Contains(","+runnerCapabilitiesV1+",", ","+localProviderRunCapabilityV1+",") {
		t.Fatal("the runner does not declare " + localProviderRunCapabilityV1)
	}
}
