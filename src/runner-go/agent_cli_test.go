package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestAgentCLIRoutesHeadersAndBodies(t *testing.T) {
	type request struct {
		method string
		path   string
		body   map[string]interface{}
	}
	var got request
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = request{method: r.Method, path: r.URL.Path}
		if r.Body != nil && r.ContentLength != 0 {
			_ = json.NewDecoder(r.Body).Decode(&got.body)
		}
		if id := r.Header.Get("X-Orbit-Session-Id"); id != "caller-session" {
			t.Errorf("X-Orbit-Session-Id = %q", id)
		}
		if token := r.Header.Get("X-Orbit-Session-Token"); token != "session-token" {
			t.Errorf("X-Orbit-Session-Token = %q", token)
		}
		switch r.Method {
		case http.MethodGet:
			_, _ = w.Write([]byte(`[{"id":"agent-9","repoUrl":"https://github.com/acme/failed.git","provisionState":"FAILED","provisionError":"fatal: denied"}]`))
		case http.MethodPost:
			_, _ = w.Write([]byte(`{"id":"agent-10","repoUrl":"https://github.com/acme/reviewer.git","provisionState":"CLONING","provisionError":null}`))
		default:
			_, _ = w.Write([]byte(`{"id":"agent-9","provisionState":"READY","provisionError":null}`))
		}
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)
	t.Setenv(envMCPOrchestration, "true")
	t.Setenv("ORBIT_SESSION_ID", "caller-session")
	t.Setenv(envOrchestrationToken, "session-token")

	var out bytes.Buffer
	if err := cmdAgentCLI([]string{"list", "--json"}, &out); err != nil {
		t.Fatalf("agent list: %v", err)
	}
	if got.method != http.MethodGet || got.path != "/api/runner/agents" {
		t.Fatalf("agent list hit %s %s", got.method, got.path)
	}
	if out.String() != "[{\"id\":\"agent-9\",\"repoUrl\":\"https://github.com/acme/failed.git\",\"provisionState\":\"FAILED\",\"provisionError\":\"fatal: denied\"}]\n" {
		t.Fatalf("agent list output = %q", out.String())
	}

	// Every write field the MCP tool carries has to survive the trip, under the same API name.
	out.Reset()
	err := cmdAgentCLI([]string{
		"create", "--name", "reviewer", "--description", "reviews diffs",
		"--system-prompt", "be exact", "--append-system-prompt", "and terse",
		"--runner-id", "runner-2", "--repo-url", "https://github.com/acme/reviewer.git",
		"--enable-worktree",
		"--env", "TOKEN=abc=123", "--env", "REGION=eu",
		"--default-merge-target", "develop", "--json",
	}, &out)
	if err != nil {
		t.Fatalf("agent create: %v", err)
	}
	if got.method != http.MethodPost || got.path != "/api/runner/agents" {
		t.Fatalf("agent create hit %s %s", got.method, got.path)
	}
	want := map[string]interface{}{
		"name":               "reviewer",
		"description":        "reviews diffs",
		"systemPrompt":       "be exact",
		"appendSystemPrompt": "and terse",
		"runnerId":           "runner-2",
		"repoUrl":            "https://github.com/acme/reviewer.git",
		"enableWorktree":     true,
		"defaultMergeTarget": "develop",
		// Split on the first '=' only, so a value may contain more of them.
		"env": map[string]interface{}{"TOKEN": "abc=123", "REGION": "eu"},
	}
	if !reflect.DeepEqual(got.body, want) {
		t.Fatalf("agent create body = %#v, want %#v", got.body, want)
	}
	if out.String() != "{\"id\":\"agent-10\",\"repoUrl\":\"https://github.com/acme/reviewer.git\",\"provisionState\":\"CLONING\",\"provisionError\":null}\n" {
		t.Fatalf("agent create output lost its provisioning receipt: %q", out.String())
	}

	// An update sends only what was asked for: the API replaces what it receives, so an
	// unmentioned field must not travel as an empty string.
	out.Reset()
	if err := cmdAgentCLI([]string{"update", "agent-9", "--work-dir", "/srv/other", "--json"}, &out); err != nil {
		t.Fatalf("agent update: %v", err)
	}
	if got.method != http.MethodPatch || got.path != "/api/runner/agents/agent-9" {
		t.Fatalf("agent update hit %s %s", got.method, got.path)
	}
	if !reflect.DeepEqual(got.body, map[string]interface{}{"workDir": "/srv/other"}) {
		t.Fatalf("agent update body = %#v", got.body)
	}
}

