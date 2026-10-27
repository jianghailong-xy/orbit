package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

// What GET /api/runner/runners answers: the runner's id is the one --runner-id takes.
const runnerListBody = `[{"id":"349tsNoHC7biW3WXF1ddp","publicId":"349tsNoHC7biW3WXF1ddp","name":"instance-20261027-071926","displayName":null,"online":true,"status":"ONLINE","version":"0.9.1","lastHeartbeatAt":"2026-10-27T07:40:00.000Z","maxConcurrent":16,"os":"linux","engines":[{"engine":"claude","auth":"yes"}],"workspaceCount":0}]`

func TestRunnerCLIListsTheAccountsRunners(t *testing.T) {
	var method, path string
	requests := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		method, path = r.Method, r.URL.Path
		if id := r.Header.Get("X-Orbit-Session-Id"); id != "caller-session" {
			t.Errorf("X-Orbit-Session-Id = %q", id)
		}
		if token := r.Header.Get("X-Orbit-Session-Token"); token != "session-token" {
			t.Errorf("X-Orbit-Session-Token = %q", token)
		}
		_, _ = w.Write([]byte(runnerListBody))
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)
	t.Setenv(envMCPOrchestration, "true")
	t.Setenv("ORBIT_SESSION_ID", "caller-session")
	t.Setenv(envOrchestrationToken, "session-token")

	var out bytes.Buffer
	if err := cmdRunnerCLI([]string{"list", "--json"}, &out); err != nil {
		t.Fatalf("runner list --json: %v", err)
	}
	if method != http.MethodGet || path != "/api/runner/runners" {
		t.Fatalf("runner list hit %s %s", method, path)
	}
	if out.String() != runnerListBody+"\n" {
		t.Fatalf("runner list --json output = %q", out.String())
	}

	// Without --json, the same answer for a person to read: every field, indented.
	out.Reset()
	if err := cmdRunnerCLI([]string{"list"}, &out); err != nil {
		t.Fatalf("runner list: %v", err)
	}
	for _, want := range []string{`"id": "349tsNoHC7biW3WXF1ddp"`, `"name": "instance-20261027-071926"`, `"online": true`, "\n  {\n"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("runner list output does not contain %q: %s", want, out.String())
		}
	}
	if requests != 2 {
		t.Fatalf("requests = %d, want 2", requests)
	}
}

// The runner list is an orchestration verb, as the agent verbs whose --runner-id it answers for are:
// no service-token scope names it, and outside a session there is no calling agent to authorize it.
func TestRunnerCLIRequiresALiveOrchestrationSession(t *testing.T) {
	requests := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)

	for _, tc := range []struct {
		name      string
		env       map[string]string
		wantError string
	}{
		{
			name:      "headless",
			env:       map[string]string{"ORBIT_SESSION_ID": "", envMCPOrchestration: "true", envOrchestrationToken: ""},
			wantError: "requires ORBIT_SESSION_ID context",
		},
		{
			name:      "orchestration disabled",
			env:       map[string]string{"ORBIT_SESSION_ID": "caller-session", envMCPOrchestration: "", envOrchestrationToken: ""},
			wantError: orchestrationOffMsg,
		},
		{
			name: "service token",
			env: map[string]string{
				"ORBIT_SESSION_ID": "", envMCPOrchestration: "true", envOrchestrationToken: "",
				envServiceToken: fakeServiceToken(t, []string{"session:create", "session:get", "session:list"}, "agent-1", time.Hour),
			},
			wantError: "no service token can grant it",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for key, value := range tc.env {
				t.Setenv(key, value)
			}
			var out bytes.Buffer
			err := cmdRunnerCLI([]string{"list"}, &out)
			if err == nil || !strings.Contains(err.Error(), tc.wantError) {
				t.Fatalf("runner list error = %v, want containing %q", err, tc.wantError)
			}
		})
	}
	if requests != 0 {
		t.Fatalf("a refused runner command still made %d requests", requests)
	}
}

func TestRunnerCLIValidatesArguments(t *testing.T) {
	requests := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)
	t.Setenv(envMCPOrchestration, "true")
	t.Setenv("ORBIT_SESSION_ID", "caller-session")
	t.Setenv(envOrchestrationToken, "session-token")

	for _, tc := range []struct {
		name      string
		args      []string
		wantError string
	}{
		{name: "unknown command", args: []string{"remove"}, wantError: "unknown command"},
		{name: "trailing argument", args: []string{"list", "runner-2"}, wantError: "unexpected arguments: runner-2"},
		{name: "unknown flag", args: []string{"list", "--all"}, wantError: "flag provided but not defined: -all"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var out bytes.Buffer
			err := cmdRunnerCLI(tc.args, &out)
			if err == nil || !strings.Contains(err.Error(), tc.wantError) {
				t.Fatalf("error = %v, want containing %q", err, tc.wantError)
			}
		})
	}
	if requests != 0 {
		t.Fatalf("a rejected runner command still made %d requests", requests)
	}
}

