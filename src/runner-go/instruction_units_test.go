package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"strings"
	"testing"
)

// instructionTestShapes is every role with each switch flipped from a task run's, on a runner with and without the
// drive: enough to reach every unit's appliesTo both ways.
func instructionTestShapes() []SessionShape {
	base := SessionShape{Role: roleTaskRun, InsideRecordedWork: true, Watches: true, Wiki: true, Workflows: true, CLI: "/usr/local/bin/orbit"}
	var shapes []SessionShape
	for _, role := range []sessionRole{roleTopLevel, roleTaskRun, roleSubAgent, roleCheckOnly, roleHelpAsk, roleCoordinator} {
		for _, flip := range []func(*SessionShape){
			func(*SessionShape) {},
			func(s *SessionShape) { s.InsideRecordedWork = !s.InsideRecordedWork },
			func(s *SessionShape) { s.Watches = false },
			func(s *SessionShape) { s.Workflows = false },
			func(s *SessionShape) { s.Wiki = false },
			func(s *SessionShape) { s.Orchestration = true },
			func(s *SessionShape) { s.Browser = true },
		} {
			for _, drive := range []bool{false, true} {
				shape := base
				shape.Role = role
				flip(&shape)
				shape.DriveMounted = drive
				shapes = append(shapes, shape)
			}
		}
	}
	return shapes
}

// Every unit is well-formed: a unique id, an owner, a kind A-F, a channel, ASCII text, and conflicts that name units
// that name it back.
func TestInstructionUnitsAreWellFormed(t *testing.T) {
	byID := map[string]instructionUnit{}
	for _, unit := range instructionUnits {
		if unit.id == "" || unit.owner == "" || unit.appliesTo == nil || len(unit.channels) == 0 || unit.core == "" || unit.detail == "" {
			t.Errorf("unit %q is missing a field: %+v", unit.id, unit)
		}
		if _, dup := byID[unit.id]; dup {
			t.Errorf("unit id %q is used twice", unit.id)
		}
		byID[unit.id] = unit
		if unit.kind < kindDisposition || unit.kind > kindEnvironment || len(unit.kind) != 1 {
			t.Errorf("unit %s has kind %q, not one of A-F", unit.id, unit.kind)
		}
		for i := 0; i < len(unit.core); i++ {
			if unit.core[i] > 127 {
				t.Errorf("unit %s is not ASCII at byte %d", unit.id, i)
				break
			}
		}
		if strings.HasSuffix(unit.core, "\n") || strings.HasPrefix(unit.core, "\n") {
			t.Errorf("unit %s carries its own separator; compose puts a blank line between units", unit.id)
		}
	}
	for _, unit := range instructionUnits {
		for _, other := range unit.conflicts {
			peer, ok := byID[other]
			if !ok {
				t.Errorf("unit %s conflicts with %q, which is no unit", unit.id, other)
				continue
			}
			named := false
			for _, back := range peer.conflicts {
				named = named || back == unit.id
			}
			if !named {
				t.Errorf("unit %s conflicts with %s, which does not name it back", unit.id, other)
			}
		}
	}
}

// Every unit renders on every engine with no placeholder left, and no shape is given two units that conflict.
func TestEveryUnitRendersOnEveryEngine(t *testing.T) {
	conflicts := map[string]map[string]bool{}
	for _, unit := range instructionUnits {
		conflicts[unit.id] = map[string]bool{}
		for _, other := range unit.conflicts {
			conflicts[unit.id][other] = true
		}
	}
	for _, profile := range append(engineProfiles, unknownEngineProfile) {
		for _, unit := range instructionUnits {
			if text := renderInstructionUnit(unit.core, SessionShape{CLI: "/usr/local/bin/orbit"}, profile); strings.Contains(text, "{{") || strings.Contains(text, "}}") {
				t.Errorf("unit %s on %q keeps a placeholder: %q", unit.id, profile.Engine, text)
			}
		}
		for _, shape := range instructionTestShapes() {
			for _, channel := range []instructionChannel{channelSystem, channelMCP} {
				var given []string
				for _, unit := range instructionUnits {
					if unit.deliveredOn(channel) && unit.appliesTo(shape) && shape.serves(unit.tools) {
						given = append(given, unit.id)
					}
				}
				for _, a := range given {
					for _, b := range given {
						if conflicts[a][b] {
							t.Errorf("%+v on %q is given %s and %s, which conflict", shape, profile.Engine, a, b)
						}
					}
				}
			}
		}
	}
}

