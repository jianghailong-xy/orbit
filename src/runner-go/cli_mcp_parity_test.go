package main

import (
	"encoding/json"
	"flag"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// Tools that deliberately have no CLI command. permission_prompt is the runtime's live approval
// bridge — Claude calls it mid-turn over MCP and nobody types it — so it is the one tool the
// parity check below must not demand.
var cliParityExemptTools = map[string]string{
	"permission_prompt": "runtime approval bridge, called by the engine mid-turn",
}

// Params whose CLI spelling is not the mechanical --kebab-case of the MCP name.
var cliParityParamAlias = map[string]string{
	"dependsOnTaskId":  "--depends-on",
	"dependsOnTaskIds": "--depends-on",
	// Singular at a terminal, like --depends-on above: one flag carries one label and repeats,
	// which is also what makes a label containing a comma expressible.
	"labels": "--label",
	// One array of {op, taskId, dependsOnTaskId} over MCP; at a terminal the same batch is typed
	// as repeated --add A:B / --remove C:D, because nobody hand-writes JSON into a flag.
	"ops": "--add",
	// Singular at a terminal for the same reason --label is: one flag carries one path and
	// repeats, and a separator that can occur inside a value is a parser that would silently split
	// a filename in half.
	"conflicts": "--conflict",
}

// The CLI and the MCP server are two doors onto the same API, and `orbit capabilities` is what an
// agent reads to find the CLI one. So every tool must have a command, and every parameter must be
// named in that command's documented arguments — this is exactly what drifted when session_create
// grew `provider` and `permissionMode` and the hand-written argument list kept quiet about them.
func TestCLICapabilitiesCoverEveryMCPToolAndParameter(t *testing.T) {
	specs := map[string]cliCapabilitySpec{}
	for _, list := range [][]cliCapabilitySpec{baseCLICapabilities, providerCLICapabilities, projectCLICapabilities, notifyCLICapabilities, mergeReceiptCLICapabilities, sessionCLICapabilities, agentCLICapabilities} {
		for _, spec := range list {
			specs[spec.Tool] = spec
		}
	}

	for _, descriptor := range toolDescriptors(true, true) {
		name, _ := descriptor["name"].(string)
		if _, exempt := cliParityExemptTools[name]; exempt {
			if _, present := specs[name]; present {
				t.Errorf("%s is documented as CLI-exempt but has a command", name)
			}
			continue
		}
		spec, ok := specs[name]
		if !ok {
			t.Errorf("MCP tool %q has no CLI command; add one or record why it is exempt", name)
			continue
		}
		documented := strings.Join(spec.Arguments, " ")
		schema, _ := descriptor["inputSchema"].(map[string]interface{})
		props, _ := schema["properties"].(map[string]interface{})
		for _, param := range sortedParamNames(props) {
			if !cliDocumentsParam(documented, param) {
				t.Errorf("%s does not document MCP parameter %q: %v", name, param, spec.Arguments)
			}
		}
	}
}

// Workspace create has three public doors and one internal HTTP contract. This is the regression
// gate for the failure mode where CreateWorkspaceDto grows a field (repoUrl was the motivating
// case), while the runner HTTP whitelist, MCP schema/dispatcher or CLI parser/body silently stays
// behind. The HTTP whitelist is an exported literal that sanitize itself iterates; reading that
// literal here lets the Go and TypeScript halves meet without inventing a second protocol file.
func TestWorkspaceCreateParametersStayInParityAcrossHTTPMCPAndCLI(t *testing.T) {
	httpFields := typescriptStringLiteralArray(t,
		filepath.Join("..", "apiserver", "src", "runner-api", "runner-agents.controller.ts"),
		"ORCHESTRATOR_WORKSPACE_CREATE_FIELDS",
	)

	// The user-facing HTTP DTO is wider by design (human-only authorization/routing fields and
	// rolling-client compatibility fields), but every agent-safe HTTP field must still be accepted
	// there. A field can only be MCP/CLI-portable if the underlying workspace create route knows it.
	publicHTTPFields := typescriptClassFields(t,
		filepath.Join("..", "apiserver", "src", "workspaces", "dto.ts"),
		"CreateWorkspaceDto",
		"UpdateWorkspaceDto",
	)
	publicSet := stringSet(publicHTTPFields)
	for _, field := range httpFields {
		if !publicSet[field] {
			t.Errorf("runner HTTP create field %q is missing from CreateWorkspaceDto", field)
		}
	}

	mcpFields := sortedParamNames(mcpToolProps(toolDescriptors(false, true), "agent_create"))
	assertSameStringSet(t, "MCP agent_create schema vs runner HTTP create", httpFields, mcpFields)

	values := map[string]interface{}{
		"name":               "parity",
		"description":        "every create field",
		"systemPrompt":       "system",
		"appendSystemPrompt": "append",
		"workDir":            "/srv/existing",
		"runnerId":           "runner-2",
		"repoUrl":            "https://github.com/acme/parity.git",
		"enableWorktree":     true,
		"env":                map[string]interface{}{"REGION": "eu"},
		"defaultMergeTarget": "main",
	}
	var mcpBody map[string]interface{}
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/runner/agents" {
			t.Errorf("agent_create hit %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&mcpBody); err != nil {
			t.Errorf("decode MCP create body: %v", err)
		}
		_, _ = w.Write([]byte(`{"id":"workspace-1","provisionState":"READY"}`))
	}))
	defer api.Close()
	mcp := &mcpServer{
		t:                  NewTransport(api.URL, "runner-token"),
		sessionID:          "caller-session",
		orchestrationToken: "session-token",
		allowOrchestration: true,
	}
	if result := mcp.callTool("agent_create", values); result["isError"] == true {
		t.Fatalf("agent_create returned an error: %#v", result["content"])
	}
	assertSameStringSet(t, "MCP forwarded body vs runner HTTP create", httpFields, mapKeys(mcpBody))

	fs := newCLIFlagSet("orbit agent create")
	flags := registerAgentWriteFlags(fs, true)
	cliFields := []string{}
	fs.VisitAll(func(cliFlag *flag.Flag) {
		switch cliFlag.Name {
		case "enable-worktree":
			cliFields = append(cliFields, "enableWorktree")
		case "env":
			cliFields = append(cliFields, "env")
		default:
			field, ok := agentCLIBodyField[cliFlag.Name]
			if !ok {
				t.Errorf("CLI create flag --%s has no HTTP field mapping", cliFlag.Name)
				return
			}
			cliFields = append(cliFields, field)
		}
	})
	assertSameStringSet(t, "CLI create flags vs runner HTTP create", httpFields, cliFields)
	if err := fs.Parse([]string{
		"--name", "parity",
		"--description", "every create field",
		"--system-prompt", "system",
		"--append-system-prompt", "append",
		"--work-dir", "/srv/existing",
		"--runner-id", "runner-2",
		"--repo-url", "https://github.com/acme/parity.git",
		"--enable-worktree=true",
		"--env", "REGION=eu",
		"--default-merge-target", "main",
	}); err != nil {
		t.Fatal(err)
	}
	cliBody := map[string]interface{}{}
	if err := flags.body(fs, cliBody); err != nil {
		t.Fatal(err)
	}
	assertSameStringSet(t, "CLI forwarded body vs runner HTTP create", httpFields, mapKeys(cliBody))
}

