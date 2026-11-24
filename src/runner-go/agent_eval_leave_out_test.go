package main

// Running the eval without one or more instruction units (instruction_units.go, docs/agent-contract-eval.md §Leaving a
// unit out). ORBIT_AGENT_EVAL_LEAVE_OUT names the units, comma-separated (scripts/agent-eval.sh live --leave-out). The
// eval process builds every engine's instructions itself (claudeCommandArgs, codexAgentContext), so it sets
// instructionUnitsLeftOut for itself; and the session's `orbit mcp` and `orbit` CLI are this same test binary in other
// processes, which an engine may start with only the variables it passes on (Codex passes a fixed list to an MCP
// server), so each run also leaves the list in a file in its ORBIT_HOME, which every one of them is given, and they
// read it as they start (init in agent_eval_session_test.go).

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

const (
	evalLeaveOutEnv = "ORBIT_AGENT_EVAL_LEAVE_OUT"
	// evalLeaveOutMarker, in a run's ORBIT_HOME, lists the units the run's processes leave out, one per line.
	evalLeaveOutMarker = "eval-leave-out"
)

// parseInstructionUnits reads a comma-separated list of unit ids, refusing one that names no unit: a typo would
// otherwise measure the full instructions under the name of a run without one.
func parseInstructionUnits(list string) (map[string]bool, error) {
	known := map[string]bool{}
	for _, id := range instructionUnitIDs {
		known[id] = true
	}
	out := map[string]bool{}
	for _, id := range strings.FieldsFunc(list, func(r rune) bool { return r == ',' || r == '\n' || r == ' ' }) {
		if !known[id] {
			return nil, fmt.Errorf("%q names no instruction unit; the units are %s", id, strings.Join(instructionUnitIDs, ", "))
		}
		out[id] = true
	}
	if len(out) == 0 {
		return nil, nil
	}
	return out, nil
}

// evalLeftOutList is the units this process leaves out, sorted, or nil.
func evalLeftOutList() []string {
	var out []string
	for id := range instructionUnitsLeftOut {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// useEvalLeaveOut sets the units the eval leaves out from ORBIT_AGENT_EVAL_LEAVE_OUT, for the test's length.
func useEvalLeaveOut(t *testing.T) {
	t.Helper()
	units, err := parseInstructionUnits(os.Getenv(evalLeaveOutEnv))
	if err != nil {
		t.Fatalf("%s: %v", evalLeaveOutEnv, err)
	}
	setEvalLeaveOut(t, units)
}

func setEvalLeaveOut(t *testing.T, units map[string]bool) {
	t.Helper()
	previous := instructionUnitsLeftOut
	instructionUnitsLeftOut = units
	t.Cleanup(func() { instructionUnitsLeftOut = previous })
}

// writeEvalLeaveOutMarker leaves this process's list in a run's home for the run's other processes.
func writeEvalLeaveOutMarker(home string) error {
	if len(instructionUnitsLeftOut) == 0 {
		return nil
	}
	return os.WriteFile(filepath.Join(home, evalLeaveOutMarker), []byte(strings.Join(evalLeftOutList(), "\n")+"\n"), 0o600)
}

// readEvalLeaveOutMarker is a run's `orbit mcp` or CLI taking up the list its run left in ORBIT_HOME. A list it cannot
// read is a harness failure the run must not pass over: the process says so and exits.
func readEvalLeaveOutMarker() {
	home := os.Getenv("ORBIT_HOME")
	if home == "" {
		return
	}
	raw, err := os.ReadFile(filepath.Join(home, evalLeaveOutMarker))
	if err != nil {
		return
	}
	units, err := parseInstructionUnits(string(raw))
	if err != nil {
		fmt.Fprintln(os.Stderr, "orbit: this eval run's", evalLeaveOutMarker, "file:", err)
		os.Exit(1)
	}
	instructionUnitsLeftOut = units
}

// Leaving a unit out takes away its paragraph and nothing else, in every engine's instructions; with none left out
// they are the text they were before units had ids, which the snapshots under testdata/agent-primer/ pin.
func TestInstructionUnitsLeaveOutOnlyTheirParagraph(t *testing.T) {
	const exe = "/usr/local/bin/orbit"
	full := orbitCLIInstructions(exe, true, true, true, true) // the longest shape: every unit has text in it
	paragraphs := strings.Split(full, "\n\n")
	if len(paragraphs) != len(instructionUnitIDs) {
		t.Fatalf("the longest shape has %d paragraphs, and there are %d units", len(paragraphs), len(instructionUnitIDs))
	}
	for i, id := range instructionUnitIDs {
		setEvalLeaveOut(t, map[string]bool{id: true})
		got := orbitCLIInstructions(exe, true, true, true, true)
		primer := agentPrimerText()
		instructionUnitsLeftOut = nil
		want := strings.Join(append(append([]string(nil), paragraphs[:i]...), paragraphs[i+1:]...), "\n\n")
		if got != want {
			t.Errorf("without %s the instructions are not the full text less paragraph %d:\n%s", id, i, got)
		}
		if i < len(agentPrimerUnits) {
			if strings.Contains(primer, agentPrimerUnits[i].text) || len(primer) != len(agentPrimer)-len(agentPrimerUnits[i].text)-2 {
				t.Errorf("without %s the primer `initialize` sends still holds it, or lost more", id)
			}
		} else if primer != agentPrimer {
			t.Errorf("without %s the primer changed", id)
		}
	}
	if orbitCLIInstructions(exe, true, true, true, true) != full || agentPrimerText() != agentPrimer {
		t.Error("with nothing left out the instructions are not what they were")
	}
	if _, err := parseInstructionUnits("wait,no-such-unit"); err == nil {
		t.Error("a list naming no unit was taken")
	}
}

// A run's `orbit mcp` is another process, which an engine starts with what it passes on: it reads the units its run
// leaves out from the run's ORBIT_HOME, and its `initialize` instructions leave them out too.
func TestAgentEvalLeaveOutReachesTheSessionsMCPServer(t *testing.T) {
	evalUseScratchHome(t)
	setEvalLeaveOut(t, map[string]bool{unitPrimerSettings: true})
	s, err := newEvalSession(evalScenarioByID("I8-settings-propose"), providerClaude)
	if err != nil {
		t.Fatal(err)
	}
	defer s.close()
	client, err := startEvalMCPClient(s.ctx, s.exe, s.env(true), s.work)
	if err != nil {
		t.Fatal(err)
	}
	defer client.close()
	if strings.Contains(client.instructions, agentPrimerSettings) || !strings.Contains(client.instructions, agentPrimerLead) {
		t.Errorf("initialize instructions with %s left out:\n%s", unitPrimerSettings, client.instructions)
	}
	if strings.Contains(orbitCLIInstructionsFor(s.job, s.exe), agentPrimerSettings) {
		t.Errorf("the engine's instructions still carry %s", unitPrimerSettings)
	}
}
