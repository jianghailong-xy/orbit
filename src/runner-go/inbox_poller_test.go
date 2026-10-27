package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"orbit/linkpb"
)

// The inbox poller (inbox_poller.go). Over HTTPS: the long poll it always was, and a second's wait after a failure.
// Over the link: a fetch only when there is something to fetch, until the inbox answers nothing; runningTurnId on
// every fetch; a failed fetch retried without waiting for a hint; a turn whose answer was lost handed back at once and
// run once; nothing fetched once the engine generation is over.

// fakeLinkInbox is one session's inbox as the control plane serves a link call (dequeueTurn, task B2): turns handed out
// in the order they were queued; a message or shell turn leased IN_FLIGHT under the fetch's lease generation until its
// turn completion, and meanwhile handed straight back to a fetch of that generation that names another running turn,
// or none; every other kind answered as it is handed out. A fetch sent again under the request id of one that handed a
// turn out is answered with that turn, whatever its kind, a withdraw only within its delivery window (task B2b). serve
// is a fakeWorkGateway backend.
type fakeLinkInbox struct {
	mu       sync.Mutex
	queued   map[string][]RunInboxResponse // by session
	inFlight map[string]*fakeLinkLease     // by session
	handedBy map[string]fakeLinkHandOut    // by the request id of the fetch that handed the turn out
	fetches  []fakeLinkFetch
	// completions are the turns whose turn completions were taken, in order.
	completions []string
	// lose, when it says so, drops the connection instead of answering a fetch that handed a turn out: an answer lost
	// on its way back, after the dequeue committed.
	lose func(f fakeLinkFetch) bool
	// fail, when it answers, is the answer to a fetch in place of the turn the fetch handed out.
	fail func(f fakeLinkFetch, rpc *linkpb.Rpc) *linkpb.RpcResult
	// hold, when set, is waited for before a fetch is served.
	hold chan struct{}
}

// fakeLinkLease is a message or shell turn leased IN_FLIGHT, and the lease generation that holds it.
type fakeLinkLease struct {
	turn       RunInboxResponse
	generation string
}

// fakeLinkHandOut is a turn a fetch handed out, the session and lease generation it was handed out to, and when.
type fakeLinkHandOut struct {
	session, generation string
	turn                RunInboxResponse
	at                  time.Time
}

// fakeWithdrawWindow is how long a withdraw is handed out at all: STEER_WITHDRAW_DELIVERY_WINDOW_MS
// (src/apiserver/src/sessions/steer-withdraw.ts), counted here from its first hand-out.
const fakeWithdrawWindow = 8 * time.Second

// fakeLinkFetch is one inbox fetch the control plane served.
type fakeLinkFetch struct {
	requestID  string
	at         time.Time
	session    string
	generation string
	running    string // runningTurnId
	stated     bool   // whether the fetch carried runningTurnId at all
	handed     string // the turn handed out, "" for none
}

func newFakeLinkInbox() *fakeLinkInbox {
	return &fakeLinkInbox{queued: map[string][]RunInboxResponse{}, inFlight: map[string]*fakeLinkLease{},
		handedBy: map[string]fakeLinkHandOut{}}
}

// queue queues turns in session's inbox.
func (in *fakeLinkInbox) queue(session string, turns ...RunInboxResponse) {
	in.mu.Lock()
	in.queued[session] = append(in.queued[session], turns...)
	in.mu.Unlock()
}

func (in *fakeLinkInbox) fetched() []fakeLinkFetch {
	in.mu.Lock()
	defer in.mu.Unlock()
	return append([]fakeLinkFetch(nil), in.fetches...)
}

// fetchedFor is the fetches of one session.
func (in *fakeLinkInbox) fetchedFor(session string) []fakeLinkFetch {
	var out []fakeLinkFetch
	for _, f := range in.fetched() {
		if f.session == session {
			out = append(out, f)
		}
	}
	return out
}

func (in *fakeLinkInbox) completed() []string {
	in.mu.Lock()
	defer in.mu.Unlock()
	return append([]string(nil), in.completions...)
}

// handedOut counts the fetches that handed turnID out.
func (in *fakeLinkInbox) handedOut(turnID string) int {
	n := 0
	for _, f := range in.fetched() {
		if f.handed == turnID {
			n++
		}
	}
	return n
}

func (in *fakeLinkInbox) serve(c *fakeWorkConn, rpc *linkpb.Rpc) *linkpb.RpcResult {
	path := rpc.GetTunnel().GetPath()
	switch {
	case strings.Contains(path, "/inbox"):
		return in.fetch(c, rpc)
	case strings.HasSuffix(path, "/turn-complete"):
		var req TurnCompleteRequest
		_ = json.Unmarshal(rpc.GetTunnel().GetJsonBody(), &req)
		session := linkPathSegment(path, 2)
		in.mu.Lock()
		if lease := in.inFlight[session]; lease != nil && lease.turn.TurnID == req.TurnID {
			delete(in.inFlight, session)
		}
		in.completions = append(in.completions, req.TurnID)
		in.mu.Unlock()
		return fakeWorkAnswer(rpc, 200, `{"ok":true,"status":"AWAITING_INPUT"}`)
	}
	return fakeWorkAnswer(rpc, 200, `{}`)
}

func (in *fakeLinkInbox) fetch(c *fakeWorkConn, rpc *linkpb.Rpc) *linkpb.RpcResult {
	in.mu.Lock()
	hold := in.hold
	in.mu.Unlock()
	if hold != nil {
		<-hold
	}
	u, err := url.Parse(rpc.GetTunnel().GetPath())
	if err != nil {
		return fakeWorkAnswer(rpc, 400, `{"code":"BAD_REQUEST"}`)
	}
	q := u.Query()
	f := fakeLinkFetch{requestID: rpc.GetRequestId(), at: time.Now(), session: linkPathSegment(u.Path, 2),
		generation: q.Get("leaseGeneration"), running: q.Get("runningTurnId"), stated: q.Has("runningTurnId")}
	in.mu.Lock()
	var turn *RunInboxResponse
	lease := in.inFlight[f.session]
	if prior, ok := in.handedBy[f.requestID]; ok && prior.session == f.session && prior.generation == f.generation &&
		(prior.turn.Kind != "withdraw" || time.Since(prior.at) < fakeWithdrawWindow) {
		picked := prior.turn // the same fetch sent again: the turn it handed out
		turn = &picked
	} else if lease != nil && f.stated && lease.generation == f.generation && lease.turn.TurnID != f.running {
		picked := lease.turn // the generation's own lease, which the fetch says it is not running
		turn = &picked
	} else {
		queued := in.queued[f.session]
		for i, next := range queued {
			executable := next.Kind == "message" || next.Kind == "shell"
			if executable && lease != nil {
				continue // the one executable slot is taken
			}
			in.queued[f.session] = append(queued[:i:i], queued[i+1:]...)
			picked := next
			turn = &picked
			if executable {
				in.inFlight[f.session] = &fakeLinkLease{turn: next, generation: f.generation}
			}
			break
		}
	}
	if turn != nil {
		f.handed = turn.TurnID
		if prior, ok := in.handedBy[f.requestID]; !ok || prior.turn.TurnID != turn.TurnID {
			in.handedBy[f.requestID] = fakeLinkHandOut{session: f.session, generation: f.generation, turn: *turn, at: f.at}
		}
	}
	in.fetches = append(in.fetches, f)
	lose, fail := in.lose, in.fail
	in.mu.Unlock()
	if turn != nil && lose != nil && lose(f) {
		c.drop()
		return nil
	}
	if fail != nil {
		if res := fail(f, rpc); res != nil {
			return res
		}
	}
	if turn == nil {
		return fakeWorkAnswer(rpc, 200, `{"turnId":"","seq":0,"kind":"message"}`)
	}
	body, _ := json.Marshal(turn)
	return fakeWorkAnswer(rpc, 200, string(body))
}

