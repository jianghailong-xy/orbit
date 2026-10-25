package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"orbit/linkpb"
)

// The work connection under faults (docs/runner-link-design.md §5.4, §5.6, §7): a connection lost mid-call, a token
// that expires, a drain, a claim whose answer is lost, a turn completion whose events are not stored yet.

// A connection that drops mid-call is replaced: the next Hello names the same process and says where each session
// stands, the last event seq sent and the turn being executed, and the call in flight is sent again on the new
// connection under its request_id and answered there.
func TestLinkResumesAfterADroppedConnection(t *testing.T) {
	r, _ := newLinkEventsRig(t)
	held := make(chan struct{})
	var once sync.Once
	r.g.backend = func(c *fakeWorkConn, rpc *linkpb.Rpc) *linkpb.RpcResult {
		path := rpc.GetTunnel().GetPath()
		switch {
		case strings.HasSuffix(path, "/merge-result") && c.id == "c-0000000000000001":
			once.Do(func() { close(held) })
			<-c.done // never answered on this connection
			return nil
		case strings.Contains(path, "/inbox"):
			return fakeWorkAnswer(rpc, 200, `{"turnId":"turn-7","kind":"message","content":"hi"}`)
		}
		return fakeWorkAnswer(rpc, 200, `{}`)
	}
	first := r.useLink(t)
	if _, err := r.t.heartbeat(HeartbeatRequest{Status: "ONLINE", LeaseOwner: r.t.leaseOwner, SupervisedSessionIDs: []string{"session-a"}}); err != nil {
		t.Fatal(err)
	}
	if err := r.t.postEvents(context.Background(), "session-a", linkTestEvents(1, 5, 10)); err != nil {
		t.Fatal(err)
	}
	if turn, err := r.t.inbox(context.Background(), "session-a", "gen-1"); err != nil || turn == nil || turn.TurnID != "turn-7" {
		t.Fatalf("inbox: %+v %v", turn, err)
	}
	result := make(chan error, 1)
	go func() {
		result <- r.t.mergeResult("session-a", MergeResultRequest{OperationID: "op-1", Status: "merged"})
	}()
	<-held
	first.drop()
	second := r.g.waitWelcomed(t, 2)
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("the call in flight failed: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the call in flight was never answered")
	}
	if !strings.EqualFold(second.hello.GetProcessId(), r.t.leaseOwner) || !strings.EqualFold(first.hello.GetProcessId(), r.t.leaseOwner) {
		t.Errorf("Hellos name processes %s and %s, the process is %s", first.hello.GetProcessId(), second.hello.GetProcessId(), r.t.leaseOwner)
	}
	if first.id == second.id {
		t.Errorf("both connections are %s", first.id)
	}
	sessions := second.hello.GetSessions()
	if len(sessions) != 1 || sessions[0].GetSessionId() != "session-a" || sessions[0].GetLastSeq() != 5 || sessions[0].GetTurnId() != "turn-7" {
		t.Errorf("the second Hello resumes %v, want session-a from seq 5 executing turn-7", sessions)
	}
	merges := r.g.rpcsTo("/runner/sessions/session-a/merge-result")
	if len(merges) != 2 || merges[0].requestID != merges[1].requestID || merges[0].conn == merges[1].conn {
		t.Fatalf("the merge result went %d times: %+v", len(merges), merges)
	}
	for _, tok := range r.cp.requests("/api/runner/link-token") {
		if !strings.EqualFold(tok.leaseOwner, r.t.leaseOwner) {
			t.Errorf("a link token was asked for process %s", tok.leaseOwner)
		}
	}
	// Leases are the process's: the connection's end took none, and nothing asked for a takeover.
	if n := len(r.g.rpcsTo("/runner/sessions/session-a/takeover-leases")); n != 0 {
		t.Errorf("%d takeovers after a reconnect", n)
	}
}

// A connection the gateway closes because its token expired is replaced with one opened with a fresh token, and the
// call it was carrying is answered on the next one.
func TestLinkReconnectsWithAFreshTokenWhenItsTokenExpires(t *testing.T) {
	r := newLinkWorkRig(t)
	held := make(chan struct{})
	var once sync.Once
	r.g.backend = func(c *fakeWorkConn, rpc *linkpb.Rpc) *linkpb.RpcResult {
		if c.id == "c-0000000000000001" {
			once.Do(func() { close(held) })
			<-c.done // the expiry takes the answer with it
			return nil
		}
		return fakeWorkAnswer(rpc, 200, `{"id":"runner-1"}`)
	}
	first := r.useLink(t)
	result := make(chan error, 1)
	go func() {
		_, err := r.t.me()
		result <- err
	}()
	<-held
	// What the gateway does when a token outlives its renewal: the token on file still had most of an hour to go,
	// so the runner did not renew it first.
	first.closeWith(linkpb.CloseCode_CLOSE_CODE_UNAUTHENTICATED, "the link token expired", 0)
	second := r.g.waitWelcomed(t, 2)
	if err := <-result; err != nil {
		t.Fatalf("GET /runner/me across the expiry: %v", err)
	}
	r.g.mu.Lock()
	closedWith := first.closedWith
	r.g.mu.Unlock()
	if closedWith != linkpb.CloseCode_CLOSE_CODE_UNAUTHENTICATED {
		t.Fatalf("the first connection was closed with %v", closedWith)
	}
	if first.token == second.token {
		t.Error("the connection after the expiry was opened with the expired token")
	}
	if n := len(r.cp.requests("/api/runner/link-token")); n != 2 {
		t.Errorf("%d link tokens for two connections", n)
	}
	calls := r.g.rpcsTo("/runner/me")
	if len(calls) != 2 || calls[0].requestID != calls[1].requestID {
		t.Errorf("GET /runner/me went as %+v", calls)
	}
}

