package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"orbit/linkpb"
)

// A claim or an inbox fetch over the runner link that got no answer at all is followed by one under the same request_id,
// however long the link stays down, until one gets an answer (linkRequestIDs, task B2b): the control plane answers it
// with the session or the turn the lost answer carried. Any answer, a session or a turn, nothing, a refusal, moves the
// next one to a new id.

// linkOutageForTest is how long a test keeps the link down after an answer is lost: past the claim and inbox calls'
// deadline (longPollCallTimeout), so that the call whose answer was lost has given up before the link is back. 3 s
// past a deadline shortened to 1 s; with ORBIT_TEST_LINK_OUTAGE set, say to 2m, that long past the real 35 s one.
func linkOutageForTest(t *testing.T) time.Duration {
	t.Helper()
	if v := os.Getenv("ORBIT_TEST_LINK_OUTAGE"); v != "" {
		outage, err := time.ParseDuration(v)
		if err != nil || outage <= longPollCallTimeout {
			t.Fatalf("ORBIT_TEST_LINK_OUTAGE=%s: want a duration longer than the calls' deadline, %s", v, longPollCallTimeout)
		}
		return outage
	}
	old := longPollCallTimeout
	longPollCallTimeout = time.Second
	t.Cleanup(func() { longPollCallTimeout = old })
	return 3 * time.Second
}

// linkDownUntil has g refuse the runner's connections until until.
func linkDownUntil(g *fakeWorkGateway, until time.Time) {
	g.mu.Lock()
	g.refuse = func(*http.Request) (int, string, string) {
		if time.Now().Before(until) {
			return http.StatusServiceUnavailable, "the link is down", ""
		}
		return 0, "", ""
	}
	g.mu.Unlock()
}

// The rule, call by call: an id is kept only by a call that went over the link and got no answer.
func TestLinkRequestIDsKeepAnIDOnlyForALinkCallThatGotNoAnswer(t *testing.T) {
	m := &linkMode{t: &Transport{leaseOwner: "11111111-2222-4333-8444-555555555555"}}
	var ids linkRequestIDs
	call := func(err error) string {
		ctx := ids.with(context.Background())
		id := m.requestIDFor(ctx)
		ids.settle(err)
		return id
	}

	// Over HTTPS (no link call made) nothing is kept, answered or not.
	ids.with(context.Background())
	ids.settle(errors.New("connection reset by peer"))
	if ids.kept() {
		t.Fatal("a fetch over HTTPS kept a request id")
	}

	first := call(context.DeadlineExceeded)
	if !ids.kept() {
		t.Fatal("a link call whose deadline passed with no answer kept no request id")
	}
	if again := call(errLinkNotConnected); again != first {
		t.Fatalf("the call after one that got no answer went under %s, want %s", again, first)
	}
	if again := call(&transportHTTPError{statusCode: http.StatusServiceUnavailable, body: `{"code":"DATABASE_UNAVAILABLE"}`}); again != first {
		t.Fatalf("the call after two that got no answer went under %s, want %s", again, first)
	}
	if ids.kept() {
		t.Fatal("a refusal was taken for no answer: the next call would repeat a question that was answered")
	}
	next := call(nil)
	if next == first {
		t.Fatalf("the call after an answered one went under the same id %s", next)
	}
	if ids.kept() {
		t.Fatal("an answered call kept its request id")
	}
	if fresh, other := m.requestIDFor(context.Background()), m.requestIDFor(context.Background()); fresh == other {
		t.Fatal("two calls with no linkRequestIDs went under one id")
	}
}