// pollInBackground hands every turn p.next returns to the channel, until p fails or the test ends.
func pollInBackground(t *testing.T, p *inboxPoller) <-chan *RunInboxResponse {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	out := make(chan *RunInboxResponse, 64)
	go func() {
		defer close(out)
		for {
			turn, err := p.next(ctx)
			if err != nil {
				return
			}
			out <- turn
		}
	}()
	return out
}

func recvTurn(t *testing.T, turns <-chan *RunInboxResponse, within time.Duration, want string) *RunInboxResponse {
	t.Helper()
	select {
	case turn, ok := <-turns:
		if !ok {
			t.Fatalf("the poller stopped before handing over %s", want)
		}
		if turn.TurnID != want {
			t.Fatalf("handed %s (%s), want %s", turn.TurnID, turn.Kind, want)
		}
		return turn
	case <-time.After(within):
		t.Fatalf("%s was not handed over within %s", want, within)
	}
	return nil
}

func sendInboxHint(conn *fakeWorkConn, sessionID string) {
	conn.send(&linkpb.Frame{Body: &linkpb.Frame_Hint{Hint: &linkpb.Hint{Kind: &linkpb.Hint_Inbox{Inbox: &linkpb.InboxHint{SessionId: sessionID}}}}})
}

// currentConn is the connection the runner's work goes out on now.
func (r *linkWorkRig) currentConn(t *testing.T) *fakeWorkConn {
	t.Helper()
	var conn *fakeWorkConn
	linkWaitFor(t, 15*time.Second, "a work connection", func() bool {
		cur := r.m.work.current()
		if cur == nil {
			return false
		}
		for _, c := range r.g.open() {
			if c.id == cur.id {
				conn = c
				return true
			}
		}
		return false
	})
	return conn
}

// Over the link the poller fetches only when there is something to fetch: its first fetch at once, then once more after
// each fetch that handed it a turn, until the inbox answers nothing; after that, only for an InboxHint naming its
// session or a HeartbeatAck whose HintState does. Nothing else asks, however long it waits. Every fetch says which turn
// this process runs in the session.
func TestInboxPollerOnTheLinkFetchesOnlyWhenThereIsSomethingToFetch(t *testing.T) {
	shortenLinkWaits(t, 100*time.Millisecond, linkApprovalRecheck, linkAfterSeqWait)
	r := newLinkWorkRig(t)
	in := newFakeLinkInbox()
	in.queue("session-a", RunInboxResponse{TurnID: "c-1", Kind: "interrupt"}, RunInboxResponse{TurnID: "c-2", Kind: "diff"},
		RunInboxResponse{TurnID: "m-1", Kind: "message", Content: "hi"})
	r.g.backend = in.serve
	conn := r.useLink(t)
	p := newInboxPoller(r.t, "session-a", "gen-1")
	defer p.close()
	turns := pollInBackground(t, p)

	// Three turns queued at once, one reason to ask: every one of them, then the fetch that finds nothing.
	for _, want := range []string{"c-1", "c-2", "m-1"} {
		recvTurn(t, turns, 5*time.Second, want)
	}
	linkWaitFor(t, 5*time.Second, "the fetch that finds the inbox empty", func() bool { return len(in.fetched()) == 4 })
	time.Sleep(600 * time.Millisecond) // six of the poller's windows
	if n := len(in.fetched()); n != 4 {
		t.Fatalf("%d fetches, 4 with nothing more to fetch", n)
	}

	// A hint for another session asks nothing.
	sendInboxHint(conn, "session-b")
	time.Sleep(200 * time.Millisecond)
	if n := len(in.fetched()); n != 4 {
		t.Fatalf("a hint for another session fetched this one's inbox: %d fetches", n)
	}
	// A hint for this one asks, until the inbox answers nothing.
	in.queue("session-a", RunInboxResponse{TurnID: "c-3", Kind: "reload", Content: "{}"})
	sendInboxHint(conn, "session-a")
	recvTurn(t, turns, 5*time.Second, "c-3")
	linkWaitFor(t, 5*time.Second, "the fetch after c-3", func() bool { return len(in.fetched()) == 6 })
	// So does a HeartbeatAck naming the session.
	in.queue("session-a", RunInboxResponse{TurnID: "c-4", Kind: "diff"})
	r.g.mu.Lock()
	r.g.ackHints = &linkpb.HintState{InboxSessionIds: []string{"session-a"}}
	r.g.mu.Unlock()
	if _, err := r.t.heartbeat(HeartbeatRequest{Status: "ONLINE", LeaseOwner: r.t.leaseOwner}); err != nil {
		t.Fatal(err)
	}
	recvTurn(t, turns, 5*time.Second, "c-4")
	linkWaitFor(t, 5*time.Second, "the fetch after c-4", func() bool { return len(in.fetched()) == 8 })
	time.Sleep(300 * time.Millisecond)
	fetches := in.fetched()
	if len(fetches) != 8 {
		t.Fatalf("%d fetches, want 8", len(fetches))
	}
	// Each said which turn this process runs: none until m-1 was handed over, m-1 since.
	for i, f := range fetches {
		want := ""
		if i >= 3 {
			want = "m-1"
		}
		if !f.stated || f.running != want {
			t.Errorf("fetch %d says runningTurnId %q (stated %v), want %q", i, f.running, f.stated, want)
		}
	}
}

