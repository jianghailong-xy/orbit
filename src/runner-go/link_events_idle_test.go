package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
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

// With the link mode off the spool goes over HTTPS at once, under this process's lease, though nobody claims the
// session; the session stays idle meanwhile.
func TestAnIdleSessionsSpoolGoesAtStartupOverHTTPS(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	logs := &linkTestLog{}
	var store seqStore
	var mu sync.Mutex
	var owners []string
	var tr *Transport
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/runner/sessions/sess-idle/events") && r.Method == http.MethodPost {
			var batch RunEventBatch
			_ = json.NewDecoder(r.Body).Decode(&batch)
			store.take(batch.Events)
			mu.Lock()
			owners = append(owners, batch.LeaseOwner)
			mu.Unlock()
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(api.Close)
	tr = NewTransport(api.URL, "runner-token")
	tr.spooled = newLinkEvents(nil, logs.log)
	t.Cleanup(tr.spooled.close)
	spool := spoolLeftBehind(t, linkSpoolDir(), "sess-idle", 10, 56, "turn-0")
	pool := newSessionPool(4)
	_, live, _, done := idleSession(t, tr, pool, "sess-idle")

	waitUntil(t, func() bool { return len(spoolFiles(linkSpoolDir())) == 0 }, "the idle session's spool was never sent")
	store.mu.Lock()
	for i, want := range spool {
		got, ok := store.stored[int(want.seq)]
		if !ok || got.Type != want.typ || got.TurnID != "turn-0" {
			t.Errorf("seq %d holds %+v, want the spool's %s (event %d)", want.seq, got, want.typ, i)
		}
	}
	stored := len(store.stored)
	store.mu.Unlock()
	if stored != 56 {
		t.Errorf("%d seqs stored, want the spool's 56", stored)
	}
	mu.Lock()
	for _, owner := range owners {
		if owner != tr.leaseOwner {
			t.Errorf("a batch went under lease owner %q, want this process's %q", owner, tr.leaseOwner)
		}
	}
	mu.Unlock()
	if pool.isActive(live) {
		t.Error("sending the spool made the idle session active")
	}
	select {
	case <-done:
		t.Error("the idle session stopped waiting for its claim once its spool was sent")
	default:
	}
	if !logged(logs, "session sess-idle is idle; the 56 events through seq 65 an earlier process could not send go now, not at its next claim") ||
		!logged(logs, "the events idle session sess-idle held through seq 65 are stored") {
		t.Errorf("the runner did not say what it sent: %v", logs.all())
	}
}

// Over the link the same: the stream's sender sends it on the work connection, and the spool is emptied.
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
	if pool.isActive(live) {
		t.Error("sending the spool made the idle session active")
	}
	select {
	case <-done:
		t.Error("the idle session stopped waiting for its claim once its spool was sent")
	default:
	}
}

// A claim while the spool is still going ends the send at once: the session's supervisor starts, and sends what is left
// first itself. What was out is still on disk.
func TestAClaimEndsTheIdleSessionsSendAndItsSupervisorTakesOver(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	logs := &linkTestLog{}
	arrived := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/events") {
			once.Do(func() { close(arrived) })
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(api.Close)
	t.Cleanup(func() { close(release) })
	tr := NewTransport(api.URL, "runner-token")
	tr.spooled = newLinkEvents(nil, logs.log)
	t.Cleanup(tr.spooled.close)
	spoolLeftBehind(t, linkSpoolDir(), "sess-claimed", 10, 20, "turn-0")
	pool := newSessionPool(4)
	job, _, _, done := idleSession(t, tr, pool, "sess-claimed")
	select {
	case <-arrived:
	case <-time.After(10 * time.Second):
		t.Fatal("the idle session's spool was never sent")
	}
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
	if files := spoolFiles(linkSpoolDir()); len(files) != 1 {
		t.Errorf("the spool holds %v, want the segment that was out, for the supervisor", files)
	}
	s := tr.spooled.open("sess-claimed")
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
