package main

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

// The three facts of the claim's retry backoff: its schedule, that a shutdown is not slept through,
// and that the loop actually spends it. The schedule and the wait are asked of the functions; the
// wiring is asked of `runLoop`'s source, as TestTheRunLoopAdoptsRecordedJobsBeforeAnythingElse asks
// for its own property — nothing fails when a loop stops pacing its retries, it simply hammers a
// control plane that is already unwell, and the symptom is a log full of failures nobody caused.
func TestClaimRetryBackoffDoublesToACap(t *testing.T) {
	want := []time.Duration{
		250 * time.Millisecond,
		500 * time.Millisecond,
		1 * time.Second,
		2 * time.Second,
		4 * time.Second,
		claimRetryMaxDelay,
		claimRetryMaxDelay,
	}
	for failures, expected := range want {
		if got := claimRetryDelayAfter(failures + 1); got != expected {
			t.Errorf("claimRetryDelayAfter(%d) = %s, want %s", failures+1, got, expected)
		}
	}
	// Clamped rather than doubled past the cap: a retry wait that keeps growing outlives the outage
	// it is waiting out, and leaves a recovered control plane idle for as long as it grew.
	for _, failures := range []int{8, 1000} {
		if got := claimRetryDelayAfter(failures); got != claimRetryMaxDelay {
			t.Errorf("claimRetryDelayAfter(%d) = %s, want the cap %s", failures, got, claimRetryMaxDelay)
		}
	}
}

func TestClaimRetryWaitEndsWithItsContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	started := time.Now()
	if claimRetryWait(ctx, 1) {
		t.Fatal("claimRetryWait reported a wait it should not have completed")
	}
	if elapsed := time.Since(started); elapsed > claimRetryInitialDelay {
		t.Fatalf("claimRetryWait slept %s after its context ended", elapsed)
	}
}

func TestTheClaimLoopPacesItsRetries(t *testing.T) {
	src, err := os.ReadFile("runloop.go")
	if err != nil {
		t.Fatalf("read runloop.go: %v", err)
	}
	body := string(src)
	body = body[strings.Index(body, "func runLoop("):]

	// The retryable-failure path, from the failure it logs to the point where the loop gives up on
	// it and goes round again.
	failure := strings.Index(body, `logln("claim failed:", err)`)
	if failure < 0 {
		t.Fatal("runLoop no longer logs a failed claim")
	}
	rest := body[failure:]
	next := strings.Index(rest, "\n\t\tif job == nil {")
	if next < 0 {
		t.Fatal("runLoop's claim failure path has no end: the success branch was not found after it")
	}
	path := rest[:next]
	if !strings.Contains(path, "claimRetryWait(") {
		t.Error("the claim failure path retries without waiting — a flapping control plane turns " +
			"into a storm of claims, each of them followed by a reclaim")
	}
	if !strings.Contains(path, "claimFailures++") {
		t.Error("the claim failure path does not count its failures, so the wait cannot grow")
	}
	// And the wait has to be spent on the SUCCESS path too: a link that answered is a link whose
	// next failure should start over rather than resume a long wait from an earlier outage.
	if !strings.Contains(body, "claimFailures = 0") {
		t.Error("runLoop never resets the claim failure count, so one outage paces every later retry")
	}
}
