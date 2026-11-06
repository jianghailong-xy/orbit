package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
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
// inbox fetch. With nothing kept, a turn is handed out again, and the completion of a turn goes once, after the turn's
// events.

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
// process: the lease owner, the engine's own session id, and the id its running totals name the engine process by
// (what that process restored stays in).
func completionWireBody(t *testing.T, body []byte) string {
	t.Helper()
	var m map[string]interface{}
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("a turn completion that is not JSON: %s", body)
	}
	delete(m, "leaseOwner")
	delete(m, "runtimeSessionId")
	if totals, ok := m["runningTotals"].(map[string]interface{}); ok {
		delete(totals, "process")
	}
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

// superviseOverLinkWithAnswers is superviseClaudeSessionOverLinkVia behind a backend that records the session's inbox
// fetches and completions in trace, answers a completion with answer (nil: as the session does, which parks), and runs
// prepare, when set, before the supervisor starts.
func superviseOverLinkWithAnswers(t *testing.T, r *linkWorkRig, pool *sessionPool, shutdown context.Context, trace *completionTrace,
	prepare func(s *supervisedSession), answer func(req TurnCompleteRequest, rpc *linkpb.Rpc) *linkpb.RpcResult,
	script ...fakeStep) *supervisedSession {
	t.Helper()
	return superviseClaudeSessionOverLinkVia(t, r, pool, shutdown, func(s *supervisedSession) {
		serve := r.g.backend
		r.g.mu.Lock()
		r.g.backend = func(c *fakeWorkConn, rpc *linkpb.Rpc) *linkpb.RpcResult {
			path := rpc.GetTunnel().GetPath()
			switch {
			case strings.Contains(path, "/inbox"):
				trace.mu.Lock()
				trace.inboxFetches++
				trace.mu.Unlock()
			case strings.HasSuffix(path, "/turn-complete"):
				req := trace.completion(t, rpc.GetTunnel().GetJsonBody(), func(turnID string) string { return newTurnCompletions(r.t, s.job.SessionID).path(turnID) })
				if answer != nil {
					if result := answer(req, rpc); result != nil {
						return result
					}
				}
			}
			return serve(c, rpc)
		}
		r.g.mu.Unlock()
		if prepare != nil {
			prepare(s)
		}
	}, script...)
}

