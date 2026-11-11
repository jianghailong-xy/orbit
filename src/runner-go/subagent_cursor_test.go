package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// A Cursor SubAgent runs the recorded CLI in child mode: one prompt in the parent's cwd, its CLI state under the
// run's own dir, its `orbit mcp` told the run, its cards filed under the run, its edit counted as a changed file,
// and its end returned with the conversation it ran in.
func TestCursorChildRunsOnePromptInTheParentsCwd(t *testing.T) {
	useCursorRealHome(t)
	useCursorSlashRegistry(t)
	fake := newCursorReplay(t, "multi-turn-tools-default/turns", "")
	prev := cursorChildExecutable
	cursorChildExecutable = func(context.Context) (string, error) { return fake.shim, nil }
	t.Cleanup(func() { cursorChildExecutable = prev })

	var mu sync.Mutex
	var cards []map[string]interface{}
	prefix := "/api/runner/sessions/" + cursorTestSessionID + "/approvals"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == prefix:
			var body map[string]interface{}
			_ = json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			cards = append(cards, body)
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "approval-1", "status": "PENDING"})
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, prefix+"/"):
			_ = json.NewEncoder(w).Encode(ApprovalDecisionResponse{ID: "approval-1", Status: "DENIED"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	parent := &ClaimedSession{SessionID: cursorTestSessionID, Provider: providerCursor, Title: "parent",
		Agent: AgentExecConfig{Provider: providerCursor, Env: map[string]string{"CURSOR_API_KEY": cursorTestKey}}}
	cwd, scratch := t.TempDir(), t.TempDir()
	files := newSubagentFileCollector(cwd)
	var events []string
	emit := func(eventType string, payload map[string]interface{}) {
		files.note(eventType, payload)
		if out, ok := rewriteSubagentEvent("run1", "toolu_delegate", eventType, payload); ok {
			mu.Lock()
			events = append(events, eventType+" "+asString(out["parentToolUseId"]))
			mu.Unlock()
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	res, conversation, err := runCursorChild(withSubagentApprovals(ctx, "run1"), subagentChild{
		t: NewTransport(server.URL, "synthetic-runner-token"), parent: parent,
		exec: AgentExecConfig{Provider: providerCursor, Env: map[string]string{"CURSOR_API_KEY": cursorTestKey}},
		def:  subagentDefinition{Name: "general"}, runID: "run1", cwd: cwd, scratch: scratch, stateDir: scratch,
		prompt: "do the thing", emit: emit,
	})
	if err != nil {
		t.Fatalf("runCursorChild: %v", err)
	}
	if res.Status != stSucceeded || strings.TrimSpace(res.Result) == "" {
		t.Fatalf("result = %+v", res)
	}
	if conversation == "" {
		t.Fatal("no conversation id returned")
	}

	// The CLI ran in the parent's cwd, with its config dir under the run's scratch, and knew the run.
	start := fake.started(t)
	startJSON, _ := json.Marshal(start)
	if !strings.Contains(string(startJSON), envSubagentRunID+"=run1") {
		t.Errorf("the CLI's environment lacks %s: %s", envSubagentRunID, startJSON)
	}
	if want := filepath.Join(scratch, "cursor", "config"); !strings.Contains(string(startJSON), want) {
		t.Errorf("CURSOR_CONFIG_DIR is not under the run's scratch %s: %s", want, startJSON)
	}
	opens := fake.requests(t, "session/new")
	if len(opens) != 1 {
		t.Fatalf("session/new sent %d times", len(opens))
	}
	servers, _ := json.Marshal(mapValue(opens[0].Message["params"])["mcpServers"])
	if !strings.Contains(string(servers), `{"name":"`+envSubagentRunID+`","value":"run1"}`) {
		t.Errorf("Orbit's MCP server is not told the run: %s", servers)
	}
	prompts := fake.requests(t, "session/prompt")
	if len(prompts) != 1 {
		t.Fatalf("session/prompt sent %d times, want one", len(prompts))
	}
	promptJSON, _ := json.Marshal(prompts[0].Message["params"])
	if !strings.Contains(string(promptJSON), "You are a SubAgent") || !strings.Contains(string(promptJSON), "do the thing") {
		t.Errorf("the prompt lacks the preamble or the brief: %s", promptJSON)
	}

	// Every kept event nests under the delegate call; the cards name the run.
	mu.Lock()
	defer mu.Unlock()
	if len(events) == 0 {
		t.Fatal("no child events reached the parent")
	}
	for _, e := range events {
		if !strings.HasSuffix(e, " toolu_delegate") {
			t.Errorf("event not nested under the delegate call: %s", e)
		}
	}
	if len(cards) == 0 {
		t.Fatal("the recording's permission requests filed no card")
	}
	for _, card := range cards {
		if card["subagentRunId"] != "run1" || !strings.HasPrefix(asString(card["toolUseId"]), "run1:") {
			t.Errorf("card not filed under the run: %v", card)
		}
	}
	// The recorded new file, written by Cursor's edit tool (Write, file_path).
	found := false
	for _, p := range files.changed {
		if strings.HasSuffix(p, "probe-write.txt") {
			found = true
		}
	}
	if !found {
		t.Errorf("changed files = %v, want probe-write.txt", files.changed)
	}
}
