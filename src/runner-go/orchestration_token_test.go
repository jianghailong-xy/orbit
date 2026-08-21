package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSessionWireDTOsCarryOrchestrationToken(t *testing.T) {
	var claimed ClaimedSession
	if err := json.Unmarshal([]byte(`{"sessionId":"claimed","orchestrationToken":"claim-token"}`), &claimed); err != nil {
		t.Fatal(err)
	}
	if claimed.OrchestrationToken != "claim-token" {
		t.Fatalf("claimed orchestration token = %q", claimed.OrchestrationToken)
	}

	var reclaimed ReclaimResponse
	if err := json.Unmarshal([]byte(`{"sessions":[{"sessionId":"reclaimed","orchestrationToken":"reclaim-token"}]}`), &reclaimed); err != nil {
		t.Fatal(err)
	}
	if len(reclaimed.Sessions) != 1 || reclaimed.Sessions[0].OrchestrationToken != "reclaim-token" {
		t.Fatalf("reclaimed sessions = %#v", reclaimed.Sessions)
	}
}

func TestOrchestrationTransportMethodsSendSessionCredential(t *testing.T) {
	tests := []struct {
		name   string
		method string
		path   string
		call   func(*Transport) error
	}{
		{
			name:   "session create",
			method: http.MethodPost,
			path:   "/api/runner/sessions",
			call: func(transport *Transport) error {
				_, err := transport.createSession("caller-session", "session-token", map[string]string{"prompt": "work"})
				return err
			},
		},
		{
			name:   "session list",
			method: http.MethodGet,
			path:   "/api/runner/sessions?status=RUNNING",
			call: func(transport *Transport) error {
				_, err := transport.listSessions("caller-session", "session-token", "?status=RUNNING")
				return err
			},
		},
		{
			name:   "session search",
			method: http.MethodGet,
			path:   "/api/runner/sessions/search?q=work",
			call: func(transport *Transport) error {
				_, err := transport.searchSessions("caller-session", "session-token", "?q=work")
				return err
			},
		},
		{
			name:   "session get",
			method: http.MethodGet,
			path:   "/api/runner/sessions/child-session",
			call: func(transport *Transport) error {
				_, err := transport.getSession("caller-session", "session-token", "child-session")
				return err
			},
		},
		{
			name:   "session send",
			method: http.MethodPost,
			path:   "/api/runner/sessions/child-session/turns",
			call: func(transport *Transport) error {
				_, err := transport.sendSessionMessage("caller-session", "session-token", "child-session", map[string]string{"message": "more"})
				return err
			},
		},
		{
			name:   "session interrupt",
			method: http.MethodPost,
			path:   "/api/runner/sessions/child-session/interrupt",
			call: func(transport *Transport) error {
				_, err := transport.interruptSession("caller-session", "session-token", "child-session", nil)
				return err
			},
		},
		{
			name:   "session merge",
			method: http.MethodPost,
			path:   "/api/runner/sessions/child-session/merge",
			call: func(transport *Transport) error {
				_, err := transport.mergeSession("caller-session", "session-token", "child-session", map[string]string{"targetBranch": "main"})
				return err
			},
		},
		{
			name:   "session end",
			method: http.MethodPost,
			path:   "/api/runner/sessions/child-session/end",
			call: func(transport *Transport) error {
				_, err := transport.endSession("caller-session", "session-token", "child-session")
				return err
			},
		},
		{
			name:   "session complete",
			method: http.MethodPost,
			path:   "/api/runner/sessions/child-session/complete-session",
			call: func(transport *Transport) error {
				_, err := transport.completeSession("caller-session", "session-token", "child-session")
				return err
			},
		},
		{
			name:   "agent list",
			method: http.MethodGet,
			path:   "/api/runner/agents",
			call: func(transport *Transport) error {
				_, err := transport.listAgents("caller-session", "session-token")
				return err
			},
		},
		{
			name:   "agent create",
			method: http.MethodPost,
			path:   "/api/runner/agents",
			call: func(transport *Transport) error {
				_, err := transport.createAgent("caller-session", "session-token", map[string]string{"name": "reviewer"})
				return err
			},
		},
		{
			name:   "agent update",
			method: http.MethodPatch,
			path:   "/api/runner/agents/agent-2",
			call: func(transport *Transport) error {
				_, err := transport.updateAgent("caller-session", "session-token", "agent-2", map[string]string{"name": "reviewer"})
				return err
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			requestCount := 0
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requestCount++
				if r.Method != tc.method || r.RequestURI != tc.path {
					t.Errorf("request = %s %s, want %s %s", r.Method, r.RequestURI, tc.method, tc.path)
				}
				if got := r.Header.Get("X-Orbit-Session-Id"); got != "caller-session" {
					t.Errorf("X-Orbit-Session-Id = %q, want caller-session", got)
				}
				if got := r.Header.Get("X-Orbit-Session-Token"); got != "session-token" {
					t.Errorf("X-Orbit-Session-Token = %q, want session-token", got)
				}
				w.Header().Set("content-type", "application/json")
				_, _ = w.Write([]byte(`{}`))
			}))
			defer srv.Close()

			if err := tc.call(NewTransport(srv.URL, "runner-token")); err != nil {
				t.Fatal(err)
			}
			if requestCount != 1 {
				t.Fatalf("request count = %d, want 1", requestCount)
			}
		})
	}
}