// initialize answers with the primer, and an Ask with the help reads' instructions, on every engine profile. On an
// engine whose own carrier is confirmed, which has the rest, it answers with the primer's lead paragraph and the
// paragraphs that carrier skips.
func TestComposedMCPInstructionsAreThePrimer(t *testing.T) {
	for _, profile := range append(engineProfiles, unknownEngineProfile) {
		for _, shape := range instructionTestShapes() {
			want := agentPrimer
			if shape.Orchestration {
				want = strings.Replace(want, agentPrimerOrchestration+"\n\n", "", 1)
			}
			if profile.SystemCarrier == probeYes {
				want = agentPrimerLead
				// A paragraph the engine's carrier skips is not there, so initialize keeps it.
				if profile.ResetNote && profile.Engine == providerClaude {
					want += "\n\n" + agentPrimerRederive
				}
			}
			if shape.Role == roleHelpAsk {
				want = ""
			}
			if got := compose(shape, profile).MCP; got != want {
				t.Errorf("%+v on %q: initialize instructions = %q, want %q", shape, profile.Engine, got, want)
			}
		}
	}
	// It does not need the CLI path, which only the engine's own carrier prints.
	if got := compose(SessionShape{Role: roleTaskRun}, unknownEngineProfile); got.MCP != agentPrimer || got.System != "" {
		t.Errorf("with no CLI path: %+v", got)
	}
}

// A unit that names Orbit tools is left out of a session served none of them; one whose carrier does not know the
// served set (Tools nil) is given every unit, as every carrier is today.
func TestUnitsFollowTheServedTools(t *testing.T) {
	shape := SessionShape{Role: roleTaskRun, InsideRecordedWork: true, Watches: true, Wiki: true, Workflows: true, CLI: "/usr/local/bin/orbit"}
	if !strings.Contains(compose(shape, claudeCodeProfile).System, orbitWikiPathInstructions) {
		t.Fatal("a session whose served tools are not known is not given the wiki unit")
	}
	shape.Tools = map[string]bool{"task_await": true, "notify": true, "delegate": true, "workflow": true, "file_upload": true, "task_progress_report": true}
	got := compose(shape, claudeCodeProfile).System
	if strings.Contains(got, orbitWikiPathInstructions) {
		t.Error("a session served no wiki_search is given the wiki unit")
	}
	if !strings.Contains(got, orbitWaitInstructions) || !strings.Contains(got, orbitNotifyInstructions) {
		t.Error("a session served the await and notify tools lost their units")
	}
}

// Every engine has a profile, and every profile states each value: measured, or the conservative unknown.
func TestEveryEngineHasAProfile(t *testing.T) {
	want := map[string]bool{providerClaude: true, providerCodex: true, providerKimi: true, providerCursor: true,
		providerAntigravity: true, providerDsh: true, providerOpenCode: true}
	for _, profile := range engineProfiles {
		if !want[profile.Engine] {
			t.Errorf("profile for %q, which is no engine carrier", profile.Engine)
		}
		delete(want, profile.Engine)
		if profile.MCPInstructions == "" || profile.ToolDescriptions == "" || profile.AlwaysLoad == "" ||
			profile.Carrier == "" || profile.SurvivesCompaction == "" || profile.OrbitTools == "" {
			t.Errorf("profile %q leaves a value unstated: %+v", profile.Engine, profile)
		}
	}
	for engine := range want {
		t.Errorf("engine %q has no profile", engine)
	}
}

// No engine carrier edits Orbit's instruction text after compose: the spellings an engine needs are its profile's. A
// strings.Replace in these files is allowed only in the functions listed, which do not touch instructions.
func TestNoCarrierPatchesInstructionText(t *testing.T) {
	allowed := map[string]bool{"cursor_acp.go redact": true, "codex_appserver.go codexNotificationCompacted": true, "agent_instructions.go shellQuote": true}
	files := []string{"agent_instructions.go", "instruction_units.go", "claude_spawn.go", "codex_appserver.go", "kimi_acp.go", "cursor_acp.go",
		"antigravity_home.go", "dsh_environment.go", "opencode.go", "mcp.go", "subagent_codex.go", "subagent_kimi.go", "subagent_cursor.go", "subagent_dsh.go"}
	fset := token.NewFileSet()
	for _, name := range files {
		file, err := parser.ParseFile(fset, name, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, decl := range file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				continue
			}
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				sel, ok := call.Fun.(*ast.SelectorExpr)
				if !ok {
					return true
				}
				if pkg, ok := sel.X.(*ast.Ident); ok && pkg.Name == "strings" && strings.HasPrefix(sel.Sel.Name, "Replace") &&
					!allowed[name+" "+fn.Name.Name] {
					t.Errorf("%s: %s calls strings.%s", fset.Position(call.Pos()), fn.Name.Name, sel.Sel.Name)
				}
				return true
			})
		}
	}
}

