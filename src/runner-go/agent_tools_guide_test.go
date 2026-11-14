package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"unicode"
)

// The Agent Tools guide's outputs, each the renderer's, byte for byte. ORBIT_UPDATE_AGENT_TOOLS_GUIDE=1
// writes them instead of comparing.
var agentToolsGuideOutputs = []struct {
	path   string
	render func() string
}{
	{filepath.Join("..", "..", "docs", "agent-tools-guide.md"), renderAgentToolsGuideMarkdown},
	{filepath.Join("..", "web", "src", "lib", "agentToolsGuide.generated.json"), renderAgentToolsGuideJSON},
	{filepath.Join("..", "macos", "OrbitKit", "Sources", "OrbitKit", "AgentTools", "AgentToolsGuide.generated.swift"), renderAgentToolsGuideSwift},
	{filepath.Join("testdata", "agent-tools", "claude-plugin", ".claude-plugin", "plugin.json"), claudeManagedPluginManifest},
	{filepath.Join("testdata", "agent-tools", "claude-plugin", "skills", claudeManagedSkillName, "SKILL.md"), func() string { return renderManagedSkill(providerClaude) }},
	{filepath.Join("testdata", "agent-tools", "codex-skills", codexManagedSkillName, "SKILL.md"), func() string { return renderManagedSkill(providerCodex) }},
}

