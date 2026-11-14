package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

// claudeInitFrame is Claude Code's system/init as 2.1.325 writes it (measured 2026-11-14), with Orbit's
// server in the given status and the Orbit tools a session with orchestration off is served.
func claudeInitFrame(t *testing.T, status string, withSkill bool) map[string]interface{} {
	t.Helper()
	tools := []interface{}{"Bash", "Read", "Skill"}
	if status == "connected" {
		served := agentToolsServedForTest(agentToolsSwitches{Orchestration: false, Watches: true, Wiki: true})
		for _, name := range served {
			tools = append(tools, claudeToolName(name))
		}
		tools = append(tools, claudeToolName("permission_prompt"))
	}
	skills := []interface{}{"loop", "simplify"}
	if withSkill {
		skills = append(skills, claudeManagedSkillID)
	}
	return map[string]interface{}{
		"type": "system", "subtype": "init", "claude_code_version": "2.1.325", "permissionMode": "default",
		"mcp_servers": []interface{}{map[string]interface{}{"name": "orbit", "status": status, "source": "dynamic"},
			map[string]interface{}{"name": "acme", "status": "failed"}},
		"tools":  tools,
		"skills": skills,
	}
}

// agentToolsServedForTest is the Orbit tools `orbit mcp` lists under sw, the permission bridge not included.
func agentToolsServedForTest(sw agentToolsSwitches) []string {
	var names []string
	for _, op := range operationCatalog().Ops {
		if agentToolsFamilyOf(op) != "" && agentToolsWithheldBy(op, sw) == "" {
			names = append(names, op.Tool)
		}
	}
	return names
}

func agentToolsJob() *ClaimedSession {
	return &ClaimedSession{
		SessionID:          "sess-1",
		AllowOrchestration: false,
		Agent:              AgentExecConfig{PermissionMode: "acceptEdits", AppendSystemPrompt: "Use pnpm.\n"},
	}
}

// Claude Code's own init frame is the report: Orbit's server connected, the tools it lists counted by
// family, the family the switch keeps out said so, its version and live mode, and the playbooks taken.
func TestClaudeInitBecomesTheAgentToolsReport(t *testing.T) {
	withClaudeSpawnVersion(t, claudeManagedPluginFloor)
	r := claudeAgentToolsReport(agentToolsJob(), claudeInitFrame(t, "connected", true))
	if r.Engine != providerClaude || r.EngineVersion != "2.1.325" || r.PermissionMode != "default" {
		t.Errorf("engine/version/mode = %s %s %s", r.Engine, r.EngineVersion, r.PermissionMode)
	}
	if r.MCP.Status != "connected" || r.MCP.Tools != len(agentToolsServedForTest(r.Switches)) {
		t.Errorf("mcp = %+v, want connected with %d tools", r.MCP, len(agentToolsServedForTest(r.Switches)))
	}
	if r.Versions.Contract != agentContractVersion || r.Versions.Catalog != operationCatalogVersion ||
		r.Versions.Primer != agentPrimerVersion || r.Versions.Guide != agentGuideVersion || r.Versions.Playbooks != agentToolsGuideVersion {
		t.Errorf("versions = %+v", r.Versions)
	}
	for _, f := range r.Families {
		switch {
		case f.ID == "orchestration":
			if f.Served != 0 || f.Total == 0 || f.Reason != "orchestration" {
				t.Errorf("orchestration family = %+v, want none served, said why", f)
			}
		case f.Served != f.Total || f.Reason != "":
			t.Errorf("family %s = %+v, want all served", f.ID, f)
		}
	}
	if r.Instructions.Carrier != carrierAppendSystemPrompt || !r.Instructions.Workspace || r.Instructions.WorkspaceChars != len("Use pnpm.") || r.Instructions.Base {
		t.Errorf("instructions = %+v", r.Instructions)
	}
	if !r.Skill.Offered || r.Skill.Loaded == nil || !*r.Skill.Loaded || r.Skill.Name != claudeManagedSkillID {
		t.Errorf("skill = %+v", r.Skill)
	}
}