// The CLI's half of the base62 rule: it does not own the id, so it must not reshape it. Every id
// a caller holds came out of this API in the base62 spelling (PublicIdInterceptor), and
// `--runner-id 349tsNoHC7biW3WXF1ddp` is how you bind an agent to a machine other than the one
// you are on. Reject it, pad it, or lowercase it here and the server never gets the chance to
// decode it — which is why this asserts the exact bytes rather than "some runnerId arrived".
func TestAgentCLISendsABase62RunnerIDVerbatim(t *testing.T) {
	const runnerID = "349tsNoHC7biW3WXF1ddp"
	const agentID = "349v3072q7OPwydQE1yiU"
	var got struct {
		path string
		body map[string]interface{}
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.path = r.URL.Path
		got.body = nil
		if r.Body != nil && r.ContentLength != 0 {
			_ = json.NewDecoder(r.Body).Decode(&got.body)
		}
		_, _ = w.Write([]byte(`{"id":"` + agentID + `"}`))
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)
	t.Setenv(envMCPOrchestration, "true")
	t.Setenv("ORBIT_SESSION_ID", "caller-session")
	t.Setenv(envOrchestrationToken, "session-token")

	var out bytes.Buffer
	if err := cmdAgentCLI([]string{"create", "--name", "UX", "--runner-id", runnerID, "--json"}, &out); err != nil {
		t.Fatalf("agent create: %v", err)
	}
	if got.body["runnerId"] != runnerID {
		t.Fatalf("create sent runnerId = %#v, want %q", got.body["runnerId"], runnerID)
	}

	// A rebind carries it the same way, and the agent's own id — base62 too — stays a legal path
	// segment rather than being second-guessed into a UUID requirement.
	out.Reset()
	if err := cmdAgentCLI([]string{"update", agentID, "--runner-id", runnerID, "--json"}, &out); err != nil {
		t.Fatalf("agent update: %v", err)
	}
	if got.path != "/api/runner/agents/"+agentID {
		t.Fatalf("agent update hit %s", got.path)
	}
	if got.body["runnerId"] != runnerID {
		t.Fatalf("update sent runnerId = %#v, want %q", got.body["runnerId"], runnerID)
	}
}

// The agent verbs are orchestration-only, exactly like the session ones: no service-token scope
// names them, and outside a session there is no calling agent to authorize them at all.
func TestAgentCLIRequiresALiveOrchestrationSession(t *testing.T) {
	requests := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		_, _ = w.Write([]byte(`{}`))
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
				envServiceToken: fakeServiceToken(t, []string{"session:create", "session:get"}, "agent-1", time.Hour),
			},
			wantError: "no service token can grant it",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for key, value := range tc.env {
				t.Setenv(key, value)
			}
			for _, args := range [][]string{{"list"}, {"create", "--name", "x"}, {"update", "agent-9", "--name", "x"}} {
				var out bytes.Buffer
				err := cmdAgentCLI(args, &out)
				if err == nil || !strings.Contains(err.Error(), tc.wantError) {
					t.Fatalf("agent %s error = %v, want containing %q", args[0], err, tc.wantError)
				}
			}
		})
	}
	if requests != 0 {
		t.Fatalf("a refused agent command still made %d requests", requests)
	}
}