// An inbox fetch that got an answer, whatever it was, is followed by one under a new request id: a turn, nothing, the
// control plane's refusal, the gateway's. One that got none, its call's deadline passing first, is followed by one
// under the same id, and so is that one when it gets none either. Over HTTPS the fetch carries no request id at all.
func TestAnInboxFetchKeepsItsRequestIDUntilItIsAnswered(t *testing.T) {
	t.Run("over the link", func(t *testing.T) {
		linkOutageForTest(t) // only for its shortened deadline
		r := newLinkWorkRig(t)
		answers := []string{"nothing", "turn", "refused", "no answer", "no answer", "nothing", "gateway refuses", "nothing"}
		var mu sync.Mutex
		var ids []string
		r.g.backend = func(c *fakeWorkConn, rpc *linkpb.Rpc) *linkpb.RpcResult {
			if !strings.Contains(rpc.GetTunnel().GetPath(), "/inbox") {
				return fakeWorkAnswer(rpc, 200, `{}`)
			}
			mu.Lock()
			n := len(ids)
			ids = append(ids, rpc.GetRequestId())
			mu.Unlock()
			answer := "nothing"
			if n < len(answers) {
				answer = answers[n]
			}
			switch answer {
			case "turn":
				return fakeWorkAnswer(rpc, 200, `{"turnId":"m-1","seq":1,"kind":"message","content":"hi"}`)
			case "refused":
				return fakeWorkAnswer(rpc, http.StatusServiceUnavailable, `{"code":"DATABASE_UNAVAILABLE","retryable":true}`)
			case "no answer":
				return nil
			case "gateway refuses":
				return fakeWorkFailure(rpc, "RPC_BAD_REQUEST", false, 0)
			}
			return fakeWorkAnswer(rpc, 200, `{"turnId":"","seq":0,"kind":"message"}`)
		}
		conn := r.useLink(t)
		p := newInboxPoller(r.t, "session-a", "gen-1")
		defer p.close()
		turns := pollInBackground(t, p)
		for i, answer := range answers {
			linkWaitFor(t, 30*time.Second, fmt.Sprintf("fetch %d", i+1), func() bool {
				mu.Lock()
				defer mu.Unlock()
				return len(ids) > i
			})
			switch answer {
			case "nothing":
				if i < len(answers)-1 {
					sendInboxHint(conn, "session-a") // nothing more is fetched until something says there is
				}
			case "turn":
				recvTurn(t, turns, 5*time.Second, "m-1")
			}
		}
		mu.Lock()
		defer mu.Unlock()
		for i := 1; i < len(answers); i++ {
			if same, want := ids[i] == ids[i-1], answers[i-1] == "no answer"; same != want {
				t.Errorf("fetch %d went under %s after fetch %d, answered %q, went under %s: same id %v, want %v",
					i+1, ids[i], i, answers[i-1], ids[i-1], same, want)
			}
		}
	})
	t.Run("over HTTPS", func(t *testing.T) {
		var mu sync.Mutex
		var headers []string
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			mu.Lock()
			headers = append(headers, req.Header.Get("X-Orbit-Link-Request-Id"))
			first := len(headers) == 1
			mu.Unlock()
			if first { // cut off before any answer
				if conn, _, err := w.(http.Hijacker).Hijack(); err == nil {
					_ = conn.Close()
				}
				return
			}
			time.Sleep(20 * time.Millisecond)
			_, _ = w.Write([]byte(`{"turnId":"","seq":0,"kind":"message"}`))
		}))
		defer srv.Close()
		tr := NewTransport(srv.URL, "runner-token")
		tr.link = newLinkMode(tr, func(...any) {}) // there, and not in use
		t.Cleanup(tr.link.close)
		p := newInboxPoller(tr, "session-a", "gen-1")
		defer p.close()
		pollInBackground(t, p)
		linkWaitFor(t, 10*time.Second, "the fetches after the one cut off", func() bool {
			mu.Lock()
			defer mu.Unlock()
			return len(headers) >= 3
		})
		mu.Lock()
		defer mu.Unlock()
		for i, h := range headers {
			if h != "" {
				t.Errorf("HTTPS fetch %d carried X-Orbit-Link-Request-Id %q", i+1, h)
			}
		}
	})
}