// Before its token expires, the next connection is opened with a fresh token and welcomed, and only then does the old
// one go: calls made all along never fail.
func TestLinkRenewsItsTokenMakeBeforeBreak(t *testing.T) {
	r := newLinkWorkRig(t)
	r.cp.lifetime = 3 * time.Second // renewed after 1.5s
	r.useLink(t)
	stop := make(chan struct{})
	var failures atomic.Int64
	var calls sync.WaitGroup
	calls.Add(1)
	go func() {
		defer calls.Done()
		for {
			select {
			case <-stop:
				return
			case <-time.After(20 * time.Millisecond):
			}
			if _, err := r.t.me(); err != nil {
				failures.Add(1)
				t.Errorf("a call during renewal: %v", err)
			}
		}
	}()
	r.g.waitWelcomed(t, 3)
	close(stop)
	calls.Wait()
	conns := r.g.welcomed()
	for i := 0; i < 2; i++ {
		old, next := conns[i], conns[i+1]
		r.g.mu.Lock()
		ended := old.ended
		r.g.mu.Unlock()
		if ended.IsZero() {
			linkWaitFor(t, 5*time.Second, old.id+" to end", func() bool {
				r.g.mu.Lock()
				defer r.g.mu.Unlock()
				ended = old.ended
				return !ended.IsZero()
			})
		}
		if !next.welcomed.Before(ended) {
			t.Errorf("%s was welcomed after %s ended: break before make", next.id, old.id)
		}
		if old.token == next.token {
			t.Errorf("%s was opened with %s's token", next.id, old.id)
		}
	}
	if failures.Load() != 0 {
		t.Errorf("%d calls failed across renewals", failures.Load())
	}
}

// A TokenRefresh renews the token in place: no new connection for it, and the next connection opens with it rather
// than with a token fetched over HTTPS.
func TestLinkTakesATokenRefresh(t *testing.T) {
	r := newLinkWorkRig(t)
	first := r.useLink(t)
	refreshed := fakeLinkToken(time.Now(), time.Hour, r.t.leaseOwner, 99)
	first.send(&linkpb.Frame{Body: &linkpb.Frame_TokenRefresh{TokenRefresh: &linkpb.TokenRefresh{
		Token: refreshed, ExpiresAtUnixMs: time.Now().Add(time.Hour).UnixMilli(),
	}}})
	linkWaitFor(t, 5*time.Second, "the refreshed token to be held", func() bool {
		r.m.work.client.mu.Lock()
		defer r.m.work.client.mu.Unlock()
		return r.m.work.client.tok != nil && r.m.work.client.tok.token == refreshed
	})
	if n := len(r.g.welcomed()); n != 1 {
		t.Fatalf("%d connections after a TokenRefresh", n)
	}
	first.drop()
	second := r.g.waitWelcomed(t, 2)
	if second.token != refreshed {
		t.Error("the next connection did not open with the refreshed token")
	}
	if n := len(r.cp.requests("/api/runner/link-token")); n != 1 {
		t.Errorf("%d link tokens fetched over HTTPS; the refresh should have spared one", n)
	}
}

// A Drain opens the next connection after its delay, make before break; the drained one goes once the next is
// welcomed, and the call it was carrying is answered on the next under the same request_id.
func TestLinkFollowsADrain(t *testing.T) {
	r := newLinkWorkRig(t)
	held := make(chan struct{})
	var once sync.Once
	r.g.backend = func(c *fakeWorkConn, rpc *linkpb.Rpc) *linkpb.RpcResult {
		if c.id == "c-0000000000000001" && strings.HasSuffix(rpc.GetTunnel().GetPath(), "/commit-result") {
			once.Do(func() { close(held) })
			<-c.done
			return nil
		}
		return fakeWorkAnswer(rpc, 200, `{}`)
	}
	first := r.useLink(t)
	result := make(chan error, 1)
	go func() {
		result <- r.t.commitResult("session-a", CommitResultRequest{OperationID: "op-2", Status: "committed"})
	}()
	<-held
	drained := time.Now()
	first.send(&linkpb.Frame{Body: &linkpb.Frame_Drain{Drain: &linkpb.Drain{ReconnectAfterMs: 150}}})
	second := r.g.waitWelcomed(t, 2)
	if err := <-result; err != nil {
		t.Fatalf("the call across the drain: %v", err)
	}
	if took := second.welcomed.Sub(drained); took < 150*time.Millisecond {
		t.Errorf("the next connection came %s after the Drain, sooner than its 150ms", took)
	}
	linkWaitFor(t, 5*time.Second, "the drained connection to end", func() bool {
		r.g.mu.Lock()
		defer r.g.mu.Unlock()
		return !first.ended.IsZero()
	})
	r.g.mu.Lock()
	ended := first.ended
	r.g.mu.Unlock()
	if !second.welcomed.Before(ended) {
		t.Error("the drained connection ended before the next was welcomed: break before make")
	}
	commits := r.g.rpcsTo("/runner/sessions/session-a/commit-result")
	if len(commits) != 2 || commits[0].requestID != commits[1].requestID {
		t.Errorf("the commit result went as %+v", commits)
	}
	if got := r.m.work.current(); got == nil || got.id != second.id {
		t.Errorf("calls go out on %v, not the new connection", got)
	}
}

