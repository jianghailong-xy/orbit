package main

import (
	"context"
	"errors"
	"net/http"
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

// A control plane without the route answers 404 forever; the loop leaves the heartbeat to it.
func TestWakeLoopStopsOnAControlPlaneWithoutTheRoute(t *testing.T) {
	var polls atomic.Int32
	done := make(chan struct{})
	go func() {
		defer close(done)
		runWakeLoop(context.Background(), func(context.Context) (bool, error) {
			polls.Add(1)
			return false, &transportHTTPError{method: "GET", path: "/runner/wake", statusCode: http.StatusNotFound}
		}, func() { t.Error("beat on a 404") })
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the wake loop kept polling a route that does not exist")
	}
	if polls.Load() != 1 {
		t.Fatalf("polls = %d, want 1", polls.Load())
	}
}

// Any other failure is a control plane that is down or restarting: rest, then poll again.
func TestWakeLoopRestsAfterAFailedPoll(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var polls atomic.Int32
	done := make(chan struct{})
	go func() {
		defer close(done)
		runWakeLoop(ctx, func(context.Context) (bool, error) {
			polls.Add(1)
			return false, errors.New("connection refused")
		}, func() {})
	}()
	time.Sleep(200 * time.Millisecond)
	cancel()
	<-done
	if polls.Load() != 1 {
		t.Fatalf("polls = %d within the retry delay, want 1", polls.Load())
	}
}
