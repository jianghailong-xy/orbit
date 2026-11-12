package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync"
	"testing"
)

// warmPoolSession is a session whose engine is resident and idle: claimed, started, parked.
func warmPoolSession(t *testing.T, p *sessionPool, id string) *liveSession {
	t.Helper()
	s := registerPoolSession(t, p, id, true)
	cancelled := 0
	startPoolEngine(t, p, s, &cancelled)
	parkPoolSession(p, s)
	return s
}

// While the pool drains for an update it claims for the sessions whose engine is running a turn here,
// and for no other: a session with an idle engine, or none, is new work, and the drain takes none. A
// control plane that does not take a scoped claim is sent none, and a pool that is only full (not
// draining) is sent none either.
func TestADrainingRunnerClaimsOnlyForAnEngineAtWork(t *testing.T) {
	p := newSessionPoolWithClock(3, newFakePoolClock())
	registerPoolSession(t, p, "cold", false)
	warmPoolSession(t, p, "warm")
	self := warmPoolSession(t, p, "self-driven")
	p.engineTurnEvent(self, evToolUse, map[string]interface{}{"id": "toolu_1"})
	busy := registerPoolSession(t, p, "busy", true)
	cancelled := 0
	startPoolEngine(t, p, busy, &cancelled)
	if scope := drainClaimScope(p, true); scope != nil {
		t.Fatalf("a pool that is not draining claimed for %q", scope)
	}
	p.drainForUpdate()
	if scope := drainClaimScope(p, false); scope != nil {
		t.Fatalf("a control plane without scoped claims was sent the scope %q", scope)
	}
	if scope := drainClaimScope(p, true); !slices.Equal(scope, []string{"busy", "self-driven"}) {
		t.Fatalf("drain claim scope = %q, want [busy self-driven]: only engines at work", scope)
	}

	// The engine's own turn ends: nothing is at work in that session any more, so it is not claimed for.
	p.engineTurnEvent(self, evTurnEnd, map[string]interface{}{})
	if scope := drainClaimScope(p, true); !slices.Equal(scope, []string{"busy"}) {
		t.Fatalf("drain claim scope after the engine's own turn ended = %q, want [busy]", scope)
	}
}

// A message claimed while the pool drains (for an engine at work) is held: it does not start here, it is
// no turn in flight, so it does not keep closeForUpdate from closing the pool once the engine's own turn
// has ended, and the row the claim made RUNNING is reclaimed by the updated runner, whose permit starts it.
func TestAMessageClaimedWhileDrainingWaitsForTheUpdatedRunner(t *testing.T) {
	p := newSessionPoolWithClock(2, newFakePoolClock())
	s := warmPoolSession(t, p, "self-driven")
	p.engineTurnEvent(s, evToolUse, map[string]interface{}{"id": "toolu_1"})
	p.drainForUpdate()

	// The scoped claim answers with this session: runLoop activates the supervisor it already has.
	if _, ok := p.activate(poolJob("self-driven")); !ok {
		t.Fatal("the claim was not activated")
	}
	if startsNow(p, s) {
		t.Fatal("a message claimed while draining started before the update")
	}
	if n, _ := p.closeForUpdate(0); n != 1 {
		t.Fatalf("closeForUpdate during the engine's own turn = %d, want 1", n)
	}
	if scope := drainClaimScope(p, true); !slices.Equal(scope, []string{"self-driven"}) {
		t.Fatalf("drain claim scope = %q, want the engine still at work", scope)
	}
	p.engineTurnEvent(s, evTurnEnd, map[string]interface{}{})
	if scope := drainClaimScope(p, true); scope != nil {
		t.Fatalf("drain claim scope with only a held claim = %q, want none", scope)
	}
	if n, _ := p.closeForUpdate(0); n != 0 {
		t.Fatalf("closeForUpdate with only a held claim = %d, want 0: it never started, so nothing is cut", n)
	}

	// The updated runner: the row is RUNNING, so reclaim registers the session holding its permit,
	// and the message starts.
	if !reclaimInitiallyActive(stRunning) {
		t.Fatal("a RUNNING row is not reclaimed holding its permit")
	}
	next := newSessionPoolWithClock(2, newFakePoolClock())
	again := registerPoolSession(t, next, "self-driven", reclaimInitiallyActive(stRunning))
	if !startsNow(next, again) {
		t.Fatal("the updated runner did not start the message held for it")
	}
}

// The scope rides the claim as drainScope, the sessions comma-separated; a claim with none asks as before.
func TestADrainScopedClaimNamesItsSessions(t *testing.T) {
	var mu sync.Mutex
	var asked []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		asked = append(asked, r.URL.RequestURI())
		mu.Unlock()
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`null`))
	}))
	defer server.Close()
	transport := NewTransport(server.URL, "runner-token")
	if _, err := transport.claimSession(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := transport.claimSession(context.Background(), nil, "busy", "self-driven"); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	want := []string{"/api/runner/sessions/claim", "/api/runner/sessions/claim?drainScope=busy%2Cself-driven"}
	if !slices.Equal(asked, want) {
		t.Fatalf("claims asked %q, want %q", asked, want)
	}
}

// A heartbeat answer from a server that takes a scoped claim says so; an older one's answer says nothing,
// which the claim loop reads as no scope and no claim while draining.
func TestTheHeartbeatAnswerSaysWhetherTheClaimTakesADrainScope(t *testing.T) {
	var resp HeartbeatResponse
	if err := json.Unmarshal([]byte(`{"cancelSessionIds":[],"drainScopedClaims":true}`), &resp); err != nil || !resp.DrainScopedClaims {
		t.Fatalf("a current server's answer read as %+v (%v)", resp, err)
	}
	resp = HeartbeatResponse{}
	if err := json.Unmarshal([]byte(`{"cancelSessionIds":[]}`), &resp); err != nil || resp.DrainScopedClaims {
		t.Fatalf("an older server's answer read as %+v (%v)", resp, err)
	}
}
