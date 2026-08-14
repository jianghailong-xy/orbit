package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func configureCLITestRunner(t *testing.T, serverURL string) {
	t.Helper()
	t.Setenv("ORBIT_HOME", t.TempDir())
	if err := saveConfig(&RunnerConfig{
		ServerURL:   serverURL,
		RunnerID:    "runner-1",
		RunnerToken: "runner-secret",
	}); err != nil {
		t.Fatal(err)
	}
}

func TestCapabilitiesJSONUsesMCPDescriptorsAndExposesOnlyPhase1(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv(envMCPOrchestration, "")
	t.Setenv("ORBIT_SESSION_ID", "session-1")
	t.Setenv("ORBIT_AGENT_ID", "agent-1")
	t.Setenv("ORBIT_TASK_ID", "task-1")
	var out bytes.Buffer
	if err := cmdCapabilitiesCLI([]string{"--json"}, &out); err != nil {
		t.Fatal(err)
	}
	var doc cliCapabilitiesDocument
	if err := json.Unmarshal(out.Bytes(), &doc); err != nil {
		t.Fatalf("capabilities output is not JSON: %v\n%s", err, out.String())
	}
	if doc.SchemaVersion != 1 || len(doc.Capabilities) != 13 {
		t.Fatalf("capabilities = %#v", doc)
	}
	// The dependency trio reached CLI parity with the MCP tools; without them a script
	// could only replace a task's whole prerequisite set, never edit one edge.
	for _, want := range []string{"task_dependency_graph", "task_dependency_add", "task_dependency_remove"} {
		found := false
		for _, capability := range doc.Capabilities {
			if capability.ID == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("capability %q not exposed to the CLI", want)
		}
	}
	if doc.Registered {
		t.Fatal("unregistered temp home reported registered")
	}
	if doc.Context.Actor != "runner_owner" || doc.Context.SessionID != "session-1" || doc.Context.TaskID != "task-1" {
		t.Fatalf("context = %#v", doc.Context)
	}
	for _, capability := range doc.Capabilities {
		if capability.Description == "" || capability.MCPInputSchema == nil {
			t.Fatalf("capability did not reuse MCP description/schema: %#v", capability)
		}
		// In-session these writes are attributed to the agent (matching the MCP path); headless they
		// fall back to the runner owner. The description must state BOTH so neither is misleading.
		writesAttributed := capability.ID == "task_create" || capability.ID == "task_create_batch" ||
			capability.ID == "task_comment"
		if writesAttributed &&
			(!strings.Contains(capability.Description, "agent") || !strings.Contains(capability.Description, "runner owner")) {
			t.Fatalf("CLI attribution is misleading: %#v", capability)
		}
		if len(capability.Arguments) == 0 {
			t.Fatalf("capability has no exact CLI argument description: %#v", capability)
		}
		if len(capability.HelpArgv) != len(capability.Argv)+1 || capability.HelpArgv[len(capability.HelpArgv)-1] != "--help" {
			t.Fatalf("capability help argv = %#v", capability.HelpArgv)
		}
		for _, forbidden := range []string{"session_", "agent_", "permission_prompt"} {
			if strings.HasPrefix(capability.ID, forbidden) || capability.ID == forbidden {
				t.Fatalf("unsafe capability exposed: %q", capability.ID)
			}
		}
	}
}

func TestCLITaskAttributionInSessionOnly(t *testing.T) {
	// In a session the runner injects both ids: the CLI claims agent authorship, like the MCP path.
	t.Setenv("ORBIT_SESSION_ID", "session-1")
	t.Setenv("ORBIT_AGENT_ID", "agent-1")
	if agentID, sessionID := cliTaskAttribution(); agentID != "agent-1" || sessionID != "session-1" {
		t.Fatalf("in-session attribution = (%q, %q), want (agent-1, session-1)", agentID, sessionID)
	}
	// Headless (no session): a shared runner credential must not let a script pose as an agent.
	t.Setenv("ORBIT_SESSION_ID", "")
	if agentID, sessionID := cliTaskAttribution(); agentID != "" || sessionID != "" {
		t.Fatalf("headless attribution = (%q, %q), want empty", agentID, sessionID)
	}
}

