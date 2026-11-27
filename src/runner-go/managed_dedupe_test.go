package main

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// fakeDedupe is a homeDedupe on a hand-moved clock whose passes run until the test ends them.
type fakeDedupe struct {
	*homeDedupe
	clockMu sync.Mutex
	at      time.Time
	started chan struct{}
	ended   chan error // what the running pass returns; a pass whose context ends returns ctx.Err()
	done    chan struct{}
}

func newFakeDedupe() *fakeDedupe {
	f := &fakeDedupe{at: time.Unix(1_800_000_000, 0), started: make(chan struct{}, 8),
		ended: make(chan error, 8), done: make(chan struct{}, 8)}
	f.homeDedupe = &homeDedupe{root: "/volume", hashfile: "/volume/.cache/orbit/duperemove.hash", dirty: true,
		now: func() time.Time { f.clockMu.Lock(); defer f.clockMu.Unlock(); return f.at }}
	f.run = func(ctx context.Context, _, _ string) error {
		f.started <- struct{}{}
		defer func() { f.done <- struct{}{} }()
		select {
		case err := <-f.ended:
			return err
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return f
}

func (f *fakeDedupe) advance(d time.Duration) {
	f.clockMu.Lock()
	f.at = f.at.Add(d)
	f.clockMu.Unlock()
}

func (f *fakeDedupe) wait(t *testing.T, ch chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(5 * time.Second):
		t.Fatalf("no pass %s", what)
	}
}

// waitIdle waits for the pass that just returned to be recorded as over.
func (f *fakeDedupe) waitIdle(t *testing.T) {
	t.Helper()
	f.wait(t, f.done, "ended")
	for deadline := time.Now().Add(5 * time.Second); f.inFlight() != 0; {
		if time.Now().After(deadline) {
			t.Fatal("the pass is still counted after it ended")
		}
		time.Sleep(time.Millisecond)
	}
}

func (f *fakeDedupe) noPass(t *testing.T) {
	t.Helper()
	select {
	case <-f.started:
		t.Fatal("a pass started")
	case <-time.After(20 * time.Millisecond):
	}
}

func TestHomeDedupeStartsOnlyAfterIdleDelayAndOncePerChange(t *testing.T) {
	f := newFakeDedupe()
	f.tick(true)
	f.advance(homeDedupeIdleDelay - time.Second)
	f.tick(true)
	f.noPass(t)
	if f.inFlight() != 0 {
		t.Fatal("counted before any pass")
	}

	f.advance(time.Second)
	f.tick(true)
	f.wait(t, f.started, "started")
	if f.inFlight() != 1 {
		t.Fatal("a running pass must count as an operation")
	}
	f.tick(true) // a second beat while it runs starts nothing more
	f.ended <- nil
	f.waitIdle(t)

	// Nothing written since: idle beats start no other pass.
	f.advance(time.Hour)
	f.tick(true)
	f.noPass(t)

	// Work, then idle again: the next pass, once the delay has passed.
	f.tick(false)
	f.tick(true)
	f.noPass(t)
	f.advance(homeDedupeIdleDelay)
	f.tick(true)
	f.wait(t, f.started, "started after work")
	f.ended <- nil
	f.waitIdle(t)
}

func TestHomeDedupeWorkStopsARunningPass(t *testing.T) {
	f := newFakeDedupe()
	f.tick(true)
	f.advance(homeDedupeIdleDelay)
	f.tick(true)
	f.wait(t, f.started, "started")

	f.tick(false) // a turn starts
	f.waitIdle(t)

	// The volume is looked at again once idle comes back.
	f.tick(true)
	f.advance(homeDedupeIdleDelay)
	f.tick(true)
	f.wait(t, f.started, "restarted")
	f.stop()
	f.waitIdle(t)
}

func TestHomeDedupeFailedPassWaitsBeforeRetrying(t *testing.T) {
	f := newFakeDedupe()
	f.tick(true)
	f.advance(homeDedupeIdleDelay)
	f.tick(true)
	f.wait(t, f.started, "started")
	f.ended <- errors.New("exit status 1")
	f.waitIdle(t)

	f.advance(homeDedupeRetryDelay - time.Minute)
	f.tick(true)
	f.noPass(t)
	f.advance(time.Minute)
	f.tick(true)
	f.wait(t, f.started, "retried")
	f.ended <- nil
	f.waitIdle(t)
}

func TestHomeDedupeNilIsOff(t *testing.T) {
	var d *homeDedupe
	d.tick(true)
	d.stop()
	if d.inFlight() != 0 {
		t.Fatal("a nil scheduler counts nothing")
	}
}
