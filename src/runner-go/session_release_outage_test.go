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
	"strings"
	"sync"
	"testing"
	"time"

	"orbit/linkpb"
)

// An engine that stops while the control plane cannot be reached — the network gone, an apiserver deploy, a database
// failing over, the runner link down — leaves its inbox generation to be released once the control plane is back
// (task B9). The session is not failed for it: the release goes again until it lands, the session takes no turn until
// then, and the next turn runs as if nothing had happened. Every case drives the real supervisor (runInteractiveSession)
// against the scripted claude and a control plane that keeps the inbox generations the way the apiserver does
// (activateLeases, releaseLeases, dequeueTurn), over HTTPS and over the link.

// releaseOutageFor is how long the control plane stays unreachable after the engine stops, and shortens the one release
// attempt's bound (finalLeaseReleaseTimeout) to well inside it: what failed the session before task B9. 1.5 s against
// 200 ms keeps the suite short; with ORBIT_TEST_RELEASE_OUTAGE set, say to 10m, the outage is that long against the real
// 10 s bound.
func releaseOutageFor(t *testing.T) time.Duration {
	t.Helper()
	if v := os.Getenv("ORBIT_TEST_RELEASE_OUTAGE"); v != "" {
		outage, err := time.ParseDuration(v)
		if err != nil || outage <= finalLeaseReleaseTimeout {
			t.Fatalf("ORBIT_TEST_RELEASE_OUTAGE=%s: want a duration longer than one release's bound, %s", v, finalLeaseReleaseTimeout)
		}
		return outage
	}
	old := finalLeaseReleaseTimeout
	finalLeaseReleaseTimeout = 200 * time.Millisecond
	t.Cleanup(func() { finalLeaseReleaseTimeout = old })
	return 1500 * time.Millisecond
}

// releaseOutageViaLink marks a request the fake gateway forwarded from the runner link, as against one that came over
// HTTPS.
const releaseOutageViaLink = "X-Test-Via-Link"

// releaseOutageControlPlane is one session's control plane as the apiserver keeps its inbox generations: activation
// makes a generation current, and is refused while another is current and not retired; a release retires one (a
// tombstone) and hands back the message turns it leased; a fetch under a generation that is not current, or retired, is
// refused 409; a control turn is answered as it is handed out, a message turn leased to the fetch's generation. Over
// HTTPS a fetch is the long poll, which goes on after its runner gave up on it, as a Nest handler does: a turn handed
// out to a fetch nobody waits for any more is recorded as eaten.
type releaseOutageControlPlane struct {
	mu sync.Mutex
	// down is the control plane unreachable, and how: "reset" (the connection cut), "503" (DATABASE_UNAVAILABLE),
	// "silent" (no answer until it is back, or the runner gives up). Over the link the gateway is down too
	// (releaseOutageRig.setDown).
	down     bool
	downKind string
	upAgain  chan struct{}
	// longPoll is how long an HTTPS fetch waits for a turn; a link fetch answers at once.
	longPoll time.Duration
	// linkRequired answers a daemon call over HTTPS 426, as RUNNER_LINK_REQUIRED does: over the link it is the link's.
	linkRequired bool
	// releaseStatus and takeoverStatus, when set, refuse release-leases and takeover-leases so.
	releaseStatus, takeoverStatus int

	generation  string
	retired     map[string]bool
	activations []releaseOutageCall
	releases    []releaseOutageCall
	queue       []RunInboxResponse
	inFlight    *RunInboxResponse // the message turn leased, and the generation it is leased to
	inFlightGen string
	handedOut   []releaseOutageHandOut
	fetches     []releaseOutageCall
	completions []TurnCompleteRequest
	finalizes   []RunFinalizeRequest
	diffs       int
	paths       []string
}

// releaseOutageCall is an activation, a release or a fetch the control plane took, under which generation, when, and
// whether it was answered 2xx.
type releaseOutageCall struct {
	generation string
	at         time.Time
	ok         bool
}

// releaseOutageHandOut is a turn handed out: to which generation, and whether its fetch's runner was still waiting.
type releaseOutageHandOut struct {
	turn       RunInboxResponse
	generation string
	at         time.Time
	eaten      bool
}