// A drain on a gateway with one node: the next connection is refused while the drained one keeps carrying the work,
// and the time that counts as without a link is only from the drained one's end to the next one's Welcome.
func TestLinkDrainOnOneNodeCountsOnlyTheTimeWithoutAConnection(t *testing.T) {
	r := newLinkWorkRig(t)
	first := r.useLink(t)
	var draining atomic.Bool
	draining.Store(true)
	var refused atomic.Int64
	var firstRefusal atomic.Pointer[time.Time]
	r.g.refuse = func(*http.Request) (int, string, string) {
		if draining.Load() {
			now := time.Now()
			firstRefusal.CompareAndSwap(nil, &now)
			refused.Add(1)
			return http.StatusServiceUnavailable, `{"code":"DRAINING","message":"draining"}`, "1"
		}
		return 0, "", ""
	}
	first.send(&linkpb.Frame{Body: &linkpb.Frame_Drain{Drain: &linkpb.Drain{ReconnectAfterMs: 50}}})
	linkWaitFor(t, 10*time.Second, "two refused upgrades", func() bool { return refused.Load() >= 2 })
	if _, err := r.t.me(); err != nil {
		t.Fatalf("the drained connection stopped carrying calls: %v", err)
	}
	draining.Store(false)
	closed := time.Now()
	first.closeWith(linkpb.CloseCode_CLOSE_CODE_UNSPECIFIED, "the gateway is shutting down", 0)
	next := r.g.waitWelcomed(t, 2)
	linkWaitFor(t, 5*time.Second, "the reconnect to be logged", func() bool {
		return strings.Contains(strings.Join(r.logs.all(), "\n"), "without one")
	})
	without := next.welcomed.Sub(closed)
	for _, line := range r.logs.all() {
		_, after, ok := strings.Cut(line, ", after ")
		if !ok {
			continue
		}
		gap, err := time.ParseDuration(strings.TrimSuffix(after, " without one"))
		if err != nil {
			t.Fatalf("%q: %v", line, err)
		}
		if gap > without+100*time.Millisecond || gap >= next.welcomed.Sub(*firstRefusal.Load()) {
			t.Errorf("logged %s without a connection; there was none for %s, and the first refused attempt was %s before the Welcome: %s",
				gap, without, next.welcomed.Sub(*firstRefusal.Load()), line)
		}
	}
}

// Back on the link after a time on HTTPS, the work connects at once: failed attempts before it was sent back say
// nothing about this time, and Welcomes that said MODE_HTTP hold it back only when they were just now. The reconnect
// it logs counts no time on HTTPS as one without a link.
func TestLinkComesBackAtOnceAfterATimeOnHTTPS(t *testing.T) {
	for _, before := range []string{"failed attempts", "a flap long ago"} {
		t.Run(before, func(t *testing.T) {
			r := newLinkWorkRig(t)
			first := r.useLink(t)
			first.drop()
			r.g.waitWelcomed(t, 2)
			r.g.setMode(linkpb.Mode_MODE_HTTP)
			if _, err := r.t.heartbeat(HeartbeatRequest{Status: "ONLINE", LeaseOwner: r.t.leaseOwner}); err != nil {
				t.Fatal(err)
			}
			linkWaitFor(t, 5*time.Second, "the work to stop", func() bool { return !r.m.work.running() && len(r.g.open()) == 0 })
			r.m.work.wait(5 * time.Second)
			r.m.work.mu.Lock()
			if before == "failed attempts" {
				r.m.work.attempt += 4 // a run of failures, just now
			} else {
				r.m.work.flaps, r.m.work.stoppedAt = 4, time.Now().Add(-2*linkBackoffMax)
			}
			r.m.work.mu.Unlock()
			r.g.setMode(linkpb.Mode_MODE_LINK)
			began := time.Now()
			r.m.observe(linkpb.Mode_MODE_LINK, "the test")
			third := r.g.waitWelcomed(t, 3)
			if took := third.welcomed.Sub(began); took > 500*time.Millisecond {
				t.Errorf("the work connection came %s after the link was back in use", took)
			}
			linkWaitFor(t, 5*time.Second, "the connection to be logged", func() bool {
				return strings.Contains(strings.Join(r.logs.all(), "\n"), third.id+" to ")
			})
			for _, line := range r.logs.all() {
				if strings.Contains(line, third.id+" to ") && strings.Contains(line, "without one") {
					t.Errorf("the time on HTTPS was logged as one without a link: %s", line)
				}
			}
		})
	}
}

// fakeClaims is a backend that claims as the control plane does under request ids (task B2): a claim sent again
// under the id of one that claimed is answered with that claim's session, and never claims another.
type fakeClaims struct {
	mu      sync.Mutex
	byID    map[string]string
	claimed []string
}

func (f *fakeClaims) claim(requestID string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if s, ok := f.byID[requestID]; ok {
		return s
	}
	s := fmt.Sprintf("session-%d", len(f.claimed)+1)
	f.byID[requestID] = s
	f.claimed = append(f.claimed, s)
	return s
}

