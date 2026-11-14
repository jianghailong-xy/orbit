package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The owner's Update Now (docs/runner-update-drain-design.md §4, D4), on the pool's fake clock: with
// turns in flight the next check takes the release at once — no deferral limit, no quiet window — the
// pool closes for it, the report says restarting with the turns it interrupts, and the stop it asks
// for is the one that interrupts them (errRunnerUpdateNow). An automatic check still waits.
func TestUpdateNowTakesTheReleaseWithTurnsInFlight(t *testing.T) {
	resetSelfUpdateStatus(t)
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Cleanup(func() { updateNowTarget.Store(nil) })

	clock := newFakePoolClock()
	p := newSessionPoolWithClock(4, clock)
	registerPoolSession(t, p, "a", true)
	registerPoolSession(t, p, "b", true)
	gate := newSelfUpdateGate(func(context.Context, string) (string, bool) { return "0.1.254", true },
		p, noOperations, selfUpdateCheckInterval, selfUpdateDeferralLimit, selfUpdateQuietWindow)

	if _, ok := gate.take(context.Background(), ""); ok {
		t.Fatal("an automatic check took the release with two turns in flight")
	}
	if gate.stopsForUpdateNow() {
		t.Fatal("an automatic check asked for the interrupting stop")
	}
	if !gate.updateNow() {
		t.Fatal("Update Now refused with a release waiting")
	}
	remote, ok := gate.take(context.Background(), "")
	if !ok || remote != "0.1.254" {
		t.Fatalf("the check after Update Now = %q, %v; want 0.1.254, true", remote, ok)
	}
	if !gate.stopsForUpdateNow() {
		t.Fatal("Update Now's release does not ask for the interrupting stop")
	}
	p.mu.Lock()
	closed := p.closedForUpdate
	p.mu.Unlock()
	if !closed {
		t.Fatal("the pool is not closed for the update once Update Now took the release: a turn could begin")
	}
	report := selfUpdateReport()
	if report == nil || report.Phase != selfUpdatePhaseRestarting || report.TargetVersion != "0.1.254" || report.InterruptedTurns != 2 {
		t.Fatalf("report = %+v; want restarting into 0.1.254 with 2 interrupted turns", report)
	}
	if got := stopInterruptPayload(stoppedFor(errRunnerUpdateNow)); got["reason"] != interruptReasonRunnerUpdate || got["targetVersion"] != "0.1.254" {
		t.Fatalf("the interrupt Update Now's stop marks a turn with = %v; want runner_update naming 0.1.254", got)
	}
	if gate.updateNow() {
		t.Fatal("a second Update Now was taken while the first restarts")
	}
	t.Logf("report while restarting: phase %s, target %s, interruptedTurns %d", report.Phase, report.TargetVersion, report.InterruptedTurns)
}

// Update Now during a postponement ends it and takes the release; with no release waiting it is
// answered (logged) and forgotten, so a later automatic check is not taken as the owner's.
func TestUpdateNowEndsAPostponementAndIsForgottenWithNoRelease(t *testing.T) {
	resetSelfUpdateStatus(t)
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Cleanup(func() { updateNowTarget.Store(nil) })

	clock := newFakePoolClock()
	p := newSessionPoolWithClock(4, clock)
	registerPoolSession(t, p, "a", true)
	var release atomic.Value
	release.Store("0.1.254")
	gate := newSelfUpdateGate(func(context.Context, string) (string, bool) {
		r := release.Load().(string)
		return r, r != ""
	}, p, noOperations, selfUpdateCheckInterval, selfUpdateDeferralLimit, selfUpdateQuietWindow)

	gate.take(context.Background(), "")
	if !gate.postpone(clock.Now().Add(time.Hour)) {
		t.Fatal("postpone refused")
	}
	gate.updateNow()
	if remote, ok := gate.take(context.Background(), ""); !ok || remote != "0.1.254" {
		t.Fatalf("Update Now during a postponement: take = %q, %v; want the release", remote, ok)
	}

	// A fresh gate whose check finds nothing: Update Now is dropped, not kept for the next release.
	resetSelfUpdateStatus(t)
	p2 := newSessionPoolWithClock(4, clock)
	registerPoolSession(t, p2, "a", true)
	release.Store("")
	gate2 := newSelfUpdateGate(func(context.Context, string) (string, bool) {
		r := release.Load().(string)
		return r, r != ""
	}, p2, noOperations, selfUpdateCheckInterval, selfUpdateDeferralLimit, selfUpdateQuietWindow)
	gate2.updateNow()
	if _, ok := gate2.take(context.Background(), ""); ok {
		t.Fatal("took an update with no release")
	}
	release.Store("0.1.255")
	if _, ok := gate2.take(context.Background(), ""); ok || gate2.stopsForUpdateNow() {
		t.Fatalf("a later automatic check with a turn in flight took the release (ok %v, interrupting %v)", ok, gate2.stopsForUpdateNow())
	}
}

func stoppedFor(cause error) context.Context {
	ctx, stop := context.WithCancelCause(context.Background())
	stop(cause)
	return ctx
}

