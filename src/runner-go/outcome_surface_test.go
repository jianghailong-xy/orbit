package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func outcomeSurfaceFixtureJSON(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile("../../contracts/outcome-reconciler-v2.surfaces.fixture.json")
	if err != nil {
		t.Fatalf("read shared outcome fixture: %v", err)
	}
	var fixture map[string]interface{}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("decode shared outcome fixture: %v", err)
	}
	projection, ok := fixture["projection"].(map[string]interface{})
	if !ok {
		t.Fatal("shared outcome fixture has no projection")
	}
	var agent map[string]interface{}
	for _, rawObligation := range projection["obligations"].([]interface{}) {
		obligation := rawObligation.(map[string]interface{})
		if obligation["owner"] == "AGENT" {
			agent = obligation
			break
		}
	}
	if agent == nil {
		t.Fatal("shared outcome fixture has no AGENT obligation")
	}
	payload := map[string]interface{}{
		"schemaVersion":     fixture["schemaVersion"],
		"surface":           "AGENT_QUEUE",
		"actor":             "AGENT",
		"staleness":         projection["staleness"],
		"canonicalIdentity": projection["canonicalIdentity"],
		"doneGate":          projection["doneGate"],
		"obligations":       projection["obligations"],
		"items": []interface{}{map[string]interface{}{
			"semantic": agent,
			"cta":      map[string]interface{}{"kind": "EXECUTE"},
		}},
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("encode shared outcome fixture: %v", err)
	}
	return string(encoded)
}

func TestProjectObligationsCLIPreservesTheServerContract(t *testing.T) {
	fixtureJSON := outcomeSurfaceFixtureJSON(t)
	var method, path, surface string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, path, surface = r.Method, r.URL.Path, r.URL.Query().Get("surface")
		_, _ = w.Write([]byte(fixtureJSON))
	}))
	defer srv.Close()
	configureCLITestRunner(t, srv.URL)
	var out bytes.Buffer
	if err := cmdProjectCLI([]string{"obligations", "proj-1", "--json"}, strings.NewReader(""), &out); err != nil {
		t.Fatalf("project obligations: %v", err)
	}
	if method != http.MethodGet || path != "/api/runner/projects/proj-1/outcome" || surface != "AGENT_QUEUE" {
		t.Fatalf("project obligations hit %s %s?surface=%s", method, path, surface)
	}
	if out.String() != fixtureJSON+"\n" {
		t.Fatalf("CLI changed the API semantic contract:\n%s", out.String())
	}
}

func TestProjectObligationsMCPPreservesTheServerContract(t *testing.T) {
	fixtureJSON := outcomeSurfaceFixtureJSON(t)
	var surface string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		surface = r.URL.Query().Get("surface")
		_, _ = w.Write([]byte(fixtureJSON))
	}))
	defer srv.Close()
	mcp := &mcpServer{t: NewTransport(srv.URL, "tok")}
	result := mcp.callTool("project_obligations", map[string]interface{}{
		"projectId": "proj-1", "surface": "WEB",
	})
	if result["isError"] == true || surface != "WEB" {
		t.Fatalf("project_obligations = %#v, surface=%q", result, surface)
	}
	content, _ := result["content"].([]map[string]interface{})
	text, _ := content[0]["text"].(string)
	for _, identity := range []string{
		"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
		"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
		"\"evaluatedThroughLogicalTime\": \"42\"",
		"\"bindingDigest\": \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"",
	} {
		if !strings.Contains(text, identity) {
			t.Fatalf("MCP lost semantic identity %q: %s", identity, text)
		}
	}
}

func TestProjectObligationsRejectsUnknownSurface(t *testing.T) {
	var out bytes.Buffer
	err := cmdProjectCLI([]string{"obligations", "proj-1", "--surface", "EMPTY_IF_STALE"}, strings.NewReader(""), &out)
	if err == nil || !strings.Contains(err.Error(), "--surface must be one of") {
		t.Fatalf("unknown surface = %v", err)
	}
}