func TestTaskCLIGroupHelp(t *testing.T) {
	for _, args := range [][]string{{"--help"}, {"-h"}} {
		var out bytes.Buffer
		if err := cmdTaskCLI(args, strings.NewReader(""), &out); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(out.String(), "orbit task — manage Orbit tasks") {
			t.Fatalf("help output = %q", out.String())
		}
	}
}

func TestTaskCLIHelpDocumentsDelete(t *testing.T) {
	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"--help"}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "orbit task delete [task-id] [--json]") {
		t.Fatalf("task help does not document delete: %q", out.String())
	}

	out.Reset()
	if err := cmdTaskCLI([]string{"delete", "--help"}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "orbit task delete") {
		t.Fatalf("delete help output = %q", out.String())
	}
}

func TestTaskCLICreateAttributesToAgentInSession(t *testing.T) {
	var gotHeader, gotSession string
	var gotBody map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/runner/tasks" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		gotHeader = r.Header.Get("X-Orbit-Agent-Id")
		gotSession = r.Header.Get("X-Orbit-Session-Id")
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Errorf("decode body: %v", err)
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"id":"created-task"}`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_AGENT_ID", "agent-1")
	t.Setenv("ORBIT_SESSION_ID", "session-1")

	var out bytes.Buffer
	err := cmdTaskCLI([]string{
		"create", "--title", "Ship CLI", "--description", "Implement it",
		"--depends-on", "dep-1,dep-2", "--depends-on", "dep-2,dep-3",
		"--auto-run-when-ready=false", "--json",
	}, strings.NewReader(""), &out)
	if err != nil {
		t.Fatal(err)
	}
	// In-session: the task is attributed to the agent and linked to the session, like the MCP path.
	if gotHeader != "agent-1" || gotSession != "session-1" {
		t.Fatalf("in-session attribution headers = agent %q session %q", gotHeader, gotSession)
	}
	// ORBIT_AGENT_ID is still the default assignee, independent of authorship.
	if gotBody["assigneeId"] != "agent-1" {
		t.Fatalf("assigneeId = %#v", gotBody["assigneeId"])
	}
	deps, ok := gotBody["dependsOnTaskIds"].([]interface{})
	if !ok || len(deps) != 3 {
		t.Fatalf("dependsOnTaskIds = %#v", gotBody["dependsOnTaskIds"])
	}
	if gotBody["autoRunWhenReady"] != false {
		t.Fatalf("autoRunWhenReady = %#v", gotBody["autoRunWhenReady"])
	}
	if strings.TrimSpace(out.String()) != `{"id":"created-task"}` {
		t.Fatalf("--json output = %q", out.String())
	}
}

func TestTaskCLICreateBatchPostsStdinTasksInOneRequest(t *testing.T) {
	var requests int
	var gotHeader, gotSession string
	var gotBody map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Method != http.MethodPost || r.URL.Path != "/api/runner/tasks/batch-create" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		gotHeader = r.Header.Get("X-Orbit-Agent-Id")
		gotSession = r.Header.Get("X-Orbit-Session-Id")
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Errorf("decode body: %v", err)
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`[{"id":"t1","ref":"build"},{"id":"t2"}]`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_AGENT_ID", "agent-1")
	t.Setenv("ORBIT_SESSION_ID", "session-1")

	stdin := strings.NewReader(`[{"title":"Build","ref":"build"},
	  {"title":"Deploy","dependsOnRefs":["build"],"assigneeId":null}]`)
	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"create-batch", "--tasks-file", "-", "--json"}, stdin, &out); err != nil {
		t.Fatal(err)
	}
	if requests != 1 {
		t.Fatalf("requests = %d, want a single batch call", requests)
	}
	if gotHeader != "agent-1" || gotSession != "session-1" {
		t.Fatalf("in-session attribution = agent %q session %q", gotHeader, gotSession)
	}
	tasks, _ := gotBody["tasks"].([]interface{})
	if len(tasks) != 2 {
		t.Fatalf("body = %#v", gotBody)
	}
	first, _ := tasks[0].(map[string]interface{})
	second, _ := tasks[1].(map[string]interface{})
	if first["assigneeId"] != "agent-1" || first["ref"] != "build" {
		t.Fatalf("tasks[0] = %#v", first)
	}
	if assignee, present := second["assigneeId"]; !present || assignee != nil {
		t.Fatalf("tasks[1] assigneeId = %#v, want an explicit null", second["assigneeId"])
	}
	if strings.TrimSpace(out.String()) != `[{"id":"t1","ref":"build"},{"id":"t2"}]` {
		t.Fatalf("--json output = %q", out.String())
	}
}

func TestTaskCLICreateBatchRejectsBadPayloadsBeforeCallingTheServer(t *testing.T) {
	configureCLITestRunner(t, "http://127.0.0.1:1")
	oversized := make([]string, maxTaskBatchCreate+1)
	for i := range oversized {
		oversized[i] = `{"title":"t"}`
	}
	cases := map[string]string{
		"not json":  `nope`,
		"empty":     `[]`,
		"untitled":  `[{"description":"no title"}]`,
		"oversized": "[" + strings.Join(oversized, ",") + "]",
	}
	for name, payload := range cases {
		var out bytes.Buffer
		if err := cmdTaskCLI([]string{"create-batch", "--tasks", payload}, strings.NewReader(""), &out); err == nil {
			t.Fatalf("%s payload was accepted", name)
		}
	}
	// The request shape {"tasks": [...]} is accepted too, so a caller can paste the API body.
	if _, err := parseTaskBatchItems(`{"tasks":[{"title":"a"}]}`); err != nil {
		t.Fatalf("wrapped payload rejected: %v", err)
	}
}

func TestTaskCLIUpdateAcceptsLeadingIDThenFlags(t *testing.T) {
	var gotPath string
	var gotBody map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"update", "task-1", "--status", "DONE", "--clear-list", "--json"}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	if gotPath != "/api/runner/tasks/task-1" {
		t.Fatalf("path = %q", gotPath)
	}
	if gotBody["status"] != "DONE" {
		t.Fatalf("status = %#v", gotBody["status"])
	}
	if v, ok := gotBody["listId"]; !ok || v != nil {
		t.Fatalf("listId = %#v, present %v", v, ok)
	}
}

func TestTaskCLIDeleteSendsDeleteAndEmitsServerJSON(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte("{\n  \"ok\": true\n}"))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"delete", "task-1", "--json"}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	if gotMethod != http.MethodDelete || gotPath != "/api/runner/tasks/task-1" {
		t.Fatalf("request = %s %s", gotMethod, gotPath)
	}
	if out.String() != "{\"ok\":true}\n" {
		t.Fatalf("--json output = %q", out.String())
	}
}

func TestTaskCLIDeleteUsesCurrentTaskFallback(t *testing.T) {
	var gotMethod, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotPath = r.Method, r.URL.Path
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_TASK_ID", "task-from-env")

	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"delete", "--json"}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	if gotMethod != http.MethodDelete || gotPath != "/api/runner/tasks/task-from-env" {
		t.Fatalf("request = %s %s", gotMethod, gotPath)
	}
}

func TestTaskCLIUpdateReplacesOrClearsDependencies(t *testing.T) {
	var bodies []map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		bodies = append(bodies, body)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	if err := cmdTaskCLI([]string{
		"update", "task-1", "--depends-on", "dep-1,dep-2", "--depends-on", "dep-2,dep-3", "--json",
	}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if err := cmdTaskCLI([]string{"update", "task-1", "--clear-dependencies", "--json"}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}

	if len(bodies) != 2 {
		t.Fatalf("bodies = %#v", bodies)
	}
	deps, ok := bodies[0]["dependsOnTaskIds"].([]interface{})
	if !ok || len(deps) != 3 || deps[0] != "dep-1" || deps[1] != "dep-2" || deps[2] != "dep-3" {
		t.Fatalf("replacement dependencies = %#v", bodies[0]["dependsOnTaskIds"])
	}
	cleared, ok := bodies[1]["dependsOnTaskIds"].([]interface{})
	if !ok || len(cleared) != 0 {
		t.Fatalf("cleared dependencies = %#v", bodies[1]["dependsOnTaskIds"])
	}
}

func TestTaskCLIUpdateDependencyFlagsAreExplicitAndExclusive(t *testing.T) {
	for _, tc := range []struct {
		args []string
		want string
	}{
		{args: []string{"update", "task-1", "--depends-on", ""}, want: "--depends-on cannot be empty"},
		{args: []string{"update", "task-1", "--depends-on", "dep-1", "--clear-dependencies"}, want: "cannot be used together"},
	} {
		var out bytes.Buffer
		err := cmdTaskCLI(tc.args, strings.NewReader(""), &out)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("cmdTaskCLI(%v) error = %v, want %q", tc.args, err, tc.want)
		}
	}
}

func TestTaskCLIUpdateCapabilityAdvertisesDependencyReplacement(t *testing.T) {
	doc := buildCLICapabilities(orbitCLIExecutable())
	for _, capability := range doc.Capabilities {
		if capability.ID != "task_update" {
			continue
		}
		args := strings.Join(capability.Arguments, " ")
		if !strings.Contains(args, "--depends-on") || !strings.Contains(args, "--clear-dependencies") {
			t.Fatalf("task_update arguments = %#v", capability.Arguments)
		}
		return
	}
	t.Fatal("task_update capability missing")
}

func TestTaskCLIDeleteCapabilityIsExactAndMutating(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv(envMCPOrchestration, "")
	doc := buildCLICapabilities("/opt/orbit")
	var got *cliCapability
	for i := range doc.Capabilities {
		if doc.Capabilities[i].ID == "task_delete" {
			got = &doc.Capabilities[i]
			break
		}
	}
	if got == nil {
		t.Fatal("task_delete capability missing")
	}

	wantArgv := []string{"/opt/orbit", "task", "delete"}
	if !reflect.DeepEqual(got.Argv, wantArgv) {
		t.Errorf("task_delete argv = %#v, want %#v", got.Argv, wantArgv)
	}
	wantHelpArgv := []string{"/opt/orbit", "task", "delete", "--help"}
	if !reflect.DeepEqual(got.HelpArgv, wantHelpArgv) {
		t.Errorf("task_delete help argv = %#v, want %#v", got.HelpArgv, wantHelpArgv)
	}
	if got.Usage != "orbit task delete [task-id] [--json]" {
		t.Errorf("task_delete usage = %q", got.Usage)
	}
	wantArguments := []string{"[task-id] (defaults to ORBIT_TASK_ID)", "--json"}
	if !reflect.DeepEqual(got.Arguments, wantArguments) {
		t.Errorf("task_delete arguments = %#v, want %#v", got.Arguments, wantArguments)
	}
	wantSchema := map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"taskId": map[string]interface{}{
				"type":        "string",
				"description": "Task id; defaults to the current task (ORBIT_TASK_ID) if omitted",
			},
		},
	}
	if !reflect.DeepEqual(got.MCPInputSchema, wantSchema) {
		t.Errorf("task_delete schema = %#v, want %#v", got.MCPInputSchema, wantSchema)
	}
	if !got.Mutates {
		t.Error("task_delete capability is not marked mutating")
	}
}

func TestTaskCLIUsesCurrentTaskFallback(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_, _ = w.Write([]byte(`{"id":"task-from-env"}`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_TASK_ID", "task-from-env")

	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"get", "--json"}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	if gotPath != "/api/runner/tasks/task-from-env" {
		t.Fatalf("path = %q", gotPath)
	}
}

func TestTaskCLIRejectsArbitraryDescriptionAndBodyFiles(t *testing.T) {
	for _, args := range [][]string{
		{"create", "--title", "x", "--description-file", "/etc/passwd"},
		{"comment", "task-1", "--body-file", "/etc/passwd"},
	} {
		var out bytes.Buffer
		err := cmdTaskCLI(args, strings.NewReader(""), &out)
		if err == nil || !strings.Contains(err.Error(), "accepts only '-' (stdin)") {
			t.Fatalf("cmdTaskCLI(%v) error = %v", args, err)
		}
	}
}

func TestTaskCLICommentReadsStdinAndAuthorsAsAgentInSession(t *testing.T) {
	var gotAgent string
	var gotBody map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAgent = r.Header.Get("X-Orbit-Agent-Id")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_, _ = w.Write([]byte(`{"id":"comment-1"}`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_AGENT_ID", "agent-1")
	t.Setenv("ORBIT_SESSION_ID", "session-1")

	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"comment", "task-1", "--body-file", "-", "--json"}, strings.NewReader("done\n"), &out); err != nil {
		t.Fatal(err)
	}
	// In-session, the comment is authored by the acting agent (same as the MCP path).
	if gotAgent != "agent-1" || gotBody["body"] != "done\n" {
		t.Fatalf("agent = %q body = %#v", gotAgent, gotBody["body"])
	}
}

func TestTaskCLIRefusesInsecureCredentialStorageWithoutMutatingIt(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows does not expose Unix credential permission bits")
	}
	home := t.TempDir()
	t.Setenv("ORBIT_HOME", home)
	if err := saveConfig(&RunnerConfig{ServerURL: "https://example.invalid", RunnerToken: "secret"}); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(home, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(configPath(), 0o644); err != nil {
		t.Fatal(err)
	}

	var out bytes.Buffer
	err := cmdTaskCLI([]string{"list", "--json"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "credential storage is not private") {
		t.Fatalf("insecure storage error = %v", err)
	}
	assertPrivateMode(t, home, 0o755)
	assertPrivateMode(t, configPath(), 0o644)

	doc := buildCLICapabilities(orbitCLIExecutable())
	if doc.Registered || doc.UnavailableReason == "" {
		t.Fatalf("capabilities availability = %#v", doc)
	}
}

func TestTaskCLIListFiltersResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`[{"id":"open","status":"OPEN","listId":"l1"},{"id":"done","status":"DONE","listId":"l1"}]`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"list", "--status", "OPEN", "--list-id", "l1", "--json"}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	var tasks []map[string]interface{}
	if err := json.Unmarshal(out.Bytes(), &tasks); err != nil || len(tasks) != 1 || tasks[0]["id"] != "open" {
		t.Fatalf("filtered tasks = %#v, err %v", tasks, err)
	}
}

func TestTaskListCLICreate(t *testing.T) {
	var gotPath string
	var gotBody map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_, _ = w.Write([]byte(`{"id":"list-1"}`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	if err := cmdTaskListCLI([]string{"create", "--title", "Release", "--json"}, &out); err != nil {
		t.Fatal(err)
	}
	if gotPath != "/api/runner/task-lists" || gotBody["title"] != "Release" {
		t.Fatalf("path = %q body = %#v", gotPath, gotBody)
	}
}

func TestTaskCLIRejectsUnknownFlags(t *testing.T) {
	var out bytes.Buffer
	err := cmdTaskCLI([]string{"list", "--not-a-real-flag"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "flag provided but not defined") {
		t.Fatalf("unknown flag error = %v", err)
	}
}

func TestTaskCLIRejectsPathLikeTaskIDs(t *testing.T) {
	for _, id := range []string{"../sessions", `..\\sessions`, "..%2Fsessions", "a/b", ".", ".."} {
		var out bytes.Buffer
		err := cmdTaskCLI([]string{"get", id, "--json"}, strings.NewReader(""), &out)
		if err == nil || !strings.Contains(err.Error(), "single safe path segment") {
			t.Fatalf("task id %q error = %v", id, err)
		}
	}
}
