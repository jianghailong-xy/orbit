package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"orbit/linkpb"
)

// A turn whose engine finished it is not handed to an engine again because its runner stopped before the control plane
// heard the turn was over (turn_complete_journal.go, task 34mwBTpOPo3S9LM2SXs10, from the C1a rollback drill of
// 2026-10-27). The supervisor keeps each completion on disk until the control plane answers it; a runner that stops
// first leaves it, and the session's next supervisor sends it after the session's spool is stored and before its first
// inbox fetch. With nothing kept, a turn is handed out again as before, and the completion of a turn goes as it always
// has: the same body, after the turn's events.

// oneTurnScript is an engine answering one message.
func oneTurnScript(text string) []fakeStep {
	return []fakeStep{
		{Await: "user"},
		{Emit: "replay_user"},
		{Emit: "system_init"},
		{Emit: "assistant", Text: text},
		{Emit: "result", Text: text},
	}
}

// completionWireBody is a turn completion's body as the control plane reads it, without what differs from process to
// process: the lease owner, and the engine's own session id.
func completionWireBody(t *testing.T, body []byte) string {
	t.Helper()
	var m map[string]interface{}
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("a turn completion that is not JSON: %s", body)
	}
	delete(m, "leaseOwner")
	delete(m, "runtimeSessionId")
	out, _ := json.Marshal(m)
	return string(out)
}

// keptCompletionBody is the completion a kept file holds, as completionWireBody reads a body.
func keptCompletionBody(t *testing.T, path string) (string, bool) {
	t.Helper()
	req, _, err := readTurnCompletion(path)
	if err != nil {
		return "", false
	}
	wire, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	return completionWireBody(t, wire), true
}

// completionTrace is what a stub control plane saw of a session's events and turn completions, in order.
type completionTrace struct {
	mu      sync.Mutex
	entries []string // "events <seq>:<type>:<turn> ..." and "turn-complete <turn>"
	bodies  map[string][]string
	// keptAtArrival is, for each completion, whether its file was on disk when it reached the control plane.
	keptAtArrival map[string]bool
	inboxFetches  int
}

func newCompletionTrace() *completionTrace {
	return &completionTrace{bodies: map[string][]string{}, keptAtArrival: map[string]bool{}}
}

func (tr *completionTrace) events(events []RunEvent) {
	parts := make([]string, len(events))
	for i, e := range events {
		parts[i] = fmt.Sprintf("%d:%s:%s", e.Seq, e.Type, e.TurnID)
	}
	tr.mu.Lock()
	tr.entries = append(tr.entries, "events "+strings.Join(parts, " "))
	tr.mu.Unlock()
}

func (tr *completionTrace) completion(t *testing.T, body []byte, keptPath func(string) string) TurnCompleteRequest {
	var req TurnCompleteRequest
	_ = json.Unmarshal(body, &req)
	_, err := os.Stat(keptPath(req.TurnID))
	tr.mu.Lock()
	tr.entries = append(tr.entries, "turn-complete "+req.TurnID)
	tr.bodies[req.TurnID] = append(tr.bodies[req.TurnID], completionWireBody(t, body))
	tr.keptAtArrival[req.TurnID] = err == nil
	tr.mu.Unlock()
	return req
}

func (tr *completionTrace) snapshot() []string {
	tr.mu.Lock()
	defer tr.mu.Unlock()
	return append([]string(nil), tr.entries...)
}

func (tr *completionTrace) completionsOf(turnID string) []string {
	tr.mu.Lock()
	defer tr.mu.Unlock()
	return append([]string(nil), tr.bodies[turnID]...)
}

func (tr *completionTrace) fetches() int {
	tr.mu.Lock()
	defer tr.mu.Unlock()
	return tr.inboxFetches
}

