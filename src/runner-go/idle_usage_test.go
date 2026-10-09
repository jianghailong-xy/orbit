package main

import (
	"context"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

// An idle runner reads an engine's usage while that engine is signed in on it, whatever its workspaces
// last ran. A workspace's provider is only the one its last session ran on, so gating the idle read on
// that alone left HPC — whose workspaces last ran Claude and DeepSeek — reading Codex only while a
// Codex session ran there. The reading lived in the runner process, so the self-update to 0.1.225 took
// it, and the runner page said "No quota reported" over a signed-in Pro login that answered
// account/rateLimits/read at once (2026-10-09). Claude's and Kimi Code's reads were gated the same way.
func TestAnIdleRunnerReadsUsageWhileTheEngineIsSignedIn(t *testing.T) {
	for _, provider := range []string{providerClaude, providerCodex, providerKimi} {
		t.Run(provider, func(t *testing.T) {
			// The machine's one workspace last ran DeepSeek: no workspace here runs provider.
			agents := &runnerAgentList{agents: []RunnerAgent{{ID: "docs", Provider: "deepseek", WorkDir: "/srv/docs"}}}
			var engine EngineHealthReport
			engines := &engineHealthProbe{probe: func() []EngineHealthReport { return []EngineHealthReport{engine} }}
			idle := idleUsage(provider, agents.providerConfigured, engines)
			if idle() {
				t.Fatal("read idle usage before the engine probe had answered")
			}
			for _, step := range []struct {
				name   string
				engine EngineHealthReport
				want   bool
			}{
				{"signed in", EngineHealthReport{Engine: provider, Installed: true, Auth: "yes"}, true},
				{"signed out", EngineHealthReport{Engine: provider, Installed: true, Auth: "no"}, false},
				{"only an added account signed in", EngineHealthReport{Engine: provider, Installed: true, Auth: "no",
					Accounts: []EngineAccountReport{{ID: accountSlotDefaultID, Auth: "no"}, {ID: "work", Auth: "yes"}}}, true},
				{"the CLI would not say", EngineHealthReport{Engine: provider, Installed: true, Auth: "unknown"}, false},
				{"another engine signed in", EngineHealthReport{Engine: providerOpenCode, Installed: true, Auth: "yes"}, false},
			} {
				engine = step.engine
				engines.refresh()
				if got := idle(); got != step.want {
					t.Errorf("%s: idle usage read = %v, want %v", step.name, got, step.want)
				}
			}

			// A workspace that last ran provider still has it read, whatever the engine probe says.
			agents.agents = append(agents.agents, RunnerAgent{ID: "orbit", Provider: provider, WorkDir: "/srv/orbit"})
			if !idle() {
				t.Error("a workspace that last ran the provider no longer has its usage read while idle")
			}

			// And signed in with no workspace running it, the probe reads on the idle cadence with no
			// session running.
			agents.agents = agents.agents[:1]
			engine = EngineHealthReport{Engine: provider, Installed: true, Auth: "yes"}
			engines.refresh()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var reads atomic.Int64
			p := &planUsageProbe{name: "test " + provider + " plan-usage", fetch: func(context.Context, *http.Client) (*PlanUsage, error) {
				reads.Add(1)
				return &PlanUsage{Provider: provider}, nil
			}}
			go p.runWithIntervals(ctx, func() int { return 0 }, idle, 5*time.Millisecond, time.Hour, 20*time.Millisecond)
			for deadline := time.Now().Add(5 * time.Second); reads.Load() < 2 && time.Now().Before(deadline); {
				time.Sleep(5 * time.Millisecond)
			}
			if n := reads.Load(); n < 2 {
				t.Errorf("idle usage reads = %d, want at least 2 on the idle cadence", n)
			}
		})
	}
}
