package main

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// A sign-in from the web that lands while the five-minute probe is mid-run. That run asked the CLI
// before the credentials were written, so the refresh the sign-in asks for has to happen after it:
// a TryLock dropped it, and the Providers page called the engine signed out — under a card saying
// the runner was ready — until the next tick, long after the page had stopped waiting.
func TestEngineProbeRefreshAskedMidRunProbesAgain(t *testing.T) {
	var authMu sync.Mutex
	auth := "no"
	var probes atomic.Int32
	inFirstProbe := make(chan struct{})
	release := make(chan struct{})
	p := &engineHealthProbe{probe: func() []EngineHealthReport {
		authMu.Lock()
		answer := auth
		authMu.Unlock()
		if probes.Add(1) == 1 {
			close(inFirstProbe)
			<-release
		}
		return []EngineHealthReport{{Engine: providerClaude, Installed: true, Auth: answer}}
	}}

	timerRun := make(chan struct{})
	go func() {
		defer close(timerRun)
		p.refresh()
	}()
	<-inFirstProbe

	// The sign-in lands, and asks for its refresh while the timer's is still out.
	authMu.Lock()
	auth = "yes"
	authMu.Unlock()
	signInRun := make(chan struct{})
	go func() {
		defer close(signInRun)
		p.refresh()
	}()
	select {
	case <-signInRun:
		t.Fatal("the sign-in's refresh returned while the probe in flight still held the old answer")
	case <-time.After(100 * time.Millisecond):
	}

	close(release)
	for _, done := range []chan struct{}{timerRun, signInRun} {
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("a refresh never finished")
		}
	}
	if n := probes.Load(); n != 2 {
		t.Fatalf("probed %d time(s), want 2 — the timer's run and the sign-in's after it", n)
	}
	if got := p.snapshotNow(); len(got) != 1 || got[0].Auth != "yes" {
		t.Fatalf("snapshot = %+v, want Claude Code signed in", got)
	}
}