// superviseOverHTTPSWithTrace is superviseClaudeSessionVia on a daemon transport whose link mode is off (Transport.spooled),
// behind a stub that records the session's event batches and completions in trace, answers a completion with answer
// (nil: an empty body, which parks), and runs prepare, when set, before the supervisor starts.
func superviseOverHTTPSWithTrace(t *testing.T, pool *sessionPool, shutdown context.Context, logs *linkTestLog, trace *completionTrace,
	prepare func(s *supervisedSession, tr *Transport), answer func(req TurnCompleteRequest, w http.ResponseWriter) bool,
	script ...fakeStep) (*supervisedSession, *Transport) {
	t.Helper()
	var transport *Transport
	s := superviseClaudeSessionVia(t, pool, t.TempDir(), shutdown, func(s *supervisedSession, apiURL string) *Transport {
		front := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case strings.HasSuffix(r.URL.Path, "/inbox"):
				trace.mu.Lock()
				trace.inboxFetches++
				trace.mu.Unlock()
			case strings.HasSuffix(r.URL.Path, "/events") && r.Method == http.MethodPost:
				body, _ := io.ReadAll(r.Body)
				r.Body = io.NopCloser(bytes.NewReader(body))
				var batch RunEventBatch
				_ = json.Unmarshal(body, &batch)
				trace.events(batch.Events)
			case strings.HasSuffix(r.URL.Path, "/turn-complete"):
				body, _ := io.ReadAll(r.Body)
				r.Body = io.NopCloser(bytes.NewReader(body))
				req := trace.completion(t, body, func(turnID string) string { return newTurnCompletions(transport, s.job.SessionID).path(turnID) })
				if answer != nil && answer(req, w) {
					return
				}
			}
			s.serve(w, r)
		}))
		t.Cleanup(front.Close)
		transport = NewTransport(front.URL, "runner-token")
		transport.spooled = newLinkEvents(nil, logs.log)
		t.Cleanup(transport.spooled.close)
		if prepare != nil {
			prepare(s, transport)
		}
		return transport
	}, script...)
	return s, transport
}

