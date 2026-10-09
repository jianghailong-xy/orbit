package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// 2026-10-09: the control plane timed out against the canary runner five times in a day, and each time a
// repository operation that had already been run went unreported — five sends, then the result was
// dropped and the maintenance job ran the operation again. A 5xx or a timeout is the control plane saying
// nothing about the result, so the send must go on as long as an answer could still be used.

// wikiRepoOpTestClock is the clock a test drives the retry policy with: sleep advances it instead of
// waiting, so a test that spends the policy's whole window runs in microseconds and its arithmetic is
// exact rather than timed.
type wikiRepoOpTestClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *wikiRepoOpTestClock) time() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *wikiRepoOpTestClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

// fastWikiRepoOpRetry gives the policy a window a test can spend: waits of 5ms doubling to 40ms, a send
// taken to take up to 50ms, and one second of window — the shape the production policy has (2s doubling
// to 30s inside 900s), small enough to run.
func fastWikiRepoOpRetry(t *testing.T) *wikiRepoOpTestClock {
	t.Helper()
	clock := &wikiRepoOpTestClock{now: time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)}
	restore := wikiRepoOpRetry
	t.Cleanup(func() { wikiRepoOpRetry = restore })
	wikiRepoOpRetry.first = 5 * time.Millisecond
	wikiRepoOpRetry.max = 40 * time.Millisecond
	wikiRepoOpRetry.window = time.Second
	wikiRepoOpRetry.guard = 0
	wikiRepoOpRetry.send = 50 * time.Millisecond
	wikiRepoOpRetry.now = clock.time
	wikiRepoOpRetry.jitter = func(d time.Duration) time.Duration { return d }
	wikiRepoOpRetry.sleep = func(_ context.Context, d time.Duration) { clock.advance(d) }
	return clock
}

// captureLogs runs fn with logln's output collected, which is stdout.
func captureLogs(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	orig := os.Stdout
	os.Stdout = w
	collected := make(chan string, 1)
	go func() {
		data, _ := io.ReadAll(r)
		collected <- string(data)
	}()
	defer func() { os.Stdout = orig }()
	fn()
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	os.Stdout = orig
	out := <-collected
	r.Close()
	return out
}

// wikiRepoOpResultBody is a result of the shape one operation reports: what these tests care about is the
// fence it carries (generation, lease owner) and that it is the body sent.
func wikiRepoOpResultBody() WikiRepoOpResultRequest {
	return WikiRepoOpResultRequest{
		ClaimGeneration: 4,
		LeaseOwner:      "owner-1",
		State:           "succeeded",
		Result:          map[string]interface{}{"sha": strings.Repeat("a", 40), "skipped": true},
	}
}

func wikiRepoOpTestCommand() WikiRepoOpCommand {
	return WikiRepoOpCommand{
		ID: "op-9", Kind: "snapshot", ClaimGeneration: 4, LeaseOwner: "owner-1", WorkDir: "~/orbit",
	}
}