// Each session shape is given only the units that apply to it (design §2 item 3): a SubAgent gets no project or
// notify paragraph and no branch-commit instruction, which would contradict its "Do not commit"; the
// orchestration-off paragraph goes only with orchestration off; the wiki line only with wiki_search served; evidence
// and progress only to a task's run; a check-only run none of the writes Plan refuses.
func TestEachShapeIsGivenOnlyTheUnitsThatApplyToIt(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	job := func(mutate func(*ClaimedSession)) *ClaimedSession {
		j := &ClaimedSession{SessionID: "s-shape", TaskID: "task-1", WT: &Worktree{Path: t.TempDir(), RepoDir: t.TempDir(), Branch: "orbit/x"},
			Agent: AgentExecConfig{Env: map[string]string{}}}
		mutate(j)
		return j
	}
	system := func(j *ClaimedSession) string {
		return withOrbitInstructions(j.appendSystemPrompt(), compose(j.sessionShape("/usr/local/bin/orbit"), claudeCodeProfile).System)
	}
	has := func(text string, paragraphs ...string) bool {
		for _, p := range paragraphs {
			if strings.Contains(text, p) {
				return true
			}
		}
		return false
	}
	projects := []string{orbitProjectProposeInstructions}

	task := system(job(func(*ClaimedSession) {}))
	for name, p := range map[string]string{"notify": orbitNotifyInstructions,
		"commit": "Commit each logical step", "evidence": orbitEvidenceFileInstructions, "progress": orbitProgressInstructions,
		"orchestration-off": agentPrimerOrchestration, "wiki": orbitWikiPathInstructions} {
		if !strings.Contains(task, p) {
			t.Errorf("a task's run is not given the %s text", name)
		}
	}

	sub := system(job(func(j *ClaimedSession) { j.Agent.Env[envSubagentRunID] = "run-1" }))
	if has(sub, projects...) || has(sub, orbitNotifyInstructions, "Commit each logical step", orbitEvidenceFileInstructions, orbitProgressInstructions, orbitHandoffInstructions) {
		t.Errorf("a SubAgent is given project, notify, commit, evidence, progress or delegate text:\n%s", sub)
	}

	check := system(job(func(j *ClaimedSession) { j.Agent.ScheduledCheckOnly = true }))
	if has(check, projects...) || has(check, "Commit each logical step", orbitEvidenceFileInstructions, orbitProgressInstructions, orbitHandoffInstructions) {
		t.Errorf("a check-only run is given a write instruction it cannot use:\n%s", check)
	}

	free := system(job(func(j *ClaimedSession) { j.TaskID = "" }))
	if has(free, orbitProgressInstructions) {
		t.Error("a session that runs no task is given the progress text")
	}
	// The evidence paragraph also says how file_upload hands a file over, which a reply in any session needs (I4).
	if !has(free, orbitEvidenceFileInstructions) {
		t.Error("a session that runs no task is not given the evidence paragraph")
	}

	orch := system(job(func(j *ClaimedSession) { j.AllowOrchestration = true }))
	if has(orch, agentPrimerOrchestration) {
		t.Error("a session with orchestration on is given the orchestration-off paragraph")
	}
	nowiki := system(job(func(j *ClaimedSession) { j.WikiDisabled = true }))
	if has(nowiki, orbitWikiPathInstructions) {
		t.Error("a session with the wiki off is given the wiki line")
	}
	if strings.Contains(orbitWikiPathInstructions, "if your tool list has it") {
		t.Error("the wiki line hedges on the tool list")
	}
}

// Admission (design §4.5): a unit in always-on text is kind A or F and names the eval scenarios that fail without it.
// Every unit of the registry is always-on on some shape, so the rule reads the whole registry.
func TestEveryAlwaysOnUnitIsKindAOrFAndNamesItsEvalCase(t *testing.T) {
	scenarios := map[string]bool{}
	for _, sc := range evalScenarios() {
		scenarios[sc.ID] = true
	}
	for _, unit := range instructionUnits {
		if err := admissionError(unit, scenarios); err != "" {
			t.Errorf("unit %s: %s", unit.id, err)
		}
	}
}

// admissionError is why the unit may not be always-on, or "".
func admissionError(unit instructionUnit, scenarios map[string]bool) string {
	if unit.kind != kindDisposition && unit.kind != kindEnvironment {
		return "kind " + string(unit.kind) + " is not A (disposition) or F (environment); demote it to a tool description, a receipt note or a guide topic"
	}
	if len(unit.guardedBy) == 0 {
		return "guardedBy names no eval scenario"
	}
	for _, id := range unit.guardedBy {
		if !scenarios[id] {
			return "guardedBy names " + id + ", which is no scenario of agent_eval_scenarios_test.go"
		}
	}
	return ""
}

// The rule above has teeth: each way a unit can break it is reported.
func TestAdmissionRuleRefusesAUnitThatBreaksIt(t *testing.T) {
	scenarios := map[string]bool{"E1-record-task": true}
	ok := instructionUnit{id: "x", kind: kindDisposition, guardedBy: []string{"E1-record-task"}}
	if got := admissionError(ok, scenarios); got != "" {
		t.Fatalf("a sound unit was refused: %s", got)
	}
	cleared := ok
	cleared.guardedBy = nil
	missing := ok
	missing.guardedBy = []string{"E1-record-task", "E99-nothing"}
	situation := ok
	situation.kind = kindSituation
	for name, unit := range map[string]instructionUnit{"cleared guardedBy": cleared, "missing scenario": missing, "kind E": situation} {
		if admissionError(unit, scenarios) == "" {
			t.Errorf("%s was admitted", name)
		}
	}
}
