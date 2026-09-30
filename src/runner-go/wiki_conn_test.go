//go:build go1.24

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// The wiki calls' connections (wiki_conn.go), against a door over TLS and HTTP/2 whose connections go silent
// the way the one between the command and the edge did on 09-29: from one moment on, nothing comes back on
// it — no answer, no answer to a ping, no reset, no close — and what the client sends down it is lost. The
// health check, the timeouts and the backoff all run on the real clock, shortened. The health check is
// go1.24's (wiki_conn_go124.go), and so are these tests.

// ── The door ────────────────────────────────────────────────────────────────────────────────────

// silentDoor is a door over TLS and HTTP/2 — its TLS offers h2 alone — that answers every call it reaches,
// except that a call silences the connection it came on when hush says so: that call is never answered, and
// the connection says nothing again.
type silentDoor struct {
	*httptest.Server
	// hush is whether the call-th call on the conn-th connection (both counted from 1) silences it.
	hush  func(conn, call int) bool
	mu    sync.Mutex
	conns []*silentConn
	calls []silentCall
}

// silentCall is a call that reached the door: its path, the connection it came on, and whether it was answered.
type silentCall struct {
	path     string
	conn     int
	answered bool
}

func newSilentDoor(t *testing.T, hush func(conn, call int) bool) *silentDoor {
	t.Helper()
	d := &silentDoor{hush: hush}
	d.Server = httptest.NewUnstartedServer(http.HandlerFunc(d.serve))
	d.EnableHTTP2 = true
	d.Listener = &silentListener{Listener: d.Listener, door: d}
	d.StartTLS()
	t.Cleanup(func() {
		// The connections go first: Close waits for a call that is never answered until its connection is gone.
		d.mu.Lock()
		conns := append([]*silentConn{}, d.conns...)
		d.mu.Unlock()
		for _, c := range conns {
			_ = c.Close()
		}
		d.Close()
	})
	return d
}

// transport is a Transport whose calls go to the door, trusting its certificate.
func (d *silentDoor) transport() *Transport {
	return &Transport{baseURL: d.URL, client: d.Client()}
}

func (d *silentDoor) serve(w http.ResponseWriter, r *http.Request) {
	d.mu.Lock()
	var c *silentConn
	for _, conn := range d.conns {
		if conn.RemoteAddr().String() == r.RemoteAddr {
			c = conn
		}
	}
	c.calls++
	hush := d.hush(c.n, c.calls)
	d.calls = append(d.calls, silentCall{path: strings.TrimPrefix(r.URL.Path, "/api/runner/wiki/spaces/space-1/"), conn: c.n, answered: !hush})
	d.mu.Unlock()
	if hush {
		c.silence()
		<-c.gone
		return
	}
	_, _ = io.Copy(io.Discard, r.Body)
	w.Header().Set("content-type", "application/json")
	_, _ = w.Write([]byte(`{"spaceId":"space-1"}`))
}

// reached is every call that reached the door, in the order it did.
func (d *silentDoor) reached() []silentCall {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]silentCall{}, d.calls...)
}

// conn is the door's nth connection (from 1).
func (d *silentDoor) conn(n int) *silentConn {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.conns[n-1]
}

// silentListener numbers the door's connections as it takes them, under TLS.
type silentListener struct {
	net.Listener
	door *silentDoor
}

func (l *silentListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	l.door.mu.Lock()
	defer l.door.mu.Unlock()
	c := &silentConn{Conn: conn, n: len(l.door.conns) + 1, hushed: make(chan struct{}), gone: make(chan struct{}), left: make(chan struct{})}
	l.door.conns = append(l.door.conns, c)
	return c, nil
}

// silentConn is one of the door's connections. Silenced, it takes what the client sends and drops it, and
// what the door writes is lost on the way: the client hears nothing more on it, until it closes it itself.
type silentConn struct {
	net.Conn
	n     int // which of the door's connections it is
	calls int // the calls that reached the door on it, under the door's mu

	hush, close, leave sync.Once
	hushed, gone, left chan struct{}
	hushedAt, leftAt   time.Time
}

func (c *silentConn) silence() {
	c.hush.Do(func() {
		c.hushedAt = time.Now()
		close(c.hushed)
	})
}

func (c *silentConn) silent() bool {
	select {
	case <-c.hushed:
		return true
	default:
		return false
	}
}

func (c *silentConn) Read(p []byte) (int, error) {
	for {
		n, err := c.Conn.Read(p)
		if !c.silent() {
			return n, err
		}
		if err != nil {
			select {
			case <-c.gone: // the door closed it
			default:
				c.leave.Do(func() {
					c.leftAt = time.Now()
					close(c.left)
				})
			}
			return 0, err
		}
	}
}

