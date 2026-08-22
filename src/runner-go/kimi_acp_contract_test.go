package main

// What a real `kimi acp` does with the session Orbit hands it.
//
// Every other Kimi test asserts on maps Orbit built for itself, which is how 0.38.0's
// refusal of stdio MCP servers as ACP session parameters landed with the suite green
// and every Kimi session dead at session/new. The runner updates its engines on its
// own schedule, so only a real handshake catches the next change of that kind.
//
// So this drives the production path end to end — the per-session KIMI_CODE_HOME
// overlay (kimi_home.go), the mcp.json written into it (kimiMCPConfigRecord) and the
// ACP session parameters (kimiMCPServers) — and stops at session/new. It sends no
// prompt: that would spend the user's quota and leave a turn in their Kimi history,
// and the whole of this break lives in the handshake.

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestKimiACPHandshakeAgainstRealCLI(t *testing.T) {
	home := userHome()
	// The PATH the runner service runs with, not the shell's: an engine installed by
	// its official installer sits in a private dir this adds (service.go).
	enginePath := runnerEnginePath(home, os.Getenv("PATH"))
	exe, ok := lookPathIn(providerKimi, enginePath)
	if !ok {
		t.Skipf("no %s binary on PATH or in %v", providerKimi, engineInstallerDirs(home))
	}
	// startKimiACP resolves the engine off the process PATH, so the test process needs
	// the service's one too.
	t.Setenv("PATH", enginePath)

	execDir := t.TempDir()
	scratchDir := t.TempDir()
	// One stdio server and one sse: the two routes a session's MCP servers travel,
	// and it was the stdio half that 0.38.0 refused.
	job := &ClaimedSession{SessionID: "kimi-acp-contract-test", Agent: kimiMixedMCPAgent()}

	realHome, err := effectiveKimiHome(envWithAgent(job.Agent.Env), execDir)
	if err != nil {
		t.Fatalf("effectiveKimiHome: %v", err)
	}
	kimiHome, err := prepareKimiHomeOverlay(scratchDir, kimiContractSourceHome(t, realHome))
	if err != nil {
		t.Fatalf("prepareKimiHomeOverlay: %v", err)
	}
	t.Cleanup(func() { _ = removeKimiHomeOverlay(kimiHome) })
	// Kimi starts the stdio servers named here while it answers session/new. In a real
	// session the orbit entry names this runner's own binary; under `go test`
	// orbitCLIExecutable() names the test binary, which would re-enter this suite, so
	// name the installed CLI — the same program — instead.
	orbitExe, err := exec.LookPath("orbit")
	if err != nil {
		orbitExe = filepath.Join(scratchDir, "orbit")
	}
	if err := writeKimiHomeMCPConfig(kimiHome, kimiMCPConfigRecord(job.Agent, orbitExe)); err != nil {
		t.Fatalf("writeKimiHomeMCPConfig: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	var mu sync.Mutex
	var events []string
	emit := func(eventType string, payload map[string]interface{}) {
		mu.Lock()
		defer mu.Unlock()
		events = append(events, eventType+": "+fmt.Sprint(payload))
	}
	// What the engine said for itself, printed only when an assertion fails: its
	// stderr arrives as system events.
	engineOutput := func() string {
		mu.Lock()
		defer mu.Unlock()
		return strings.Join(events, "\n")
	}

	// No transport: the only thing it reaches is the permission bridge, and nothing
	// asks permission for anything until a prompt runs.
	app, err := startKimiACP(ctx, nil, job, execDir, kimiHome, emit)
	if err != nil {
		t.Fatalf("spawning %s acp: %v", exe, err)
	}
	defer app.close()
	// A response waits behind a barrier queued after the notifications that precede
	// it, and only a consumer releases it. runKimiSessionProcess runs one; so must
	// this, or the first request never returns.
	app.wg.Add(1)
	go func() {
		defer app.wg.Done()
		for {
			select {
			case <-app.done:
				return
			case item := <-app.notifications:
				if item.barrier != nil {
					close(item.barrier)
				}
			}
		}
	}()

	if err := app.initialize(ctx); err != nil {
		// -32000 from authenticate is the one error that means "this runner is signed
		// out", the same reading kimiAuthMessage and doctor's probe give it. Nothing
		// else may be skipped: a protocol change has to fail.
		if failure, ok := err.(*kimiRPCFailure); ok && failure.err.Code == -32000 {
			t.Skipf("%s is signed out on this runner: %v", exe, err)
		}
		t.Fatalf("initialize/authenticate against %s: %v\n%s", exe, err, engineOutput())
	}
	sessionID, err := app.startOrResumeSession(ctx, job, execDir)
	if err != nil {
		t.Fatalf("session/new against %s (%s) failed: %v\n%s", exe, engineVersion(exe), err, engineOutput())
	}
	t.Logf("kimi %s at %s answered session/new with %s", engineVersion(exe), exe, sessionID)
}

// kimiContractSourceHome is the home the overlay borrows from: the real one's login
// and configuration, and nothing that records sessions. session/new adds a row to
// sessions/ and to session_index.jsonl, and those are the user's — borrowing them
// would leave an empty session in their Kimi history every time this test runs.
func kimiContractSourceHome(t *testing.T, realHome string) string {
	t.Helper()
	dir := t.TempDir()
	for _, name := range []string{"credentials", "oauth", "config.toml", "region", "device_id"} {
		target := filepath.Join(realHome, name)
		if _, err := os.Lstat(target); err != nil {
			continue
		}
		if err := os.Symlink(target, filepath.Join(dir, name)); err != nil {
			t.Fatalf("linking %s into the borrowed home: %v", name, err)
		}
	}
	return dir
}