// The completion of an ordinary turn, with nothing kept from an earlier process, goes as it always has, over HTTPS and
// over the link: once, with the body the engine's loop gave it, after the turn's events are stored. It is on disk while
// the control plane has it, and gone once the control plane answered it. A completion the disk will not take is said
// and goes all the same, the same body in the same place: what the runner sent before completions were kept.
func TestWithNothingKeptATurnCompletionGoesAsItAlwaysHas(t *testing.T) {
	type run struct {
		order []string // the entries of the trace, the events reduced to the turn's end
		body  string
		kept  bool
		left  []string
		logs  *linkTestLog
	}
	reduce := func(entries []string) []string {
		var out []string
		for _, e := range entries {
			if strings.HasPrefix(e, "events ") {
				for _, part := range strings.Fields(strings.TrimPrefix(e, "events ")) {
					if strings.Contains(part, ":"+evTurnEnd+":") {
						out = append(out, "turn_end "+part[strings.LastIndex(part, ":")+1:])
					}
				}
				continue
			}
			out = append(out, e)
		}
		return out
	}
	overHTTPS := func(t *testing.T, writable bool) run {
		logs := &linkTestLog{}
		trace := newCompletionTrace()
		var keptDir string
		s, tr := superviseOverHTTPSWithTrace(t, newSessionPool(4), context.Background(), logs, trace,
			func(s *supervisedSession, tr *Transport) {
				keptDir = newTurnCompletions(tr, s.job.SessionID).dir
				if !writable {
					// The spool's directory is a file: no completion can be kept.
					if err := os.WriteFile(tr.spooled.spool.dir, []byte("not a directory"), 0o600); err != nil {
						t.Fatal(err)
					}
				}
			}, nil, oneTurnScript("answered")...)
		s.awaitParked("turn-1")
		bodies := trace.completionsOf("turn-1")
		if len(bodies) != 1 {
			t.Fatalf("turn-1's completion went %d times, want once", len(bodies))
		}
		left, _ := filepath.Glob(filepath.Join(keptDir, turnCompletionPrefix+"*"))
		_ = tr
		trace.mu.Lock()
		kept := trace.keptAtArrival["turn-1"]
		trace.mu.Unlock()
		return run{order: reduce(trace.snapshot()), body: bodies[0], kept: kept, left: left, logs: logs}
	}
	var kept, unkept run
	t.Run("kept", func(t *testing.T) { kept = overHTTPS(t, true) })
	t.Run("not kept", func(t *testing.T) { unkept = overHTTPS(t, false) })
	if t.Failed() {
		return
	}
	want := []string{"turn_end turn-1", "turn-complete turn-1"}
	for name, r := range map[string]run{"kept": kept, "not kept": unkept} {
		if fmt.Sprint(r.order) != fmt.Sprint(want) {
			t.Errorf("over HTTPS, %s: the control plane saw %v, want the turn's end stored and then its completion, once", name, r.order)
		}
	}
	if kept.body != unkept.body {
		t.Errorf("over HTTPS the completion's body differs with the completion kept:\n  kept:     %s\n  not kept: %s", kept.body, unkept.body)
	}
	if !kept.kept || len(kept.left) != 0 {
		t.Errorf("over HTTPS the completion was on disk when it arrived: %v; left once answered: %v", kept.kept, kept.left)
	}
	if unkept.kept || !logged(unkept.logs, "could not be kept for the runner's next process") {
		t.Errorf("a completion the disk would not take was on disk (%v) or not said: %v", unkept.kept, unkept.logs.all())
	}

	// Over the link: the same body, after the turn's end is stored, once, and nothing left on disk.
	r, in := newLinkEventsRig(t)
	var linkBody string
	var linkEndStored, linkKept bool
	var linkCompletions int
	var mu sync.Mutex
	s := superviseClaudeSessionOverLinkVia(t, r, newSessionPool(4), context.Background(), func(s *supervisedSession) {
		serve := r.g.backend
		r.g.mu.Lock()
		r.g.backend = func(c *fakeWorkConn, rpc *linkpb.Rpc) *linkpb.RpcResult {
			if strings.HasSuffix(rpc.GetTunnel().GetPath(), "/turn-complete") {
				body := rpc.GetTunnel().GetJsonBody()
				var req TurnCompleteRequest
				_ = json.Unmarshal(body, &req)
				ended := false
				seqs, _, _ := in.storedSeqs(s.job.SessionID)
				for _, seq := range seqs {
					if e := in.event(s.job.SessionID, seq); e != nil && e.GetType() == evTurnEnd && e.GetTurnId() == req.TurnID {
						ended = true
					}
				}
				_, err := os.Stat(newTurnCompletions(r.t, s.job.SessionID).path(req.TurnID))
				mu.Lock()
				linkCompletions++
				linkBody, linkEndStored, linkKept = completionWireBody(t, body), ended, err == nil
				mu.Unlock()
			}
			return serve(c, rpc)
		}
		r.g.mu.Unlock()
	}, oneTurnScript("answered")...)
	s.awaitParked("turn-1")
	mu.Lock()
	defer mu.Unlock()
	if linkCompletions != 1 || !linkEndStored || !linkKept {
		t.Errorf("over the link the completion went %d time(s), with the turn's end stored %v and the completion on disk %v; want once, true, true",
			linkCompletions, linkEndStored, linkKept)
	}
	if linkBody != kept.body {
		t.Errorf("over the link the completion's body differs from HTTPS's:\n  link:  %s\n  HTTPS: %s", linkBody, kept.body)
	}
	if left, _ := filepath.Glob(filepath.Join(newTurnCompletions(r.t, s.job.SessionID).dir, turnCompletionPrefix+"*")); len(left) != 0 {
		t.Errorf("over the link a completion answered is still on disk: %v", left)
	}
}