// A claim whose answer is lost, with the connection it went on, is sent again under the same request_id on the next
// connection, and comes back with the session the first one claimed: one session claimed, not two.
func TestALostClaimAnswerIsSentAgainUnderItsRequestIDForTheSameSession(t *testing.T) {
	for _, loss := range []string{"connection lost", "BACKEND_CUT_OFF"} {
		t.Run(loss, func(t *testing.T) {
			r := newLinkWorkRig(t)
			claims := &fakeClaims{byID: map[string]string{}}
			var answered atomic.Int64
			r.g.backend = func(c *fakeWorkConn, rpc *linkpb.Rpc) *linkpb.RpcResult {
				if rpc.GetTunnel().GetPath() != "/runner/sessions/claim" {
					return fakeWorkAnswer(rpc, 200, `{}`)
				}
				session := claims.claim(rpc.GetRequestId())
				if answered.Add(1) == 1 {
					// Claimed, and the answer lost on its way back.
					if loss == "BACKEND_CUT_OFF" {
						return fakeWorkFailure(rpc, "BACKEND_CUT_OFF", true, 0)
					}
					c.drop()
					return nil
				}
				return fakeWorkAnswer(rpc, 200, fmt.Sprintf(`{"sessionId":%q,"title":"t"}`, session))
			}
			r.useLink(t)
			job, err := r.t.claimSession(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if job == nil || job.SessionID != "session-1" {
				t.Fatalf("claimed %+v, want session-1", job)
			}
			calls := r.g.rpcsTo("/runner/sessions/claim")
			if len(calls) != 2 || calls[0].requestID != calls[1].requestID {
				t.Fatalf("the claim went as %+v", calls)
			}
			claims.mu.Lock()
			defer claims.mu.Unlock()
			if len(claims.claimed) != 1 {
				t.Errorf("claimed %v: the resend claimed another session", claims.claimed)
			}
		})
	}
}

// A request too large for one link frame is refused before it is sent: sent, it would end the connection, and end the
// next one when it was sent again.
func TestARequestTooLargeForTheLinkIsRefusedBeforeItIsSent(t *testing.T) {
	r := newLinkWorkRig(t)
	conn := r.useLink(t)
	err := r.t.diffResultContext(context.Background(), "session-a", DiffResultRequest{
		ChangedDiff: []FilePatch{{Path: "big.txt", Patch: strings.Repeat("x", linkMaxRequestBytes)}},
	})
	if !isTransportHTTPStatus(err, http.StatusRequestEntityTooLarge) || !strings.Contains(err.Error(), "RUNNER_LINK_REQUEST_TOO_LARGE") {
		t.Fatalf("the oversized diff: %v", err)
	}
	if n := len(r.g.rpcsTo("/runner/sessions/session-a/diff")); n != 0 {
		t.Errorf("%d oversized requests reached the gateway", n)
	}
	if _, err := r.t.me(); err != nil {
		t.Fatal(err)
	}
	if open := r.g.open(); len(open) != 1 || open[0] != conn {
		t.Error("the connection did not survive the refused request")
	}
}

// A transcript page whose answer is more than one frame may carry is asked for again in halves: the gateway refuses
// to relay it (BACKEND_ANSWER_TOO_LARGE), and a smaller page fits.
func TestATranscriptPageTooLargeForTheLinkIsAskedForInHalves(t *testing.T) {
	r := newLinkWorkRig(t)
	r.g.backend = func(c *fakeWorkConn, rpc *linkpb.Rpc) *linkpb.RpcResult {
		path := rpc.GetTunnel().GetPath()
		if strings.Contains(path, "/events?") && !strings.HasSuffix(path, "limit=37") {
			return fakeWorkFailure(rpc, "BACKEND_ANSWER_TOO_LARGE", false, 0)
		}
		return fakeWorkAnswer(rpc, 200, `{"events":[{"seq":1,"type":"assistant","payload":{}}],"hasMore":true}`)
	}
	r.useLink(t)
	page, err := r.t.sessionEvents(context.Background(), "session-a", 0, transcriptFetchPageSize)
	if err != nil || len(page.Events) != 1 || !page.HasMore {
		t.Fatalf("the page: %+v %v", page, err)
	}
	var limits []string
	for _, c := range r.g.rpcsTo("/runner/sessions/session-a/events") {
		_, q, _ := strings.Cut(c.path, "limit=")
		limits = append(limits, q)
	}
	if strings.Join(limits, ",") != "300,150,75,37" {
		t.Errorf("pages asked for: %v", limits)
	}
}

// Over the link a session's events go as EventBatch frames on the work connection, never as calls to the events
// route, and postEvents returns once the EventAck says they are stored.
func TestEventsGoOverTheLinkAsEventBatches(t *testing.T) {
	r, in := newLinkEventsRig(t)
	r.useLink(t)
	if err := r.t.postEvents(context.Background(), "session-a", linkTestEvents(1, 4, 10)); err != nil {
		t.Fatal(err)
	}
	if err := r.t.postEvents(context.Background(), "session-a", linkTestEvents(5, 2, 10)); err != nil {
		t.Fatal(err)
	}
	in.assertContiguous(t, "session-a", 1, 6)
	if n := len(r.g.rpcsTo("/runner/sessions/session-a/events")); n != 0 {
		t.Errorf("%d event batches went as calls", n)
	}
	if got := r.m.storedRowSeq("session-a"); got != 6 {
		t.Errorf("stored through %d", got)
	}
}

// Every call has its own request_id, and a call sent again keeps it.
func TestEachCallHasARequestIDOfItsOwn(t *testing.T) {
	r := newLinkWorkRig(t)
	r.useLink(t)
	for i := 0; i < 3; i++ {
		if _, err := r.t.me(); err != nil {
			t.Fatal(err)
		}
	}
	calls := r.g.rpcsTo("/runner/me")
	seen := map[string]bool{}
	for _, c := range calls {
		if seen[c.requestID] {
			t.Errorf("request_id %s used twice", c.requestID)
		}
		seen[c.requestID] = true
		if !requestIDPatternOK(c.requestID) {
			t.Errorf("request_id %q is not what the gateway forwards", c.requestID)
		}
	}
}

// requestIDPatternOK is the gateway's rule for a request_id (forward.go): 1 to 128 of [A-Za-z0-9._:-].
func requestIDPatternOK(id string) bool {
	if len(id) == 0 || len(id) > 128 {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("._:-", c)) {
			return false
		}
	}
	return true
}

// A turn completion carries after_seq, the session's last event seq sent, and while the control plane answers that
// those events are not all stored yet it is sent again, under the same request_id, after the delay it names.
func TestATurnCompletionWaitsForItsEventsWithAfterSeq(t *testing.T) {
	r, _ := newLinkEventsRig(t)
	var pending atomic.Int64
	r.g.backend = func(c *fakeWorkConn, rpc *linkpb.Rpc) *linkpb.RpcResult {
		if strings.HasSuffix(rpc.GetTunnel().GetPath(), "/turn-complete") && pending.Add(1) <= 2 {
			return &linkpb.RpcResult{RequestId: rpc.GetRequestId(), Outcome: &linkpb.RpcResult_Tunnel{Tunnel: &linkpb.TunnelResponse{
				Status: 503, RetryAfterMs: 120,
				JsonBody: []byte(`{"statusCode":503,"code":"RUNNER_LINK_AFTER_SEQ_PENDING","retryable":true,"retryAfterMs":120}`),
			}}}
		}
		if strings.HasSuffix(rpc.GetTunnel().GetPath(), "/turn-complete") {
			return fakeWorkAnswer(rpc, 200, `{"status":"AWAITING_INPUT"}`)
		}
		return fakeWorkAnswer(rpc, 200, `{}`)
	}
	r.useLink(t)
	if err := r.t.postEvents(context.Background(), "session-a", linkTestEvents(1, 7, 10)); err != nil {
		t.Fatal(err)
	}
	status, err := r.t.turnComplete(context.Background(), "session-a", TurnCompleteRequest{TurnID: "turn-1", Status: "completed"})
	if err != nil || status != "AWAITING_INPUT" {
		t.Fatalf("turn-complete: %q %v", status, err)
	}
	calls := r.g.rpcsTo("/runner/sessions/session-a/turn-complete")
	if len(calls) != 3 {
		t.Fatalf("turn-complete went %d times", len(calls))
	}
	for i, c := range calls {
		if c.sessionID != "session-a" || c.afterSeq != 7 || c.requestID != calls[0].requestID {
			t.Errorf("attempt %d: session %q after_seq %d request_id %s", i, c.sessionID, c.afterSeq, c.requestID)
		}
		if i > 0 && c.at.Sub(calls[i-1].at) < 100*time.Millisecond {
			t.Errorf("attempt %d came %s after the one before, sooner than the 120ms it was told", i, c.at.Sub(calls[i-1].at))
		}
	}
	// The events themselves went as EventBatches, which depend on nothing.
	if n := len(r.g.rpcsTo("/runner/sessions/session-a/events")); n != 0 {
		t.Errorf("%d event batches went as calls", n)
	}
}

