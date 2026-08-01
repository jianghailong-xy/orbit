package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestSessionCLICapabilitiesMatchMCPAndFollowOrchestrationGate(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv("ORBIT_SESSION_ID", "")
	t.Setenv(envMCPOrchestration, "")
	t.Setenv(envOrchestrationToken, "")

	off := buildCLICapabilities("/opt/orbit")
	if capability := sessionCLIFirstSessionCapability(off.Capabilities); capability != nil {
		t.Fatalf("session capability exposed with orchestration disabled: %#v", capability)
	}

	t.Setenv(envMCPOrchestration, "true")
	withoutContext := buildCLICapabilities("/opt/orbit")
	if capability := sessionCLIFirstSessionCapability(withoutContext.Capabilities); capability != nil {
		t.Fatalf("session capability exposed without a caller session: %#v", capability)
	}

	t.Setenv("ORBIT_SESSION_ID", "caller-session")
	withoutCredential := buildCLICapabilities("/opt/orbit")
	if capability := sessionCLICapabilityByID(withoutCredential.Capabilities, "session_list"); capability == nil {
		t.Fatal("session capability missing with allow flag and caller session")
	}

	t.Setenv(envOrchestrationToken, "session-token")
	on := buildCLICapabilities("/opt/orbit")
	descriptors := map[string]map[string]interface{}{}
	for _, descriptor := range toolDescriptors(false, true) {
		name, _ := descriptor["name"].(string)
		descriptors[name] = descriptor
	}

	mutating := map[string]bool{
		"session_create":    true,
		"session_send":      true,
		"session_interrupt": true,
		"session_merge":     true,
		"session_end":       true,
		"session_complete":  true,
	}
	requiredArguments := map[string][]string{
		"create":    {"--prompt", "--prompt-file -", "--agent-id", "--agent-name", "--title", "--model", "--wait", "--json"},
		"list":      {"--status", "--parent-session-id", "--json"},
		"search":    {"--query", "--limit", "--json"},
		"get":       {"[session-id]", "--json"},
		"send":      {"[session-id]", "--message", "--message-file -", "--json"},
		"interrupt": {"[session-id]", "--json"},
		"merge":     {"[session-id]", "--target-branch", "--json"},
		"end":       {"[session-id]", "--json"},
		"complete":  {"[session-id]", "--json"},
	}
	for _, action := range []string{"create", "list", "search", "get", "send", "interrupt", "merge", "end", "complete"} {
		id := "session_" + action
		capability := sessionCLICapabilityByID(on.Capabilities, id)
		if capability == nil {
			t.Fatalf("%s capability missing with orchestration enabled", id)
		}
		wantArgv := []string{"/opt/orbit", "session", action}
		if !reflect.DeepEqual(capability.Argv, wantArgv) {
			t.Errorf("%s argv = %#v, want %#v", id, capability.Argv, wantArgv)
		}
		wantHelp := append(append([]string{}, wantArgv...), "--help")
		if !reflect.DeepEqual(capability.HelpArgv, wantHelp) {
			t.Errorf("%s help argv = %#v, want %#v", id, capability.HelpArgv, wantHelp)
		}
		descriptor := descriptors[id]
		if descriptor == nil {
			t.Fatalf("MCP descriptor %s missing", id)
		}
		if capability.Description != descriptor["description"] {
			t.Errorf("%s description diverged from MCP descriptor", id)
		}
		if !reflect.DeepEqual(capability.MCPInputSchema, descriptor["inputSchema"]) {
			t.Errorf("%s schema = %#v, want MCP schema %#v", id, capability.MCPInputSchema, descriptor["inputSchema"])
		}
		if capability.Mutates != mutating[id] {
			t.Errorf("%s mutates = %v, want %v", id, capability.Mutates, mutating[id])
		}
		for _, argument := range requiredArguments[action] {
			if !sessionCLIContains(capability.Arguments, argument) {
				t.Errorf("%s arguments do not document %q: %#v", id, argument, capability.Arguments)
			}
		}
		if action != "create" && sessionCLIContains(capability.Arguments, "defaults to ORBIT_SESSION_ID") {
			t.Errorf("%s incorrectly advertises a current-session fallback: %#v", id, capability.Arguments)
		}
	}
}

