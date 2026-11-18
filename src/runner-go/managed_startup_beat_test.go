package main

import (
	"context"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The first beat waits for the engine probe, so that it reports what READY reads, and goes the moment
// the probe answers — not at the first tick.
func TestManagedStartupBeatWaitsForTheEngineProbe(t *testing.T) {
	probed := make(chan struct{})
	var beats atomic.Int32
	done := make(chan bool, 1)
	go func() {
		done <- managedStartupBeat(context.Background(), probed, time.Hour, time.Hour, time.Hour, func() bool {
			beats.Add(1)
			return true
		})
	}()
	time.Sleep(50 * time.Millisecond)
	if got := beats.Load(); got != 0 {
		t.Fatalf("%d beats before the engine probe answered, want none", got)
	}
	close(probed)
	select {
	case taken := <-done:
		if !taken || beats.Load() != 1 {
			t.Fatalf("taken = %v after %d beats, want one beat, taken", taken, beats.Load())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no beat once the engine probe had answered")
	}
}

// A probe that does not answer holds the first beat back for its wait and no longer.
func TestManagedStartupBeatDoesNotWaitForAWedgedProbe(t *testing.T) {
	started := time.Now()
	taken := managedStartupBeat(context.Background(), make(chan struct{}), 50*time.Millisecond, time.Hour, time.Hour, func() bool { return true })
	if !taken {
		t.Fatal("the beat after the probe's wait was not taken")
	}
	if elapsed := time.Since(started); elapsed < 50*time.Millisecond || elapsed > 5*time.Second {
		t.Fatalf("the first beat went after %s, want the probe's wait of 50ms", elapsed)
	}
}

// Refused or unanswered — the control plane restarting, or its manager not having recorded the Pod yet —
// the first beat is sent again soon, until one is taken.
func TestManagedStartupBeatTriesAgainUntilOneIsTaken(t *testing.T) {
	probed := make(chan struct{})
	close(probed)
	var beats atomic.Int32
	taken := managedStartupBeat(context.Background(), probed, time.Hour, 10*time.Millisecond, time.Hour, func() bool {
		return beats.Add(1) == 3
	})
	if !taken || beats.Load() != 3 {
		t.Fatalf("taken = %v after %d beats, want taken on the third", taken, beats.Load())
	}
}

// It gives up once its limit has passed, by when the ticker's own first beat is due, and at once when
// the runner stops.
func TestManagedStartupBeatEndsAtItsLimitAndWhenTheRunnerStops(t *testing.T) {
	probed := make(chan struct{})
	close(probed)
	started := time.Now()
	if managedStartupBeat(context.Background(), probed, time.Hour, 10*time.Millisecond, 100*time.Millisecond, func() bool { return false }) {
		t.Fatal("no beat was taken, yet it answered taken")
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("it gave up after %s, want its limit of 100ms", elapsed)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var beats atomic.Int32
	if managedStartupBeat(ctx, make(chan struct{}), time.Hour, time.Hour, time.Hour, func() bool { beats.Add(1); return true }) {
		t.Fatal("a stopping runner's first beat answered taken")
	}
	if beats.Load() != 0 {
		t.Fatal("a stopping runner was still beaten for")
	}
}

func TestEngineHealthProbedClosesWithTheFirstProbe(t *testing.T) {
	release := make(chan struct{})
	p := &engineHealthProbe{probe: func() []EngineHealthReport {
		<-release
		return []EngineHealthReport{{Engine: providerClaude, Installed: true, Auth: "no"}}
	}}
	probed := p.probed()
	go p.refresh()
	select {
	case <-probed:
		t.Fatal("probed before the probe answered")
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	select {
	case <-probed:
	case <-time.After(5 * time.Second):
		t.Fatal("the first probe answered and probed stayed open")
	}
	if p.snapshotNow() == nil {
		t.Fatal("probed closed before the snapshot was stored")
	}
	// Later probes leave it closed.
	p.refresh()
	select {
	case <-p.probed():
	default:
		t.Fatal("probed is open again after a later probe")
	}
}

// A self-managed runner's first beat does not wait for the probe, so what the probe finds is asked a beat
// of its own, once: a later probe is news only for the next tick.
func TestBeatOnceProbedBeatsWhenTheProbeFirstAnswers(t *testing.T) {
	probed := make(chan struct{})
	var beats atomic.Int32
	done := make(chan struct{})
	go func() {
		defer close(done)
		beatOnceProbed(context.Background(), probed, func() { beats.Add(1) })
	}()
	time.Sleep(20 * time.Millisecond)
	if beats.Load() != 0 {
		t.Fatal("beat before the probe answered")
	}
	close(probed)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("still waiting after the probe answered")
	}
	if beats.Load() != 1 {
		t.Fatalf("beats = %d, want 1", beats.Load())
	}
}

func TestBeatOnceProbedEndsWithTheRunner(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var beats atomic.Int32
	done := make(chan struct{})
	go func() {
		defer close(done)
		beatOnceProbed(ctx, make(chan struct{}), func() { beats.Add(1) })
	}()
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("still waiting after the runner stopped")
	}
	if beats.Load() != 0 {
		t.Fatalf("beats = %d, want 0", beats.Load())
	}
}

// The wiring in runLoop: a self-managed runner asks for its first beat once it has reclaimed its sessions,
// and not at the first tick half a minute on. Not sooner: the beat hands out merges and commits against
// the supervisors it advertises (heartbeatMerge), and the reclaim is what makes those. The engines the
// probe finds get a beat of their own. Its first claim is not held back for any of it.
func TestRunLoopBeatsOnceASelfManagedRunnerHasReclaimed(t *testing.T) {
	src, err := os.ReadFile("runloop.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(src)
	body = body[strings.Index(body, "func runLoop("):]
	body = body[:strings.Index(body, "\n}\n")]

	first := "\tif currentManagedInstance() == nil {\n\t\tbeatNow()\n\t\tgo beatOnceProbed(loopCtx, engineHealth.probed(), beatNow)\n\t}\n"
	at := strings.Index(body, first)
	if at < 0 {
		t.Fatal("runLoop does not beat a self-managed runner's first heartbeat by itself, with one for the probe")
	}
	reclaim := strings.Index(body, "reclaimWaitedOnSessions(loopCtx, t, pool.reclaimStates, prepareTakeover)")
	reclaimed := strings.Index(body, "reclaimed = true")
	if reclaim < 0 || reclaimed < reclaim || at < reclaimed {
		t.Fatal("the first heartbeat is asked for before the reclaim has made the supervisors it advertises")
	}
	gate := strings.Index(body, "case <-startupBeatDone:")
	if gate < at {
		t.Fatal("the first heartbeat is asked for after the claim gate")
	}
}

// The wiring in runLoop: a managed instance's heartbeat goroutine beats once before its ticker loop, and
// the claim loop waits for that before its first claim. A self-managed runner does neither: its first
// beat is asked for by the reclaim, above, and its first claim is not held back.
func TestRunLoopBeatsBeforeAManagedInstanceClaims(t *testing.T) {
	src, err := os.ReadFile("runloop.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(src)
	body = body[strings.Index(body, "func runLoop("):]
	body = body[:strings.Index(body, "\n}\n")]

	// The beat is counted taken only past its failure path.
	failure := strings.Index(body, `logln("heartbeat failed:", err)`)
	taken := strings.Index(body, "beatTaken = true")
	if failure < 0 || taken < failure || !strings.Contains(body[failure:taken], "return\n") {
		t.Error("a beat counts as taken only once the control plane has answered it")
	}

	startup := strings.Index(body, "managedStartupBeat(loopCtx, engineHealth.probed(), managedStartupProbeWait, managedStartupBeatRetry, heartbeatInterval,")
	opened := strings.Index(body, "close(startupBeatDone)")
	ticks := strings.Index(body, "beatUntilStopped(hbStop, ticker.C, hbNow, beat)")
	if startup < 0 || opened < startup || ticks < opened {
		t.Fatal("the heartbeat goroutine does not beat for a managed instance, then open its claims, then tick")
	}
	if !strings.HasSuffix(strings.TrimRight(body[:startup], "\t "), "if currentManagedInstance() != nil {\n") {
		t.Error("the startup beat is not for a managed instance alone")
	}

	gate := strings.Index(body, "case <-startupBeatDone:")
	loop := strings.Index(body, "\tfor loopCtx.Err() == nil {")
	claim := strings.Index(body, "t.claimSession(loopCtx, &claims, scope...)")
	if gate < 0 || loop < gate || claim < loop {
		t.Fatal("the claim loop does not wait for the startup beat before its first claim")
	}
	held := body[strings.LastIndex(body[:gate], "\n\tif "):gate]
	if !strings.Contains(held, "if currentManagedInstance() != nil {") {
		t.Errorf("claims wait for the startup beat on a self-managed runner too:\n%s", held)
	}
	if strings.Count(body, "t.claimSession(") != 1 {
		t.Error("runLoop claims somewhere other than its claim loop")
	}
}