// The public document, the apps' copy and the skills are the guide rendered, so they cannot say different
// things: a change to a section, an example, a playbook, a route or the catalogue shows here as a file to
// regenerate and review.
func TestAgentToolsGuideOutputsAreGenerated(t *testing.T) {
	restore := runsAsRoot
	t.Cleanup(func() { runsAsRoot = restore })
	for _, out := range agentToolsGuideOutputs {
		runsAsRoot = false
		want := out.render()
		runsAsRoot = true
		if asRoot := out.render(); asRoot != want {
			t.Fatalf("%s depends on whether the runner is root", out.path)
		}
		if os.Getenv("ORBIT_UPDATE_AGENT_TOOLS_GUIDE") == "1" {
			if err := os.MkdirAll(filepath.Dir(out.path), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(out.path, []byte(want), 0o644); err != nil {
				t.Fatal(err)
			}
			continue
		}
		got, err := os.ReadFile(out.path)
		if err != nil {
			t.Fatalf("%v (regenerate with ORBIT_UPDATE_AGENT_TOOLS_GUIDE=1 go test -run TestAgentToolsGuideOutputsAreGenerated .)", err)
		}
		if string(got) != want {
			t.Errorf("%s is not the Agent Tools guide rendered (regenerate with ORBIT_UPDATE_AGENT_TOOLS_GUIDE=1 go test -run TestAgentToolsGuideOutputsAreGenerated .)", out.path)
		}
	}
}

// The guide carries what P1-03's acceptance asks a person to be able to read without the Orbit repository:
// MCP first, the record and the private plan, object routing, create versus start, the CLI's place and
// troubleshooting, and at least the four examples: record a task, keep a plan of several steps, hand work
// off now, and a batch from a script.
func TestAgentToolsGuideCarriesTheRequiredSectionsAndExamples(t *testing.T) {
	doc := agentToolsGuideDocument()
	var ids []string
	for _, s := range doc.Sections {
		ids = append(ids, s.ID)
		if strings.TrimSpace(s.Title) == "" || strings.TrimSpace(s.Lead) == "" || len(s.Points) == 0 || len(s.Asks) == 0 {
			t.Errorf("section %s does not have a title, a lead, its points and something to ask", s.ID)
		}
	}
	if !reflect.DeepEqual(ids, agentToolsSectionIDs) {
		t.Errorf("sections = %v, want %v", ids, agentToolsSectionIDs)
	}
	examples := map[string]agentToolsExample{}
	for _, ex := range doc.Examples {
		examples[ex.ID] = ex
		if ex.Ask == "" || ex.Does == "" || ex.Proof == "" || ex.Scenario == "" || len(ex.CLI) == 0 {
			t.Errorf("example %s does not say what is asked, what the agent does, its CLI lines, its scenario and what proves it", ex.ID)
		}
		for _, scenario := range strings.Split(ex.Scenario, ", ") {
			if !regexp.MustCompile(`^E[1-8]-[a-z-]+$`).MatchString(scenario) {
				t.Errorf("example %s names %q, which is not a contract scenario id", ex.ID, scenario)
			}
		}
	}
	for _, id := range agentToolsExampleIDs {
		if _, ok := examples[id]; !ok {
			t.Errorf("the guide has no %s example", id)
		}
	}
	playbooks := map[string]bool{}
	for _, p := range doc.Playbooks {
		playbooks[p.ID] = true
	}
	for _, ex := range doc.Examples {
		if ex.Playbook != "" && !playbooks[ex.Playbook] {
			t.Errorf("example %s points at the playbook %s, which the skill does not carry", ex.ID, ex.Playbook)
		}
	}
	if !reflect.DeepEqual(doc.Rules, guideRules) {
		t.Errorf("the guide's rules are not the route guide's")
	}
	if len(doc.Routes) != len(guideRoutes) {
		t.Errorf("the guide carries %d routes, the route guide %d", len(doc.Routes), len(guideRoutes))
	}
}

// Every example a person is shown is a call its surface accepts: the MCP arguments pass the tool's own
// schema, and each orbit line reaches its catalogued command's flag parser with every flag accepted. The
// batch script's orbit lines are the batch example's lines.
func TestAgentToolsExamplesAreAcceptedByTheirSurfaces(t *testing.T) {
	catalogFullestCLIContext(t)
	for _, ex := range agentToolsExamples() {
		for _, call := range ex.MCP {
			op := catalogOperation(call.Tool)
			if op == nil || op.MCP == nil {
				t.Errorf("example %s calls %s, which is not a catalogued MCP tool", ex.ID, call.Tool)
				continue
			}
			if violations := validateToolArguments(op, call.Arguments); len(violations) > 0 {
				t.Errorf("example %s: %s refuses its arguments: %+v", ex.ID, call.Tool, violations)
			}
		}
		for _, line := range ex.CLI {
			checkAgentToolsCLILine(t, "example "+ex.ID, line)
		}
	}
	batch := map[string]bool{}
	for _, ex := range agentToolsExamples() {
		if ex.ID == "batch-script" {
			for _, line := range ex.CLI {
				batch[shellJoin(line)] = true
			}
		}
	}
	for _, line := range strings.Split(agentToolsBatchScript, "\n") {
		if strings.HasPrefix(line, "orbit ") && !batch[strings.TrimSuffix(line, " < plan.json")] {
			t.Errorf("the batch script runs %q, which is not one of the batch example's checked lines", line)
		}
	}
}

// checkAgentToolsCLILine holds one orbit line to its command: it is a catalogued command, and every flag it
// passes reaches that command's own parser (the probe flag after them is the first thing refused).
func checkAgentToolsCLILine(t *testing.T, where string, line []string) {
	t.Helper()
	if len(line) < 2 || line[0] != "orbit" {
		t.Errorf("%s: %q is not an orbit command", where, line)
		return
	}
	matched := false
	for _, op := range operationCatalog().Ops {
		if op.CLI != nil && len(line) >= len(op.CLI.Argv) && reflect.DeepEqual(line[:len(op.CLI.Argv)], op.CLI.Argv) {
			matched = true
		}
	}
	if !matched {
		t.Errorf("%s: %q is no catalogued command", where, line)
		return
	}
	probe := []string{}
	for _, word := range line[1:] {
		if word != "--receipt" {
			probe = append(probe, word)
		}
	}
	probe = append(probe, "--orbit-catalog-probe")
	var out, errOut strings.Builder
	err := runOrbitCLI(probe, strings.NewReader(""), &out, &errOut)
	if err == nil || !strings.Contains(err.Error(), "flag provided but not defined: -orbit-catalog-probe") {
		t.Errorf("%s: %q did not reach its parser with every flag accepted: %v", where, line, err)
	}
}

// A troubleshooting row that names a refusal names a code Orbit really answers: one of the receipt's runner
// codes (contracts/orbit-agent.contract.json), or a code the control plane itself sends.
func TestAgentToolsTroubleshootingNamesRealCodes(t *testing.T) {
	blob, err := os.ReadFile(filepath.Join("..", "..", "contracts", "orbit-agent.contract.json"))
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		Receipt struct {
			RunnerErrorCodes []string `json:"runnerErrorCodes"`
		} `json:"receipt"`
	}
	if err := json.Unmarshal(blob, &contract); err != nil {
		t.Fatal(err)
	}
	known := map[string]bool{}
	for _, code := range contract.Receipt.RunnerErrorCodes {
		known[code] = true
	}
	serverCodes := map[string]string{"TASK_WRITE_NEEDS_OWNER_CARD": filepath.Join("..", "apiserver", "src", "tasks", "task-write-approval.ts")}
	seen := map[string]bool{}
	for _, row := range agentToolsTroubles() {
		if seen[row.ID] {
			t.Errorf("troubleshooting row %s is declared twice", row.ID)
		}
		seen[row.ID] = true
		if row.Symptom == "" || row.Cause == "" || row.Fix == "" {
			t.Errorf("troubleshooting row %s does not say what is seen, why and what to do", row.ID)
		}
		if row.Code == "" || known[row.Code] {
			continue
		}
		path, ok := serverCodes[row.Code]
		if !ok {
			t.Errorf("troubleshooting row %s names %s, which Orbit does not answer", row.ID, row.Code)
			continue
		}
		source, err := os.ReadFile(path)
		if err != nil || !strings.Contains(string(source), row.Code) {
			t.Errorf("troubleshooting row %s names %s, which %s does not send", row.ID, row.Code, path)
		}
	}
}