func typescriptStringLiteralArray(t *testing.T, path, name string) []string {
	t.Helper()
	source, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	startMarker := "export const " + name + " = ["
	start := strings.Index(string(source), startMarker)
	if start < 0 {
		t.Fatalf("%s has no %s literal", path, name)
	}
	rest := string(source)[start+len(startMarker):]
	end := strings.Index(rest, "] as const;")
	if end < 0 {
		t.Fatalf("%s has no end for %s literal", path, name)
	}
	matches := regexp.MustCompile(`'([A-Za-z][A-Za-z0-9]*)'`).FindAllStringSubmatch(rest[:end], -1)
	fields := make([]string, 0, len(matches))
	for _, match := range matches {
		fields = append(fields, match[1])
	}
	if len(fields) == 0 {
		t.Fatalf("%s %s has no fields", path, name)
	}
	return fields
}

func typescriptClassFields(t *testing.T, path, className, nextClassName string) []string {
	t.Helper()
	source, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	startMarker := "export class " + className + " {"
	start := strings.Index(string(source), startMarker)
	if start < 0 {
		t.Fatalf("%s has no %s", path, className)
	}
	rest := string(source)[start+len(startMarker):]
	end := strings.Index(rest, "export class "+nextClassName+" {")
	if end < 0 {
		t.Fatalf("%s has no %s after %s", path, nextClassName, className)
	}
	// Decorators and the property often share one line (`@IsOptional() @IsString() repoUrl?:`),
	// so anchor on the TypeScript property punctuation rather than the beginning of the line.
	matches := regexp.MustCompile(`\b([A-Za-z][A-Za-z0-9]*)[!?]:`).FindAllStringSubmatch(rest[:end], -1)
	fields := make([]string, 0, len(matches))
	for _, match := range matches {
		fields = append(fields, match[1])
	}
	return fields
}

func stringSet(values []string) map[string]bool {
	out := make(map[string]bool, len(values))
	for _, value := range values {
		out[value] = true
	}
	return out
}

func mapKeys(values map[string]interface{}) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	return keys
}

func assertSameStringSet(t *testing.T, label string, want, got []string) {
	t.Helper()
	want = append([]string{}, want...)
	got = append([]string{}, got...)
	sort.Strings(want)
	sort.Strings(got)
	if strings.Join(want, "\x00") != strings.Join(got, "\x00") {
		t.Errorf("%s:\nwant %v\n got %v", label, want, got)
	}
}

// A parameter counts as documented when the arguments name its flag (--kebab-case), its
// positional form ([kebab-case]), or the alias the CLI deliberately uses instead.
func cliDocumentsParam(documented, param string) bool {
	kebab := kebabCase(param)
	if strings.Contains(documented, "--"+kebab) || strings.Contains(documented, "["+kebab+"]") {
		return true
	}
	alias, ok := cliParityParamAlias[param]
	return ok && strings.Contains(documented, alias)
}

func kebabCase(s string) string {
	var b strings.Builder
	for i, r := range s {
		if r >= 'A' && r <= 'Z' {
			if i > 0 {
				b.WriteByte('-')
			}
			b.WriteRune(r + ('a' - 'A'))
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

func sortedParamNames(m map[string]interface{}) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
