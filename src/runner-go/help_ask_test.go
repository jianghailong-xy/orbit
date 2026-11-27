package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// The help center's Ask starts read-only (help_ask.go, mcp_help_ask.go): Claude Code with Read, Grep and Glob and the
// four help reads, nothing else; `orbit mcp` serving those reads alone; the article library in a scratch folder.

func askJob() *ClaimedSession {
	return &ClaimedSession{
		SessionID:   "11111111-2222-4333-8444-555555555555",
		SessionUUID: "11111111-2222-4333-8444-555555555555",
		Agent:       AgentExecConfig{Model: "claude-sonnet-5-5", PermissionMode: "bypassPermissions"},
		HelpAsk: &HelpAskMarker{Page: &HelpAskPage{
			Route: "/settings/machines", Label: "Settings → Machines", Errors: []string{"build-box is offline"},
		}},
	}
}

func TestHelpAskClaudeHasNoWriteTools(t *testing.T) {
	scratch := t.TempDir()
	args := claudeCommandArgs(askJob(), scratch, true)

	if mode := argValue(args, "--permission-mode"); mode != "dontAsk" {
		t.Fatalf("--permission-mode = %q, want dontAsk whatever the session says (bypassPermissions here)", mode)
	}
	if tools := argValue(args, "--tools"); tools != "Read,Grep,Glob" {
		t.Fatalf("--tools = %q, want the three read-only built-ins alone", tools)
	}
	allowed := argValue(args, "--allowedTools")
	want := "mcp__orbit__help_machines,mcp__orbit__help_sessions,mcp__orbit__help_tasks,mcp__orbit__help_quota"
	if allowed != want {
		t.Fatalf("--allowedTools = %q, want %q", allowed, want)
	}
	for _, write := range []string{"Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "WebFetch", "WebSearch", "Task", "Agent", "task_create", "permission_prompt"} {
		for _, flag := range []string{"--tools", "--allowedTools"} {
			value := argValue(args, flag)
			for _, name := range strings.Split(value, ",") {
				if name == write || strings.HasSuffix(name, "__"+write) {
					t.Fatalf("%s offers %s", flag, write)
				}
			}
		}
	}
	// Allowed by name, Read reads anywhere; left to Don't Ask it reads the Ask's folder alone. No settings source may widen it.
	if sources := argValue(args, "--setting-sources"); sources != "" || !hasArg(args, "--setting-sources") {
		t.Fatalf("--setting-sources = %q, want none loaded", sources)
	}
	if !hasArg(args, "--strict-mcp-config") {
		t.Fatal("an Ask must load no MCP server but Orbit's (--strict-mcp-config)")
	}
	if hasArg(args, "--permission-prompt-tool") {
		t.Fatal("an Ask asks nobody: no --permission-prompt-tool")
	}
	if hasArg(args, "--add-dir") {
		t.Fatal("an Ask reads its own folder and no other: no --add-dir")
	}
	if hasArg(args, "--system-prompt") {
		t.Fatal("the Ask's prompt is appended to the engine's, not a replacement")
	}

	if mcpPath := argValue(args, "--mcp-config"); mcpPath != "" {
		raw, err := os.ReadFile(mcpPath)
		if err != nil {
			t.Fatal(err)
		}
		var cfg struct {
			McpServers map[string]struct {
				Args []string          `json:"args"`
				Env  map[string]string `json:"env"`
			} `json:"mcpServers"`
		}
		if err := json.Unmarshal(raw, &cfg); err != nil {
			t.Fatal(err)
		}
		if len(cfg.McpServers) != 1 {
			t.Fatalf("MCP servers = %v, want orbit's alone (an agent's own servers are left out)", cfg.McpServers)
		}
		if orbit := cfg.McpServers["orbit"]; orbit.Env[envHelpAsk] != "1" || len(orbit.Args) != 1 || orbit.Args[0] != "mcp" {
			t.Fatalf("orbit server = %+v, want `orbit mcp` with %s=1", orbit, envHelpAsk)
		}
	}

	prompt := argValue(args, "--append-system-prompt")
	for _, must := range []string{
		"you change nothing", "INDEX.md", "help_machines", "help_quota", "[1]", "Sources:",
		"say you don't know", "orbit:/", "Settings → Machines", "/settings/machines", "build-box is offline",
	} {
		if !strings.Contains(prompt, must) {
			t.Errorf("the Ask's system prompt does not say %q", must)
		}
	}
	if resume := claudeCommandArgs(askJob(), scratch, false); !hasArg(resume, "--resume") || hasArg(resume, "--session-id") {
		t.Fatal("a later spawn of an Ask resumes its conversation, as any session's does")
	}
}