// A fetch that failed is fetched again once its backoff has passed, without waiting for anything to say there is
// something to fetch, and never sooner than the answer's retry_after. When the control plane had handed a turn out
// whose answer the runner never got, the next fetch, naming no running turn, has it handed straight back. No hint, and
// no HintState, would ever name that turn: it is IN_FLIGHT under this generation's lease, which HintState leaves out,
// so B6's gate, which waited for one, waited until the lease ran out 300 s later.
func TestInboxPollerFetchesAgainAfterAFailureWithoutAHint(t *testing.T) {
	t.Run("retry_after", func(t *testing.T) {
		r := newLinkWorkRig(t)
		in := newFakeLinkInbox()
		in.queue("session-a", RunInboxResponse{TurnID: "m-1", Kind: "message", Content: "hi"})
		var refusedAt atomic.Int64
		r.g.backend = func(c *fakeWorkConn, rpc *linkpb.Rpc) *linkpb.RpcResult {
			if strings.Contains(rpc.GetTunnel().GetPath(), "/inbox") && refusedAt.CompareAndSwap(0, time.Now().UnixNano()) {
				// Turned away by the database before anything was dequeued (runner-link-error.filter.ts).
				return &linkpb.RpcResult{RequestId: rpc.GetRequestId(), Outcome: &linkpb.RpcResult_Tunnel{Tunnel: &linkpb.TunnelResponse{
					Status: http.StatusServiceUnavailable, RetryAfterMs: 1500,
					JsonBody: []byte(`{"code":"DATABASE_UNAVAILABLE","retryable":true,"retryAfterMs":1500}`),
				}}}
			}
			return in.serve(c, rpc)
		}
		r.useLink(t)
		p := newInboxPoller(r.t, "session-a", "gen-1")
		defer p.close()
		recvTurn(t, pollInBackground(t, p), 10*time.Second, "m-1")
		fetches := in.fetched()
		waited := fetches[0].at.Sub(time.Unix(0, refusedAt.Load()))
		if waited < 1500*time.Millisecond || waited > 2500*time.Millisecond {
			t.Errorf("fetched again %s after a refusal asking for 1.5 s", waited)
		}
	})
	t.Run("an answer the runner never got", func(t *testing.T) {
		r := newLinkWorkRig(t)
		in := newFakeLinkInbox()
		in.queue("session-a", RunInboxResponse{TurnID: "m-1", Kind: "message", Content: "hi"})
		var failed atomic.Bool
		in.fail = func(f fakeLinkFetch, rpc *linkpb.Rpc) *linkpb.RpcResult {
			if f.handed != "" && failed.CompareAndSwap(false, true) {
				// The dequeue committed and the answer was lost on the way, as a failure the call is not sent
				// again for.
				return fakeWorkFailure(rpc, "BACKEND_ANSWER_LOST", false, 0)
			}
			return nil
		}
		r.g.backend = in.serve
		r.useLink(t)
		p := newInboxPoller(r.t, "session-a", "gen-1")
		defer p.close()
		recvTurn(t, pollInBackground(t, p), 5*time.Second, "m-1")
		fetches := in.fetched()
		if len(fetches) < 2 || fetches[0].handed != "m-1" || fetches[1].handed != "m-1" {
			t.Fatalf("fetches %+v: want m-1 handed out, lost, and handed out again", fetches)
		}
		if !fetches[1].stated || fetches[1].running != "" {
			t.Errorf("the fetch after the loss says runningTurnId %q (stated %v), want \"\"", fetches[1].running, fetches[1].stated)
		}
		if fetches[0].requestID == fetches[1].requestID {
			t.Errorf("the second fetch is the first sent again (%s): want a fetch of its own", fetches[1].requestID)
		}
		if took := fetches[1].at.Sub(fetches[0].at); took > 5*time.Second {
			t.Errorf("m-1 was handed back %s after its answer was lost", took)
		}
		r.g.mu.Lock()
		hints := r.g.ackHints
		r.g.mu.Unlock()
		if hints != nil {
			t.Fatal("the test sent a HintState: the fetch again must need none")
		}
	})
}

// A fetch whose answer is lost on its way back, after the control plane handed the turn out, gets that same turn back
// within 5 s, and the session loop runs it once. The connection drops with the answer; the call is sent again on the
// next connection under its request_id, saying no turn is running, and the control plane hands the turn, IN_FLIGHT
// under the generation's lease, straight back. Every fetch while it runs names it, so it is not handed out a third time,
// and its completion goes once.
func TestALostInboxAnswerIsHandedBackWithinFiveSecondsAndRunOnce(t *testing.T) {
	for _, engine := range []string{providerClaude, providerCodex, providerKimi, providerOpenCode} {
		t.Run(engine, func(t *testing.T) {
			r := newLinkWorkRig(t)
			in := newFakeLinkInbox()
			const text = "do the thing"
			var lostAt atomic.Int64
			in.lose = func(f fakeLinkFetch) bool {
				return f.handed == "m-1" && lostAt.CompareAndSwap(0, time.Now().UnixNano())
			}
			r.g.backend = in.serve
			r.useLink(t)
			in.queue(lostAnswerSessionID, RunInboxResponse{TurnID: "m-1", Kind: "message", Content: text})

			run, ran, completed := lostAnswerSession(t, engine, r)
			done := make(chan struct{})
			go func() {
				defer close(done)
				run()
			}()
			linkWaitFor(t, 15*time.Second, "the engine to run m-1", func() bool { return ran() >= 1 })
			handedBack := time.Now()
			// Answered, not only taken: the control plane takes the completion before its answer reaches the runner,
			// and until then the runner still names m-1 as running (linkMode.turnDone), as it must.
			linkWaitFor(t, 15*time.Second, "m-1's completion", func() bool { return completed() == 1 })
			if lostAt.Load() == 0 {
				t.Fatal("no answer was lost")
			}
			if took := handedBack.Sub(time.Unix(0, lostAt.Load())); took > 5*time.Second {
				t.Errorf("m-1 reached the engine %s after its answer was lost", took)
			}

			// End the session, on whatever connection carries the work now, once the fetch that followed m-1's
			// hand-back has been served: the fetch the hint brings is then the first sent since the completion.
			linkWaitFor(t, 5*time.Second, "the fetch after m-1 was handed back", func() bool { return len(in.fetched()) >= 3 })
			in.queue(lostAnswerSessionID, RunInboxResponse{TurnID: "e-1", Kind: "end"})
			sendInboxHint(r.currentConn(t), lostAnswerSessionID)
			select {
			case <-done:
			case <-time.After(15 * time.Second):
				t.Fatal("the session loop did not end")
			}

			if n := ran(); n != 1 {
				t.Errorf("the engine ran m-1 %d times", n)
			}
			if got := in.completed(); len(got) != 1 || got[0] != "m-1" {
				t.Errorf("turn completions %v, want [m-1]", got)
			}
			fetches := in.fetched()
			if len(fetches) < 2 || fetches[0].handed != "m-1" || fetches[1].handed != "m-1" {
				t.Fatalf("fetches %+v: want m-1 handed out, lost, and handed out again", fetches)
			}
			if fetches[1].requestID != fetches[0].requestID || fetches[1].running != "" || !fetches[1].stated {
				t.Errorf("the fetch after the loss %+v: want the lost call sent again, naming no running turn", fetches[1])
			}
			// Handed out twice, the lost answer and the call sent again: every fetch after that named m-1 while it
			// ran, and nothing once its completion was answered.
			if n := in.handedOut("m-1"); n != 2 {
				t.Errorf("m-1 was handed out %d times, want 2", n)
			}
			for _, f := range fetches {
				if f.handed == "e-1" && f.running != "" {
					t.Errorf("the fetch that ended the session, after m-1's completion, says runningTurnId %q", f.running)
				}
			}
			if n := in.handedOut("e-1"); n != 1 {
				t.Errorf("e-1 was handed out %d times", n)
			}
		})
	}
}

const lostAnswerSessionID = "sess-lost"

