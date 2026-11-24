package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// claudeSessionInitializeInstructions is what `orbit mcp` answers initialize with inside job's Claude Code session:
// the server built from the session's environment, with the env the orbit entry of the mcp.json that
// claudeCommandArgs writes layered over it, as Claude Code layers it.
func claudeSessionInitializeInstructions(t *testing.T, job *ClaimedSession) string {
	t.Helper()
	scratch := t.TempDir()
	claudeCommandArgs(job, scratch, true)
	raw, err := os.ReadFile(filepath.Join(scratch, "mcp.json"))
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		Servers map[string]struct {
			Args []string          `json:"args"`
			Env  map[string]string `json:"env"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal(raw, &config); err != nil {
		t.Fatal(err)
	}
	orbit, ok := config.Servers["orbit"]
	if !ok || len(orbit.Args) != 1 || orbit.Args[0] != "mcp" {
		t.Fatalf("the mcp.json declares no `orbit mcp` server: %s", raw)
	}
	env := map[string]string{
		"ORBIT_SESSION_ID":  publicID(job.SessionID),
		"ORBIT_TASK_ID":     publicID(job.TaskID),
		envMCPOrchestration: orchestrationEnv(job.AllowOrchestration),
		envMCPEngine:        "",
	}
	for key, value := range orbit.Env {
		env[key] = value
	}
	return initializeInstructionsWithEnv(t, env)
}

// initializeInstructionsWithEnv is what `orbit mcp` started with env answers initialize with. The process's own
// environment is put back afterwards, so the carriers built after it read what they did before.
func initializeInstructionsWithEnv(t *testing.T, env map[string]string) string {
	t.Helper()
	for key, value := range env {
		previous, had := os.LookupEnv(key)
		os.Setenv(key, value)
		defer func(key, previous string, had bool) {
			if had {
				os.Setenv(key, previous)
			} else {
				os.Unsetenv(key)
			}
		}(key, previous, had)
	}
	resp, _ := mcpServerFromEnv(nil).handle(&rpcRequest{JSONRPC: "2.0", ID: json.RawMessage("1"), Method: "initialize"})
	return resp.Result.(map[string]interface{})["instructions"].(string)
}

// A Claude Code session is given the primer once (design §4.3). Its appended system prompt carries the whole of it,
// and `orbit mcp`, told by the runner's mcp.json that it serves Claude Code, answers initialize with the lead
// paragraph only. The lead is the one paragraph sent on both channels, on purpose: it says what Orbit is for and
// carries the primer's version. Every session shape the snapshots take is checked.
func TestClaudeCodeSessionIsGivenThePrimerOnce(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	for _, shape := range instructionSnapshotShapes() {
		job := shape.job(t)
		args := claudeCommandArgs(job, t.TempDir(), true)
		appended := ""
		for i, arg := range args {
			if arg == "--append-system-prompt" && i+1 < len(args) {
				appended = args[i+1]
			}
		}
		initialize := claudeSessionInitializeInstructions(t, job)
		if initialize != agentPrimerLead {
			t.Errorf("%s: initialize answers %q, want the primer's lead paragraph only", shape.name, initialize)
		}
		both := appended + "\n\n" + initialize
		primer := primerFor("claude")
		if shape.orchestration {
			primer = strings.Replace(primer, agentPrimerOrchestration+"\n\n", "", 1)
		}
		if n := strings.Count(both, primer); n != 1 {
			t.Errorf("%s: the primer appears %d times across the appended prompt and initialize, want 1", shape.name, n)
		}
		for _, paragraph := range strings.Split(primer, "\n\n") {
			want := 1
			if paragraph == agentPrimerLead {
				want = 2 // the safety unit, once in each
			}
			if n := strings.Count(both, paragraph); n != want {
				t.Errorf("%s: primer paragraph %.60q... appears %d times, want %d", shape.name, paragraph, n, want)
			}
		}
	}
}

// Outside a runner session `orbit mcp` has no engine carrier beside it, so it answers initialize with the whole
// primer, whatever ORBIT_MCP_ENGINE says. So does a session whose runner did not name the engine: every engine but
// Claude Code, and a Claude Code session whose appended prompt could not carry Orbit's text.
func TestBareOrbitMCPAnswersWithTheWholePrimer(t *testing.T) {
	for _, env := range []map[string]string{
		{"ORBIT_SESSION_ID": "", envMCPEngine: ""},
		{"ORBIT_SESSION_ID": "", envMCPEngine: providerClaude},
		{"ORBIT_SESSION_ID": "s-other-engine", envMCPEngine: ""},
		{"ORBIT_SESSION_ID": "s-unknown-engine", envMCPEngine: "no-such-engine"},
	} {
		env[envMCPOrchestration] = "0"
		if got := initializeInstructionsWithEnv(t, env); got != agentPrimer {
			t.Errorf("orbit mcp with %v answers initialize with %q, want the whole primer", env, got)
		}
	}
	// A CLI path that cannot be printed into the appended prompt leaves Orbit's text out of it, and then initialize
	// is not told the carrier has it.
	if got := claudeOrbitInstructions(SessionShape{Role: roleTaskRun, CLI: "/opt/orbit,(x)/orbit"}); got != "" {
		t.Errorf("an unprintable CLI path still gave Claude Code Orbit's text: %q", got)
	}
}
