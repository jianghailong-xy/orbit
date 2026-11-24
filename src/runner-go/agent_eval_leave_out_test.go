package main

// Running the eval without one or more instruction units (the registry's instructionUnits, by id;
// docs/agent-contract-eval.md §Leaving a unit out). ORBIT_AGENT_EVAL_LEAVE_OUT names the units, comma-separated
// (scripts/agent-eval.sh live --leave-out), and compose drops each of them from every channel. The eval process builds
// every engine's instructions itself (claudeCommandArgs, codexAgentContext), so it sets instructionUnitsLeftOut for
// itself; and the session's `orbit mcp` and `orbit` CLI are this same test binary in other
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
	var ids []string
	for _, unit := range instructionUnits {
		known[unit.id] = true
		ids = append(ids, unit.id)
	}
	out := map[string]bool{}
	for _, id := range strings.FieldsFunc(list, func(r rune) bool { return r == ',' || r == '\n' || r == ' ' }) {
		if !known[id] {
			return nil, fmt.Errorf("%q names no instruction unit; the units are %s", id, strings.Join(ids, ", "))
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

// Leaving a unit out takes away its paragraph and nothing else, on both channels and every engine; with none left
// out compose is what it was, which TestEngineInstructionSnapshots pins against testdata/agent-instructions.
func TestInstructionUnitsLeaveOutOnlyTheirParagraph(t *testing.T) {
	const exe = "/usr/local/bin/orbit"
	shapes := []SessionShape{
		{Role: roleTaskRun, InsideRecordedWork: true, Watches: true, Wiki: true, Workflows: true, CLI: exe},
		{Role: roleTopLevel, Watches: true, Wiki: true, Workflows: true, CLI: exe},
		{Role: roleTopLevel, Watches: true, Wiki: true, Workflows: true, DriveMounted: true, CLI: exe},
		{Role: roleHelpAsk, CLI: exe},
	}
	seen := map[string]bool{}
	for _, profile := range engineProfiles {
		for _, shape := range shapes {
			full := compose(shape, profile)
			for _, unit := range instructionUnits {
				applies := unit.appliesTo(shape) && shape.serves(unit.tools)
				setEvalLeaveOut(t, map[string]bool{unit.id: true})
				without := compose(shape, profile)
				instructionUnitsLeftOut = nil
				text := renderInstructionUnit(unit.core, shape, profile)
				for _, ch := range []struct {
					channel     instructionChannel
					full, gotIt string
				}{{channelSystem, full.System, without.System}, {channelMCP, full.MCP, without.MCP}} {
					want := ch.full
					if applies && unit.deliveredOn(ch.channel) {
						seen[unit.id] = true
						want = strings.Join(removeParagraph(strings.Split(ch.full, "\n\n"), text), "\n\n")
					}
					if ch.gotIt != want {
						t.Errorf("%s on %s, %s: leaving %s out did not take away exactly its paragraph", profile.Engine, shape.Role, ch.channel, unit.id)
					}
				}
			}
			if again := compose(shape, profile); again != full {
				t.Errorf("%s on %s: with nothing left out compose is not what it was", profile.Engine, shape.Role)
			}
		}
	}
	for _, unit := range instructionUnits {
		if !seen[unit.id] {
			t.Errorf("no shape here composes %s, so its leaving out is untested", unit.id)
		}
	}
	if _, err := parseInstructionUnits("wait.use-await,no-such-unit"); err == nil {
		t.Error("a list naming no unit was taken")
	}
}

// removeParagraph is paragraphs without the one that is text.
func removeParagraph(paragraphs []string, text string) []string {
	var out []string
	removed := false
	for _, p := range paragraphs {
		if p == text && !removed {
			removed = true
			continue
		}
		out = append(out, p)
	}
	return out
}

// A run's `orbit mcp` is another process, which an engine starts with what it passes on: it reads the units its run
// leaves out from the run's ORBIT_HOME, and its `initialize` instructions leave them out too.
func TestAgentEvalLeaveOutReachesTheSessionsMCPServer(t *testing.T) {
	evalUseScratchHome(t)
	setEvalLeaveOut(t, map[string]bool{"primer.settings": true})
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
		t.Errorf("initialize instructions with primer.settings left out:\n%s", client.instructions)
	}
	if strings.Contains(orbitCLIInstructionsFor(s.job, s.exe), agentPrimerSettings) {
		t.Error("the engine's instructions still carry primer.settings")
	}
}

// Every I scenario names the units it guards by the registry's ids, and each of those units names the scenario back
// in its guardedBy: one namespace, read from both ends.
func TestAgentEvalIScenariosAndTheirUnitsNameEachOther(t *testing.T) {
	units := map[string]instructionUnit{}
	for _, unit := range instructionUnits {
		units[unit.id] = unit
	}
	for _, sc := range evalScenarios() {
		if !strings.HasPrefix(sc.ID, "I") {
			continue
		}
		if len(sc.Guards) == 0 {
			t.Errorf("%s guards no unit", sc.ID)
		}
		for _, id := range sc.Guards {
			unit, ok := units[id]
			if !ok {
				t.Errorf("%s guards %q, which is no unit of the registry", sc.ID, id)
				continue
			}
			named := false
			for _, guard := range unit.guardedBy {
				named = named || guard == sc.ID
			}
			if !named {
				t.Errorf("unit %s does not name %s in guardedBy", id, sc.ID)
			}
		}
	}
}

// For every I scenario, a run of its session with the unit it guards left out: the unit's text is in neither the
// engine's instructions (Claude Code's appended prompt, Codex's application context) nor `orbit mcp` initialize, and
// is in them with nothing left out. It logs each composed text's sha256, with and without.
func TestAgentEvalEachIScenarioRunsWithoutItsUnit(t *testing.T) {
	evalUseScratchHome(t)
	units := map[string]instructionUnit{}
	for _, unit := range instructionUnits {
		units[unit.id] = unit
	}
	for _, sc := range evalScenarios() {
		if !strings.HasPrefix(sc.ID, "I") {
			continue
		}
		for _, leave := range []bool{false, true} {
			if leave {
				left := map[string]bool{}
				for _, id := range sc.Guards {
					left[id] = true
				}
				setEvalLeaveOut(t, left)
			} else {
				setEvalLeaveOut(t, nil)
			}
			s, err := newEvalSession(sc, providerClaude)
			if err != nil {
				t.Fatal(err)
			}
			client, err := startEvalMCPClient(s.ctx, s.exe, s.env(true), s.work)
			if err != nil {
				s.close()
				t.Fatal(err)
			}
			mcp := client.instructions
			client.close()
			shape := s.job.sessionShape(s.exe)
			claude := orbitCLIInstructionsFor(s.job, s.exe)
			codex := codexAgentContext(s.job.Agent, shape)
			s.close()
			for _, id := range sc.Guards {
				unit := units[id]
				for _, carrier := range []struct {
					name, text string
					profile    EngineProfile
					delivered  bool
				}{
					{"claude", claude, claudeCodeProfile, unit.deliveredOn(channelSystem)},
					{"codex", codex, codexProfile, unit.deliveredOn(channelSystem)},
					{"mcp", mcp, unknownEngineProfile, unit.deliveredOn(channelMCP)},
				} {
					if !carrier.delivered {
						continue
					}
					text := renderInstructionUnit(unit.core, shape, carrier.profile)
					if has := strings.Contains(carrier.text, text); has == leave {
						t.Errorf("%s with %s left out=%v: its text in the %s instructions is %v", sc.ID, id, leave, carrier.name, has)
					}
				}
			}
			t.Logf("%s, %v left out: claude %.12s codex %.12s mcp %.12s", sc.ID, evalLeftOutList(),
				sha256Hex([]byte(claude)), sha256Hex([]byte(codex)), sha256Hex([]byte(mcp)))
		}
	}
}