// The completion of an ordinary turn, with nothing kept from an earlier process, goes once, with the body the engine's
// loop gave it, after the turn's events are stored. It is on disk while the control plane has it, and gone once the
// control plane answered it. A completion the disk will not take is said and goes all the same, the same body.
func TestWithNothingKeptATurnCompletionGoesOnceAfterItsEvents(t *testing.T) {
	type run struct {
		endStored, kept bool
		body            string
		completions     int
		left            []string
		logs            *linkTestLog
	}
	overLink := func(t *testing.T, writable bool) run {
		r, in := newLinkEventsRig(t)
		var mu sync.Mutex
		var got run
		s := superviseClaudeSessionOverLinkVia(t, r, newSessionPool(4), context.Background(), func(s *supervisedSession) {
			if !writable {
				// The session's spool directory is a file: no completion can be kept.
				dir := newTurnCompletions(r.t, s.job.SessionID).dir
				if err := os.MkdirAll(filepath.Dir(dir), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(dir, []byte("not a directory"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
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
					got.completions++
					got.body, got.endStored, got.kept = completionWireBody(t, body), ended, err == nil
					mu.Unlock()
				}
				return serve(c, rpc)
			}
			r.g.mu.Unlock()
		}, oneTurnScript("answered")...)
		s.awaitParked("turn-1")
		got.left, _ = filepath.Glob(filepath.Join(newTurnCompletions(r.t, s.job.SessionID).dir, turnCompletionPrefix+"*"))
		got.logs = r.logs
		mu.Lock()
		defer mu.Unlock()
		return got
	}
	var kept, unkept run
	t.Run("kept", func(t *testing.T) { kept = overLink(t, true) })
	t.Run("not kept", func(t *testing.T) { unkept = overLink(t, false) })
	if t.Failed() {
		return
	}
	for name, r := range map[string]run{"kept": kept, "not kept": unkept} {
		if r.completions != 1 || !r.endStored {
			t.Errorf("%s: the completion went %d time(s), with the turn's end stored %v; want once, true", name, r.completions, r.endStored)
		}
	}
	if kept.body != unkept.body {
		t.Errorf("the completion's body differs with the completion kept:\n  kept:     %s\n  not kept: %s", kept.body, unkept.body)
	}
	if !kept.kept || len(kept.left) != 0 {
		t.Errorf("the completion was on disk when it arrived: %v; left once answered: %v", kept.kept, kept.left)
	}
	if unkept.kept || !logged(unkept.logs, "could not be kept for the runner's next process") {
		t.Errorf("a completion the disk would not take was on disk (%v) or not said: %v", unkept.kept, unkept.logs.all())
	}
}

// A runner that stops before the control plane answers a turn's completion keeps it, whole, for its next process: here
// no answer comes until the stop has begun, and then a refusal that says nothing of the session.
func TestARunnerStoppingBeforeItsCompletionIsAnsweredKeepsIt(t *testing.T) {
	r, _ := newLinkEventsRig(t)
	trace := newCompletionTrace()
	shutdown, stop := context.WithCancel(context.Background())
	defer stop()
	arrived := make(chan struct{})
	var once sync.Once
	s := superviseOverLinkWithAnswers(t, r, newSessionPool(4), shutdown, trace, nil,
		func(req TurnCompleteRequest, rpc *linkpb.Rpc) *linkpb.RpcResult {
			once.Do(func() { close(arrived) })
			<-shutdown.Done()
			return fakeWorkAnswer(rpc, http.StatusBadRequest, `{"code":"REFUSED_FOR_THE_TEST"}`)
		}, oneTurnScript("answered before the stop")...)
	select {
	case <-arrived:
	case <-time.After(20 * time.Second):
		t.Fatal("the turn's completion never reached the control plane")
	}
	stop()
	waitUntil(t, func() bool {
		return logged(r.logs, "the completion of turn turn-1 of session sess-1 is kept for the runner's next process")
	},
		"the runner never said it kept the completion")
	path := newTurnCompletions(r.t, s.job.SessionID).path("turn-1")
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
			var completed TurnCompleteRequest
			_ = json.Unmarshal(rpc.GetTunnel().GetJsonBody(), &completed)
			if strings.HasSuffix(path, "/turn-complete") && completed.TurnID == "turn-0" {
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
	wire, _ := json.Marshal(kept)
	if bodies[0] != completionWireBody(t, wire) {
		t.Errorf("the kept completion went as %s, want %s", bodies[0], completionWireBody(t, wire))
	}
	if !spoolStoredFirst || fetchesBefore != 0 {
		t.Errorf("when the kept completion went the spool was stored: %v, and the supervisor had fetched %d time(s)", spoolStoredFirst, fetchesBefore)
	}
	mu.Unlock()
	if n := len(r.g.rpcsTo("/runner/sessions/" + s.job.SessionID + "/inbox")); n != 0 || len(s.fake.Spawns()) != 0 {
		t.Errorf("with turn-0 settled the supervisor fetched %d time(s) and started %d engine(s)", n, len(s.fake.Spawns()))
	}
	in.assertContiguous(t, s.job.SessionID, 1, 20)
	if _, err := os.Stat(newTurnCompletions(r.t, s.job.SessionID).path("turn-0")); !os.IsNotExist(err) {
		t.Errorf("the kept completion is still on disk once answered: %v", err)
	}
	if !logged(r.logs, "turn turn-0 of session sess-1, which an earlier process finished, is settled from the completion it kept: AWAITING_INPUT") {
		t.Errorf("the runner never said it settled turn-0: %v", r.logs.all())
	}

	// The next message claims the session: it is what the engine is handed, and nothing of turn-0.
	s.queue(RunInboxResponse{TurnID: "turn-1", Kind: "message", Content: "start the build"})
	if _, ok := pool.activate(s.job); !ok {
		t.Fatal("the next message's claim did not activate the session")
	}
	r.m.gates.markInbox(s.job.SessionID)
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

// With nothing kept (the runner killed before its engine finished the turn, or before the completion was written), the
// first fetch hands turn-0 back with its resume continuation, the engine runs it, and its completion goes once, from
// that run.
func TestWithNoCompletionKeptTheTurnIsHandedOutAgain(t *testing.T) {
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
	r, _ := newLinkEventsRig(t)
	trace := newCompletionTrace()
	pool := newSessionPool(4)
	s := superviseOverLinkWithAnswers(t, r, pool, context.Background(), trace,
		func(s *supervisedSession) {
			newTurnCompletions(r.t, s.job.SessionID).keep(TurnCompleteRequest{TurnID: "turn-0", Status: stFailed, Result: "API Error: 529 overloaded"})
		},
		func(req TurnCompleteRequest, rpc *linkpb.Rpc) *linkpb.RpcResult {
			return fakeWorkAnswer(rpc, http.StatusOK, `{"ok":true,"status":"FAILED"}`)
		}, oneTurnScript("never asked")...)
	waitUntil(t, func() bool { return !pool.ids()[s.job.SessionID] }, "the supervisor did not end the run")
	if n := trace.fetches(); n != 0 || len(s.fake.Spawns()) != 0 {
		t.Errorf("the run ended by its kept failed turn fetched %d time(s) and started %d engine(s)", n, len(s.fake.Spawns()))
	}
	if !logged(r.logs, "is settled from the completion it kept: FAILED") {
		t.Errorf("the runner never said it settled the failed turn: %v", r.logs.all())
	}
}

// A kept completion the control plane refuses for the session (409: another process owns it now) is dropped and said;
// the supervisor lets the session go, as for any such refusal.
func TestAKeptCompletionRefusedForTheSessionIsDroppedAndSaid(t *testing.T) {
	r, _ := newLinkEventsRig(t)
	trace := newCompletionTrace()
	pool := newSessionPool(4)
	s := superviseOverLinkWithAnswers(t, r, pool, context.Background(), trace,
		func(s *supervisedSession) {
			newTurnCompletions(r.t, s.job.SessionID).keep(TurnCompleteRequest{TurnID: "turn-0", Status: stSucceeded})
		},
		func(req TurnCompleteRequest, rpc *linkpb.Rpc) *linkpb.RpcResult {
			return fakeWorkAnswer(rpc, http.StatusConflict, `{"code":"CONFLICT","message":"runner process no longer owns this session"}`)
		}, oneTurnScript("never asked")...)
	waitUntil(t, func() bool { return !pool.ids()[s.job.SessionID] }, "the supervisor did not let the session go")
	if _, err := os.Stat(newTurnCompletions(r.t, s.job.SessionID).path("turn-0")); !os.IsNotExist(err) {
		t.Errorf("a completion refused for the session is still kept: %v", err)
	}
	if !logged(r.logs, "the completion an earlier process kept of turn turn-0 of session sess-1 is dropped: the control plane refused it for the session") {
		t.Errorf("the runner never said it dropped the completion: %v", r.logs.all())
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
	tr.link = newLinkMode(tr, logs.log)
	t.Cleanup(tr.link.close)
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
	tr.link = newLinkMode(tr, func(...any) {})
	newTurnCompletions(tr, "session-old").keep(TurnCompleteRequest{TurnID: "turn-9", Status: stSucceeded})
	spoolLeftBehind(t, linkSpoolDir(), "session-old", 5, 3, "turn-9")
	tr.link.close()
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
