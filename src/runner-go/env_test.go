package main

import (
	"os"
	"strings"
	"testing"
)

// envWithAgent is shared by the claude process and `!`-shells; both must see the runner's
// own environment with the agent's custom vars layered on top.
func TestEnvWithAgent(t *testing.T) {
	os.Setenv("ORBIT_TEST_BASE", "base")
	defer os.Unsetenv("ORBIT_TEST_BASE")

	env := envWithAgent(map[string]string{"FOO": "bar"})

	var sawBase, sawAgent bool
	for _, e := range env {
		switch e {
		case "ORBIT_TEST_BASE=base":
			sawBase = true
		case "FOO=bar":
			sawAgent = true
		}
	}
	if !sawBase {
		t.Error("runner's own env should be preserved")
	}
	if !sawAgent {
		t.Error("agent's custom env should be injected")
	}
}

// A session with no custom env must still get the runner's own environment.
func TestEnvWithAgentNil(t *testing.T) {
	if len(envWithAgent(nil)) == 0 {
		t.Error("nil agent env should still return the runner's environment")
	}
}

func TestEnvWithAgentKeepsRunnerHomeReserved(t *testing.T) {
	t.Setenv("ORBIT_HOME", "/runner/home")
	env := envWithAgent(map[string]string{
		"ORBIT_HOME":                  "/agent/home",
		"ORBIT_SESSION_ID":            "agent-session",
		"orbit_allow_orchestration":   "1",
		"orbit_orchestration_token":   "agent-token",
		"ORBIT_MCP_PERMISSION_PROMPT": "1",
	})
	for _, entry := range env {
		key, _, _ := strings.Cut(entry, "=")
		if strings.EqualFold(key, "ORBIT_HOME") && entry != "ORBIT_HOME=/runner/home" {
			t.Fatalf("agent environment overrode reserved ORBIT_HOME: %q", entry)
		}
		if sessionContextEnvKey(key) {
			t.Fatalf("agent environment injected reserved session context: %q", entry)
		}
	}
}

func TestClearInheritedSessionContext(t *testing.T) {
	reserved := []string{
		"ORBIT_SESSION_ID",
		"ORBIT_AGENT_ID",
		"ORBIT_TASK_ID",
		envMCPOrchestration,
		envOrchestrationToken,
		envMCPPermissionPrompt,
	}
	for _, key := range reserved {
		t.Setenv(key, "stale-launchd-context")
	}
	clearInheritedSessionContext()
	for _, key := range reserved {
		if _, ok := os.LookupEnv(key); ok {
			t.Fatalf("runner mode retained inherited %s", key)
		}
	}
}