// A turn completion whose events never get stored (a batch the session gave up on) does not wait forever: past
// linkAfterSeqWait it depends only on the events the control plane acknowledged.
func TestATurnCompletionStopsWaitingForEventsThatWillNeverBeStored(t *testing.T) {
	shortenLinkWaits(t, linkLongPoll, linkApprovalRecheck, 400*time.Millisecond)
	r, in := newLinkEventsRig(t)
	in.refuseBatch = func(eb *linkpb.EventBatch) *linkpb.Failure {
		if eb.GetEvents()[0].GetSeq() == 6 {
			return fakeIngestFailure("REFUSED_FOR_THE_TEST", false, 0) // never stored
		}
		return nil
	}
	r.g.backend = func(c *fakeWorkConn, rpc *linkpb.Rpc) *linkpb.RpcResult {
		path := rpc.GetTunnel().GetPath()
		switch {
		case strings.HasSuffix(path, "/turn-complete") && rpc.GetAfterSeq() > 5:
			return &linkpb.RpcResult{RequestId: rpc.GetRequestId(), Outcome: &linkpb.RpcResult_Tunnel{Tunnel: &linkpb.TunnelResponse{
				Status: 503, RetryAfterMs: 50, JsonBody: []byte(`{"code":"RUNNER_LINK_AFTER_SEQ_PENDING","retryable":true}`),
			}}}
		}
		return fakeWorkAnswer(rpc, 200, `{"status":"AWAITING_INPUT"}`)
	}
	r.useLink(t)
	if err := r.t.postEvents(context.Background(), "session-a", linkTestEvents(1, 5, 10)); err != nil {
		t.Fatal(err)
	}
	if err := r.t.postEvents(context.Background(), "session-a", linkTestEvents(6, 2, 10)); err == nil {
		t.Fatal("the refused batch was accepted")
	}
	began := time.Now()
	if _, err := r.t.turnComplete(context.Background(), "session-a", TurnCompleteRequest{TurnID: "turn-1"}); err != nil {
		t.Fatal(err)
	}
	if took := time.Since(began); took < 400*time.Millisecond {
		t.Errorf("gave up waiting after %s, before linkAfterSeqWait", took)
	}
	calls := r.g.rpcsTo("/runner/sessions/session-a/turn-complete")
	last := calls[len(calls)-1]
	if calls[0].afterSeq != 7 || last.afterSeq != 5 {
		t.Errorf("after_seq went from %d to %d, want 7 (sent) then 5 (stored)", calls[0].afterSeq, last.afterSeq)
	}
}

// The heartbeat goes as a Heartbeat frame whose parts are sent whole only when the gateway does not hold them: all on
// a connection's first beat, then by digest alone, a changed part whole, and a part the gateway asks for at once. The
// gateway forwards the body the HTTPS heartbeat carries, and the route's answer is applied as the HTTPS answer is.
func TestLinkHeartbeatSendsItsPartsByDigest(t *testing.T) {
	r := newLinkWorkRig(t)
	r.g.reconcile = func(c *fakeWorkConn, body map[string]json.RawMessage) []byte {
		return []byte(`{"maxConcurrent":7,"cancelSessionIds":["session-z"]}`)
	}
	r.useLink(t)
	hb := linkTestHeartbeat(r.t.leaseOwner)
	resp, err := r.t.heartbeat(hb)
	if err != nil {
		t.Fatal(err)
	}
	if resp.MaxConcurrent != 7 || len(resp.CancelSessionIDs) != 1 || resp.CancelSessionIDs[0] != "session-z" {
		t.Errorf("the reconcile was applied as %+v", resp)
	}
	httpBody, _ := json.Marshal(hb)
	var httpMembers map[string]json.RawMessage
	_ = json.Unmarshal(httpBody, &httpMembers)
	_, _, beats := r.g.snapshot()
	if len(beats) != 1 || beats[0].forwarded == nil {
		t.Fatalf("beats: %+v", beats)
	}
	for _, f := range beats[0].frame.GetFacts() {
		if len(f.GetJson()) == 0 {
			t.Errorf("the first beat sent %s by digest alone", f.GetKind())
		}
	}
	for name, raw := range httpMembers {
		if name == "status" || name == "version" {
			continue
		}
		if got, ok := beats[0].forwarded[name]; !ok || !jsonEqual(t, got, raw) {
			t.Errorf("the forwarded body's %s is %s, the HTTPS body's %s", name, got, raw)
		}
	}

	// The same beat again: every part by digest.
	if _, err := r.t.heartbeat(hb); err != nil {
		t.Fatal(err)
	}
	// One part changed: that part whole, the rest by digest.
	hb.ReposRoot = "/srv/elsewhere"
	if _, err := r.t.heartbeat(hb); err != nil {
		t.Fatal(err)
	}
	_, _, beats = r.g.snapshot()
	for _, f := range beats[1].frame.GetFacts() {
		if len(f.GetJson()) != 0 {
			t.Errorf("the second beat sent %s whole", f.GetKind())
		}
	}
	for _, f := range beats[2].frame.GetFacts() {
		if whole := len(f.GetJson()) != 0; whole != (f.GetKind() == "reposRoot") {
			t.Errorf("the third beat sent %s whole=%v", f.GetKind(), whole)
		}
	}
	if string(beats[2].forwarded["reposRoot"]) != `"/srv/elsewhere"` {
		t.Errorf("the changed part was forwarded as %s", beats[2].forwarded["reposRoot"])
	}

	// The gateway lost a part: it asks, and gets it whole at once, in the same heartbeat call.
	cur := r.g.open()[0]
	r.g.mu.Lock()
	delete(cur.facts, "engines")
	r.g.mu.Unlock()
	if _, err := r.t.heartbeat(hb); err != nil {
		t.Fatal(err)
	}
	_, _, beats = r.g.snapshot()
	asked, answered := beats[3], beats[4]
	if len(asked.want) != 1 || asked.want[0] != "engines" || asked.forwarded != nil {
		t.Errorf("the gateway's question: %+v", asked)
	}
	for _, f := range answered.frame.GetFacts() {
		if whole := len(f.GetJson()) != 0; whole != (f.GetKind() == "engines") {
			t.Errorf("the answer to want_facts sent %s whole=%v", f.GetKind(), whole)
		}
	}
	if answered.forwarded == nil {
		t.Error("the beat sent after want_facts was not forwarded")
	}
}

