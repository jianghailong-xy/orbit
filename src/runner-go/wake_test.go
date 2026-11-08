package main

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

// A wake moves the heartbeat forward; a poll that timed out does not.
func TestWakeLoopBeatsOnlyWhenWoken(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	answers := []bool{false, true, false, true}
	var polls, beats atomic.Int32
	done := make(chan struct{})
	go func() {
		defer close(done)
		runWakeLoop(ctx, func(context.Context) (bool, error) {
			n := int(polls.Add(1)) - 1
			if n == len(answers) {
				cancel()
				return false, ctx.Err()
			}
			return answers[n], nil
		}, func() { beats.Add(1) })
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the wake loop did not stop with its context")
	}
	if got := beats.Load(); got != 2 {
		t.Fatalf("beats = %d, want one per wake (2)", got)
	}
}