// A runner that stops before the control plane answers a turn's completion keeps it, whole, for its next process: here
// the control plane refuses HTTPS once the stop has begun, as one whose link is required does.
func TestARunnerStoppingBeforeItsCompletionIsAnsweredKeepsIt(t *testing.T) {
	logs := &linkTestLog{}
	trace := newCompletionTrace()
	shutdown, stop := context.WithCancel(context.Background())
	defer stop()
	arrived := make(chan struct{})
	var once sync.Once
	s, tr := superviseOverHTTPSWithTrace(t, newSessionPool(4), shutdown, logs, trace, nil,
		func(req TurnCompleteRequest, w http.ResponseWriter) bool {
			once.Do(func() { close(arrived) })
			<-shutdown.Done()
			w.WriteHeader(http.StatusUpgradeRequired)
			_, _ = w.Write([]byte(`{"code":"UPGRADE_REQUIRED","message":"daemon calls go over the runner link"}`))
			return true
		}, oneTurnScript("answered before the stop")...)
	select {
	case <-arrived:
	case <-time.After(20 * time.Second):
		t.Fatal("the turn's completion never reached the control plane")
	}
	stop()
	waitUntil(t, func() bool {
		return logged(logs, "the completion of turn turn-1 of session sess-1 is kept for the runner's next process")
	},
		"the runner never said it kept the completion")
	path := newTurnCompletions(tr, s.job.SessionID).path("turn-1")
	body, ok := keptCompletionBody(t, path)
	if !ok {
		t.Fatalf("no completion of turn-1 is kept at %s", path)
	}
	if sent := trace.completionsOf("turn-1"); len(sent) != 1 || sent[0] != body {
		t.Errorf("the kept completion is %s, want what was sent: %v", body, sent)
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Errorf("the kept completion's file is %v (%v), want mode 0600 as the spool's", info, err)
	}
}

// The next process: the session's spool holds the end of turn-0, whose engine finished it, and its completion is kept.
// The supervisor stores the spool, then sends the completion, before it fetches anything: the control plane answers
// it, and turn-0 is never handed to an engine again. The next message is run as ever.
func TestTheNextProcessSettlesAKeptCompletionBeforeItsFirstFetch(t *testing.T) {
	logs := &linkTestLog{}
	trace := newCompletionTrace()
	pool := newSessionPool(4)
	var kept TurnCompleteRequest
	s, tr := superviseOverHTTPSWithTrace(t, pool, context.Background(), logs, trace,
		func(s *supervisedSession, tr *Transport) {
			s.job.MaxSeq = 9
			spoolLeftBehind(t, tr.spooled.spool.dir, s.job.SessionID, 10, 11, "turn-0")
			kept = TurnCompleteRequest{TurnID: "turn-0", Status: stSucceeded, Result: "the answer before the stop", Subtype: "success",
				NumTurns: 2, CostUsd: 0.25, Usage: &TokenUsage{InputTokens: 120, OutputTokens: 40}}
			newTurnCompletions(tr, s.job.SessionID).keep(kept)
			// Nothing queued: the next message comes later. A fetch before turn-0's completion would be the one the
			// control plane answers with turn-0 again, and its resume continuation.
			s.mu.Lock()
			s.inbox = []RunInboxResponse{}
			s.mu.Unlock()
		},
		func(req TurnCompleteRequest, w http.ResponseWriter) bool {
			if req.TurnID != "turn-0" {
				return false
			}
			_, _ = w.Write([]byte(`{"ok":true,"status":"AWAITING_INPUT"}`))
			return true
		}, oneTurnScript("answered the next message")...)

	waitUntil(t, func() bool { return len(trace.completionsOf("turn-0")) == 1 }, "turn-0's kept completion was never sent")
	waitUntil(t, func() bool { return !pool.isActive(s.live) }, "the session was never parked after turn-0 was settled")
	time.Sleep(300 * time.Millisecond)
	entries := trace.snapshot()
	if len(entries) < 2 || !strings.HasPrefix(entries[0], "events 10:") || !strings.Contains(entries[0], "20:"+evTurnEnd+":turn-0") ||
		entries[1] != "turn-complete turn-0" {
		t.Fatalf("the control plane saw %v, want the spool's seqs 10-20 and then turn-0's completion", entries)
	}
	wire, _ := json.Marshal(kept)
	if got := trace.completionsOf("turn-0")[0]; got != completionWireBody(t, wire) {
		t.Errorf("the kept completion went as %s, want %s", got, completionWireBody(t, wire))
	}
	if n := trace.fetches(); n != 0 || len(s.fake.Spawns()) != 0 {
		t.Errorf("with turn-0 settled and the session parked the supervisor fetched %d time(s) and started %d engine(s)", n, len(s.fake.Spawns()))
	}
	if _, err := os.Stat(newTurnCompletions(tr, s.job.SessionID).path("turn-0")); !os.IsNotExist(err) {
		t.Errorf("the kept completion is still on disk once answered: %v", err)
	}
	if !logged(logs, "turn turn-0 of session sess-1, which an earlier process finished, is settled from the completion it kept: AWAITING_INPUT") {
		t.Errorf("the runner never said it settled turn-0: %v", logs.all())
	}

	// The next message claims the session: it is what the engine is handed, and nothing of turn-0.
	s.queue(RunInboxResponse{TurnID: "turn-1", Kind: "message", Content: "start the build"})
	if _, ok := pool.activate(s.job); !ok {
		t.Fatal("the next message's claim did not activate the session")
	}
	s.awaitParked("turn-1")
	var handed []string
	for _, frame := range s.fake.Stdin() {
		if frame["type"] == frameUser {
			handed = append(handed, userFrameText(t, frame))
		}
	}
	if len(handed) != 1 || handed[0] != "start the build" {
		t.Errorf("the engine was handed %q, want only the next message", handed)
	}
}

