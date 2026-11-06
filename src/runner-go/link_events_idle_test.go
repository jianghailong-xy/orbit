package main

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

// What an earlier process left in the spool of a session the runner takes back idle goes at the runner's start, not at
// the session's next claim (link_events_idle.go, task 34mwBTpOPo3S9LM2SXs10).

// idleSession registers a session cold, as the startup reclaim registers one that is not RUNNING, and waits for its
// claim the way runLoop does; the result is waitActiveSendingHeld's.
func idleSession(t *testing.T, tr *Transport, pool *sessionPool, sessionID string) (*ClaimedSession, *liveSession, context.CancelFunc, <-chan bool) {
	t.Helper()
	job := &ClaimedSession{SessionID: sessionID, Title: "an idle session", Reclaimed: true}
	ctx, cancel := context.WithCancel(context.Background())
	live, added := pool.register(job, cancel, false)
	if !added {
		t.Fatal("the session was not registered")
	}
	done := make(chan bool, 1)
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		done <- waitActiveSendingHeld(tr, pool, live, sessionID, ctx, context.Background())
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-finished:
		case <-time.After(10 * time.Second):
			t.Error("the idle session's wait did not end when it was cancelled")
		}
	})
	return job, live, cancel, done
}

// The stream's sender sends it on the work connection at once, under this process's lease, though nobody claims the
// session; the session stays idle meanwhile, and the spool is emptied.
func TestAnIdleSessionsSpoolGoesAtStartupOverTheLink(t *testing.T) {
	r, in := newLinkEventsRig(t)
	in.preload("session-idle", seqRangeU(1, 9)...)
	spoolLeftBehind(t, r.m.events.spool.dir, "session-idle", 10, 56, "turn-0")
	r.useLink(t)
	pool := newSessionPool(4)
	_, live, _, done := idleSession(t, r.t, pool, "session-idle")
	linkWaitFor(t, 20*time.Second, "the idle session's spool to be stored", func() bool {
		seqs, _, _ := in.storedSeqs("session-idle")
		return len(seqs) == 65
	})
	in.assertContiguous(t, "session-idle", 1, 65)
	linkWaitFor(t, 5*time.Second, "the spool to be emptied", func() bool { return len(spoolFiles(r.m.events.spool.dir)) == 0 })
	// The last segment goes as its batch is stored; the send says so on its next pass, once it finds nothing held.
	waitUntil(t, func() bool {
		return logged(r.logs, "the events idle session session-idle held through seq 65 are stored")
	},
		"the runner never said the idle session's spool was stored")
	if pool.isActive(live) {
		t.Error("sending the spool made the idle session active")
	}
	select {
	case <-done:
		t.Error("the idle session stopped waiting for its claim once its spool was sent")
	default:
	}
	if !logged(r.logs, "session session-idle is idle; the 56 events through seq 65 an earlier process could not send go now, not at its next claim") {
		t.Errorf("the runner did not say what it sent: %v", r.logs.all())
	}
}

// A claim while the spool is still going ends the send at once: the session's supervisor starts, and sends what is left
// first itself. What was out is still on disk.
func TestAClaimEndsTheIdleSessionsSendAndItsSupervisorTakesOver(t *testing.T) {
	r, in := newLinkEventsRig(t)
	in.preload("sess-claimed", seqRangeU(1, 9)...)
	in.setDown(true) // the control plane stores nothing while the send goes on
	spoolLeftBehind(t, r.m.events.spool.dir, "sess-claimed", 10, 20, "turn-0")
	r.useLink(t)
	pool := newSessionPool(4)
	job, _, _, done := idleSession(t, r.t, pool, "sess-claimed")
	linkWaitFor(t, 10*time.Second, "the idle session's spool to be sent", func() bool { return len(in.batchesOf("sess-claimed")) > 0 })
	if _, ok := pool.activate(job); !ok {
		t.Fatal("the claim did not activate the session")
	}
	select {
	case active := <-done:
		if !active {
			t.Error("the claimed session's wait ended without its claim")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the claim did not end the idle session's wait: the send held it up")
	}
	if files := spoolFiles(r.m.events.spool.dir); len(files) != 1 {
		t.Errorf("the spool holds %v, want the segment that was out, for the supervisor", files)
	}
	s := r.m.events.open("sess-claimed")
	defer s.release()
	if held, through := s.holding(); held != 20 || through != 29 {
		t.Errorf("the session's stream holds %d events through seq %d for its supervisor, want 20 through 29", held, through)
	}
}

// runLoop registers a session the startup reclaim hands back idle through waitActiveSendingHeld, so its spool goes then.
func TestRunLoopSendsAnIdleSessionsSpoolWhileItWaitsForItsClaim(t *testing.T) {
	src, err := os.ReadFile("runloop.go")
	if err != nil {
		t.Fatalf("read runloop.go: %v", err)
	}
	body := string(src)
	body = body[strings.Index(body, "func runLoop("):]
	if !strings.Contains(body, "if !activeAtRegister && !pool.hasAdoptedJobs(j.SessionID) && !waitActiveSendingHeld(t, pool, live, j.SessionID, jobCtx, loopCtx) {") {
		t.Error("runLoop waits for an idle session's claim without sending what its spool holds")
	}
	if strings.Contains(body, "!pool.waitActive(live, jobCtx, loopCtx)") {
		t.Error("runLoop still waits for an idle session's claim with pool.waitActive alone")
	}
}
