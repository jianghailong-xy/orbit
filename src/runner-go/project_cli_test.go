package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The payload is returned as the server sent it — a coordinator reads goal/acceptanceCriteria/
// instructions and the tallies off this, so anything the CLI reshaped here would be a second,
// disagreeing definition of what a project is.
const projectDetailJSON = `{"id":"proj-1","title":"Crawl","goal":"Index the corpus",` +
	`"acceptanceCriteria":"Every shard reported","instructions":"Work shard by shard",` +
	`"status":"OPEN","coordinatorSessionId":"sess-1","coordinatorWorkspaceId":"ws-1",` +
	`"_count":{"tasks":3},"tasksByStatus":{"OPEN":2,"DONE":1}}`

func TestProjectGetReadsTheRunnerProjectRoute(t *testing.T) {
	var method, path, auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		auth = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(projectDetailJSON))
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	if err := cmdProjectCLI([]string{"get", "proj-1", "--json"}, &out); err != nil {
		t.Fatalf("project get: %v", err)
	}
	if method != http.MethodGet || path != "/api/runner/projects/proj-1" {
		t.Fatalf("project get hit %s %s", method, path)
	}
	// The runner credential is what authenticates this: the user-facing /api/projects/:id is
	// behind a JWT the runner does not have, which is why the bridge route exists.
	if auth != "Bearer runner-secret" {
		t.Fatalf("project get sent authorization %q", auth)
	}
	if out.String() != projectDetailJSON+"\n" {
		t.Fatalf("project get output = %q", out.String())
	}
}

// A base62 public id is what a person copies out of a /projects/<id> URL and what every payload
// encodes ids as. It reaches the server verbatim (the server decodes it), exactly as the task
// commands pass theirs through.
func TestProjectGetPassesAPublicIDThroughUntouched(t *testing.T) {
	var path string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		_, _ = w.Write([]byte(projectDetailJSON))
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	if err := cmdProjectCLI([]string{"get", "343dlzsYWKo5z8l2M8tsB"}, &out); err != nil {
		t.Fatalf("project get: %v", err)
	}
	if path != "/api/runner/projects/343dlzsYWKo5z8l2M8tsB" {
		t.Fatalf("project get hit %s", path)
	}
	// Without --json the body is indented for a person, and still the same document.
	var got map[string]interface{}
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatalf("project get output is not JSON: %v\n%s", err, out.String())
	}
	if got["goal"] != "Index the corpus" || got["status"] != "OPEN" {
		t.Fatalf("project get output = %#v", got)
	}
	if !strings.Contains(out.String(), "\n  \"goal\"") {
		t.Fatalf("project get did not indent for a person: %q", out.String())
	}
}

// No ORBIT_PROJECT_ID fallback exists, so a missing id has to be refused here rather than turned
// into a request for whichever project the server would pick.
func TestProjectGetRequiresAProjectID(t *testing.T) {
	var hit bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
		_, _ = w.Write([]byte(projectDetailJSON))
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	err := cmdProjectCLI([]string{"get", "--json"}, &out)
	if err == nil || !strings.Contains(err.Error(), "project id is required") {
		t.Fatalf("project get without an id = %v", err)
	}
	if hit {
		t.Fatal("project get called the server with no id")
	}
}