// lostAnswerSession is a session loop of engine over r's transport, how many times its engine has run the message
// "do the thing", and how many of its turn completions the control plane has answered.
func lostAnswerSession(t *testing.T, engine string, r *linkWorkRig) (run func(), ran func() int, completed func() int) {
	t.Helper()
	var answered atomic.Int32
	complete := func(req TurnCompleteRequest, _ ...context.Context) error {
		_, err := r.t.turnComplete(context.Background(), lostAnswerSessionID, req)
		if err == nil {
			answered.Add(1)
		}
		return err
	}
	completed = func() int { return int(answered.Load()) }
	permit := func(context.Context) bool { return true }
	noEmit := func(string, map[string]interface{}) {}
	noEmitFor := func(string, string, map[string]interface{}) {}
	dir := t.TempDir()
	switch engine {
	case providerClaude:
		fake := newFakeClaude(t,
			fakeStep{Emit: "system_init"},
			fakeStep{Await: "user"},
			fakeStep{Emit: "replay_user"},
			fakeStep{Emit: "assistant", Text: "done"},
			fakeStep{Emit: "result"},
		)
		t.Setenv("PATH", fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))
		job := claudeSpawnJob(t)
		job.SessionID = lostAnswerSessionID
		run = func() {
			runClaudeSessionProcess(context.Background(), context.Background(), r.t, job, "gen-1", dir, dir, noEmit, noEmitFor,
				func(string) {}, true, nil, complete, permit, func(error) {})
		}
		ran = func() int {
			n := 0
			for _, line := range fake.readLines("stdin.jsonl") {
				if strings.Contains(line, `"type":"user"`) && strings.Contains(line, "do the thing") {
					n++
				}
			}
			return n
		}
	case providerCodex:
		fake := newFakeCodexBinary(t, map[string]interface{}{}, map[string]interface{}{})
		fake.useAsRunnerDefault(t)
		fake.answerSessionsWith(t)
		fake.answerTurnsWith(t, codexCompletedAttempt("done"))
		job := &ClaimedSession{SessionID: lostAnswerSessionID, Provider: providerCodex, Agent: AgentExecConfig{Provider: providerCodex}}
		run = func() {
			runCodexAppServerSessionProcess(context.Background(), context.Background(), r.t, job, "gen-1", dir, t.TempDir(), noEmit,
				noEmitFor, func(string) {}, false, nil, nil, complete, permit, func(error) {})
		}
		ran = func() int {
			n := 0
			for _, line := range fake.lines(t, "requests.jsonl") {
				if strings.Contains(line, `"turn/start"`) && strings.Contains(line, "do the thing") {
					n++
				}
			}
			return n
		}
	case providerKimi:
		fake := newFakeKimiEngine(t, map[string]interface{}{"sessionUpdate": "agent_message_chunk",
			"content": map[string]interface{}{"type": "text", "text": "done"}})
		t.Setenv("PATH", fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))
		home, err := os.MkdirTemp("", "ors") // short: sockets live under it
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.RemoveAll(home) })
		t.Setenv("ORBIT_HOME", home)
		job := &ClaimedSession{SessionID: lostAnswerSessionID, SessionUUID: "11111111-2222-3333-4444-555555555557",
			Provider: providerKimi, Agent: AgentExecConfig{Provider: providerKimi, Env: map[string]string{
				"KIMI_CODE_HOME": filepath.Join(t.TempDir(), ".kimi-code"), "KIMI_MODEL_NAME": "test-model", "KIMI_MODEL_API_KEY": "test-key",
			}}}
		// The fake records no prompts: each time the loop takes the message on it says so in a user event.
		var taken atomic.Int32
		emit := func(kind string, payload map[string]interface{}) {
			if kind == evUser && payload["text"] == "do the thing" {
				taken.Add(1)
			}
		}
		run = func() {
			runKimiSessionProcess(context.Background(), context.Background(), r.t, job, "gen-1", dir, t.TempDir(), emit, noEmitFor,
				func(string) {}, false, nil, complete, permit, func(error) {})
		}
		ran = func() int { return int(taken.Load()) }
	case providerOpenCode:
		count := filepath.Join(dir, "invocations")
		writeFakeBin(t, dir, providerOpenCode, `printf x >> "$COUNT_PATH"
printf '%s\n' '{"type":"text","part":{"text":"done"}}'
printf '%s\n' '{"type":"step_finish","part":{"cost":0,"tokens":{"total":2,"input":1,"output":1}}}'`)
		t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
		job := &ClaimedSession{SessionID: lostAnswerSessionID, Agent: AgentExecConfig{Env: map[string]string{"COUNT_PATH": count}}}
		run = func() {
			runOpenCodeSessionProcess(context.Background(), context.Background(), r.t, job, "gen-1", dir, dir, noEmit, noEmitFor,
				func(string) {}, false, nil, complete, permit, func(error) {})
		}
		ran = func() int {
			b, _ := os.ReadFile(count)
			return len(b)
		}
	default:
		t.Fatalf("no lost-answer session for %s", engine)
	}
	return run, ran, completed
}

// onceKinds are the kinds of turn the poller hands to the session loop once: every kind but message and shell.
var onceKinds = []string{"interrupt", "end", "diff", "setconfig", "reload", "withdraw", "steer"}

// The answer that handed out a turn of any other kind is made good the same way (task B2b): the connection drops with
// the answer, the call goes again on the next connection under its request id, the control plane answers it with that
// same turn, and the session loop is handed it once, within 5 s. A fetch of its own, under a new request id, would have
// been handed what is queued behind it, and the turn would be gone: answered as it was handed out, or, a steer, never
// leased again.
func TestALostControlTurnOrSteerAnswerIsHandedBackOnceWithinFiveSeconds(t *testing.T) {
	for _, kind := range onceKinds {
		t.Run(kind, func(t *testing.T) {
			r := newLinkWorkRig(t)
			in := newFakeLinkInbox()
			var lostAt atomic.Int64
			in.lose = func(f fakeLinkFetch) bool {
				return f.handed == "c-1" && lostAt.CompareAndSwap(0, time.Now().UnixNano())
			}
			r.g.backend = in.serve
			r.useLink(t)
			in.queue("session-a", RunInboxResponse{TurnID: "c-1", Kind: kind, Content: "{}"},
				RunInboxResponse{TurnID: "m-1", Kind: "message", Content: "queued behind it"})
			p := newInboxPoller(r.t, "session-a", "gen-1")
			defer p.close()
			turns := pollInBackground(t, p)

			if got := recvTurn(t, turns, 10*time.Second, "c-1"); got.Kind != kind {
				t.Fatalf("c-1 was handed over as %q, want %q", got.Kind, kind)
			}
			handedBack := time.Now()
			recvTurn(t, turns, 5*time.Second, "m-1")
			if lostAt.Load() == 0 {
				t.Fatal("no answer was lost")
			}
			if took := handedBack.Sub(time.Unix(0, lostAt.Load())); took > 5*time.Second {
				t.Errorf("c-1 was handed over %s after its answer was lost", took)
			}
			fetches := in.fetchedFor("session-a")
			if len(fetches) < 3 || fetches[0].handed != "c-1" || fetches[1].handed != "c-1" || fetches[2].handed != "m-1" {
				t.Fatalf("fetches %+v: want c-1 handed out and lost, handed out again, then m-1", fetches)
			}
			if fetches[1].requestID != fetches[0].requestID {
				t.Errorf("the fetch after the loss is %s, not the lost call %s sent again", fetches[1].requestID, fetches[0].requestID)
			}
			if fetches[2].requestID == fetches[0].requestID {
				t.Errorf("the fetch after c-1 went under the lost call's request id %s", fetches[2].requestID)
			}
			select {
			case extra := <-turns:
				t.Fatalf("handed over %s (%s) as well", extra.TurnID, extra.Kind)
			case <-time.After(300 * time.Millisecond):
			}
		})
	}
}

