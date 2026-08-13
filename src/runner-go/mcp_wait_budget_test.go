package main

import (
	"os"
	"testing"
	"time"
)

// A nested session_create(wait) must settle inside the wait that is waiting on it. The
// parent's budget has to cover its child's ENTIRE execution, so a child that may wait just
// as long as its parent can spend the whole budget on its own nested wait — the outer call
// then times out and hands back a still-PENDING session, which reads exactly like slow but
// healthy progress.
func TestSessionWaitBudgetShrinksWithDepth(t *testing.T) {
	root := sessionWaitPolls(0)
	if root != maxSessionWaitPolls {
		t.Fatalf("a root keeps the full budget: got %d, want %d", root, maxSessionWaitPolls)
	}
	prev := root
	for depth := 1; depth <= 5; depth++ {
		got := sessionWaitPolls(depth)
		if got > prev {
			t.Fatalf("depth %d must not exceed depth %d: %d > %d", depth, depth-1, got, prev)
		}
		if got < minSessionWaitPolls {
			t.Fatalf("depth %d fell under the floor: %d < %d", depth, got, minSessionWaitPolls)
		}
		prev = got
	}
}

// The containment property itself: at every supported depth a child's whole wait fits
// strictly inside its parent's, so the parent outlives it and returns a settled answer.
func TestNestedWaitFinishesBeforeItsParent(t *testing.T) {
	for depth := 0; depth < 5; depth++ {
		parent := time.Duration(sessionWaitPolls(depth)) * sessionWaitInterval
		child := time.Duration(sessionWaitPolls(depth+1)) * sessionWaitInterval
		if child >= parent {
			t.Fatalf("depth %d: child waits %s, parent only %s — the parent times out first",
				depth+1, child, parent)
		}
	}
}

// An older server does not send the depth. Falling back to 0 keeps exactly the previous
// single-budget behaviour rather than silently shortening every wait on the machine.
func TestSpawnDepthDefaultsToRootWhenUnset(t *testing.T) {
	for _, v := range []string{"", "   ", "not-a-number", "-3"} {
		t.Setenv(envSpawnDepth, v)
		if got := spawnDepthFromEnv(); got != 0 {
			t.Fatalf("%q should read as depth 0, got %d", v, got)
		}
	}
	os.Unsetenv(envSpawnDepth)
	if got := spawnDepthFromEnv(); got != 0 {
		t.Fatalf("unset should read as depth 0, got %d", got)
	}
	t.Setenv(envSpawnDepth, "2")
	if got := spawnDepthFromEnv(); got != 2 {
		t.Fatalf("depth 2 should parse, got %d", got)
	}
}
