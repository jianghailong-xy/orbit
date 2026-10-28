package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"orbit/link-gateway/linkpb"
)

// Merged ingest (events_merge.go): batches of any of the gateway's connections, one merged call, each batch's own
// answer back on its own connection.

const mergePath = "/api/runner/link/events"

const (
	mergeSession1 = "0190a0b0-0000-7000-8000-0000000000c1"
	mergeSession2 = "0190a0b0-0000-7000-8000-0000000000c2"
	mergeSession3 = "0190a0b0-0000-7000-8000-0000000000c3"
	mergeSession4 = "0190a0b0-0000-7000-8000-0000000000c4"
	processB2     = "0190a0b0-0000-4000-8000-0000000000b1"
	runnerC       = "0190a0b0-0000-7000-8000-00000000000c"
)

// mergedCallSeen is a merged call as the apiserver reads it (link-events.ts LinkEventCall).
type mergedCallSeen struct {
	Connections []struct {
		LinkToken string            `json:"linkToken"`
		Headers   map[string]string `json:"headers"`
	} `json:"connections"`
	Batches []struct {
		Connection int             `json:"connection"`
		SessionID  string          `json:"sessionId"`
		Events     json.RawMessage `json:"events"`
	} `json:"batches"`
}

func readMergedCall(t testing.TB, body []byte) mergedCallSeen {
	t.Helper()
	var call mergedCallSeen
	if err := json.Unmarshal(body, &call); err != nil {
		t.Fatalf("a merged call that is not JSON: %v\n%s", err, body)
	}
	return call
}

// claimsOf is the runner and process a link token names.
func claimsOf(t testing.TB, token string) (runner, process string) {
	t.Helper()
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("a link token of %d parts", len(parts))
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	var claims struct {
		RunnerID   string `json:"runnerId"`
		LeaseOwner string `json:"leaseOwner"`
	}
	if err != nil || json.Unmarshal(payload, &claims) != nil {
		t.Fatalf("a link token that does not read: %v", err)
	}
	return claims.RunnerID, claims.LeaseOwner
}

func lastSeqOf(t testing.TB, events json.RawMessage) uint64 {
	t.Helper()
	var list []struct {
		Seq uint64 `json:"seq"`
	}
	if err := json.Unmarshal(events, &list); err != nil || len(list) == 0 {
		t.Fatalf("a batch's events: %v %s", err, events)
	}
	return list[len(list)-1].Seq
}

// mergedRoute answers merged calls as the apiserver does, each batch stored through its last seq unless alone says it
// is to go alone, and the events route's single calls as stored.
func mergedRoute(t testing.TB, alone func(session string) bool) func(w http.ResponseWriter, r *http.Request, body []byte) {
	return func(w http.ResponseWriter, r *http.Request, body []byte) {
		if r.URL.Path != mergePath {
			stored(w, r, body)
			return
		}
		call := readMergedCall(t, body)
		results := []any{}
		for _, b := range call.Batches {
			if alone != nil && alone(b.SessionID) {
				results = append(results, map[string]bool{"sendAlone": true})
				continue
			}
			results = append(results, map[string]any{"ok": true, "durableSeq": lastSeqOf(t, b.Events), "rejected": []any{}})
		}
		writeJSON(w, http.StatusOK, map[string]any{"results": results, "heldMs": 12})
	}
}

// mergingHarness is a link harness whose gateway merges, with window and the rest as set.
func mergingHarness(t *testing.T, backend *fakeBackend, tune func(*mergeTuning)) *harness {
	t.Helper()
	return newLinkHarness(t, []*fakeBackend{backend}, func(c *config) {
		c.link.Merge = defaultMergeTuning()
		c.link.Merge.Window = 300 * time.Millisecond
		if tune != nil {
			tune(&c.link.Merge)
		}
	})
}

// acks reads n EventAcks off a connection, by session.
func (tc *testConn) acks(n int, timeout time.Duration) map[string]*linkpb.EventAck {
	tc.t.Helper()
	out := map[string]*linkpb.EventAck{}
	for i := 0; i < n; i++ {
		ack := tc.eventAck(timeout)
		out[ack.GetSessionId()] = ack
	}
	return out
}

