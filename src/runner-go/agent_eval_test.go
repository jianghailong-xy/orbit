package main

// The deterministic half of the agent-contract eval (docs/agent-contract-eval.md §Layers): no engine, no model,
// every run in CI. The scenario catalogue covers the contract's eight cases and every situation the eval is asked
// to cover; the golden agent passes every scenario through the real `orbit mcp` and the real CLI, which holds
// Orbit's side of each; and every mistake agent fails the clause written for its mistake, which holds the graders.

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

// evalUseScratchHome gives the eval process an ORBIT_HOME of its own, under which the sessions' sockets live.
func evalUseScratchHome(t *testing.T) {
	t.Helper()
	home, err := os.MkdirTemp("", "p201r")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	t.Setenv("ORBIT_HOME", home)
}

// playScripted runs one scenario with a scripted agent and grades it.
func playScripted(t *testing.T, sc *evalScenario, agents, follow map[int]evalAgent) (*evalRun, string, []evalClauseResult) {
	t.Helper()
	s, err := newEvalSession(sc, providerClaude)
	if err != nil {
		t.Fatalf("%s: %v", sc.ID, err)
	}
	defer s.close()
	run := s.play(&scriptedEngine{agents: agents, follow: follow}, 1, 2*time.Minute)
	verdict, clauses := run.grade()
	return run, verdict, clauses
}

func failedClauses(clauses []evalClauseResult) []string {
	var out []string
	for _, c := range clauses {
		if !c.Passed {
			out = append(out, c.ID+": "+c.Why)
		}
	}
	return out
}

// The suite names every case of the contract's §7, by the ids contracts/orbit-agent.contract.json carries, and
// every situation the eval is asked to cover; every clause has a check and a failure type; ids are unique.
func TestAgentEvalScenarioCatalogCoversTheContract(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "contracts", "orbit-agent.contract.json"))
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		Scenarios []struct {
			Case string `json:"case"`
		} `json:"scenarios"`
	}
	if err := json.Unmarshal(raw, &contract); err != nil {
		t.Fatal(err)
	}
	cases := map[string]bool{}
	covered := map[string]bool{evalCoverVersionDrift: len(evalSupportedMatrix()) > 0}
	ids := map[string]bool{}
	for _, sc := range evalScenarios() {
		if ids[sc.ID] {
			t.Errorf("scenario %s is defined twice", sc.ID)
		}
		ids[sc.ID] = true
		if sc.Case != "" {
			cases[sc.Case] = true
			if !strings.HasPrefix(sc.ID, sc.Case) {
				t.Errorf("scenario %s automates %s but is not named for it", sc.ID, sc.Case)
			}
		}
		for _, c := range sc.Covers {
			covered[c] = true
		}
		if len(sc.Turns) == 0 || sc.Summary == "" {
			t.Errorf("scenario %s has no turns or no summary", sc.ID)
		}
		clauseIDs := map[string]bool{}
		gates := 0
		for _, c := range sc.clauses() {
			if c.Check == nil || c.Failure == "" || c.Says == "" || (c.Kind != "expect" && c.Kind != "must_not" && c.Kind != "pass") {
				t.Errorf("%s: clause %s is incomplete", sc.ID, c.ID)
			}
			if c.Safety && !c.Gate {
				t.Errorf("%s: clause %s is a safety clause that is not a gate", sc.ID, c.ID)
			}
			if clauseIDs[c.ID] {
				t.Errorf("%s: clause %s twice", sc.ID, c.ID)
			}
			clauseIDs[c.ID] = true
			if c.Gate {
				gates++
			}
		}
		if gates == 0 {
			t.Errorf("%s decides nothing: no gate clause", sc.ID)
		}
	}
	for _, s := range contract.Scenarios {
		if !cases[s.Case] {
			t.Errorf("the contract's case %s has no scenario", s.Case)
		}
	}
	if len(contract.Scenarios) != 8 {
		t.Errorf("the contract carries %d cases, want the eight of §7", len(contract.Scenarios))
	}
	for _, c := range evalRequiredCoverage {
		if !covered[c] {
			t.Errorf("nothing covers %s", c)
		}
	}
	// The contract's index lists the suite by id, in the order a report lists it.
	idx, err := readEvalContractIndex()
	if err != nil {
		t.Fatal(err)
	}
	var want []string
	for _, sc := range evalScenarios() {
		want = append(want, sc.ID)
	}
	if strings.Join(idx.Eval.Scenarios, ",") != strings.Join(want, ",") {
		t.Errorf("contracts/orbit-agent.contract.json eval.scenarios = %v, the suite is %v", idx.Eval.Scenarios, want)
	}
	if idx.ContractVersion != agentContractVersion {
		t.Errorf("the contract's index is at %s, the eval grades under %s", idx.ContractVersion, agentContractVersion)
	}
}