func TestSessionCLIHelpDocumentsComplete(t *testing.T) {
	var out bytes.Buffer
	if err := cmdSessionCLI([]string{"--help"}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "orbit session complete SESSION_ID [--json]") {
		t.Fatalf("session help does not document complete: %q", out.String())
	}

	out.Reset()
	if err := cmdSessionCLI([]string{"complete", "--help"}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "move a session to Completed") {
		t.Fatalf("complete help does not explain Completed semantics: %q", out.String())
	}
}

func TestSessionCLIExactRoutesHeadersBodiesAndJSON(t *testing.T) {
	tests := []struct {
		name       string
		args       []string
		stdin      string
		method     string
		requestURI string
		wantBody   map[string]interface{}
	}{
		{
			name:       "create",
			args:       []string{"create", "--prompt-file", "-", "--agent-id", "agent-2", "--title", "Review", "--model", "model-2", "--json"},
			stdin:      "inspect the change\n",
			method:     http.MethodPost,
			requestURI: "/api/runner/sessions",
			wantBody: map[string]interface{}{
				"prompt":  "inspect the change\n",
				"agentId": "agent-2",
				"title":   "Review",
				"model":   "model-2",
			},
		},
		{
			name:       "list",
			args:       []string{"list", "--status", "RUNNING", "--parent-session-id", "parent-2", "--json"},
			method:     http.MethodGet,
			requestURI: "/api/runner/sessions?parentSessionId=parent-2&status=RUNNING",
		},
		{
			name:       "search",
			args:       []string{"search", "--query", "merge conflict", "--limit", "7", "--json"},
			method:     http.MethodGet,
			requestURI: "/api/runner/sessions/search?limit=7&q=merge+conflict",
		},
		{
			name:       "get",
			args:       []string{"get", "child-session", "--json"},
			method:     http.MethodGet,
			requestURI: "/api/runner/sessions/child-session",
		},
		{
			name:       "send",
			args:       []string{"send", "child-session", "--message-file", "-", "--json"},
			stdin:      "please adjust the tests\n",
			method:     http.MethodPost,
			requestURI: "/api/runner/sessions/child-session/turns",
			wantBody:   map[string]interface{}{"message": "please adjust the tests\n"},
		},
		{
			name:       "interrupt",
			args:       []string{"interrupt", "child-session", "--json"},
			method:     http.MethodPost,
			requestURI: "/api/runner/sessions/child-session/interrupt",
		},
		{
			name:       "merge",
			args:       []string{"merge", "child-session", "--target-branch", "feature/target", "--json"},
			method:     http.MethodPost,
			requestURI: "/api/runner/sessions/child-session/merge",
			wantBody:   map[string]interface{}{"targetBranch": "feature/target"},
		},
		{
			name:       "end",
			args:       []string{"end", "child-session", "--json"},
			method:     http.MethodPost,
			requestURI: "/api/runner/sessions/child-session/end",
		},
		{
			name:       "complete",
			args:       []string{"complete", "child-session", "--json"},
			method:     http.MethodPost,
			requestURI: "/api/runner/sessions/child-session/complete-session",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			requestCount := 0
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requestCount++
				if r.Method != tc.method || r.RequestURI != tc.requestURI {
					t.Errorf("request = %s %s, want %s %s", r.Method, r.RequestURI, tc.method, tc.requestURI)
				}
				if got := r.Header.Get("Authorization"); got != "Bearer runner-secret" {
					t.Errorf("authorization = %q", got)
				}
				if got := r.Header.Get("X-Orbit-Session-Id"); got != "parent-session" {
					t.Errorf("X-Orbit-Session-Id = %q, want parent-session", got)
				}
				if got := r.Header.Get("X-Orbit-Session-Token"); got != "session-token" {
					t.Errorf("X-Orbit-Session-Token = %q, want session-token", got)
				}
				if got := r.Header.Get("X-Orbit-Agent-Id"); got != "" {
					t.Errorf("unexpected X-Orbit-Agent-Id = %q", got)
				}
				bodyBytes, err := io.ReadAll(r.Body)
				if err != nil {
					t.Errorf("read request body: %v", err)
				}
				if tc.wantBody == nil {
					if len(bodyBytes) != 0 {
						t.Errorf("request body = %s, want empty", bodyBytes)
					}
				} else {
					var gotBody map[string]interface{}
					if err := json.Unmarshal(bodyBytes, &gotBody); err != nil {
						t.Errorf("decode request body %q: %v", bodyBytes, err)
					} else if !reflect.DeepEqual(gotBody, tc.wantBody) {
						t.Errorf("request body = %#v, want %#v", gotBody, tc.wantBody)
					}
				}
				w.Header().Set("content-type", "application/json")
				_, _ = w.Write([]byte(`{ "operation": "` + tc.name + `", "ok": true }`))
			}))
			defer srv.Close()

			configureCLITestRunner(t, srv.URL)
			t.Setenv(envMCPOrchestration, "true")
			t.Setenv("ORBIT_SESSION_ID", "parent-session")
			t.Setenv(envOrchestrationToken, "session-token")
			t.Setenv("ORBIT_AGENT_ID", "current-agent")

			var out bytes.Buffer
			if err := cmdSessionCLI(tc.args, strings.NewReader(tc.stdin), &out); err != nil {
				t.Fatal(err)
			}
			if requestCount != 1 {
				t.Fatalf("request count = %d, want 1", requestCount)
			}
			wantOutput := `{"operation":"` + tc.name + `","ok":true}` + "\n"
			if out.String() != wantOutput {
				t.Errorf("--json output = %q, want %q", out.String(), wantOutput)
			}
		})
	}
}