// The Claude supervisor's drain under Update Now's stop: the turn in flight is cut at once — not after
// the drain budget, an hour here — and marked interrupted with reason runner_update and the release.
// Any other stop keeps the drain, and a self-update that is not Update Now does too.
func TestUpdateNowCutsTheClaudeTurnAtOnce(t *testing.T) {
	updateNowTarget.Store(ptr("0.1.254"))
	t.Cleanup(func() { updateNowTarget.Store(nil) })
	for _, tc := range []struct {
		name   string
		cause  error
		reason string
	}{
		{"update now", errRunnerUpdateNow, interruptReasonRunnerUpdate},
		{"automatic update", errRunnerSelfUpdate, interruptReasonRunnerRestart},
		{"service stop", nil, interruptReasonRunnerRestart},
	} {
		t.Run(tc.name, func(t *testing.T) {
			procCtx, procCancel := context.WithCancel(context.Background())
			defer procCancel()
			shutdownCtx, shutdown := context.WithCancelCause(context.Background())
			pending := make(chan string, 1)
			pending <- "turn-1"
			probe := &drainProbe{}
			budget := time.Hour
			if tc.cause != errRunnerUpdateNow {
				budget = 300 * time.Millisecond
			}
			done := make(chan struct{})
			start := time.Now()
			go func() {
				defer close(done)
				watchShutdownDrain(procCtx, shutdownCtx, pending, new(atomic.Int32), budget, func() {},
					func() { probe.mu.Lock(); probe.torndown = true; probe.mu.Unlock(); procCancel() }, probe.emit, "s-1")
			}()
			shutdown(tc.cause)
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("the drain watcher never returned")
			}
			took := time.Since(start)
			interrupts := probe.interrupts()
			if len(interrupts) != 1 || interrupts[0].Payload["reason"] != tc.reason {
				t.Fatalf("interrupts = %+v; want one with reason %s", interrupts, tc.reason)
			}
			if tc.cause == errRunnerUpdateNow {
				if took > time.Second {
					t.Fatalf("Update Now's stop cut the turn after %s; want at once", took)
				}
				if interrupts[0].Payload["targetVersion"] != "0.1.254" {
					t.Fatalf("interrupt payload = %v; want targetVersion 0.1.254", interrupts[0].Payload)
				}
			} else if took < 250*time.Millisecond {
				t.Fatalf("a %s cut the turn after %s, before its drain", tc.name, took)
			}
			t.Logf("%s: cut after %s with %v", tc.name, took.Round(time.Millisecond), interrupts[0].Payload)
		})
	}
}

// A shell turn the runner runs itself — an acceptance command whose -1 would fail its task — is not
// an engine's turn: Update Now's stop still gives it the drain.
func TestUpdateNowLetsAShellTurnDrain(t *testing.T) {
	procCtx, procCancel := context.WithCancel(context.Background())
	defer procCancel()
	shutdownCtx, shutdown := context.WithCancelCause(context.Background())
	shells := new(atomic.Int32)
	shells.Store(1)
	probe := &drainProbe{}
	done := make(chan struct{})
	go func() {
		defer close(done)
		watchShutdownDrain(procCtx, shutdownCtx, make(chan string), shells, 5*time.Second, func() {},
			func() { procCancel() }, probe.emit, "s-1")
	}()
	shutdown(errRunnerUpdateNow)
	time.Sleep(300 * time.Millisecond)
	shells.Store(0)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the drain watcher never returned")
	}
	if n := len(probe.interrupts()); n != 0 {
		t.Fatalf("a shell turn that finished in the drain was marked interrupted %d time(s)", n)
	}
}