func TestRunnerListHelpNamesWhatTheIDIsFor(t *testing.T) {
	var out bytes.Buffer
	if err := cmdRunnerCLI([]string{"list", "--help"}, &out); err != nil {
		t.Fatalf("runner list --help: %v", err)
	}
	for _, want := range []string{"orbit runner list [--json]", "--runner-id", "orbit agent create", "orbit agent update", "online"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("runner list --help does not mention %q: %q", want, out.String())
		}
	}
	if !ownsLeafHelp("runner") {
		t.Fatal("main does not route orbit runner list --help to the leaf command")
	}
	if help := helpFor("runner"); help != runnerHelp {
		t.Fatalf("orbit help runner = %q", help)
	}
	if !strings.Contains(usage, "orbit runner <command>") {
		t.Fatal("orbit's usage does not list the runner command")
	}
	// The agent verbs that take a runner id point at the list that has them.
	for _, action := range []string{"create", "update"} {
		if !strings.Contains(agentActionHelp[action], "'orbit runner list' shows the ids") {
			t.Errorf("orbit agent %s --help does not point --runner-id at orbit runner list", action)
		}
	}
}

// The capability document is what an agent reads to discover the CLI: runner_list is there under the
// orchestration gate the agent verbs ride, read-only, described and shaped as the MCP tool is — and
// never outside that gate.
func TestRunnerCLICapabilitiesFollowTheOrchestrationGate(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv(envOrchestrationToken, "session-token")
	t.Setenv(envServiceToken, "")

	t.Setenv("ORBIT_SESSION_ID", "caller-session")
	t.Setenv(envMCPOrchestration, "true")
	on := buildCLICapabilities("/opt/orbit")
	var descriptor map[string]interface{}
	for _, d := range toolDescriptors(false, true) {
		if d["name"] == "runner_list" {
			descriptor = d
		}
	}
	if descriptor == nil {
		t.Fatal("no runner_list MCP tool with orchestration enabled")
	}
	capability := sessionCLICapabilityByID(on.Capabilities, "runner_list")
	if capability == nil {
		t.Fatal("runner_list missing from orbit capabilities with orchestration enabled")
	}
	if !reflect.DeepEqual(capability.Argv, []string{"/opt/orbit", "runner", "list"}) {
		t.Errorf("runner_list argv = %#v", capability.Argv)
	}
	if capability.Usage != "orbit runner list [--json]" {
		t.Errorf("runner_list usage = %q", capability.Usage)
	}
	if capability.Description != descriptor["description"] {
		t.Error("runner_list description diverged from the MCP descriptor")
	}
	if !reflect.DeepEqual(capability.MCPInputSchema, descriptor["inputSchema"]) {
		t.Error("runner_list schema diverged from the MCP descriptor")
	}
	if capability.Mutates {
		t.Error("runner_list only reads, so it must not be marked as mutating")
	}
	if !capability.Available {
		t.Errorf("runner_list unavailable in an orchestrating session: %q", capability.UnavailableReason)
	}

	// Orchestration off, and headless with a service token: not in either document.
	t.Setenv(envMCPOrchestration, "")
	off := buildCLICapabilities("/opt/orbit")
	t.Setenv("ORBIT_SESSION_ID", "")
	t.Setenv(envServiceToken, fakeServiceToken(t, []string{"session:create", "session:get"}, "agent-1", time.Hour))
	headless := buildCLICapabilities("/opt/orbit")
	for _, doc := range []cliCapabilitiesDocument{off, headless} {
		if sessionCLICapabilityByID(doc.Capabilities, "runner_list") != nil {
			t.Fatal("runner_list advertised without an orchestration-enabled session")
		}
	}

	// And pre-approved exactly where it is advertised.
	rule := "Bash(/opt/orbit runner list *)"
	if !contains(orbitCLIAllowedTools("/opt/orbit", true), rule) {
		t.Errorf("an orchestrating session is not pre-approved %s", rule)
	}
	if contains(orbitCLIAllowedTools("/opt/orbit", false), rule) {
		t.Errorf("a session without the grant is pre-approved %s", rule)
	}
}
