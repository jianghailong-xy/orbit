package main

// What a real `claude` does with the correction claude_mode_correction.go sends, asked of the installed
// CLI on the same loopback API, empty config and production control path as the setconfig probes
// (claude_setconfig_real_cli_test.go). claude_mode_correction_test.go drives the session loop against
// the fake, which answers the way these record the real CLI answering.

import (
	"context"
	"os"
	"path/filepath"
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

// claudeDisableAutoModeSettings is the settings layer that turns Auto off in the CLI, whatever the model.
const claudeDisableAutoModeSettings = `{"permissions":{"disableAutoMode":"disable"}}`

// signedInWithTheAutoGateOn makes a probe's CLI behave as one signed in to an account whose Auto gate is
// on, which is the CLI that names its mode in a status frame as well as its init frame. It is told it
// holds an OAuth token, a throwaway one like the loopback API's (no credential of this machine is read),
// and it finds the gate already cached in its empty config dir, where the CLI caches the gates it fetches.
// With an API token instead, or without the cached gate, 2.1.332 names its mode in its init frame alone.
func signedInWithTheAutoGateOn(t *testing.T, agent *AgentExecConfig) {
	t.Helper()
	agent.Env["ANTHROPIC_AUTH_TOKEN"] = ""
	agent.Env["CLAUDE_CODE_OAUTH_TOKEN"] = "sk-ant-oat01-orbit-mode-probe"
	seed := `{"cachedGrowthBookFeatures":{"tengu_auto_mode_config":{"enabled":"enabled"}}}`
	if err := os.WriteFile(filepath.Join(agent.Env["CLAUDE_CONFIG_DIR"], ".claude.json"), []byte(seed), 0o600); err != nil {
		t.Fatal(err)
	}
}

// The disableAutoMode case, end to end on the installed CLI: spawned in Auto on a model that has Auto, with
// permissions.disableAutoMode "disable" in its project settings or in --settings. Every frame of its first
// turn goes through what session.go's stdout reader does with it (claudeEngineModeFrame): the mode the CLI
// names is reported as Default, the runner asks for Auto once, the CLI refuses in its own words, and the
// refusal is reported.
func TestRealClaudeWithAutoDisabledBySettingsReportsDefaultAndTheRefusedCorrection(t *testing.T) {
	for _, tc := range []struct {
		name  string
		setup func(agent *AgentExecConfig, cwd string) []string
	}{
		{"project settings", func(agent *AgentExecConfig, cwd string) []string {
			if err := os.MkdirAll(filepath.Join(cwd, ".claude"), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(cwd, ".claude", "settings.json"), []byte(claudeDisableAutoModeSettings), 0o644); err != nil {
				t.Fatal(err)
			}
			return nil
		}},
		{"--settings", func(agent *AgentExecConfig, cwd string) []string {
			return []string{"--settings", claudeDisableAutoModeSettings}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			agent := realClaudeContractAgent()
			agent.Model = realClaudeTargetModel // a model with Auto: only the setting takes it away
			agent.PermissionMode = claudeAutoPermissionMode
			p := startRealClaudeProbeWith(t, agent, func(agent *AgentExecConfig, cwd string) []string {
				signedInWithTheAutoGateOn(t, agent)
				return tc.setup(agent, cwd)
			})
			job := &ClaimedSession{SessionID: "real-claude-mode-correction", SessionUUID: p.sessionID, Provider: providerClaude, Agent: agent}
			modeFix := newClaudeModeCorrection(realClaudeTransportArgs(job))
			var agentTools agentToolsReporter
			var emitted correctionEvents

			p.startReadbackTurn()
			var pending []*pendingModeCorrection
			var named []string
			p.awaitFrame("the first turn's result", func(m map[string]interface{}) bool {
				if mode, ok := claudeEngineModeReading(m); ok {
					named = append(named, m["subtype"].(string)+" "+mode)
				}
				if q := claudeEngineModeFrame(job, p.rt, m, &agentTools, modeFix, emitted.emit); q != nil {
					pending = append(pending, q)
				}
				return m["type"] == "result"
			})
			t.Logf("%s named its mode as: %s", p.exe, strings.Join(named, ", "))
			if len(pending) != 1 {
				t.Fatalf("the runner asked %s for Auto %d time(s) in its first turn, want exactly once (it named %v)%s",
					p.exe, len(pending), named, p.engineOutput())
			}
			modeFix.report(context.Background(), p.rt, pending[0], emitted.emit, p.sessionID)

			var reported []string
			var failed []RunEvent
			for _, e := range emitted.all() {
				switch e.Payload["subtype"] {
				case agentToolsEventSubtype:
					report, _ := e.Payload["agentTools"].(map[string]interface{})
					mode, _ := report["permissionMode"].(string)
					reported = append(reported, mode)
				case permissionModeCorrectionFailedSubtype:
					failed = append(failed, e)
				case permissionModeCorrectedSubtype:
					t.Errorf("%s with Auto disabled by settings was reported as switched to Auto: %v", p.exe, e.Payload)
				}
			}
			t.Logf("the Agent Tools reports named %v", reported)
			if len(reported) == 0 || reported[len(reported)-1] != "default" {
				t.Errorf("the Agent Tools reports named %v, want the last to name %q, the mode %s runs in", reported, "default", p.exe)
			}
			if len(failed) != 1 {
				t.Fatalf("the refused correction was reported as %v, want one %s event", emitted.all(), permissionModeCorrectionFailedSubtype)
			}
			reason, _ := failed[0].Payload["reason"].(string)
			t.Logf("%s refused set_permission_mode auto with: %s", p.exe, reason)
			if !strings.Contains(reason, "auto") || !strings.Contains(reason, "settings") {
				t.Errorf("the reported reason %q does not carry the CLI's refusal of Auto by settings", reason)
			}
			if failed[0].Payload["mode"] != "default" {
				t.Errorf("the failure names the mode the engine runs in as %v, want %q", failed[0].Payload["mode"], "default")
			}
		})
	}
}