// The answer that handed out a control turn or a steer is lost, and the link stays down past the inbox call's deadline:
// that call gives up, and the poller's fetches while the link is down, and its first once the link is back, go under
// the lost fetch's request id, which the control plane answers with that same turn (dequeueTurn). The session loop is
// handed it once, then what was queued behind it under a new id. A withdraw is answered again only within its delivery
// window, as dequeueTurn answers it: past it, the fetch under that id is served as a new one.
func TestALostControlTurnOrSteerAnswerComesBackAfterTheLinkWasDownLongerThanACall(t *testing.T) {
	for _, kind := range onceKinds {
		t.Run(kind, func(t *testing.T) {
			outage := linkOutageForTest(t)
			r := newLinkWorkRig(t)
			in := newFakeLinkInbox()
			var lostAt atomic.Int64
			in.lose = func(f fakeLinkFetch) bool {
				if f.handed != "c-1" || !lostAt.CompareAndSwap(0, time.Now().UnixNano()) {
					return false
				}
				linkDownUntil(r.g, time.Now().Add(outage))
				return true
			}
			r.g.backend = in.serve
			r.useLink(t)
			in.queue("session-a", RunInboxResponse{TurnID: "c-1", Kind: kind, Content: "{}"},
				RunInboxResponse{TurnID: "m-1", Kind: "message", Content: "queued behind it"})
			p := newInboxPoller(r.t, "session-a", "gen-1")
			defer p.close()
			turns := pollInBackground(t, p)

			// Back once the link is: within the reconnect's backoff (linkBackoffMax) and the poller's (inboxLinkBackoffMax).
			var got *RunInboxResponse
			select {
			case got = <-turns:
			case <-time.After(outage + linkBackoffMax + inboxLinkBackoffMax + 30*time.Second):
				t.Fatal("nothing was handed over after the link came back")
			}
			handedBack := time.Now()
			if got == nil {
				t.Fatal("the poller stopped")
			}
			if lostAt.Load() == 0 {
				t.Fatal("no answer was lost")
			}
			lost := time.Unix(0, lostAt.Load())
			back := r.g.waitWelcomed(t, 2).welcomed
			fetches := in.fetchedFor("session-a")
			if len(fetches) < 2 || fetches[0].handed != "c-1" {
				t.Fatalf("fetches %+v: want c-1 handed out, and its answer lost", fetches)
			}
			// A withdraw sent again past its window is served as a new fetch, which hands out what is queued behind it.
			pastWindow := kind == "withdraw" && fetches[1].at.Sub(fetches[0].at) >= fakeWithdrawWindow
			want := "c-1"
			if pastWindow {
				want = "m-1"
			}
			if got.TurnID != want {
				t.Fatalf("handed %s (%s) first after the link came back, want %s", got.TurnID, got.Kind, want)
			}
			if took := handedBack.Sub(lost); took <= longPollCallTimeout {
				t.Fatalf("%s was handed over %s after its answer was lost, within the call's own %s deadline", want, took, longPollCallTimeout)
			}
			if after := handedBack.Sub(back); after > inboxLinkBackoffMax+5*time.Second {
				t.Errorf("%s was handed over %s after the link was back", want, after)
			}
			t.Logf("%s (%s) handed over %s after its answer was lost and the link went down for %s, %s after the link was back",
				got.TurnID, got.Kind, handedBack.Sub(lost).Round(time.Millisecond), outage, handedBack.Sub(back).Round(time.Millisecond))
			if fetches[1].requestID != fetches[0].requestID {
				t.Errorf("the first fetch after the outage went under %s, not the lost fetch's %s", fetches[1].requestID, fetches[0].requestID)
			}
			if fetches[1].at.Before(back) {
				t.Errorf("a fetch reached the gateway at %s, before the link was back at %s", fetches[1].at, back)
			}
			if fetches[1].handed != want {
				t.Errorf("the fetch under the lost id was handed %q, want %q", fetches[1].handed, want)
			}
			if !pastWindow {
				recvTurn(t, turns, 10*time.Second, "m-1")
				fetches = in.fetchedFor("session-a")
				if len(fetches) < 3 || fetches[2].handed != "m-1" || fetches[2].requestID == fetches[0].requestID {
					t.Errorf("fetches %+v: want m-1 handed out next, under a new id", fetches)
				}
				if n := in.handedOut("c-1"); n != 2 {
					t.Errorf("c-1 was handed out %d times, want 2: the lost answer and the fetch under its id", n)
				}
			} else if n := in.handedOut("c-1"); n != 1 {
				t.Errorf("the withdraw past its window was handed out %d times, want once: the answer that was lost", n)
			}
			select {
			case extra := <-turns:
				t.Fatalf("handed over %s (%s) again", extra.TurnID, extra.Kind)
			case <-time.After(300 * time.Millisecond):
			}
		})
	}
}

