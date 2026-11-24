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

// initialize answers with the primer, and an Ask with the help reads' instructions, on every engine profile.
func TestComposedMCPInstructionsAreThePrimer(t *testing.T) {
	for _, profile := range append(engineProfiles, unknownEngineProfile) {
		for _, shape := range instructionTestShapes() {
			want := agentPrimer
			if shape.Role == roleHelpAsk {
				want = helpAskInstructions
			}
			if got := compose(shape, profile).MCP; got != want {
				t.Errorf("%+v on %q: initialize instructions = %q, want %q", shape, profile.Engine, got, want)
			}
		}
	}
	// It does not need the CLI path, which only the engine's own carrier prints.
	if got := compose(SessionShape{Role: roleTaskRun}, claudeCodeProfile); got.MCP != agentPrimer || got.System != "" {
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