func TestBatchesOfSeveralConnectionsGoAsOneMergedCallAndEachIsAcknowledgedOnItsOwn(t *testing.T) {
	backend := newFakeBackend(t, nil)
	backend.setHandler(mergedRoute(t, nil))
	h := mergingHarness(t, backend, nil)
	a, _ := h.connectLink(runnerA, processA)
	b, _ := h.connectLink(runnerB, processB2)

	first, second, third := batch(mergeSession1, 1, 3), batch(mergeSession2, 1, 2), batch(mergeSession3, 7, 7)
	a.send(eventsFrame(first))
	a.send(eventsFrame(second))
	b.send(eventsFrame(third))

	got := a.acks(2, 5*time.Second)
	if ack := got[mergeSession1]; ack.GetDurableSeq() != 3 || ack.GetFailure() != nil {
		t.Fatalf("the first session's ack %v", ack)
	}
	if ack := got[mergeSession2]; ack.GetDurableSeq() != 2 || ack.GetFailure() != nil {
		t.Fatalf("the second session's ack %v", ack)
	}
	if ack := b.eventAck(5 * time.Second); ack.GetSessionId() != mergeSession3 || ack.GetDurableSeq() != 7 || ack.GetFailure() != nil {
		t.Fatalf("the other runner's ack %v", ack)
	}

	calls := backend.requestsTo(mergePath)
	if len(calls) != 1 || len(backend.requestsTo(eventsPath(mergeSession1))) != 0 {
		t.Fatalf("%d merged calls and %d alone: every batch of the window goes in one call", len(calls), len(backend.requests())-len(calls))
	}
	if auth := calls[0].Header.Get("Authorization"); auth != "Bearer "+strings.Repeat("g", 32) {
		t.Fatalf("the merged call's Authorization %q: the gateway's own secret", auth)
	}
	if calls[0].Header.Get(runnerLinkTokenHeader) != "" {
		t.Fatalf("a merged call names no runner in its headers: each batch's connection carries its own token")
	}
	call := readMergedCall(t, calls[0].Body)
	if len(call.Connections) != 2 || len(call.Batches) != 3 {
		t.Fatalf("%d connections and %d batches", len(call.Connections), len(call.Batches))
	}
	byRunner := map[string]int{}
	for i, c := range call.Connections {
		runner, process := claimsOf(t, c.LinkToken)
		byRunner[runner+"/"+process] = i
		if c.Headers["x-orbit-runner-capabilities"] != "session-terminal-handoff-v1,source-pin/v1" ||
			c.Headers["x-orbit-managed-runner-generation"] != "7" || c.Headers["x-orbit-managed-runner-pod-uid"] != "pod-1" ||
			c.Headers["x-orbit-supported-providers"] != "claude,codex" {
			t.Fatalf("connection %d's headers %v: what every call forwarded for it carries", i, c.Headers)
		}
		if _, ok := c.Headers[strings.ToLower(runnerLinkTokenHeader)]; ok {
			t.Fatalf("connection %d's token is repeated among its headers", i)
		}
	}
	aConn, aOK := byRunner[runnerA+"/"+processA]
	bConn, bOK := byRunner[runnerB+"/"+processB2]
	if !aOK || !bOK {
		t.Fatalf("the connections' link tokens are not the ones they connected with: %v", byRunner)
	}
	// In the order they reached the gateway, which for two connections is either.
	for _, want := range []struct {
		eb         *linkpb.EventBatch
		connection int
	}{{first, aConn}, {second, aConn}, {third, bConn}} {
		found := false
		for _, got := range call.Batches {
			if got.SessionID != want.eb.GetSessionId() {
				continue
			}
			found = true
			if got.Connection != want.connection {
				t.Fatalf("session %s's batch is on connection %d, want %d", got.SessionID, got.Connection, want.connection)
			}
			expect, _ := json.Marshal(requestEvents(want.eb))
			if string(got.Events) != string(expect) {
				t.Fatalf("session %s's events are not the events route's body of them:\n got %s\nwant %s", got.SessionID, got.Events, expect)
			}
		}
		if !found {
			t.Fatalf("session %s's batch is not in the call", want.eb.GetSessionId())
		}
	}
	m := h.g.metrics
	if m.mergeCalls.get("answered") != 1 || m.eventsStored.get() != 6 {
		t.Fatalf("merged calls answered %v, events stored %v", m.mergeCalls.get("answered"), m.eventsStored.get())
	}
	if count, sum := m.mergeBatches.snapshot(); count != 1 || sum != 3 {
		t.Fatalf("batches per call: %d calls, %v batches", count, sum)
	}
	if count, sum := m.mergeHeld.snapshot(); count != 1 || sum != 0.012 {
		t.Fatalf("held: %d, %v s", count, sum)
	}
	eventually(t, 5*time.Second, "the ingest queue empty again", func() bool { return h.g.credit.depth() == creditLevel{} })
}

