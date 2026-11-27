package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// The session-release protocol from the runner's side (session_release.go, docs/session-three-state-plan.md step 6.2):
// declared only while the runner's own server says it offers it, and on nothing else; a failed turn under it is
// reported as the turn's outcome and the session held until a release of its own; a held session ends by that release
// alone, whatever the heartbeat says meanwhile and whichever replica answers; and without the offer, everything as
// before.

// releaseControlPlane is runnerStopControlPlane as a server that serves the session-release protocol (step 6.1): a
// failed turn whose report declares it is answered RUNNING (held), and POST /release is a route. missingRoute answers
// that many /release calls the way a replica without the route does.
type releaseControlPlane struct {
	*runnerStopControlPlane
	mu sync.Mutex
	// holds: the server serves the protocol. False is an older server, which ignores the declaration.
	holds        bool
	missingRoute int
	notFound     int
	releases     []map[string]json.RawMessage
	onHold       func()
}

func newReleaseControlPlane(holds bool) *releaseControlPlane {
	return &releaseControlPlane{runnerStopControlPlane: newRunnerStopControlPlane(), holds: holds}
}

func (c *releaseControlPlane) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case strings.HasSuffix(r.URL.Path, "/turn-complete"):
		body, _ := io.ReadAll(r.Body)
		var req TurnCompleteRequest
		_ = json.Unmarshal(body, &req)
		c.mu.Lock()
		hold := c.holds && req.ReleaseProtocol == sessionReleaseV1 && turnCompletionEndsSession(req)
		onHold := c.onHold
		c.mu.Unlock()
		if hold {
			c.runnerStopControlPlane.mu.Lock()
			c.runnerStopControlPlane.completions = append(c.runnerStopControlPlane.completions, req)
			c.runnerStopControlPlane.mu.Unlock()
			if onHold != nil {
				onHold()
			}
			_ = json.NewEncoder(w).Encode(TurnCompleteResponse{OK: true, Status: stRunning})
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		c.runnerStopControlPlane.serve(w, r)
	case strings.HasSuffix(r.URL.Path, "/release"):
		c.mu.Lock()
		if !c.holds || c.missingRoute > 0 {
			if c.missingRoute > 0 {
				c.missingRoute--
			}
			c.notFound++
			c.mu.Unlock()
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"Cannot POST /api` + r.URL.Path + `","error":"Not Found","statusCode":404}`))
			return
		}
		var body map[string]json.RawMessage
		_ = json.NewDecoder(r.Body).Decode(&body)
		c.releases = append(c.releases, body)
		c.mu.Unlock()
		c.runnerStopControlPlane.mu.Lock()
		c.runnerStopControlPlane.closed = true
		c.runnerStopControlPlane.mu.Unlock()
		_ = json.NewEncoder(w).Encode(RunFinalizeResponse{Ok: true, KeepCheckout: true})
	default:
		c.runnerStopControlPlane.serve(w, r)
	}
}

func (c *releaseControlPlane) releaseBodies() []map[string]json.RawMessage {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]map[string]json.RawMessage(nil), c.releases...)
}

func (c *releaseControlPlane) finalizeCount() int {
	c.runnerStopControlPlane.mu.Lock()
	defer c.runnerStopControlPlane.mu.Unlock()
	return len(c.runnerStopControlPlane.finalizes)
}

func (c *releaseControlPlane) misses() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.notFound
}

// releaseSession is a Claude session in a real checkout holding uncommitted work, supervised against api with a
// transport whose server's latest heartbeat answer offered the protocol, or did not.
type releaseSession struct {
	sup *runnerStopSupervisor
	t   *Transport
	wt  *Worktree
}

func superviseForRelease(t *testing.T, id string, active, offered bool, api *releaseControlPlane, steps ...fakeStep) *releaseSession {
	t.Helper()
	job := runnerStopJob(t, id)
	wt := sessionWorktree(t, id)
	job.WT = wt
	job.IsolationStatus = isoWorktree
	if len(steps) > 0 {
		fake := newFakeClaude(t, steps...)
		t.Setenv("PATH", fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	}
	server := httptest.NewServer(api)
	t.Cleanup(server.Close)
	transport := NewTransport(server.URL, "runner-token")
	if offered {
		transport.noteSessionReleaseOffer(&HeartbeatResponse{SessionReleaseV1: true})
	}
	pool := newSessionPool(4)
	sessionCtx, cancelSession := context.WithCancel(context.Background())
	runnerCtx, stopRunner := context.WithCancel(context.Background())
	live, added := pool.register(job, cancelSession, active)
	if !added {
		t.Fatal("the session was not registered")
	}
	s := &runnerStopSupervisor{job: job, pool: pool, live: live, stop: stopRunner, end: cancelSession, done: make(chan struct{})}
	go func() {
		defer close(s.done)
		runInteractiveSession(transport, job, sessionCtx, runnerCtx, wt.Path, nil, pool, live)
		pool.finish(live)
	}()
	t.Cleanup(func() {
		stopRunner()
		api.releaseLeases()
		select {
		case <-s.done:
		case <-time.After(4 * time.Minute):
			t.Error("the supervisor never returned")
		}
		cancelSession()
	})
	return &releaseSession{sup: s, t: transport, wt: wt}
}

// failingTurn is a CLI that reads the message and answers it with an error result: a failed turn of the session's own.
var failingTurn = []fakeStep{
	{Await: "user"},
	{Emit: "replay_user"},
	{Emit: "system_init"},
	{Emit: "result", Text: "API Error: 500 the model is overloaded", IsError: true},
}

func failedCompletionOf(t *testing.T, api *releaseControlPlane, turnID string) TurnCompleteRequest {
	t.Helper()
	for _, c := range api.turnCompletions() {
		if c.TurnID == turnID && c.Status == stFailed {
			return c
		}
	}
	t.Fatalf("turn %s was never reported failed: %+v", turnID, api.turnCompletions())
	return TurnCompleteRequest{}
}

// headMessage is the message of the commit the session's branch ends on.
func headMessage(t *testing.T, wt *Worktree) string {
	t.Helper()
	return mustGit(t, wt.RepoDir, "log", "-1", "--format=%B", "refs/heads/"+wt.Branch)
}

// The new protocol: the failed turn is reported as the turn's outcome (declared, answered RUNNING), the teardown cancel
// its report asked for arrives (as the next heartbeat hands it over), and the run ends by a release with no status
// word, no Claude session id and no cut-off outcome (the failure is already the turn's), never a finalize. The work it
// left is committed permanently: a failure it reported, not a stop it was told to make.
func TestFailedTurnUnderTheReleaseProtocolIsReportedThenReleased(t *testing.T) {
	shortDrainWait(t)
	api := newReleaseControlPlane(true)
	s := superviseForRelease(t, "sRelNew", true, true, api, failingTurn...)
	api.mu.Lock()
	// The teardown cancel the hold sets, handed over by the next heartbeat, a moment after the answer.
	api.onHold = func() { time.AfterFunc(20*time.Millisecond, s.sup.end) }
	api.mu.Unlock()
	api.queue(RunInboxResponse{TurnID: "turn-1", Kind: "message", Content: "deploy"})
	s.sup.awaitReturn(t, 2*time.Minute)

	if got := failedCompletionOf(t, api, "turn-1").ReleaseProtocol; got != sessionReleaseV1 {
		t.Fatalf("the failed turn's report declared %q, want %q", got, sessionReleaseV1)
	}
	if n := api.finalizeCount(); n != 0 {
		t.Fatalf("a held session was finalized %d time(s); only its release may end it", n)
	}
	releases := api.releaseBodies()
	if len(releases) != 1 {
		t.Fatalf("releases = %d, want exactly one", len(releases))
	}
	body := releases[0]
	for _, absent := range []string{"status", "claudeSessionId", "cutOffTurnOutcome"} {
		if _, ok := body[absent]; ok {
			t.Errorf("the release carried %q: %s", absent, body[absent])
		}
	}
	if got := string(body["releaseProtocol"]); got != `"`+sessionReleaseV1+`"` {
		t.Errorf("the release declared %s, want %q", got, sessionReleaseV1)
	}
	if msg := headMessage(t, s.wt); strings.Contains(msg, parkCheckpointTrailer) {
		t.Fatalf("the work of a failed turn was committed as an undoable park checkpoint: %q", msg)
	}
	if _, err := git(s.wt.RepoDir, "cat-file", "-e", "refs/heads/"+s.wt.Branch+":work.txt"); err != nil {
		t.Fatalf("the failed run's work is not on its branch: %v", err)
	}
}

// The same failed turn whose report gets no answer: the teardown cancel that report asked for cuts the request off
// before the answer arrives. The runner cannot know whether the hold was made, so it ends the run as a held one, by the
// release alone, and says the cut-off failure as well (the server reads the hold first if it was made, and otherwise
// records the failure on the turn the release cuts off). Still the permanent commit: the failure is the runner's own.
func TestFailedTurnWhoseReportHadNoAnswerEndsByTheReleaseAsAFailure(t *testing.T) {
	shortDrainWait(t)
	api := newReleaseControlPlane(true)
	s := superviseForRelease(t, "sRelLost", true, true, api, failingTurn...)
	api.mu.Lock()
	api.onHold = s.sup.end // the cancel lands before the answer is written
	api.mu.Unlock()
	api.queue(RunInboxResponse{TurnID: "turn-1", Kind: "message", Content: "deploy"})
	s.sup.awaitReturn(t, 2*time.Minute)

	if n := api.finalizeCount(); n != 0 {
		t.Fatalf("a session that may be held was finalized %d time(s)", n)
	}
	releases := api.releaseBodies()
	if len(releases) != 1 {
		t.Fatalf("releases = %d, want exactly one", len(releases))
	}
	if got := string(releases[0]["cutOffTurnOutcome"]); got != `"FAILED"` {
		t.Errorf("cutOffTurnOutcome = %s, want \"FAILED\": the runner does not know the hold was made", got)
	}
	if msg := headMessage(t, s.wt); strings.Contains(msg, parkCheckpointTrailer) {
		t.Fatalf("the work of a failed turn was committed as an undoable park checkpoint: %q", msg)
	}
}

// What a failed turn's report tells of the hold.
func TestHoldAfterReport(t *testing.T) {
	refused := &transportHTTPError{method: "POST", path: "/runner/sessions/s/turn-complete", statusCode: 400, body: `{}`}
	for _, tc := range []struct {
		name     string
		declared bool
		status   string
		err      error
		want     failedTurnHold
	}{
		{"not declared, answered FAILED", false, stFailed, nil, holdNone},
		{"not declared, no answer", false, "", context.Canceled, holdNone},
		{"declared, answered RUNNING", true, stRunning, nil, holdConfirmed},
		{"declared, answered FAILED (a replica without the protocol)", true, stFailed, nil, holdNone},
		{"declared, refused", true, "", refused, holdNone},
		{"declared, no answer", true, "", context.Canceled, holdUnknown},
		{"declared, the connection dropped", true, "", io.ErrUnexpectedEOF, holdUnknown},
	} {
		if got := holdAfterReport(tc.declared, tc.status, tc.err); got != tc.want {
			t.Errorf("%s: %v, want %v", tc.name, got, tc.want)
		}
	}
}

// The old protocol, as before: a runner whose server has not offered the protocol declares nothing, its failed turn is
// answered FAILED (released in that write), and nothing follows: no release, no finalize, no commit. The same against
// an older replica that ignores the declaration of a runner whose server did offer it (a stale word): the answer is
// FAILED, so the run is over as before.
func TestFailedTurnWithoutTheOfferIsTodays(t *testing.T) {
	for _, tc := range []struct {
		name           string
		offered, holds bool
		wantDeclared   string
	}{
		{"not offered, a server that serves it", false, true, ""},
		{"not offered, an older server", false, false, ""},
		{"offered, but answered by a replica without it", true, false, sessionReleaseV1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			shortDrainWait(t)
			api := newReleaseControlPlane(tc.holds)
			s := superviseForRelease(t, "sRelOld", true, tc.offered, api, failingTurn...)
			base := mustGit(t, s.wt.RepoDir, "rev-parse", "refs/heads/"+s.wt.Branch)
			api.queue(RunInboxResponse{TurnID: "turn-1", Kind: "message", Content: "deploy"})
			s.sup.awaitReturn(t, 2*time.Minute)

			if got := failedCompletionOf(t, api, "turn-1").ReleaseProtocol; got != tc.wantDeclared {
				t.Fatalf("the failed turn's report declared %q, want %q", got, tc.wantDeclared)
			}
			if n, r := api.finalizeCount(), len(api.releaseBodies()); n != 0 || r != 0 {
				t.Fatalf("after a failed turn answered FAILED: %d finalize(s), %d release(s); want none, as before", n, r)
			}
			if tip := mustGit(t, s.wt.RepoDir, "rev-parse", "refs/heads/"+s.wt.Branch); tip != base {
				t.Fatalf("the branch moved from %s to %s; the old protocol commits nothing after a failed turn", base, tip)
			}
		})
	}
}

// A hold made just before the word goes away (one replica with the switch on, the next answer from one with it off, or
// restarted without it): the declaration is off from that answer on, and the held session still ends by a release,
// sent again past a replica without the route, and never by a finalize, which such a replica would read as a stop.
func TestHeldSessionIsReleasedThroughFlappingAndMissingRoutes(t *testing.T) {
	shortDrainWait(t)
	restore := releaseRetryPause
	releaseRetryPause = 10 * time.Millisecond
	t.Cleanup(func() { releaseRetryPause = restore })

	api := newReleaseControlPlane(true)
	s := superviseForRelease(t, "sRelFlap", true, true, api, failingTurn...)
	api.mu.Lock()
	api.missingRoute = 3
	api.onHold = func() {
		// The next heartbeat answer, from a replica whose switch is off.
		s.t.noteSessionReleaseOffer(&HeartbeatResponse{})
		s.sup.end()
	}
	api.mu.Unlock()
	api.queue(RunInboxResponse{TurnID: "turn-1", Kind: "message", Content: "deploy"})
	s.sup.awaitReturn(t, 2*time.Minute)

	if s.t.offersSessionRelease() {
		t.Fatal("the declaration is still on after an answer without the word")
	}
	if got := api.misses(); got != 3 {
		t.Fatalf("the release met a missing route %d time(s), want 3: it was not sent again", got)
	}
	if n := api.finalizeCount(); n != 0 {
		t.Fatalf("a held session was finalized %d time(s) after its release met a replica without the route", n)
	}
	if r := len(api.releaseBodies()); r != 1 {
		t.Fatalf("releases = %d, want one, once the route answered", r)
	}
}

// A run's end with no failed turn held: under the offer, the release, and the stop it was told to make is committed as
// the undoable park checkpoint; against a server without the route, the old finalize (CANCELLED) as before.
func TestRunEndWithoutAHoldUnderTheOffer(t *testing.T) {
	t.Run("released", func(t *testing.T) {
		api := newReleaseControlPlane(true)
		s := superviseForRelease(t, "sRelEnd", false, true, api)
		s.sup.end()
		s.sup.awaitReturn(t, time.Minute)
		releases := api.releaseBodies()
		if len(releases) != 1 || api.finalizeCount() != 0 {
			t.Fatalf("releases = %d, finalizes = %d; want the release alone", len(releases), api.finalizeCount())
		}
		if _, ok := releases[0]["cutOffTurnOutcome"]; ok {
			t.Errorf("a stop reported a cut-off failure: %s", releases[0]["cutOffTurnOutcome"])
		}
		if msg := headMessage(t, s.wt); !strings.Contains(msg, parkCheckpointTrailer+": "+s.wt.Session) {
			t.Fatalf("a stop it was told to make was not committed as a park checkpoint: %q", msg)
		}
	})
	t.Run("an older server", func(t *testing.T) {
		api := newReleaseControlPlane(false)
		s := superviseForRelease(t, "sRelEndOld", false, true, api)
		s.sup.end()
		s.sup.awaitReturn(t, time.Minute)
		if got := api.finalizeStatuses(); len(got) != 1 || got[0] != stCancelled {
			t.Fatalf("finalizes = %v, want one CANCELLED after the release route was missing", got)
		}
		if api.misses() != 1 || len(api.releaseBodies()) != 0 {
			t.Fatalf("release attempts: %d missing, %d landed; want one missing, none landed", api.misses(), len(api.releaseBodies()))
		}
	})
	t.Run("not offered", func(t *testing.T) {
		api := newReleaseControlPlane(true)
		s := superviseForRelease(t, "sRelEndOff", false, false, api)
		s.sup.end()
		s.sup.awaitReturn(t, time.Minute)
		if got := api.finalizeStatuses(); len(got) != 1 || got[0] != stCancelled {
			t.Fatalf("finalizes = %v, want one CANCELLED, as before", got)
		}
		if api.misses() != 0 || len(api.releaseBodies()) != 0 {
			t.Fatal("a runner whose server did not offer the protocol sent a release")
		}
	})
}

// What the runner reads the offer from: a successful heartbeat answer of its own server, and only its latest. A process
// that never had one declares nothing; an older server's answer (no field) reads as off; a future field is ignored by
// the same decoder an older runner has (encoding/json, no DisallowUnknownFields), which is why an older runner is
// unaffected by the word.
func TestSessionReleaseOfferIsTheLatestHeartbeatAnswer(t *testing.T) {
	tr := NewTransport("http://127.0.0.1:1", "runner-token")
	if tr.offersSessionRelease() {
		t.Fatal("a runner that never had a heartbeat answer declares the protocol")
	}
	var on, off, future HeartbeatResponse
	if err := json.Unmarshal([]byte(`{"cancelSessionIds":[],"maxConcurrent":4,"sessionReleaseV1":true}`), &on); err != nil || !on.SessionReleaseV1 {
		t.Fatalf("the word did not decode: %v %+v", err, on)
	}
	if err := json.Unmarshal([]byte(`{"cancelSessionIds":[],"maxConcurrent":4}`), &off); err != nil || off.SessionReleaseV1 {
		t.Fatalf("an older server's answer did not read as off: %v %+v", err, off)
	}
	if err := json.Unmarshal([]byte(`{"cancelSessionIds":[],"sessionReleaseV1":true,"aWordFromTheFuture":{"x":1}}`), &future); err != nil {
		t.Fatalf("an answer with a field this binary does not know failed to decode: %v", err)
	}
	tr.noteSessionReleaseOffer(&on)
	if !tr.offersSessionRelease() {
		t.Fatal("the word did not turn the declaration on")
	}
	tr.noteSessionReleaseOffer(nil) // a beat that failed: no answer, nothing learned
	if !tr.offersSessionRelease() {
		t.Fatal("a failed beat changed the declaration")
	}
	tr.noteSessionReleaseOffer(&off)
	if tr.offersSessionRelease() {
		t.Fatal("the first answer without the word did not turn the declaration off")
	}
	// Flapping between replicas that disagree: each answer decides, and nothing is remembered past it.
	for i, answer := range []HeartbeatResponse{on, off, on, on, off} {
		tr.noteSessionReleaseOffer(&answer)
		if tr.offersSessionRelease() != answer.SessionReleaseV1 {
			t.Fatalf("answer %d: declaration %v, want %v", i, tr.offersSessionRelease(), answer.SessionReleaseV1)
		}
	}
}

// Which reports declare it: only a failed turn that ends the run, and only under the offer. A turn reported SUCCEEDED
// could still fail its session at the server (an acceptance mismatch), and a RUNNING answer to it could not be told
// from a permit handed to a follow-up; a failed steer or unknown kind ends nothing.
func TestTurnReportsDeclareTheProtocolOnlyOnAFailedTurnThatEndsTheRun(t *testing.T) {
	var mu sync.Mutex
	var got []TurnCompleteRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req TurnCompleteRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		mu.Lock()
		got = append(got, req)
		mu.Unlock()
		_ = json.NewEncoder(w).Encode(TurnCompleteResponse{OK: true, Status: stAwaitingInput})
	}))
	t.Cleanup(server.Close)
	tr := NewTransport(server.URL, "runner-token")
	reports := []TurnCompleteRequest{
		{TurnID: "failed", Status: stFailed},
		{TurnID: "succeeded", Status: stSucceeded},
		{TurnID: "steer", Status: stFailed, Subtype: subtypeSteer},
		{TurnID: "unknown", Status: stFailed, Subtype: subtypeUnknownKind},
		{TurnID: "interrupted", Status: stInterrupted},
	}
	for _, offered := range []bool{false, true} {
		tr.noteSessionReleaseOffer(&HeartbeatResponse{SessionReleaseV1: offered})
		for _, req := range reports {
			_, declared, err := tr.turnCompleteReporting(context.Background(), "s1", req)
			if err != nil {
				t.Fatal(err)
			}
			want := offered && req.TurnID == "failed"
			if declared != want {
				t.Errorf("offered=%v %s: declared %v, want %v", offered, req.TurnID, declared, want)
			}
		}
	}
	mu.Lock()
	defer mu.Unlock()
	for i, req := range got {
		want := ""
		if i >= len(reports) && req.TurnID == "failed" {
			want = sessionReleaseV1
		}
		if req.ReleaseProtocol != want {
			t.Errorf("report %d (%s) carried releaseProtocol %q, want %q", i, req.TurnID, req.ReleaseProtocol, want)
		}
	}
	if heldByFailedTurn(false, stRunning) || !heldByFailedTurn(true, stRunning) || heldByFailedTurn(true, stFailed) {
		t.Error("heldByFailedTurn: a hold is a declared report answered RUNNING, and nothing else")
	}
}

// The release body: the finalize report without its status word or Claude session id, the declaration, and a cut-off
// failure only for a run that failed with no turn it reported.
func TestReleaseRequestBody(t *testing.T) {
	base := RunFinalizeRequest{Status: stFailed, Error: "engine exited 3 times", ClaudeSessionID: "c1", NumTurns: 2, Branch: "orbit/x", WorktreeDirty: true}
	for _, tc := range []struct {
		name      string
		req       RunReleaseRequest
		wantCutOf string
	}{
		{"a cut-off failure", releaseRequestOf(base, holdNone), `"FAILED"`},
		{"a held failed turn", releaseRequestOf(base, holdConfirmed), ""},
		{"a failed turn whose report had no answer", releaseRequestOf(base, holdUnknown), `"FAILED"`},
		{"a stop", releaseRequestOf(RunFinalizeRequest{Status: stCancelled}, holdNone), ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := json.Marshal(tc.req)
			if err != nil {
				t.Fatal(err)
			}
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(raw, &fields); err != nil {
				t.Fatal(err)
			}
			if _, ok := fields["status"]; ok {
				t.Errorf("status in %s", raw)
			}
			if _, ok := fields["claudeSessionId"]; ok {
				t.Errorf("claudeSessionId in %s", raw)
			}
			if string(fields["releaseProtocol"]) != `"`+sessionReleaseV1+`"` {
				t.Errorf("no declaration in %s", raw)
			}
			if string(fields["cutOffTurnOutcome"]) != tc.wantCutOf {
				t.Errorf("cutOffTurnOutcome = %s, want %q", fields["cutOffTurnOutcome"], tc.wantCutOf)
			}
			if tc.req.Status == stFailed && string(fields["error"]) != `"engine exited 3 times"` {
				t.Errorf("the run's error is not carried: %s", raw)
			}
		})
	}
}
