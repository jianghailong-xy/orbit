package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The task writes the control plane answers differently for a run name the session they come from: a
// delete, a list's delete, an edge, a batch of edges and a progress report, through the MCP tool and the CLI alike, whose
// callers hold no session of their own to pass. A process in no session names none, which is how the
// account owner's own terminal reaches those doors, and a read names none either way.

type namedSessionRequest struct{ method, path, session string }

func recordNamedSessions(t *testing.T) (*httptest.Server, *[]namedSessionRequest) {
	t.Helper()
	var seen []namedSessionRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, namedSessionRequest{r.Method, r.URL.Path, r.Header.Get("X-Orbit-Session-Id")})
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(srv.Close)
	return srv, &seen
}

func TestMCPTaskWritesNameTheCallingSession(t *testing.T) {
	calls := []struct {
		tool       string
		args       map[string]interface{}
		wantMethod string
		wantPath   string
	}{
		{"task_delete", map[string]interface{}{}, http.MethodDelete, "/api/runner/tasks/t1"},
		{"tasklist_delete", map[string]interface{}{"listId": "list-1"}, http.MethodDelete, "/api/runner/task-lists/list-1"},
		{"task_dependency_add", map[string]interface{}{"dependsOnTaskId": "p1"}, http.MethodPost, "/api/runner/tasks/t1/dependencies"},
		{"task_dependency_remove", map[string]interface{}{"dependsOnTaskId": "p1"}, http.MethodDelete, "/api/runner/tasks/t1/dependencies/p1"},
		{"task_progress_report", map[string]interface{}{"phase": "tests"}, http.MethodPost, "/api/runner/tasks/t1/progress"},
	}
	for _, sessionID := range []string{"caller-session", ""} {
		t.Setenv("ORBIT_SESSION_ID", sessionID)
		srv, seen := recordNamedSessions(t)
		mcp := &mcpServer{taskID: "t1", t: NewTransport(srv.URL, "tok")}
		for _, call := range calls {
			if res := mcp.callTool(call.tool, call.args); res["isError"] == true {
				t.Fatalf("%s returned an error: %#v", call.tool, res["content"])
			}
		}
		for index, call := range calls {
			got := (*seen)[index]
			want := namedSessionRequest{call.wantMethod, call.wantPath, sessionID}
			if got != want {
				t.Errorf("%s with ORBIT_SESSION_ID=%q sent %+v, want %+v", call.tool, sessionID, got, want)
			}
		}
	}
}

func TestDagApplyNamesTheCallingSessionAndAPreviewDoesNot(t *testing.T) {
	srv, seen := recordNamedSessions(t)
	transport := NewTransport(srv.URL, "tok")
	body := map[string]interface{}{"ops": []interface{}{}}
	if _, err := transport.dagPreview("list-1", body); err != nil {
		t.Fatal(err)
	}
	if _, err := transport.dagApply("list-1", body, "caller-session"); err != nil {
		t.Fatal(err)
	}
	want := []namedSessionRequest{
		{http.MethodPost, "/api/runner/task-lists/list-1/dag-preview", ""},
		{http.MethodPost, "/api/runner/task-lists/list-1/dag-apply", "caller-session"},
	}
	for index, entry := range want {
		if (*seen)[index] != entry {
			t.Errorf("request %d = %+v, want %+v", index, (*seen)[index], entry)
		}
	}
}

func TestReadingProgressNamesNoSession(t *testing.T) {
	t.Setenv("ORBIT_SESSION_ID", "caller-session")
	srv, seen := recordNamedSessions(t)
	mcp := &mcpServer{taskID: "t1", t: NewTransport(srv.URL, "tok")}
	if res := mcp.callTool("task_progress_report", map[string]interface{}{}); res["isError"] == true {
		t.Fatalf("reading the progress returned an error: %#v", res["content"])
	}
	want := namedSessionRequest{http.MethodGet, "/api/runner/tasks/t1/progress", ""}
	if len(*seen) != 1 || (*seen)[0] != want {
		t.Errorf("reading the progress sent %+v, want only %+v", *seen, want)
	}
}