func (c *silentConn) Write(p []byte) (int, error) {
	if c.silent() {
		return len(p), nil
	}
	return c.Conn.Write(p)
}

func (c *silentConn) Close() error {
	c.close.Do(func() { close(c.gone) })
	return c.Conn.Close()
}

// closedByClient is how long after it went silent the client closed the connection, and false while it has not.
func (c *silentConn) closedByClient(within time.Duration) (time.Duration, bool) {
	select {
	case <-c.left:
		return c.leftAt.Sub(c.hushedAt), true
	case <-time.After(within):
		return 0, false
	}
}

// ── The clock ───────────────────────────────────────────────────────────────────────────────────

// withWikiConnHealth shortens the health check: a ping after sendPing without a frame, and the connection
// closed when the ping has had no answer for ping.
func withWikiConnHealth(t *testing.T, sendPing, ping time.Duration) {
	t.Helper()
	previous := wikiConnHealth
	wikiConnHealth.sendPing, wikiConnHealth.ping = sendPing, ping
	t.Cleanup(func() { wikiConnHealth = previous })
}

// withRealClockWikiRetry is the backoff from first, doubling to max, over budget, without jitter — on the real
// clock, which the health check and the timeouts it waits for run on too. What it returns reads the lines.
func withRealClockWikiRetry(t *testing.T, first, max, budget time.Duration) *fakeWikiRetry {
	t.Helper()
	lines := &fakeWikiRetry{}
	previous := wikiRetry
	wikiRetry = wikiRetryPolicy{first: first, max: max, budget: budget, now: time.Now, sleep: time.Sleep,
		jitter: func(d time.Duration) time.Duration { return d }, log: lines}
	t.Cleanup(func() { wikiRetry = previous })
	return lines
}

// wikiConnSlack is what a loaded machine may add to a bound: handshakes, goroutines waiting to be run.
const wikiConnSlack = 3 * time.Second

// ── A connection that went silent ───────────────────────────────────────────────────────────────

// 09-29 at 15:23Z: the run's connection to the edge went silent under an article's write, after carrying the
// calls before it. The health check finds it dead a ping's wait and the ping's own after it last said
// anything — nowhere near the write's 2-minute timeout — and closes it; the write goes again, on a new
// connection, and is answered.
func TestWikiConnHealthFindsASilentConnectionAndSendsAgainOnANewOne(t *testing.T) {
	sendPing, ping, first := time.Second, 500*time.Millisecond, 100*time.Millisecond
	withWikiConnHealth(t, sendPing, ping)
	lines := withRealClockWikiRetry(t, first, time.Second, time.Minute)
	door := newSilentDoor(t, func(conn, call int) bool { return conn == 1 && call >= 2 })
	tr := door.transport()

	if _, err := tr.wikiArticleInput("maintenance-session", "space-1", "web-client"); err != nil {
		t.Fatalf("the call before: %v", err)
	}
	began := time.Now()
	_, err := tr.writeWikiArticles("maintenance-session", "space-1", "agent-tooling", map[string]interface{}{"entrySetSha256": "sha"})
	took := time.Since(began)
	if err != nil {
		t.Fatalf("the write on a connection that went silent = %v after %s\n%s", err, took, strings.Join(lines.lines(), "\n"))
	}
	if limit := sendPing + ping + first + wikiConnSlack; took > limit {
		t.Errorf("the write was answered after %s: want it within the health check's time, %s", took, limit)
	}

	want := []silentCall{{"articles/web-client/input", 1, true}, {"articles/agent-tooling", 1, false}, {"articles/agent-tooling", 2, true}}
	if got := door.reached(); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("the door was reached by %v: want %v — the write again, on a new connection", got, want)
	}
	// Found out and closed by the client itself, a health check's time after it went silent.
	if after, closed := door.conn(1).closedByClient(wikiConnSlack); !closed || after > sendPing+ping+wikiConnSlack {
		t.Errorf("the silent connection was closed by the client %v after it went silent (closed: %v)", after, closed)
	}
	if got := lines.lines(); len(got) != 1 ||
		!strings.Contains(got[0], "orbit wiki: POST /runner/wiki/spaces/space-1/articles/agent-tooling failed (http2: client connection lost); retry 1 in 100ms") {
		t.Errorf("the retries said %q: want one, for the connection the health check found lost", got)
	}
}