// The answer to a claim is lost after the control plane claimed a session, and the link stays down past the claim
// call's deadline: the claims while it is down, and the first once it is back, go under the lost claim's request id,
// which the control plane answers with the session it claimed (QueueService.trySessionClaim). It comes back once. Every
// claim answered after it, with nothing, with the session or with a refusal, moves the next to a new id; one that got
// no answer keeps it, and is asked again with no hint saying anything waits.
func TestALostClaimAnswerComesBackAfterTheLinkWasDownLongerThanACall(t *testing.T) {
	outage := linkOutageForTest(t)
	shortenLinkWaits(t, 200*time.Millisecond, linkApprovalRecheck, linkAfterSeqWait)
	r := newLinkWorkRig(t)
	var mu sync.Mutex
	claimedBy, silentFor := "", ""
	others := 0
	var lostAt time.Time
	r.g.backend = func(c *fakeWorkConn, rpc *linkpb.Rpc) *linkpb.RpcResult {
		if rpc.GetTunnel().GetPath() != "/runner/sessions/claim" {
			return fakeWorkAnswer(rpc, 200, `{}`)
		}
		mu.Lock()
		defer mu.Unlock()
		switch id := rpc.GetRequestId(); {
		case claimedBy == "":
			// session-c claimed under this id, its answer lost with the connection, and the link down.
			claimedBy, lostAt = id, time.Now()
			linkDownUntil(r.g, lostAt.Add(outage))
			c.drop()
			return nil
		case id == claimedBy:
			return fakeWorkAnswer(rpc, 200, `{"sessionId":"session-c","title":"claimed before the link went down"}`)
		case id == silentFor:
			return fakeWorkAnswer(rpc, http.StatusServiceUnavailable, `{"code":"DATABASE_UNAVAILABLE","retryable":true}`)
		default:
			if others++; others == 2 {
				silentFor = id
				return nil // no answer, the connection up: the call's deadline passes
			}
			return fakeWorkAnswer(rpc, 200, `null`)
		}
	}
	r.useLink(t)

	// As the claim loop asks: again after each claim that failed, a moment later (claimRetryWait).
	var claims linkRequestIDs
	ctx := context.Background()
	var job *ClaimedSession
	deadline := time.Now().Add(outage + linkBackoffMax + 30*time.Second)
	for job == nil {
		if time.Now().After(deadline) {
			t.Fatal("the claimed session did not come back")
		}
		var err error
		job, err = r.t.claimSession(ctx, &claims)
		if err != nil {
			if !claims.kept() {
				t.Fatalf("a claim that got no answer kept no request id: %v", err)
			}
			time.Sleep(claimRetryDelayAfter(1))
		}
	}
	back := r.g.waitWelcomed(t, 2).welcomed
	handedBack := time.Now()
	if job.SessionID != "session-c" {
		t.Fatalf("the claim was answered with %q, want session-c", job.SessionID)
	}
	mu.Lock()
	lost := lostAt
	mu.Unlock()
	if took := handedBack.Sub(lost); took <= longPollCallTimeout {
		t.Fatalf("session-c came back %s after its answer was lost, within the call's own %s deadline", took, longPollCallTimeout)
	}
	t.Logf("session-c came back %s after its claim's answer was lost and the link went down for %s, %s after the link was back",
		handedBack.Sub(lost).Round(time.Millisecond), outage, handedBack.Sub(back).Round(time.Millisecond))
	calls := r.g.rpcsTo("/runner/sessions/claim")
	if len(calls) != 2 || calls[0].requestID != calls[1].requestID || calls[1].at.Before(back) {
		t.Fatalf("claims %+v: want the lost one, then the first once the link was back, under its id", calls)
	}
	if claims.kept() {
		t.Fatal("the answered claim kept its request id")
	}

	// After it: answered with nothing (new id), no answer (kept, asked again with no hint), a refusal (new id), nothing.
	ask := func(want string) (string, error) {
		t.Helper()
		before := len(r.g.rpcsTo("/runner/sessions/claim"))
		var err error
		linkWaitFor(t, 10*time.Second, "a claim to be asked "+want, func() bool {
			job, err = r.t.claimSession(ctx, &claims)
			return len(r.g.rpcsTo("/runner/sessions/claim")) > before
		})
		if job != nil {
			t.Fatalf("a claim %s was answered with %s", want, job.SessionID)
		}
		calls := r.g.rpcsTo("/runner/sessions/claim")
		return calls[len(calls)-1].requestID, err
	}
	r.m.gates.markClaim() // a ClaimHint
	afterIt, err := ask("after the session came back")
	if err != nil || afterIt == calls[0].requestID {
		t.Fatalf("the claim after the answered one went under %s (%v), want a new id", afterIt, err)
	}
	r.m.gates.markClaim()
	silent, err := ask("answered by nobody")
	if err == nil || silent == afterIt || !claims.kept() {
		t.Fatalf("the claim no backend answered went under %s (%v; kept %v), want a new id, kept", silent, err, claims.kept())
	}
	again, err := ask("again, with no hint") // nothing marked it: the claim that got no answer did
	if again != silent || err == nil || claims.kept() {
		t.Fatalf("the claim after the unanswered one went under %s (%v; kept %v), want %s, refused, not kept", again, err, claims.kept(), silent)
	}
	r.m.gates.markClaim()
	last, err := ask("after the refusal")
	if err != nil || last == silent {
		t.Fatalf("the claim after the refused one went under %s (%v), want a new id", last, err)
	}
}

