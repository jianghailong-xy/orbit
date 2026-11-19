//go:build linux || darwin

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// `orbit mcp` halves its session_create(wait) budget per level of nesting (sessionWaitPolls) and reads the
// level from ORBIT_SPAWN_DEPTH, and so does the `orbit` CLI an agent runs from its shell (session_cli.go). A
// session started by another one that does not carry it waits a root session's whole budget, and can
// outlast the wait above it. Each engine below is started for real, on a stand-in that writes down the
// environment it was given; Codex is codex_session_env_test.go.

// Kimi declares Orbit's server with an empty env on purpose (kimiMCPConfigRecord), so `orbit mcp` inherits
// the kimi process's environment, and that process is where the depth has to be.
func TestKimiCarriesTheSpawnDepthToOrbitMCP(t *testing.T) {
	job := spawnDepthJob(t)
	capture := fakeEngineCapturingEnv(t, providerKimi)
	dir := t.TempDir()
	app, err := startKimiACP(context.Background(), NewTransport("http://127.0.0.1:1", "runner-token"), job, dir,
		filepath.Join(dir, "kimi-home"), func(string, map[string]interface{}) {})
	if err != nil {
		t.Fatal(err)
	}
	defer app.close()
	assertCarriesSpawnDepth(t, "kimi", readCapturedEnv(t, capture), "2")
}

// OpenCode hands its local MCP servers the environment block its configuration declares for them
// (TestOpenCodeRunnerOwnedJobSurvivesItsEngine), so the depth goes in that block for `orbit mcp`, and in the
// process for the shell. The block is read from the configuration the process was started with.
func TestOpenCodeCarriesTheSpawnDepthToOrbitMCP(t *testing.T) {
	job := spawnDepthJob(t)
	capture := fakeEngineCapturingEnv(t, providerOpenCode)
	dir := t.TempDir()
	runOpenCodeTurn(context.Background(), job, dir, dir, "hello", nil, func(string, map[string]interface{}) {})
	env := readCapturedEnv(t, capture)
	assertCarriesSpawnDepth(t, "opencode", env, "2")

	content := envValue(env, "OPENCODE_CONFIG_CONTENT")
	var config struct {
		MCP map[string]struct {
			Environment map[string]string `json:"environment"`
		} `json:"mcp"`
	}
	if err := json.Unmarshal([]byte(content), &config); err != nil {
		t.Fatalf("opencode was started without a configuration it can read: %v: %q", err, content)
	}
	orbit, ok := config.MCP["orbit"]
	if !ok {
		t.Fatalf("opencode's configuration declares no orbit MCP server: %s", content)
	}
	if got, ok := orbit.Environment[envSpawnDepth]; !ok || got != "2" {
		t.Fatalf("the orbit MCP server's environment block sets %s=%q (present %v), want %q", envSpawnDepth, got, ok, "2")
	}
}

// agy declares Orbit's server with an empty env too (antigravityMCPServers), so `orbit mcp` inherits agy's
// environment: on an API key, and on the runner's Google sign-in, whose environment is the same one with the
// key's variables taken out (antigravityGoogleEnv).
func TestAntigravityCarriesTheSpawnDepthToOrbitMCP(t *testing.T) {
	job := spawnDepthJob(t)
	capture := fakeEngineCapturingEnv(t, agyExecutable)
	for _, google := range []bool{false, true} {
		_ = os.Remove(capture)
		dir := t.TempDir()
		proc, err := startAgyProcess(context.Background(), job, dir, filepath.Join(dir, "gemini"), google, nil,
			func(string, map[string]interface{}) {})
		if err != nil {
			t.Fatal(err)
		}
		env := readCapturedEnv(t, capture)
		proc.stop(time.Second)
		assertCarriesSpawnDepth(t, fmt.Sprintf("agy (Google sign-in %v)", google), env, "2")
	}
}

// spawnDepthJob is a claim two links below its root, run by a runner whose own environment and whose agent
// configuration both name another depth: what the engine carries has to be the claim's.
func spawnDepthJob(t *testing.T) *ClaimedSession {
	t.Helper()
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv(envSpawnDepth, "5")
	return &ClaimedSession{SessionID: "session-depth", SpawnDepth: 2,
		Agent: AgentExecConfig{Env: map[string]string{envSpawnDepth: "7"}}}
}

// assertCarriesSpawnDepth fails unless env sets ORBIT_SPAWN_DEPTH once, to want.
func assertCarriesSpawnDepth(t *testing.T, engine string, env []string, want string) {
	t.Helper()
	var got []string
	for _, entry := range env {
		if value, ok := strings.CutPrefix(entry, envSpawnDepth+"="); ok {
			got = append(got, value)
		}
	}
	if len(got) != 1 || got[0] != want {
		t.Fatalf("%s was started with %s set to %q, want %q alone", engine, envSpawnDepth, got, want)
	}
}
