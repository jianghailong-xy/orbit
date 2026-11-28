package main

// What a real `claude` does with the correction claude_mode_correction.go sends, asked of the installed
// CLI on the same loopback API, empty config and production control path as the setconfig probes
// (claude_setconfig_real_cli_test.go). claude_mode_correction_test.go drives the session loop against
// the fake, which answers the way these record the real CLI answering.

import (
	"context"
	"strings"
	"sync"
	"testing"
)

// correctionEvents is an emitFn that keeps every event it was handed, payload and all.
type correctionEvents struct {
	mu     sync.Mutex
	events []RunEvent
}

func (r *correctionEvents) emit(eventType string, payload map[string]interface{}) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, RunEvent{Type: eventType, Payload: payload})
}

func (r *correctionEvents) all() []RunEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]RunEvent(nil), r.events...)
}

// firstInit opens a turn and returns the init frame the CLI starts it with: the mode it settled on.
func (p *realClaudeProbe) firstInit() map[string]interface{} {
	p.t.Helper()
	p.startReadbackTurn()
	return p.awaitFrame("the turn's system/init frame", func(m map[string]interface{}) bool {
		return m["type"] == "system" && m["subtype"] == "init"
	})
}

// The premise and the refusal together, both the CLI's own: spawned in Auto on a model with no Auto, it
// starts without a word and names Default in its init frame; asked for Auto then, it refuses; and the
// runner reports the refusal in the CLI's words instead of a correction it did not get.
func TestRealClaudeRefusesTheAutoCorrectionOnAModelWithoutAuto(t *testing.T) {
	t.Parallel()
	agent := realClaudeContractAgent() // Haiku 4.5, which has no Auto
	agent.PermissionMode = claudeAutoPermissionMode
	p := startRealClaudeProbe(t, agent)
	modeFix := newClaudeModeCorrection(realClaudeTransportArgs(&ClaimedSession{SessionUUID: p.sessionID, Agent: agent}))

	init := p.firstInit()
	if got := init["permissionMode"]; got != "default" {
		t.Fatalf("%s spawned in Auto on %s settled on %v; this probe needs it to settle on %q%s",
			p.exe, agent.Model, got, "default", p.engineOutput())
	}
	pending := modeFix.begin(p.rt, init)
	if pending == nil {
		t.Fatal("an engine spawned in Auto that settled on Default was not asked for Auto")
	}
	var emitted correctionEvents
	modeFix.report(context.Background(), p.rt, pending, emitted.emit, p.sessionID)

	events := emitted.all()
	if len(events) != 1 || events[0].Payload["subtype"] != permissionModeCorrectionFailedSubtype {
		t.Fatalf("the refused correction was reported as %v, want one %s event", events, permissionModeCorrectionFailedSubtype)
	}
	reason, _ := events[0].Payload["reason"].(string)
	t.Logf("%s refused set_permission_mode auto with: %s", p.exe, reason)
	if !strings.Contains(reason, "auto") {
		t.Errorf("the reported reason %q does not carry the CLI's refusal of Auto", reason)
	}
	if events[0].Payload["mode"] != "default" {
		t.Errorf("the failure names the mode the engine runs in as %v, want %q", events[0].Payload["mode"], "default")
	}
}

// The frame the correction sends, taken by a CLI that has Auto: answered with a success, and followed by
// the status frame in which the CLI names the mode it is now in.
//
// A CLI whose model has Auto does not settle below it when spawned in Auto, so this one is spawned in
// Default and judged as if it had been spawned in Auto: the engine half is real, only the reason it is
// in Default is staged.
func TestRealClaudeTakesTheAutoCorrectionFromDefault(t *testing.T) {
	t.Parallel()
	agent := realClaudeContractAgent()
	agent.Model = realClaudeTargetModel
	p := startRealClaudeProbe(t, agent)
	modeFix := &claudeModeCorrection{spawned: claudeAutoPermissionMode}

	init := p.firstInit()
	if got := init["permissionMode"]; got != "default" {
		t.Fatalf("%s spawned in Default named %v in its init frame, want %q%s", p.exe, got, "default", p.engineOutput())
	}
	pending := modeFix.begin(p.rt, init)
	if pending == nil {
		t.Fatal("an engine judged as spawned in Auto that settled on Default was not asked for Auto")
	}
	var emitted correctionEvents
	modeFix.report(context.Background(), p.rt, pending, emitted.emit, p.sessionID)

	events := emitted.all()
	if len(events) != 1 || events[0].Payload["subtype"] != permissionModeCorrectedSubtype {
		t.Fatalf("%s's answer was reported as %v, want one %s event%s", p.exe, events, permissionModeCorrectedSubtype, p.engineOutput())
	}
	status := p.awaitFrame("a system/status frame naming the mode after the correction", func(m map[string]interface{}) bool {
		return m["type"] == "system" && m["subtype"] == "status" && m["permissionMode"] != nil
	})
	if got := status["permissionMode"]; got != claudeAutoPermissionMode {
		t.Errorf("%s reports permissionMode %v after taking the correction, want %q: %v", p.exe, got, claudeAutoPermissionMode, status)
	}
}