func TestASessionsBatchesStillGoOneAfterAnotherInOrder(t *testing.T) {
	var mu sync.Mutex
	var firsts []uint64
	backend := newFakeBackend(t, nil)
	answer := mergedRoute(t, nil)
	backend.setHandler(func(w http.ResponseWriter, r *http.Request, body []byte) {
		if r.URL.Path == mergePath {
			call := readMergedCall(t, body)
			mu.Lock()
			for _, b := range call.Batches {
				var events []struct {
					Seq uint64 `json:"seq"`
				}
				_ = json.Unmarshal(b.Events, &events)
				firsts = append(firsts, events[0].Seq)
			}
			mu.Unlock()
			if len(call.Batches) != 1 {
				t.Errorf("a merged call carried %d batches of one session", len(call.Batches))
			}
		}
		answer(w, r, body)
	})
	h := mergingHarness(t, backend, func(m *mergeTuning) { m.Window = 50 * time.Millisecond })
	tc, _ := h.connectLink(runnerA, processA)
	tc.send(eventsFrame(batch(mergeSession1, 1, 2)))
	tc.send(eventsFrame(batch(mergeSession1, 3, 4)))
	tc.send(eventsFrame(batch(mergeSession1, 5, 6)))
	for _, want := range []uint64{2, 4, 6} {
		if ack := tc.eventAck(5 * time.Second); ack.GetDurableSeq() != want || ack.GetFailure() != nil {
			t.Fatalf("ack %v, want durable %d", ack, want)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(firsts) != 3 || firsts[0] != 1 || firsts[1] != 3 || firsts[2] != 5 {
		t.Fatalf("the batches went as %v: a session's next batch goes once the one before it is answered", firsts)
	}
}

func TestABatchTheMergedCallSendsAloneIsForwardedToTheEventsRoute(t *testing.T) {
	backend := newFakeBackend(t, nil)
	merged := mergedRoute(t, func(session string) bool { return session == mergeSession2 })
	backend.setHandler(func(w http.ResponseWriter, r *http.Request, body []byte) {
		if r.URL.Path == eventsPath(mergeSession2) {
			// The events route's own answer: one event refused and held by a tombstone.
			writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "durableSeq": 2,
				"rejected": []map[string]any{{"seq": 2, "code": "EVENT_PAYLOAD_INVALID", "message": "the payload is not a JSON object"}}})
			return
		}
		merged(w, r, body)
	})
	h := mergingHarness(t, backend, nil)
	tc, _ := h.connectLink(runnerA, processA)
	tc.send(eventsFrame(batch(mergeSession1, 1, 3)))
	tc.send(eventsFrame(batch(mergeSession2, 1, 2)))
	got := tc.acks(2, 5*time.Second)
	if ack := got[mergeSession1]; ack.GetDurableSeq() != 3 || ack.GetFailure() != nil {
		t.Fatalf("the merged batch's ack %v", ack)
	}
	alone := got[mergeSession2]
	if alone.GetDurableSeq() != 2 || alone.GetFailure() != nil || len(alone.GetRejected()) != 1 ||
		alone.GetRejected()[0].GetCode() != "EVENT_PAYLOAD_INVALID" {
		t.Fatalf("the batch sent alone is acknowledged as the events route answered it: %v", alone)
	}
	if n := len(backend.requestsTo(eventsPath(mergeSession2))); n != 1 {
		t.Fatalf("%d calls to the events route for the batch sent alone", n)
	}
	if n := len(backend.requestsTo(eventsPath(mergeSession1))); n != 0 {
		t.Fatalf("the merged batch also went alone (%d calls)", n)
	}
	if got := h.g.metrics.mergeAlone.get("answered_alone"); got != 1 {
		t.Fatalf("link_event_merge_alone_total{answered_alone} %v", got)
	}
}

