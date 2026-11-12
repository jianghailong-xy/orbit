package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

type criterionCallSeen struct {
	method, path, session string
	body                  map[string]interface{}
}

func criterionServer(t *testing.T, status int) (*httptest.Server, *[]criterionCallSeen) {
	t.Helper()
	seen := &[]criterionCallSeen{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		*seen = append(*seen, criterionCallSeen{r.Method, r.URL.Path, r.Header.Get("X-Orbit-Session-Id"), body})
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"definitionId":"crit-1","revision":2,"confirmation":{"state":"CONFIRMED"}}`))
	}))
	t.Cleanup(srv.Close)
	return srv, seen
}

// The coordinator's three doors post to the criterion's routes as the calling session, which is
// the authority the server checks against the project's coordinator pointer.
func TestCriterionConfirmationToolsPostAsTheCallingSession(t *testing.T) {
	srv, seen := criterionServer(t, http.StatusOK)
	mcp := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "343dlzsYWKo5z8l2M8tsB"}
	cases := []struct {
		tool string
		args map[string]interface{}
		path string
		body string
	}{
		{"criterion_confirm", map[string]interface{}{
			"projectId": "proj-1", "criterionId": "crit-1", "note": "read the ICP record", "revision": 2,
			"attachmentIds": []interface{}{"att-1"},
		}, "/api/runner/projects/proj-1/criteria/crit-1/confirmations",
			`{"attachmentIds":["att-1"],"note":"read the ICP record","revision":2}`},
		{"criterion_confirmation_withdraw", map[string]interface{}{"projectId": "proj-1", "criterionId": "crit-1"},
			"/api/runner/projects/proj-1/criteria/crit-1/confirmations/withdraw", `{}`},
		{"criterion_check_start", map[string]interface{}{
			"projectId": "proj-1", "criterionId": "crit-1", "instructions": "use staging",
		}, "/api/runner/projects/proj-1/criteria/crit-1/checks", `{"instructions":"use staging"}`},
		{"criterion_check_report", map[string]interface{}{"verdict": "FAIL", "note": "no filing number"},
			"/api/runner/criterion-checks/report", `{"note":"no filing number","verdict":"FAIL"}`},
	}
	for i, tc := range cases {
		res := mcp.callTool(tc.tool, tc.args)
		if res["isError"] == true {
			t.Fatalf("%s returned an error: %s", tc.tool, toolText(t, res))
		}
		if len(*seen) != i+1 {
			t.Fatalf("%s made %d requests in all", tc.tool, len(*seen))
		}
		got := (*seen)[i]
		if got.method != http.MethodPost || got.path != tc.path {
			t.Fatalf("%s reached %s %s, want POST %s", tc.tool, got.method, got.path, tc.path)
		}
		if got.session != "343dlzsYWKo5z8l2M8tsB" {
			t.Fatalf("%s session header = %q", tc.tool, got.session)
		}
		body, _ := json.Marshal(got.body)
		if string(body) != tc.body {
			t.Fatalf("%s sent %s, want %s", tc.tool, body, tc.body)
		}
	}
}

// What the server refuses comes back as a tool error, and a bad verdict never leaves the runner.
func TestCriterionToolsReportRefusalsAndValidateArguments(t *testing.T) {
	srv, seen := criterionServer(t, http.StatusForbidden)
	mcp := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "343dlzsYWKo5z8l2M8tsB"}
	if res := mcp.callTool("criterion_confirm", map[string]interface{}{"projectId": "proj-1", "criterionId": "crit-1"}); res["isError"] != true {
		t.Fatalf("a 403 read as success: %s", toolText(t, res))
	}
	if res := mcp.callTool("criterion_confirm", map[string]interface{}{"projectId": "proj-1"}); res["isError"] != true {
		t.Fatalf("a missing criterionId was not refused")
	}
	if res := mcp.callTool("criterion_check_report", map[string]interface{}{"verdict": "MAYBE"}); res["isError"] != true {
		t.Fatalf("a verdict other than PASS/FAIL was not refused")
	}
	if len(*seen) != 1 {
		t.Fatalf("refused arguments reached the server: %d requests", len(*seen))
	}
	tools := toolDescriptors(false, false)
	for _, name := range []string{"criterion_confirm", "criterion_confirmation_withdraw", "criterion_check_start", "criterion_check_report"} {
		if !hasMCPTool(tools, name) {
			t.Fatalf("%s is not advertised", name)
		}
	}
}
