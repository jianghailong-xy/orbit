package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

func TestSubagentRateMCPAndCLI(t *testing.T) {
	t.Setenv(envSubagentRunID, "")
	t.Setenv(envMCPOrchestration, "")
	t.Setenv("ORBIT_SESSION_ID", "cli-session")
	note := strings.Repeat("🎯", maxSubagentRatingNoteChars)
	type request struct {
		path string
		body map[string]interface{}
	}
	sent := make(chan request, 2)
	const rating = `{"runId":"Run123","score":4,"note":null,"ratedAt":"2026-11-21T00:00:00.000Z","rater":{"engine":"codex","provider":"openai","model":"gpt-6"},"replaced":false}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/runner/sessions/mcp-session/subagents/Run123/rating", "/api/runner/sessions/cli-session/subagents/Run123/rating":
		default:
			t.Errorf("unexpected request path %q", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer runner-secret" {
			t.Errorf("request method or runner credential is wrong: %s, %v", r.Method, r.Header)
		}
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		sent <- request{r.URL.Path, body}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, rating)
	}))
	defer server.Close()

	s := &mcpServer{sessionID: "mcp-session", t: NewTransport(server.URL, "runner-secret")}
	params := subagentJSON(map[string]interface{}{
		"name":      "subagent_rate",
		"arguments": map[string]interface{}{"runId": "Run123", "score": 4, "note": note},
	})
	res, _ := s.handle(&rpcRequest{Method: "tools/call", Params: params})
	var receipt toolReceipt
	if err := json.Unmarshal([]byte(toolText(t, res.Result.(map[string]interface{}))), &receipt); err != nil {
		t.Fatal(err)
	}
	if !receipt.OK || receipt.Outcome != outcomeWritten || receipt.ID == nil || *receipt.ID != "Run123" || compactReceiptJSON(string(receipt.Entity)) != rating {
		t.Fatalf("unexpected rating receipt: %+v, entity %s", receipt, receipt.Entity)
	}
	if got := <-sent; got.path != "/api/runner/sessions/mcp-session/subagents/Run123/rating" ||
		!reflect.DeepEqual(got.body, map[string]interface{}{"score": 4.0, "note": note}) {
		t.Error("MCP did not send the calling session, score and note")
	}

	configureCLITestRunner(t, server.URL)
	var out, stderr bytes.Buffer
	if err := runOrbitCLI([]string{"subagent", "rate", "Run123", "--score", "4", "--json"}, strings.NewReader(""), &out, &stderr); err != nil {
		t.Fatalf("rate command: %v\n%s\n%s", err, out.String(), stderr.String())
	}
	if got := strings.TrimSpace(out.String()); got != rating {
		t.Errorf("CLI output = %s", got)
	}
	if got := <-sent; got.path != "/api/runner/sessions/cli-session/subagents/Run123/rating" ||
		!reflect.DeepEqual(got.body, map[string]interface{}{"score": 4.0}) {
		t.Errorf("CLI sent unexpected rating request: %+v", got)
	}
	out.Reset()
	if err := runOrbitCLI([]string{"subagent", "rate", "--help"}, strings.NewReader(""), &out, &stderr); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), subagentRateUsage) || !strings.Contains(out.String(), subagentRateDescription) {
		t.Errorf("unexpected leaf help:\n%s", out.String())
	}
}

func TestSubagentRateRejectsInvalidCallsBeforeHTTP(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		http.Error(w, "unexpected request", http.StatusInternalServerError)
	}))
	defer server.Close()

	for _, tc := range []struct {
		name, session, child, runID string
		score                       float64
		note, want                  string
	}{
		{name: "score zero", session: "parent", runID: "Run123", score: 0, want: "score"},
		{name: "score six", session: "parent", runID: "Run123", score: 6, want: "score"},
		{name: "fractional score", session: "parent", runID: "Run123", score: 2.5, want: "score"},
		{name: "long note", session: "parent", runID: "Run123", score: 3, note: strings.Repeat("🎯", 501), want: "note"},
		{name: "outside a session", runID: "Run123", score: 3, want: "ORBIT_SESSION_ID"},
		{name: "inside a SubAgent", session: "parent", child: "child", runID: "Run123", score: 3, want: "a SubAgent cannot rate a SubAgent run"},
		{name: "unsafe run id", session: "parent", runID: "../Run123", score: 3, want: "runId"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(envSubagentRunID, tc.child)
			s := &mcpServer{sessionID: tc.session, t: NewTransport(server.URL, "runner-secret")}
			args := map[string]interface{}{"runId": tc.runID, "score": tc.score, "note": tc.note}
			for _, result := range []map[string]interface{}{s.invokeTool("subagent_rate", args), s.runTool("subagent_rate", args)} {
				if result["isError"] != true || !strings.Contains(toolText(t, result), tc.want) {
					t.Errorf("expected refusal containing %q, got %v", tc.want, result)
				}
			}
		})
	}
	if got := calls.Load(); got != 0 {
		t.Errorf("invalid calls reached HTTP %d times", got)
	}
}

func TestSubagentRateToolsList(t *testing.T) {
	s := &mcpServer{sessionID: "parent"}
	for _, runID := range []string{"", "child"} {
		t.Setenv(envSubagentRunID, runID)
		res, _ := s.handle(&rpcRequest{Method: "tools/list"})
		listed := res.Result.(map[string]interface{})["tools"].([]map[string]interface{})
		if hasMCPTool(listed, "subagent_rate") != (runID == "") {
			t.Errorf("wrong subagent_rate visibility with %s=%q", envSubagentRunID, runID)
		}
	}
}

func TestDelegateResultOffersOptionalRatingWhenEnded(t *testing.T) {
	for _, status := range []string{subagentStatusDone, subagentStatusFailed, subagentStatusRunning} {
		result := delegateResult(subagentReport{RunID: "Run123", Status: status})
		var doc map[string]interface{}
		if err := json.Unmarshal([]byte(toolText(t, result)), &doc); err != nil {
			t.Fatal(err)
		}
		rate, present := doc["rate"].(string)
		if status == subagentStatusRunning {
			if present {
				t.Errorf("running result offers a rating: %q", rate)
			}
		} else if !strings.Contains(rate, "subagent_rate") || !strings.Contains(rate, "Optional; nothing waits on it.") {
			t.Errorf("status %s has unexpected rating guidance %q", status, rate)
		}
	}
}