func jsonEqual(t *testing.T, a, b []byte) bool {
	t.Helper()
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return false
	}
	xa, _ := json.Marshal(x)
	ya, _ := json.Marshal(y)
	return string(xa) == string(ya)
}

// A heartbeat that reconciled nothing failed, as an HTTPS heartbeat that got no 2xx does: nothing is applied.
func TestALinkHeartbeatThatReconciledNothingFailed(t *testing.T) {
	r := newLinkWorkRig(t)
	r.g.reconcile = func(*fakeWorkConn, map[string]json.RawMessage) []byte { return nil }
	r.useLink(t)
	if _, err := r.t.heartbeat(linkTestHeartbeat(r.t.leaseOwner)); !errors.Is(err, errLinkBeatUnreconciled) {
		t.Fatalf("a beat with no reconcile: %v", err)
	}
}

// In link mode the long polls hang nowhere: a claim, an inbox fetch or the wake is asked once something says there is
// an answer (a hint, the HintState of a HeartbeatAck, a new connection) and otherwise answers nothing at the end of
// its window without asking at all.
func TestLinkLongPollsWaitForHints(t *testing.T) {
	shortenLinkWaits(t, 300*time.Millisecond, 200*time.Millisecond, linkAfterSeqWait)
	r := newLinkWorkRig(t)
	var claimable atomic.Bool
	r.g.backend = func(c *fakeWorkConn, rpc *linkpb.Rpc) *linkpb.RpcResult {
		path := rpc.GetTunnel().GetPath()
		switch {
		case path == "/runner/sessions/claim" && claimable.Load():
			return fakeWorkAnswer(rpc, 200, `{"sessionId":"session-c","title":"t"}`)
		case strings.Contains(path, "/inbox"):
			return fakeWorkAnswer(rpc, 200, `{"turnId":"turn-1","kind":"message"}`)
		case strings.Contains(path, "/approvals/"):
			return fakeWorkAnswer(rpc, 200, `{"id":"ap-1","status":"PENDING"}`)
		}
		return fakeWorkAnswer(rpc, 200, ``)
	}
	conn := r.useLink(t)
	ctx := context.Background()

	// The claim: once for the new connection, then only on a hint.
	if job, err := r.t.claimSession(ctx); err != nil || job != nil {
		t.Fatalf("first claim: %+v %v", job, err)
	}
	began := time.Now()
	if job, err := r.t.claimSession(ctx); err != nil || job != nil || time.Since(began) < 250*time.Millisecond {
		t.Fatalf("an unhinted claim: %+v %v after %s", job, err, time.Since(began))
	}
	if n := len(r.g.rpcsTo("/runner/sessions/claim")); n != 1 {
		t.Fatalf("%d claims asked with one reason to ask", n)
	}
	claimable.Store(true)
	go func() {
		time.Sleep(50 * time.Millisecond)
		conn.send(&linkpb.Frame{Body: &linkpb.Frame_Hint{Hint: &linkpb.Hint{Kind: &linkpb.Hint_Claim{Claim: &linkpb.ClaimHint{}}}}})
	}()
	if job, err := r.t.claimSession(ctx); err != nil || job == nil || job.SessionID != "session-c" {
		t.Fatalf("a hinted claim: %+v %v", job, err)
	}

	// The inbox: the first ask, then a hint for that session, or the HintState of a HeartbeatAck.
	if turn, _ := r.t.inbox(ctx, "session-a", ""); turn == nil {
		t.Fatal("the first inbox fetch asked nothing")
	}
	if turn, _ := r.t.inbox(ctx, "session-a", ""); turn != nil {
		t.Fatal("an unhinted inbox fetch asked")
	}
	conn.send(&linkpb.Frame{Body: &linkpb.Frame_Hint{Hint: &linkpb.Hint{Kind: &linkpb.Hint_Inbox{Inbox: &linkpb.InboxHint{SessionId: "session-b"}}}}})
	if turn, _ := r.t.inbox(ctx, "session-a", ""); turn != nil {
		t.Fatal("a hint for another session fetched this one's inbox")
	}
	r.g.mu.Lock()
	r.g.ackHints = &linkpb.HintState{InboxSessionIds: []string{"session-a"}}
	r.g.mu.Unlock()
	if _, err := r.t.heartbeat(HeartbeatRequest{Status: "ONLINE", LeaseOwner: r.t.leaseOwner}); err != nil {
		t.Fatal(err)
	}
	if turn, _ := r.t.inbox(ctx, "session-a", ""); turn == nil {
		t.Fatal("the HintState of a HeartbeatAck did not fetch the inbox")
	}
	if n := len(r.g.rpcsTo("/runner/sessions/session-a/inbox")); n != 2 {
		t.Errorf("the inbox was asked %d times with two reasons to ask", n)
	}

	// The wake asks nothing: a CommandsHint is the wake.
	if woke, err := r.t.waitForWake(ctx); err != nil || !woke {
		t.Fatalf("the new connection's first beat is owed at once: %v %v", woke, err)
	}
	if woke, _ := r.t.waitForWake(ctx); woke {
		t.Fatal("woke with nothing hinted")
	}
	conn.send(&linkpb.Frame{Body: &linkpb.Frame_Hint{Hint: &linkpb.Hint{Kind: &linkpb.Hint_Commands{Commands: &linkpb.CommandsHint{}}}}})
	if woke, _ := r.t.waitForWake(ctx); !woke {
		t.Fatal("a CommandsHint did not wake")
	}
	if n := len(r.g.rpcsTo("/runner/wake")); n != 0 {
		t.Errorf("the wake was asked %d times over the link", n)
	}

	// An approval is read again every linkApprovalRecheck, and at once on its ApprovalHint.
	began = time.Now()
	for i := 0; i < 3; i++ {
		if dec, err := r.t.pollApproval(ctx, "session-a", "ap-1"); err != nil || dec.Status != "PENDING" {
			t.Fatalf("poll: %+v %v", dec, err)
		}
	}
	if took := time.Since(began); took < 350*time.Millisecond {
		t.Errorf("three reads of a pending approval took %s: not paced", took)
	}
	go func() {
		time.Sleep(20 * time.Millisecond)
		conn.send(&linkpb.Frame{Body: &linkpb.Frame_Hint{Hint: &linkpb.Hint{Kind: &linkpb.Hint_Approval{Approval: &linkpb.ApprovalHint{SessionId: "session-a", ApprovalId: "ap-1"}}}}})
	}()
	began = time.Now()
	if _, err := r.t.pollApproval(ctx, "session-a", "ap-1"); err != nil {
		t.Fatal(err)
	}
	if took := time.Since(began); took > 150*time.Millisecond {
		t.Errorf("an ApprovalHint took %s to be read", took)
	}
}

