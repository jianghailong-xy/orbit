package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The late check has to come after the last moment the control plane can still commit a claim the
// runner gave up on, or it looks before that claim lands and the session stays RUNNING with nobody
// supervising it. Read from the control plane's own source, so a longer poll there fails here instead
// of quietly reopening the window.
func TestTheLateClaimCheckWaitsOutTheControlPlanesClaim(t *testing.T) {
	longPoll := tsMillis(t, filepath.Join("..", "apiserver", "src", "runner-api", "runner-api.controller.ts"),
		`const LONG_POLL_MS = ([\d_]+);`)
	connectionWait := tsMillis(t, filepath.Join("..", "apiserver", "src", "common", "transaction-retry.ts"),
		`export const RUNNER_POLL_TRANSACTION_MAX_WAIT_MS = ([\d_]+);`)
	// The claim sets no transaction timeout of its own, so it runs under Prisma's default.
	const transactionTimeout = 5 * time.Second
	if latest := longPoll + connectionWait + transactionTimeout; lateClaimWindow <= latest {
		t.Fatalf("lateClaimWindow is %s, but the control plane can commit a claim %s after the request began", lateClaimWindow, latest)
	}
}

func TestTheClaimLoopLooksAgainForALateClaim(t *testing.T) {
	src, err := os.ReadFile("runloop.go")
	if err != nil {
		t.Fatalf("read runloop.go: %v", err)
	}
	body := string(src)
	body = body[strings.Index(body, "func runLoop("):]
	loop := strings.Index(body, "\tfor loopCtx.Err() == nil {")
	if loop < 0 {
		t.Fatal("runLoop's claim loop was not found")
	}

	// Armed before the claim loop, for the claim the process this one replaced may have left open.
	if !strings.Contains(body[:loop], "lateClaimCheckAt := time.Now().Add(lateClaimWindow)") {
		t.Error("runLoop does not schedule a late claim check at startup: a claim the previous process " +
			"left open lands after the startup reclaim and nothing ever supervises it")
	}

	// Once due, it reconciles, starts what it finds, and is spent.
	inLoop := body[loop:]
	check := strings.Index(inLoop, "if !lateClaimCheckAt.IsZero() && time.Now().After(lateClaimCheckAt) {")
	if check < 0 {
		t.Fatal("the claim loop never runs the late claim check")
	}
	block := inLoop[check:]
	block = block[:strings.Index(block, "\n\t\t}\n")]
	for _, want := range []string{
		"lateClaimCheckAt = time.Time{}",
		"reclaimMissingSessions(loopCtx, t, pool.reclaimStates, prepareTakeover)",
		"startSession(pending.job, pending.initiallyActive)",
		"pending.endTakeover()",
	} {
		if !strings.Contains(block, want) {
			t.Errorf("the late claim check does not run %q", want)
		}
	}

	// And a failed claim owes one: its request's claim may commit after the reconciliation it just ran.
	failure := strings.Index(inLoop, `logln("claim failed:", err)`)
	if failure < 0 {
		t.Fatal("runLoop no longer logs a failed claim")
	}
	next := strings.Index(inLoop[failure:], "\n\t\tif job == nil {")
	if next < 0 {
		t.Fatal("runLoop's claim failure path has no end: the success branch was not found after it")
	}
	if !strings.Contains(inLoop[failure:failure+next], "lateClaimCheckAt = time.Now().Add(lateClaimWindow)") {
		t.Error("a failed claim does not schedule a late claim check")
	}
}

// tsMillis reads one millisecond constant out of a control-plane source file.
func tsMillis(t *testing.T, file, pattern string) time.Duration {
	t.Helper()
	src, err := os.ReadFile(file)
	if err != nil {
		t.Fatalf("read %s: %v", file, err)
	}
	m := regexp.MustCompile(pattern).FindSubmatch(src)
	if m == nil {
		t.Fatalf("%s no longer declares %s", file, pattern)
	}
	ms, err := strconv.Atoi(strings.ReplaceAll(string(m[1]), "_", ""))
	if err != nil {
		t.Fatalf("%s: %v", file, err)
	}
	return time.Duration(ms) * time.Millisecond
}