// A server Claude Code could not start is reported failed, with no tool in any family and why.
func TestClaudeReportsAFailedOrbitServer(t *testing.T) {
	withClaudeSpawnVersion(t, "2.1.300")
	r := claudeAgentToolsReport(agentToolsJob(), claudeInitFrame(t, "failed", false))
	if r.MCP.Status != "failed" || r.MCP.Tools != 0 {
		t.Errorf("mcp = %+v", r.MCP)
	}
	for _, f := range r.Families {
		if f.Served != 0 || f.Reason != "not_connected" {
			t.Errorf("family %s = %+v, want not connected", f.ID, f)
		}
	}
	if r.Skill.Offered || r.Skill.Loaded != nil || !strings.Contains(r.Skill.Reason, claudeManagedPluginFloor) {
		t.Errorf("an older CLI's skill = %+v", r.Skill)
	}
	for status, want := range map[string]string{"pending": "starting", "needs-auth": "needs_auth", "": "not_configured", "disabled": "failed"} {
		if got := claudeMCPStatus(status); got != want {
			t.Errorf("claudeMCPStatus(%q) = %q, want %q", status, got, want)
		}
	}
	noOrbit := claudeInitFrame(t, "connected", false)
	noOrbit["mcp_servers"] = []interface{}{}
	if got := claudeAgentToolsReport(agentToolsJob(), noOrbit).MCP.Status; got != "not_configured" {
		t.Errorf("an init naming no orbit server = %q", got)
	}
}

// The report goes out as one system event when it says something new, and not again while it says the same.
func TestAgentToolsReporterSendsOnlyWhatChanged(t *testing.T) {
	withClaudeSpawnVersion(t, claudeManagedPluginFloor)
	var events []map[string]interface{}
	emit := func(kind string, payload map[string]interface{}) {
		if kind != evSystem {
			t.Errorf("sent as %s", kind)
		}
		events = append(events, payload)
	}
	rep := agentToolsReporter{now: func() time.Time { return time.Date(2026, 11, 14, 13, 0, 0, 0, time.UTC) }}
	rep.send(claudeAgentToolsReport(agentToolsJob(), claudeInitFrame(t, "pending", true)), emit)
	rep.send(claudeAgentToolsReport(agentToolsJob(), claudeInitFrame(t, "pending", true)), emit)
	rep.send(claudeAgentToolsReport(agentToolsJob(), claudeInitFrame(t, "connected", true)), emit)
	if len(events) != 2 {
		t.Fatalf("sent %d events, want 2", len(events))
	}
	if events[0]["subtype"] != agentToolsEventSubtype {
		t.Errorf("subtype = %v", events[0]["subtype"])
	}
	report, _ := events[1]["agentTools"].(map[string]interface{})
	mcp, _ := report["mcp"].(map[string]interface{})
	if report["v"] != float64(agentToolsReportVersion) || report["at"] != "2026-11-14T13:00:00Z" || mcp["status"] != "connected" {
		t.Errorf("second report = %v", report)
	}
	// The event is one the control plane stores: not a noise ping, and not live-only.
	if !linkRowEvent(evSystem, events[1]) {
		t.Error("the report is an event the control plane would not store")
	}
}