func TestSessionCLICreateUsesMCPAgentRoutingDefaults(t *testing.T) {
	tests := []struct {
		name     string
		args     []string
		wantBody map[string]interface{}
	}{
		{
			name:     "current agent by default",
			args:     []string{"create", "--prompt", "do work", "--json"},
			wantBody: map[string]interface{}{"prompt": "do work", "agentId": "current-agent"},
		},
		{
			name:     "agent by name",
			args:     []string{"create", "--prompt", "do work", "--agent-name", "reviewer", "--json"},
			wantBody: map[string]interface{}{"prompt": "do work", "agentName": "reviewer"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var gotBody map[string]interface{}
			var gotCaller, gotCredential string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotCaller = r.Header.Get("X-Orbit-Session-Id")
				gotCredential = r.Header.Get("X-Orbit-Session-Token")
				_ = json.NewDecoder(r.Body).Decode(&gotBody)
				_, _ = w.Write([]byte(`{"id":"child"}`))
			}))
			defer srv.Close()
			configureCLITestRunner(t, srv.URL)
			t.Setenv(envMCPOrchestration, "1")
			t.Setenv("ORBIT_SESSION_ID", "current-session")
			t.Setenv(envOrchestrationToken, "session-token")
			t.Setenv("ORBIT_AGENT_ID", "current-agent")

			var out bytes.Buffer
			if err := cmdSessionCLI(tc.args, strings.NewReader(""), &out); err != nil {
				t.Fatal(err)
			}
			if gotCaller != "current-session" {
				t.Errorf("caller session header = %q", gotCaller)
			}
			if gotCredential != "session-token" {
				t.Errorf("caller session token header = %q", gotCredential)
			}
			if !reflect.DeepEqual(gotBody, tc.wantBody) {
				t.Errorf("body = %#v, want %#v", gotBody, tc.wantBody)
			}
		})
	}
}