// A 404 (someone else's project, or a deleted one) is the server's answer and must reach the
// caller as a failure carrying the status, not as an empty success.
func TestProjectGetPropagatesTheServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"statusCode":404,"message":"project not found"}`))
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	err := cmdProjectCLI([]string{"get", "proj-1", "--json"}, &out)
	if err == nil {
		t.Fatal("a 404 project read reported success")
	}
	if !strings.Contains(err.Error(), "get project") || !strings.Contains(err.Error(), "404") {
		t.Fatalf("project get error = %v", err)
	}
	if out.Len() != 0 {
		t.Fatalf("project get printed a body for a failed read: %q", out.String())
	}
}

// An id carrying a path separator must never be able to address another route.
func TestProjectGetIDCannotEscapeTheProjectRoute(t *testing.T) {
	var hit bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	if err := cmdProjectCLI([]string{"get", "../runner/tasks"}, &out); err == nil {
		t.Fatal("an unsafe project id was accepted")
	}
	if hit {
		t.Fatal("an unsafe project id reached the server")
	}
}

func TestProjectCLIHelpAndUnknownCommand(t *testing.T) {
	var out bytes.Buffer
	if err := cmdProjectCLI([]string{"get", "--help"}, &out); err != nil {
		t.Fatalf("project get --help: %v", err)
	}
	// What the command is for, in the words the payload uses.
	for _, want := range []string{"acceptanceCriteria", "instructions", "tasksByStatus"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("project get --help does not mention %q: %q", want, out.String())
		}
	}

	out.Reset()
	if err := cmdProjectCLI([]string{"nope"}, &out); err == nil {
		t.Fatal("unknown project command was accepted")
	}

	// Read-only family: no verb that writes, now or by accident later.
	for _, forbidden := range []string{"create", "update", "delete", "list"} {
		if _, exists := projectActionHelp[forbidden]; exists {
			t.Fatalf("project family grew a %q action", forbidden)
		}
	}
}

// The capability document is how an agent discovers the command, so its argv, usage and schema
// have to be the ones that actually work — and it must say this command writes nothing.
func TestProjectGetCapabilityIsAccurateAndReadOnly(t *testing.T) {
	if len(projectCLICapabilities) != 1 {
		t.Fatalf("project capabilities = %#v", projectCLICapabilities)
	}
	spec := projectCLICapabilities[0]
	if spec.Tool != "project_get" {
		t.Fatalf("project capability tool = %q", spec.Tool)
	}
	if got := strings.Join(spec.Argv, " "); got != "orbit project get" {
		t.Fatalf("project capability argv = %q", got)
	}
	if spec.Usage != "orbit project get PROJECT_ID [--json]" {
		t.Fatalf("project capability usage = %q", spec.Usage)
	}
	if spec.Mutates {
		t.Fatal("project_get is advertised as mutating")
	}

	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv(envMCPOrchestration, "")
	t.Setenv("ORBIT_SESSION_ID", "session-1")
	var out bytes.Buffer
	if err := cmdCapabilitiesCLI([]string{"--json"}, &out); err != nil {
		t.Fatal(err)
	}
	var doc cliCapabilitiesDocument
	if err := json.Unmarshal(out.Bytes(), &doc); err != nil {
		t.Fatalf("capabilities output is not JSON: %v\n%s", err, out.String())
	}
	var found *cliCapability
	for i := range doc.Capabilities {
		if doc.Capabilities[i].ID == "project_get" {
			found = &doc.Capabilities[i]
		}
	}
	if found == nil {
		t.Fatalf("project_get missing from capabilities: %#v", doc.Capabilities)
	}
	if found.Mutates {
		t.Fatal("capabilities advertises project_get as mutating")
	}
	if found.Description == "" || found.MCPInputSchema == nil {
		t.Fatalf("project_get did not reuse the MCP description/schema: %#v", found)
	}
	// The schema an agent reads must be the tool's own, required projectId included.
	props, _ := found.MCPInputSchema["properties"].(map[string]interface{})
	if _, ok := props["projectId"]; !ok {
		t.Fatalf("project_get schema has no projectId: %#v", found.MCPInputSchema)
	}
	required, _ := found.MCPInputSchema["required"].([]interface{})
	if len(required) != 1 || required[0] != "projectId" {
		t.Fatalf("project_get required = %#v", found.MCPInputSchema["required"])
	}
	if strings.Join(found.Argv[1:], " ") != "project get" {
		t.Fatalf("project_get argv = %#v", found.Argv)
	}
	if last := found.HelpArgv[len(found.HelpArgv)-1]; last != "--help" {
		t.Fatalf("project_get help argv = %#v", found.HelpArgv)
	}
}

// The command capabilities advertises must also be pre-approved, or the agent hits a permission
// prompt for something the document just told it to run.
func TestProjectGetIsPreApprovedForAgents(t *testing.T) {
	rules := strings.Join(orbitCLIAllowedTools("/usr/local/bin/orbit", false), "\n")
	if !strings.Contains(rules, "Bash(/usr/local/bin/orbit project get *)") {
		t.Fatalf("project get is not pre-approved: %q", rules)
	}
	// Read-only stays read-only: no wildcard over the whole family.
	if strings.Contains(rules, " project *)") {
		t.Fatalf("the project family is pre-approved wholesale: %q", rules)
	}
}
