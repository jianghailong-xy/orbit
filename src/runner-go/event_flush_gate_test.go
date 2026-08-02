package main

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

func TestEventEmissionGateSealWaitsAndRejectsLateEmitters(t *testing.T) {
	gate := &eventEmissionGate{}
	entered := make(chan struct{})
	release := make(chan struct{})
	firstDone := make(chan struct{})
	go func() {
		gate.run(func() {
			close(entered)
			<-release
		})
		close(firstDone)
	}()
	<-entered

	sealed := make(chan struct{})
	go func() {
		gate.seal()
		close(sealed)
	}()
	select {
	case <-sealed:
		t.Fatal("seal returned before the admitted emitter completed")
	case <-time.After(20 * time.Millisecond):
	}
	close(release)
	select {
	case <-firstDone:
	case <-time.After(time.Second):
		t.Fatal("admitted emitter did not complete")
	}
	select {
	case <-sealed:
	case <-time.After(time.Second):
		t.Fatal("seal did not complete after the emitter exited")
	}

	var late atomic.Bool
	if gate.run(func() { late.Store(true) }) {
		t.Fatal("sealed gate admitted a late emitter")
	}
	if late.Load() {
		t.Fatal("late emitter callback ran after seal")
	}
}

func TestEventFlushGateJoinsAnInflightSend(t *testing.T) {
	gate := newEventFlushGate()
	firstStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	firstDone := make(chan error, 1)
	go func() {
		firstDone <- gate.run(context.Background(), func(context.Context) error {
			close(firstStarted)
			<-releaseFirst
			return nil
		})
	}()
	<-firstStarted

	secondStarted := make(chan struct{})
	secondDone := make(chan error, 1)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	go func() {
		secondDone <- gate.run(ctx, func(context.Context) error {
			close(secondStarted)
			return nil
		})
	}()

	select {
	case <-secondStarted:
		t.Fatal("second send crossed the gate while the first send was in flight")
	case <-time.After(25 * time.Millisecond):
	}
	close(releaseFirst)
	if err := <-firstDone; err != nil {
		t.Fatalf("first send: %v", err)
	}
	select {
	case <-secondStarted:
	case <-time.After(time.Second):
		t.Fatal("second send did not cross the gate after the first completed")
	}
	if err := <-secondDone; err != nil {
		t.Fatalf("second send: %v", err)
	}
}

func TestEventFlushGateHonorsAWaitingDrainDeadline(t *testing.T) {
	gate := newEventFlushGate()
	firstStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	firstDone := make(chan error, 1)
	go func() {
		firstDone <- gate.run(context.Background(), func(context.Context) error {
			close(firstStarted)
			<-releaseFirst
			return nil
		})
	}()
	<-firstStarted

	called := false
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	err := gate.run(ctx, func(context.Context) error {
		called = true
		return nil
	})
	cancel()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("waiting drain error = %v, want deadline exceeded", err)
	}
	if called {
		t.Fatal("timed-out drain unexpectedly started its send")
	}
	close(releaseFirst)
	if err := <-firstDone; err != nil {
		t.Fatalf("first send: %v", err)
	}
}