// A turn of any kind but message and shell is handed to the session loop once, in either mode. The control plane answers
// a control turn as it hands it out and never leases a steer again, and over the link hands either out again only to a
// fetch sent again under the request id that handed it out, whose answer never arrived. A second copy that arrives all
// the same is dropped: it would interrupt, end, reconfigure or steer the engine a second time. A steer the engine could
// not take is put back in the queue as a message under its own id, and that is handed over.
func TestAControlTurnOrSteerIsHandedToTheSessionLoopOnce(t *testing.T) {
	check := func(t *testing.T, turns <-chan *RunInboxResponse, handedOut func(string) int) {
		t.Helper()
		for _, kind := range onceKinds {
			if got := recvTurn(t, turns, 5*time.Second, "c-"+kind); got.Kind != kind {
				t.Fatalf("c-%s was handed over as %q", kind, got.Kind)
			}
		}
		if got := recvTurn(t, turns, 5*time.Second, "c-steer"); got.Kind != "message" {
			t.Fatalf("the steer put back in the queue was handed over as %q, want a message", got.Kind)
		}
		select {
		case extra := <-turns:
			t.Fatalf("handed over %s (%s) again", extra.TurnID, extra.Kind)
		case <-time.After(300 * time.Millisecond):
		}
		for _, kind := range onceKinds {
			want := 2
			if kind == "steer" {
				want = 3 // and once more as the message it became
			}
			if n := handedOut("c-" + kind); n != want {
				t.Errorf("c-%s was handed out %d times, want %d", kind, n, want)
			}
		}
	}
	// Each turn of those kinds twice, then the steer as the message it is put back in the queue as.
	queue := func(add func(...RunInboxResponse)) {
		for _, kind := range onceKinds {
			c := RunInboxResponse{TurnID: "c-" + kind, Kind: kind, Content: "{}"}
			add(c, c)
		}
		add(RunInboxResponse{TurnID: "c-steer", Kind: "message", Content: "the steer, put back in the queue"})
	}

	t.Run("over the link", func(t *testing.T) {
		r := newLinkWorkRig(t)
		in := newFakeLinkInbox()
		queue(func(turns ...RunInboxResponse) { in.queue("session-a", turns...) })
		r.g.backend = in.serve
		r.useLink(t)
		p := newInboxPoller(r.t, "session-a", "gen-1")
		defer p.close()
		check(t, pollInBackground(t, p), in.handedOut)
	})
	t.Run("over HTTPS", func(t *testing.T) {
		var mu sync.Mutex
		var queued []RunInboxResponse
		handed := map[string]int{}
		queue(func(turns ...RunInboxResponse) { queued = append(queued, turns...) })
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			mu.Lock()
			if len(queued) > 0 {
				next := queued[0]
				queued = queued[1:]
				handed[next.TurnID]++
				mu.Unlock()
				_ = json.NewEncoder(w).Encode(next)
				return
			}
			mu.Unlock()
			time.Sleep(20 * time.Millisecond) // the long poll, shortened
			_, _ = w.Write([]byte(`{"turnId":"","seq":0,"kind":"message"}`))
		}))
		defer srv.Close()
		p := newInboxPoller(NewTransport(srv.URL, "runner-token"), "session-a", "gen-1")
		defer p.close()
		check(t, pollInBackground(t, p), func(turnID string) int {
			mu.Lock()
			defer mu.Unlock()
			return handed[turnID]
		})
	})
}