func TestAnApiserverWithoutTheMergedRouteHasEveryBatchSentAlone(t *testing.T) {
	backend := newFakeBackend(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		if r.URL.Path == mergePath {
			writeJSON(w, http.StatusNotFound, map[string]any{"statusCode": 404, "message": "Cannot POST /api/runner/link/events"})
			return
		}
		stored(w, r, body)
	})
	h := mergingHarness(t, backend, nil)
	tc, _ := h.connectLink(runnerA, processA)
	tc.send(eventsFrame(batch(mergeSession1, 1, 3)))
	tc.send(eventsFrame(batch(mergeSession2, 1, 2)))
	got := tc.acks(2, 5*time.Second)
	if got[mergeSession1].GetDurableSeq() != 3 || got[mergeSession2].GetDurableSeq() != 2 {
		t.Fatalf("acks %v", got)
	}
	if len(backend.requestsTo(eventsPath(mergeSession1))) != 1 || len(backend.requestsTo(eventsPath(mergeSession2))) != 1 {
		t.Fatalf("each batch goes alone after the merged call is refused: %d calls", len(backend.requests()))
	}
	if h.g.metrics.mergeCalls.get("alone") != 1 || h.g.metrics.mergeAlone.get("call") != 2 {
		t.Fatalf("merged calls alone %v, batches alone %v", h.g.metrics.mergeCalls.get("alone"), h.g.metrics.mergeAlone.get("call"))
	}
}

func TestAMergedCallTheDatabaseTurnsAwayFailsEachBatchRetryable(t *testing.T) {
	backend := newFakeBackend(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		if r.URL.Path == mergePath {
			w.Header().Set("Retry-After-Ms", "2000")
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"code": "DATABASE_UNAVAILABLE", "retryable": true, "retryAfterMs": 2000})
			return
		}
		t.Errorf("a batch went alone after the database turned its call away: %s", r.URL.Path)
		stored(w, r, body)
	})
	h := mergingHarness(t, backend, nil)
	tc, _ := h.connectLink(runnerA, processA)
	tc.send(eventsFrame(batch(mergeSession1, 1, 3)))
	tc.send(eventsFrame(batch(mergeSession2, 1, 2)))
	for session, ack := range tc.acks(2, 5*time.Second) {
		f := ack.GetFailure()
		if ack.GetDurableSeq() != 0 || f.GetCode() != "DATABASE_UNAVAILABLE" || !f.GetRetryable() || f.GetRetryAfterMs() != 2000 {
			t.Fatalf("%s: %v — as the events route's 503 would have failed it", session, ack)
		}
	}
	if h.g.metrics.mergeCalls.get("failed") != 1 {
		t.Fatalf("merged calls failed %v", h.g.metrics.mergeCalls.get("failed"))
	}
}

func TestABatchCarryingATurnEndGoesAtOnce(t *testing.T) {
	backend := newFakeBackend(t, nil)
	backend.setHandler(mergedRoute(t, nil))
	h := mergingHarness(t, backend, func(m *mergeTuning) { m.Window = 5 * time.Second })
	tc, _ := h.connectLink(runnerA, processA)
	eb := batch(mergeSession1, 1, 2)
	eb.Events[1].Type = "turn_end"
	sent := time.Now()
	tc.send(eventsFrame(eb))
	if ack := tc.eventAck(2 * time.Second); ack.GetDurableSeq() != 2 {
		t.Fatalf("ack %v", ack)
	}
	if waited := time.Since(sent); waited > time.Second {
		t.Fatalf("a turn's end waited %s for a 5 s window: its completion waits on it", waited)
	}
	if h.g.metrics.mergeFlushes.get("turn_end") != 1 {
		t.Fatalf("flushes %v", h.g.metrics.mergeFlushes.get("turn_end"))
	}
}