// The golden agent does what the contract says in every scenario and passes every clause, gate or advisory:
// what each context offers, the cards, the receipts, the Plan gate and the CLI's door are Orbit's side of the
// scenario, held here on the real `orbit mcp` and the real CLI.
func TestAgentEvalGoldenAgentPassesEveryScenario(t *testing.T) {
	evalUseScratchHome(t)
	for _, sc := range evalScenarios() {
		agents, follow := goldenAgents(sc)
		if agents == nil {
			t.Errorf("%s has no golden agent", sc.ID)
			continue
		}
		run, verdict, clauses := playScripted(t, sc, agents, follow)
		if run.HarnessError != "" {
			t.Errorf("%s: harness: %s", sc.ID, run.HarnessError)
			continue
		}
		if failed := failedClauses(clauses); verdict != evalVerdictPass || len(failed) > 0 {
			t.Errorf("%s: %s\n  %s\n%s", sc.ID, verdict, strings.Join(failed, "\n  "), evalDebugRun(run))
		}
	}
}

// Every mistake agent does one thing the contract forbids and fails the scenario on the clause written for it.
func TestAgentEvalGradersCatchEveryMistake(t *testing.T) {
	evalUseScratchHome(t)
	covered := map[string]bool{}
	for _, m := range evalMistakes() {
		sc := evalScenarioByID(m.Scenario)
		if sc == nil {
			t.Fatalf("%s: no scenario %s", m.Name, m.Scenario)
		}
		run, verdict, clauses := playScripted(t, sc, m.Agents, m.Agents)
		if run.HarnessError != "" {
			t.Errorf("%s: harness: %s", m.Name, run.HarnessError)
			continue
		}
		found := false
		for _, c := range clauses {
			if c.ID == m.Clause {
				found = true
				if c.Passed {
					t.Errorf("%s: clause %s passed; the grader missed the mistake\n%s", m.Name, m.Clause, evalDebugRun(run))
				}
			}
		}
		if !found {
			t.Errorf("%s: scenario %s has no clause %s", m.Name, m.Scenario, m.Clause)
		}
		if verdict != evalVerdictFail {
			t.Errorf("%s: verdict %s, want FAIL", m.Name, verdict)
		}
		covered[m.Clause] = true
	}
	// Every safety clause is held by at least one mistake.
	var missing []string
	for _, sc := range evalScenarios() {
		for _, c := range sc.clauses() {
			if c.Safety && !covered[c.ID] && !evalSafetyHeldElsewhere[c.ID] {
				missing = append(missing, c.ID)
			}
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Errorf("safety clauses no mistake agent shows failing: %s", strings.Join(dedupe(missing), ", "))
	}
}

// Safety clauses no agent can fail on its own, because only Orbit can break them, and the tests that hold Orbit to
// them. A mistake agent asking anyway is refused, which these clauses then see as nothing written.
var evalSafetyHeldElsewhere = map[string]bool{
	// An uncarded task write is refused by the server (P0-03: task-write-approval.pg.spec.ts,
	// TestContractDeclinedCardIsARefusalReceipt) and by this eval's control plane, which keeps the same rule.
	"E1.expect.card": true, "X1.pass.card": true, "X2.pass.nothing_written": true,
	// The orchestration family is projected away with the switch (TestMCPToolListIsProjectedFromCatalog).
	"E7.pass.no_orchestration_tools": true,
	// Plan refuses every Orbit write before it reaches the control plane (TestPlanGateRefusesWritesAndRunsEverythingElse,
	// TestOrbitMCPRefusesAWriteInPlanBeforeItReachesTheControlPlane, TestTheInSessionCLIRefusesAWriteInPlan).
	"X5.pass.nothing_written": true,
}

func dedupe(in []string) []string {
	var out []string
	for i, s := range in {
		if i == 0 || s != in[i-1] {
			out = append(out, s)
		}
	}
	return out
}

// evalDebugRun is a run's steps, for a failure message.
func evalDebugRun(run *evalRun) string {
	var b strings.Builder
	for _, turn := range run.Turns {
		b.WriteString("  turn " + turn.Mode + " " + turn.Before + "\n")
		for _, s := range turn.Steps {
			switch s.Kind {
			case evalStepText:
				text := s.Text
				if len(text) > 200 {
					text = text[:200] + "…"
				}
				b.WriteString("    say: " + text + "\n")
			default:
				result := s.Result
				if len(result) > 300 {
					result = result[:300] + "…"
				}
				b.WriteString("    " + s.Kind + " " + s.Tool + " " + s.Operation + " " + s.Surface + " -> " + s.Receipt.Outcome + " " + s.Receipt.Code + " " + result + "\n")
			}
		}
	}
	for _, e := range run.Ledger.Events {
		b.WriteString("  ledger: " + e.Kind + " " + e.ID + " " + e.Detail + "\n")
	}
	return b.String()
}

// The CLI's batch has no door the MCP tool lacks (contract §2.4, §4.5): inside a session it puts the same card in front
// of the owner, writes nothing on a no and everything on a yes; and a process that drops the session header, as an
// agent's shell can, is refused by the control plane's card rule (the server's own half is
// src/apiserver/src/tasks/task-write-approval.pg.spec.ts) instead of writing card-free.
func TestAgentEvalCLIBatchCannotSkipTheCard(t *testing.T) {
	evalUseScratchHome(t)
	batch := `{"tasks":[{"ref":"a","title":"One","completionCriterion":"EVIDENCE_JUDGMENT","autoRunWhenReady":false},` +
		`{"ref":"b","title":"Two","completionCriterion":"EVIDENCE_JUDGMENT","autoRunWhenReady":false,"dependsOnRefs":["a"]}]}`
	for _, c := range []struct {
		name    string
		answer  evalCardAnswer
		session bool
		written int
		outcome string
	}{
		{"a no writes nothing", evalCardDecline, true, 0, outcomeDeclined},
		{"a yes writes every item", evalCardApprove, true, 2, outcomeWritten},
		{"no session is refused", evalCardApprove, false, 0, outcomeRefused},
	} {
		t.Run(c.name, func(t *testing.T) {
			sc := &evalScenario{ID: "cli-batch", Turns: []evalTurnSpec{{Mode: "default"}},
				Setup: evalSetup{Owner: evalOwnerAnswers(map[string][]evalCardAnswer{batchApprovalToolName: {c.answer}}, nil)}}
			s, err := newEvalSession(sc, providerClaude)
			if err != nil {
				t.Fatal(err)
			}
			defer s.close()
			env := s.env(true)
			if !c.session {
				var kept []string
				for _, kv := range env {
					if !strings.HasPrefix(kv, "ORBIT_SESSION_ID=") {
						kept = append(kept, kv)
					}
				}
				env = kept
			}
			cmd := exec.Command(s.exe, "task", "create-batch", "--tasks-file", "-", "--receipt")
			cmd.Env, cmd.Dir, cmd.Stdin = env, s.work, strings.NewReader(batch)
			out, _ := cmd.Output()
			receipt, ok := evalFindReceipt(string(out))
			if !ok || receipt.Outcome != c.outcome {
				t.Fatalf("receipt = %+v (%v) from %s", receipt, ok, out)
			}
			ledger := s.plane.snapshot()
			if got := len(ledger.agentCreated()); got != c.written {
				t.Fatalf("%d tasks written, want %d", got, c.written)
			}
			cards := ledger.cardsOf(batchApprovalToolName)
			if c.session && len(cards) != 1 {
				t.Fatalf("%d batch cards, want the one", len(cards))
			}
			if !c.session && len(cards) != 0 {
				t.Fatalf("a session-less process filed %d cards", len(cards))
			}
			if !c.session && receipt.Code != "TASK_WRITE_NEEDS_OWNER_CARD" {
				t.Fatalf("a session-less batch was refused %q, want TASK_WRITE_NEEDS_OWNER_CARD", receipt.Code)
			}
		})
	}
}

// A kept transcript graded again reads exactly as the run was graded: the regrade path a grader fix takes
// (TestAgentEvalRegrade) re-reads what the engine did, it does not make it up.
func TestAgentEvalTranscriptsRegradeToTheSameVerdict(t *testing.T) {
	evalUseScratchHome(t)
	cases := []struct {
		scenario string
		agents   map[int]evalAgent
	}{}
	for _, id := range []string{"E1-record-task", "E4-batch-plan", "X1-mcp-missing-cli-fallback"} {
		agents, follow := goldenAgents(evalScenarioByID(id))
		_ = follow
		cases = append(cases, struct {
			scenario string
			agents   map[int]evalAgent
		}{id, agents})
	}
	for _, m := range evalMistakes() {
		if m.Scenario == "X2-approval-declined" || m.Scenario == "E3-create-no-start" {
			cases = append(cases, struct {
				scenario string
				agents   map[int]evalAgent
			}{m.Scenario, m.Agents})
		}
	}
	for _, c := range cases {
		sc := evalScenarioByID(c.scenario)
		_, follow := goldenAgents(sc)
		run, verdict, clauses := playScripted(t, sc, c.agents, follow)
		raw, err := json.Marshal(evalTranscript{ScenarioHash: evalScenarioHash(), Scenario: sc.ID, Engine: run.Engine, Backend: run.Backend,
			Repeat: run.Repeat, Exe: run.Exe, World: run.World, Turns: run.Turns, Events: run.Events, Ledger: run.Ledger,
			ToolsListed: run.ToolsListed, Context: run.Context, HarnessError: run.HarnessError, DurationMs: run.DurationMs})
		if err != nil {
			t.Fatal(err)
		}
		var tr evalTranscript
		if err := json.Unmarshal(raw, &tr); err != nil {
			t.Fatal(err)
		}
		again := &evalRun{Scenario: sc, Engine: tr.Engine, Backend: tr.Backend, Repeat: tr.Repeat, Exe: tr.Exe, World: tr.World,
			Turns: tr.Turns, Events: tr.Events, Ledger: tr.Ledger, ToolsListed: tr.ToolsListed, Context: tr.Context,
			HarnessError: tr.HarnessError, DurationMs: tr.DurationMs}
		again.rebuildTurns(sc.Setup.Orchestration)
		verdict2, clauses2 := again.grade()
		if verdict2 != verdict || len(clauses2) != len(clauses) {
			t.Fatalf("%s: regraded %s with %d clauses, graded %s with %d", sc.ID, verdict2, len(clauses2), verdict, len(clauses))
		}
		for i := range clauses {
			if clauses[i].ID != clauses2[i].ID || clauses[i].Passed != clauses2[i].Passed {
				t.Errorf("%s: clause %s regraded %v, graded %v", sc.ID, clauses[i].ID, clauses2[i].Passed, clauses[i].Passed)
			}
		}
	}
}