// Hints and HintState mark only the gates a long poll made: an approval nobody reads, or one already read and decided
// that HintState keeps naming until its tool call returns (task B4b), leaves no gate behind, and neither does a hint
// for a session nobody fetches the inbox of.
func TestHintsMakeNoGateNobodyWaitsOn(t *testing.T) {
	r := newLinkWorkRig(t)
	var decided atomic.Bool
	r.g.backend = func(c *fakeWorkConn, rpc *linkpb.Rpc) *linkpb.RpcResult {
		if strings.Contains(rpc.GetTunnel().GetPath(), "/approvals/") {
			if decided.Load() {
				return fakeWorkAnswer(rpc, 200, `{"id":"ap-1","status":"ALLOWED"}`)
			}
			return fakeWorkAnswer(rpc, 200, `{"id":"ap-1","status":"PENDING"}`)
		}
		return fakeWorkAnswer(rpc, 200, `{}`)
	}
	conn := r.useLink(t)
	gates := func() (approvals, inboxes int) {
		r.m.gates.mu.Lock()
		defer r.m.gates.mu.Unlock()
		return len(r.m.gates.approval), len(r.m.gates.inbox)
	}
	hint := func(h *linkpb.Hint) { conn.send(&linkpb.Frame{Body: &linkpb.Frame_Hint{Hint: h}}) }
	unknownApproval := "6f3a2c1e-0b7d-4c55-9a8e-2d4f6b8a1c3e"
	hint(&linkpb.Hint{Kind: &linkpb.Hint_Approval{Approval: &linkpb.ApprovalHint{SessionId: "session-a", ApprovalId: unknownApproval}}})
	hint(&linkpb.Hint{Kind: &linkpb.Hint_Inbox{Inbox: &linkpb.InboxHint{SessionId: "session-nobody-fetches"}}})
	r.g.mu.Lock()
	r.g.ackHints = &linkpb.HintState{Approvals: []*linkpb.ApprovalHint{{SessionId: "session-a", ApprovalId: unknownApproval}},
		InboxSessionIds: []string{"session-nobody-fetches"}}
	r.g.mu.Unlock()
	if _, err := r.t.heartbeat(HeartbeatRequest{Status: "ONLINE", LeaseOwner: r.t.leaseOwner}); err != nil {
		t.Fatal(err)
	}
	if a, i := gates(); a != 0 || i != 0 {
		t.Fatalf("hints for what nobody waits on made %d approval and %d inbox gates", a, i)
	}

	// A card read while pending, decided, hinted, and read again: its gate goes with the decision.
	if dec, err := r.t.pollApproval(context.Background(), "session-a", "ap-1"); err != nil || dec.Status != "PENDING" {
		t.Fatalf("first read: %+v %v", dec, err)
	}
	decided.Store(true)
	hint(&linkpb.Hint{Kind: &linkpb.Hint_Approval{Approval: &linkpb.ApprovalHint{SessionId: "session-a", ApprovalId: "ap-1"}}})
	began := time.Now()
	if dec, err := r.t.pollApproval(context.Background(), "session-a", "ap-1"); err != nil || dec.Status != "ALLOWED" {
		t.Fatalf("read after the hint: %+v %v", dec, err)
	}
	if took := time.Since(began); took > time.Second {
		t.Errorf("the hinted read took %s: the hint did not reach the waiting gate", took)
	}
	// HintState keeps naming a decided card until its tool call returns.
	r.g.mu.Lock()
	r.g.ackHints = &linkpb.HintState{Approvals: []*linkpb.ApprovalHint{{SessionId: "session-a", ApprovalId: "ap-1"}}}
	r.g.mu.Unlock()
	if _, err := r.t.heartbeat(HeartbeatRequest{Status: "ONLINE", LeaseOwner: r.t.leaseOwner}); err != nil {
		t.Fatal(err)
	}
	if a, _ := gates(); a != 0 {
		t.Errorf("%d approval gates left after the decided card was read", a)
	}
}