func TestOrdinarySessionIsNotStartedAsAnAsk(t *testing.T) {
	job := askJob()
	job.HelpAsk = nil
	args := claudeCommandArgs(job, t.TempDir(), true)
	if hasArg(args, "--tools") || hasArg(args, "--strict-mcp-config") {
		t.Fatalf("an ordinary session's argv changed: %v", args)
	}
	if mode := argValue(args, "--permission-mode"); mode != "bypassPermissions" {
		t.Fatalf("an ordinary session keeps its mode, got %q", mode)
	}
}

func TestHelpAskCapabilityIsDeclared(t *testing.T) {
	if !strings.Contains(","+runnerCapabilitiesV1+",", ","+helpAskCapabilityV1+",") {
		t.Fatalf("runner capabilities %q do not declare %s", runnerCapabilitiesV1, helpAskCapabilityV1)
	}
}

func TestHelpAskMCPServesTheFourReadsAlone(t *testing.T) {
	var mu sync.Mutex
	var seen []string
	var headers []http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Method+" "+r.URL.Path)
		headers = append(headers, r.Header.Clone())
		mu.Unlock()
		_, _ = w.Write([]byte(`{"machines":[{"name":"build-box","online":false}]}`))
	}))
	defer srv.Close()
	s := &mcpServer{t: newCallerTransport(srv.URL, "runner-token", runnerCallerMCP), sessionID: "4bA2c", helpAsk: true}

	resp, _ := s.handle(&rpcRequest{ID: json.RawMessage(`1`), Method: "tools/list"})
	var names []string
	for _, tool := range resp.Result.(map[string]interface{})["tools"].([]map[string]interface{}) {
		names = append(names, tool["name"].(string))
	}
	if got := strings.Join(names, ","); got != "help_machines,help_sessions,help_tasks,help_quota" {
		t.Fatalf("tools/list = %s, want the four reads alone", got)
	}

	for _, name := range []string{"task_create", "task_update", "session_create", "bg_run", "wiki_propose", "file_upload", "permission_prompt", "help_files"} {
		params, _ := json.Marshal(map[string]interface{}{"name": name, "arguments": map[string]interface{}{"title": "x"}})
		resp, _ := s.handle(&rpcRequest{ID: json.RawMessage(`2`), Method: "tools/call", Params: params})
		result := resp.Result.(map[string]interface{})
		if result["isError"] != true {
			t.Fatalf("%s was not refused: %v", name, result)
		}
	}
	mu.Lock()
	if len(seen) != 0 {
		t.Fatalf("a refused tool reached the control plane: %v", seen)
	}
	mu.Unlock()

	for _, read := range helpAskReads {
		params, _ := json.Marshal(map[string]interface{}{"name": "help_" + read})
		resp, _ := s.handle(&rpcRequest{ID: json.RawMessage(`3`), Method: "tools/call", Params: params})
		if result := resp.Result.(map[string]interface{}); result["isError"] != false {
			t.Fatalf("help_%s failed: %v", read, result)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if got := strings.Join(seen, ","); got != "GET /api/runner/help-ask/machines,GET /api/runner/help-ask/sessions,GET /api/runner/help-ask/tasks,GET /api/runner/help-ask/quota" {
		t.Fatalf("calls = %s, want the four read doors, GET", got)
	}
	for _, h := range headers {
		if h.Get("X-Orbit-Session-Id") != "4bA2c" || h.Get(runnerCallerHeader) != runnerCallerMCP {
			t.Fatalf("a read without the Ask's session header and caller: %v", h)
		}
	}
}

// An Ask's four reads say what they are in their descriptions, each one read-only; initialize adds nothing since
// step 7a, because no eval case guards a paragraph about them.
func TestHelpAskMCPInitializeIsEmptyAndEveryReadSaysItIsReadOnly(t *testing.T) {
	s := &mcpServer{helpAsk: true}
	resp, _ := s.handle(&rpcRequest{ID: json.RawMessage(`1`), Method: "initialize"})
	if instructions := resp.Result.(map[string]interface{})["instructions"].(string); instructions != "" {
		t.Fatalf("instructions = %q", instructions)
	}
	for read, description := range helpAskToolDescriptions {
		if !strings.HasSuffix(description, "Read-only.") {
			t.Errorf("help read %s does not say it is read-only: %q", read, description)
		}
	}
}

func TestFillHelpLibraryWritesTheArticlesAndAnIndex(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Errorf("the help doors are read signed out, got Authorization on %s", r.URL.Path)
		}
		switch r.URL.Path {
		case "/api/help":
			_, _ = w.Write([]byte(`{"categories":[{"slug":"get-started","title":"Get started"},{"slug":"machines-and-engines","title":"Machines & engines"}],
"articles":[{"slug":"a-machine-shows-offline","title":"A machine shows Offline","summary":"Why.","category":"machines-and-engines"},
{"slug":"add-your-first-machine","title":"Add your first machine","summary":"How.","category":"get-started"},
{"slug":"../escape","title":"Escape","summary":"No.","category":"get-started"}]}`))
		case "/api/help/articles/a-machine-shows-offline":
			_, _ = w.Write([]byte(`{"slug":"a-machine-shows-offline","title":"A machine shows Offline","category":"machines-and-engines","body":"A machine that sleeps stops beating."}`))
		case "/api/help/articles/add-your-first-machine":
			_, _ = w.Write([]byte(`{"slug":"add-your-first-machine","title":"Add your first machine","category":"get-started","body":"Run one command."}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	dir := t.TempDir()
	n, err := fillHelpLibrary(context.Background(), srv.URL, dir)
	if err != nil || n != 3 {
		t.Fatalf("fillHelpLibrary = %d, %v", n, err)
	}
	body, err := os.ReadFile(filepath.Join(dir, "articles", "machines-and-engines", "a-machine-shows-offline.md"))
	if err != nil || !strings.Contains(string(body), "Link: orbit:/help/machines-and-engines/a-machine-shows-offline") ||
		!strings.Contains(string(body), "A machine that sleeps stops beating.") {
		t.Fatalf("article file = %q, %v", body, err)
	}
	index, _ := os.ReadFile(filepath.Join(dir, "INDEX.md"))
	if !strings.Contains(string(index), "## Get started") || strings.Index(string(index), "Get started") > strings.Index(string(index), "Machines & engines") {
		t.Fatalf("INDEX.md lists categories in the library's order: %s", index)
	}
	if strings.Contains(string(index), "escape") {
		t.Fatal("a slug that is not a plain name is not filed")
	}
	if _, err := os.Stat(filepath.Join(dir, "escape.md")); err == nil {
		t.Fatal("a slug escaped the folder")
	}

	// A control plane that stops answering leaves the last library in place.
	srv.Close()
	if _, err := fillHelpLibrary(context.Background(), srv.URL, dir); err == nil {
		t.Fatal("want an error from a control plane that does not answer")
	}
	if _, err := os.Stat(filepath.Join(dir, "articles", "get-started", "add-your-first-machine.md")); err != nil {
		t.Fatal("the last library was removed by a failed refresh")
	}
}
