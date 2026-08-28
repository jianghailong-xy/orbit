package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
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
	if err := cmdProjectCLI([]string{"get", "proj-1", "--json"}, strings.NewReader(""), &out); err != nil {
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
	if err := cmdProjectCLI([]string{"get", "343dlzsYWKo5z8l2M8tsB"}, strings.NewReader(""), &out); err != nil {
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
	err := cmdProjectCLI([]string{"get", "--json"}, strings.NewReader(""), &out)
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
	err := cmdProjectCLI([]string{"get", "proj-1", "--json"}, strings.NewReader(""), &out)
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
	if err := cmdProjectCLI([]string{"get", "../runner/tasks"}, strings.NewReader(""), &out); err == nil {
		t.Fatal("an unsafe project id was accepted")
	}
	if hit {
		t.Fatal("an unsafe project id reached the server")
	}
}

func TestProjectCLIHelpAndUnknownCommand(t *testing.T) {
	var out bytes.Buffer
	if err := cmdProjectCLI([]string{"get", "--help"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("project get --help: %v", err)
	}
	// What the command is for, in the words the payload uses.
	for _, want := range []string{"acceptanceCriteria", "instructions", "tasksByStatus"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("project get --help does not mention %q: %q", want, out.String())
		}
	}

	out.Reset()
	if err := cmdProjectCLI([]string{"nope"}, strings.NewReader(""), &out); err == nil {
		t.Fatal("unknown project command was accepted")
	}

	// The verbs that exist, each reachable as `orbit project <verb> --help` — leaf help that the
	// family does not route to is text nobody can read.
	for _, action := range []string{
		"get", "create", "update", "delete",
		"acceptance", "criteria-confirm", "acceptance-run", "acceptance-verdict", "merge-evidence",
	} {
		out.Reset()
		if err := cmdProjectCLI([]string{action, "--help"}, strings.NewReader(""), &out); err != nil {
			t.Fatalf("project %s --help: %v", action, err)
		}
		if !strings.Contains(out.String(), "orbit project "+action) {
			t.Fatalf("project %s --help = %q", action, out.String())
		}
	}
	// Listing, opening a coordinator and triggering a coordination run stay the human's door —
	// `status` reads that loop, it does not drive it.
	for _, forbidden := range []string{"list", "coordinator", "trigger"} {
		if _, exists := projectActionHelp[forbidden]; exists {
			t.Fatalf("project family grew a %q action", forbidden)
		}
	}
	if !ownsLeafHelp("project") {
		t.Fatal("the project family no longer owns its leaf help")
	}
}

// The capability document is how an agent discovers the command, so its argv, usage and schema
// have to be the ones that actually work — and it must say this command writes nothing.
func TestProjectCLICapabilitiesAreAccurate(t *testing.T) {
	specs := map[string]cliCapabilitySpec{}
	for _, spec := range projectCLICapabilities {
		specs[spec.Tool] = spec
	}
	// One per read/write the project family exposes. Unit L7's two reads are here — what has been
	// asked about work crossing this project's line, and what reopening it would cost. Neither has
	// a companion that WRITES, and that absence is the point.
	if len(specs) != 11 {
		t.Fatalf("project capabilities = %#v", projectCLICapabilities)
	}
	spec, ok := specs["project_get"]
	if !ok {
		t.Fatalf("project capabilities lost project_get: %#v", projectCLICapabilities)
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
	// `project_acceptance` is a read like the two above, and the one an agent reaches for first
	// when it is deciding whether a project can be closed at all.
	acceptance, ok := specs["project_acceptance"]
	if !ok {
		t.Fatalf("project capabilities lost project_acceptance: %#v", projectCLICapabilities)
	}
	if got := strings.Join(acceptance.Argv, " "); got != "orbit project acceptance" {
		t.Fatalf("project_acceptance argv = %q", got)
	}
	if acceptance.Mutates {
		t.Fatal("project_acceptance is advertised as mutating")
	}
	// The write verbs must say so: an agent reads `mutates` to decide whether a command is
	// safe to run while exploring, and a write advertised as a read is the wrong answer.
	for _, tool := range []string{
		"project_create", "project_update", "project_delete",
		"project_criteria_confirm", "project_acceptance_run", "project_acceptance_verdict",
		"project_merge_evidence",
	} {
		write, ok := specs[tool]
		if !ok {
			t.Fatalf("%s has no CLI capability: %#v", tool, projectCLICapabilities)
		}
		if !write.Mutates {
			t.Fatalf("%s is not advertised as mutating", tool)
		}
		// The MCP name is snake_case and the CLI verb is kebab-case — `project_acceptance_run` is
		// `orbit project acceptance-run`. One mechanical mapping, so a new verb cannot quietly
		// advertise an argv nobody can type.
		verb := strings.ReplaceAll(strings.TrimPrefix(tool, "project_"), "_", "-")
		if got := strings.Join(write.Argv, " "); got != "orbit project "+verb {
			t.Fatalf("%s argv = %q", tool, got)
		}
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
	var deleteFound *cliCapability
	for i := range doc.Capabilities {
		if doc.Capabilities[i].ID == "project_get" {
			found = &doc.Capabilities[i]
		}
		if doc.Capabilities[i].ID == "project_delete" {
			deleteFound = &doc.Capabilities[i]
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
	if deleteFound == nil {
		t.Fatalf("project_delete missing from capabilities: %#v", doc.Capabilities)
	}
	if !deleteFound.Mutates {
		t.Fatal("capabilities advertises project_delete as read-only")
	}
	if strings.Join(deleteFound.Argv[1:], " ") != "project delete" {
		t.Fatalf("project_delete argv = %#v", deleteFound.Argv)
	}
	deleteProps, _ := deleteFound.MCPInputSchema["properties"].(map[string]interface{})
	if _, ok := deleteProps["projectId"]; !ok {
		t.Fatalf("project_delete schema has no projectId: %#v", deleteFound.MCPInputSchema)
	}
}

func TestProjectCriteriaConfirmPostsDigestActionWithSessionContext(t *testing.T) {
	var method, path, session string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		session = r.Header.Get("X-Orbit-Session-Id")
		_, _ = w.Write([]byte(`{"current":true}`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "judgment-session-1")

	var out bytes.Buffer
	if err := cmdProjectCLI([]string{
		"criteria-confirm", "proj-1", "--json",
	}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("project criteria-confirm: %v", err)
	}
	if method != http.MethodPost || path != "/api/runner/projects/proj-1/acceptance/criteria-confirmation" {
		t.Fatalf("project criteria-confirm hit %s %s", method, path)
	}
	if session != "judgment-session-1" {
		t.Fatalf("project criteria-confirm session = %q", session)
	}
}

// The command capabilities advertises must also be pre-approved, or the agent hits a permission
// prompt for something the document just told it to run.
func TestProjectCommandsArePreApprovedForAgents(t *testing.T) {
	rules := strings.Join(orbitCLIAllowedTools("/usr/local/bin/orbit", false), "\n")
	// Every verb capabilities advertises, individually. A write the document names but that is not
	// pre-approved stalls on a permission prompt the agent cannot answer headless.
	for _, action := range []string{"get", "criteria-confirm", "create", "update", "delete"} {
		if !strings.Contains(rules, "Bash(/usr/local/bin/orbit project "+action+" *)") {
			t.Fatalf("project %s is not pre-approved: %q", action, rules)
		}
	}
	// Enumerated, never wholesale: a verb added later must be a decision, not an inheritance.
	if strings.Contains(rules, " project *)") {
		t.Fatalf("the project family is pre-approved wholesale: %q", rules)
	}
}

// ── delete ────────────────────────────────────────────────────────────────────────────────────

func TestProjectDeleteUsesTheGuardedRunnerRoute(t *testing.T) {
	var method, path, auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		auth = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	if err := cmdProjectCLI([]string{"delete", "343dlzsYWKo5z8l2M8tsB", "--json"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("project delete: %v", err)
	}
	if method != http.MethodDelete || path != "/api/runner/projects/343dlzsYWKo5z8l2M8tsB" {
		t.Fatalf("project delete hit %s %s", method, path)
	}
	if auth != "Bearer runner-secret" {
		t.Fatalf("project delete sent authorization %q", auth)
	}
	if out.String() != "{\"ok\":true}\n" {
		t.Fatalf("project delete output = %q", out.String())
	}
}

func TestProjectDeleteRequiresASafeProjectID(t *testing.T) {
	var hit bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)

	for _, argv := range [][]string{{"delete", "--json"}, {"delete", "../tasks", "--json"}} {
		var out bytes.Buffer
		err := cmdProjectCLI(argv, strings.NewReader(""), &out)
		if err == nil {
			t.Fatalf("project delete accepted %#v", argv)
		}
	}
	if hit {
		t.Fatal("an invalid project delete reached the server")
	}
}

func TestProjectDeletePropagatesANonEmptyRefusal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"statusCode":409,"message":"This project still holds 2 task(s) and cannot be deleted"}`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	err := cmdProjectCLI([]string{"delete", "proj-1", "--json"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "delete project") || !strings.Contains(err.Error(), "409") {
		t.Fatalf("non-empty project delete = %v", err)
	}
	if out.Len() != 0 {
		t.Fatalf("failed project delete printed output: %q", out.String())
	}
}

// ── create ────────────────────────────────────────────────────────────────────────────────────

const projectCreatedJSON = `{"id":"proj-2","title":"Crawl","goal":"Index the corpus",` +
	`"acceptanceCriteria":null,"instructions":null,"status":"OPEN"}`

// The exact verb, path and body: a create that landed on the task route, or that renamed a field
// on the way, would still look like a success to whoever typed it.
func TestProjectCreatePostsTheRunnerProjectRoute(t *testing.T) {
	var method, path, auth string
	var body map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		auth = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = w.Write([]byte(projectCreatedJSON))
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	err := cmdProjectCLI([]string{
		"create", "--title", "Crawl", "--goal", "Index the corpus",
		"--instructions", "Work shard by shard",
		"--json",
	}, strings.NewReader(""), &out)
	if err != nil {
		t.Fatalf("project create: %v", err)
	}
	if method != http.MethodPost || path != "/api/runner/projects" {
		t.Fatalf("project create hit %s %s", method, path)
	}
	if auth != "Bearer runner-secret" {
		t.Fatalf("project create sent authorization %q", auth)
	}
	// The server's own field names, carried through unrenamed — the CLI holds no second opinion
	// about what a project has.
	want := map[string]interface{}{
		"title":        "Crawl",
		"goal":         "Index the corpus",
		"instructions": "Work shard by shard",
	}
	if fmt.Sprintf("%v", body) != fmt.Sprintf("%v", want) {
		t.Fatalf("project create body = %#v", body)
	}
	if out.String() != projectCreatedJSON+"\n" {
		t.Fatalf("project create output = %q", out.String())
	}
}

func TestProjectCreateRejectsLegacyAcceptanceBeforeHTTP(t *testing.T) {
	var hit bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hit = true }))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)

	for _, args := range [][]string{
		{"create", "--title", "LFS", "--acceptance-criteria", "Build succeeds"},
		{"create", "--title", "LFS", "--acceptance-criteria-file", "-"},
	} {
		var out bytes.Buffer
		err := cmdProjectCLI(args, strings.NewReader("Build succeeds"), &out)
		if err == nil || !strings.Contains(err.Error(), "HUMAN_SIGNOFF") ||
			!strings.Contains(err.Error(), "completionCriterion") {
			t.Fatalf("legacy project create = %v", err)
		}
	}
	if hit {
		t.Fatal("legacy project create reached HTTP")
	}
}

// Fields nobody named must not be invented as empty strings: the server stores blank prose as
// null, so a phantom "" is indistinguishable from a stated-and-empty goal in the payload that
// comes back.
func TestProjectCreateSendsOnlyTheFieldsGiven(t *testing.T) {
	var body map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = w.Write([]byte(projectCreatedJSON))
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	if err := cmdProjectCLI([]string{"create", "--title", "Crawl", "--json"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("project create: %v", err)
	}
	if len(body) != 1 || body["title"] != "Crawl" {
		t.Fatalf("project create body = %#v", body)
	}
}

func TestProjectCreateSendsStructuredAcceptanceItems(t *testing.T) {
	var body map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = w.Write([]byte(projectCreatedJSON))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	err := cmdProjectCLI([]string{
		"create", "--title", "LFS", "--acceptance-criteria-items",
		`[{"text":" Build succeeds ","verificationMethod":" Run npm test ","completionCriterion":"HUMAN_SIGNOFF"},{"text":"Image boots","verificationMethod":"Smoke the image","completionCriterion":"HUMAN_SIGNOFF"}]`, "--json",
	}, strings.NewReader(""), &out)
	if err != nil {
		t.Fatalf("structured project create: %v", err)
	}
	items, _ := body["acceptanceCriteriaItems"].([]interface{})
	if len(items) != 2 || items[0].(map[string]interface{})["text"] != "Build succeeds" ||
		items[0].(map[string]interface{})["verificationMethod"] != "Run npm test" ||
		items[0].(map[string]interface{})["completionCriterion"] != "HUMAN_SIGNOFF" ||
		items[1].(map[string]interface{})["text"] != "Image boots" ||
		items[1].(map[string]interface{})["verificationMethod"] != "Smoke the image" ||
		items[1].(map[string]interface{})["completionCriterion"] != "HUMAN_SIGNOFF" {
		t.Fatalf("structured project create body = %#v", body)
	}
	if _, legacy := body["acceptanceCriteria"]; legacy {
		t.Fatalf("structured project create invented legacy criteria: %#v", body)
	}
}

func TestProjectCreateRejectsAmbiguousAcceptanceAuthoring(t *testing.T) {
	var hit bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hit = true }))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)

	for _, args := range [][]string{
		{"create", "--title", "LFS", "--acceptance-criteria", "Build", "--acceptance-criteria-items", `[{"text":"Build"}]`},
		{"create", "--title", "LFS", "--acceptance-criteria-items", `[{"id":"not-allowed","text":"Build"}]`},
		{"create", "--title", "LFS", "--acceptance-criteria-items", `[{"text":"   "}]`},
		{"create", "--title", "LFS", "--acceptance-criteria-items", `[{"text":"Build\nBoot"}]`},
		{"create", "--title", "LFS", "--acceptance-criteria-items", `[{"text":"Build"}]`},
		{"create", "--title", "LFS", "--acceptance-criteria-items", `[{"text":"Build","verificationMethod":"   "}]`},
	} {
		var out bytes.Buffer
		if err := cmdProjectCLI(args, strings.NewReader(""), &out); err == nil {
			t.Fatalf("project create accepted ambiguous criteria: %#v", args)
		}
	}
	if hit {
		t.Fatal("an invalid structured project create reached the server")
	}
}

// A project with no title has nothing to identify it by, and the server refuses one — so the CLI
// says which flag is missing rather than spending a round trip to be told.
func TestProjectCreateRequiresATitle(t *testing.T) {
	var hit bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)

	for _, args := range [][]string{
		{"create", "--json"},
		{"create", "--title", "   ", "--json"},
	} {
		var out bytes.Buffer
		err := cmdProjectCLI(args, strings.NewReader(""), &out)
		if err == nil || !strings.Contains(err.Error(), "--title is required") {
			t.Fatalf("project %v = %v", args, err)
		}
	}
	if hit {
		t.Fatal("project create called the server with no title")
	}
}

// One stdin, three fields that can read it. The first read drains the stream and the second comes
// back empty, which nothing downstream can notice — so naming two is refused before either read.
func TestProjectCreateRejectsTwoStdinFlags(t *testing.T) {
	var hit bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	err := cmdProjectCLI([]string{
		"create", "--title", "Crawl", "--goal-file", "-", "--instructions-file", "-",
	}, strings.NewReader("from stdin"), &out)
	if err == nil || !strings.Contains(err.Error(), "cannot be used together") {
		t.Fatalf("two stdin flags = %v", err)
	}
	if hit {
		t.Fatal("two stdin flags reached the server")
	}

	// One of them alone is the point of the flag, and stays legal alongside inline values.
	out.Reset()
	var body map[string]interface{}
	srv2 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = w.Write([]byte(projectCreatedJSON))
	}))
	defer srv2.Close()
	configureCLITestRunner(t, srv2.URL)
	err = cmdProjectCLI([]string{
		"create", "--title", "Crawl", "--goal-file", "-", "--instructions", "Work shard by shard",
	}, strings.NewReader("Index the corpus"), &out)
	if err != nil {
		t.Fatalf("project create with one stdin flag: %v", err)
	}
	if body["goal"] != "Index the corpus" || body["instructions"] != "Work shard by shard" {
		t.Fatalf("project create body = %#v", body)
	}
}

func TestProjectCreatePropagatesTheServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"statusCode":400,"message":"goal must be shorter than or equal to 4000 characters"}`))
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	err := cmdProjectCLI([]string{"create", "--title", "Crawl", "--goal", "x", "--json"}, strings.NewReader(""), &out)
	if err == nil {
		t.Fatal("a rejected project create reported success")
	}
	if !strings.Contains(err.Error(), "create project") || !strings.Contains(err.Error(), "400") {
		t.Fatalf("project create error = %v", err)
	}
	if out.Len() != 0 {
		t.Fatalf("project create printed a body for a failed write: %q", out.String())
	}
}

// ── update ────────────────────────────────────────────────────────────────────────────────────

func TestProjectUpdatePatchesTheRunnerProjectRoute(t *testing.T) {
	var method, path string
	var body map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = w.Write([]byte(projectDetailJSON))
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	err := cmdProjectCLI([]string{
		"update", "343dlzsYWKo5z8l2M8tsB", "--title", "Crawl the archive",
		"--goal", "Index every shard", "--status", "CANCELLED", "--json",
	}, strings.NewReader(""), &out)
	if err != nil {
		t.Fatalf("project update: %v", err)
	}
	// PATCH, not POST: a POST to this path is the create route and would file a second project
	// rather than change this one. The base62 id reaches the server verbatim.
	if method != http.MethodPatch || path != "/api/runner/projects/343dlzsYWKo5z8l2M8tsB" {
		t.Fatalf("project update hit %s %s", method, path)
	}
	want := map[string]interface{}{"title": "Crawl the archive", "goal": "Index every shard", "status": "CANCELLED"}
	if fmt.Sprintf("%v", body) != fmt.Sprintf("%v", want) {
		t.Fatalf("project update body = %#v", body)
	}
}

// Only what was named. A partial edit that also carried the fields nobody mentioned would blank
// them, because the server treats a present key as an instruction.
func TestProjectUpdateSendsOnlyTheFlagsGiven(t *testing.T) {
	var body map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = w.Write([]byte(projectDetailJSON))
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	if err := cmdProjectCLI([]string{"update", "proj-1", "--status", "CANCELLED", "--json"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("project update: %v", err)
	}
	if len(body) != 1 || body["status"] != "CANCELLED" {
		t.Fatalf("project update body = %#v", body)
	}
}

func TestProjectUpdatePreservesStructuredAcceptanceIdentity(t *testing.T) {
	var body map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = w.Write([]byte(projectDetailJSON))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	err := cmdProjectCLI([]string{
		"update", "proj-1", "--acceptance-criteria-items",
		`[{"id":"criterion-2","text":"Image boots","verificationMethod":"Smoke the image","completionCriterion":"HUMAN_SIGNOFF"},{"id":"criterion-1","text":"Build succeeds","verificationMethod":"Run npm test","completionCriterion":"HUMAN_SIGNOFF"}]`,
		"--json",
	}, strings.NewReader(""), &out)
	if err != nil {
		t.Fatalf("structured project update: %v", err)
	}
	items, _ := body["acceptanceCriteriaItems"].([]interface{})
	if len(items) != 2 || items[0].(map[string]interface{})["id"] != "criterion-2" ||
		items[0].(map[string]interface{})["verificationMethod"] != "Smoke the image" ||
		items[0].(map[string]interface{})["completionCriterion"] != "HUMAN_SIGNOFF" ||
		items[1].(map[string]interface{})["id"] != "criterion-1" ||
		items[1].(map[string]interface{})["verificationMethod"] != "Run npm test" ||
		items[1].(map[string]interface{})["completionCriterion"] != "HUMAN_SIGNOFF" {
		t.Fatalf("structured project update body = %#v", body)
	}
	if len(body) != 1 {
		t.Fatalf("structured project update sent unrelated fields: %#v", body)
	}

	// An empty structured array is the unambiguous structured clear spelling.
	body = nil
	if err := cmdProjectCLI([]string{
		"update", "proj-1", "--acceptance-criteria-items", "[]", "--json",
	}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("structured project clear: %v", err)
	}
	cleared, present := body["acceptanceCriteriaItems"].([]interface{})
	if !present || len(cleared) != 0 {
		t.Fatalf("structured project clear body = %#v", body)
	}
}

// --clear-<field> removes ordinary prose as JSON null. Acceptance criteria use the structured []
// spelling tested above, because a legacy null is still the implicit-HUMAN_SIGNOFF authoring shape.
func TestProjectUpdateClearsOrdinaryProseWithAnExplicitNull(t *testing.T) {
	var raw string
	var body map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		raw = string(b)
		_ = json.Unmarshal(b, &body)
		_, _ = w.Write([]byte(projectDetailJSON))
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	err := cmdProjectCLI([]string{
		"update", "proj-1", "--clear-goal", "--clear-instructions", "--json",
	}, strings.NewReader(""), &out)
	if err != nil {
		t.Fatalf("project update: %v", err)
	}
	for _, field := range []string{"goal", "instructions"} {
		value, present := body[field]
		if !present {
			t.Fatalf("project update dropped the %s clear: %s", field, raw)
		}
		if value != nil {
			t.Fatalf("project update sent %s = %#v, not null: %s", field, value, raw)
		}
	}
	if len(body) != 2 {
		t.Fatalf("project update body = %s", raw)
	}
}

func TestProjectUpdateRejectsLegacyAcceptanceBeforeHTTP(t *testing.T) {
	var hit bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hit = true }))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)

	for _, args := range [][]string{
		{"update", "proj-1", "--acceptance-criteria", "Build succeeds"},
		{"update", "proj-1", "--acceptance-criteria-file", "-"},
		{"update", "proj-1", "--clear-acceptance-criteria"},
	} {
		var out bytes.Buffer
		err := cmdProjectCLI(args, strings.NewReader("Build succeeds"), &out)
		if err == nil || !strings.Contains(err.Error(), "HUMAN_SIGNOFF") ||
			!strings.Contains(err.Error(), "use [] to clear") {
			t.Fatalf("legacy project update = %v", err)
		}
	}
	if hit {
		t.Fatal("legacy project update reached HTTP")
	}
}

