package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// runnerMeBody is `GET /api/runner/me` as the apiserver sends it: runner-api.controller.ts me(),
// then the global interceptors. The controller is machine protocol, so every id stays a UUID and
// gains a publicId twin, and nothing mirrors `workspaces` to `agents`.
func runnerMeBody(workspaces string) string {
	return `{"id":"6f1c2a9e-3b7d-4c52-9e1a-5d8b7f0c4e21","name":"build-host","status":"ONLINE","online":true,` +
		`"lastHeartbeatAt":"2026-09-12T01:25:45.123Z","version":"0.1.156","labels":[],"maxConcurrent":2,` +
		`"workspaces":` + workspaces + `,"publicId":"3Nf1GScXFWjk1spCZ7o68P"}`
}

// An idle runner polls a provider's plan usage only while one of its workspaces runs that provider,
// and it learns its workspaces from `GET /runner/me`. It used to decode them from `agents`, a key the
// apiserver stopped sending at the Agent → Workspace rename, so no provider ever counted as
// configured: an idle runner never read Codex usage and the Codex reset block never reached the
// heartbeat.
func TestRunnerMeWorkspacesEnableIdleUsageProbes(t *testing.T) {
	cases := []struct {
		name         string
		workspaces   string
		wantWorkDirs []string
		wantCodex    bool
		wantClaude   bool
	}{
		{
			name: "codex workspaces",
			workspaces: `[{"id":"0b7e4f2c-8a1d-4f63-b5c9-2e7d1a9c3f80","name":"orbit","provider":"codex","workDir":"/srv/orbit","publicId":"LgdcgUxO5aTqRU2wmdzlY"},` +
				`{"id":"9d3a6c1e-5f2b-4e87-a0d4-7c8b2e6f1a95","name":"site","provider":"codex","workDir":"/srv/site","publicId":"4mgUeYAvOHLaaAcdPPGY5d"}]`,
			wantWorkDirs: []string{"/srv/orbit", "/srv/site"},
			wantCodex:    true,
		},
		{
			name:         "claude workspace only",
			workspaces:   `[{"id":"4a8f2d6b-1c9e-4b35-8f7a-3e5d9c2b6a14","name":"docs","provider":"claude","workDir":"/srv/docs","publicId":"2GgraykKCu2Hdo1d4LFk3A"}]`,
			wantWorkDirs: []string{"/srv/docs"},
			wantClaude:   true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodGet || r.URL.Path != "/api/runner/me" {
					http.NotFound(w, r)
					return
				}
				w.Header().Set("content-type", "application/json")
				_, _ = io.WriteString(w, runnerMeBody(tc.workspaces))
			}))
			defer srv.Close()

			var agents runnerAgentList
			agents.refresh(NewTransport(srv.URL, "runner-token"))
			var workDirs []string
			for _, a := range agents.snapshot() {
				workDirs = append(workDirs, a.WorkDir)
			}
			if got, want := strings.Join(workDirs, ","), strings.Join(tc.wantWorkDirs, ","); got != want {
				t.Errorf("workspace workDirs = %q, want %q", got, want)
			}
			if got := agents.providerConfigured(providerCodex); got != tc.wantCodex {
				t.Errorf("providerConfigured(codex) = %v, want %v", got, tc.wantCodex)
			}
			if got := agents.providerConfigured(providerClaude); got != tc.wantClaude {
				t.Errorf("providerConfigured(claude) = %v, want %v", got, tc.wantClaude)
			}

			// No session is active, so only the idle branch can read, and each probe is gated the way
			// runLoop gates it. Both run over the same window: the enabled one must read on the idle
			// cadence while the other never reads.
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var codexReads, claudeReads atomic.Int64
			startIdleProbe := func(provider string, reads *atomic.Int64) {
				p := &planUsageProbe{
					name: "test " + provider + " plan-usage",
					fetch: func(context.Context, *http.Client) (*PlanUsage, error) {
						reads.Add(1)
						return &PlanUsage{Provider: provider}, nil
					},
				}
				idle := func() bool { return agents.providerConfigured(provider) }
				go p.runWithIntervals(ctx, func() int { return 0 }, idle, 5*time.Millisecond, time.Hour, 20*time.Millisecond)
			}
			startIdleProbe(providerCodex, &codexReads)
			startIdleProbe(providerClaude, &claudeReads)
			readEnough := func(reads *atomic.Int64, want bool) bool { return !want || reads.Load() >= 2 }
			deadline := time.Now().Add(5 * time.Second)
			for !(readEnough(&codexReads, tc.wantCodex) && readEnough(&claudeReads, tc.wantClaude)) && time.Now().Before(deadline) {
				time.Sleep(5 * time.Millisecond)
			}
			checkReads := func(provider string, reads int64, want bool) {
				if want && reads < 2 {
					t.Errorf("idle %s usage reads = %d, want at least 2 on the idle cadence", provider, reads)
				}
				if !want && reads != 0 {
					t.Errorf("idle %s usage reads = %d, want none without a %s workspace", provider, reads, provider)
				}
			}
			checkReads(providerCodex, codexReads.Load(), tc.wantCodex)
			checkReads(providerClaude, claudeReads.Load(), tc.wantClaude)
		})
	}
}

// The rest of the body still decodes beside the list, and an apiserver older than the rename, which
// sends the list under `agents` alone, is still read.
func TestRunnerMeDecodesTheListUnderEitherKey(t *testing.T) {
	list := `[{"id":"0b7e4f2c-8a1d-4f63-b5c9-2e7d1a9c3f80","name":"orbit","provider":"codex","workDir":"/srv/orbit"}]`
	bodies := map[string]string{
		"workspaces": runnerMeBody(list),
		"agents from a pre-rename apiserver": `{"id":"6f1c2a9e-3b7d-4c52-9e1a-5d8b7f0c4e21","name":"build-host","status":"ONLINE","online":true,` +
			`"lastHeartbeatAt":"2026-09-12T01:25:45.123Z","version":"0.1.156","labels":[],"maxConcurrent":2,"agents":` + list + `}`,
	}
	for name, body := range bodies {
		t.Run(name, func(t *testing.T) {
			var me MeResponse
			if err := json.Unmarshal([]byte(body), &me); err != nil {
				t.Fatal(err)
			}
			if !me.Online || me.LastHeartbeatAt == nil || me.MaxConcurrent != 2 ||
				len(me.Agents) != 1 || me.Agents[0].Provider != providerCodex || me.Agents[0].WorkDir != "/srv/orbit" {
				t.Fatalf("decoded %+v", me)
			}
		})
	}
}