// What the session loop does with a turn it is handed takes effect once when the turn arrives twice: the engine is
// interrupted once, reconfigured once, has one steer written into its turn and is asked once to withdraw it, and the
// worktree's diff is sent once.
func TestTheClaudeLoopActsOnceOnAControlTurnOrSteerHandedOverTwice(t *testing.T) {
	twice := func(s scriptedTurn) []scriptedTurn { return []scriptedTurn{s, s} }
	settledAs := func(run *deliverySession, turnID string) int {
		run.mu.Lock()
		defer run.mu.Unlock()
		n := 0
		for _, s := range run.settled {
			if s.TurnID == turnID {
				n++
			}
		}
		return n
	}
	// The follow-up the inbox hands out once the copies have gone: by the time it runs, the loop has taken both.
	followUp := afterTurn(messageTurn("turn-2", "and now the next thing"), "turn-1")

	t.Run("interrupt", func(t *testing.T) {
		run := runDeliverySession(t,
			[]fakeStep{
				{Await: "user"}, {Emit: "replay_user"},
				{Emit: "assistant", Text: "starting the long thing"},
				{Await: "control_request", Subtype: ctrlInterrupt},
				{Emit: "control_response"},
				{Emit: "result", Subtype: "error_during_execution", Text: "interrupted"},
				{Await: "user"}, {Emit: "replay_user"},
				{Emit: "result", Text: "done"},
				{Emit: "eof"},
			},
			append(append([]scriptedTurn{messageTurn("turn-1", "start something long")}, twice(interruptTurn("int-1"))...), followUp),
			nil)
		if reqs := interruptRequests(run.fake); len(reqs) != 1 {
			t.Fatalf("the CLI received %d interrupt control_request(s), want 1", len(reqs))
		}
		if markers := run.interruptMarkers(); len(markers) != 1 {
			t.Errorf("the transcript shows %d interrupt marker(s), want 1", len(markers))
		}
		if msgs := run.errorMessages(); len(msgs) != 0 {
			t.Errorf("the run reported failures: %v", msgs)
		}
		if got := run.turnResult("turn-2"); got == nil || got.Status != stSucceeded {
			t.Errorf("the follow-up settled as %+v", got)
		}
	})
	t.Run("setconfig", func(t *testing.T) {
		run := runDeliverySession(t,
			[]fakeStep{
				{Await: "user"}, {Emit: "replay_user"},
				{Await: "control_request", Subtype: ctrlSetPermissionMode},
				{Emit: "control_response"},
				{Emit: "result", Text: "done"},
				{Await: "user"}, {Emit: "replay_user"},
				{Emit: "result", Text: "done again"},
				{Emit: "eof"},
			},
			append(append([]scriptedTurn{messageTurn("turn-1", "start something long")},
				twice(setConfigTurn("cfg-1", "claude-opus-5", "plan"))...), followUp),
			nil)
		if asked := controlRequests(run, ctrlSetPermissionMode); len(asked) != 1 {
			t.Fatalf("the CLI was asked %d time(s) to set the permission mode, want 1", len(asked))
		}
		if n := settledAs(run, "cfg-1"); n != 1 {
			t.Errorf("the setconfig turn was settled %d times, want 1", n)
		}
		if run.reload {
			t.Error("the run asked to be spawned again")
		}
		if got := run.turnResult("turn-2"); got == nil || got.Status != stSucceeded {
			t.Errorf("the follow-up settled as %+v", got)
		}
	})
	t.Run("steer and withdraw", func(t *testing.T) {
		run := runDeliverySession(t,
			[]fakeStep{
				{Emit: "system_init", Version: "2.1.300"},
				{Await: "user"}, // the message that opens the turn
				{Emit: "replay_user"},
				{Emit: "tool_use", ToolUseID: "toolu_1", ToolName: "Bash", Input: map[string]interface{}{"command": "sleep 20"}},
				{Await: "user"}, // the steer, queued while the tool runs
				{Await: "control_request", Subtype: ctrlCancelAsyncMessage},
				{Emit: "control_response", Response: map[string]interface{}{"cancelled": true}},
				{Emit: "tool_result", ToolUseID: "toolu_1", Text: "done"},
				{Emit: "result", Text: "built"},
				{Await: "user"}, {Emit: "replay_user"},
				{Emit: "result", Text: "done"},
				{Emit: "eof"},
			},
			append(append(append([]scriptedTurn{messageTurn("turn-1", "build it")},
				twice(steerAfterRead("steer-1", "then push it to main", "turn-1"))...),
				twice(withdrawTurn("withdraw-1", "steer-1", "then push it to main"))...), followUp),
			nil)
		steers := 0
		for _, frame := range run.fake.Stdin() {
			if frame["type"] == "user" && userFrameText(t, frame) == "then push it to main" {
				steers++
			}
		}
		if steers != 1 {
			t.Fatalf("the steer was written into the turn %d times, want 1", steers)
		}
		if asked := controlRequests(run, ctrlCancelAsyncMessage); len(asked) != 1 {
			t.Fatalf("the CLI was asked %d time(s) to drop the steer, want 1", len(asked))
		}
		if n := settledAs(run, "withdraw-1"); n != 1 {
			t.Errorf("the withdraw turn was settled %d times, want 1", n)
		}
		if w := run.turnResult("withdraw-1"); w == nil || w.Result != withdrawWithdrawn {
			t.Errorf("the withdraw turn settled as %+v, want %s", w, withdrawWithdrawn)
		}
		if got := run.turnResult("turn-2"); got == nil || got.Status != stSucceeded {
			t.Errorf("the follow-up settled as %+v", got)
		}
	})
	t.Run("diff", func(t *testing.T) {
		var mu sync.Mutex
		diffs := 0
		run := runDeliverySessionWith(t,
			[]fakeStep{
				{Await: "user"}, {Emit: "replay_user"},
				{Emit: "result", Text: "done"},
				{Await: "user"}, {Emit: "replay_user"},
				{Emit: "result", Text: "done again"},
				{Emit: "eof"},
			},
			append(append([]scriptedTurn{messageTurn("turn-1", "change something")},
				twice(scriptedTurn{turn: RunInboxResponse{TurnID: "diff-1", Kind: "diff"}, ungated: true})...), followUp),
			nil,
			deliveryOptions{onRequest: func(path string, _ []byte) {
				if strings.HasSuffix(path, "/diff") {
					mu.Lock()
					diffs++
					mu.Unlock()
				}
			}})
		mu.Lock()
		defer mu.Unlock()
		if diffs != 1 {
			t.Fatalf("the worktree's diff was sent %d times, want 1", diffs)
		}
		if got := run.turnResult("turn-2"); got == nil || got.Status != stSucceeded {
			t.Errorf("the follow-up settled as %+v", got)
		}
	})
}

// A new connection does not have every inbox asked again (§10): the Welcome is followed at once by the connection's
// first heartbeat, and the HintState of its HeartbeatAck names the sessions with a turn waiting, whose pollers ask
// then. A turn queued while there was no connection, whose hint was lost with it, is fetched that way, and a session
// with nothing waiting asks nothing.
func TestAReconnectFetchesWhatTheFirstHeartbeatAckNames(t *testing.T) {
	r := newLinkWorkRig(t)
	in := newFakeLinkInbox()
	r.g.backend = in.serve
	first := r.useLink(t)
	ctx := context.Background()
	pa := newInboxPoller(r.t, "session-a", "gen-a")
	defer pa.close()
	pb := newInboxPoller(r.t, "session-b", "gen-b")
	defer pb.close()
	turnsA := pollInBackground(t, pa)
	pollInBackground(t, pb)
	linkWaitFor(t, 5*time.Second, "each poller's first fetch", func() bool {
		return len(in.fetchedFor("session-a")) == 1 && len(in.fetchedFor("session-b")) == 1
	})
	if woke, err := r.t.waitForWake(ctx); err != nil || !woke {
		t.Fatalf("the first connection's heartbeat was not owed: %v %v", woke, err)
	}

	first.drop()
	in.queue("session-a", RunInboxResponse{TurnID: "a-1", Kind: "message", Content: "while it was down"})
	second := r.g.waitWelcomed(t, 2)
	linkWaitFor(t, 5*time.Second, "the new connection to be adopted", func() bool {
		cur := r.m.work.current()
		return cur != nil && cur.id == second.id
	})
	time.Sleep(400 * time.Millisecond)
	if a, b := len(in.fetchedFor("session-a")), len(in.fetchedFor("session-b")); a != 1 || b != 1 {
		t.Fatalf("the new connection had the inboxes asked again: %d and %d fetches", a, b)
	}

	// The connection's first heartbeat is owed at once, and its HeartbeatAck says what waits.
	wakeCtx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	if woke, err := r.t.waitForWake(wakeCtx); err != nil || !woke {
		t.Fatalf("the new connection's first heartbeat is not owed at once: %v %v", woke, err)
	}
	r.g.mu.Lock()
	r.g.ackHints = &linkpb.HintState{InboxSessionIds: []string{"session-a"}}
	r.g.mu.Unlock()
	if _, err := r.t.heartbeat(HeartbeatRequest{Status: "ONLINE", LeaseOwner: r.t.leaseOwner, SupervisedSessionIDs: []string{"session-a", "session-b"}}); err != nil {
		t.Fatal(err)
	}
	recvTurn(t, turnsA, 5*time.Second, "a-1")
	linkWaitFor(t, 5*time.Second, "session-a's fetch after a-1", func() bool { return len(in.fetchedFor("session-a")) == 3 })
	time.Sleep(300 * time.Millisecond)
	if b := len(in.fetchedFor("session-b")); b != 1 {
		t.Errorf("session-b, named by nothing, fetched %d times", b)
	}
}