// Every Orbit MCP tool but the engine's permission bridge is in exactly one family, so the counts a session
// reports add up to the tools its engine lists.
func TestEveryOrbitToolHasOneFamily(t *testing.T) {
	inFamily := map[string]string{}
	for _, family := range agentToolsFamilies() {
		if len(family.Tools) == 0 {
			t.Errorf("family %s has no tools", family.ID)
		}
		for _, tool := range family.Tools {
			if other, ok := inFamily[tool]; ok {
				t.Errorf("%s is in both %s and %s", tool, other, family.ID)
			}
			inFamily[tool] = family.ID
		}
	}
	for _, op := range operationCatalog().Ops {
		if op.MCP == nil {
			continue
		}
		_, ok := inFamily[op.Tool]
		if op.Gate == gatePermissionPrompt {
			if ok {
				t.Errorf("%s, the engine's bridge, is counted in a family", op.Tool)
			}
			continue
		}
		if !ok {
			t.Errorf("%s is an Orbit MCP tool in no family", op.Tool)
		}
	}
	for _, op := range operationCatalog().Ops {
		if op.Gate == gateOrchestration && op.MCP != nil && inFamily[op.Tool] != "orchestration" {
			t.Errorf("%s needs Session orchestration but is in %s", op.Tool, inFamily[op.Tool])
		}
	}
}