// A call whose own timeout is shorter than the health check — the door's light calls wait 20 seconds, the
// check takes up to 45 — times out on the silent connection first. That connection is still in the pool
// then, taking new calls, and not idle while another call waits on it: the retry goes out on a new one all
// the same, and so does the other call's when its own, longer timeout comes.
func TestWikiConnHealthSendsATimedOutCallAgainOnANewConnection(t *testing.T) {
	// The health check as it ships, which cannot find the connection out within this test.
	short, long := 500*time.Millisecond, 3*time.Second
	lines := withRealClockWikiRetry(t, 100*time.Millisecond, time.Second, 10*time.Second)
	door := newSilentDoor(t, func(conn, call int) bool { return conn == 1 && call >= 2 })
	tr := door.transport()
	run, input := "/runner/wiki/spaces/space-1/maintenance/run", "/runner/wiki/spaces/space-1/articles/web-client/input"
	get := func(path string, timeout time.Duration) (int, time.Duration, error) {
		var out json.RawMessage
		began := time.Now()
		sends, err := tr.doWiki(http.MethodGet, path, nil, &out, timeout, nil, true)
		return sends, time.Since(began), err
	}

	if _, _, err := get(run, short); err != nil {
		t.Fatalf("the call before: %v", err)
	}
	// The long call goes first, and the connection goes silent under it.
	longDone := make(chan error, 1)
	go func() {
		sends, _, err := get(input, long)
		if err == nil && sends != 2 {
			err = fmt.Errorf("answered after %d sends, want 2", sends)
		}
		longDone <- err
	}()
	for deadline := time.Now().Add(wikiConnSlack); len(door.reached()) < 2; time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("the long call never reached the door: %v", door.reached())
		}
	}
	sends, took, err := get(run, short)
	if err != nil || sends != 2 || took >= long {
		t.Fatalf("a call that timed out on the silent connection = %v after %d sends and %s: want it answered on a new "+
			"connection before the other call's %s timeout\n%s", err, sends, took, long, strings.Join(lines.lines(), "\n"))
	}
	if err := <-longDone; err != nil {
		t.Fatalf("the call that silenced the connection: %v\n%s", err, strings.Join(lines.lines(), "\n"))
	}
	want := []silentCall{{"maintenance/run", 1, true}, {"articles/web-client/input", 1, false}, {"maintenance/run", 2, true},
		{"articles/web-client/input", 2, true}}
	if got := door.reached(); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("the door was reached by %v: want %v — each retry on the new connection", got, want)
	}
	if got := lines.lines(); len(got) != 2 ||
		!strings.Contains(got[0], "orbit wiki: GET "+run+" failed (context deadline exceeded); retry 1 in 100ms") ||
		!strings.Contains(got[1], "orbit wiki: GET "+input+" failed (context deadline exceeded); retry 1 in 100ms") {
		t.Errorf("the retries said %q", got)
	}
}