func newReleaseOutageControlPlane() *releaseOutageControlPlane {
	return &releaseOutageControlPlane{retired: map[string]bool{}, longPoll: 200 * time.Millisecond, upAgain: make(chan struct{})}
}

func (c *releaseOutageControlPlane) serve(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api")
	link := r.Header.Get(releaseOutageViaLink) != ""
	body, _ := io.ReadAll(r.Body)
	c.mu.Lock()
	c.paths = append(c.paths, path)
	down, kind, upAgain := c.down, c.downKind, c.upAgain
	required := c.linkRequired && !link
	c.mu.Unlock()
	if down && !c.unreachable(w, r, kind, upAgain) {
		return
	}
	if _, daemon := linkDaemonRoute(r.Method, path); required && daemon {
		w.WriteHeader(http.StatusUpgradeRequired)
		_, _ = w.Write([]byte(`{"code":"UPGRADE_REQUIRED","message":"the runner link carries this route"}`))
		return
	}
	switch {
	case strings.HasSuffix(path, "/activate-leases"):
		c.activate(w, body)
		return
	case strings.HasSuffix(path, "/release-leases"):
		c.release(w, body)
		return
	case strings.HasSuffix(path, "/inbox"):
		c.inbox(w, r, link)
		return
	case strings.HasSuffix(path, "/turn-complete"):
		var req TurnCompleteRequest
		_ = json.Unmarshal(body, &req)
		c.mu.Lock()
		c.completions = append(c.completions, req)
		if c.inFlight != nil && c.inFlight.TurnID == req.TurnID {
			c.inFlight, c.inFlightGen = nil, ""
		}
		c.mu.Unlock()
		_, _ = w.Write([]byte(`{"ok":true,"status":"AWAITING_INPUT"}`))
		return
	case strings.HasSuffix(path, "/diff"):
		c.mu.Lock()
		c.diffs++
		c.mu.Unlock()
	case strings.HasSuffix(path, "/finalize"):
		var req RunFinalizeRequest
		_ = json.Unmarshal(body, &req)
		c.mu.Lock()
		c.finalizes = append(c.finalizes, req)
		c.mu.Unlock()
	case strings.HasSuffix(path, "/takeover-leases"):
		c.mu.Lock()
		status := c.takeoverStatus
		c.mu.Unlock()
		if status != 0 {
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"message":"session does not belong to this runner"}`))
			return
		}
		_, _ = w.Write([]byte(`{"status":"AWAITING_INPUT"}`))
		return
	}
	_, _ = w.Write([]byte(`{}`))
}

// unreachable answers a request while the control plane is down, as kind says, and reports whether the request goes on
// to be served: a silent one is, once the control plane is back before its runner gave up on it.
func (c *releaseOutageControlPlane) unreachable(w http.ResponseWriter, r *http.Request, kind string, upAgain chan struct{}) bool {
	switch kind {
	case "reset":
		if conn, _, err := w.(http.Hijacker).Hijack(); err == nil {
			_ = conn.Close()
			return false
		}
	case "silent":
		select {
		case <-upAgain:
			return true
		case <-r.Context().Done():
			return false
		}
	}
	w.WriteHeader(http.StatusServiceUnavailable)
	_, _ = w.Write([]byte(`{"code":"DATABASE_UNAVAILABLE","message":"the database is unavailable","retryable":true}`))
	return false
}

func (c *releaseOutageControlPlane) activate(w http.ResponseWriter, body []byte) {
	var req struct {
		LeaseGeneration string `json:"leaseGeneration"`
	}
	_ = json.Unmarshal(body, &req)
	c.mu.Lock()
	defer c.mu.Unlock()
	gen := req.LeaseGeneration
	refused := c.retired[gen] || (c.generation != "" && c.generation != gen && !c.retired[c.generation])
	c.activations = append(c.activations, releaseOutageCall{generation: gen, at: time.Now(), ok: !refused})
	if refused {
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"message":"another inbox generation is active"}`))
		return
	}
	c.generation = gen
	if c.inFlight != nil && c.inFlightGen != gen {
		// Every message turn another generation leased is handed out again (activateLeases).
		c.queue = append([]RunInboxResponse{*c.inFlight}, c.queue...)
		c.inFlight, c.inFlightGen = nil, ""
	}
	_, _ = w.Write([]byte(`{"ok":true,"abandonedSteers":[]}`))
}

