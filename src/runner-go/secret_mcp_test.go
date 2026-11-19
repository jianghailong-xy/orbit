//go:build linux || darwin

package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRequestOwnerActionChecksTheSecretDestinationBeforeFiling(t *testing.T) {
	home := secretTestHome(t)
	_ = os.WriteFile(filepath.Join(home, ".bashrc"), []byte("x"), 0o600)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("a refused destination reached the server: %s", r.URL.Path)
	}))
	defer srv.Close()
	mcp := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "343dlzsYWKo5z8l2M8tsB"}
	for spec, says := range map[string]string{
		`{"name":"k","envVar":"PATH"}`:             "reserved",
		`{"name":"k","envVar":"lower"}`:            "must match",
		`{"name":"k","filePath":"~/.bashrc"}`:      "already exists",
		`{"name":"k","filePath":"~/.claude/key"}`:  "configuration directory",
		`{"name":"k","filePath":"relative/key"}`:   "absolute",
		`{"name":"k","filePath":"~/.orbit/x/key"}`: "Orbit's own directory",
	} {
		var secretSpec map[string]interface{}
		_ = json.Unmarshal([]byte(spec), &secretSpec)
		res := mcp.callTool("request_owner_action", map[string]interface{}{
			"kind": "SECRET", "title": "t", "why": "w", "secretSpec": secretSpec,
		})
		content, _ := res["content"].([]map[string]interface{})
		text, _ := content[0]["text"].(string)
		if res["isError"] != true || !strings.Contains(text, says) {
			t.Errorf("%s: %v %q", spec, res["isError"], text)
		}
	}
	props := mcpToolProps(toolDescriptors(false, false), "request_owner_action")
	spec, _ := props["secretSpec"].(map[string]interface{})
	inner, _ := spec["properties"].(map[string]interface{})
	if _, has := inner["runnerId"]; has {
		t.Fatal("secretSpec still offers runnerId")
	}
	if !strings.Contains(sprintAll(inner["envVar"]), "orbit secret exec NAME --") {
		t.Fatal("envVar does not say how the secret is used")
	}
}

func TestWithdrawOwnerRequestPostsAsTheSession(t *testing.T) {
	var path, session string
	var body map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path, session = r.URL.Path, r.Header.Get("X-Orbit-Session-Id")
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = w.Write([]byte(`{"id":"r1","state":"WITHDRAWN"}`))
	}))
	defer srv.Close()
	if !hasMCPTool(toolDescriptors(false, false), "withdraw_owner_request") {
		t.Fatal("withdraw_owner_request is not offered to a plain session")
	}
	mcp := &mcpServer{t: NewTransport(srv.URL, "tok"), sessionID: "343dlzsYWKo5z8l2M8tsB"}
	res := mcp.callTool("withdraw_owner_request", map[string]interface{}{"requestId": "r1", "reason": "done with it"})
	if res["isError"] == true || path != "/api/runner/owner-requests/r1/withdraw" || session != "343dlzsYWKo5z8l2M8tsB" || body["reason"] != "done with it" {
		t.Fatalf("%v %s %s %#v", res, path, session, body)
	}
	if res := mcp.callTool("withdraw_owner_request", map[string]interface{}{}); res["isError"] != true {
		t.Fatal("a call without requestId was sent")
	}
}

func TestRunnerDeclaresOwnerSecretCapability(t *testing.T) {
	if !strings.Contains(","+runnerCapabilitiesV1+",", ","+ownerSecretCapabilityV1+",") {
		t.Fatalf("capabilities = %q", runnerCapabilitiesV1)
	}
}