// Codex's startup states of Orbit's server become the report, its error text included; another server's
// do not.
func TestCodexStartupStatusBecomesTheReport(t *testing.T) {
	clientReader, serverWriter := io.Pipe()
	app := &codexAppServer{
		ctx:           context.Background(),
		pending:       map[string]chan codexRPCMessage{},
		notifications: make(chan codexRPCMessage, 8),
		done:          make(chan struct{}),
		engineVersion: "0.167.2",
	}
	app.setInstructionMode(codexInstructionsAdditionalContext)
	go app.readLoop(clientReader)

	var mu sync.Mutex
	var reports []map[string]interface{}
	emit := func(kind string, payload map[string]interface{}) {
		mu.Lock()
		defer mu.Unlock()
		if payload["subtype"] == agentToolsEventSubtype {
			r, _ := payload["agentTools"].(map[string]interface{})
			reports = append(reports, r)
		}
	}
	job := agentToolsJob()
	job.AllowOrchestration = true
	tools := newCodexAgentTools(job, app, emit)
	tools.skillRoot(nil, "/scratch/orbit-skills")
	app.listenOrbitMCP(tools.mcpStatus)
	tools.carrier(app.currentInstructionMode())
	for _, frame := range []map[string]interface{}{
		{"method": "mcpServer/startupStatus/updated", "params": map[string]interface{}{"threadId": "t", "name": "acme", "status": "failed", "error": "boom"}},
		{"method": "mcpServer/startupStatus/updated", "params": map[string]interface{}{"threadId": "t", "name": "orbit", "status": "starting"}},
		{"method": "mcpServer/startupStatus/updated", "params": map[string]interface{}{"threadId": "t", "name": "orbit", "status": "ready"}},
		{"method": "mcpServer/startupStatus/updated", "params": map[string]interface{}{"threadId": "t", "name": "orbit", "status": "failed", "error": "handshaking with MCP server failed: connection closed"}},
	} {
		line, _ := json.Marshal(frame)
		if _, err := serverWriter.Write(append(line, '\n')); err != nil {
			t.Fatal(err)
		}
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		mu.Lock()
		n := len(reports)
		mu.Unlock()
		if n >= 3 || time.Now().After(deadline) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	_ = serverWriter.Close()
	mu.Lock()
	defer mu.Unlock()
	// The carrier's report (starting), the ready one, and the failed one: "starting" again says nothing new.
	if len(reports) != 3 {
		t.Fatalf("sent %d reports, want 3: %v", len(reports), reports)
	}
	ready := reports[1]
	mcp, _ := ready["mcp"].(map[string]interface{})
	if mcp["status"] != "connected" || mcp["tools"] != float64(len(agentToolsServedForTest(agentToolsSwitches{Orchestration: true, Watches: true, Wiki: true}))) {
		t.Errorf("ready = %v", mcp)
	}
	instructions, _ := ready["instructions"].(map[string]interface{})
	skill, _ := ready["skill"].(map[string]interface{})
	if ready["engineVersion"] != "0.167.2" || instructions["carrier"] != carrierAdditionalContext || skill["offered"] != true || skill["name"] != codexManagedSkillName {
		t.Errorf("ready report = %v", ready)
	}
	failed, _ := reports[2]["mcp"].(map[string]interface{})
	if failed["status"] != "failed" || failed["detail"] != "handshaking with MCP server failed: connection closed" || failed["tools"] != float64(0) {
		t.Errorf("failed = %v", failed)
	}
}

// A Codex that refuses the skill root is reported without the skill, and why.
func TestCodexSkillRootRefusalIsReported(t *testing.T) {
	app := &codexAppServer{}
	tools := newCodexAgentTools(agentToolsJob(), app, nil)
	tools.skillRoot(errors.New("unknown variant `skills/extraRoots/set`"), "/scratch/orbit-skills")
	if tools.report.Skill.Offered || !strings.Contains(tools.report.Skill.Reason, "unknown variant") {
		t.Errorf("skill = %+v", tools.report.Skill)
	}
	tools = newCodexAgentTools(agentToolsJob(), app, nil)
	tools.skillRoot(nil, "")
	if tools.report.Skill.Offered || tools.report.Skill.Reason == "" {
		t.Errorf("unwritten skill = %+v", tools.report.Skill)
	}
	if got := codexVersionFromUserAgent("codex_cli_rs/0.167.2 (Debian 13.0.0; x86_64) unknown"); got != "0.167.2" {
		t.Errorf("version = %q", got)
	}
	for mode, want := range map[codexInstructionMode]string{
		codexInstructionsAdditionalContext: carrierAdditionalContext,
		codexInstructionsInjectItems:       carrierDeveloperMessage,
		codexInstructionsUserInput:         carrierTurnInput,
	} {
		if got := codexInstructionCarrier(mode); got != want {
			t.Errorf("carrier(%v) = %q, want %q", mode, got, want)
		}
	}
}

// The playbooks plugin is passed only to a CLI known to take --plugin-dir, from the session's own directory.
func TestClaudeSpawnGetsThePlaybooksOnlyWhenNewEnough(t *testing.T) {
	for _, c := range []struct {
		version string
		want    bool
	}{{claudeManagedPluginFloor, true}, {"2.2.0", true}, {"2.1.324", false}, {"0.0.0", false}} {
		withClaudeSpawnVersion(t, c.version)
		scratch := t.TempDir()
		args := claudeCommandArgs(claudeSpawnJob(t), scratch, true)
		got := containsArgs(args, []string{"--plugin-dir", scratch + "/orbit-plugin"})
		if got != c.want {
			t.Errorf("claude %s: --plugin-dir passed = %v, want %v (%q)", c.version, got, c.want, args)
		}
	}
}