// The layers say, per engine, what the model reads and in which role, in the order measured on Claude Code
// 2.1.325 and Codex 0.167.2: the workspace's runtime instructions before Orbit's, Claude Code's MCP server
// instructions in the system message after the first user message, and on Codex one Orbit layer per carrier.
func TestAgentToolsLayersAreWellFormed(t *testing.T) {
	layers := agentToolsLayers()
	for _, engine := range []string{providerClaude, providerCodex} {
		ls := layers[engine]
		count := map[string]int{}
		index := map[string]int{}
		for i, layer := range ls {
			count[layer.ID]++
			if _, seen := index[layer.ID]; !seen {
				index[layer.ID] = i
			}
			for _, c := range layer.When {
				if !agentToolsLayerConditions[c] {
					t.Errorf("%s layer %s names the condition %q", engine, layer.ID, c)
				}
			}
			if layer.Title == "" || layer.RoleLabel == "" || layer.Detail == "" || layer.Source == "" || layer.Role == "" {
				t.Errorf("%s layer %s is missing a field", engine, layer.ID)
			}
		}
		for _, id := range []string{"engine", "workspace-base", "repository", "person", "mcp", "skill"} {
			if count[id] != 1 {
				t.Errorf("%s has %d %s layers, want 1", engine, count[id], id)
			}
		}
		if index["workspace"] > index["orbit"] {
			t.Errorf("%s reads Orbit's runtime instructions before the workspace's", engine)
		}
		if index["person"] < index["repository"] {
			t.Errorf("%s puts the person's message before the repository's files", engine)
		}
	}
	claude := layers[providerClaude]
	idx := map[string]int{}
	for i, l := range claude {
		idx[l.ID] = i
	}
	if idx["mcp"] < idx["person"] || idx["skill"] < idx["mcp"] {
		t.Error("Claude Code lists the MCP server instructions and the skills after the first user message, as measured")
	}
	for _, carrier := range []string{"additional_context", "developer_message", "turn_input"} {
		orbit, workspace := 0, 0
		for _, l := range layers[providerCodex] {
			for _, c := range l.When {
				if c == carrier && l.ID == "orbit" {
					orbit++
				}
				if c == carrier && l.ID == "workspace" {
					workspace++
				}
			}
		}
		if orbit != 1 || workspace != 1 {
			t.Errorf("Codex carrier %s has %d Orbit and %d workspace layers, want one each", carrier, orbit, workspace)
		}
	}
}

// What a mode is said to mean for a background job is what the contract's permission table says it is.
func TestAgentToolsModesAgreeWithTheContract(t *testing.T) {
	blob, err := os.ReadFile(filepath.Join("..", "..", "contracts", "orbit-agent.contract.json"))
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		Permission struct {
			Modes                []string          `json:"modes"`
			BackgroundJobsByMode map[string]string `json:"backgroundJobsByMode"`
		} `json:"permission"`
	}
	if err := json.Unmarshal(blob, &contract); err != nil {
		t.Fatal(err)
	}
	said := map[string]string{}
	for _, m := range agentToolsModes() {
		said[m.Mode] = m.Orbit
	}
	if len(said) != len(contract.Permission.Modes) {
		t.Errorf("the guide explains %d modes, the contract has %d", len(said), len(contract.Permission.Modes))
	}
	clause := map[string]string{"refused": "ackground jobs are refused", "card": "background job asks before it starts", "started": "ackground jobs start without asking"}
	for _, mode := range contract.Permission.Modes {
		text, ok := said[mode]
		if !ok {
			t.Errorf("the guide does not explain %s", mode)
			continue
		}
		if want := clause[contract.Permission.BackgroundJobsByMode[mode]]; want == "" || !strings.Contains(text, want) {
			t.Errorf("%s: %q does not say a background job is %s", mode, text, contract.Permission.BackgroundJobsByMode[mode])
		}
		if mode == "plan" && !strings.Contains(text, "SESSION_IN_PLAN_MODE") {
			t.Errorf("plan does not name its refusal")
		}
	}
}

