package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// SubAgent definitions (docs/subagent-design.md §3): the types a `delegate` call may name. Two are built in;
// the rest are *.md files under .cursor/agents, .claude/agents and .codex/agents of the session's working
// directory, then the same three under the user's home. On a name clash the first of those six wins: project
// before user, then .cursor before .claude before .codex. A file may take a built-in's name and replace it.
//
// They are read from the directory the session works in — the cwd `orbit mcp` was started in, the execDir the
// runner starts the child in — so a definition added on the session's own branch is found, which a scan of the
// workspace's workDir would miss.

// subagentDefinitionDirs are the per-root directories, in precedence order.
var subagentDefinitionDirs = []string{".cursor/agents", ".claude/agents", ".codex/agents"}

// subagentHomeDir is the user's home the second three directories sit under; a var so tests point it elsewhere.
var subagentHomeDir = os.UserHomeDir

// subagentReadonlyDisallowed are the edit tools a read-only SubAgent is not given.
var subagentReadonlyDisallowed = []string{"Edit", "MultiEdit", "Write", "NotebookEdit"}

type subagentDefinition struct {
	Name        string
	Description string
	// Source is what the server records as definitionSource: "builtin", or the file's path relative to the
	// working directory (".claude/agents/x.md") or to the home ("~/.claude/agents/x.md").
	Source string
	// Model is the frontmatter's model as written: inherit, auto or an id. The server's router reads it, and
	// counts an id no provider lists as auto, saying so in its Why.
	Model string
	// Size is S, M, L or XL; any other value was ignored.
	Size string
	// Readonly runs the SubAgent in plan mode without edit tools.
	Readonly bool
	// PermissionMode is the frontmatter's permissionMode when it is one of Claude Code's modes; empty runs the
	// SubAgent in its parent's mode. The server refuses one wider than the parent's (§5.3).
	PermissionMode string
	// Tools and DisallowedTools go to engines that support them.
	Tools           []string
	DisallowedTools []string
	// Background is the default for the call's background; nil leaves it false.
	Background *bool
	// Prompt is the file's body: the child's system prompt, after the fixed preamble.
	Prompt string
}

func (d subagentDefinition) builtin() bool { return d.Source == "builtin" }

var builtinSubagentDefinitions = []subagentDefinition{
	{Name: "general", Source: "builtin", Size: "M",
		Description: "Any work, may edit files; runs with this session's permission mode (the default type)."},
	{Name: "explore", Source: "builtin", Size: "S", Readonly: true,
		Description: "Read-only: finding and reading code, answering where something is or how it works."},
}

// loadSubagentDefinitions returns the built-ins and every definition file under cwd and home, one per name,
// sorted by name with the built-ins first.
func loadSubagentDefinitions(cwd, home string) []subagentDefinition {
	byName := map[string]subagentDefinition{}
	var order []string
	add := func(d subagentDefinition) {
		if _, taken := byName[d.Name]; !taken {
			order = append(order, d.Name)
		}
		byName[d.Name] = d
	}
	// Lowest precedence first, so a later add replaces an earlier one.
	for _, d := range builtinSubagentDefinitions {
		add(d)
	}
	type root struct{ dir, label string }
	var roots []root
	if home != "" {
		roots = append(roots, root{home, "~/"})
	}
	if cwd != "" && (home == "" || filepath.Clean(cwd) != filepath.Clean(home)) {
		roots = append(roots, root{cwd, ""})
	}
	for _, r := range roots {
		for i := len(subagentDefinitionDirs) - 1; i >= 0; i-- {
			rel := subagentDefinitionDirs[i]
			for _, d := range readSubagentDefinitionDir(filepath.Join(r.dir, rel), r.label+rel) {
				add(d)
			}
		}
	}
	out := make([]subagentDefinition, 0, len(order))
	for _, name := range order {
		out = append(out, byName[name])
	}
	builtins := map[string]int{}
	for i, d := range builtinSubagentDefinitions {
		builtins[d.Name] = i + 1
	}
	sort.SliceStable(out, func(i, j int) bool {
		bi, bj := builtins[out[i].Name], builtins[out[j].Name]
		if (bi > 0) != (bj > 0) {
			return bi > 0
		}
		if bi > 0 {
			return bi < bj
		}
		return out[i].Name < out[j].Name
	})
	return out
}

// readSubagentDefinitionDir reads one directory's *.md files, sorted by file name so a clash inside one
// directory resolves the same way every time (the first file wins).
func readSubagentDefinitionDir(dir, label string) []subagentDefinition {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []subagentDefinition
	seen := map[string]bool{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		d := parseSubagentDefinition(filepath.Join(dir, e.Name()))
		d.Source = label + "/" + e.Name()
		if d.Name == "" || seen[d.Name] {
			continue
		}
		seen[d.Name] = true
		out = append(out, d)
	}
	return out
}