func TestCLITaskWritesNameTheCallingSession(t *testing.T) {
	calls := []struct {
		run        func() error
		wantMethod string
		wantPath   string
	}{
		{func() error { return cmdTaskCLI([]string{"delete", "t1"}, strings.NewReader(""), &strings.Builder{}) }, http.MethodDelete, "/api/runner/tasks/t1"},
		{func() error {
			return cmdTaskListCLI([]string{"delete", "list-1"}, strings.NewReader(""), &strings.Builder{})
		}, http.MethodDelete, "/api/runner/task-lists/list-1"},
		{func() error {
			return cmdTaskCLI([]string{"dependency-add", "t1", "--depends-on", "p1"}, strings.NewReader(""), &strings.Builder{})
		}, http.MethodPost, "/api/runner/tasks/t1/dependencies"},
		{func() error {
			return cmdTaskCLI([]string{"dependency-remove", "t1", "--depends-on", "p1"}, strings.NewReader(""), &strings.Builder{})
		}, http.MethodDelete, "/api/runner/tasks/t1/dependencies/p1"},
		{func() error {
			return cmdTaskCLI([]string{"progress", "t1", "--phase", "tests"}, strings.NewReader(""), &strings.Builder{})
		}, http.MethodPost, "/api/runner/tasks/t1/progress"},
	}
	for _, sessionID := range []string{"caller-session", ""} {
		srv, seen := recordNamedSessions(t)
		configureCLITestRunner(t, srv.URL)
		t.Setenv("ORBIT_SESSION_ID", sessionID)
		for _, call := range calls {
			if err := call.run(); err != nil {
				t.Fatalf("%s %s: %v", call.wantMethod, call.wantPath, err)
			}
		}
		for index, call := range calls {
			got := (*seen)[index]
			want := namedSessionRequest{call.wantMethod, call.wantPath, sessionID}
			if got != want {
				t.Errorf("with ORBIT_SESSION_ID=%q the CLI sent %+v, want %+v", sessionID, got, want)
			}
		}
	}
}

// The DAG batch names its session where it writes, and inside a session it asks first — the card,
// the poll and the apply are three requests, and only the apply carries the attribution header
// (dag_approval.go). A process in no session sends the apply alone, which the server then refuses on
// the machine credential (TASK_WRITE_NEEDS_OWNER_CARD).
func TestCLIDagApplyNamesTheCallingSessionAfterTheCard(t *testing.T) {
	t.Setenv("ORBIT_SESSION_ID", "caller-session")
	srv, seen := recordNamedSessionDag(t)
	configureCLITestRunner(t, srv.URL)
	if err := cmdTaskListCLI([]string{"propose-dag", "list-1", "--add", "t1:p1", "--apply"},
		strings.NewReader(""), &strings.Builder{}); err != nil {
		t.Fatal(err)
	}
	want := []namedSessionRequest{
		{http.MethodPost, "/api/runner/task-lists/list-1/dag-preview", ""},
		{http.MethodPost, "/api/runner/sessions/caller-session/approvals", ""},
		{http.MethodGet, "/api/runner/sessions/caller-session/approvals/ap1", ""},
		{http.MethodPost, "/api/runner/task-lists/list-1/dag-apply", "caller-session"},
	}
	if len(*seen) != len(want) {
		t.Fatalf("sent %+v, want %+v", *seen, want)
	}
	for index, entry := range want {
		if (*seen)[index] != entry {
			t.Errorf("request %d = %+v, want %+v", index, (*seen)[index], entry)
		}
	}

	t.Setenv("ORBIT_SESSION_ID", "")
	srv, seen = recordNamedSessionDag(t)
	configureCLITestRunner(t, srv.URL)
	if err := cmdTaskListCLI([]string{"propose-dag", "list-1", "--add", "t1:p1", "--apply"},
		strings.NewReader(""), &strings.Builder{}); err != nil {
		t.Fatal(err)
	}
	if len(*seen) != 1 || (*seen)[0] != (namedSessionRequest{http.MethodPost, "/api/runner/task-lists/list-1/dag-apply", ""}) {
		t.Fatalf("headless sent %+v, want the apply alone", *seen)
	}
}

func recordNamedSessionDag(t *testing.T) (*httptest.Server, *[]namedSessionRequest) {
	t.Helper()
	var seen []namedSessionRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, namedSessionRequest{r.Method, r.URL.Path, r.Header.Get("X-Orbit-Session-Id")})
		switch {
		case strings.Contains(r.URL.Path, "/dag-preview"):
			_, _ = w.Write([]byte(`{"effectiveCount":1,"noopCount":0}`))
		case strings.HasSuffix(r.URL.Path, "/approvals"):
			_, _ = w.Write([]byte(`{"id":"ap1","status":"PENDING"}`))
		case strings.Contains(r.URL.Path, "/approvals/"):
			_, _ = w.Write([]byte(`{"status":"ALLOWED"}`))
		default:
			_, _ = w.Write([]byte(`{"ok":true}`))
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &seen
}
