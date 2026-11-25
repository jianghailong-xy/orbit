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
// paragraph and the re-read paragraph the appended prompt skips (primerFor). The lead is the one paragraph sent on
// both channels, on purpose: it says what Orbit is for and carries the primer's version. Every session shape the
// snapshots take is checked.
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
		if want := primerFor("orbit mcp initialize, claude"); initialize != want {
			t.Errorf("%s: initialize answers %q, want the primer's lead and the paragraph the appended prompt leaves out", shape.name, initialize)
		}
		both := appended + "\n\n" + initialize
		primer := primerFor("claude")
		if shape.orchestration {
			primer = strings.Replace(primer, agentPrimerOrchestration+"\n\n", "", 1)
		}
		if n := strings.Count(both, primer); n != 1 {
			t.Errorf("%s: the primer appears %d times across the appended prompt and initialize, want 1", shape.name, n)
		}
		// Every paragraph of the whole primer reaches the session, the re-read one through initialize alone.
		whole := agentPrimer
		if shape.orchestration {
			whole = strings.Replace(whole, agentPrimerOrchestration+"\n\n", "", 1)
		}
		for _, paragraph := range strings.Split(whole, "\n\n") {
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

// alwaysOnBudget is what Orbit's always-on text may cost one session shape (design §4.5): its bytes, and its rules,
// counted as the paragraphs composed (each unit is one paragraph and states one or two rules). Claude Code's figure is
// its appended prompt's Orbit part (without the agent's own prompt and the checkout notes) plus the initialize
// instructions; Codex's is its application context's Orbit part, the text it is given again every turn.
type alwaysOnBudget struct {
	claudeBytes, claudeRules, codexBytes, codexRules int
}

// alwaysOnBudgets caps each canonical shape (instructionSnapshotShapes) at what it took after design step 5, measured
// with alwaysOnBudgetCLI. A change that needs more raises the cap here, in review, with the unit it adds and the eval
// case that guards it; a change that saves bytes lowers it. The project's goal for the longest Claude Code shape is
// claudeCodeAlwaysOnGoalBytes.
var alwaysOnBudgets = map[string]alwaysOnBudget{
	"free-watch-toplevel-workflows":                              {claudeBytes: 5499, claudeRules: 17, codexBytes: 5164, codexRules: 16},
	"free-watch-toplevel-noworkflows":                            {claudeBytes: 5499, claudeRules: 17, codexBytes: 5164, codexRules: 16},
	"free-watch-subagent-workflows":                              {claudeBytes: 4009, claudeRules: 13, codexBytes: 3590, codexRules: 12},
	"free-nowatch-toplevel-workflows":                            {claudeBytes: 5358, claudeRules: 16, codexBytes: 5023, codexRules: 15},
	"free-nowatch-toplevel-noworkflows":                          {claudeBytes: 5358, claudeRules: 16, codexBytes: 5023, codexRules: 15},
	"free-nowatch-subagent-workflows":                            {claudeBytes: 3868, claudeRules: 12, codexBytes: 3449, codexRules: 11},
	"task-watch-toplevel-workflows":                              {claudeBytes: 5091, claudeRules: 17, codexBytes: 4756, codexRules: 16},
	"task-watch-toplevel-noworkflows":                            {claudeBytes: 5091, claudeRules: 17, codexBytes: 4756, codexRules: 16},
	"task-watch-subagent-workflows":                              {claudeBytes: 4009, claudeRules: 13, codexBytes: 3590, codexRules: 12},
	"task-nowatch-toplevel-workflows":                            {claudeBytes: 4950, claudeRules: 16, codexBytes: 4615, codexRules: 15},
	"task-nowatch-toplevel-noworkflows":                          {claudeBytes: 4950, claudeRules: 16, codexBytes: 4615, codexRules: 15},
	"task-nowatch-subagent-workflows":                            {claudeBytes: 3868, claudeRules: 12, codexBytes: 3449, codexRules: 11},
	"task-watch-toplevel-workflows-drive":                        {claudeBytes: 5091, claudeRules: 17, codexBytes: 4756, codexRules: 16},
	"free-watch-toplevel-workflows-systemprompt":                 {claudeBytes: 5499, claudeRules: 17, codexBytes: 5164, codexRules: 16},
	"task-watch-subagent-workflows-systemprompt":                 {claudeBytes: 4009, claudeRules: 13, codexBytes: 3590, codexRules: 12},
	"free-watch-toplevel-workflows-bare":                         {claudeBytes: 5499, claudeRules: 17, codexBytes: 5164, codexRules: 16},
	"task-watch-toplevel-workflows-orchestration-nowiki-browser": {claudeBytes: 4716, claudeRules: 15, codexBytes: 4381, codexRules: 14},
	"task-watch-toplevel-workflows-checkonly":                    {claudeBytes: 4168, claudeRules: 14, codexBytes: 3749, codexRules: 13},
}

// claudeCodeAlwaysOnGoalBytes is the instruction-units project's goal for the longest Claude Code shape (criterion
// 5CM9pGWkpF2H9phd7Np21g). It is logged against, not enforced: the caps above are what the measured steps reached.
const claudeCodeAlwaysOnGoalBytes = 6200

// alwaysOnBudgetCLI is a CLI path longer than any runner's, so a shape measured with it fits its cap on every runner.
const alwaysOnBudgetCLI = "/home/a-long-account-name/.orbit/bin/versions/0.1.999/orbit"

// alwaysOnCost is one shape's always-on text on Claude Code and Codex, by bytes and by paragraphs.
func alwaysOnCost(t *testing.T, shape instructionSnapshotShape) alwaysOnBudget {
	t.Helper()
	fakeDriveMount(t, shape.drive)
	driveParentPath = driveRootPath // the root a Pod has, as the snapshots name it
	job := shape.job(t)
	session := job.sessionShape(alwaysOnBudgetCLI)
	claude := claudeOrbitInstructions(session)
	initialize := claudeSessionInitializeInstructions(t, job)
	codex := compose(session, codexProfile).System
	paragraphs := func(texts ...string) int {
		n := 0
		for _, text := range texts {
			if text != "" {
				n += len(strings.Split(text, "\n\n"))
			}
		}
		return n
	}
	return alwaysOnBudget{claudeBytes: len(claude) + len(initialize), claudeRules: paragraphs(claude, initialize),
		codexBytes: len(codex), codexRules: paragraphs(codex)}
}

// Every shape's always-on text, logged, and held to its caps: a shape over its byte cap or its rule cap fails.
func TestAlwaysOnBudgetPerShape(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	longest, longestName := 0, ""
	for _, shape := range instructionSnapshotShapes() {
		cost := alwaysOnCost(t, shape)
		cap, ok := alwaysOnBudgets[shape.name]
		t.Logf("%s: Claude Code %d bytes, %d rules (cap %d, %d); Codex %d bytes, %d rules (cap %d, %d)", shape.name,
			cost.claudeBytes, cost.claudeRules, cap.claudeBytes, cap.claudeRules, cost.codexBytes, cost.codexRules, cap.codexBytes, cap.codexRules)
		if cost.claudeBytes > longest {
			longest, longestName = cost.claudeBytes, shape.name
		}
		if !ok {
			t.Errorf("%s has no always-on budget in alwaysOnBudgets", shape.name)
			continue
		}
		if cost.claudeBytes > cap.claudeBytes || cost.claudeRules > cap.claudeRules {
			t.Errorf("%s on Claude Code: %d bytes and %d rules, over its cap of %d bytes and %d rules", shape.name,
				cost.claudeBytes, cost.claudeRules, cap.claudeBytes, cap.claudeRules)
		}
		if cost.codexBytes > cap.codexBytes || cost.codexRules > cap.codexRules {
			t.Errorf("%s on Codex: %d bytes and %d rules, over its cap of %d bytes and %d rules", shape.name,
				cost.codexBytes, cost.codexRules, cap.codexBytes, cap.codexRules)
		}
	}
	for name := range alwaysOnBudgets {
		found := false
		for _, shape := range instructionSnapshotShapes() {
			found = found || shape.name == name
		}
		if !found {
			t.Errorf("alwaysOnBudgets caps %s, which is no shape", name)
		}
	}
	t.Logf("longest Claude Code shape: %s, %d bytes (the project's goal is %d)", longestName, longest, claudeCodeAlwaysOnGoalBytes)
}