func TestAgentCLIValidatesArguments(t *testing.T) {
	requests := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		_, _ = w.Write([]byte(`{}`))
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
		{name: "missing name", args: []string{"create"}, wantError: "--name is required"},
		{name: "blank field", args: []string{"create", "--name", "x", "--work-dir", " "}, wantError: "--work-dir cannot be empty"},
		// The client half of the runnerId blank boundary. A blank is not a spelling of an id, and
		// the API refuses it with a 400 either way — but it never has to, because the request is
		// not made: `requests` below asserts every case here stopped in the CLI.
		{name: "blank runner id", args: []string{"create", "--name", "x", "--runner-id", ""}, wantError: "--runner-id cannot be empty"},
		{name: "blank repo URL", args: []string{"create", "--name", "x", "--repo-url", " "}, wantError: "--repo-url cannot be empty"},
		{name: "whitespace runner id", args: []string{"update", "343dlzsYWKo5z8l2M8tsD", "--runner-id", "  "}, wantError: "--runner-id cannot be empty"},
		{name: "env without value", args: []string{"create", "--name", "x", "--env", "TOKEN"}, wantError: "KEY=VALUE"},
		{name: "missing agent id", args: []string{"update", "--name", "x"}, wantError: "agent id is required"},
		{name: "nothing to update", args: []string{"update", "agent-9"}, wantError: "no fields to update"},
		{name: "repo URL is create-only", args: []string{"update", "agent-9", "--repo-url", "https://github.com/acme/new.git"}, wantError: "flag provided but not defined"},
		{name: "unsafe agent id", args: []string{"update", "../sessions", "--name", "x"}, wantError: "agent "},
		{name: "unknown command", args: []string{"restart"}, wantError: "unknown command"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var out bytes.Buffer
			err := cmdAgentCLI(tc.args, &out)
			if err == nil || !strings.Contains(err.Error(), tc.wantError) {
				t.Fatalf("error = %v, want containing %q", err, tc.wantError)
			}
		})
	}
	if requests != 0 {
		t.Fatalf("a rejected agent command still made %d requests", requests)
	}
}

func TestAgentCreateLeafHelpExplainsRepoProvisioning(t *testing.T) {
	var out bytes.Buffer
	if err := cmdAgentCLI([]string{"create", "--help"}, &out); err != nil {
		t.Fatalf("agent create --help: %v", err)
	}
	for _, want := range []string{"orbit agent create", "--repo-url", "CLONING", "READY", "FAILED", "provisionError", "orbit agent list"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("agent create --help does not mention %q: %q", want, out.String())
		}
	}
	if !ownsLeafHelp("agent") {
		t.Fatal("main no longer routes orbit agent create --help to the leaf command")
	}
}

// The capability document is what an agent reads to discover the CLI, so the agent verbs must
// appear there under the same gate as the session ones — and never outside it.
func TestAgentCLICapabilitiesFollowTheOrchestrationGate(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv(envOrchestrationToken, "session-token")
	t.Setenv(envServiceToken, "")

	t.Setenv("ORBIT_SESSION_ID", "caller-session")
	t.Setenv(envMCPOrchestration, "true")
	on := buildCLICapabilities("/opt/orbit")
	descriptors := map[string]map[string]interface{}{}
	for _, descriptor := range toolDescriptors(false, true) {
		name, _ := descriptor["name"].(string)
		descriptors[name] = descriptor
	}
	for _, id := range []string{"agent_list", "agent_create", "agent_update"} {
		capability := sessionCLICapabilityByID(on.Capabilities, id)
		if capability == nil {
			t.Fatalf("%s missing with orchestration enabled", id)
		}
		if capability.Description != descriptors[id]["description"] {
			t.Errorf("%s description diverged from the MCP descriptor", id)
		}
		if !reflect.DeepEqual(capability.MCPInputSchema, descriptors[id]["inputSchema"]) {
			t.Errorf("%s schema diverged from the MCP descriptor", id)
		}
		if !capability.Mutates && id != "agent_list" {
			t.Errorf("%s must be marked as mutating", id)
		}
	}

	// Orchestration off, and headless with a service token: no agent verb in either document.
	t.Setenv(envMCPOrchestration, "")
	off := buildCLICapabilities("/opt/orbit")
	t.Setenv("ORBIT_SESSION_ID", "")
	t.Setenv(envServiceToken, fakeServiceToken(t, []string{"session:create", "session:get"}, "agent-1", time.Hour))
	headless := buildCLICapabilities("/opt/orbit")
	for _, doc := range []cliCapabilitiesDocument{off, headless} {
		for _, id := range []string{"agent_list", "agent_create", "agent_update"} {
			if capability := sessionCLICapabilityByID(doc.Capabilities, id); capability != nil {
				t.Fatalf("%s advertised without an orchestration-enabled session", id)
			}
		}
	}
}