func parseSubagentDefinition(path string) subagentDefinition {
	fields, body, ok := readFrontmatterFields(path)
	if !ok {
		raw, _ := os.ReadFile(path)
		body = string(raw)
	}
	d := subagentDefinition{
		Name:        strings.TrimSpace(fields["name"]),
		Description: fields["description"],
		Model:       strings.TrimSpace(fields["model"]),
		Tools:       frontmatterList(fields["tools"]),
		Prompt:      strings.TrimSpace(body),
	}
	if d.Name == "" {
		d.Name = strings.TrimSuffix(filepath.Base(path), ".md")
	}
	d.DisallowedTools = frontmatterList(firstNonEmpty(fields["disallowedTools"], fields["disallowed_tools"]))
	switch size := strings.ToUpper(strings.TrimSpace(fields["size"])); size {
	case "S", "M", "L", "XL":
		d.Size = size
	}
	d.Readonly = frontmatterBool(fields["readonly"])
	switch mode := strings.TrimSpace(fields["permissionMode"]); mode {
	case "default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions":
		d.PermissionMode = mode
	}
	if v, set := fields["is_background"]; set && strings.TrimSpace(v) != "" {
		b := frontmatterBool(v)
		d.Background = &b
	}
	return d
}

// frontmatterList reads "a, b", "[a, b]" or a block list (joined with commas by readFrontmatterFields).
func frontmatterList(v string) []string {
	v = strings.TrimSpace(v)
	v = strings.TrimSuffix(strings.TrimPrefix(v, "["), "]")
	var out []string
	for _, item := range strings.Split(v, ",") {
		if item = strings.Trim(strings.TrimSpace(item), `"'`); item != "" {
			out = append(out, item)
		}
	}
	return out
}

func frontmatterBool(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "true", "yes", "on":
		return true
	}
	return false
}

// findSubagentDefinition is the definition a call's type names; an empty type is general.
func findSubagentDefinition(defs []subagentDefinition, kind string) (subagentDefinition, error) {
	if kind == "" {
		kind = "general"
	}
	names := make([]string, 0, len(defs))
	for _, d := range defs {
		if d.Name == kind {
			return d, nil
		}
		names = append(names, fmt.Sprintf("%q", d.Name))
	}
	return subagentDefinition{}, fmt.Errorf("unknown SubAgent type %q: use one of %s", kind, strings.Join(names, ", "))
}

// sessionSubagentDefinitions reads the definitions of a working directory and the user's home.
func sessionSubagentDefinitions(cwd string) []subagentDefinition {
	home, _ := subagentHomeDir()
	return loadSubagentDefinitions(cwd, home)
}

// subagentTypesDescription is the part of the delegate tool's description that lists the types.
func subagentTypesDescription(defs []subagentDefinition) string {
	var b strings.Builder
	b.WriteString("Types (name: description):")
	for _, d := range defs {
		desc := strings.TrimSpace(d.Description)
		if desc == "" {
			desc = "(no description)"
		}
		b.WriteString("\n- " + d.Name + ": " + desc)
	}
	return b.String()
}

// subagentStartBody is the POST that opens a run on the server: the call's own fields and what the definition
// says, so routing can read the definition's model and size.
func subagentStartBody(args map[string]interface{}, def subagentDefinition, toolUseID string, background bool) map[string]interface{} {
	body := map[string]interface{}{
		"toolUseId":        toolUseID,
		"type":             def.Name,
		"definitionSource": def.Source,
		"background":       background,
		"readonly":         def.Readonly,
	}
	for _, key := range []string{"size", "sizeReason", "model"} {
		if v := strings.TrimSpace(getString(args, key)); v != "" {
			body[key] = v
		}
	}
	// A built-in's tier is the type's default, which the router already knows; only a file's are sent.
	if !def.builtin() {
		if def.Model != "" {
			body["definitionModel"] = def.Model
		}
		if def.Size != "" {
			body["definitionSize"] = def.Size
		}
		if def.PermissionMode != "" {
			body["permissionMode"] = def.PermissionMode
		}
	}
	return body
}

// subagentSystemPrompt is the child's appended system prompt: the fixed preamble, then the definition's body.
func subagentSystemPrompt(def subagentDefinition) string {
	if def.Prompt == "" {
		return subagentPreamble
	}
	return subagentPreamble + "\n\n" + def.Prompt
}