// Clearing and replacing are opposite instructions about one field, so naming both is refused
// rather than resolved by a preference order — including when the replacement is on stdin, which
// is why it is caught before anything reads it.
func TestProjectUpdateRejectsContradictoryFlags(t *testing.T) {
	var hit bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)

	for _, args := range [][]string{
		{"update", "proj-1", "--clear-goal", "--goal", "Index the corpus"},
		{"update", "proj-1", "--clear-goal", "--goal-file", "-"},
		{"update", "proj-1", "--clear-instructions", "--instructions", "Shard by shard"},
		{"update", "proj-1", "--clear-instructions", "--instructions-file", "-"},
	} {
		var out bytes.Buffer
		err := cmdProjectCLI(args, strings.NewReader("from stdin"), &out)
		if err == nil || !strings.Contains(err.Error(), "cannot be used together") {
			t.Fatalf("project %v = %v", args, err)
		}
	}
	if hit {
		t.Fatal("a contradictory update reached the server")
	}
}

// An update naming no field is a request that would change nothing and come back 200, which reads
// as "the edit went through". Refused locally instead — same rule as `orbit task update`.
func TestProjectUpdateRejectsAnEmptyEdit(t *testing.T) {
	var hit bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	err := cmdProjectCLI([]string{"update", "proj-1", "--json"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "no fields to update") {
		t.Fatalf("empty project update = %v", err)
	}
	if hit {
		t.Fatal("an empty project update reached the server")
	}
}

func TestProjectUpdateValidatesIDAndStatus(t *testing.T) {
	var hit bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)

	// No ORBIT_PROJECT_ID to fall back on, so a missing id cannot be guessed.
	var out bytes.Buffer
	err := cmdProjectCLI([]string{"update", "--status", "DONE"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "project id is required") {
		t.Fatalf("project update without an id = %v", err)
	}
	// An id that could address another route never leaves the process.
	out.Reset()
	if err := cmdProjectCLI([]string{"update", "../tasks/x", "--status", "CANCELLED"}, strings.NewReader(""), &out); err == nil {
		t.Fatal("an unsafe project id was accepted")
	}
	// A status the server would reject is named here, with the alternatives.
	for _, status := range []string{"DONE", "IN_PROGRESS", "done", ""} {
		out.Reset()
		err := cmdProjectCLI([]string{"update", "proj-1", "--status", status}, strings.NewReader(""), &out)
		if err == nil || !strings.Contains(err.Error(), "--status must be one of") {
			t.Fatalf("project update --status %q = %v", status, err)
		}
	}
	// An empty title is a typo, not an instruction: the server's DTO has MinLength(1).
	out.Reset()
	err = cmdProjectCLI([]string{"update", "proj-1", "--title", "  "}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "--title cannot be empty") {
		t.Fatalf("project update --title '' = %v", err)
	}
	if hit {
		t.Fatal("an invalid project update reached the server")
	}
}

func TestProjectUpdatePropagatesTheServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"statusCode":404,"message":"project not found"}`))
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	err := cmdProjectCLI([]string{"update", "someone-elses-project", "--status", "CANCELLED", "--json"}, strings.NewReader(""), &out)
	if err == nil {
		t.Fatal("a 404 project update reported success")
	}
	if !strings.Contains(err.Error(), "update project") || !strings.Contains(err.Error(), "404") {
		t.Fatalf("project update error = %v", err)
	}
	if out.Len() != 0 {
		t.Fatalf("project update printed a body for a failed write: %q", out.String())
	}
}

// The session the CLI ran in reaches the server as context, which is what lets the new project
// remember where its coordinator is to be opened. Verbatim: the runner injects ORBIT_SESSION_ID
// already spelled base62 (that is the spelling everything a model can see uses), and the server
// decodes it — a CLI that re-spelled it here would produce an id neither end recognises.
func TestProjectCreateCarriesTheSessionItRanIn(t *testing.T) {
	var session, method, path string
	var body map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path = r.Method, r.URL.Path
		session = r.Header.Get("X-Orbit-Session-Id")
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = w.Write([]byte(projectCreatedJSON))
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "343dlzsYWKo5z8l2M8tsB")

	var out bytes.Buffer
	if err := cmdProjectCLI([]string{"create", "--title", "Crawl"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("project create: %v", err)
	}
	if method != http.MethodPost || path != "/api/runner/projects" {
		t.Fatalf("project create hit %s %s", method, path)
	}
	if session != "343dlzsYWKo5z8l2M8tsB" {
		t.Fatalf("project create session header = %q", session)
	}
	// The session is context, never content: a workspace in the body would be this process's own
	// claim about where a coordinator should run, and the server does not accept one.
	if len(body) != 1 || body["title"] != "Crawl" {
		t.Fatalf("project create body = %#v", body)
	}
}

// A launchd/cron bridge belongs to no session and has no workspace to inherit. The header has to
// be ABSENT rather than empty: an empty one is a session id the server would look up and refuse,
// turning a legitimate headless create into a 403.
func TestProjectCreateHeadlessSendsNoSessionHeader(t *testing.T) {
	sawSessionHeader := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, sawSessionHeader = r.Header["X-Orbit-Session-Id"]
		_, _ = w.Write([]byte(projectCreatedJSON))
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)
	t.Setenv("ORBIT_SESSION_ID", "")

	var out bytes.Buffer
	if err := cmdProjectCLI([]string{"create", "--title", "Nightly sweep"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("project create: %v", err)
	}
	if sawSessionHeader {
		t.Fatal("a headless project create sent a session header")
	}
}

// A shell that exports ORBIT_SESSION_ID from something empty leaves whitespace, which is not a
// session — and padding around a real id is not a different id.
func TestProjectCreateTrimsTheSessionFromTheEnvironment(t *testing.T) {
	for _, tc := range []struct{ env, want string }{
		{"  sess-1  ", "sess-1"},
		{"   ", ""},
	} {
		var session string
		sawSessionHeader := true
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			session = r.Header.Get("X-Orbit-Session-Id")
			_, sawSessionHeader = r.Header["X-Orbit-Session-Id"]
			_, _ = w.Write([]byte(projectCreatedJSON))
		}))

		configureCLITestRunner(t, srv.URL)
		t.Setenv("ORBIT_SESSION_ID", tc.env)

		var out bytes.Buffer
		if err := cmdProjectCLI([]string{"create", "--title", "Crawl"}, strings.NewReader(""), &out); err != nil {
			t.Fatalf("project create %q: %v", tc.env, err)
		}
		srv.Close()
		if session != tc.want {
			t.Fatalf("ORBIT_SESSION_ID=%q sent session header %q, want %q", tc.env, session, tc.want)
		}
		if tc.want == "" && sawSessionHeader {
			t.Fatalf("ORBIT_SESSION_ID=%q sent an empty session header instead of none", tc.env)
		}
	}
}

// Reading, revising and deleting a project are not "where am I" questions. A coordinator default
// is settled when the project is created; none of these requests may reinterpret the calling
// session as a coordinator binding.
func TestProjectReadUpdateAndDeleteCarryNoSession(t *testing.T) {
	for _, tc := range []struct {
		name string
		argv []string
	}{
		{"get", []string{"get", "proj-1", "--json"}},
		{"update", []string{"update", "proj-1", "--status", "CANCELLED", "--json"}},
		{"delete", []string{"delete", "proj-1", "--json"}},
	} {
		sawSessionHeader := true
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, sawSessionHeader = r.Header["X-Orbit-Session-Id"]
			_, _ = w.Write([]byte(projectDetailJSON))
		}))

		configureCLITestRunner(t, srv.URL)
		t.Setenv("ORBIT_SESSION_ID", "sess-1")

		var out bytes.Buffer
		if err := cmdProjectCLI(tc.argv, strings.NewReader(""), &out); err != nil {
			t.Fatalf("project %s: %v", tc.name, err)
		}
		srv.Close()
		if sawSessionHeader {
			t.Fatalf("project %s sent a session header", tc.name)
		}
	}
}

// Whoever reads the help or the capability document is deciding whether a project they create can
// be coordinated. The old text said it "holds no tasks yet" and stopped there, which read as "so
// there is nothing to coordinate from" — the exact belief that produced the file-a-task-first
// workaround.
func TestProjectCreateHelpStatesTheCoordinatorDefault(t *testing.T) {
	var out bytes.Buffer
	if err := cmdProjectCLI([]string{"create", "--help"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("project create --help: %v", err)
	}
	for _, want := range []string{"coordinator", "session", "headless"} {
		if !strings.Contains(strings.ToLower(out.String()), want) {
			t.Fatalf("project create help does not mention %q:\n%s", want, out.String())
		}
	}

	var found bool
	for _, cmd := range projectCLICapabilities {
		if cmd.Tool != "project_create" {
			continue
		}
		found = true
		for _, want := range []string{"coordinator", "session", "headless"} {
			if !strings.Contains(strings.ToLower(cmd.Description), want) {
				t.Fatalf("project_create capability description does not mention %q: %q", want, cmd.Description)
			}
		}
	}
	if !found {
		t.Fatal("project_create is missing from the capability document")
	}
}

func TestProjectWriteHelpTreatsLegacyCriteriaAsUserCompatibilityNotAgentFallback(t *testing.T) {
	for _, action := range []string{"create", "update"} {
		var out bytes.Buffer
		if err := cmdProjectCLI([]string{action, "--help"}, strings.NewReader(""), &out); err != nil {
			t.Fatalf("project %s --help: %v", action, err)
		}
		text := out.String()
		for _, want := range []string{"user/JWT API", "not an agent authoring fallback", "HUMAN_SIGNOFF", "completionCriterion"} {
			if !strings.Contains(text, want) {
				t.Fatalf("project %s help does not explain legacy compatibility (%q):\n%s", action, want, text)
			}
		}
	}

	for _, command := range projectCLICapabilities {
		if command.Tool != "project_create" && command.Tool != "project_update" {
			continue
		}
		if strings.Contains(strings.Join(command.Arguments, " "), "--acceptance-criteria <") {
			t.Fatalf("%s capability still advertises the refused legacy write: %#v", command.Tool, command.Arguments)
		}
		for _, want := range []string{"user/JWT API", "not an agent fallback", "HUMAN_SIGNOFF", "completionCriterion"} {
			if !strings.Contains(command.Description, want) {
				t.Fatalf("%s capability does not explain legacy compatibility (%q): %q", command.Tool, want, command.Description)
			}
		}
	}
}

// ── `orbit project status` (contract AC10, unit 20) ───────────────────────────────────────────

// The control loop's own state, served as the server composed it. Two things are being asserted:
// the route (the runner bridge, not the JWT-guarded user one), and that the body reaches stdout
// verbatim — a CLI that reformatted it would be a second, disagreeing account of what the
// coordinator is doing, and this command exists precisely because there was no single account.
const projectStatusJSON = `{"projectId":"proj-1","project":{"status":"OPEN"},` +
	`"coordination":{"agentId":null,"agentIdAbsentReason":"NO_COORDINATOR_AGENT"},` +
	`"policy":{"coordinatorEnabled":false,"automationPolicy":"MANUAL","configRevision":"3"},` +
	`"runtime":{"runState":"PLANNING","lease":null,"leaseAbsentReason":"NOT_LEASED"},` +
	`"nextWake":{"at":null,"absentReason":"NO_WAKE_SCHEDULED"}}`

// No id, no request. The task commands default to ORBIT_TASK_ID; there is no ORBIT_PROJECT_ID and
// guessing one would read a different project than the caller meant.
func TestProjectStatusRequiresAnID(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("project status without an id reached the server")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	if err := cmdProjectCLI([]string{"status"}, strings.NewReader(""), &out); err == nil {
		t.Fatal("project status without an id was accepted")
	}
}

// ── The compare-and-swap fence on `orbit project update` ──────────────────────────────────────

func TestProjectUpdateSendsTheExpectedConfigRevision(t *testing.T) {
	var body map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = w.Write([]byte(projectDetailJSON))
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	err := cmdProjectCLI(
		[]string{"update", "proj-1", "--title", "Crawl", "--expected-config-revision", "7"},
		strings.NewReader(""), &out)
	if err != nil {
		t.Fatalf("project update: %v", err)
	}
	// A string on the wire, not a number: configRevision is a bigint served as decimal text, and a
	// JSON number would stop being able to tell two revisions apart past 2^53 — which is exactly
	// the comparison the fence exists to make.
	if body["expectedConfigRevision"] != "7" {
		t.Fatalf("update body = %#v", body)
	}
}

// The fence names nothing to write, so an invocation carrying only it is the no-op the command
// already refuses. Accepting it would send a request that changes nothing and report success.
func TestProjectUpdateRefusesAFenceWithNoFields(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("an update with no fields reached the server")
		_, _ = w.Write([]byte(projectDetailJSON))
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	err := cmdProjectCLI(
		[]string{"update", "proj-1", "--expected-config-revision", "7"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "no fields to update") {
		t.Fatalf("update with only a fence = %v", err)
	}
}

func TestProjectUpdateRejectsANonDecimalRevision(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("a malformed fence reached the server")
		_, _ = w.Write([]byte(projectDetailJSON))
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)

	for _, bad := range []string{"", "7.0", "-1", "seven", "0x7", "999999999999999999999"} {
		var out bytes.Buffer
		err := cmdProjectCLI(
			[]string{"update", "proj-1", "--title", "Crawl", "--expected-config-revision", bad},
			strings.NewReader(""), &out)
		if err == nil {
			t.Fatalf("--expected-config-revision %q was accepted", bad)
		}
	}
}

// Omitting it keeps the behaviour every existing script has: the write goes as it always did.
func TestProjectUpdateWithoutAFenceSendsNoSuchField(t *testing.T) {
	var body map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = w.Write([]byte(projectDetailJSON))
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)

	var out bytes.Buffer
	if err := cmdProjectCLI([]string{"update", "proj-1", "--title", "Crawl"},
		strings.NewReader(""), &out); err != nil {
		t.Fatalf("project update: %v", err)
	}
	if _, present := body["expectedConfigRevision"]; present {
		t.Fatalf("update body carried a fence nobody asked for: %#v", body)
	}
}
