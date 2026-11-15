//go:build linux || darwin

package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A Codex session that another session started has to tell `orbit mcp` how deep it sits, or its
// session_create(wait) gets a root session's whole budget and can outlast the wait above it
// (sessionWaitPolls). Codex hands its MCP servers an allowlist rather than its own environment, so each
// variable of the session context has to be both set by the spawn and named on that list: ORBIT_SPAWN_DEPTH
// was missing from both, which no test of either half alone could see.
func TestCodexForwardsTheWholeSessionContextToOrbitMCP(t *testing.T) {
	job := &ClaimedSession{SessionID: "11111111-1111-4111-8111-111111111111", AgentID: "agent", TaskID: "task",
		SpawnDepth: 3, AllowOrchestration: true}
	allowlist := codexMCPEnvAllowlist(t)
	got := map[string]string{}
	for _, pair := range codexOrbitSessionEnv(job) {
		key, value, _ := strings.Cut(pair, "=")
		got[key] = value
		if !allowlist[key] {
			t.Errorf("the Codex spawn sets %s, which codexOrbitMCPEnvVarsConfig does not pass to `orbit mcp`", key)
		}
	}
	// What `orbit mcp` reads of the session it serves, as the Claude spawn exports it (claude_spawn.go).
	for name, want := range map[string]string{
		"ORBIT_SESSION_ID": publicID(job.SessionID), "ORBIT_AGENT_ID": publicID("agent"), "ORBIT_TASK_ID": publicID("task"),
		envMCPOrchestration: "1", envWatches: watchesEnv(false), envWiki: wikiEnv(false), envMCPPermissionPrompt: "0",
		envSpawnDepth: "3",
	} {
		if got[name] != want {
			t.Errorf("the Codex spawn sets %s=%q, want %q", name, got[name], want)
		}
	}
	// The rest of what `orbit mcp` needs comes from elsewhere in the spawn, and is on the list as well: the runner's
	// mark among them, without which the Plan gate reads a session process with no socket as a terminal.
	for _, name := range []string{"ORBIT_HOME", envBgSocket, envBgToken, envRunnerChild, envManagedRunnerGeneration, envManagedRunnerPodUID} {
		if !allowlist[name] {
			t.Errorf("codexOrbitMCPEnvVarsConfig does not pass %s to `orbit mcp`", name)
		}
	}
}

// Both spawn paths put the depth in the process they start: the app-server a session runs on, and
// `codex exec`.
func TestBothCodexSpawnsCarryTheSpawnDepth(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	dir, bin := t.TempDir(), t.TempDir()
	envFile := filepath.Join(dir, "env.txt")
	writeFakeBin(t, bin, "codex", "env > "+shellQuote(envFile)+"\nexec cat >/dev/null")
	t.Setenv("PATH", bin+":/usr/bin:/bin")
	job := &ClaimedSession{SessionID: "session-depth", SpawnDepth: 2}

	app, err := startCodexAppServer(context.Background(), job, dir, dir, envWithAgent(job.Agent.Env),
		func(string, map[string]interface{}) {}, nil)
	if err != nil {
		t.Fatal(err)
	}
	assertSpawnDepthInEnvFile(t, envFile, "2")
	app.close()

	_ = os.Remove(envFile)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	writeFakeBin(t, bin, "codex", "env > "+shellQuote(envFile))
	runCodexTurn(ctx, job, dir, "hello", nil, func(string, map[string]interface{}) {})
	assertSpawnDepthInEnvFile(t, envFile, "2")
}

func assertSpawnDepthInEnvFile(t *testing.T, path, want string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		raw, err := os.ReadFile(path)
		if err == nil && strings.Contains(string(raw), "\n") {
			for _, line := range strings.Split(string(raw), "\n") {
				if value, ok := strings.CutPrefix(line, envSpawnDepth+"="); ok {
					if value != want {
						t.Fatalf("codex started with %s=%s, want %s", envSpawnDepth, value, want)
					}
					return
				}
			}
			t.Fatalf("codex started without %s", envSpawnDepth)
		}
		if time.Now().After(deadline) {
			t.Fatalf("codex never wrote its environment: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// codexMCPEnvAllowlist is the names codexOrbitMCPEnvVarsConfig passes to `orbit mcp`.
func codexMCPEnvAllowlist(t *testing.T) map[string]bool {
	t.Helper()
	_, list, ok := strings.Cut(codexOrbitMCPEnvVarsConfig, "=")
	if !ok {
		t.Fatalf("codexOrbitMCPEnvVarsConfig = %q", codexOrbitMCPEnvVarsConfig)
	}
	var names []string
	if err := json.Unmarshal([]byte(list), &names); err != nil {
		t.Fatalf("codexOrbitMCPEnvVarsConfig is not a list of names: %v", err)
	}
	allowlist := map[string]bool{}
	for _, name := range names {
		allowlist[name] = true
	}
	return allowlist
}
