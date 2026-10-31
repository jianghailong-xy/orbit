//go:build linux || darwin

package main

import (
	"context"
	"os"
	"reflect"
	"sync"
	"testing"
	"time"
)

// forwardedStderr records the stderr events a Codex process's output was forwarded as.
type forwardedStderr struct {
	mu     sync.Mutex
	events []map[string]interface{}
}

func (f *forwardedStderr) emit(kind string, payload map[string]interface{}) {
	if kind != evSystem || payload["stderr"] == nil {
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.events = append(f.events, payload)
}

func (f *forwardedStderr) first(t *testing.T) map[string]interface{} {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		f.mu.Lock()
		if len(f.events) > 0 {
			payload := f.events[0]
			f.mu.Unlock()
			return payload
		}
		f.mu.Unlock()
		if time.Now().After(deadline) {
			t.Fatal("codex's stderr line was never forwarded")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// Both ways the runner runs Codex forward its stderr through codexStderrDiagnostic: the line a
// failed model-catalog refresh logs arrives with the diagnostic, and with the raw stderr that older
// clients and exports read.
func TestCodexForwardsACatalogRefreshFailureAsADiagnosticOnBothPaths(t *testing.T) {
	const line = "2026-10-28T15:13:06.979719Z ERROR codex_models_manager::manager: failed to refresh available models: request timed out"
	want, ok := codexStderrDiagnostic(line)
	if !ok {
		t.Fatalf("diagnostic not recognized: %q", line)
	}
	newJob := func(t *testing.T) (*ClaimedSession, string) {
		t.Helper()
		t.Setenv("ORBIT_HOME", t.TempDir())
		bin := t.TempDir()
		// Codex stays up after logging the line, as it does; exiting at once would race the
		// line against the pipe being closed once the process is reaped.
		writeFakeBin(t, bin, providerCodex, "echo '"+line+"' >&2; /bin/sleep 1")
		t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
		return &ClaimedSession{
			SessionID: "019fcbf3-0fa8-7f83-9302-46b25389cb16",
			Agent:     AgentExecConfig{PermissionMode: "auto"},
		}, t.TempDir()
	}
	check := func(t *testing.T, payload map[string]interface{}) {
		t.Helper()
		if got := payload["stderr"]; got != line+"\n" {
			t.Errorf("stderr = %q, want the raw line", got)
		}
		if got := payload["diagnostic"]; !reflect.DeepEqual(got, want) {
			t.Errorf("diagnostic = %#v, want %#v", got, want)
		}
	}

	t.Run("exec", func(t *testing.T) {
		job, dir := newJob(t)
		var forwarded forwardedStderr
		runCodexTurn(context.Background(), job, dir, "work", nil, forwarded.emit)
		check(t, forwarded.first(t))
	})

	t.Run("app-server", func(t *testing.T) {
		job, dir := newJob(t)
		var forwarded forwardedStderr
		app, err := startCodexAppServer(context.Background(), job, dir, dir, envWithAgent(job.Agent.Env), forwarded.emit, nil)
		if err != nil {
			t.Fatal(err)
		}
		payload := forwarded.first(t)
		app.close()
		check(t, payload)
	})
}