func TestOrchestrationTransportRejectsCrossOriginRedirectWithoutLeakingCredential(t *testing.T) {
	destinationRequests := 0
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		destinationRequests++
		if got := r.Header.Get("X-Orbit-Session-Token"); got != "" {
			t.Errorf("redirect leaked X-Orbit-Session-Token = %q", got)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer destination.Close()

	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL+"/stolen", http.StatusTemporaryRedirect)
	}))
	defer origin.Close()

	_, err := NewTransport(origin.URL, "runner-token").listSessions(
		"caller-session",
		"session-token",
		"",
	)
	if err == nil || !strings.Contains(err.Error(), "refusing cross-origin redirect") {
		t.Fatalf("cross-origin redirect error = %v", err)
	}
	if destinationRequests != 0 {
		t.Fatalf("cross-origin destination received %d requests, want 0", destinationRequests)
	}
}

func TestTransportKeepsCrossOriginRedirectsForCallsWithoutSessionCredential(t *testing.T) {
	destinationRequests := 0
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		destinationRequests++
		w.WriteHeader(http.StatusNoContent)
	}))
	defer destination.Close()

	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL+"/canonical", http.StatusTemporaryRedirect)
	}))
	defer origin.Close()

	transport := NewTransport(origin.URL, "runner-token")
	if err := transport.do(nil, http.MethodGet, "/plain", nil, nil, time.Second); err != nil {
		t.Fatalf("non-orchestration redirect: %v", err)
	}
	if destinationRequests != 1 {
		t.Fatalf("cross-origin destination received %d requests, want 1", destinationRequests)
	}
}

func TestSessionCLIGateAllowsLazyCredentialAndDoesNotExposeIt(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv(envMCPOrchestration, "true")
	t.Setenv("ORBIT_SESSION_ID", "caller-session")
	t.Setenv(envOrchestrationToken, "")

	withoutToken := buildCLICapabilities("/opt/orbit")
	if capability := sessionCLICapabilityByID(withoutToken.Capabilities, "session_list"); capability == nil {
		t.Fatal("session_list capability missing before lazy credential acquisition")
	}

	requestCount := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		if got := r.Header.Get("X-Orbit-Session-Id"); got != "caller-session" {
			t.Errorf("X-Orbit-Session-Id = %q", got)
		}
		if got := r.Header.Get("X-Orbit-Session-Token"); got != "session-token" {
			t.Errorf("X-Orbit-Session-Token = %q", got)
		}
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)
	t.Setenv(envOrchestrationToken, "session-token")

	withToken := buildCLICapabilities("/opt/orbit")
	if capability := sessionCLICapabilityByID(withToken.Capabilities, "session_list"); capability == nil {
		t.Fatal("session_list capability missing with allow flag, session id, and token")
	}
	encodedCapabilities, err := json.Marshal(withToken)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encodedCapabilities, []byte("session-token")) {
		t.Fatalf("capabilities leaked the orchestration token: %s", encodedCapabilities)
	}

	var out bytes.Buffer
	if err := cmdSessionCLI([]string{"list", "--json"}, strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	if requestCount != 1 {
		t.Fatalf("request count = %d, want 1", requestCount)
	}
}