// The work connection dials through the proxy HTTPS_PROXY names, over TLS: what doctor reports is what the work uses.
func TestLinkWorkConnectsThroughTheProxyOverTLS(t *testing.T) {
	r := newLinkWorkRig(t)
	proxy := newFakeLinkProxy(t)
	host := strings.TrimPrefix(r.g.URL, "https://")
	r.trust(r.g.roots(), proxy.proxyFor(host))
	r.useLink(t)
	if _, err := r.t.me(); err != nil {
		t.Fatal(err)
	}
	if got := proxy.connected(); len(got) != 1 || got[0] != host {
		t.Errorf("the proxy tunnelled %v, want %s", got, host)
	}
	if conns := r.g.welcomed(); len(conns) != 1 || conns[0].hello.GetProcessId() == "" {
		t.Errorf("connections through the proxy: %d", len(conns))
	}
}

// A refused upgrade is tried again no sooner than its Retry-After, and the backoff between failed attempts is drawn at
// random, so the runners a gateway lost together do not come back together.
func TestLinkWorkReconnectsNoSoonerThanItIsTold(t *testing.T) {
	r := newLinkWorkRig(t)
	var refusals atomic.Int64
	r.g.refuse = func(*http.Request) (int, string, string) {
		if refusals.Add(1) <= 2 {
			return http.StatusServiceUnavailable, `{"code":"DRAINING","message":"draining","retryAfterMs":1000}`, "1"
		}
		return 0, "", ""
	}
	r.m.observe(linkpb.Mode_MODE_LINK, "the test")
	r.g.waitWelcomed(t, 1)
	r.g.mu.Lock()
	upgrades := append([]time.Time{}, r.g.upgrades...)
	r.g.mu.Unlock()
	if len(upgrades) != 3 {
		t.Fatalf("%d upgrades", len(upgrades))
	}
	for i := 1; i < len(upgrades); i++ {
		if gap := upgrades[i].Sub(upgrades[i-1]); gap < time.Second {
			t.Errorf("attempt %d came %s after a refusal saying Retry-After: 1", i+1, gap)
		}
	}
	waits := map[time.Duration]bool{}
	for i := 0; i < 20; i++ {
		waits[linkBackoff(3)] = true
	}
	if len(waits) < 10 {
		t.Errorf("20 backoffs drew %d distinct waits: not jittered", len(waits))
	}
}

// A Redirect closes the connection and opens the next at the address it names, with a token fetched first when it
// brought none.
func TestLinkFollowsARedirect(t *testing.T) {
	r := newLinkWorkRig(t)
	other := newFakeWorkGateway(t)
	pool := r.g.roots()
	pool.AddCert(other.Certificate())
	r.trust(pool, nil)
	first := r.useLink(t)
	first.send(&linkpb.Frame{Body: &linkpb.Frame_Redirect{Redirect: &linkpb.Redirect{Url: other.linkURL()}}})
	moved := other.waitWelcomed(t, 1)
	if !strings.EqualFold(moved.hello.GetProcessId(), r.t.leaseOwner) {
		t.Errorf("the redirected connection is process %s", moved.hello.GetProcessId())
	}
	linkWaitFor(t, 5*time.Second, "calls to go out on the redirected connection", func() bool {
		cur := r.m.work.current()
		return cur != nil && cur.id == moved.id
	})
	if _, err := r.t.me(); err != nil {
		t.Fatal(err)
	}
	if n := len(other.rpcsTo("/runner/me")); n != 1 {
		t.Errorf("the redirected cell took %d calls", n)
	}
	if n := len(r.cp.requests("/api/runner/link-token")); n != 2 {
		t.Errorf("%d link tokens: a Redirect without one fetches a fresh one", n)
	}
}

// The Welcome's assigned release feeds the self-update: the next heartbeat's answer asks for a release check, which
// installs the release the link holds (TestReleaseCheckInstallsWhatTheLinkAssigns). A HeartbeatAck stating the same
// assignment asks nothing more, and one stating none hands the question back to GET /api/runner/release.
func TestLinkAssignedReleaseFeedsTheSelfUpdate(t *testing.T) {
	t.Cleanup(func() { setLinkAssignedRelease(nil) })
	r := newLinkWorkRig(t)
	assigned := &linkpb.AssignedRelease{Version: "999.0.0"}
	r.g.welcome = func(c *fakeWorkConn, w *linkpb.Welcome) { w.Release = assigned }
	r.g.ackRelease = assigned
	r.useLink(t)
	resp, err := r.t.heartbeat(HeartbeatRequest{Status: "ONLINE", LeaseOwner: r.t.leaseOwner})
	if err != nil {
		t.Fatal(err)
	}
	if !resp.CheckSelfUpdate {
		t.Fatal("the beat after a Welcome assigning a newer release did not ask for a release check")
	}
	resp, err = r.t.heartbeat(HeartbeatRequest{Status: "ONLINE", LeaseOwner: r.t.leaseOwner})
	if err != nil || resp.CheckSelfUpdate {
		t.Fatalf("asked again for the same assignment: %+v %v", resp, err)
	}
	if a := linkAssignedRelease.Load(); a == nil || a.Version != "999.0.0" || a.Rollback {
		t.Fatalf("the assignment held is %+v", a)
	}
	r.g.mu.Lock()
	r.g.ackRelease = nil
	r.g.mu.Unlock()
	if _, err := r.t.heartbeat(HeartbeatRequest{Status: "ONLINE", LeaseOwner: r.t.leaseOwner}); err != nil {
		t.Fatal(err)
	}
	if a := linkAssignedRelease.Load(); a != nil {
		t.Errorf("a HeartbeatAck assigning nothing left %+v assigned", a)
	}
}
