package main

import (
	"slices"
	"testing"
	"time"
)

// A turn that ends while the pool drains for an update, with its next message already queued: the
// control plane commits RUNNING, wakes the session's inbox (notifyInbox) and only then answers the
// /turn-complete. The poller can therefore hand the follow-up to the engine before the answer arrives,
// while the turn's permit is still held and nothing is marked held. Held after that, the follow-up was
// a turn the engine was running that the update did not count, so closeForUpdate could stop the runner
// in the middle of it. A follow-up that has passed waitTurnPermit is not held: it is a turn in flight.
func TestAFollowUpTheEngineAlreadyTookIsATurnInFlight(t *testing.T) {
	isolateClaudeRegionEnv(t)
	engineOutwaitsTheTest(t)
	var rig *regionRig
	answering := make(chan struct{})
	status := func(req TurnCompleteRequest) string {
		switch {
		case req.TurnID == "turn-1":
			// notifyInbox before the answer: the follow-up reaches the engine first.
			rig.queue(RunInboxResponse{TurnID: "turn-2", Kind: "message", Content: secondMessage})
			// The engine has the follow-up on its stdin. (Its events cannot be read here: they are flushed
			// behind this completion.)
			deadline := time.Now().Add(fakeClaudeTimeout)
			for userFrames(rig.fake) < 2 && time.Now().Before(deadline) {
				time.Sleep(2 * time.Millisecond)
			}
			close(answering)
			return stRunning
		case turnCompletionEndsSession(req):
			return stFailed
		}
		return stAwaitingInput
	}
	rig = newRegionRig(t, regionAnswerAllowed, anthropicKey(), status,
		fakeStep{Await: "user"}, fakeStep{Emit: "replay_user"}, fakeStep{Emit: "system_init"},
		fakeStep{Emit: "assistant", Text: "renamed it"},
		fakeStep{Await: "release", Text: "end turn one"},
		fakeStep{Emit: "result", Text: "renamed it"},
		fakeStep{Await: "user"}, fakeStep{Emit: "replay_user"},
		fakeStep{Emit: "assistant", Text: "on turn two"},
		fakeStep{Await: "release", Text: "end turn two"},
		fakeStep{Emit: "result", Text: "deleted it"},
		fakeStep{Await: "user"},
	)
	waitUntil(t, func() bool { return rig.hasEvent(evAssistant, "renamed it") }, "turn-1 never started")
	rig.pool.drainForUpdate()
	rig.fake.Release("end turn one")
	select {
	case <-answering:
	case <-time.After(2 * fakeClaudeTimeout):
		t.Fatal("turn-1 was never answered")
	}
	if n := userFrames(rig.fake); n != 2 {
		t.Fatalf("the engine had %d user message(s) when turn-1 was answered, want 2: the ordering under test did not happen", n)
	}

	// Turn-2 runs in the engine from here on until it is released. Give the runner time to act on
	// turn-1's RUNNING answer; at no point may the running turn-2 drop out of the update's count.
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if n := rig.pool.turnsInFlight(); n != 1 {
			t.Fatalf("turnsInFlight while the engine runs turn-2 = %d, want 1: the follow-up it already took was held for the update", n)
		}
		time.Sleep(5 * time.Millisecond)
	}
	if n := rig.pool.closeForUpdate(); n != 1 {
		t.Fatalf("closeForUpdate while the engine runs turn-2 = %d, want 1 and the pool left open", n)
	}

	rig.fake.Release("end turn two")
	rig.awaitSettled("turn-2")
	waitUntil(t, func() bool { return !rig.pool.isActive(rig.live) }, "turn-2's permit was never handed back")
	if n := rig.pool.turnsInFlight(); n != 0 {
		t.Fatalf("turnsInFlight after turn-2 ended = %d, want 0", n)
	}
	rig.mu.Lock()
	handed := slices.Clone(rig.handedOut)
	rig.mu.Unlock()
	if !slices.Contains(handed, "turn-2") {
		t.Fatal("turn-2 was never handed out")
	}
}

// userFrames counts the user messages the fake engine has been written.
func userFrames(f *fakeClaude) int {
	n := 0
	for _, frame := range f.Stdin() {
		if frame["type"] == "user" {
			n++
		}
	}
	return n
}

// heldForUpdate belongs to one permit: once that permit ends, the session's next claim is not held
// by a mark left from a turn before it.
func TestAHeldFollowUpMarkEndsWithItsPermit(t *testing.T) {
	p := newSessionPool(2)
	s := registerPoolSession(t, p, "a", true)
	p.drainForUpdate()
	p.holdFollowUpForUpdate(s, p.permitGeneration(s))
	if startsNow(p, s) {
		t.Fatal("the follow-up started while the pool drained")
	}
	parkPoolSession(p, s)
	p.mu.Lock()
	held := s.heldForUpdate
	p.mu.Unlock()
	if held {
		t.Fatal("heldForUpdate outlived the permit it was set under")
	}
}