// Over the link the same: the spool is stored on the link, then the kept completion goes over it, before any fetch.
func TestTheNextProcessSettlesAKeptCompletionOverTheLink(t *testing.T) {
	r, in := newLinkEventsRig(t)
	pool := newSessionPool(4)
	var mu sync.Mutex
	var bodies []string
	var spoolStoredFirst bool
	var fetchesBefore int
	kept := TurnCompleteRequest{TurnID: "turn-0", Status: stSucceeded, Result: "the answer before the stop", Subtype: "success", NumTurns: 1, CostUsd: 0.1}
	s := superviseClaudeSessionOverLinkVia(t, r, pool, context.Background(), func(s *supervisedSession) {
		s.job.MaxSeq = 9
		in.preload(s.job.SessionID, seqRangeU(1, 9)...)
		spoolLeftBehind(t, r.m.events.spool.dir, s.job.SessionID, 10, 11, "turn-0")
		newTurnCompletions(r.t, s.job.SessionID).keep(kept)
		s.mu.Lock()
		s.inbox = []RunInboxResponse{}
		s.mu.Unlock()
		serve := r.g.backend
		r.g.mu.Lock()
		r.g.backend = func(c *fakeWorkConn, rpc *linkpb.Rpc) *linkpb.RpcResult {
			path := rpc.GetTunnel().GetPath()
			if strings.HasSuffix(path, "/turn-complete") {
				seqs, _, _ := in.storedSeqs(s.job.SessionID)
				mu.Lock()
				bodies = append(bodies, completionWireBody(t, rpc.GetTunnel().GetJsonBody()))
				spoolStoredFirst = len(seqs) == 20
				fetchesBefore = len(r.g.rpcsTo("/runner/sessions/" + s.job.SessionID + "/inbox"))
				mu.Unlock()
				return fakeWorkAnswer(rpc, http.StatusOK, `{"ok":true,"status":"AWAITING_INPUT"}`)
			}
			return serve(c, rpc)
		}
		r.g.mu.Unlock()
	}, oneTurnScript("answered the next message")...)
	waitUntil(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(bodies) == 1
	}, "turn-0's kept completion was never sent over the link")
	waitUntil(t, func() bool { return !pool.isActive(s.live) }, "the session was never parked after turn-0 was settled")
	time.Sleep(300 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	wire, _ := json.Marshal(kept)
	if bodies[0] != completionWireBody(t, wire) {
		t.Errorf("the kept completion went as %s, want %s", bodies[0], completionWireBody(t, wire))
	}
	if !spoolStoredFirst || fetchesBefore != 0 {
		t.Errorf("when the kept completion went the spool was stored: %v, and the supervisor had fetched %d time(s)", spoolStoredFirst, fetchesBefore)
	}
	if n := len(r.g.rpcsTo("/runner/sessions/" + s.job.SessionID + "/inbox")); n != 0 || len(s.fake.Spawns()) != 0 {
		t.Errorf("with turn-0 settled the supervisor fetched %d time(s) and started %d engine(s)", n, len(s.fake.Spawns()))
	}
	in.assertContiguous(t, s.job.SessionID, 1, 20)
	if _, err := os.Stat(newTurnCompletions(r.t, s.job.SessionID).path("turn-0")); !os.IsNotExist(err) {
		t.Errorf("the kept completion is still on disk once answered: %v", err)
	}
}

