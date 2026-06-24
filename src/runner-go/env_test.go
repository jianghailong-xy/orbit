package main

import (
	"os"
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
