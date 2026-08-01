package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
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
	if doc.SchemaVersion != 1 || len(doc.Capabilities) != 8 {
		t.Fatalf("capabilities = %#v", doc)
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
		if (capability.ID == "task_create" || capability.ID == "task_comment") && !strings.Contains(capability.Description, "runner owner") {
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

func TestTaskCLICreateDefaultsAssigneeWithoutTrustingAttributionEnv(t *testing.T) {
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
	if gotHeader != "" || gotSession != "" {
		t.Fatalf("untrusted attribution headers = agent %q session %q", gotHeader, gotSession)
	}
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

func TestTaskCLICommentReadsStdinWithoutTrustingAttributionEnv(t *testing.T) {
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

	var out bytes.Buffer
	if err := cmdTaskCLI([]string{"comment", "task-1", "--body-file", "-", "--json"}, strings.NewReader("done\n"), &out); err != nil {
		t.Fatal(err)
	}
	if gotAgent != "" || gotBody["body"] != "done\n" {
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
