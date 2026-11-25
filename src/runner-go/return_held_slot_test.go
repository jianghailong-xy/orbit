package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// The engine ran a turn of its own while the pool drained for an update, and the draining runner claimed its session
// for the message queued meanwhile (drainClaimScope), which the update holds. When that turn ends nothing runs under
// the permit: the pool says to give the slot back, and once the control plane has put the session back in the queue
// (PENDING) the permit is parked, the engine still warm (docs/runner-update-drain-design.md §7.1, §7.3).
func TestAnEngineTurnOfItsOwnEndingUnderADrainClaimGivesTheSlotBack(t *testing.T) {
	p := newSessionPoolWithClock(2, newFakePoolClock())
	s := warmPoolSession(t, p, "self-driven")
	if p.engineTurnEvent(s, evToolUse, map[string]interface{}{"id": "toolu_1"}) {
		t.Fatal("a turn of the engine's own that is still running gave its slot back")
	}
	p.drainForUpdate()
	if _, ok := p.activate(poolJob("self-driven")); !ok {
		t.Fatal("the drain-scoped claim was not activated")
	}
	if !p.engineTurnEvent(s, evTurnEnd, map[string]interface{}{}) {
		t.Fatal("the engine's own turn ended under a claim held for the update, and the slot was not to be given back")
	}
	asked := 0
	p.returnHeldSlot("self-driven", func() (string, error) { asked++; return stPending, nil })
	if asked != 1 {
		t.Fatalf("the control plane was asked %d times, want 1", asked)
	}
	if p.isActive(s) {
		t.Fatal("the permit was kept after the session went back to the queue")
	}
	if !p.engineResident(s) {
		t.Fatal("the engine did not stay warm")
	}
	if n, _ := p.closeForUpdate(0); n != 0 {
		t.Fatalf("closeForUpdate after the slot was given back = %d, want 0", n)
	}
}

// A turn in flight keeps the slot: the control plane answers RUNNING, and the permit stays.
func TestASlotTheControlPlaneKeepsIsKept(t *testing.T) {
	p := newSessionPool(2)
	s := registerPoolSession(t, p, "busy", true)
	p.drainForUpdate()
	p.returnHeldSlot("busy", func() (string, error) { return stRunning, nil })
	if !p.isActive(s) {
		t.Fatal("the permit was released although the control plane kept the slot")
	}
}

// Nothing is given back while the pool is not draining, nor for an engine at work on a turn of its own, nor while a
// turn's completion is out: the control plane is not asked.
func TestASlotIsGivenBackOnlyWhileDrainingWithNothingRunning(t *testing.T) {
	never := func(t *testing.T) func() (string, error) {
		return func() (string, error) { t.Fatal("the control plane was asked"); return "", nil }
	}
	p := newSessionPool(2)
	s := registerPoolSession(t, p, "a", true)
	p.returnHeldSlot("a", never(t))
	if !p.isActive(s) {
		t.Fatal("a permit was released while the pool was not draining")
	}
	p.drainForUpdate()
	p.beginTurnCompletion(s)
	p.returnHeldSlot("a", never(t))
	p.endTurnCompletion(s)

	q := newSessionPoolWithClock(2, newFakePoolClock())
	self := warmPoolSession(t, q, "self")
	q.engineTurnEvent(self, evToolUse, map[string]interface{}{"id": "toolu_1"})
	q.drainForUpdate()
	if _, ok := q.activate(poolJob("self")); !ok {
		t.Fatal("the drain-scoped claim was not activated")
	}
	q.returnHeldSlot("self", never(t))
}

// A Stop on a session whose queued message waits for the update reaches the session loop as an interrupt; the poller
// then gives the session's slot back, since nothing runs under it (§7.4). It does not while the pool is not draining.
func TestAnInterruptWhileDrainingGivesTheSlotBack(t *testing.T) {
	for _, draining := range []bool{true, false} {
		stub := newHeldTurnStub(t)
		stub.queue(RunInboxResponse{TurnID: "stop-1", Kind: "interrupt"})
		tr := NewTransport(stub.server.URL, "runner-token")
		tr.draining = func() bool { return draining }
		var mu sync.Mutex
		var returned []string
		tr.returnHeldSlot = func(id string) { mu.Lock(); returned = append(returned, id); mu.Unlock() }
		poller := newInboxPoller(tr, "stopped", "")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		resp, err := poller.next(ctx)
		cancel()
		poller.close()
		if err != nil || resp == nil || resp.Kind != "interrupt" {
			t.Fatalf("draining=%t: the interrupt was not handed on: %+v, %v", draining, resp, err)
		}
		mu.Lock()
		got := append([]string(nil), returned...)
		mu.Unlock()
		if draining && (len(got) != 1 || got[0] != "stopped") {
			t.Fatalf("an interrupt while draining gave back %q, want [stopped]", got)
		}
		if !draining && len(got) != 0 {
			t.Fatalf("an interrupt while not draining gave back %q, want none", got)
		}
	}
}

// The slot return names the session and the process holding it, and reads back the status the control plane answers.
func TestReturnSlotSendsTheLeaseOwnerAndReadsTheStatus(t *testing.T) {
	var path string
	var body map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&body)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "status": stPending})
	}))
	t.Cleanup(server.Close)
	tr := NewTransport(server.URL, "runner-token")
	status, err := tr.returnSlot(context.Background(), "s1")
	if err != nil || status != stPending {
		t.Fatalf("returnSlot = %q, %v; want PENDING", status, err)
	}
	if path != "/api/runner/sessions/s1/return-slot" {
		t.Fatalf("returnSlot went to %q", path)
	}
	if body["leaseOwner"] == "" || body["leaseOwner"] != tr.leaseOwner {
		t.Fatalf("returnSlot sent leaseOwner %q, want this process's %q", body["leaseOwner"], tr.leaseOwner)
	}
}