// runningTurnId names a message or shell turn from the answer that handed it over until the control plane takes its
// turn completion, or until the engine generation it was handed to ends: a generation that ends with its turn still
// leased must not have the next one's fetches name it, or a turn handed to the next one whose answer is lost would wait
// out its lease. A Hello says the same.
func TestRunningTurnIDLivesFromTheHandoverToTheCompletionOrTheGenerationsEnd(t *testing.T) {
	r := newLinkWorkRig(t)
	in := newFakeLinkInbox()
	r.g.backend = in.serve
	conn := r.useLink(t)
	ctx := context.Background()
	in.queue("session-a", RunInboxResponse{TurnID: "m-1", Kind: "message", Content: "one"})
	first := newInboxPoller(r.t, "session-a", "gen-1")
	turns := pollInBackground(t, first)

	recvTurn(t, turns, 5*time.Second, "m-1")
	linkWaitFor(t, 5*time.Second, "the fetch after m-1", func() bool { return len(in.fetched()) == 2 })
	if f := in.fetched()[1]; f.running != "m-1" {
		t.Errorf("the fetch while m-1 runs says runningTurnId %q", f.running)
	}
	if _, err := r.t.turnComplete(ctx, "session-a", TurnCompleteRequest{TurnID: "m-1", Status: stSucceeded}); err != nil {
		t.Fatal(err)
	}
	if got := r.m.runningTurn("session-a"); got != "" {
		t.Errorf("after m-1's completion the running turn is %q", got)
	}
	in.queue("session-a", RunInboxResponse{TurnID: "m-2", Kind: "message", Content: "two"})
	sendInboxHint(conn, "session-a")
	recvTurn(t, turns, 5*time.Second, "m-2")
	linkWaitFor(t, 5*time.Second, "the fetch after m-2", func() bool { return len(in.fetched()) == 4 })
	if f := in.fetched(); f[2].running != "" || f[3].running != "m-2" {
		t.Errorf("fetches say runningTurnId %q, then %q: want \"\" (m-1 completed), then m-2", f[2].running, f[3].running)
	}

	// The generation ends with m-2 still leased.
	first.close()
	if got := r.m.runningTurn("session-a"); got != "" {
		t.Errorf("after its generation ended the running turn is %q", got)
	}
	second := newInboxPoller(r.t, "session-a", "gen-2")
	defer second.close()
	pollInBackground(t, second)
	linkWaitFor(t, 5*time.Second, "the next generation's first fetch", func() bool { return len(in.fetched()) == 5 })
	if f := in.fetched()[4]; f.generation != "gen-2" || !f.stated || f.running != "" {
		t.Errorf("the next generation's first fetch %+v: want gen-2 naming no running turn", f)
	}
	conn.drop()
	hello := r.g.waitWelcomed(t, 2).hello
	for _, s := range hello.GetSessions() {
		if s.GetSessionId() == "session-a" && s.GetTurnId() != "" {
			t.Errorf("the Hello after the generation ended resumes session-a running %s", s.GetTurnId())
		}
	}
}

// A poller whose engine generation has ended fetches nothing, in either mode: a control turn handed to it would have
// no receiver (retirePendingGeneration in session.go). Closed, it is asked nothing by any hint and hands over no turn a
// fetch still out brings back; over HTTPS, a poll whose context ended is not followed by another.
func TestAnEndedInboxPollerFetchesNothing(t *testing.T) {
	t.Run("link", func(t *testing.T) {
		r := newLinkWorkRig(t)
		in := newFakeLinkInbox()
		r.g.backend = in.serve
		conn := r.useLink(t)
		p := newInboxPoller(r.t, "session-a", "gen-1")
		result := make(chan error, 1)
		go func() {
			_, err := p.next(context.Background())
			result <- err
		}()
		linkWaitFor(t, 5*time.Second, "the first fetch", func() bool { return len(in.fetched()) == 1 })
		p.close()
		select {
		case err := <-result:
			if !errors.Is(err, errInboxPollerClosed) {
				t.Fatalf("a poller closed while it waited answered %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("a poller closed while it waited went on waiting")
		}
		in.queue("session-a", RunInboxResponse{TurnID: "c-1", Kind: "interrupt"})
		sendInboxHint(conn, "session-a")
		if _, err := p.next(context.Background()); !errors.Is(err, errInboxPollerClosed) {
			t.Fatalf("a closed poller answered %v", err)
		}
		time.Sleep(300 * time.Millisecond)
		if n := len(in.fetched()); n != 1 {
			t.Fatalf("a closed poller fetched %d times", n)
		}

		// A fetch still out when the generation ends brings back a turn nobody is handed.
		held := newInboxPoller(r.t, "session-b", "gen-2")
		hold := make(chan struct{})
		in.mu.Lock()
		in.hold = hold
		in.mu.Unlock()
		in.queue("session-b", RunInboxResponse{TurnID: "m-1", Kind: "message", Content: "late"})
		go func() {
			_, err := held.next(context.Background())
			result <- err
		}()
		time.Sleep(200 * time.Millisecond)
		held.close()
		close(hold)
		select {
		case err := <-result:
			if !errors.Is(err, errInboxPollerClosed) {
				t.Fatalf("the fetch out at the end answered %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("the fetch out at the end never came back")
		}
		if got := r.m.runningTurn("session-b"); got != "" {
			t.Errorf("a turn handed to an ended generation counts as running: %q", got)
		}
	})
	t.Run("https", func(t *testing.T) {
		var requests atomic.Int32
		answered := make(chan struct{})
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			requests.Add(1)
			<-r.Context().Done() // a long poll the runner gives up on
			close(answered)
		}))
		defer srv.Close()
		p := newInboxPoller(NewTransport(srv.URL, "token"), "s1", "gen-1")
		defer p.close()
		ctx, cancel := context.WithCancel(context.Background())
		result := make(chan error, 1)
		go func() {
			_, err := p.next(ctx)
			result <- err
		}()
		linkWaitFor(t, 5*time.Second, "the long poll", func() bool { return requests.Load() == 1 })
		cancel()
		if err := <-result; !errors.Is(err, context.Canceled) {
			t.Fatalf("a cancelled poll answered %v", err)
		}
		<-answered
		time.Sleep(1500 * time.Millisecond) // longer than the retry after a failure
		if n := requests.Load(); n != 1 {
			t.Fatalf("%d polls after the context ended", n-1)
		}
	})
}

// Over HTTPS the poller is the long poll it always was: one request the server holds for its 25 s window, answered
// empty, then the next at once; no runningTurnId. Run beside the suite's other parallel tests: it takes the whole
// window.
func TestInboxPollerOverHTTPSIsTheLongPollItWas(t *testing.T) {
	t.Parallel()
	type request struct {
		at, answered time.Time
		query        url.Values
		path         string
	}
	var mu sync.Mutex
	var requests []*request
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		req := &request{at: time.Now(), query: r.URL.Query(), path: r.URL.Path}
		mu.Lock()
		requests = append(requests, req)
		n := len(requests)
		mu.Unlock()
		if n == 1 {
			time.Sleep(25 * time.Second) // INBOX_LONG_POLL_MS: the server holds the poll, and nothing came
			_, _ = w.Write([]byte(`{"turnId":"","seq":0,"kind":"message"}`))
		} else {
			_, _ = w.Write([]byte(`{"turnId":"m-1","seq":1,"kind":"message","content":"hi"}`))
		}
		mu.Lock()
		req.answered = time.Now()
		mu.Unlock()
	}))
	defer srv.Close()
	p := newInboxPoller(NewTransport(srv.URL, "token"), "s1", "gen-1")
	defer p.close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	turn, err := p.next(ctx)
	if err != nil || turn.TurnID != "m-1" {
		t.Fatalf("next: %+v %v", turn, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(requests) != 2 {
		t.Fatalf("%d requests, want 2", len(requests))
	}
	if held := requests[0].answered.Sub(requests[0].at); held < 25*time.Second {
		t.Errorf("the long poll was held %s", held)
	}
	if gap := requests[1].at.Sub(requests[0].answered); gap > 250*time.Millisecond {
		t.Errorf("the next poll went %s after an empty one", gap)
	}
	for i, r := range requests {
		if r.path != "/api/runner/sessions/s1/inbox" || r.query.Get("acceptsSteer") != "1" || r.query.Get("leaseGeneration") != "gen-1" || r.query.Has("runningTurnId") {
			t.Errorf("request %d: %s?%s", i, r.path, r.query.Encode())
		}
	}
}

// Over HTTPS a failed poll is followed by the next a second later, every time, whatever the answer asked, as it always
// was; a refusal for the lease ends the poller. A link mode the control plane has not asked for changes none of it.
func TestInboxPollerOverHTTPSFetchesAgainOneSecondAfterAFailure(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	var mu sync.Mutex
	var at []time.Time
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		at = append(at, time.Now())
		n := len(at)
		mu.Unlock()
		switch {
		case n <= 2:
			w.WriteHeader(http.StatusBadGateway)
		case n == 3:
			w.Header().Set("Retry-After", "5")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"code":"DATABASE_UNAVAILABLE","retryable":true,"retryAfterMs":5000}`))
		case n == 4:
			_, _ = w.Write([]byte(`{"turnId":"m-1","seq":1,"kind":"message"}`))
		default:
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"code":"LEASE_GENERATION_SUPERSEDED"}`))
		}
	}))
	defer srv.Close()
	tr := NewTransport(srv.URL, "token")
	tr.link = newLinkMode(tr, (&linkTestLog{}).log)
	t.Cleanup(tr.link.close)
	p := newInboxPoller(tr, "s1", "gen-1")
	defer p.close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if turn, err := p.next(ctx); err != nil || turn.TurnID != "m-1" {
		t.Fatalf("next: %+v %v", turn, err)
	}
	if _, err := p.next(ctx); !isLeaseOwnershipError(err) {
		t.Fatalf("after a 409: %v", err)
	}
	time.Sleep(1500 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if len(at) != 5 {
		t.Fatalf("%d polls, want 5 (three failed, one turn, one refused for the lease)", len(at))
	}
	for i := 1; i < 4; i++ {
		if gap := at[i].Sub(at[i-1]); gap < 950*time.Millisecond || gap > 1600*time.Millisecond {
			t.Errorf("poll %d went %s after a failed one, want 1 s", i+1, gap)
		}
	}
	if gap := at[4].Sub(at[3]); gap > 250*time.Millisecond {
		t.Errorf("the poll after a turn went %s later", gap)
	}
}

