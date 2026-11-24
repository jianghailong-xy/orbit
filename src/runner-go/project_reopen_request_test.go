package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const reopenFiledBody = `{"ok":true,"outcome":"written","id":"34XreopenReq0000001","status":"PENDING","alreadyOpen":false}`

type reopenSeen struct {
	method, path, session string
	body                  map[string]interface{}
}

func reopenServer(t *testing.T, status int, answer string) (*[]reopenSeen, string) {
	t.Helper()
	seen := &[]reopenSeen{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		*seen = append(*seen, reopenSeen{r.Method, r.URL.Path, r.Header.Get("X-Orbit-Session-Id"), body})
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(answer))
	}))
	t.Cleanup(srv.Close)
	configureCLITestRunner(t, srv.URL)
	return seen, srv.URL
}

func TestProjectRequestReopenToolSchemaAndDescription(t *testing.T) {
	for _, tools := range [][]map[string]interface{}{toolDescriptors(false, false), toolDescriptors(true, true)} {
		if !hasMCPTool(tools, "project_request_reopen") {
			t.Fatal("project_request_reopen is missing from the tools")
		}
	}
	tools := toolDescriptors(false, false)
	props := mcpToolProps(tools, "project_request_reopen")
	for _, want := range []string{"projectId", "why", "plannedWork"} {
		if _, ok := props[want]; !ok {
			t.Fatalf("project_request_reopen does not take %q: %#v", want, props)
		}
	}
	for _, tool := range tools {
		if tool["name"] != "project_request_reopen" {
			continue
		}
		schema, _ := tool["inputSchema"].(map[string]interface{})
		required, _ := schema["required"].([]string)
		if strings.Join(required, ",") != "projectId,why,plannedWork" {
			t.Fatalf("project_request_reopen requires %v", required)
		}
	}
	description := mcpToolDescription(tools, "project_request_reopen")
	for _, want := range []string{"Ask the account owner to reopen a DONE or CANCELLED project",
		"PROJECT_REOPEN_REQUIRED", "It returns at once", "do not ask again"} {
		if !strings.Contains(description, want) {
			t.Fatalf("description does not say %q: %q", want, description)
		}
	}
}

func TestProjectRequestReopenToolPostsAsTheSession(t *testing.T) {
	seen, url := reopenServer(t, http.StatusCreated, reopenFiledBody)
	mcp := &mcpServer{t: NewTransport(url, "tok"), sessionID: "sess-9"}
	res := mcp.callTool("project_request_reopen", map[string]interface{}{
		"projectId": "proj-1", "why": "  The criteria changed.  ", "plannedWork": " Add a test. ",
	})
	if res["isError"] == true {
		t.Fatalf("error: %s", toolText(t, res))
	}
	if len(*seen) != 1 {
		t.Fatalf("made %d requests", len(*seen))
	}
	got := (*seen)[0]
	if got.method != http.MethodPost || got.path != "/api/runner/projects/proj-1/reopen-requests" || got.session != "sess-9" {
		t.Fatalf("sent %#v", got)
	}
	if got.body["why"] != "The criteria changed." || got.body["plannedWork"] != "Add a test." || len(got.body) != 2 {
		t.Fatalf("body %#v", got.body)
	}
	text := toolText(t, res)
	for _, want := range []string{"34XreopenReq0000001", "PENDING", "written", "alreadyOpen"} {
		if !strings.Contains(text, want) {
			t.Fatalf("result does not say %q: %s", want, text)
		}
	}
	for _, args := range []map[string]interface{}{
		{"why": "x", "plannedWork": "y"},
		{"projectId": "proj-1", "why": " ", "plannedWork": "y"},
		{"projectId": "proj-1", "why": "x"},
	} {
		if res := mcp.callTool("project_request_reopen", args); res["isError"] != true {
			t.Fatalf("%v was accepted", args)
		}
	}
	if len(*seen) != 1 {
		t.Fatalf("a malformed call reached the server: %d", len(*seen))
	}
}

func TestProjectRequestReopenCLISendsTheSameRequest(t *testing.T) {
	seen, _ := reopenServer(t, http.StatusCreated, reopenFiledBody)
	t.Setenv("ORBIT_SESSION_ID", "sess-1")
	t.Setenv("ORBIT_SERVICE_TOKEN", "")
	var out bytes.Buffer
	if err := cmdProjectCLI([]string{"request-reopen", "proj-1", "--why", "Because.", "--planned-work", "Fix it.", "--json"},
		strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	if len(*seen) != 1 || (*seen)[0].session != "sess-1" || (*seen)[0].path != "/api/runner/projects/proj-1/reopen-requests" {
		t.Fatalf("sent %#v", *seen)
	}
	if b := (*seen)[0].body; b["why"] != "Because." || b["plannedWork"] != "Fix it." {
		t.Fatalf("body %#v", b)
	}
	if !strings.Contains(out.String(), "34XreopenReq0000001") {
		t.Fatalf("printed %q", out.String())
	}
	if err := cmdProjectCLI([]string{"request-reopen", "proj-1", "--why", "Because."}, strings.NewReader(""), &out); err == nil ||
		!strings.Contains(err.Error(), "plannedWork") {
		t.Fatalf("missing planned work accepted: %v", err)
	}
	t.Setenv("ORBIT_SESSION_ID", "")
	if err := cmdProjectCLI([]string{"request-reopen", "proj-1", "--why", "a", "--planned-work", "b"}, strings.NewReader(""), &out); err == nil ||
		!strings.Contains(err.Error(), "ORBIT_SESSION_ID") {
		t.Fatalf("no session accepted: %v", err)
	}
	if len(*seen) != 1 {
		t.Fatalf("a refused command reached the server: %d", len(*seen))
	}
}
