package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"orbit/link-gateway/linkpb"
)

// The mode runners are told, as the server's RUNNER_LINK_REQUIRED switch says (mode.go).

// fakeSwitch is the apiserver's GET /api/runner/link/mode: each read answered with status and body, as set.
type fakeSwitch struct {
	srv    *httptest.Server
	mu     sync.Mutex
	status int
	body   string
	auth   []string
}

func newFakeSwitch(t *testing.T) *fakeSwitch {
	t.Helper()
	f := &fakeSwitch{status: http.StatusOK, body: `{"required":false}`}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.auth = append(f.auth, r.Method+" "+r.URL.Path+" "+r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(f.status)
		_, _ = w.Write([]byte(f.body))
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeSwitch) answer(status int, body string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.status, f.body = status, body
}

func (f *fakeSwitch) poller(g *gateway) *modePoller {
	return &modePoller{url: f.srv.URL + "/api/runner/link/mode", token: g.cfg.GatewayToken, client: f.srv.Client(), g: g}
}

// newFollowingHarness is a gateway with LINK_MODE unset (http) and backends to forward to: it tells runners what the
// server's switch says.
func newFollowingHarness(t *testing.T, backends ...*fakeBackend) *harness {
	t.Helper()
	return newHarness(t, func(c *config) {
		for _, b := range backends {
			c.InternalAPIURLs = append(c.InternalAPIURLs, b.url())
		}
		c.link.RetryBudget = 2 * time.Second
		c.link.BackendDownFor = 500 * time.Millisecond
	})
}

func TestTheSwitchIsReadAndAFailedReadChangesNothing(t *testing.T) {
	h := newFollowingHarness(t, newFakeBackend(t, nil))
	f := newFakeSwitch(t)
	p := f.poller(h.g)
	if h.g.mode() != linkpb.Mode_MODE_HTTP || h.g.metrics.mode.get() != 0 {
		t.Fatalf("before any read: %v, link_mode_link %v; want MODE_HTTP, what LINK_MODE says", h.g.mode(), h.g.metrics.mode.get())
	}
	// Never read, and the first read fails: still MODE_HTTP.
	f.answer(http.StatusServiceUnavailable, `{"code":"DATABASE_UNAVAILABLE"}`)
	if err := p.fetch(context.Background()); err == nil || h.g.mode() != linkpb.Mode_MODE_HTTP {
		t.Fatalf("err %v, mode %v", err, h.g.mode())
	}

	f.answer(http.StatusOK, `{"required":true}`)
	if err := p.fetch(context.Background()); err != nil {
		t.Fatal(err)
	}
	if h.g.mode() != linkpb.Mode_MODE_LINK || h.g.metrics.mode.get() != 1 {
		t.Fatalf("switched on: %v, link_mode_link %v", h.g.mode(), h.g.metrics.mode.get())
	}
	if got := f.auth[len(f.auth)-1]; got != "GET /api/runner/link/mode Bearer "+h.g.cfg.GatewayToken {
		t.Fatalf("asked %q", got)
	}

	// Whatever goes wrong with a read, runners are told the mode last read: never off on an error.
	failures := []struct {
		status int
		body   string
		result string
	}{
		{http.StatusInternalServerError, `{"statusCode":500}`, "error"},
		{http.StatusServiceUnavailable, `{"code":"TRANSIENT_DB_CONFLICT"}`, "error"},
		{http.StatusNotFound, `{"code":"RUNNER_LINK_NOT_CONFIGURED"}`, "not_configured"},
		{http.StatusUnauthorized, `{"code":"RUNNER_LINK_GATEWAY_UNAUTHORIZED"}`, "unauthorized"},
		{http.StatusOK, `{}`, "error"},
		{http.StatusOK, `{"required":"no"}`, "error"},
		{http.StatusOK, `<html>bad gateway</html>`, "error"},
	}
	for _, fail := range failures {
		f.answer(fail.status, fail.body)
		before := h.g.metrics.modeFetches.get(fail.result)
		if err := p.fetch(context.Background()); err == nil {
			t.Fatalf("%d %s read as an answer", fail.status, fail.body)
		}
		if h.g.mode() != linkpb.Mode_MODE_LINK {
			t.Fatalf("%d %s switched the mode to %v", fail.status, fail.body, h.g.mode())
		}
		if got := h.g.metrics.modeFetches.get(fail.result); got != before+1 {
			t.Fatalf("%d %s: link_mode_fetches_total{result=%q} %v, was %v", fail.status, fail.body, fail.result, got, before)
		}
	}
	f.srv.Close()
	if err := p.fetch(context.Background()); err == nil || h.g.mode() != linkpb.Mode_MODE_LINK {
		t.Fatalf("an apiserver that cannot be reached: err %v, mode %v", err, h.g.mode())
	}
}

func TestTheSwitchIsReadEveryIntervalAndFailuresAreLoggedOnce(t *testing.T) {
	h := newFollowingHarness(t, newFakeBackend(t, nil))
	f := newFakeSwitch(t)
	p := f.poller(h.g)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go p.run(ctx, 20*time.Millisecond)

	f.answer(http.StatusOK, `{"required":true}`)
	eventually(t, 5*time.Second, "MODE_LINK once the switch is on", func() bool { return h.g.mode() == linkpb.Mode_MODE_LINK })
	f.answer(http.StatusServiceUnavailable, `{}`)
	time.Sleep(300 * time.Millisecond) // a dozen failed reads
	if h.g.mode() != linkpb.Mode_MODE_LINK {
		t.Fatalf("failed reads switched the mode to %v", h.g.mode())
	}
	f.answer(http.StatusOK, `{"required":false}`)
	eventually(t, 5*time.Second, "MODE_HTTP once the switch is off", func() bool { return h.g.mode() == linkpb.Mode_MODE_HTTP })
	cancel()
	logs := h.logs.String()
	if n := strings.Count(logs, "RUNNER_LINK_REQUIRED not read"); n != 1 {
		t.Fatalf("the failure was logged %d times, want once:\n%s", n, logs)
	}
	if n := strings.Count(logs, "RUNNER_LINK_REQUIRED read again"); n != 1 {
		t.Fatalf("the recovery was logged %d times, want once:\n%s", n, logs)
	}
	for _, want := range []string{"RUNNER_LINK_REQUIRED switched: runners are told MODE_LINK", "RUNNER_LINK_REQUIRED switched: runners are told MODE_HTTP"} {
		if !strings.Contains(logs, want) {
			t.Fatalf("no %q in:\n%s", want, logs)
		}
	}
}

func TestSwitchedOnRunnersAreToldModeLink(t *testing.T) {
	backend := newFakeBackend(t, heartbeatAnswer)
	h := newFollowingHarness(t, backend)

	// The shadow's connection, opened while the switch is off: compared, never forwarded.
	shadow, w := h.connect(runnerA, processA)
	if w.GetMode() != linkpb.Mode_MODE_HTTP {
		t.Fatalf("Welcome %v", w.GetMode())
	}
	h.g.setLinkRequired(true)

	// Its next HeartbeatAck says MODE_LINK, with nothing to apply: the beat was not forwarded.
	shadow.send(heartbeatFrame(&linkpb.Heartbeat{ProcessId: processA}))
	ack := shadow.await("heartbeat_ack", 5*time.Second, nil).GetHeartbeatAck()
	if ack.GetMode() != linkpb.Mode_MODE_LINK || len(ack.GetReconcileJson()) != 0 {
		t.Fatalf("ack on the MODE_HTTP connection: %v", ack)
	}
	// A connection opened in MODE_HTTP forwards nothing, whatever the gateway says now.
	if r := shadow.rpc("r:"+processA+":1", "GET", "/runner/me", nil); r.GetFailure().GetCode() != "LINK_MODE_HTTP" {
		t.Fatalf("a call on the MODE_HTTP connection: %v", r)
	}
	if n := len(backend.requests()); n != 0 {
		t.Fatalf("%d calls reached a backend from a connection opened in MODE_HTTP", n)
	}

	// The runner's work connection, opened now: MODE_LINK, its calls and beats forwarded.
	work, w := h.connectLink(runnerA, processB)
	if w.GetMode() != linkpb.Mode_MODE_LINK {
		t.Fatalf("Welcome %v", w.GetMode())
	}
	if n := len(backend.welcomeCalls()); n != 1 {
		t.Fatalf("%d welcome route calls, want the MODE_LINK Welcome's one", n)
	}
	if r := work.rpc("r:"+processB+":1", "GET", "/runner/me", nil); r.GetTunnel().GetStatus() != 200 {
		t.Fatalf("a call on the MODE_LINK connection: %v", r)
	}
	work.send(heartbeatFrame(&linkpb.Heartbeat{ProcessId: processB}))
	ack = work.await("heartbeat_ack", 5*time.Second, nil).GetHeartbeatAck()
	if ack.GetMode() != linkpb.Mode_MODE_LINK || len(ack.GetReconcileJson()) == 0 {
		t.Fatalf("ack on the MODE_LINK connection: %v", ack)
	}
	if n := len(backend.requestsTo("/api/runner/heartbeat")); n != 1 {
		t.Fatalf("%d heartbeats forwarded", n)
	}
}

func TestSwitchedOffAModeLinkConnectionForwardsNoBeatOrCallButStillItsEvents(t *testing.T) {
	var mu sync.Mutex
	var storedSeqs []uint64
	ingest := linkIngestRoute(&mu, &storedSeqs)
	backend := newFakeBackend(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/events"):
			ingest(w, r, body)
		case r.URL.Path == "/api/runner/heartbeat":
			heartbeatAnswer(w, r, body)
		default:
			writeJSON(w, http.StatusOK, map[string]any{})
		}
	})
	h := newFollowingHarness(t, backend)
	h.g.setLinkRequired(true)
	work, w := h.connectLink(runnerA, processA)
	if w.GetMode() != linkpb.Mode_MODE_LINK {
		t.Fatalf("Welcome %v", w.GetMode())
	}
	work.send(eventsFrame(batch(eventSession, 1, 40)))
	if ack := work.eventAck(5 * time.Second); ack.GetDurableSeq() != 40 || ack.GetFailure() != nil {
		t.Fatalf("ack %v", ack)
	}

	h.g.setLinkRequired(false)
	beats, calls := len(backend.requestsTo("/api/runner/heartbeat")), len(backend.requestsTo("/api/runner/me"))

	// The beat is answered MODE_HTTP with nothing to apply, and reaches no backend: the runner sends it over HTTPS.
	work.send(heartbeatFrame(&linkpb.Heartbeat{ProcessId: processA}))
	ack := work.await("heartbeat_ack", 5*time.Second, nil).GetHeartbeatAck()
	if ack.GetMode() != linkpb.Mode_MODE_HTTP || len(ack.GetReconcileJson()) != 0 {
		t.Fatalf("ack %v", ack)
	}
	// A call is refused LINK_MODE_HTTP before it reaches one: the runner sends it again over HTTPS.
	if r := work.rpc("r:"+processA+":9", "GET", "/runner/me", nil); r.GetFailure().GetCode() != "LINK_MODE_HTTP" {
		t.Fatalf("a call after the switch went off: %v", r)
	}
	if b, c := len(backend.requestsTo("/api/runner/heartbeat")), len(backend.requestsTo("/api/runner/me")); b != beats || c != calls {
		t.Fatalf("after the switch went off, %d beats and %d calls reached a backend", b-beats, c-calls)
	}
	// Its event batches are still forwarded until the runner leaves the connection: stored once each, acknowledged.
	work.send(eventsFrame(batch(eventSession, 41, 80)))
	if ack := work.eventAck(5 * time.Second); ack.GetDurableSeq() != 80 || ack.GetFailure() != nil {
		t.Fatalf("a batch after the switch went off: %v", ack)
	}
	mu.Lock()
	got := append([]uint64(nil), storedSeqs...)
	mu.Unlock()
	for i, seq := range got {
		if seq != uint64(i)+1 {
			t.Fatalf("stored seqs %v", got)
		}
	}
	if len(got) != 80 {
		t.Fatalf("%d events stored, want 80", len(got))
	}

	// A connection opened now is in MODE_HTTP, and asks the welcome route nothing.
	welcomes := len(backend.welcomeCalls())
	_, w = h.connect(runnerA, processB)
	if w.GetMode() != linkpb.Mode_MODE_HTTP || len(backend.welcomeCalls()) != welcomes {
		t.Fatalf("Welcome %v, %d welcome route calls", w.GetMode(), len(backend.welcomeCalls())-welcomes)
	}
}

func TestLinkModeLinkPinsModeLinkWhateverTheSwitchSays(t *testing.T) {
	backend := newFakeBackend(t, heartbeatAnswer)
	h := newLinkHarness(t, []*fakeBackend{backend}, nil)
	h.g.setLinkRequired(false)
	tc, w := h.connectLink(runnerA, processA)
	if w.GetMode() != linkpb.Mode_MODE_LINK || h.g.metrics.mode.get() != 1 {
		t.Fatalf("Welcome %v, link_mode_link %v", w.GetMode(), h.g.metrics.mode.get())
	}
	tc.send(heartbeatFrame(&linkpb.Heartbeat{ProcessId: processA}))
	if ack := tc.await("heartbeat_ack", 5*time.Second, nil).GetHeartbeatAck(); ack.GetMode() != linkpb.Mode_MODE_LINK || len(ack.GetReconcileJson()) == 0 {
		t.Fatalf("ack %v", ack)
	}
}
