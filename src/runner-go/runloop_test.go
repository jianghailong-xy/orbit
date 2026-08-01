package main

import (
	"context"
	"os"
	"reflect"
	"syscall"
	"testing"
	"time"
)

func TestWaitForRunLoopStopUpdate(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	reason, remote := waitForRunLoopStop(ctx, nil, "https://control.example", time.Millisecond,
		func(_ context.Context, server string) (string, bool) {
			if server != "https://control.example" {
				t.Errorf("server = %q", server)
			}
			return "0.1.81", true
		})
	if reason != runLoopStopUpdate || remote != "0.1.81" {
		t.Fatalf("stop = %v, %q; want update, 0.1.81", reason, remote)
	}
}

func TestWaitForRunLoopStopSignalDoesNotRequestUpdate(t *testing.T) {
	signals := make(chan os.Signal, 1)
	signals <- syscall.SIGTERM
	checks := 0
	reason, remote := waitForRunLoopStop(context.Background(), signals, "https://control.example", time.Hour,
		func(context.Context, string) (string, bool) {
			checks++
			return "99.0.0", true
		})
	if reason != runLoopStopSignal || remote != "" {
		t.Fatalf("stop = %v, %q; want signal", reason, remote)
	}
	if checks != 0 {
		t.Fatalf("update checker called %d time(s) after SIGTERM, want 0", checks)
	}
}

func TestWaitForRunLoopStopSignalWinsDuringUpdateCheck(t *testing.T) {
	signals := make(chan os.Signal, 1)
	checkStarted := make(chan struct{})
	finishCheck := make(chan struct{})
	result := make(chan runLoopStopReason, 1)
	go func() {
		reason, _ := waitForRunLoopStop(context.Background(), signals, "https://control.example", time.Millisecond,
			func(context.Context, string) (string, bool) {
				close(checkStarted)
				<-finishCheck
				return "0.1.81", true
			})
		result <- reason
	}()

	select {
	case <-checkStarted:
	case <-time.After(time.Second):
		t.Fatal("update check did not start")
	}
	signals <- syscall.SIGTERM
	close(finishCheck)
	select {
	case reason := <-result:
		if reason != runLoopStopSignal {
			t.Fatalf("stop = %v, want SIGTERM to win over update", reason)
		}
	case <-time.After(time.Second):
		t.Fatal("waitForRunLoopStop did not return")
	}
}

func TestWaitForRunLoopStopContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	reason, remote := waitForRunLoopStop(ctx, nil, "https://control.example", time.Hour, nil)
	if reason != runLoopStopNone || remote != "" {
		t.Fatalf("stop = %v, %q; want context cancellation", reason, remote)
	}
}

func TestRestartForUpdateYieldsToSignalReceivedWhileDraining(t *testing.T) {
	signals := make(chan os.Signal, 1)
	signals <- syscall.SIGTERM
	if restartForUpdate(true, false, signals) {
		t.Fatal("restartForUpdate = true with pending SIGTERM, want normal exit")
	}
	if restartForUpdate(false, false, nil) {
		t.Fatal("restartForUpdate = true without update request")
	}
	if restartForUpdate(true, true, nil) {
		t.Fatal("restartForUpdate = true after drain timeout")
	}
}

func TestSelfUpdateSupervisorReexecsInsteadOfReusingStoppedRunLoop(t *testing.T) {
	var events []string
	superviseSelfUpdates("https://control.example",
		func(server string) { events = append(events, "update:"+server) },
		func() bool {
			events = append(events, "loop")
			return true
		},
		func() error {
			events = append(events, "reexec")
			return nil
		})
	want := []string{
		"update:https://control.example", "loop", "update:https://control.example", "reexec",
	}
	if !reflect.DeepEqual(events, want) {
		t.Fatalf("events = %#v, want %#v", events, want)
	}
}

func TestCarryOverModelCatalog(t *testing.T) {
	prev := &ModelCatalog{
		Codex:  []ModelInfo{{Value: "gpt-5.6-sol", Label: "GPT-5.6-Sol", ContextWindow: 372_000}},
		Claude: []ModelInfo{{Value: "claude-opus-5", Label: "Opus 5"}},
	}

	// Claude refreshed, `codex debug models` failed → keep the last good Codex list rather than
	// heartbeating a catalog that blanks it (which would drop the clients to a default window).
	merged := carryOverModelCatalog(prev, &ModelCatalog{
		Claude: []ModelInfo{{Value: "claude-opus-6", Label: "Opus 6"}},
	})
	if len(merged.Codex) != 1 || merged.Codex[0].ContextWindow != 372_000 {
		t.Fatalf("Codex = %#v, want the previous list carried over", merged.Codex)
	}
	if len(merged.Claude) != 1 || merged.Claude[0].Value != "claude-opus-6" {
		t.Fatalf("Claude = %#v, want this round's list", merged.Claude)
	}

	// A fresh Codex list always wins — carrying over must never pin a stale window.
	merged = carryOverModelCatalog(prev, &ModelCatalog{
		Codex: []ModelInfo{{Value: "gpt-5.7", Label: "GPT-5.7", ContextWindow: 512_000}},
	})
	if len(merged.Codex) != 1 || merged.Codex[0].ContextWindow != 512_000 {
		t.Fatalf("Codex = %#v, want this round's list", merged.Codex)
	}
	if len(merged.Claude) != 1 || merged.Claude[0].Value != "claude-opus-5" {
		t.Fatalf("Claude = %#v, want the previous list carried over", merged.Claude)
	}

	// First refresh after startup has nothing to carry over.
	first := &ModelCatalog{Codex: []ModelInfo{{Value: "gpt-5.6-sol", Label: "GPT-5.6-Sol"}}}
	if got := carryOverModelCatalog(nil, first); got != first {
		t.Fatalf("carryOverModelCatalog(nil, first) = %#v, want first unchanged", got)
	}
}