// The claim loop does not reconcile while a claim waits for its answer over the link: a reclaim would start the session
// that claim claimed, and the claim's answer would start it again. The reconciliation a claim that got no answer owes
// is the late check's, once the claim has been answered. Read from runLoop's source, as the claim loop's other rules are
// (late_claim_check_test.go, claim_retry_backoff_test.go).
func TestTheClaimLoopHoldsItsReconciliationsWhileAClaimWaitsForItsAnswer(t *testing.T) {
	src, err := os.ReadFile("runloop.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(src)
	body = body[strings.Index(body, "func runLoop("):]
	body = body[:strings.Index(body, "\n}\n")]
	loop := strings.Index(body, "\tfor loopCtx.Err() == nil {")
	if loop < 0 {
		t.Fatal("runLoop's claim loop was not found")
	}
	if !strings.Contains(body[:loop], "var claims linkRequestIDs") {
		t.Error("the claim loop keeps no request id for its claims")
	}
	inLoop := body[loop:]
	for _, want := range []string{
		"if !reclaimRetryAt.IsZero() && time.Now().After(reclaimRetryAt) && !claims.kept() {",
		"if !lateClaimCheckAt.IsZero() && time.Now().After(lateClaimCheckAt) && !claims.kept() {",
		"job, err := t.claimSession(loopCtx, &claims)",
	} {
		if !strings.Contains(inLoop, want) {
			t.Errorf("the claim loop no longer reads: %s", want)
		}
	}
	failure := strings.Index(inLoop, `logln("claim failed:", err)`)
	if failure < 0 {
		t.Fatal("runLoop no longer logs a failed claim")
	}
	path := inLoop[failure:]
	path = path[:strings.Index(path, "\n\t\tif job == nil {")]
	held := strings.Index(path, "if claims.kept() {")
	reconcile := strings.Index(path, "reclaimMissingSessions(")
	if held < 0 || reconcile < held || !strings.Contains(path[held:reconcile], "lateClaimCheckAt = time.Now()\n") ||
		!strings.Contains(path[held:reconcile], "} else {") {
		t.Errorf("a claim that got no answer over the link is reconciled at once, not by the late check once it is answered:\n%s", path)
	}
}