// Codex under Update Now's stop: the turn running in the app-server is cut at once, not after the
// 100 s drain, and marked interrupted — today's Codex drain marks nothing — with reason runner_update.
// The turn is not completed, so the control plane hands it back as the update's continuation once the
// updated runner reclaims the session.
func TestUpdateNowCutsTheCodexTurnAtOnceAndMarksIt(t *testing.T) {
	updateNowTarget.Store(ptr("0.1.254"))
	t.Cleanup(func() { updateNowTarget.Store(nil) })
	fake := newFakeCodexBinary(t, map[string]interface{}{}, map[string]interface{}{})
	fake.useAsRunnerDefault(t)
	fake.answerSessionsWith(t)
	// The turn starts and never completes: a long turn in flight.
	fake.answerTurnsWith(t, []map[string]interface{}{
		{"method": "item/agentMessage/delta", "params": map[string]interface{}{"threadId": "thread-fake-session", "delta": "working"}},
	})
	var served atomic.Bool
	inbox := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/inbox") && served.CompareAndSwap(false, true) {
			_, _ = w.Write([]byte(`{"turnId":"orbit-turn-1","kind":"message","content":"a long turn"}`))
			return
		}
		select {
		case <-r.Context().Done():
		case <-time.After(200 * time.Millisecond):
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(inbox.Close)

	var mu sync.Mutex
	var marks []RunEvent
	started := make(chan struct{}, 1)
	emitFor := func(turnID, kind string, payload map[string]interface{}) {
		mu.Lock()
		defer mu.Unlock()
		if kind == evInterrupt {
			marks = append(marks, RunEvent{Type: kind, TurnID: turnID, Payload: payload})
		}
	}
	emit := func(kind string, payload map[string]interface{}) {
		if kind == evAssistant || kind == evUser {
			select {
			case started <- struct{}{}:
			default:
			}
		}
	}
	var completed atomic.Int32
	job := &ClaimedSession{SessionID: "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e40", Provider: providerCodex, Agent: AgentExecConfig{Provider: providerCodex}}
	shutdownCtx, shutdown := context.WithCancelCause(context.Background())
	ended := make(chan struct{})
	var status string
	var resumable bool
	go func() {
		defer close(ended)
		status, resumable, _ = runCodexAppServerSessionProcess(context.Background(), shutdownCtx, NewTransport(inbox.URL, "runner-token"), job, "", t.TempDir(), t.TempDir(),
			emit, emitFor, func(string) {}, false, nil, nil,
			func(TurnCompleteRequest, ...context.Context) error { completed.Add(1); return nil },
			func(context.Context) bool { return true }, func(error) {})
	}()
	select {
	case <-started:
	case <-time.After(30 * time.Second):
		t.Fatal("the turn never started")
	}
	// Until turn/start is answered the runner does not know the turn is in flight in the app-server.
	deadline := time.Now().Add(10 * time.Second)
	for {
		n := 0
		for _, line := range fake.lines(t, "requests.jsonl") {
			if strings.Contains(line, `"turn/start"`) {
				n++
			}
		}
		if n > 0 || time.Now().After(deadline) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	time.Sleep(200 * time.Millisecond)
	stop := time.Now()
	shutdown(errRunnerUpdateNow)
	select {
	case <-ended:
	case <-time.After(10 * time.Second):
		t.Fatal("the Codex session did not detach after Update Now's stop")
	}
	took := time.Since(stop)
	if took > 5*time.Second {
		t.Fatalf("Update Now's stop took %s to cut the Codex turn; want well under the %s drain", took, shutdownDrainTimeout)
	}
	if status != stCancelled || !resumable {
		t.Fatalf("the session ended %q, resumable %v; want cancelled and resumable (detached for the reclaim)", status, resumable)
	}
	if completed.Load() != 0 {
		t.Fatal("the cut turn was completed; the control plane would not hand it back")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(marks) != 1 || marks[0].TurnID != "orbit-turn-1" || marks[0].Payload["reason"] != interruptReasonRunnerUpdate || marks[0].Payload["targetVersion"] != "0.1.254" {
		t.Fatalf("interrupt marks = %+v; want one on orbit-turn-1 with runner_update and 0.1.254", marks)
	}
	t.Logf("Codex turn cut %s after the stop, marked %v, completed %d time(s)", took.Round(time.Millisecond), marks[0].Payload, completed.Load())
}

// The image an update restarted into says how long the restart took and how many turns it
// interrupted, once: the Updated card's "Took 34 s. 2 interrupted turns resumed".
func TestTheRestartIsMeasuredOnceTheNewImageStarts(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Cleanup(func() { updateNowRestart.startedAt.Store(nil); updateNowRestart.interrupted.Store(0) })
	saved := version
	t.Cleanup(func() { version = saved })

	stoppedAt := time.Date(2026, 11, 12, 12, 20, 26, 0, time.UTC)
	noteUpdateRestart(stoppedAt, 2)
	recordSelfUpdate("0.1.253", "0.1.254", stoppedAt.Add(20*time.Second))
	version = "0.1.254"
	markSelfUpdateBack(stoppedAt.Add(34 * time.Second))
	markSelfUpdateBack(stoppedAt.Add(time.Hour)) // a later start of the same image is not the restart
	rec := lastSelfUpdate()
	if rec.restartSeconds() != 34 || rec.InterruptedTurns != 2 {
		t.Fatalf("record = %+v (%d s); want 34 s and 2 interrupted turns", rec, rec.restartSeconds())
	}
	b, _ := os.ReadFile(filepath.Join(os.Getenv("ORBIT_HOME"), "self-update.json"))
	t.Logf("self-update.json: %s", b)
}

func ptr[T any](v T) *T { return &v }

// The runner declares it honours Update Now under the name the control plane checks, and its interrupt
// reason is the one the control plane reads.
func TestTheRunnerDeclaresSelfUpdateNow(t *testing.T) {
	if !strings.Contains(","+runnerCapabilitiesV1+",", ","+selfUpdateNowCapabilityV1+",") {
		t.Fatalf("this runner does not declare %s: %q", selfUpdateNowCapabilityV1, runnerCapabilitiesV1)
	}
	shared, err := os.ReadFile(filepath.Join("..", "shared", "src", "dto.ts"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"SELF_UPDATE_NOW_V1 = '" + selfUpdateNowCapabilityV1 + "'",
		"RUNNER_UPDATE_INTERRUPT_REASON = '" + interruptReasonRunnerUpdate + "'",
	} {
		if !strings.Contains(string(shared), want) {
			t.Errorf("@orbit/shared does not say %s", want)
		}
	}
}
