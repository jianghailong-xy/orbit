package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeDefinition(t *testing.T, root, dir, file, content string) {
	t.Helper()
	path := filepath.Join(root, dir, file)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func definitionNamed(t *testing.T, defs []subagentDefinition, name string) subagentDefinition {
	t.Helper()
	d, err := findSubagentDefinition(defs, name)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

// Six locations, one name each pair apart: project beats user, and .cursor beats .claude beats .codex.
func TestSubagentDefinitionPrecedenceAcrossTheSixLocations(t *testing.T) {
	project, home := t.TempDir(), t.TempDir()
	locations := []struct{ root, label, dir string }{
		{project, "", ".cursor/agents"},
		{project, "", ".claude/agents"},
		{project, "", ".codex/agents"},
		{home, "~/", ".cursor/agents"},
		{home, "~/", ".claude/agents"},
		{home, "~/", ".codex/agents"},
	}
	// Definition "top<i>" is present in location i and every location after it, so location i must win it.
	for i := range locations {
		for _, l := range locations[i:] {
			name := "top" + string(rune('0'+i))
			writeDefinition(t, l.root, l.dir, name+".md",
				"---\ndescription: from "+l.label+l.dir+"\n---\nbody of "+l.label+l.dir+"\n")
		}
	}
	defs := loadSubagentDefinitions(project, home)
	for i, l := range locations {
		d := definitionNamed(t, defs, "top"+string(rune('0'+i)))
		want := l.label + l.dir + "/" + d.Name + ".md"
		if d.Source != want || d.Description != "from "+l.label+l.dir || d.Prompt != "body of "+l.label+l.dir {
			t.Errorf("%s: got source %q description %q prompt %q, want %s", d.Name, d.Source, d.Description, d.Prompt, want)
		}
	}
	// The built-ins come first, then the files by name.
	var names []string
	for _, d := range defs {
		names = append(names, d.Name)
	}
	if got := strings.Join(names, ","); got != "general,explore,top0,top1,top2,top3,top4,top5" {
		t.Errorf("definitions in order %s", got)
	}
}

func TestSubagentDefinitionFieldsAndDefaults(t *testing.T) {
	project := t.TempDir()
	writeDefinition(t, project, ".claude/agents", "reviewer.md", `---
description: "Reviews a diff for bugs"
model: claude-opus-5-5
size: l
tools: Read, Grep, Bash(git diff:*)
disallowedTools:
  - WebFetch
  - WebSearch
is_background: true
---
You review diffs.

Report bugs only.
`)
	writeDefinition(t, project, ".cursor/agents", "odd.md", "---\nname: oddly\nmodel: gpt-unknown-9\nsize: XXL\n---\nOdd.\n")
	writeDefinition(t, project, ".codex/agents", "plain.md", "No frontmatter at all.\n")
	defs := loadSubagentDefinitions(project, "")

	r := definitionNamed(t, defs, "reviewer")
	if r.Description != "Reviews a diff for bugs" || r.Model != "claude-opus-5-5" || r.Size != "L" {
		t.Errorf("reviewer read as %+v", r)
	}
	if strings.Join(r.Tools, "|") != "Read|Grep|Bash(git diff:*)" || strings.Join(r.DisallowedTools, "|") != "WebFetch|WebSearch" {
		t.Errorf("reviewer tools %q disallowed %q", r.Tools, r.DisallowedTools)
	}
	if r.Background == nil || !*r.Background || r.Readonly {
		t.Errorf("reviewer background %v readonly %v", r.Background, r.Readonly)
	}
	if r.Prompt != "You review diffs.\n\nReport bugs only." {
		t.Errorf("reviewer prompt %q", r.Prompt)
	}

	// name: overrides the file name. An unknown size is ignored; an unknown model goes to the server as written,
	// whose router counts an id no provider lists as auto and says so in the Why.
	o := definitionNamed(t, defs, "oddly")
	if o.Size != "" || o.Model != "gpt-unknown-9" {
		t.Errorf("oddly read as size %q model %q", o.Size, o.Model)
	}
	body := subagentStartBody(map[string]interface{}{}, o, "toolu_1", false)
	if _, sent := body["definitionSize"]; sent || body["definitionModel"] != "gpt-unknown-9" {
		t.Errorf("an unknown size was sent or the model was not: %v", body)
	}
	if body["type"] != "oddly" || body["definitionSource"] != ".cursor/agents/odd.md" {
		t.Errorf("the POST names %v from %v", body["type"], body["definitionSource"])
	}

	// No frontmatter: the name is the file's, the whole file is the prompt.
	if p := definitionNamed(t, defs, "plain"); p.Prompt != "No frontmatter at all." || p.Description != "" {
		t.Errorf("plain read as %+v", p)
	}

	if _, err := findSubagentDefinition(defs, "nope"); err == nil || !strings.Contains(err.Error(), `"reviewer"`) {
		t.Errorf("an unknown type was not refused with the list: %v", err)
	}
}

// is_background is the default for background; a call that says background wins.
func TestSubagentIsBackgroundIsTheDefault(t *testing.T) {
	yes, no := true, false
	cases := []struct {
		args map[string]interface{}
		def  *bool
		want bool
	}{
		{map[string]interface{}{}, nil, false},
		{map[string]interface{}{}, &yes, true},
		{map[string]interface{}{}, &no, false},
		{map[string]interface{}{"background": false}, &yes, false},
		{map[string]interface{}{"background": true}, &no, true},
	}
	for _, c := range cases {
		got, err := subagentBackground(c.args, subagentDefinition{Background: c.def})
		if err != nil || got != c.want {
			t.Errorf("args %v, is_background %v: got %v (%v), want %v", c.args, c.def, got, err, c.want)
		}
	}
}

// readonly: the POST asks for a read-only run (the server answers with plan mode), and the child is spawned in
// plan mode with the edit tools disallowed, whatever mode the server's exec carries.
func TestSubagentReadonlyRunsInPlanModeWithoutEditTools(t *testing.T) {
	project := t.TempDir()
	writeDefinition(t, project, ".claude/agents", "auditor.md",
		"---\ndescription: Audits\nreadonly: true\ntools: Read, Grep, Edit\n---\nYou audit.\n")
	defs := loadSubagentDefinitions(project, "")
	parent := &ClaimedSession{SessionID: "sess-ro", Provider: providerClaude}
	exec := AgentExecConfig{Model: "claude-sonnet-5-5", PermissionMode: "acceptEdits", DisallowedTools: []string{"WebFetch"}}

	for _, name := range []string{"auditor", "explore"} {
		def := definitionNamed(t, defs, name)
		if body := subagentStartBody(map[string]interface{}{}, def, "toolu_1", false); body["readonly"] != true {
			t.Errorf("%s: the POST does not ask for read-only: %v", name, body)
		}
		child, args := claudeChildSession(parent, exec, def, "run1", "uuid-1", false, t.TempDir())
		if mode := argValue(args, "--permission-mode"); mode != "plan" || child.Agent.PermissionMode != "plan" {
			t.Errorf("%s: permission mode %q", name, mode)
		}
		disallowed := argValue(args, "--disallowedTools")
		for _, tool := range append([]string{"WebFetch"}, subagentReadonlyDisallowed...) {
			if !strings.Contains(","+disallowed+",", ","+tool+",") {
				t.Errorf("%s: %s is not disallowed: %s", name, tool, disallowed)
			}
		}
	}

	// A definition's tools reach Claude as --tools; general keeps the parent's mode and its edit tools.
	auditor := definitionNamed(t, defs, "auditor")
	if _, args := claudeChildSession(parent, exec, auditor, "run1", "uuid-1", false, t.TempDir()); argValue(args, "--tools") != "Read,Grep,Edit" {
		t.Errorf("--tools not passed: %q", args)
	}
	general := definitionNamed(t, defs, "general")
	if general.Readonly || general.Size != "M" || definitionNamed(t, defs, "explore").Size != "S" {
		t.Errorf("built-ins read as %+v", defs[:2])
	}
	_, args := claudeChildSession(parent, exec, general, "run1", "uuid-1", false, t.TempDir())
	disallowed := argValue(args, "--disallowedTools")
	if mode := argValue(args, "--permission-mode"); mode != "acceptEdits" || strings.Contains(","+disallowed+",", ",Edit,") {
		t.Errorf("general runs as %q without %q", mode, disallowed)
	}
	if body := subagentStartBody(map[string]interface{}{"size": "L"}, general, "toolu_1", false); body["readonly"] != false ||
		body["definitionSource"] != "builtin" || body["size"] != "L" || body["definitionSize"] != nil {
		t.Errorf("general's POST %v", body)
	}
}

// The body is the child's system prompt, after the fixed preamble.
func TestSubagentDefinitionBodyFollowsThePreamble(t *testing.T) {
	def := subagentDefinition{Name: "x", Source: ".claude/agents/x.md", Prompt: "You are the X reviewer."}
	_, args := claudeChildSession(&ClaimedSession{Provider: providerClaude}, AgentExecConfig{Model: "m", PermissionMode: "default"},
		def, "run1", "uuid-1", false, t.TempDir())
	appended := argValue(args, "--append-system-prompt")
	if !strings.HasPrefix(appended, subagentPreamble+"\n\nYou are the X reviewer.") {
		t.Errorf("appended system prompt %q", appended)
	}
}

// The runner reads from the directory the child runs in: a definition committed only on the session's branch (its
// worktree) is found, though the workspace's workDir has none.
func TestSubagentDefinitionOnlyInTheSessionWorktreeIsFound(t *testing.T) {
	workDir, worktree, home := t.TempDir(), t.TempDir(), t.TempDir()
	prev := subagentHomeDir
	subagentHomeDir = func() (string, error) { return home, nil }
	t.Cleanup(func() { subagentHomeDir = prev })
	writeDefinition(t, worktree, ".claude/agents", "branch-only.md", "---\ndescription: Only on this branch\n---\nBranch prompt.\n")

	if _, err := findSubagentDefinition(sessionSubagentDefinitions(workDir), "branch-only"); err == nil {
		t.Fatal("the workspace's workDir has the definition: the fixture is wrong")
	}
	svc := &bgJobService{execDir: worktree}
	def, err := findSubagentDefinition(sessionSubagentDefinitions(svc.execDir), "branch-only")
	if err != nil || def.Prompt != "Branch prompt." {
		t.Fatalf("the session's worktree definition was not found: %v %+v", err, def)
	}

	// orbit mcp, started in the worktree, lists it in the delegate tool's description.
	wd, _ := os.Getwd()
	if err := os.Chdir(worktree); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(wd) })
	t.Setenv(envSubagentRunID, "")
	resp, _ := (&mcpServer{}).handle(&rpcRequest{JSONRPC: "2.0", ID: []byte("1"), Method: "tools/list"})
	for _, tool := range resp.Result.(map[string]interface{})["tools"].([]map[string]interface{}) {
		if tool["name"] == delegateToolName {
			desc := tool["description"].(string)
			for _, line := range []string{"- general: ", "- explore: Read-only", "- branch-only: Only on this branch"} {
				if !strings.Contains(desc, line) {
					t.Errorf("delegate's description lacks %q:\n%s", line, desc)
				}
			}
			return
		}
	}
	t.Fatal("no delegate tool listed")
}