// 09-29 at 15:23Z again, all of it: the articles stage's calls in flight at once, on the one connection, which
// goes silent under them — the run lost every one of them to its timeout. Each is found out with the
// connection, and answered on a new one a health check's time later.
func TestWikiConnHealthCarriesABatchOfCallsOffADeadConnection(t *testing.T) {
	sendPing, ping, first := time.Second, 500*time.Millisecond, 100*time.Millisecond
	withWikiConnHealth(t, sendPing, ping)
	lines := withRealClockWikiRetry(t, first, time.Second, time.Minute)
	door := newSilentDoor(t, func(conn, call int) bool { return conn == 1 && call >= 2 })
	tr := door.transport()

	if _, err := tr.planWikiArticles("maintenance-session", "space-1"); err != nil {
		t.Fatalf("the stage's first call: %v", err)
	}
	article := map[string]interface{}{"entrySetSha256": "sha"}
	batch := map[string]func() error{
		"POST articles/agent-tooling": func() error {
			_, err := tr.writeWikiArticles("maintenance-session", "space-1", "agent-tooling", article)
			return err
		},
		"GET articles/web-client/input": func() error {
			_, err := tr.wikiArticleInput("maintenance-session", "space-1", "web-client")
			return err
		},
		"GET articles/apple-clients/input": func() error {
			_, err := tr.wikiArticleInput("maintenance-session", "space-1", "apple-clients")
			return err
		},
		"POST articles/ui-design": func() error {
			_, err := tr.writeWikiArticles("maintenance-session", "space-1", "ui-design", article)
			return err
		},
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	failed := map[string]error{}
	began := time.Now()
	for name, call := range batch {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := call(); err != nil {
				mu.Lock()
				failed[name] = err
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	took := time.Since(began)
	if len(failed) != 0 {
		t.Fatalf("calls of the batch failed: %v\n%s", failed, strings.Join(lines.lines(), "\n"))
	}
	if limit := sendPing + ping + first + wikiConnSlack; took > limit {
		t.Errorf("the batch was answered after %s: want it within the health check's time, %s", took, limit)
	}
	answered := map[string]bool{}
	for _, call := range door.reached() {
		switch {
		case call.path == "article-plan":
			if !call.answered || call.conn != 1 {
				t.Errorf("the plan = %+v: want it answered on the first connection", call)
			}
		case call.answered && call.conn == 1:
			t.Errorf("%s was answered on the connection that went silent", call.path)
		case call.answered:
			answered[call.path] = true
		}
	}
	if len(answered) != len(batch) {
		t.Errorf("answered on a new connection: %v; want all %d of the batch", answered, len(batch))
	}
	if got := lines.lines(); len(got) != len(batch) {
		t.Errorf("the retries said %q: want one for each call of the batch", got)
	}
	for _, line := range lines.lines() {
		if !strings.Contains(line, " failed (http2: client connection lost); retry 1 in 100ms") {
			t.Errorf("retry line %q: want the connection the health check found lost, sent again after the first wait", line)
		}
	}
}

// ── The budget ──────────────────────────────────────────────────────────────────────────────────

// A silence that does not clear: every connection goes silent under the first call it carries. Each send goes
// out on a new connection and is found out there, and the call gives up inside its budget — a send never
// waits past the budget's end — with the last send's own failure, as the transport returned it.
func TestWikiConnHealthGivesUpOnceTheBudgetIsSpentWithTheOriginalError(t *testing.T) {
	budget, max := 4*time.Second, 400*time.Millisecond
	withWikiConnHealth(t, 400*time.Millisecond, 200*time.Millisecond)
	lines := withRealClockWikiRetry(t, 100*time.Millisecond, max, budget)
	door := newSilentDoor(t, func(int, int) bool { return true })
	tr := door.transport()

	path := "/runner/wiki/spaces/space-1/articles/agent-tooling"
	began := time.Now()
	_, err := tr.writeWikiArticles("maintenance-session", "space-1", "agent-tooling", map[string]interface{}{"entrySetSha256": "sha"})
	took := time.Since(began)

	// The transport's own error, not one of this code's: what a caller did with it before, it still does.
	var urlErr *url.Error
	var answer *transportHTTPError
	if !errors.As(err, &urlErr) || errors.As(err, &answer) || !strings.HasPrefix(err.Error(), `Post "`+door.URL+"/api"+path+`": `) {
		t.Fatalf("after the budget = %#v, want the transport's own failure", err)
	}
	if _, _, transient := wikiTransient(err, http.MethodPost, path, time.Now()); !transient {
		t.Errorf("after the budget = %v: want a failure on the way, the kind that is sent again", err)
	}
	// Given up within the budget: after it, never before the last wait could no longer fit in it.
	if took > budget+wikiConnSlack/2 || took < budget-max {
		t.Errorf("gave up after %s: want it within the %s budget, and not before %s", took, budget, budget-max)
	}

	got := lines.lines()
	sends := len(got)
	last := fmt.Sprintf("orbit wiki: POST %s failed (%s) on send %d; the %s retry budget is spent, so the failure stands",
		path, wikiRetryCause(err, http.MethodPost, path), sends, budget)
	if sends < 3 || got[sends-1] != last {
		t.Fatalf("the retries said:\n%s\nwant several, then %q", strings.Join(got, "\n"), last)
	}
	for i, line := range got[:sends-1] {
		if !strings.Contains(line, fmt.Sprintf("; retry %d in ", i+1)) {
			t.Errorf("retry line %d = %q", i+1, line)
		}
	}
	// Every send on a new connection: each connection the door took carried one call at most, and every send
	// but the last — which the budget may have cut short before it arrived — reached the door.
	reached := door.reached()
	for i, call := range reached {
		if call.conn != i+1 || call.answered {
			t.Errorf("call %d reached the door as %+v: want it on connection %d, unanswered", i+1, call, i+1)
		}
	}
	if len(reached) != sends && len(reached) != sends-1 {
		t.Errorf("%d calls reached the door over %d sends", len(reached), sends)
	}

	// With the health check as it ships, a silent connection holds a send until the budget's end — not until the
	// write's own 2-minute timeout — and the call gives up then, with the send's own timeout.
	withWikiConnHealth(t, 30*time.Second, 15*time.Second)
	budget = 2 * time.Second
	lines = withRealClockWikiRetry(t, 100*time.Millisecond, max, budget)
	door = newSilentDoor(t, func(int, int) bool { return true })
	began = time.Now()
	_, err = door.transport().writeWikiArticles("maintenance-session", "space-1", "agent-tooling", map[string]interface{}{"entrySetSha256": "sha"})
	took = time.Since(began)
	if !errors.Is(err, context.DeadlineExceeded) || took > budget+wikiConnSlack {
		t.Errorf("a send on a silent connection = %v after %s: want it given up at the %s budget, as its own timeout", err, took, budget)
	}
	if got := lines.lines(); len(got) != 1 || !strings.Contains(got[0], "failed (context deadline exceeded) on send 1; the 2s retry budget is spent") {
		t.Errorf("the retries said %q", got)
	}
}