// With nothing kept (the runner killed before its engine finished the turn, or before the completion was written), the
// turn is handed out again with its resume continuation and run, as before.
func TestWithNoCompletionKeptTheTurnIsHandedOutAgain(t *testing.T) {
	logs := &linkTestLog{}
	trace := newCompletionTrace()
	const continuation = "Your previous run of this message was interrupted because its runner restarted."
	s, _ := superviseOverHTTPSWithTrace(t, newSessionPool(4), context.Background(), logs, trace,
		func(s *supervisedSession, tr *Transport) {
			s.job.MaxSeq = 9
			s.mu.Lock()
			s.inbox = []RunInboxResponse{{TurnID: "turn-0", Kind: "message", Content: continuation}}
			s.mu.Unlock()
		}, nil, oneTurnScript("answered again")...)
	s.awaitParked("turn-0")
	var handed []string
	for _, frame := range s.fake.Stdin() {
		if frame["type"] == frameUser {
			handed = append(handed, userFrameText(t, frame))
		}
	}
	if len(handed) != 1 || !strings.Contains(handed[0], continuation) {
		t.Errorf("the engine was handed %q, want turn-0's continuation", handed)
	}
	if sent := trace.completionsOf("turn-0"); len(sent) != 1 {
		t.Errorf("turn-0's completion went %d time(s), want once, from the engine that ran it again", len(sent))
	}
}

// Over the link the same: with nothing kept, the first fetch hands turn-0 back with its resume continuation, the engine
// runs it, and its completion goes once, from that run.
func TestWithNoCompletionKeptTheTurnIsHandedOutAgainOverTheLink(t *testing.T) {
	r, in := newLinkEventsRig(t)
	const continuation = "Your previous run of this message was interrupted because its runner restarted."
	var mu sync.Mutex
	var completions, fetchesBefore int
	s := superviseClaudeSessionOverLinkVia(t, r, newSessionPool(4), context.Background(), func(s *supervisedSession) {
		s.job.MaxSeq = 9
		in.preload(s.job.SessionID, seqRangeU(1, 9)...)
		s.mu.Lock()
		s.inbox = []RunInboxResponse{{TurnID: "turn-0", Kind: "message", Content: continuation}}
		s.mu.Unlock()
		serve := r.g.backend
		r.g.mu.Lock()
		r.g.backend = func(c *fakeWorkConn, rpc *linkpb.Rpc) *linkpb.RpcResult {
			if strings.HasSuffix(rpc.GetTunnel().GetPath(), "/turn-complete") {
				var req TurnCompleteRequest
				_ = json.Unmarshal(rpc.GetTunnel().GetJsonBody(), &req)
				mu.Lock()
				if req.TurnID == "turn-0" {
					completions++
					fetchesBefore = len(r.g.rpcsTo("/runner/sessions/" + s.job.SessionID + "/inbox"))
				}
				mu.Unlock()
			}
			return serve(c, rpc)
		}
		r.g.mu.Unlock()
	}, oneTurnScript("answered again")...)
	s.awaitParked("turn-0")
	var handed []string
	for _, frame := range s.fake.Stdin() {
		if frame["type"] == frameUser {
			handed = append(handed, userFrameText(t, frame))
		}
	}
	if len(handed) != 1 || !strings.Contains(handed[0], continuation) {
		t.Errorf("over the link the engine was handed %q, want turn-0's continuation", handed)
	}
	mu.Lock()
	defer mu.Unlock()
	if completions != 1 || fetchesBefore == 0 {
		t.Errorf("over the link turn-0's completion went %d time(s), after %d fetch(es); want once, after the fetch that handed it back",
			completions, fetchesBefore)
	}
}