func TestMCPOrchestrationAllowsLazyCredential(t *testing.T) {
	requestCount := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		_, _ = w.Write([]byte(`[]`))
	}))
	defer srv.Close()

	mcp := &mcpServer{
		t:                  NewTransport(srv.URL, "runner-token"),
		sessionID:          "caller-session",
		allowOrchestration: true,
	}
	for _, tool := range []string{"session_list", "agent_list"} {
		result := mcp.callTool(tool, map[string]interface{}{})
		if result["isError"] == true {
			t.Errorf("%s without startup orchestration token isError = %#v", tool, result["isError"])
		}
	}
	response, respond := mcp.handle(&rpcRequest{ID: json.RawMessage(`1`), Method: "tools/list"})
	if !respond {
		t.Fatal("tools/list did not return a response")
	}
	result, ok := response.Result.(map[string]interface{})
	if !ok {
		t.Fatalf("tools/list result = %#v", response.Result)
	}
	tools, ok := result["tools"].([]map[string]interface{})
	if !ok {
		t.Fatalf("tools/list tools = %#v", result["tools"])
	}
	foundSessionTool := false
	for _, tool := range tools {
		name, _ := tool["name"].(string)
		if name == "session_list" {
			foundSessionTool = true
		}
	}
	if !foundSessionTool {
		t.Fatal("tools/list omitted session tools before lazy credential acquisition")
	}
	if requestCount != 2 {
		t.Fatalf("requests without startup orchestration token = %d, want 2", requestCount)
	}
}

func TestCodexDoesNotForwardOrchestrationTokenToOrbitMCP(t *testing.T) {
	if strings.Contains(codexOrbitMCPEnvVarsConfig, `"ORBIT_ORCHESTRATION_TOKEN"`) {
		t.Fatalf("Codex Orbit MCP env forwarding exposes orchestration token: %s", codexOrbitMCPEnvVarsConfig)
	}
}

func TestProviderProcessesDoNotReceiveSessionOrchestrationToken(t *testing.T) {
	const wantToken = "signed-session-token"

	newJobAndFakeProvider := func(t *testing.T, executable string) (*ClaimedSession, string, string) {
		t.Helper()
		root := t.TempDir()
		binDir := filepath.Join(root, "bin")
		if err := os.MkdirAll(binDir, 0o755); err != nil {
			t.Fatal(err)
		}
		capture := filepath.Join(root, "captured-token")
		script := "#!/bin/sh\nprintf '%s' \"$ORBIT_ORCHESTRATION_TOKEN\" > \"$ORBIT_TEST_CAPTURE_FILE\"\n"
		if err := os.WriteFile(filepath.Join(binDir, executable), []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
		t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
		t.Setenv("ORBIT_HOME", filepath.Join(root, "orbit-home"))
		return &ClaimedSession{
			SessionID:          "caller-session",
			SessionUUID:        "runtime-session",
			AllowOrchestration: true,
			OrchestrationToken: wantToken,
			Agent: AgentExecConfig{
				Model:          "model",
				PermissionMode: "dontAsk",
				Env: map[string]string{
					"ORBIT_TEST_CAPTURE_FILE": capture,
					// Agent config must not re-introduce this reserved credential.
					envOrchestrationToken: "agent-controlled-value",
				},
			},
		}, capture, root
	}

	assertCaptured := func(t *testing.T, capture string) {
		t.Helper()
		deadline := time.Now().Add(2 * time.Second)
		for {
			got, err := os.ReadFile(capture)
			if err == nil {
				if string(got) != "" {
					t.Fatalf("provider received an orchestration token snapshot")
				}
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("provider did not capture orchestration token: %v", err)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}

	emit := func(string, map[string]interface{}) {}
	t.Run("claude", func(t *testing.T) {
		job, capture, root := newJobAndFakeProvider(t, "claude")
		api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{}`))
		}))
		defer api.Close()

		runClaudeSessionProcess(
			context.Background(), context.Background(), NewTransport(api.URL, "runner-token"),
			job, "11111111-1111-4111-8111-111111111111", root, root, emit,
			func(string, string, map[string]interface{}) {}, func(string) {}, true, nil,
			func(TurnCompleteRequest, ...context.Context) error { return nil }, func(context.Context) bool { return true }, func(error) {},
		)
		assertCaptured(t, capture)
	})

	t.Run("codex exec", func(t *testing.T) {
		job, capture, root := newJobAndFakeProvider(t, "codex")
		runCodexTurn(context.Background(), job, root, "work", nil, emit)
		assertCaptured(t, capture)
	})

	t.Run("codex app server", func(t *testing.T) {
		job, capture, root := newJobAndFakeProvider(t, "codex")
		// nil approval bridge: this asserts process environment, and nil is the fail-closed
		// default (every approval request is declined) rather than a missing dependency.
		app, err := startCodexAppServer(context.Background(), job, root, root, envWithAgent(job.Agent.Env), emit, nil)
		if err != nil {
			t.Fatal(err)
		}
		assertCaptured(t, capture)
		app.cancel()
		_ = app.cmd.Wait()
	})
}