// A 5xx is the control plane saying it is unwell, not a verdict on the result. Three 500s must not end the
// report the way they did on 2026-10-09: the fourth send lands, and what lands is the operation's own
// result, fence and all.
func TestWikiRepoOpResultIsSentAgainThroughAServerFault(t *testing.T) {
	clock := fastWikiRepoOpRetry(t)
	var sends atomic.Int32
	var got WikiRepoOpResultRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/wiki/repo-ops/op-9/result") {
			t.Errorf("the result was sent to %s", r.URL.Path)
		}
		if sends.Add(1) <= 3 {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"statusCode":500,"message":"timeout"}`))
			return
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("decode result: %v", err)
		}
		_, _ = w.Write([]byte(`{"accepted":true,"state":"succeeded"}`))
	}))
	t.Cleanup(srv.Close)

	body := wikiRepoOpResultBody()
	logs := captureLogs(t, func() {
		reportWikiRepoOpResult(context.Background(), NewTransport(srv.URL, "tok"), wikiRepoOpTestCommand(),
			body, wikiRepoOpRetry.deadline(clock.time()))
	})

	if n := sends.Load(); n != 4 {
		t.Fatalf("the control plane was told %d times, want the three 500s and the send that landed", n)
	}
	if got.ClaimGeneration != 4 || got.LeaseOwner != "owner-1" || got.State != "succeeded" {
		t.Fatalf("the send that landed carried %#v, want the operation's own result and fence", got)
	}
	for _, want := range []string{
		"result not delivered on attempt 1:", "sending it again in",
		"result not delivered on attempt 2:", "result not delivered on attempt 3:",
		"reported succeeded accepted=true",
	} {
		if !strings.Contains(logs, want) {
			t.Fatalf("the log does not say %q; every retry and the ending have to be readable there:\n%s", want, logs)
		}
	}
}

// The whole report, as the heartbeat's goroutine runs it: an operation that failed for this machine's own
// reason — a checkout that is not there — still has to be told to the control plane through a fault, and
// what arrives is the failure and the reason, not silence.
func TestWikiRepoOpAndReportSendsAFailureThroughAServerFault(t *testing.T) {
	fastWikiRepoOpRetry(t)
	var sends atomic.Int32
	var got WikiRepoOpResultRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/wiki/repo-ops/op-9/result") {
			t.Errorf("the result was sent to %s", r.URL.Path)
		}
		if sends.Add(1) <= 2 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("decode result: %v", err)
		}
		_, _ = w.Write([]byte(`{"accepted":true,"state":"failed"}`))
	}))
	t.Cleanup(srv.Close)

	cmd := wikiRepoOpTestCommand()
	cmd.WorkDir = "" // no checkout to read: the operation fails and says so
	logs := captureLogs(t, func() {
		runWikiRepoOpAndReport(context.Background(), NewTransport(srv.URL, "tok"), cmd)
	})
	t.Log(logs)

	if n := sends.Load(); n != 3 {
		t.Fatalf("the control plane was told %d times, want the two 500s and the send that landed", n)
	}
	if got.State != "failed" || !strings.Contains(got.Error, "no working directory") {
		t.Fatalf("the send that landed carried %#v, want the operation's failure and its reason", got)
	}
	if !strings.Contains(logs, "reported failed accepted=true") {
		t.Fatalf("the log does not say how the report ended:\n%s", logs)
	}
}

// An answer that settles the matter ends the report after one send: 409 STALE_CLAIM is a claim that moved
// on (the operation is not this process's any more), and 404, 400 INVALID_RESULT and 422 UNSTORABLE_RESULT
// each say the operation is gone or has been failed with why. Sending the same bytes again cannot change
// any of them.
func TestWikiRepoOpResultStopsOnAnAnswerThatSettlesIt(t *testing.T) {
	for _, refused := range []struct {
		status int
		body   string
	}{
		{http.StatusConflict, `{"code":"STALE_CLAIM","message":"this operation's claim has moved on"}`},
		{http.StatusNotFound, `{"code":"NOT_FOUND","message":"no such operation"}`},
		{http.StatusBadRequest, `{"code":"INVALID_RESULT","message":"a failed operation has to say why"}`},
		{http.StatusUnprocessableEntity, `{"code":"UNSTORABLE_RESULT","message":"a NUL the database will not store"}`},
	} {
		t.Run(http.StatusText(refused.status), func(t *testing.T) {
			clock := fastWikiRepoOpRetry(t)
			var sends atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				sends.Add(1)
				w.WriteHeader(refused.status)
				_, _ = w.Write([]byte(refused.body))
			}))
			t.Cleanup(srv.Close)

			logs := captureLogs(t, func() {
				reportWikiRepoOpResult(context.Background(), NewTransport(srv.URL, "tok"), wikiRepoOpTestCommand(),
					wikiRepoOpResultBody(), wikiRepoOpRetry.deadline(clock.time()))
			})

			if n := sends.Load(); n != 1 {
				t.Fatalf("the control plane was told %d times, want one: %d is an answer, not a fault", n, refused.status)
			}
			if !strings.Contains(logs, "result refused, so it will not be sent again:") {
				t.Fatalf("the log does not say the report ended on the answer:\n%s", logs)
			}
		})
	}
}

// A control plane that never answers takes the report as far as the window allows and no further: the
// sends stop when the next one could no longer be answered while the operation is still this process's to
// report. Nothing is spooled — a late result reaches nobody — so there is an end to it.
func TestWikiRepoOpResultGivesUpWhenItsWindowIsSpent(t *testing.T) {
	clock := fastWikiRepoOpRetry(t)
	start := clock.time()
	deadline := wikiRepoOpRetry.deadline(start)
	var sends atomic.Int32
	var lastSendAt atomic.Int64
	var sentAfterDeadline atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		sends.Add(1)
		at := clock.time()
		lastSendAt.Store(at.UnixNano())
		if at.After(deadline) {
			sentAfterDeadline.Add(1)
		}
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(`{"statusCode":502,"message":"Bad Gateway"}`))
	}))
	t.Cleanup(srv.Close)

	logs := captureLogs(t, func() {
		reportWikiRepoOpResult(context.Background(), NewTransport(srv.URL, "tok"), wikiRepoOpTestCommand(),
			wikiRepoOpResultBody(), deadline)
	})

	n := sends.Load()
	if n < 3 {
		t.Fatalf("the report made %d sends; a fault is sent again until the window is spent", n)
	}
	if n > 40 {
		t.Fatalf("the report made %d sends inside one window, which is not a capped wait", n)
	}
	if sentAfterDeadline.Load() != 0 {
		t.Fatal("a send went out after the window the result is worth sending inside")
	}
	if elapsed := clock.time().Sub(start); elapsed > wikiRepoOpRetry.window {
		t.Fatalf("the report ran %s of a %s window", elapsed, wikiRepoOpRetry.window)
	}
	if last := time.Unix(0, lastSendAt.Load()); last.Add(wikiRepoOpRetry.send).After(deadline) {
		t.Fatalf("the last send at %s could not be answered inside the window (deadline %s)", last, deadline)
	}
	if !strings.Contains(logs, "and the window a result is worth sending inside is spent, so it will not be sent again") {
		t.Fatalf("the log does not say why the report ended:\n%s", logs)
	}
}

// A runner that is stopping abandons the send it is in: nothing is spooled for the next process, so there
// is nothing to wait for, and the drain must not be held by a control plane that is down.
func TestAStoppingRunnerStopsReportingAWikiRepoOp(t *testing.T) {
	fastWikiRepoOpRetry(t)
	var sends atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		sends.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)

	ctx, stop := context.WithCancel(context.Background())
	stop()
	done := make(chan struct{})
	go func() {
		defer close(done)
		reportWikiRepoOpResult(ctx, NewTransport(srv.URL, "tok"), wikiRepoOpTestCommand(),
			wikiRepoOpResultBody(), time.Now().Add(time.Hour))
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the report kept running after the runner was told to stop")
	}
}

// A snapshot too large for one request body travels in fragments, and each is a piece the route stages by
// its ordinal: a fragment the control plane could not take is sent again — the same piece — rather than
// giving up the payload after three tries.
func TestWikiRepoOpFragmentsAreSentAgainThroughAServerFault(t *testing.T) {
	clock := fastWikiRepoOpRetry(t)
	var first atomic.Int32
	var mu sync.Mutex
	var got []WikiRepoOpFragmentRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/wiki/repo-ops/op-9/fragments") {
			t.Errorf("a fragment was sent to %s", r.URL.Path)
		}
		var body WikiRepoOpFragmentRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode fragment: %v", err)
		}
		if body.Index == 0 && first.Add(1) <= 2 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		mu.Lock()
		got = append(got, body)
		mu.Unlock()
		_, _ = w.Write([]byte(`{"accepted":true,"received":1}`))
	}))
	t.Cleanup(srv.Close)

	fragments := []string{`{"a":1}`, `{"b":2}`}
	logs := captureLogs(t, func() {
		if err := uploadWikiRepoOpFragments(context.Background(), NewTransport(srv.URL, "tok"),
			wikiRepoOpTestCommand(), strings.Repeat("c", 40), fragments, wikiRepoOpRetry.deadline(clock.time())); err != nil {
			t.Errorf("the upload failed: %v", err)
		}
	})

	mu.Lock()
	defer mu.Unlock()
	if len(got) != 2 {
		t.Fatalf("%d fragments were staged, want both", len(got))
	}
	for index, body := range got {
		if body.Index != index || body.Total != 2 || body.Content != fragments[index] {
			t.Fatalf("fragment %d was staged as %#v, want its own ordinal, count and text", index, body)
		}
		if body.ClaimGeneration != 4 || body.LeaseOwner != "owner-1" {
			t.Fatalf("fragment %d was staged under %#v, want the operation's claim", index, body)
		}
	}
	if !strings.Contains(logs, "fragment 1/2 not staged on attempt 1:") {
		t.Fatalf("the log does not say the fragment is being sent again:\n%s", logs)
	}
}

// A fragment the control plane answers for good about ends the upload: the operation is not this
// process's to report any more (409 STALE_CLAIM here — the claim moved on), and the pieces behind it
// belong to nobody.
func TestWikiRepoOpFragmentsStopOnAnAnswerThatSettlesIt(t *testing.T) {
	clock := fastWikiRepoOpRetry(t)
	var sends atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body WikiRepoOpFragmentRequest
		_ = json.NewDecoder(r.Body).Decode(&body)
		sends.Add(1)
		if body.Index == 1 {
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"code":"STALE_CLAIM","message":"this operation's claim has moved on"}`))
			return
		}
		_, _ = w.Write([]byte(`{"accepted":true,"received":1}`))
	}))
	t.Cleanup(srv.Close)

	err := uploadWikiRepoOpFragments(context.Background(), NewTransport(srv.URL, "tok"), wikiRepoOpTestCommand(),
		strings.Repeat("c", 40), []string{`{"a":1}`, `{"b":2}`, `{"c":3}`}, wikiRepoOpRetry.deadline(clock.time()))

	if err == nil {
		t.Fatal("a fragment refused for good has to end the upload")
	}
	if !strings.Contains(err.Error(), "STALE_CLAIM") {
		t.Fatalf("the upload failed with %v, want the control plane's own refusal", err)
	}
	if n := sends.Load(); n != 2 {
		t.Fatalf("%d fragments were sent, want the two up to the refusal", n)
	}
}