// A kept completion of a failed turn is the run's end, as the failed turn's own acknowledgement is: the control plane
// answers it with a terminal status, and the supervisor returns without an engine.
func TestAKeptCompletionOfAFailedTurnEndsTheRun(t *testing.T) {
	logs := &linkTestLog{}
	trace := newCompletionTrace()
	pool := newSessionPool(4)
	s, _ := superviseOverHTTPSWithTrace(t, pool, context.Background(), logs, trace,
		func(s *supervisedSession, tr *Transport) {
			newTurnCompletions(tr, s.job.SessionID).keep(TurnCompleteRequest{TurnID: "turn-0", Status: stFailed, Result: "API Error: 529 overloaded"})
		},
		func(req TurnCompleteRequest, w http.ResponseWriter) bool {
			_, _ = w.Write([]byte(`{"ok":true,"status":"FAILED"}`))
			return true
		}, oneTurnScript("never asked")...)
	waitUntil(t, func() bool { return !pool.ids()[s.job.SessionID] }, "the supervisor did not end the run")
	if n := trace.fetches(); n != 0 || len(s.fake.Spawns()) != 0 {
		t.Errorf("the run ended by its kept failed turn fetched %d time(s) and started %d engine(s)", n, len(s.fake.Spawns()))
	}
	if !logged(logs, "is settled from the completion it kept: FAILED") {
		t.Errorf("the runner never said it settled the failed turn: %v", logs.all())
	}
}

