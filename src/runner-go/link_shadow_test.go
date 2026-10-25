package main

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"orbit/linkpb"
)

// linkTestHeartbeat is a heartbeat as the runner sends one, with what encoders treat differently in it: <, > and &,
// text that is not ASCII, a number past 2^53, null-able and empty members.
func linkTestHeartbeat(leaseOwner string) HeartbeatRequest {
	runsAsRoot := false
	free := uint64(1<<62 + 1)
	return HeartbeatRequest{
		Status: "ONLINE", IdleCapacity: 3, Version: version, LeaseOwner: leaseOwner,
		SupervisedSessionIDs: []string{"session-b", "session-a"},
		Commands:             []SlashCommandInfo{{Name: "review", Description: "Review <changes> & report → naïve café 中文"}},
		RuntimeDefaultModels: map[string]string{},
		Engines:              []EngineHealthReport{{Engine: "claude", Installed: true, Version: "2.1.300", Auth: "yes"}},
		AgentDirProbes:       []AgentDirProbe{{AgentID: "a1", WorkDir: "~/w", Exists: true, IsGitRepo: true, FreeBytes: &free}},
		ReposRoot:            "/srv/repos/é",
		RunsAsRoot:           &runsAsRoot,
		SelfUpdate:           &SelfUpdateReport{State: "enabled"},
	}
}

// linkTestEvents is an event batch as a session's flush sends one.
func linkTestEvents(from, n int, payloadBytes int) RunEventBatch {
	var batch RunEventBatch
	for i := 0; i < n; i++ {
		ev := RunEvent{Seq: from + i, Type: "assistant", TS: nowISO(), TurnID: "turn-1",
			Payload: map[string]interface{}{"text": fmt.Sprintf("<b>step %d</b> & \"quotes\" → 中文 %s", from+i,
				strings.Repeat("x", payloadBytes)), "n": 1.5, "list": []interface{}{1, "two", nil, true}}}
		switch i % 3 {
		case 1:
			ev.Payload, ev.TurnID = nil, "" // payload null, no turn
		case 2:
			ev.Type = "tool_result"
		}
		batch.Events = append(batch.Events, ev)
	}
	return batch
}

// Each heartbeat and event batch the control plane answered with 2xx reaches the gateway as both halves of a
// mirror: the typed half matches by every rule of the gateway's comparison, and the raw half is the very body the
// control plane received, byte for byte.
func TestLinkShadowMirrorsWhatTheControlPlaneAccepted(t *testing.T) {
	rig := newLinkTestRig(t)
	rig.start(t)
	rig.connected(t, 1)

	if _, err := rig.t.heartbeat(linkTestHeartbeat(rig.t.leaseOwner)); err != nil {
		t.Fatal(err)
	}
	if err := rig.t.postEvents(context.Background(), "session-a", linkTestEvents(1, 6, 10)); err != nil {
		t.Fatal(err)
	}
	linkWaitFor(t, 10*time.Second, "two mirrors compared", func() bool {
		_, pairs, _, _ := rig.g.snapshot()
		return len(pairs) == 2
	})
	_, pairs, unpaired, _ := rig.g.snapshot()
	if len(unpaired) != 0 {
		t.Fatalf("unpaired halves: %v", unpaired)
	}
	sent := map[string][]byte{
		linkMirrorHeartbeat: rig.cp.requests("/api/runner/heartbeat")[0].body,
		linkMirrorEvents:    rig.cp.requests("/api/runner/sessions/session-a/events")[0].body,
	}
	for _, p := range pairs {
		if len(p.diffs) != 0 {
			t.Errorf("the %s mirror differs: %v", p.kind, p.diffs)
		}
		if !bytes.Equal(p.raw.GetJsonBody(), sent[p.kind]) {
			t.Errorf("the %s raw half is not the body the control plane received:\n%s\n%s", p.kind, p.raw.GetJsonBody(), sent[p.kind])
		}
	}
	hb := pairs[0].typed.GetHeartbeat()
	if pairs[0].kind != linkMirrorHeartbeat || hb.GetProcessId() != rig.t.leaseOwner || hb.GetIdleCapacity() != 3 {
		t.Fatalf("the first mirror is %s: %v", pairs[0].kind, hb)
	}
	var kinds []string
	for _, f := range hb.GetFacts() {
		kinds = append(kinds, f.GetKind())
	}
	if want := "agentDirProbes,commands,engines,reposRoot,runsAsRoot,runtimeDefaultModels,selfUpdate"; strings.Join(kinds, ",") != want {
		t.Errorf("facts %v, want %s", kinds, want)
	}
	if got := strings.Join(hb.GetSupportedProviders(), ","); got != supportedProvidersHeader() {
		t.Errorf("supported_providers %q", got)
	}
	if n := rig.shadow.counts[linkMirrorHeartbeat].sent.Load() + rig.shadow.counts[linkMirrorEvents].sent.Load(); n != 2 {
		t.Errorf("the shadow counts %d mirrors sent", n)
	}
	linkWaitFor(t, 5*time.Second, "both raw halves answered", func() bool { return rig.shadow.answered.Load() == 2 })
}

