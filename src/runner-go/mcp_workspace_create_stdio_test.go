package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"testing"
)

const mcpStdioWorkspaceCreateChild = "ORBIT_TEST_MCP_STDIO_WORKSPACE_CREATE_CHILD"
const mcpStdioWorkspaceCreateServer = "ORBIT_TEST_MCP_STDIO_WORKSPACE_CREATE_SERVER"

// The child half of TestMCPStdioAgentCreateWithRepoURLReturnsCloningWorkspace. In the ordinary
// suite this is a no-op; the parent re-execs the test binary with the marker set and this process
// then speaks MCP on its actual stdin/stdout, exactly as `orbit mcp` does.
func TestMCPStdioWorkspaceCreateServerProcess(t *testing.T) {
	if os.Getenv(mcpStdioWorkspaceCreateChild) != "1" {
		return
	}
	mcp := &mcpServer{
		t:                  NewTransport(os.Getenv(mcpStdioWorkspaceCreateServer), "runner-token"),
		sessionID:          "caller-session",
		orchestrationToken: "session-token",
		allowOrchestration: true,
	}
	mcp.serve(os.Stdin, os.Stdout)
}

// This deliberately enters through the MCP wire, not callTool: JSON-RPC is written through real
// process stdin/stdout, then the tool's HTTP request and provisioning receipt are checked at the
// other end. A schema-only test would stay green if the dispatcher silently dropped repoUrl,
// which is the drift this task exists to stop.
func TestMCPStdioAgentCreateWithRepoURLReturnsCloningWorkspace(t *testing.T) {
	const repoURL = "https://github.com/acme/widget.git"
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/runner/agents" {
			t.Errorf("agent_create hit %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("X-Orbit-Session-Id"); got != "caller-session" {
			t.Errorf("X-Orbit-Session-Id = %q", got)
		}
		if got := r.Header.Get("X-Orbit-Session-Token"); got != "session-token" {
			t.Errorf("X-Orbit-Session-Token = %q", got)
		}
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode create body: %v", err)
		}
		if body["name"] != "widget" || body["repoUrl"] != repoURL {
			t.Errorf("agent_create body = %#v", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"workspace-1","name":"widget","repoUrl":"` + repoURL + `","workDir":null,"provisionState":"CLONING","provisionError":null}`))
	}))
	defer api.Close()

	cmd := exec.Command(os.Args[0], "-test.run=^TestMCPStdioWorkspaceCreateServerProcess$")
	cmd.Env = replaceEnv(os.Environ(), map[string]string{
		mcpStdioWorkspaceCreateChild:  "1",
		mcpStdioWorkspaceCreateServer: api.URL,
		"ORBIT_HOME":                  t.TempDir(),
	})
	clientToServerW, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	serverToClientR, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var childStderr bytes.Buffer
	cmd.Stderr = &childStderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	waited := false
	t.Cleanup(func() {
		_ = clientToServerW.Close()
		if !waited {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
	})

	enc := json.NewEncoder(clientToServerW)
	dec := json.NewDecoder(serverToClientR)
	type wireResponse struct {
		ID     int             `json:"id"`
		Result json.RawMessage `json:"result"`
		Error  *rpcError       `json:"error"`
	}
	roundTrip := func(request map[string]interface{}) wireResponse {
		t.Helper()
		if err := enc.Encode(request); err != nil {
			t.Fatalf("write MCP request: %v", err)
		}
		var response wireResponse
		if err := dec.Decode(&response); err != nil {
			t.Fatalf("read MCP response: %v", err)
		}
		if response.Error != nil {
			t.Fatalf("MCP protocol error: %+v", response.Error)
		}
		return response
	}

	initialized := roundTrip(map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "initialize",
		"params":  map[string]interface{}{"protocolVersion": "2024-11-05"},
	})
	if initialized.ID != 1 {
		t.Fatalf("initialize response id = %d", initialized.ID)
	}
	if err := enc.Encode(map[string]interface{}{
		"jsonrpc": "2.0",
		"method":  "notifications/initialized",
	}); err != nil {
		t.Fatal(err)
	}

	response := roundTrip(map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      2,
		"method":  "tools/call",
		"params": map[string]interface{}{
			"name": "agent_create",
			"arguments": map[string]interface{}{
				"name":    "widget",
				"repoUrl": repoURL,
			},
		},
	})
	var result struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		IsError bool `json:"isError"`
	}
	if err := json.Unmarshal(response.Result, &result); err != nil {
		t.Fatalf("decode tools/call result: %v", err)
	}
	if result.IsError || len(result.Content) != 1 {
		t.Fatalf("agent_create result = %#v", result)
	}
	var workspace map[string]interface{}
	if err := json.Unmarshal([]byte(result.Content[0].Text), &workspace); err != nil {
		t.Fatalf("decode workspace receipt %q: %v", result.Content[0].Text, err)
	}
	if workspace["repoUrl"] != repoURL || workspace["provisionState"] != "CLONING" {
		t.Fatalf("workspace receipt = %#v", workspace)
	}
	if provisionError, present := workspace["provisionError"]; !present || provisionError != nil {
		t.Fatalf("workspace provisionError = %#v (present %v)", provisionError, present)
	}

	_ = clientToServerW.Close()
	err = cmd.Wait()
	waited = true
	if err != nil {
		t.Fatalf("MCP stdio child: %v\n%s", err, childStderr.String())
	}
}
