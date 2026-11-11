package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// dshChildRun runs runDshChild against the mock Harness (TestDshACPHelperProcess) in mode, with the control plane
// served by handler, and returns its result, conversation id and the events it emitted.
func dshChildRun(t *testing.T, mode string, handler http.HandlerFunc) (ExecResult, string, []dshProcessEvent, *subagentFileCollector, string) {
	t.Helper()
	spec, record := dshMockLaunchSpec(t, mode)
	var launchedHome string
	restore := prepareDshChildLaunch
	prepareDshChildLaunch = func(_ context.Context, child *ClaimedSession, cwd, home string) (DshLaunchSpec, error) {
		if child.Agent.Env[envSubagentRunID] != "run1" || !strings.Contains(child.Agent.AppendSystemPrompt, "You are a SubAgent") {
			t.Errorf("child claim = %+v", child.Agent)
		}
		launchedHome = home
		return spec, nil
	}
	restoreSeal := sealDshChildProfile
	sealDshChildProfile = func(DshLaunchSpec) error { return nil }
	t.Cleanup(func() { prepareDshChildLaunch, sealDshChildProfile = restore, restoreSeal })
	if handler == nil {
		handler = func(w http.ResponseWriter, r *http.Request) {
			t.Errorf("unexpected control-plane request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var events dshProcessEvents
	files := newSubagentFileCollector(spec.Cwd)
	scratch := t.TempDir()
	res, conversation, err := runDshChild(withSubagentApprovals(ctx, "run1"), subagentChild{
		t:      NewTransport(server.URL, "synthetic-runner-token"),
		parent: &ClaimedSession{SessionID: "dsh-parent-session", Provider: providerDsh, Agent: AgentExecConfig{Provider: providerDsh}},
		exec:   AgentExecConfig{Provider: providerDsh, Model: "model/with opaque value", Effort: "low", PermissionMode: "default"},
		def:    subagentDefinition{Name: "general"}, runID: "run1",
		cwd: spec.Cwd, scratch: scratch, stateDir: scratch, prompt: "the brief",
		emit: func(typ string, payload map[string]interface{}) {
			files.note(typ, payload)
			events.emit("", typ, payload)
		},
	})
	if err != nil {
		t.Fatalf("runDshChild: %v", err)
	}
	if launchedHome != filepath.Join(scratch, "dsh-home") {
		t.Errorf("DSH_HOME = %q, want the run's own under its scratch dir", launchedHome)
	}
	for _, request := range dshProcessRequests(t, record) {
		if request["method"] == "session/prompt" {
			prompt, _ := json.Marshal(mapValue(request["params"])["prompt"])
			if !strings.Contains(string(prompt), "the brief") {
				t.Errorf("prompt sent = %s", prompt)
			}
		}
	}
	return res, conversation, events.snapshot(), files, spec.Cwd
}

// A DSH SubAgent runs one prompt through the session's own driver and returns the reply; its events reach emit only.
func TestDshChildRunsOnePromptAndReturnsItsReply(t *testing.T) {
	res, conversation, events, _, _ := dshChildRun(t, "single", nil)
	if res.Status != stSucceeded || res.Result != "reply-1" || conversation != dshMockSessionID || res.CostUsd != 0 {
		t.Fatalf("result = %+v, conversation %q", res, conversation)
	}
	var kinds []string
	for _, e := range events {
		if e.typ == evToolUse || e.typ == evToolResult || e.typ == evAssistant {
			kinds = append(kinds, e.typ+":"+firstNonEmpty(asString(e.payload["name"]), asString(e.payload["text"]), asString(e.payload["toolUseId"])))
		}
	}
	if want := []string{"tool_use:read", "tool_result:same-tool-id", "assistant:reply-1"}; !reflect.DeepEqual(kinds, want) {
		t.Fatalf("events = %v, want %v", kinds, want)
	}
}

// A DSH SubAgent's approval goes to the parent's session as the run's card, and its allowed write counts as changed.
func TestDshChildApprovalIsTheRunsCard(t *testing.T) {
	var mu sync.Mutex
	var card map[string]interface{}
	res, _, _, files, _ := dshChildRun(t, "permission", func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/runner/sessions/dsh-parent-session/approvals":
			mu.Lock()
			_ = json.NewDecoder(r.Body).Decode(&card)
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"id": "ap1", "status": "PENDING"})
		case r.Method == http.MethodGet && r.URL.Path == "/api/runner/sessions/dsh-parent-session/approvals/ap1":
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"id": "ap1", "status": "ALLOWED"})
		default:
			t.Errorf("unexpected control-plane request: %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	})
	mu.Lock()
	defer mu.Unlock()
	if card["subagentRunId"] != "run1" || card["toolUseId"] != "run1:perm-tool" || card["toolName"] != "write" {
		t.Fatalf("approval card = %v", card)
	}
	if res.Status != stSucceeded || res.Result != "after-completed" {
		t.Fatalf("result = %+v", res)
	}
	if want := []string{"approved.txt"}; !reflect.DeepEqual(files.changed, want) {
		t.Fatalf("changed = %v, want %v", files.changed, want)
	}
}

// A DSH SubAgent's `orbit mcp` is told it serves a SubAgent, so it offers no delegate; a session's is not.
func TestDshChildMCPServerCarriesTheRunID(t *testing.T) {
	policy, _ := dshPermissionPolicyFor("default")
	envOf := func(job *ClaimedSession) map[string]string {
		servers, err := dshMCPServers(job, policy)
		if err != nil {
			t.Fatal(err)
		}
		out := map[string]string{}
		for _, pair := range mapValue(servers[0])["env"].([]map[string]string) {
			out[pair["name"]] = pair["value"]
		}
		return out
	}
	parent := &ClaimedSession{SessionID: "dsh-parent-session", Provider: providerDsh}
	if _, ok := envOf(parent)[envSubagentRunID]; ok {
		t.Fatalf("a session's orbit mcp names a SubAgent run")
	}
	child := subagentChildJob(parent, AgentExecConfig{Provider: providerDsh}, subagentDefinition{Name: "general"}, "run1", providerDsh, "")
	if got := envOf(child)[envSubagentRunID]; got != "run1" {
		t.Fatalf("%s = %q, want run1", envSubagentRunID, got)
	}
}