func TestSessionCLICreateWaitPollsWithCallerContext(t *testing.T) {
	requestCount := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		if got := r.Header.Get("X-Orbit-Session-Id"); got != "caller-session" {
			t.Errorf("request %d caller header = %q", requestCount, got)
		}
		if got := r.Header.Get("X-Orbit-Session-Token"); got != "session-token" {
			t.Errorf("request %d caller token header = %q", requestCount, got)
		}
		w.Header().Set("content-type", "application/json")
		switch requestCount {
		case 1:
			if r.Method != http.MethodPost || r.URL.Path != "/api/runner/sessions" {
				t.Errorf("create request = %s %s", r.Method, r.URL.Path)
			}
			_, _ = w.Write([]byte(`{"id":"child-session","status":"PENDING"}`))
		case 2:
			if r.Method != http.MethodGet || r.URL.Path != "/api/runner/sessions/child-session" {
				t.Errorf("poll request = %s %s", r.Method, r.URL.Path)
			}
			_, _ = w.Write([]byte(`{"id":"child-session","status":"SUCCEEDED","result":"done"}`))
		default:
			t.Errorf("unexpected request %d: %s %s", requestCount, r.Method, r.URL.Path)
			_, _ = w.Write([]byte(`{"id":"child-session","status":"SUCCEEDED"}`))
		}
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)
	t.Setenv(envMCPOrchestration, "true")
	t.Setenv("ORBIT_SESSION_ID", "caller-session")
	t.Setenv(envOrchestrationToken, "session-token")
	t.Setenv("ORBIT_AGENT_ID", "")

	var out bytes.Buffer
	if err := cmdSessionCLI([]string{"create", "--prompt", "work", "--wait", "--json"}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	if requestCount != 2 {
		t.Fatalf("request count = %d, want create plus one poll", requestCount)
	}
	if got, want := out.String(), "{\"id\":\"child-session\",\"status\":\"SUCCEEDED\",\"result\":\"done\"}\n"; got != want {
		t.Errorf("wait output = %q, want %q", got, want)
	}
}

func TestSessionCLIPropagatesForbiddenWithoutDroppingContextOrRetrying(t *testing.T) {
	requestCount := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		if r.Method != http.MethodGet || r.URL.Path != "/api/runner/sessions/child-session" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("X-Orbit-Session-Id"); got != "caller-session" {
			t.Errorf("caller header = %q", got)
		}
		if got := r.Header.Get("X-Orbit-Session-Token"); got != "session-token" {
			t.Errorf("caller token header = %q", got)
		}
		http.Error(w, "orchestration disabled", http.StatusForbidden)
	}))
	defer srv.Close()

	configureCLITestRunner(t, srv.URL)
	t.Setenv(envMCPOrchestration, "true")
	t.Setenv("ORBIT_SESSION_ID", "caller-session")
	t.Setenv(envOrchestrationToken, "session-token")

	var out bytes.Buffer
	err := cmdSessionCLI([]string{"get", "child-session", "--json"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "403") {
		t.Fatalf("forbidden error = %v", err)
	}
	if requestCount != 1 {
		t.Fatalf("request count = %d, want no retry or fallback", requestCount)
	}
	if out.Len() != 0 {
		t.Fatalf("forbidden command output = %q", out.String())
	}
}