// What the control plane did not accept is not mirrored: a refusal, an error status, a failure to reach it. Nor is
// anything but the two mirrored routes.
func TestLinkShadowMirrorsNothingElse(t *testing.T) {
	rig := newLinkTestRig(t)
	rig.cp.status = func(path string) int {
		switch path {
		case "/api/runner/heartbeat":
			return http.StatusInternalServerError
		case "/api/runner/sessions/refused/events":
			return http.StatusConflict
		}
		return 0
	}
	rig.start(t)
	rig.connected(t, 1)
	if _, err := rig.t.heartbeat(linkTestHeartbeat(rig.t.leaseOwner)); err == nil {
		t.Fatal("the refused heartbeat succeeded")
	}
	if err := rig.t.postEvents(context.Background(), "refused", linkTestEvents(1, 2, 10)); err == nil {
		t.Fatal("the refused batch succeeded")
	}
	// Other routes, answered 200.
	if _, err := rig.t.finalizeRun(context.Background(), "session-a", RunFinalizeRequest{}); err != nil {
		t.Fatal(err)
	}
	if _, err := rig.t.claimSession(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := rig.t.do(context.Background(), http.MethodPost, "/runner/sessions/session-a/events/extra", map[string]int{"a": 1}, nil, time.Second); err != nil {
		t.Fatal(err)
	}
	// And a control plane that cannot be reached at all.
	dead := NewTransport("http://127.0.0.1:1", "runner-token")
	if err := installLinkShadowTap(dead, rig.shadow); err != nil {
		t.Fatal(err)
	}
	if err := dead.postEvents(context.Background(), "session-a", linkTestEvents(1, 2, 10)); err == nil {
		t.Fatal("a batch to nowhere succeeded")
	}
	time.Sleep(300 * time.Millisecond)
	conns, pairs, unpaired, _ := rig.g.snapshot()
	rig.g.mu.Lock()
	typed := len(conns[0].typed)
	rig.g.mu.Unlock()
	if len(pairs)+len(unpaired)+typed != 0 {
		t.Fatalf("the gateway got %d mirrors, %d unpaired and %d typed halves for requests that were not accepted",
			len(pairs), len(unpaired), typed)
	}
	for kind, counts := range rig.shadow.counts {
		if counts.sent.Load() != 0 {
			t.Errorf("%d %s mirrors sent", counts.sent.Load(), kind)
		}
		for reason := range linkDropReasons {
			if n := counts.dropped[reason].Load(); n != 0 {
				t.Errorf("%d %s mirrors dropped as %s: there was nothing to mirror", n, kind, linkDropReasonNames[reason])
			}
		}
	}
}

// The tap leaves the work path as it was: the same answers and the same errors, through every way the transport
// sends (its JSON calls, a long poll, a refusal, a download, a multipart upload), with and without it.
func TestLinkShadowTapLeavesTheWorkPathAsItWas(t *testing.T) {
	cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		switch {
		case r.URL.Path == "/api/runner/heartbeat":
			_, _ = w.Write([]byte(`{"maxConcurrent":4,"cancelSessionIds":["s9"],"leaseLostSessionIds":["s8"]}`))
		case r.URL.Path == "/api/runner/sessions/claim":
			_, _ = w.Write([]byte(`{"sessionId":"s1","title":"a title"}`))
		case strings.HasSuffix(r.URL.Path, "/inbox"):
			_, _ = fmt.Fprintf(w, `{"turnId":"t1","text":%q}`, r.URL.RawQuery)
		case strings.HasSuffix(r.URL.Path, "/finalize"):
			_, _ = w.Write([]byte(`{"keepCheckout":false}`))
		case strings.HasSuffix(r.URL.Path, "/turn-complete"):
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"code":"TURN_NOT_LEASED","message":"not yours","requiredAction":"stop"}`))
		case strings.HasSuffix(r.URL.Path, "/attachments/a1"):
			_, _ = w.Write([]byte{0, 1, 2, 255})
		case strings.HasSuffix(r.URL.Path, "/attachments"):
			_, _ = fmt.Fprintf(w, `{"id":"att-%d"}`, len(body))
		default:
			_, _ = w.Write([]byte(`{}`))
		}
	}))
	defer cp.Close()
	file := filepath.Join(t.TempDir(), "note.txt")
	if err := os.WriteFile(file, []byte("a file"), 0o600); err != nil {
		t.Fatal(err)
	}
	calls := func(tr *Transport) []string {
		var out []string
		add := func(v any, err error) {
			b, _ := json.Marshal(v)
			out = append(out, fmt.Sprintf("%s | %v", b, err))
		}
		hb, err := tr.heartbeat(linkTestHeartbeat(tr.leaseOwner))
		add(hb, err)
		claim, err := tr.claimSession(context.Background())
		add(claim, err)
		in, err := tr.inbox(context.Background(), "s1", "gen-1")
		add(in, err)
		keep, err := tr.finalizeRun(context.Background(), "s1", RunFinalizeRequest{})
		add(keep, err)
		_, err = tr.turnComplete(context.Background(), "s1", TurnCompleteRequest{TurnID: "t1"})
		add(nil, err)
		add(nil, tr.postEvents(context.Background(), "s1", linkTestEvents(1, 3, 10)))
		data, err := tr.fetchAttachment(context.Background(), "s1", "a1")
		add(data, err)
		id, err := tr.uploadSessionAttachment(context.Background(), "s1", file, "text/plain")
		add(id, err)
		return out
	}
	plain := calls(NewTransport(cp.URL, "runner-token"))

	tapped := NewTransport(cp.URL, "runner-token")
	g := newFakeLinkGateway(t)
	linkCP := newFakeLinkControlPlane(t, g.linkURL())
	s := newLinkShadow(newLinkTestClient(linkCP, tapped.leaseOwner, g.roots(), nil), (&linkTestLog{}).log)
	if err := installLinkShadowTap(tapped, s); err != nil {
		t.Fatal(err)
	}
	stop := s.start()
	defer stop()
	got := calls(tapped)
	if strings.Join(got, "\n") != strings.Join(plain, "\n") {
		t.Fatalf("through the tap:\n%s\nwithout it:\n%s", strings.Join(got, "\n"), strings.Join(plain, "\n"))
	}
	linkWaitFor(t, 10*time.Second, "the heartbeat's and the batch's mirrors", func() bool {
		_, pairs, _, _ := g.snapshot()
		return len(pairs) == 2
	})
}

// linkStuckGateway is a way for the link gateway to be gone or stuck.
type linkStuckGateway struct {
	name string
	// gateway is the link address the control plane hands out, and the roots that trust it; mid, when set, runs
	// a third of the way through.
	gateway func(t *testing.T) (string, *x509.CertPool)
	mid     func()
	// dropped is the reason the shadow must have dropped mirrors for.
	dropped linkDropReason
}

// A link gateway that cannot be reached, that never answers, that stops reading, or that crashes mid-way, and a full
// queue: none of it adds a moment to the work path. Every call is answered as fast as the control plane answers it,
// and the mirrors the shadow could not send are dropped and counted, never waited for.
func TestLinkShadowNeverSlowsTheWorkPath(t *testing.T) {
	var crashing *fakeLinkGateway
	scenarios := []linkStuckGateway{
		{name: "unreachable", dropped: linkDropOffline, gateway: func(t *testing.T) (string, *x509.CertPool) {
			l, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			addr := l.Addr().String()
			_ = l.Close() // nothing listens there now
			return "wss://" + addr, nil
		}},
		{name: "never answers", dropped: linkDropQueueFull, gateway: func(t *testing.T) (string, *x509.CertPool) {
			l, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			var held []net.Conn
			var mu sync.Mutex
			go func() {
				for {
					c, err := l.Accept()
					if err != nil {
						return
					}
					mu.Lock()
					held = append(held, c) // accepted, and never a byte back
					mu.Unlock()
				}
			}()
			t.Cleanup(func() {
				_ = l.Close()
				mu.Lock()
				for _, c := range held {
					_ = c.Close()
				}
				mu.Unlock()
			})
			return "wss://" + l.Addr().String(), nil
		}},
		{name: "stops reading", dropped: linkDropQueueFull, gateway: func(t *testing.T) (string, *x509.CertPool) {
			g := newFakeLinkGateway(t)
			g.stall = true
			return g.linkURL(), g.roots()
		}},
		{name: "crashes", dropped: linkDropOffline, gateway: func(t *testing.T) (string, *x509.CertPool) {
			crashing = newFakeLinkGateway(t)
			return crashing.linkURL(), crashing.roots()
		}, mid: func() {
			crashing.mu.Lock()
			conns := append([]*fakeLinkConn{}, crashing.conns...)
			crashing.mu.Unlock()
			crashing.Listener.Close()
			for _, c := range conns {
				_ = c.ws.CloseNow()
			}
		}},
	}
	for _, sc := range scenarios {
		t.Run(sc.name, func(t *testing.T) {
			linkURL, roots := sc.gateway(t)
			cp := newFakeLinkControlPlane(t, linkURL)
			cp.discardBodies = true
			tapped := NewTransport(cp.URL, "runner-token")
			s := newLinkShadow(newLinkTestClient(cp, tapped.leaseOwner, roots, nil), (&linkTestLog{}).log)
			if err := installLinkShadowTap(tapped, s); err != nil {
				t.Fatal(err)
			}
			stop := s.start()
			defer stop()
			baseline := NewTransport(cp.URL, "runner-token")

			// Big batches, so a gateway that stops reading fills its connection, and more of them than the queue
			// holds.
			const rounds = 150
			var slowest, slowestWithout time.Duration
			var with, without []time.Duration
			for i := 0; i < rounds; i++ {
				if i == rounds/3 && sc.mid != nil {
					sc.mid()
				}
				for _, tr := range []*Transport{tapped, baseline} {
					began := time.Now()
					if i%10 == 0 {
						if _, err := tr.heartbeat(linkTestHeartbeat(tr.leaseOwner)); err != nil {
							t.Fatal(err)
						}
					} else if err := tr.postEvents(context.Background(), "session-a", linkTestEvents(i*4, 4, 64<<10)); err != nil {
						t.Fatal(err)
					}
					took := time.Since(began)
					if tr == tapped {
						with = append(with, took)
						slowest = max(slowest, took)
					} else {
						without = append(without, took)
						slowestWithout = max(slowestWithout, took)
					}
				}
			}
			// A shadow in the way would cost a dial's 15s or a write's 10s; a second is a loaded machine's margin.
			if slowest > slowestWithout+time.Second {
				t.Errorf("a work-path call took %s with the link gateway %s, against %s without the shadow", slowest, sc.name, slowestWithout)
			}
			t.Logf("gateway %s: median %s with the shadow, %s without; slowest %s with, %s without",
				sc.name, linkMedian(with), linkMedian(without), slowest, slowestWithout)
			counts := s.counts[linkMirrorEvents]
			if counts.dropped[sc.dropped].Load() == 0 {
				t.Errorf("no batch mirror was dropped as %s: sent %d, dropped %v", linkDropReasonNames[sc.dropped],
					counts.sent.Load(), linkDroppedCounts(counts))
			}
		})
	}
}

func linkMedian(d []time.Duration) time.Duration {
	if len(d) == 0 {
		return 0
	}
	s := append([]time.Duration{}, d...)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	return s[len(s)/2]
}

func linkDroppedCounts(c *linkMirrorCounts) map[string]int64 {
	out := map[string]int64{}
	for reason := range linkDropReasons {
		if n := c.dropped[reason].Load(); n > 0 {
			out[linkDropReasonNames[reason]] = n
		}
	}
	return out
}

// The queue holds linkShadowQueueLen mirrors and linkShadowQueueBytes of bodies; past either, or past a mirror's own
// bound, a mirror is dropped and counted. A request whose body cannot be taken again is not mirrored either.
func TestLinkShadowQueueIsBoundedAndCountsWhatItDrops(t *testing.T) {
	s := newLinkShadow(nil, (&linkTestLog{}).log)
	body := func() (io.ReadCloser, error) { return io.NopCloser(strings.NewReader("{}")), nil }
	for i := 0; i < linkShadowQueueLen+5; i++ {
		s.offer(&linkMirror{kind: linkMirrorHeartbeat, body: body, size: 2})
	}
	hb := s.counts[linkMirrorHeartbeat]
	if len(s.queue) != linkShadowQueueLen || hb.dropped[linkDropQueueFull].Load() != 5 {
		t.Fatalf("queued %d, dropped %v", len(s.queue), linkDroppedCounts(hb))
	}
	for len(s.queue) > 0 {
		m := <-s.queue
		s.queuedBytes.Add(-m.size)
	}
	for i := 0; i < 6; i++ {
		s.offer(&linkMirror{kind: linkMirrorEvents, body: body, size: linkShadowMaxBody})
	}
	ev := s.counts[linkMirrorEvents]
	if want := int64(linkShadowQueueBytes / linkShadowMaxBody); int64(len(s.queue)) != want || ev.dropped[linkDropQueueFull].Load() != 6-want {
		t.Fatalf("queued %d of 6 bodies of %d bytes, dropped %v", len(s.queue), linkShadowMaxBody, linkDroppedCounts(ev))
	}
	s.offer(&linkMirror{kind: linkMirrorEvents, body: body, size: linkShadowMaxBody + 1})
	if ev.dropped[linkDropTooLarge].Load() != 1 {
		t.Fatalf("a body past %d bytes: %v", linkShadowMaxBody, linkDroppedCounts(ev))
	}
	tap := &linkShadowTap{shadow: s, prefix: "/api"}
	req, _ := http.NewRequest(http.MethodPost, "http://h/api/runner/heartbeat", io.NopCloser(strings.NewReader("{}")))
	tap.observe(req)
	if hb.dropped[linkDropNoBody].Load() != 1 {
		t.Fatalf("a body without GetBody: %v", linkDroppedCounts(hb))
	}
}

// The tap takes the request's body again through GetBody, after the 2xx: the body the transport sent is not read by
// anyone else, and a panic inside the tap stays in the tap.
func TestLinkShadowTapNeverTouchesTheRequestsOwnBody(t *testing.T) {
	var got []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, _ = io.ReadAll(r.Body)
	}))
	defer srv.Close()
	s := newLinkShadow(nil, (&linkTestLog{}).log)
	tap := &linkShadowTap{shadow: s, prefix: "/api"}
	client := &http.Client{Transport: tap}
	sent := []byte(`{"leaseOwner":"p","events":[]}`)
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/runner/sessions/s1/events", bytes.NewReader(sent))
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if !bytes.Equal(got, sent) {
		t.Fatalf("the server got %q", got)
	}
	m := <-s.queue
	rc, _ := m.body()
	mirrored, _ := io.ReadAll(rc)
	if !bytes.Equal(mirrored, sent) || m.sessionID != "s1" || m.path != "/runner/sessions/s1/events" || m.size != int64(len(sent)) {
		t.Fatalf("mirror %+v of %q", m, mirrored)
	}

	// A panic in the tap (here: a shadow with no counts) is the tap's alone.
	broken := &linkShadowTap{shadow: &linkShadow{}, prefix: "/api"}
	req, _ = http.NewRequest(http.MethodPost, srv.URL+"/api/runner/heartbeat", bytes.NewReader(sent))
	resp, err = (&http.Client{Transport: broken}).Do(req)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("through a broken tap: %v", err)
	}
	resp.Body.Close()
	if broken.shadow.tapPanics.Load() != 1 {
		t.Errorf("the tap's panic was not counted")
	}
}

// CloseIdleConnections through the client reaches the transport under the tap: the runner's idle-connection
// cleanups keep working.
func TestLinkShadowTapForwardsCloseIdleConnections(t *testing.T) {
	var closed atomic.Int32
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	srv.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateClosed {
			closed.Add(1)
		}
	}
	srv.Start()
	defer srv.Close()
	tr := NewTransport(srv.URL, "runner-token")
	tr.client.Transport = &http.Transport{} // a pool of its own, to see it emptied
	inner := tr.client.Transport
	if err := installLinkShadowTap(tr, newLinkShadow(nil, (&linkTestLog{}).log)); err != nil {
		t.Fatal(err)
	}
	if tr.client.Transport.(*linkShadowTap).next != inner {
		t.Fatal("the tap is not around the transport the client had")
	}
	if err := tr.do(context.Background(), http.MethodGet, "/runner/me", nil, nil, time.Second); err != nil {
		t.Fatal(err)
	}
	tr.client.CloseIdleConnections()
	linkWaitFor(t, 5*time.Second, "the idle connection closed", func() bool { return closed.Load() == 1 })

	// Over the default transport too, which the client had when it named none.
	plain := NewTransport(srv.URL, "runner-token")
	if err := installLinkShadowTap(plain, newLinkShadow(nil, (&linkTestLog{}).log)); err != nil {
		t.Fatal(err)
	}
	if tap := plain.client.Transport.(*linkShadowTap); tap.next != nil || tap.transport() != http.DefaultTransport {
		t.Fatal("over a client that named no transport, the tap does not send through http.DefaultTransport")
	}
	if err := plain.do(context.Background(), http.MethodGet, "/runner/me", nil, nil, time.Second); err != nil {
		t.Fatal(err)
	}
	plain.client.CloseIdleConnections()
	linkWaitFor(t, 5*time.Second, "the default transport's idle connection closed", func() bool { return closed.Load() == 2 })
}

// Turned off by the environment or the config, the shadow installs nothing: the client's transport is what it is
// without the shadow.
func TestLinkShadowTurnedOffInstallsNothing(t *testing.T) {
	off := false
	for _, c := range []struct {
		env string
		cfg *RunnerConfig
	}{{"0", &RunnerConfig{}}, {"false", nil}, {"off", &RunnerConfig{}}, {"", &RunnerConfig{LinkShadow: &off}}} {
		t.Setenv(linkShadowEnv, c.env)
		if c.env == "" {
			os.Unsetenv(linkShadowEnv)
		}
		tr := NewTransport("http://127.0.0.1:1", "runner-token")
		stop := startLinkShadow(c.cfg, tr)
		stop()
		if tr.client.Transport != nil {
			t.Errorf("%s=%q, config %+v: the client's transport is %T", linkShadowEnv, c.env, c.cfg, tr.client.Transport)
		}
		if on, why := linkShadowEnabled(c.cfg); on || why == "" {
			t.Errorf("%s=%q: on %v (%s)", linkShadowEnv, c.env, on, why)
		}
	}
	os.Unsetenv(linkShadowEnv)
	if on, _ := linkShadowEnabled(&RunnerConfig{}); !on {
		t.Error("the shadow is off by default")
	}
	on := true
	if ok, _ := linkShadowEnabled(&RunnerConfig{LinkShadow: &on}); !ok {
		t.Error(`"linkShadow": true turns it off`)
	}
}

// On by default: the tap goes around the transport, and stopping the shadow gives it back nothing to wait for.
func TestLinkShadowStartsByDefaultAndStopsPromptly(t *testing.T) {
	os.Unsetenv(linkShadowEnv)
	cp := newFakeLinkControlPlane(t, "wss://127.0.0.1:1")
	cp.tokenStatus = http.StatusNotFound
	tr := NewTransport(cp.URL, "runner-token")
	stop := startLinkShadow(&RunnerConfig{}, tr)
	if _, ok := tr.client.Transport.(*linkShadowTap); !ok {
		t.Fatalf("the client's transport is %T", tr.client.Transport)
	}
	linkWaitFor(t, 5*time.Second, "the shadow to ask for a link token", func() bool {
		return len(cp.requests("/api/runner/link-token")) == 1
	})
	began := time.Now()
	stop()
	if took := time.Since(began); took > linkShadowStopWait+time.Second {
		t.Errorf("stopping took %s", took)
	}
}

// Before the token expires, the next connection is opened with a fresh token and welcomed, and only then is the
// old one closed, by the runner, once the gateway has answered what was sent on it: no mirror is lost on the way.
func TestLinkShadowRenewsItsTokenMakeBeforeBreak(t *testing.T) {
	rig := newLinkTestRig(t)
	rig.cp.lifetime = 3 * time.Second // renewed after 1.5s
	rig.start(t)
	rig.connected(t, 1)
	stopBeats := make(chan struct{})
	var beats sync.WaitGroup
	var delivered atomic.Int64
	beats.Add(1)
	go func() {
		defer beats.Done()
		for i := 0; ; i++ {
			select {
			case <-stopBeats:
				return
			case <-time.After(20 * time.Millisecond):
			}
			if err := rig.t.postEvents(context.Background(), "session-a", linkTestEvents(i*2+1, 2, 100)); err == nil {
				delivered.Add(1)
			}
		}
	}()
	rig.connected(t, 3)
	close(stopBeats)
	beats.Wait()
	linkWaitFor(t, 10*time.Second, "every mirror compared", func() bool {
		_, pairs, _, _ := rig.g.snapshot()
		return int64(len(pairs)) == delivered.Load()
	})
	conns, pairs, unpaired, _ := rig.g.snapshot()
	if len(unpaired) != 0 {
		t.Fatalf("unpaired halves: %v", unpaired)
	}
	for _, p := range pairs {
		if len(p.diffs) != 0 {
			t.Fatalf("a mirror differs: %v", p.diffs)
		}
	}
	if n := len(rig.cp.requests("/api/runner/link-token")); n < 3 {
		t.Errorf("%d link tokens for 3 connections", n)
	}
	linkWaitFor(t, 5*time.Second, "the replaced connections to end", func() bool {
		rig.g.mu.Lock()
		defer rig.g.mu.Unlock()
		return !conns[0].ended.IsZero() && !conns[1].ended.IsZero()
	})
	rig.g.mu.Lock()
	defer rig.g.mu.Unlock()
	for i := 0; i+1 < len(conns) && i < 2; i++ {
		old, next := conns[i], conns[i+1]
		if !next.welcomed.Before(old.ended) {
			t.Errorf("connection %s was welcomed at %s, after %s ended at %s: break before make", next.id,
				next.welcomed.Format("15:04:05.000"), old.id, old.ended.Format("15:04:05.000"))
		}
		if old.status != websocket.StatusNormalClosure {
			t.Errorf("connection %s ended with %v, not the runner's normal close", old.id, old.status)
		}
	}
	for kind, counts := range rig.shadow.counts {
		if d := linkDroppedCounts(counts); len(d) != 0 {
			t.Errorf("%s mirrors dropped across renewals: %v", kind, d)
		}
	}
}

// A Drain opens the next connection after reconnect_after_ms, and the drained one is closed once it is welcomed.
func TestLinkShadowFollowsADrain(t *testing.T) {
	rig := newLinkTestRig(t)
	rig.start(t)
	rig.connected(t, 1)
	conns, _, _, _ := rig.g.snapshot()
	sent := time.Now()
	conns[0].send(&linkpb.Frame{Body: &linkpb.Frame_Drain{Drain: &linkpb.Drain{ReconnectAfterMs: 400}}})
	rig.connected(t, 2)
	conns, _, _, upgrades := rig.g.snapshot()
	if at := upgrades[len(upgrades)-1]; at.Sub(sent) < 400*time.Millisecond {
		t.Errorf("the next connection was opened %s after the Drain, sooner than its 400ms", at.Sub(sent))
	}
	linkWaitFor(t, 5*time.Second, "the drained connection to end", func() bool {
		rig.g.mu.Lock()
		defer rig.g.mu.Unlock()
		return !conns[0].ended.IsZero()
	})
	rig.g.mu.Lock()
	old, next := conns[0], conns[1]
	if !next.welcomed.Before(old.ended) || old.status != websocket.StatusNormalClosure {
		t.Errorf("drained %s ended %s (%v), its successor welcomed %s", old.id, old.ended, old.status, next.welcomed)
	}
	rig.g.mu.Unlock()
	if !strings.Contains(strings.Join(rig.logs.all(), "\n"), "replaced by "+next.id+" (drain)") {
		t.Errorf("the log does not say the drain replaced the connection:\n%s", strings.Join(rig.logs.all(), "\n"))
	}
}

// A connection the gateway closes is reopened with backoff, never sooner than the Close's retry_after_ms; an upgrade
// refused with Retry-After is asked again no sooner either. The summary counts the reconnect and its gap.
func TestLinkShadowReconnectsNoSoonerThanItIsTold(t *testing.T) {
	rig := newLinkTestRig(t)
	rig.shadow.summaryEvery = time.Hour
	rig.start(t)
	rig.connected(t, 1)
	conns, _, _, _ := rig.g.snapshot()
	var refused atomic.Int32
	rig.g.mu.Lock()
	rig.g.refuse = func(*http.Request) (int, string, string) {
		if refused.Add(1) == 1 {
			return http.StatusServiceUnavailable, `{"code":"DRAINING","message":"draining"}`, "2"
		}
		return 0, "", ""
	}
	rig.g.mu.Unlock()
	closedAt := time.Now()
	conns[0].send(&linkpb.Frame{Body: &linkpb.Frame_Close{Close: &linkpb.Close{
		Code: linkpb.CloseCode_CLOSE_CODE_INTERNAL_ERROR, Message: "the test closes it", RetryAfterMs: 1200}}})
	_ = conns[0].ws.Close(websocket.StatusInternalError, "closing")
	rig.connected(t, 2)
	_, _, _, upgrades := rig.g.snapshot()
	if len(upgrades) != 3 {
		t.Fatalf("%d upgrades: want the first, one refused, one welcomed", len(upgrades))
	}
	if gap := upgrades[1].Sub(closedAt); gap < 1200*time.Millisecond {
		t.Errorf("reconnected %s after a Close asking for 1.2s", gap)
	}
	if gap := upgrades[2].Sub(upgrades[1]); gap < 2*time.Second {
		t.Errorf("asked again %s after a refusal with Retry-After: 2", gap)
	}
	rig.stop()
	var summary linkShadowSummary
	for _, line := range rig.logs.all() {
		if rest, ok := strings.CutPrefix(line, "link shadow summary "); ok {
			if err := json.Unmarshal([]byte(rest), &summary); err != nil {
				t.Fatal(err)
			}
		}
	}
	if !summary.Final || summary.Connects != 2 || summary.Reconnects != 1 || summary.DialFailures != 1 ||
		len(summary.ReconnectGapsMs) != 1 || summary.ReconnectGapsMs[0] < 3000 || summary.MaxReconnectMs < 3000 {
		t.Errorf("summary %+v", summary)
	}
	if !strings.Contains(summary.LastError, "DRAINING") && !strings.Contains(summary.LastError, "the test closes it") {
		t.Errorf("last error %q", summary.LastError)
	}
	if summary.RTTMs == nil || summary.RTTMs.Samples == 0 {
		t.Errorf("no RTT in %+v", summary)
	}
	log := strings.Join(rig.logs.all(), "\n")
	for _, want := range []string{"closed by the gateway: CLOSE_CODE_INTERNAL_ERROR", "cannot connect (upgrade answered 503 DRAINING)", "after 3."} {
		if !strings.Contains(log, want) {
			t.Errorf("the log does not say %q:\n%s", want, log)
		}
	}
}

// The summary line says what A6 counts: online time, connections, mirrors sent, answered and dropped by reason, and
// the process's goroutines and heap.
func TestLinkShadowSummarySaysWhatHappened(t *testing.T) {
	rig := newLinkTestRig(t)
	rig.shadow.summaryEvery = 100 * time.Millisecond
	rig.start(t)
	rig.connected(t, 1)
	if _, err := rig.t.heartbeat(linkTestHeartbeat(rig.t.leaseOwner)); err != nil {
		t.Fatal(err)
	}
	rig.shadow.offer(&linkMirror{kind: linkMirrorEvents, size: linkShadowMaxBody + 1})
	linkWaitFor(t, 5*time.Second, "the mirror answered", func() bool { return rig.shadow.answered.Load() == 1 })
	var summary linkShadowSummary
	linkWaitFor(t, 5*time.Second, "a summary with the mirror in it", func() bool {
		for _, line := range rig.logs.all() {
			if rest, ok := strings.CutPrefix(line, "link shadow summary "); ok {
				_ = json.Unmarshal([]byte(rest), &summary)
			}
		}
		return summary.Answered == 1
	})
	if summary.State != "connected" || summary.Connection == "" || summary.Process != rig.t.leaseOwner || summary.OnlineS <= 0 ||
		summary.Mirrors[linkMirrorHeartbeat].Sent != 1 || summary.Mirrors[linkMirrorEvents].Dropped["too_large"] != 1 ||
		summary.Goroutines == 0 || summary.HeapBytes == 0 || summary.Link != rig.g.linkURL() {
		t.Errorf("summary %+v", summary)
	}
}

// The typed halves follow the README's rules for bodies the runner does not send today as well: absent and null
// members, a payload missing, a ts that does not parse.
func TestLinkMirrorBuildersFollowTheReadme(t *testing.T) {
	hello := &linkpb.Hello{ProcessId: "p-1", RunnerVersion: version}
	for _, body := range []string{
		`{"status":"ONLINE","idleCapacity":0,"leaseOwner":"P-1","runtimeDefaultModels":null}`,
		`{"leaseOwner":"p-1","supervisedSessionIds":null,"draining":true,"version":"` + version + `","x":{"b":1,"a":[1.0,2e0]}}`,
		`{}`,
	} {
		hb, err := linkMirrorOfHeartbeat([]byte(body), "claude,codex")
		if err != nil {
			t.Fatal(err)
		}
		_, diffs := compareLinkMirror(&linkpb.Frame{Body: &linkpb.Frame_Heartbeat{Heartbeat: hb}},
			&linkpb.TunnelRequest{Method: "POST", Path: "/runner/heartbeat", JsonBody: []byte(body)}, hello)
		if len(diffs) != 0 {
			t.Errorf("%s: %v", body, diffs)
		}
	}
	for _, body := range []string{
		`{"leaseOwner":"p-1","events":[{"seq":1,"type":"a","ts":"2026-10-25T08:00:00.123Z"},{"seq":2,"type":"b","ts":"2026-10-25T08:00:00.999999999+02:00","turnId":"t","payload":{"<":"&"}}]}`,
		`{"events":[]}`,
		`{"events":null}`,
	} {
		eb, err := linkMirrorOfEvents("s", []byte(body))
		if err != nil {
			t.Fatal(err)
		}
		_, diffs := compareLinkMirror(&linkpb.Frame{Body: &linkpb.Frame_EventBatch{EventBatch: eb}},
			&linkpb.TunnelRequest{Method: "POST", Path: "/runner/sessions/s/events", JsonBody: []byte(body)}, hello)
		if len(diffs) != 0 {
			t.Errorf("%s: %v", body, diffs)
		}
	}
	for _, bad := range []string{`[]`, `nope`, `null`} {
		if _, err := linkMirrorOfHeartbeat([]byte(bad), ""); err == nil {
			t.Errorf("heartbeat %s built", bad)
		}
		if _, err := linkMirrorOfEvents("s", []byte(bad)); err == nil {
			t.Errorf("batch %s built", bad)
		}
	}
	if _, err := linkMirrorOfEvents("s", []byte(`{"events":[1]}`)); err == nil {
		t.Error("a batch whose event is not an object built")
	}
	// What the gateway would count as a real difference is carried as it is, for the gateway to see.
	eb, _ := linkMirrorOfEvents("s", []byte(`{"events":[{"seq":1,"type":"a","ts":"yesterday","extra":true}]}`))
	_, diffs := compareLinkMirror(&linkpb.Frame{Body: &linkpb.Frame_EventBatch{EventBatch: eb}}, &linkpb.TunnelRequest{
		Method: "POST", Path: "/runner/sessions/s/events", JsonBody: []byte(`{"events":[{"seq":1,"type":"a","ts":"yesterday","extra":true}]}`)}, hello)
	if want := []string{"event_member 0: extra", "ts 0"}; !reflect.DeepEqual(diffs, want) {
		t.Errorf("diffs %v, want %v", diffs, want)
	}
}

// Stopping sends what is queued, waits for the gateway to take it and closes the connection as going away; with a
// gateway that takes nothing, it still returns within linkShadowStopWait.
func TestLinkShadowStopFlushesAndNeverHangs(t *testing.T) {
	rig := newLinkTestRig(t)
	rig.start(t)
	rig.connected(t, 1)
	if _, err := rig.t.heartbeat(linkTestHeartbeat(rig.t.leaseOwner)); err != nil {
		t.Fatal(err)
	}
	rig.stop()
	_, pairs, unpaired, _ := rig.g.snapshot()
	if len(pairs) != 1 || len(unpaired) != 0 {
		t.Fatalf("after stopping: %d mirrors compared, unpaired %v", len(pairs), unpaired)
	}
	conns, _, _, _ := rig.g.snapshot()
	linkWaitFor(t, 5*time.Second, "the connection to end", func() bool {
		rig.g.mu.Lock()
		defer rig.g.mu.Unlock()
		return !conns[0].ended.IsZero()
	})
	rig.g.mu.Lock()
	if conns[0].status != websocket.StatusGoingAway {
		t.Errorf("the connection ended with %v", conns[0].status)
	}
	rig.g.mu.Unlock()

	stalled := newLinkTestRig(t)
	stalled.g.stall = true
	stalled.start(t)
	stalled.connected(t, 1)
	for i := 0; i < 40; i++ {
		_ = stalled.t.postEvents(context.Background(), "s", linkTestEvents(i*2+1, 2, 64<<10))
	}
	began := time.Now()
	stalled.stop()
	if took := time.Since(began); took > linkShadowStopWait+500*time.Millisecond {
		t.Errorf("stopping against a gateway that takes nothing took %s", took)
	}
}