// The skill is a long recipe and nothing else: ASCII like every other text Orbit puts in front of a model,
// named as each engine lists it, sending a single call to guide, naming only real operations, and never
// named by the primer or the engine instructions, so no path depends on it.
func TestManagedSkillIsASCIIAndOffTheCriticalPath(t *testing.T) {
	ops := map[string]bool{}
	for _, op := range operationCatalog().Ops {
		ops[op.Tool] = true
	}
	toolWord := regexp.MustCompile(`\b(task|project|session|tasklist|watch|wiki|file|bg|agent|runner|provider)_[a-z_]+\b`)
	for _, engine := range []string{providerClaude, providerCodex} {
		skill := renderManagedSkill(engine)
		for i, r := range skill {
			if r > unicode.MaxASCII {
				t.Fatalf("%s skill has a non-ASCII %q at %d", engine, r, i)
			}
		}
		if !strings.HasPrefix(skill, "---\nname: ") || !strings.Contains(skill, "\ndescription: "+agentToolsSkillPurpose+"\n---\n") {
			t.Errorf("%s skill does not open with its frontmatter", engine)
		}
		if !strings.Contains(skill, "guide") || !strings.Contains(agentToolsSkillPurpose, "Optional") {
			t.Errorf("%s skill does not send a single call to guide and say it is optional", engine)
		}
		for _, p := range agentToolsPlaybooks() {
			if !strings.Contains(skill, "# "+p.Title+"\n") {
				t.Errorf("%s skill lacks the playbook %s", engine, p.ID)
			}
		}
		for _, word := range toolWord.FindAllString(skill, -1) {
			if !ops[word] && !strings.HasSuffix(word, "_id") {
				t.Errorf("%s skill names %s, which is no operation", engine, word)
			}
		}
	}
	for _, text := range []string{agentPrimer, orbitCLIInstructions("/opt/orbit/orbit", true, true), orbitCLIInstructions("/opt/orbit/orbit", false, false)} {
		for _, name := range []string{"playbook", claudeManagedSkillID, codexManagedSkillName} {
			if strings.Contains(text, name) {
				t.Errorf("the always-on instructions name %q: the skill must stay off the critical path", name)
			}
		}
	}
}

// What a person reads in the apps is English (CLAUDE.md §5): no CJK in the guide the clients render.
func TestAgentToolsGuideIsEnglish(t *testing.T) {
	for _, r := range renderAgentToolsGuideJSON() {
		if unicode.Is(unicode.Han, r) || unicode.Is(unicode.Hiragana, r) || unicode.Is(unicode.Katakana, r) || unicode.Is(unicode.Hangul, r) {
			t.Fatalf("the Agent Tools guide carries %q", r)
		}
	}
}

// The plugin the runner writes is one Claude Code loads with --plugin-dir, and the skill root one Codex's
// app server lists: the same files the snapshots hold.
func TestManagedSkillFilesAreWrittenWhereEachEngineLoadsThem(t *testing.T) {
	scratch := t.TempDir()
	dir := writeClaudeManagedPlugin(scratch)
	if dir != filepath.Join(scratch, "orbit-plugin") {
		t.Fatalf("plugin dir = %q", dir)
	}
	manifest, err := os.ReadFile(filepath.Join(dir, ".claude-plugin", "plugin.json"))
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]interface{}
	if err := json.Unmarshal(manifest, &m); err != nil || m["name"] != claudeManagedPluginName {
		t.Errorf("plugin.json = %s", manifest)
	}
	skill, err := os.ReadFile(filepath.Join(dir, "skills", claudeManagedSkillName, "SKILL.md"))
	if err != nil || string(skill) != renderManagedSkill(providerClaude) {
		t.Errorf("the Claude skill was not written as rendered: %v", err)
	}
	root := writeCodexManagedSkillRoot(scratch)
	codex, err := os.ReadFile(filepath.Join(root, codexManagedSkillName, "SKILL.md"))
	if err != nil || string(codex) != renderManagedSkill(providerCodex) {
		t.Errorf("the Codex skill was not written as rendered: %v", err)
	}
	if writeClaudeManagedPlugin("") != "" || writeCodexManagedSkillRoot("") != "" {
		t.Error("a session with no scratch dir is given a skill path")
	}
	// Written again over itself, as every spawn does, it leaves no temporary file behind.
	writeClaudeManagedPlugin(scratch)
	matches, _ := filepath.Glob(filepath.Join(dir, "skills", claudeManagedSkillName, "*.tmp"))
	if len(matches) > 0 {
		t.Errorf("temporary files left: %v", matches)
	}
}

// Every layer's source has the name the document gives it.
func TestAgentToolsLayerSourcesAreNamed(t *testing.T) {
	for engine, layers := range agentToolsLayers() {
		for _, layer := range layers {
			if agentToolsSourceLabels[layer.Source] == "" {
				t.Errorf("%s layer %s is set by %q, which the document does not name", engine, layer.ID, layer.Source)
			}
		}
	}
}