func (c *releaseOutageControlPlane) release(w http.ResponseWriter, body []byte) {
	var req struct {
		LeaseGeneration string `json:"leaseGeneration"`
	}
	_ = json.Unmarshal(body, &req)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.releaseStatus != 0 {
		c.releases = append(c.releases, releaseOutageCall{generation: req.LeaseGeneration, at: time.Now()})
		w.WriteHeader(c.releaseStatus)
		_, _ = w.Write([]byte(`{"message":"session does not belong to this runner"}`))
		return
	}
	c.retired[req.LeaseGeneration] = true
	c.releases = append(c.releases, releaseOutageCall{generation: req.LeaseGeneration, at: time.Now(), ok: true})
	if c.inFlight != nil && c.inFlightGen == req.LeaseGeneration {
		c.queue = append([]RunInboxResponse{*c.inFlight}, c.queue...)
		c.inFlight, c.inFlightGen = nil, ""
	}
	_, _ = w.Write([]byte(`{"ok":true}`))
}

// inbox is dequeueTurn: under the generation the fetch names, the next control turn, or the next message turn while
// none is leased. Over HTTPS it waits for one as the long poll does, looking again under the lock each time, and never
// at whether its runner still waits.
func (c *releaseOutageControlPlane) inbox(w http.ResponseWriter, r *http.Request, link bool) {
	gen := r.URL.Query().Get("leaseGeneration")
	deadline := time.Now()
	if !link {
		deadline = deadline.Add(c.longPoll)
	}
	for {
		c.mu.Lock()
		if c.down {
			c.mu.Unlock()
			w.WriteHeader(http.StatusServiceUnavailable) // the dequeue fails with the database
			return
		}
		c.fetches = append(c.fetches, releaseOutageCall{generation: gen, at: time.Now(), ok: gen == c.generation && !c.retired[gen]})
		if gen != c.generation || c.retired[gen] {
			c.mu.Unlock()
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"message":"inbox lease generation is missing or retired"}`))
			return
		}
		var turn *RunInboxResponse
		for i, next := range c.queue {
			executable := next.Kind == "message" || next.Kind == "shell"
			if executable && c.inFlight != nil {
				continue
			}
			c.queue = append(c.queue[:i:i], c.queue[i+1:]...)
			picked := next
			turn = &picked
			if executable {
				c.inFlight, c.inFlightGen = &picked, gen
			}
			break
		}
		if turn != nil {
			c.handedOut = append(c.handedOut, releaseOutageHandOut{turn: *turn, generation: gen, at: time.Now(), eaten: r.Context().Err() != nil})
			c.mu.Unlock()
			_ = json.NewEncoder(w).Encode(turn)
			return
		}
		c.mu.Unlock()
		if !time.Now().Before(deadline) {
			_, _ = w.Write([]byte(`{"turnId":"","seq":0,"kind":"message"}`))
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (c *releaseOutageControlPlane) queueTurn(turn RunInboxResponse) {
	c.mu.Lock()
	c.queue = append(c.queue, turn)
	c.mu.Unlock()
}

func (c *releaseOutageControlPlane) setDown(kind string) {
	c.mu.Lock()
	c.down, c.downKind, c.upAgain = true, kind, make(chan struct{})
	c.mu.Unlock()
}

func (c *releaseOutageControlPlane) setUp() {
	c.mu.Lock()
	c.down = false
	close(c.upAgain)
	c.mu.Unlock()
}

func (c *releaseOutageControlPlane) completed(turnID string) *TurnCompleteRequest {
	c.mu.Lock()
	defer c.mu.Unlock()
	for i := range c.completions {
		if c.completions[i].TurnID == turnID {
			req := c.completions[i]
			return &req
		}
	}
	return nil
}

// releasedAfter is the first release of gen the control plane took at or after since, if there is one.
func (c *releaseOutageControlPlane) releasedAfter(gen string, since time.Time) (time.Time, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, rel := range c.releases {
		if rel.ok && rel.generation == gen && !rel.at.Before(since) {
			return rel.at, true
		}
	}
	return time.Time{}, false
}

func (c *releaseOutageControlPlane) snapshot() (activations, releases, fetches []releaseOutageCall, handed []releaseOutageHandOut,
	completions []TurnCompleteRequest, finalizes []RunFinalizeRequest, diffs int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]releaseOutageCall(nil), c.activations...), append([]releaseOutageCall(nil), c.releases...),
		append([]releaseOutageCall(nil), c.fetches...), append([]releaseOutageHandOut(nil), c.handedOut...),
		append([]TurnCompleteRequest(nil), c.completions...), append([]RunFinalizeRequest(nil), c.finalizes...), c.diffs
}

// releaseOutageRig is one claude session under runInteractiveSession, on a pool with a fake clock, against
// releaseOutageControlPlane: over HTTPS, or over the link (link set), with RUNNER_LINK_REQUIRED's 426 on HTTPS.
type releaseOutageRig struct {
	t     *testing.T
	cp    *releaseOutageControlPlane
	link  *linkWorkRig
	pool  *sessionPool
	clock *fakePoolClock
	fake  *fakeClaude
	job   *ClaimedSession
	live  *liveSession
	// end cancels the session (a person ending it), stop the runner; done is closed once the supervisor returned.
	end, stop context.CancelFunc
	done      chan struct{}
}

// releaseOutageScript answers each turn the engine is handed, and is the script of every spawn: the first, and the
// cold resume after the recycle.
var releaseOutageScript = []fakeStep{
	{Await: "user"},
	{Emit: "replay_user"},
	{Emit: "system_init"},
	{Emit: "assistant", Text: "done"},
	{Emit: "result", Text: "done"},
}

func superviseThroughReleaseOutage(t *testing.T, overLink bool) *releaseOutageRig {
	t.Helper()
	return superviseThroughReleaseOutageWith(t, overLink, nil)
}

// superviseThroughReleaseOutageWith is superviseThroughReleaseOutage with ingest, over the link, set up as the test says
// before the session hands it anything.
func superviseThroughReleaseOutageWith(t *testing.T, overLink bool, ingest func(*fakeIngest)) *releaseOutageRig {
	t.Helper()
	cp := newReleaseOutageControlPlane()
	rig := &releaseOutageRig{t: t, cp: cp, clock: newFakePoolClock(), done: make(chan struct{})}
	rig.pool = newSessionPoolWithClock(2, rig.clock)
	rig.fake = newFakeClaude(t, releaseOutageScript...)
	t.Setenv("PATH", rig.fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	rig.job = claudeSpawnJob(t)
	rig.job.Agent.Env = map[string]string{"ANTHROPIC_API_KEY": "test"}
	var transport *Transport
	if overLink {
		r, in := newLinkEventsRig(t) // its gateway stores the session's events
		if ingest != nil {
			in.mu.Lock()
			ingest(in)
			in.mu.Unlock()
		}
		rig.link = r
		cp.linkRequired = true
		r.g.mu.Lock()
		r.g.backend = func(c *fakeWorkConn, rpc *linkpb.Rpc) *linkpb.RpcResult {
			tun := rpc.GetTunnel()
			req := httptest.NewRequest(tun.GetMethod(), "/api"+tun.GetPath(), bytes.NewReader(tun.GetJsonBody()))
			req.Header.Set(releaseOutageViaLink, "1")
			rec := httptest.NewRecorder()
			cp.serve(rec, req)
			return fakeWorkAnswer(rpc, rec.Code, rec.Body.String())
		}
		r.g.mu.Unlock()
		r.cp.mu.Lock()
		r.cp.delegate = cp.serve
		r.cp.mu.Unlock()
		r.useLink(t)
		transport = r.t
	} else {
		api := httptest.NewServer(http.HandlerFunc(cp.serve))
		t.Cleanup(api.Close)
		transport = NewTransport(api.URL, "runner-token")
	}
	cp.queueTurn(RunInboxResponse{TurnID: "turn-1", Kind: "message", Content: "start the build"})
	ctx, end := context.WithCancel(context.Background())
	runner, stop := context.WithCancel(context.Background())
	rig.end, rig.stop = end, stop
	live, added := rig.pool.register(rig.job, end, true)
	if !added {
		t.Fatal("the session was not registered")
	}
	rig.live = live
	execDir := t.TempDir()
	go func() {
		defer close(rig.done)
		runInteractiveSession(transport, rig.job, ctx, runner, execDir, nil, rig.pool, live)
		rig.pool.finish(live)
	}()
	t.Cleanup(func() {
		cp.mu.Lock()
		if cp.down {
			cp.down = false
			close(cp.upAgain)
		}
		cp.mu.Unlock()
		if rig.link != nil {
			rig.linkUp()
		}
		end()
		select {
		case <-rig.done:
		case <-time.After(60 * time.Second):
			t.Error("the supervisor did not return after its session was cancelled")
		}
		stop()
	})
	return rig
}

// setDown makes the control plane unreachable, as kind says over HTTPS; over the link the gateway goes down too, with
// the link-token route that the runner reconnects through.
func (r *releaseOutageRig) setDown(kind string) {
	r.cp.setDown(kind)
	if r.link == nil {
		return
	}
	r.link.g.mu.Lock()
	r.link.g.refuse = func(*http.Request) (int, string, string) {
		return http.StatusServiceUnavailable, "the cell is down", ""
	}
	r.link.g.mu.Unlock()
	r.link.cp.mu.Lock()
	r.link.cp.tokenStatus = http.StatusServiceUnavailable
	r.link.cp.mu.Unlock()
	for _, c := range r.link.g.open() {
		c.drop()
	}
}

func (r *releaseOutageRig) setUp() {
	r.cp.setUp()
	if r.link != nil {
		r.linkUp()
	}
}

func (r *releaseOutageRig) linkUp() {
	r.link.g.mu.Lock()
	r.link.g.refuse = nil
	r.link.g.mu.Unlock()
	r.link.cp.mu.Lock()
	r.link.cp.tokenStatus = 0
	r.link.cp.mu.Unlock()
}

func (r *releaseOutageRig) returned() bool {
	select {
	case <-r.done:
		return true
	default:
		return false
	}
}

// parkAndRecycle waits for turn-1 to be acknowledged and parked, makes the control plane unreachable as kind says, and
// has the pool recycle the idle engine, as its warm TTL does. It returns the generation the engine had, and when the
// engine was gone.
func (r *releaseOutageRig) parkAndRecycle(kind string) (string, time.Time) {
	r.t.Helper()
	linkWaitFor(r.t, 20*time.Second, "turn-1 acknowledged and parked", func() bool {
		return r.cp.completed("turn-1") != nil && !r.pool.isActive(r.live)
	})
	r.cp.mu.Lock()
	gen := r.cp.generation
	r.cp.mu.Unlock()
	if gen == "" {
		r.t.Fatal("no inbox generation was activated for turn-1")
	}
	r.setDown(kind)
	r.clock.Advance(warmEngineTTL + time.Second)
	if !recycleRequested(r.pool, r.live) {
		r.t.Fatal("the warm TTL did not recycle the idle engine")
	}
	linkWaitFor(r.t, 20*time.Second, "the recycled engine to be gone", func() bool { return !r.pool.engineResident(r.live) })
	return gen, time.Now()
}

// claim is the claim of the next message, as runLoop hands it over.
func (r *releaseOutageRig) claim(turn RunInboxResponse) {
	r.t.Helper()
	r.cp.queueTurn(turn)
	claim := *r.job
	if _, ok := r.pool.activate(&claim); !ok {
		r.t.Fatal("the claim could not activate the session")
	}
}

// The engine of an idle session is recycled just as the control plane becomes unreachable, and stays so well past the
// bound of one release. Over HTTPS (the connection cut, DATABASE_UNAVAILABLE, no answer at all) and over the link (the
// cell down, gateway and all): the session is not failed and its supervisor goes on; the release lands once the control
// plane is back, ahead of anything else the session does — no activation, though the next message was claimed during
// the outage, and never a fetch under the stopped generation; that message is answered by a new engine; and the control
// turn queued during the outage is handed out once, to the new generation, and acted on once. No turn is handed to a
// fetch nobody waits for.
func TestAnEngineStoppingWhileTheControlPlaneIsUnreachableDoesNotFailTheSession(t *testing.T) {
	cases := []struct {
		name     string
		overLink bool
		kind     string
	}{
		{name: "https connection cut", kind: "reset"},
		{name: "https database unavailable", kind: "503"},
		{name: "https no answer", kind: "silent"},
		{name: "link cell down", overLink: true, kind: "503"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			outage := releaseOutageFor(t)
			rig := superviseThroughReleaseOutage(t, tc.overLink)
			stopped, engineGone := rig.parkAndRecycle(tc.kind)

			// A control turn the control plane takes while the runner cannot reach it: a person asked for the diff.
			rig.cp.queueTurn(RunInboxResponse{TurnID: "diff-1", Kind: "diff"})
			deadline := engineGone.Add(outage)
			claimed := false
			for time.Now().Before(deadline) {
				if rig.returned() {
					t.Fatalf("the supervisor returned %s into the outage", time.Since(engineGone).Round(time.Millisecond))
				}
				if !claimed && time.Until(deadline) < outage/2 {
					// The next message, claimed while the stopped generation is not released yet: it waits for the release.
					rig.claim(RunInboxResponse{TurnID: "turn-2", Kind: "message", Content: "and now the next thing"})
					claimed = true
				}
				time.Sleep(50 * time.Millisecond)
			}
			_, _, _, _, completions, finalizes, _ := rig.cp.snapshot()
			if len(finalizes) > 0 || rig.returned() {
				t.Fatalf("after %s of outage the session was finalized %+v (supervisor returned: %v)", outage, finalizes, rig.returned())
			}
			for _, c := range completions {
				if c.Status == stFailed {
					t.Fatalf("a turn was completed FAILED during the outage: %+v", c)
				}
			}

			back := time.Now()
			rig.setUp()
			within := 15 * time.Second
			if tc.overLink {
				within += linkBackoffMax // the reconnect's backoff, up to a minute after a long outage
			}
			var released time.Time
			linkWaitFor(t, within, "the stopped generation's release to land", func() bool {
				if _, _, _, _, _, finalizes, _ := rig.cp.snapshot(); len(finalizes) > 0 {
					t.Fatalf("once the control plane was back the session was finalized %+v, its generation never released", finalizes)
				}
				var ok bool
				released, ok = rig.cp.releasedAfter(stopped, back)
				return ok
			})
			t.Logf("the generation of the engine recycled as an outage of %s began was released %s after the control plane came back",
				outage, released.Sub(back).Round(time.Millisecond))

			linkWaitFor(t, 30*time.Second, "turn-2 answered and the diff sent", func() bool {
				_, _, _, _, _, _, diffs := rig.cp.snapshot()
				return rig.cp.completed("turn-2") != nil && diffs > 0
			})
			time.Sleep(300 * time.Millisecond) // anything handed out twice would arrive by now

			activations, _, fetches, handed, completions, finalizes, diffs := rig.cp.snapshot()
			if got := rig.cp.completed("turn-2"); got.Status != stSucceeded {
				t.Errorf("turn-2 completed %+v, want SUCCEEDED", got)
			}
			if len(finalizes) > 0 || rig.returned() {
				t.Errorf("the session was finalized %+v (supervisor returned: %v)", finalizes, rig.returned())
			}
			for _, c := range completions {
				if c.Status == stFailed {
					t.Errorf("a turn was completed FAILED: %+v", c)
				}
			}
			// Nothing activated before the release: the session took no turn until its old generation was retired.
			next := ""
			for _, a := range activations {
				if a.generation != stopped && a.ok {
					next = a.generation
					if a.at.Before(released) {
						t.Errorf("generation %s was activated at %s, before the stopped one was released at %s", a.generation, a.at, released)
					}
				}
			}
			if next == "" {
				t.Fatalf("no generation was activated after the outage: %+v", activations)
			}
			for _, f := range fetches {
				if f.generation == stopped && f.at.After(engineGone) {
					t.Errorf("a fetch under the stopped generation reached the control plane at %s, after its engine was gone at %s", f.at, engineGone)
				}
			}
			counts := map[string]int{}
			for _, h := range handed {
				counts[h.turn.TurnID]++
				if h.eaten {
					t.Errorf("%s (%s) was handed out to a fetch whose runner no longer waited", h.turn.TurnID, h.turn.Kind)
				}
				if h.turn.TurnID == "diff-1" && h.generation != next {
					t.Errorf("the diff was handed out to generation %s, not the new one %s", h.generation, next)
				}
			}
			if counts["diff-1"] != 1 || diffs != 1 {
				t.Errorf("the diff was handed out %d times and sent %d times, want once each", counts["diff-1"], diffs)
			}
			if counts["turn-1"] != 1 || counts["turn-2"] != 1 {
				t.Errorf("turns handed out %v, want turn-1 and turn-2 once each", counts)
			}
			if n := len(rig.fake.Spawns()); n != 2 {
				t.Errorf("claude was spawned %d times, want 2: the first engine and the one after the outage", n)
			}
		})
	}
}

// A release refused for the lease — the session moved to another runner, or another process took it over — is no
// outage: it ends the supervisor at once, as it always has, and the session is left to whoever holds it (the takeover
// check before finalization detaches it). It is not sent again and again.
func TestAReleaseRefusedForTheLeaseStillEndsTheSupervisor(t *testing.T) {
	for _, overLink := range []bool{false, true} {
		t.Run(fmt.Sprintf("link %v", overLink), func(t *testing.T) {
			releaseOutageFor(t) // for its shortened release bound only
			rig := superviseThroughReleaseOutage(t, overLink)
			linkWaitFor(t, 20*time.Second, "turn-1 acknowledged and parked", func() bool {
				return rig.cp.completed("turn-1") != nil && !rig.pool.isActive(rig.live)
			})
			rig.cp.mu.Lock()
			rig.cp.releaseStatus, rig.cp.takeoverStatus = http.StatusForbidden, http.StatusForbidden
			rig.cp.mu.Unlock()
			rig.clock.Advance(warmEngineTTL + time.Second)
			select {
			case <-rig.done:
			case <-time.After(20 * time.Second):
				t.Fatal("the supervisor went on after its release was refused for the lease")
			}
			_, releases, _, _, _, finalizes, _ := rig.cp.snapshot()
			if len(finalizes) != 0 {
				t.Errorf("the session was finalized %+v by a process that lost it", finalizes)
			}
			// The release after the stop, and the final one on the way out: never a loop.
			if len(releases) > 2 {
				t.Errorf("the refused release was sent %d times", len(releases))
			}
		})
	}
}

// The release goes again only while the session lives and the runner runs. A runner that stops during the outage has
// its supervisor detach the session as resumable, without finalizing it; a session ended during the outage goes on to
// its finalization.
func TestTheReleaseGoesAgainOnlyWhileTheSessionLivesAndTheRunnerRuns(t *testing.T) {
	t.Run("the runner stops", func(t *testing.T) {
		releaseOutageFor(t)
		rig := superviseThroughReleaseOutage(t, false)
		rig.parkAndRecycle("reset")
		time.Sleep(3 * finalLeaseReleaseTimeout) // retrying by now
		stopped := time.Now()
		rig.stop()
		select {
		case <-rig.done:
		case <-time.After(3*finalLeaseReleaseTimeout + 20*time.Second):
			t.Fatal("the supervisor went on retrying the release after the runner stopped")
		}
		t.Logf("the supervisor returned %s after the runner stopped", time.Since(stopped).Round(time.Millisecond))
		if _, _, _, _, _, finalizes, _ := rig.cp.snapshot(); len(finalizes) != 0 {
			t.Errorf("a stopping runner finalized the session %+v; it detaches it, resumable", finalizes)
		}
	})
	t.Run("the session is ended", func(t *testing.T) {
		releaseOutageFor(t)
		rig := superviseThroughReleaseOutage(t, false)
		rig.parkAndRecycle("reset")
		time.Sleep(3 * finalLeaseReleaseTimeout)
		rig.end()
		linkWaitFor(t, 3*finalLeaseReleaseTimeout+20*time.Second, "the ended session's finalization to be attempted", func() bool {
			rig.cp.mu.Lock()
			defer rig.cp.mu.Unlock()
			for _, p := range rig.cp.paths {
				if strings.HasSuffix(p, "/takeover-leases") || strings.HasSuffix(p, "/finalize") {
					return true
				}
			}
			return false
		})
		rig.setUp()
		select {
		case <-rig.done:
		case <-time.After(30 * time.Second):
			t.Fatal("the ended session's supervisor did not return once the control plane was back")
		}
		_, _, _, _, _, finalizes, _ := rig.cp.snapshot()
		if len(finalizes) != 1 || finalizes[0].Status != stCancelled {
			t.Errorf("the ended session was finalized %+v, want once, CANCELLED", finalizes)
		}
	})
}
