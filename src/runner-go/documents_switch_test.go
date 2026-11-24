package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// The Documents switch (documents_switch.go): a session spawned with ORBIT_DOCUMENTS=off has no drive tools at
// all, the way ORBIT_WIKI=off leaves out the wiki tools.
func TestDocumentsOffLeavesOutTheDriveTools(t *testing.T) {
	t.Setenv(envDocuments, "off")
	if documentsEnabledFromEnv() {
		t.Fatal("ORBIT_DOCUMENTS=off reads as on")
	}
	stripped := withoutDriveTools(toolDescriptors(false, true))
	for name := range driveToolNames {
		if hasMCPTool(toolDescriptors(false, true), name) == false {
			t.Fatalf("%s is not in the full list, so the test proves nothing", name)
		}
		if hasMCPTool(stripped, name) {
			t.Errorf("%s is still offered with Drive off", name)
		}
	}
	for _, kept := range []string{"task_list", "file_upload", "wiki_search"} {
		if !hasMCPTool(stripped, kept) {
			t.Errorf("turning Drive off dropped %s along with it", kept)
		}
	}
	srv := &mcpServer{documentsOff: true}
	if hasMCPTool(srv.listedToolDescriptors(), "documents_put") {
		t.Error("tools/list offers documents_put with Drive off")
	}
	on := &mcpServer{}
	if !hasMCPTool(on.listedToolDescriptors(), "documents_put") {
		t.Error("tools/list leaves out documents_put with Drive on")
	}

	// The CLI half: not offered, and the commands themselves refuse.
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv("ORBIT_SESSION_ID", "caller-session")
	if ids := capabilityIDs(buildCLICapabilities("/usr/local/bin/orbit")); contains(ids, "documents_put") {
		t.Errorf("capabilities offer documents_put with Drive off: %v", ids)
	}
	err := cmdDocumentsCLI([]string{"ls"}, &strings.Builder{})
	if err == nil || !strings.Contains(err.Error(), "ORBIT_DOCUMENTS_ENABLED") {
		t.Errorf("orbit drive ls with Drive off = %v, want the refusal that names ORBIT_DOCUMENTS_ENABLED", err)
	}
	t.Setenv(envDocuments, "on")
	if ids := capabilityIDs(buildCLICapabilities("/usr/local/bin/orbit")); !contains(ids, "documents_put") {
		t.Errorf("capabilities with Drive on do not offer documents_put: %v", ids)
	}
}

func TestDocumentsOffRefusesADriveCallWithoutTouchingTheServer(t *testing.T) {
	srv, requests := wikiDoor(t, http.StatusOK, `{}`)
	off := wikiMCP(t, srv.URL)
	off.documentsOff = true
	for name := range driveToolNames {
		result := off.callTool(name, map[string]interface{}{"path": "/a.md", "localPath": "a.md", "from": "/a", "to": "/b"})
		text := wikiToolText(t, result)
		if result["isError"] != true || !strings.Contains(text, "Drive is not enabled on this Orbit server (ORBIT_DOCUMENTS_ENABLED)") ||
			!strings.Contains(text, "Nothing was read or written") {
			t.Errorf("%s with Drive off = %s", name, text)
		}
	}
	if len(*requests) != 0 {
		t.Fatalf("a drive call with Drive off reached the server: %#v", *requests)
	}
}

// A server with Documents off answers 404 DOCUMENTS_DISABLED; a runner that did not know reads it as that, not as a
// missing path.
func TestDocumentsDisabledAnswerFromTheServerReadsAsTheSwitch(t *testing.T) {
	err := &transportHTTPError{statusCode: http.StatusNotFound, body: `{"code":"DOCUMENTS_DISABLED","message":"x"}`}
	if !documentsDisabledByServer(err) {
		t.Fatal("404 DOCUMENTS_DISABLED is not read as the switch")
	}
	if documentsDisabledByServer(&transportHTTPError{statusCode: http.StatusNotFound, body: `{"code":"NOT_FOUND"}`}) {
		t.Error("an ordinary 404 reads as the switch")
	}
	got := documentsToolError("documents_list", err)
	if !strings.Contains(got.Error(), "ORBIT_DOCUMENTS_ENABLED") || !strings.Contains(got.Error(), "documents_list") {
		t.Errorf("documentsToolError = %v", got)
	}
}

func TestDocumentsSwitchReachesTheSpawnAndSurvivesReclaim(t *testing.T) {
	var claim ClaimedSession
	if err := json.Unmarshal([]byte(`{"sessionId":"s","documentsDisabled":true}`), &claim); err != nil {
		t.Fatal(err)
	}
	if got := documentsEnv(claim.DocumentsDisabled); got != "off" {
		t.Errorf("claimed with documentsDisabled: %s=%s, want off", envDocuments, got)
	}
	var resp ReclaimResponse
	if err := json.Unmarshal([]byte(`{"sessions":[{"sessionId":"off","documentsDisabled":true},{"sessionId":"on"}]}`), &resp); err != nil {
		t.Fatal(err)
	}
	if got := documentsEnv(claimedSessionFromReclaim(resp.Sessions[0]).DocumentsDisabled); got != "off" {
		t.Errorf("reclaimed with documentsDisabled: %s=%s, want off", envDocuments, got)
	}
	if got := documentsEnv(claimedSessionFromReclaim(resp.Sessions[1]).DocumentsDisabled); got != "on" {
		t.Errorf("reclaimed with no field: %s=%s, want on (a server that predates the switch)", envDocuments, got)
	}
	// The Codex spawn passes it through to `orbit mcp`.
	job := &ClaimedSession{SessionID: "s", DocumentsDisabled: true}
	found := false
	for _, pair := range codexOrbitSessionEnv(job) {
		if pair == envDocuments+"=off" {
			found = true
		}
	}
	if !found {
		t.Errorf("the Codex spawn does not set %s=off: %v", envDocuments, codexOrbitSessionEnv(job))
	}
}

func TestDocumentsOffDropsTheDriveFromTheAgentsInstructions(t *testing.T) {
	t.Cleanup(func() { noteDocumentsDisabled(false) })
	noteDocumentsDisabled(false)
	if !strings.Contains(orbitDriveInstructions(), "documents_put") {
		t.Fatal("the drive paragraph is missing with Drive on")
	}
	noteDocumentsDisabled(true)
	if got := orbitDriveInstructions(); got != "" {
		t.Errorf("drive instructions with Drive off = %q", got)
	}
	if got := orbitDriveGuide(); got != "" {
		t.Errorf("drive guide rule with Drive off = %q", got)
	}
	exe := "/opt/orbit/orbit"
	if text := orbitCLIInstructions(exe, false, true, true, true); strings.Contains(text, "documents_put") || strings.Contains(text, "~/Files") {
		t.Errorf("the instructions still advertise the drive with Drive off")
	}
	// The report names the switch as what withholds the tools.
	op := &operation{Tool: "documents_put"}
	if got := agentToolsWithheldBy(op, agentToolsSwitches{DocumentsOff: true}); got != "documents" {
		t.Errorf("withheld by %q, want documents", got)
	}
	if got := agentToolsWithheldBy(op, agentToolsSwitches{}); got != "" {
		t.Errorf("withheld by %q with Drive on", got)
	}
}