func TestSessionCLIRequiresOrchestrationAndExplicitContext(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv(envMCPOrchestration, "")
	disabledCommands := [][]string{
		{"create", "--prompt", "work", "--json"},
		{"list", "--json"},
		{"search", "--query", "work", "--json"},
		{"get", "child", "--json"},
		{"send", "child", "--message", "work", "--json"},
		{"interrupt", "child", "--json"},
		{"merge", "child", "--json"},
		{"end", "child", "--json"},
		{"complete", "child", "--json"},
	}
	for _, args := range disabledCommands {
		var out bytes.Buffer
		if err := cmdSessionCLI(args, strings.NewReader(""), &out); err == nil || !strings.Contains(err.Error(), "orchestration") {
			t.Errorf("session %s with orchestration disabled error = %v", args[0], err)
		}
	}

	t.Setenv(envMCPOrchestration, "true")
	t.Setenv("ORBIT_SESSION_ID", "")
	for _, args := range disabledCommands {
		var out bytes.Buffer
		if err := cmdSessionCLI(args, strings.NewReader(""), &out); err == nil || !strings.Contains(err.Error(), "ORBIT_SESSION_ID") {
			t.Errorf("session %s without caller context error = %v", args[0], err)
		}
	}

	// A target operation never falls back to the caller's own session. Requiring an
	// explicit id avoids accidentally interrupting, merging, ending, or completing the caller.
	t.Setenv("ORBIT_SESSION_ID", "current-session")
	t.Setenv(envOrchestrationToken, "session-token")
	for _, action := range []string{"get", "send", "interrupt", "merge", "end", "complete"} {
		args := []string{action, "--json"}
		if action == "send" {
			args = append(args, "--message", "hello")
		}
		var out bytes.Buffer
		err := cmdSessionCLI(args, strings.NewReader(""), &out)
		if err == nil || !strings.Contains(err.Error(), "session id is required") {
			t.Errorf("session %s without target error = %v", action, err)
		}
	}
}

func TestSessionCLIValidatesArgumentsAndRejectsArbitraryFiles(t *testing.T) {
	t.Setenv(envMCPOrchestration, "true")
	t.Setenv("ORBIT_SESSION_ID", "current-session")
	t.Setenv(envOrchestrationToken, "session-token")

	tests := []struct {
		name      string
		args      []string
		wantError string
	}{
		{name: "missing prompt", args: []string{"create"}, wantError: "--prompt or --prompt-file - is required"},
		{name: "two agent selectors", args: []string{"create", "--prompt", "x", "--agent-id", "a", "--agent-name", "b"}, wantError: "cannot be used together"},
		{name: "prompt path", args: []string{"create", "--prompt-file", "/etc/passwd"}, wantError: "accepts only '-' (stdin)"},
		{name: "missing search query", args: []string{"search"}, wantError: "--query is required"},
		{name: "invalid status", args: []string{"list", "--status", "UNKNOWN"}, wantError: "status must be one of"},
		{name: "missing message", args: []string{"send", "child"}, wantError: "--message or --message-file - is required"},
		{name: "message path", args: []string{"send", "child", "--message-file", "/etc/passwd"}, wantError: "accepts only '-' (stdin)"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var out bytes.Buffer
			err := cmdSessionCLI(tc.args, strings.NewReader(""), &out)
			if err == nil || !strings.Contains(err.Error(), tc.wantError) {
				t.Fatalf("error = %v, want containing %q", err, tc.wantError)
			}
		})
	}
}

func TestSessionCLIPathIDsCannotEscapeSessionRoute(t *testing.T) {
	t.Setenv(envMCPOrchestration, "true")
	t.Setenv("ORBIT_SESSION_ID", "current-session")
	t.Setenv(envOrchestrationToken, "session-token")

	for _, action := range []string{"get", "send", "interrupt", "merge", "end", "complete"} {
		for _, id := range []string{"../tasks", "..%2Ftasks", "a/b", `a\b`, "a?query"} {
			args := []string{action, id, "--json"}
			if action == "send" {
				args = append(args, "--message", "hello")
			}
			var out bytes.Buffer
			err := cmdSessionCLI(args, strings.NewReader(""), &out)
			if err == nil || !strings.Contains(err.Error(), "single safe path segment") {
				t.Errorf("session %s %q error = %v", action, id, err)
			}
		}
	}
}

func sessionCLICapabilityByID(capabilities []cliCapability, id string) *cliCapability {
	for i := range capabilities {
		if capabilities[i].ID == id {
			return &capabilities[i]
		}
	}
	return nil
}

func sessionCLIFirstSessionCapability(capabilities []cliCapability) *cliCapability {
	for i := range capabilities {
		if strings.HasPrefix(capabilities[i].ID, "session_") {
			return &capabilities[i]
		}
	}
	return nil
}

func sessionCLIContains(values []string, needle string) bool {
	for _, value := range values {
		if strings.Contains(value, needle) {
			return true
		}
	}
	return false
}