// A kept completion the control plane refuses for the session (409: another process owns it now) is dropped and said;
// the supervisor lets the session go, as for any such refusal.
func TestAKeptCompletionRefusedForTheSessionIsDroppedAndSaid(t *testing.T) {
	logs := &linkTestLog{}
	trace := newCompletionTrace()
	pool := newSessionPool(4)
	s, tr := superviseOverHTTPSWithTrace(t, pool, context.Background(), logs, trace,
		func(s *supervisedSession, tr *Transport) {
			newTurnCompletions(tr, s.job.SessionID).keep(TurnCompleteRequest{TurnID: "turn-0", Status: stSucceeded})
		},
		func(req TurnCompleteRequest, w http.ResponseWriter) bool {
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"code":"CONFLICT","message":"runner process no longer owns this session"}`))
			return true
		}, oneTurnScript("never asked")...)
	waitUntil(t, func() bool { return !pool.ids()[s.job.SessionID] }, "the supervisor did not let the session go")
	if _, err := os.Stat(newTurnCompletions(tr, s.job.SessionID).path("turn-0")); !os.IsNotExist(err) {
		t.Errorf("a completion refused for the session is still kept: %v", err)
	}
	if !logged(logs, "the completion an earlier process kept of turn turn-0 of session sess-1 is dropped: the control plane refused it for the session") {
		t.Errorf("the runner never said it dropped the completion: %v", logs.all())
	}
	if len(s.fake.Spawns()) != 0 {
		t.Errorf("a session another process owns started %d engine(s)", len(s.fake.Spawns()))
	}
}

// What a completion keeps of its request, and how it reads back: the request as it goes on the wire, a usage the
// engine did not measure included; oldest first; a write cut short, or a file that does not read back, removed.
func TestAKeptCompletionReadsBackAsItWasSent(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	logs := &linkTestLog{}
	tr := NewTransport("http://127.0.0.1:1", "runner-token")
	tr.spooled = newLinkEvents(nil, logs.log)
	t.Cleanup(tr.spooled.close)
	j := newTurnCompletions(tr, "sess-k")
	first := TurnCompleteRequest{TurnID: "turn-a", Status: stSucceeded, UsageUnknown: true, NumTurns: 1, BaseSha: "abc", LeaseOwner: "someone"}
	j.keep(first)
	time.Sleep(5 * time.Millisecond)
	second := TurnCompleteRequest{TurnID: "turn-b", Status: stFailed, Result: "it broke", CostUsd: 1.5}
	j.keep(second)
	if err := os.WriteFile(j.path("turn-c")+".tmp", []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(j.path("turn-d"), []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	got := j.pending()
	if len(got) != 2 || got[0].TurnID != "turn-a" || got[1].TurnID != "turn-b" {
		t.Fatalf("pending reads back %+v, want turn-a then turn-b", got)
	}
	if !got[0].UsageUnknown || got[0].LeaseOwner != "" {
		t.Errorf("turn-a reads back with UsageUnknown %v and lease owner %q, want true and none", got[0].UsageUnknown, got[0].LeaseOwner)
	}
	for i, want := range []TurnCompleteRequest{first, second} {
		want.LeaseOwner = ""
		a, _ := json.Marshal(want)
		b, _ := json.Marshal(got[i])
		if string(a) != string(b) {
			t.Errorf("%s goes on the wire as %s, want %s", want.TurnID, b, a)
		}
	}
	if _, err := os.Stat(j.path("turn-c") + ".tmp"); !os.IsNotExist(err) {
		t.Errorf("a write cut short is still there: %v", err)
	}
	if _, err := os.Stat(j.path("turn-d")); !os.IsNotExist(err) || !logged(logs, "does not read back and is removed") {
		t.Errorf("a file that does not read back is still there (%v) or was not said: %v", err, logs.all())
	}
	j.settle("turn-a", nil)
	if left := j.pending(); len(left) != 1 || left[0].TurnID != "turn-b" {
		t.Errorf("after turn-a was answered %+v is kept, want turn-b alone", left)
	}
}

// The spool's 72-hour cleanup removes a kept completion with the rest of the session's spool, and says which turns, how
// many, and how many so far.
func TestTheSpoolCleanupSaysWhichKeptCompletionsItRemoves(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	logs := &linkTestLog{}
	tr := NewTransport("http://127.0.0.1:1", "runner-token")
	tr.spooled = newLinkEvents(nil, func(...any) {})
	newTurnCompletions(tr, "session-old").keep(TurnCompleteRequest{TurnID: "turn-9", Status: stSucceeded})
	spoolLeftBehind(t, linkSpoolDir(), "session-old", 5, 3, "turn-9")
	tr.spooled.close()
	dir := filepath.Join(linkSpoolDir(), "session-old")
	old := time.Now().Add(-linkSpoolStaleAfter - time.Hour)
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if err := os.Chtimes(filepath.Join(dir, e.Name()), old, old); err != nil {
			t.Fatal(err)
		}
	}
	newLinkSpool(linkSpoolDir(), logs.log).queue("session-new")
	if !logged(logs, "its 1 kept turn completion(s), of turn(s) turn-9, were never answered by the control plane and are lost (1 lost so far)") {
		t.Errorf("the cleanup did not say which kept completions it removes: %v", logs.all())
	}
	if !logged(logs, "its 3 events, of seqs 5-7") {
		t.Errorf("the cleanup did not say which events it removes: %v", logs.all())
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Errorf("the stale spool is still there: %v", err)
	}
}