// The link's backoff after a failed fetch: its ceiling doubles from 1 s to 30 s, the wait is anywhere under it (full
// jitter), and never shorter than the failed answer asked.
func TestInboxLinkBackoffIsExponentialWithFullJitterAndHonoursRetryAfter(t *testing.T) {
	failure := errors.New("the runner link is not connected")
	for i, ceiling := range []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second,
		16 * time.Second, 30 * time.Second, 30 * time.Second, 30 * time.Second} {
		lo, hi := ceiling, time.Duration(0)
		for n := 0; n < 400; n++ {
			w := inboxLinkBackoff(i+1, failure)
			if w <= 0 || w > ceiling+time.Millisecond {
				t.Fatalf("failure %d waited %s, past its ceiling %s", i+1, w, ceiling)
			}
			lo, hi = min(lo, w), max(hi, w)
		}
		if lo > ceiling/4 || hi < ceiling*3/4 {
			t.Errorf("failure %d: 400 waits within [%s, %s] of [0, %s): not jittered over the whole range", i+1, lo, hi, ceiling)
		}
	}
	refusal := &transportHTTPError{method: "GET", path: "/runner/sessions/s/inbox", statusCode: http.StatusServiceUnavailable,
		body: `{"code":"DATABASE_UNAVAILABLE","retryable":true,"retryAfterMs":2500}`, retryAfter: "3"}
	headerOnly := &transportHTTPError{method: "GET", path: "/runner/sessions/s/inbox", statusCode: http.StatusTooManyRequests, retryAfter: "4"}
	for n := 0; n < 50; n++ {
		if w := inboxLinkBackoff(1, refusal); w != 2500*time.Millisecond {
			t.Fatalf("a refusal asking for 2.5 s waited %s", w)
		}
		if w := inboxLinkBackoff(1, headerOnly); w != 4*time.Second {
			t.Fatalf("a Retry-After of 4 waited %s", w)
		}
		if w := inboxLinkBackoff(6, refusal); w < 2500*time.Millisecond || w > 30*time.Second+time.Millisecond {
			t.Fatalf("the sixth failure with a refusal asking for 2.5 s waited %s", w)
		}
	}
}

// Every session loop takes its turns through an inbox poller, and nothing else fetches an inbox: the eight loops build
// one each, and only the poller calls Transport.inbox.
func TestEveryInboxIsFetchedThroughTheInboxPoller(t *testing.T) {
	loops := map[string]int{"session.go": 0, "codex.go": 0, "codex_appserver.go": 0, "kimi_acp.go": 0, "opencode.go": 0,
		"antigravity.go": 0, "cursor_acp.go": 0, "dsh_acp.go": 0}
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		file, err := os.Open(f)
		if err != nil {
			t.Fatal(err)
		}
		scanner := bufio.NewScanner(file)
		scanner.Buffer(make([]byte, 1<<20), 1<<20)
		for n := 1; scanner.Scan(); n++ {
			line := strings.TrimSpace(scanner.Text())
			if strings.HasPrefix(line, "//") {
				continue
			}
			if strings.Contains(line, ".inbox(") && f != "inbox_poller.go" {
				t.Errorf("%s:%d fetches an inbox outside the inbox poller: %s", f, n, line)
			}
			if strings.Contains(line, "newInboxPoller(") && !strings.HasPrefix(line, "func newInboxPoller(") {
				if _, ok := loops[f]; !ok {
					t.Errorf("%s:%d builds an inbox poller and is no session loop this test knows: %s", f, n, line)
				}
				loops[f]++
			}
		}
		file.Close()
	}
	for f, n := range loops {
		if n != 1 {
			t.Errorf("%s builds %d inbox pollers, want 1", f, n)
		}
	}
}