func TestAFullCallGoesAtOnceAndCallsInFlightAreBounded(t *testing.T) {
	release := make(chan struct{})
	var mu sync.Mutex
	sizes := []int{}
	backend := newFakeBackend(t, nil)
	answer := mergedRoute(t, nil)
	backend.setHandler(func(w http.ResponseWriter, r *http.Request, body []byte) {
		if r.URL.Path == mergePath {
			mu.Lock()
			sizes = append(sizes, len(readMergedCall(t, body).Batches))
			first := len(sizes) == 1
			mu.Unlock()
			if first {
				<-release
			}
		}
		answer(w, r, body)
	})
	h := mergingHarness(t, backend, func(m *mergeTuning) {
		m.Window = 5 * time.Second
		m.MaxBatches = 2
		m.CallsPerBackend = 1
	})
	tc, _ := h.connectLink(runnerA, processA)
	tc.send(eventsFrame(batch(mergeSession1, 1, 1)))
	tc.send(eventsFrame(batch(mergeSession2, 1, 1)))
	eventually(t, 2*time.Second, "the full call at the route at once", func() bool { return len(backend.requestsTo(mergePath)) == 1 })
	tc.send(eventsFrame(batch(mergeSession3, 1, 1)))
	tc.send(eventsFrame(batch(mergeSession4, 1, 1)))
	time.Sleep(200 * time.Millisecond)
	if n := len(backend.requestsTo(mergePath)); n != 1 {
		t.Fatalf("%d merged calls out at once, with one call slot", n)
	}
	close(release)
	if got := tc.acks(4, 5*time.Second); len(got) != 4 {
		t.Fatalf("acks %v", got)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(sizes) != 2 || sizes[0] != 2 || sizes[1] != 2 {
		t.Fatalf("calls of %v batches: two full calls, the second as soon as the first returned", sizes)
	}
	if h.g.metrics.mergeFlushes.get("batches") != 1 || h.g.metrics.mergeFlushes.get("due") != 1 {
		t.Fatalf("flushes: batches %v, due %v", h.g.metrics.mergeFlushes.get("batches"), h.g.metrics.mergeFlushes.get("due"))
	}
}

// holdingBackends are backends that answer merged calls as the apiserver does once released, and count the calls each
// holds until then.
type holdingBackends struct {
	backends []*fakeBackend
	release  chan struct{}
	freed    sync.Once
	mu       sync.Mutex
	out      []int
	calls    int
}

func newHoldingBackends(t *testing.T, n int) *holdingBackends {
	hb := &holdingBackends{release: make(chan struct{}), out: make([]int, n)}
	answer := mergedRoute(t, nil)
	for i := 0; i < n; i++ {
		b := newFakeBackend(t, nil)
		b.setHandler(func(w http.ResponseWriter, r *http.Request, body []byte) {
			if r.URL.Path == mergePath {
				hb.mu.Lock()
				hb.out[i]++
				hb.calls++
				hb.mu.Unlock()
				<-hb.release
				hb.mu.Lock()
				hb.out[i]--
				hb.mu.Unlock()
			}
			answer(w, r, body)
		})
		hb.backends = append(hb.backends, b)
	}
	// Before the backends close, which waits for the calls they hold: a test that failed holding some.
	t.Cleanup(hb.free)
	return hb
}

// free answers every call held, and every call from now on at once.
func (hb *holdingBackends) free() { hb.freed.Do(func() { close(hb.release) }) }

// held is the merged calls each backend holds now.
func (hb *holdingBackends) held() []int {
	hb.mu.Lock()
	defer hb.mu.Unlock()
	return slices.Clone(hb.out)
}

func (hb *holdingBackends) total() int {
	total := 0
	for _, n := range hb.held() {
		total += n
	}
	return total
}

// mergeSessionN is the nth of many sessions.
func mergeSessionN(n int) string { return fmt.Sprintf("0190a0b0-0000-7000-8000-0000000002%02x", n) }

func TestTheMergedCallsOutAtOnceGrowWithTheApiservers(t *testing.T) {
	for _, tc := range []struct {
		name       string
		backends   int
		perBackend int // 0: the default
		want       int
	}{
		// One apiserver: four calls out at once, as before the calls grew with the apiservers.
		{"one apiserver", 1, 0, 4},
		{"three apiservers", 3, 0, 12},
		{"two apiservers, LINK_EVENT_MERGE_CALLS_PER_BACKEND=2", 2, 2, 4},
	} {
		t.Run(tc.name, func(t *testing.T) {
			hb := newHoldingBackends(t, tc.backends)
			h := newLinkHarness(t, hb.backends, func(c *config) {
				c.link.Merge = defaultMergeTuning()
				// Every batch a full call of its own, which goes at once.
				c.link.Merge.Window = 5 * time.Second
				c.link.Merge.MaxBatches = 1
				if tc.perBackend > 0 {
					c.link.Merge.CallsPerBackend = tc.perBackend
				}
			})
			if tc.perBackend == 0 && h.g.cfg.link.Merge.CallsPerBackend != 4 {
				t.Fatalf("the default is %d calls a backend, want 4", h.g.cfg.link.Merge.CallsPerBackend)
			}
			// More batches than there are slots, from three connections (each forwards eight sessions' at most).
			conns := []*testConn{}
			for i, runner := range []string{runnerA, runnerB, runnerC} {
				c, _ := h.connectLink(runner, []string{processA, processB2, processC}[i])
				conns = append(conns, c)
			}
			batches := tc.want + 6
			for n := 0; n < batches; n++ {
				conns[n%len(conns)].send(eventsFrame(batch(mergeSessionN(n), 1, 1)))
			}
			eventually(t, 5*time.Second, fmt.Sprintf("%d merged calls out", tc.want), func() bool { return hb.total() >= tc.want })
			time.Sleep(300 * time.Millisecond)
			held := hb.held()
			for _, n := range held {
				if n != tc.want/tc.backends {
					t.Fatalf("the backends hold %v merged calls, want %d each and %d in all", held, tc.want/tc.backends, tc.want)
				}
			}
			hb.free()
			acked := 0
			for i, c := range conns {
				acked += len(c.acks((batches-i+len(conns)-1)/len(conns), 5*time.Second))
			}
			hb.mu.Lock()
			calls := hb.calls
			hb.mu.Unlock()
			if acked != batches || calls != batches {
				t.Fatalf("%d batches acknowledged and %d merged calls, want %d of each", acked, calls, batches)
			}
			if due := h.g.metrics.mergeFlushes.get("due"); due < 1 {
				t.Fatalf("no batch waited for a call slot: flushes{due} %v", due)
			}
		})
	}
}

func TestAnApiserverThatCannotBeDialedLendsNoCallSlotsToTheOthers(t *testing.T) {
	gone := newFakeBackend(t, nil)
	gone.srv.Close()
	hb := newHoldingBackends(t, 1)
	h := newLinkHarness(t, []*fakeBackend{gone, hb.backends[0]}, func(c *config) {
		c.link.Merge = defaultMergeTuning()
		c.link.Merge.Window = 5 * time.Second
		c.link.Merge.MaxBatches = 1
		c.link.BackendDownFor = time.Minute
	})
	// The first call of all, the first connection's welcome, tries the first backend, which refuses the dial.
	a, _ := h.connectLink(runnerA, processA)
	b, _ := h.connectLink(runnerB, processB2)
	if !h.g.backends.passedOver(0) {
		t.Fatalf("the backend that refuses every dial is not passed over")
	}
	for n := 0; n < 10; n++ {
		[]*testConn{a, b}[n%2].send(eventsFrame(batch(mergeSessionN(n), 1, 1)))
	}
	eventually(t, 5*time.Second, "four merged calls out", func() bool { return hb.total() >= 4 })
	time.Sleep(300 * time.Millisecond)
	if n := hb.total(); n != 4 {
		t.Fatalf("the one backend that answers holds %d merged calls: the other's four slots went to it", n)
	}
	hb.free()
	if got := len(a.acks(5, 5*time.Second)) + len(b.acks(5, 5*time.Second)); got != 10 {
		t.Fatalf("%d batches acknowledged", got)
	}
}

func TestABatchTooLargeToMergeGoesAlone(t *testing.T) {
	backend := newFakeBackend(t, nil)
	backend.setHandler(mergedRoute(t, nil))
	h := mergingHarness(t, backend, func(m *mergeTuning) { m.AloneBytes = 200 })
	tc, _ := h.connectLink(runnerA, processA)
	tc.send(eventsFrame(batch(mergeSession1, 1, 5)))
	if ack := tc.eventAck(5 * time.Second); ack.GetDurableSeq() != 5 || ack.GetFailure() != nil {
		t.Fatalf("ack %v", ack)
	}
	if len(backend.requestsTo(mergePath)) != 0 || len(backend.requestsTo(eventsPath(mergeSession1))) != 1 {
		t.Fatalf("the large batch went %d merged, %d alone", len(backend.requestsTo(mergePath)), len(backend.requestsTo(eventsPath(mergeSession1))))
	}
	if h.g.metrics.mergeAlone.get("too_large") != 1 {
		t.Fatalf("link_event_merge_alone_total{too_large} %v", h.g.metrics.mergeAlone.get("too_large"))
	}
}

func TestABatchWhoseConnectionEndedIsLeftOutOfItsCall(t *testing.T) {
	backend := newFakeBackend(t, nil)
	backend.setHandler(mergedRoute(t, nil))
	h := mergingHarness(t, backend, func(m *mergeTuning) { m.Window = 500 * time.Millisecond })
	gone, _ := h.connectLink(runnerA, processA)
	stays, _ := h.connectLink(runnerB, processB2)
	gone.send(eventsFrame(batch(mergeSession1, 1, 1)))
	stays.send(eventsFrame(batch(mergeSession2, 1, 1)))
	_ = gone.ws.Close(websocket.StatusNormalClosure, "the runner went away")
	eventually(t, 2*time.Second, "the first connection closed at the gateway", func() bool { return h.g.reg.count() == 1 })
	if ack := stays.eventAck(5 * time.Second); ack.GetSessionId() != mergeSession2 || ack.GetDurableSeq() != 1 {
		t.Fatalf("ack %v", ack)
	}
	calls := backend.requestsTo(mergePath)
	if len(calls) != 1 {
		t.Fatalf("%d merged calls", len(calls))
	}
	call := readMergedCall(t, calls[0].Body)
	if len(call.Batches) != 1 || call.Batches[0].SessionID != mergeSession2 || len(call.Connections) != 1 {
		t.Fatalf("the call carried %d batches over %d connections: nobody is left to acknowledge the ended one's",
			len(call.Batches), len(call.Connections))
	}
}

func TestTheMergeWindowIsReadFromTheEnvironment(t *testing.T) {
	env := func(extra map[string]string) func(string) string {
		base := map[string]string{
			"LINK_TLS_MODE": "off", "LINK_API_URL": "http://api", "LINK_GATEWAY_TOKEN": strings.Repeat("g", 32),
			"LINK_PUBLIC_KEYS": publicPEM(t, newTestKeys(t).pub),
		}
		for k, v := range extra {
			base[k] = v
		}
		return func(name string) string { return base[name] }
	}
	for value, want := range map[string]time.Duration{"": 100 * time.Millisecond, "0": 0, "off": 0, "250ms": 250 * time.Millisecond} {
		cfg, err := configFromEnv(env(map[string]string{"LINK_EVENT_MERGE_WINDOW": value}))
		if err != nil || cfg.link.Merge.Window != want {
			t.Fatalf("LINK_EVENT_MERGE_WINDOW=%q: %v, %v", value, cfg.link.Merge.Window, err)
		}
	}
	for _, value := range []string{"1s", "-5ms", "soon"} {
		if _, err := configFromEnv(env(map[string]string{"LINK_EVENT_MERGE_WINDOW": value})); err == nil ||
			!strings.Contains(err.Error(), "LINK_EVENT_MERGE_WINDOW") {
			t.Fatalf("LINK_EVENT_MERGE_WINDOW=%q accepted: %v", value, err)
		}
	}
	cfg, err := configFromEnv(env(map[string]string{"LINK_EVENT_MERGE_MAX_BATCHES": "32", "LINK_EVENT_MERGE_MAX_BYTES": "65536"}))
	if err != nil || cfg.link.Merge.MaxBatches != 32 || cfg.link.Merge.MaxBytes != 65536 {
		t.Fatalf("caps %+v, %v", cfg.link.Merge, err)
	}
	if _, err := configFromEnv(env(map[string]string{"LINK_EVENT_MERGE_MAX_BATCHES": "300"})); err == nil {
		t.Fatalf("a call of more batches than the apiserver takes was accepted")
	}
	for value, want := range map[string]int{"": 4, "1": 1, "8": 8} {
		cfg, err := configFromEnv(env(map[string]string{"LINK_EVENT_MERGE_CALLS_PER_BACKEND": value}))
		if err != nil || cfg.link.Merge.CallsPerBackend != want {
			t.Fatalf("LINK_EVENT_MERGE_CALLS_PER_BACKEND=%q: %d, %v", value, cfg.link.Merge.CallsPerBackend, err)
		}
	}
	// More than the apiserver's database connections leave room for, or none at all.
	for _, value := range []string{"9", "0", "-1", "four"} {
		if _, err := configFromEnv(env(map[string]string{"LINK_EVENT_MERGE_CALLS_PER_BACKEND": value})); err == nil ||
			!strings.Contains(err.Error(), "LINK_EVENT_MERGE_CALLS_PER_BACKEND") {
			t.Fatalf("LINK_EVENT_MERGE_CALLS_PER_BACKEND=%q accepted: %v", value, err)
		}
	}
}
