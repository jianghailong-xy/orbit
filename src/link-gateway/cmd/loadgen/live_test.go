package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	"orbit/link-gateway/linkpb"
)

// watchGateway is a gateway with watchers (live.go): it acknowledges heartbeats and event batches, says who watches
// which session as the link gateway does (a Hint{watchers} after Welcome for each session watched, and the whole
// HintState in every HeartbeatAck), asks each connection's runner for its session's turn prefix once, and records every
// LiveBatch and TurnPrefixResponse it is sent.
type watchGateway struct {
	mu          sync.Mutex
	watched     map[string]bool
	conns       map[string]*watchConn // by session: the connection of the runner that streams it
	stored      map[string]uint64
	live        map[string][]liveSeen
	prefixes    map[string]*linkpb.TurnPrefixResponse // by request id; nil until answered
	unwatchedAt map[string]time.Time
}

type watchConn struct {
	ws  *websocket.Conn
	wmu sync.Mutex
}

func (c *watchConn) write(f *linkpb.Frame) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	b, _ := proto.Marshal(f)
	return c.ws.Write(context.Background(), websocket.MessageBinary, b)
}

type liveSeen struct {
	at    time.Time
	conn  int
	batch *linkpb.LiveBatch
}

func newWatchGateway(watched ...string) *watchGateway {
	g := &watchGateway{watched: map[string]bool{}, conns: map[string]*watchConn{}, stored: map[string]uint64{},
		live: map[string][]liveSeen{}, prefixes: map[string]*linkpb.TurnPrefixResponse{}, unwatchedAt: map[string]time.Time{}}
	for _, s := range watched {
		g.watched[s] = true
	}
	return g
}

func (g *watchGateway) hintState() *linkpb.HintState {
	g.mu.Lock()
	defer g.mu.Unlock()
	h := &linkpb.HintState{}
	for s, on := range g.watched {
		if on {
			h.Watchers = append(h.Watchers, &linkpb.WatchersHint{SessionId: s, Watchers: 1})
		}
	}
	return h
}

// unwatch says nobody watches the session any more: a Hint{watchers: 0} to its runner, and HintStates without it.
func (g *watchGateway) unwatch(session string) {
	g.mu.Lock()
	g.watched[session] = false
	g.unwatchedAt[session] = time.Now()
	c := g.conns[session]
	g.mu.Unlock()
	if c != nil {
		_ = c.write(&linkpb.Frame{Body: &linkpb.Frame_Hint{Hint: &linkpb.Hint{Kind: &linkpb.Hint_Watchers{
			Watchers: &linkpb.WatchersHint{SessionId: session, Watchers: 0}}}}})
	}
}

var watchConnSeq struct {
	sync.Mutex
	n int
}

func (g *watchGateway) serveHTTP(w http.ResponseWriter, r *http.Request) {
	ws, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	ws.SetReadLimit(readLimit)
	c := &watchConn{ws: ws}
	watchConnSeq.Lock()
	watchConnSeq.n++
	n := watchConnSeq.n
	watchConnSeq.Unlock()
	read := func() (*linkpb.Frame, error) {
		_, data, err := ws.Read(r.Context())
		if err != nil {
			return nil, err
		}
		f := &linkpb.Frame{}
		return f, proto.Unmarshal(data, f)
	}
	first, err := read()
	if err != nil || first.GetHello() == nil {
		_ = ws.CloseNow()
		return
	}
	var streamed string // the runner's running session: the one Hello names first, as the fleet below has it
	var states []*linkpb.SessionState
	g.mu.Lock()
	for _, named := range first.GetHello().GetSessions() {
		if strings.HasSuffix(named.GetSessionId(), "-0") {
			streamed = named.GetSessionId()
			g.conns[streamed] = c
		}
		states = append(states, &linkpb.SessionState{SessionId: named.GetSessionId(), DurableSeq: g.stored[named.GetSessionId()], LeaseHeld: true})
	}
	g.mu.Unlock()
	// Welcome's HintState is empty, as the link gateway's is: who watches comes after.
	if err := c.write(&linkpb.Frame{Body: &linkpb.Frame_Welcome{Welcome: &linkpb.Welcome{ProtocolVersion: 1, Mode: linkpb.Mode_MODE_LINK,
		HeartbeatIntervalMs: 200, ConnectionId: fmt.Sprintf("c-%d", n), Sessions: states, Hints: &linkpb.HintState{},
		Credit: &linkpb.Credit{MaxUnackedEvents: 10_000, MaxUnackedBytes: 64 << 20}}}}); err != nil {
		return
	}
	for _, wh := range g.hintState().GetWatchers() {
		if wh.GetSessionId() == streamed {
			_ = c.write(&linkpb.Frame{Body: &linkpb.Frame_Hint{Hint: &linkpb.Hint{Kind: &linkpb.Hint_Watchers{Watchers: wh}}}})
		}
	}
	requestID := fmt.Sprintf("prefix-%d", n)
	g.mu.Lock()
	g.prefixes[requestID] = nil
	g.mu.Unlock()
	_ = c.write(&linkpb.Frame{Body: &linkpb.Frame_TurnPrefixRequest{TurnPrefixRequest: &linkpb.TurnPrefixRequest{RequestId: requestID, SessionId: streamed}}})
	for {
		f, err := read()
		if err != nil {
			return
		}
		switch body := f.GetBody().(type) {
		case *linkpb.Frame_Heartbeat:
			_ = c.write(&linkpb.Frame{Body: &linkpb.Frame_HeartbeatAck{HeartbeatAck: &linkpb.HeartbeatAck{Mode: linkpb.Mode_MODE_LINK,
				ReconcileJson: []byte(`{"cancelSessionIds":[],"leaseLostSessionIds":[]}`), Hints: g.hintState()}}})
		case *linkpb.Frame_EventBatch:
			g.mu.Lock()
			durable := g.stored[body.EventBatch.GetSessionId()]
			for _, e := range body.EventBatch.GetEvents() {
				if e.GetSeq() == durable+1 {
					durable = e.GetSeq()
				}
			}
			g.stored[body.EventBatch.GetSessionId()] = durable
			g.mu.Unlock()
			_ = c.write(&linkpb.Frame{Body: &linkpb.Frame_EventAck{EventAck: &linkpb.EventAck{SessionId: body.EventBatch.GetSessionId(), DurableSeq: durable}}})
		case *linkpb.Frame_LiveBatch:
			g.mu.Lock()
			g.live[body.LiveBatch.GetSessionId()] = append(g.live[body.LiveBatch.GetSessionId()], liveSeen{at: time.Now(), conn: n, batch: body.LiveBatch})
			g.mu.Unlock()
		case *linkpb.Frame_TurnPrefixResponse:
			g.mu.Lock()
			if _, asked := g.prefixes[body.TurnPrefixResponse.GetRequestId()]; asked {
				g.prefixes[body.TurnPrefixResponse.GetRequestId()] = body.TurnPrefixResponse
			}
			g.mu.Unlock()
		}
	}
}

// playWatched plays three runners, each with one running session (session-<i>-0) and one idle one, against gw, with
// liveRate; during the run it calls during(start of the steady window) once.
func playWatched(t *testing.T, gw *watchGateway, liveRate float64, during func()) *summary {
	t.Helper()
	link := httptest.NewServer(http.HandlerFunc(gw.serveHTTP))
	defer link.Close()
	linkURL := "ws" + strings.TrimPrefix(link.URL, "http")
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/runner/link-token" {
			http.Error(w, "no", http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"token": "t", "linkUrl": linkURL,
			"expiresAt": time.Now().Add(1500 * time.Millisecond).UTC().Format(time.RFC3339Nano)})
	}))
	defer api.Close()
	dir := t.TempDir()
	var lines []string
	for i := 0; i < 3; i++ {
		fr := fleetRunner{Runner: newUUID(rand.New(rand.NewPCG(11, uint64(i)))), Token: fmt.Sprintf("tok-%d", i), Process: fmt.Sprintf("proc-%d", i),
			Sessions: []string{fmt.Sprintf("session-%d-0", i), fmt.Sprintf("session-%d-1", i)},
			Active:   []activeSession{{ID: fmt.Sprintf("session-%d-0", i)}}}
		b, _ := json.Marshal(fr)
		lines = append(lines, string(b))
	}
	fleet := filepath.Join(dir, "fleet.jsonl")
	if err := os.WriteFile(fleet, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	g, err := newLoadgen(options{fleet: fleet, api: api.URL, out: dir, rampRate: 100, duration: 3 * time.Second,
		drainTimeout: 5 * time.Second, interval: time.Second, eventRate: 60, flushMin: 30 * time.Millisecond,
		flushMax: 120 * time.Millisecond, maxBatch: 10, renewBefore: 500 * time.Millisecond, settle: 200 * time.Millisecond,
		seed: 5, liveRate: liveRate})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if during != nil {
		go func() {
			// The steady window opens once all three are connected and the settle has passed.
			for g.ever.Load() < 3 {
				time.Sleep(10 * time.Millisecond)
			}
			time.Sleep(time.Second)
			during()
		}()
	}
	sum, _ := g.run(ctx)
	if sum == nil || sum.Steady == nil {
		t.Fatalf("no steady window: %+v", sum)
	}
	if sum.Unacknowledged != 0 || len(sum.Whole.Errors) != 0 {
		t.Errorf("the durable stream: %d unacknowledged, errors %v %v", sum.Unacknowledged, sum.Whole.Errors, sum.ErrorSamples)
	}
	return sum
}

// jsonKeys is every object key anywhere in v as JSON.
func jsonKeys(t *testing.T, v any) map[string]bool {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var anyv any
	if err := json.Unmarshal(b, &anyv); err != nil {
		t.Fatal(err)
	}
	keys := map[string]bool{}
	var walk func(any)
	walk = func(x any) {
		switch x := x.(type) {
		case map[string]any:
			for k, v := range x {
				keys[k] = true
				walk(v)
			}
		case []any:
			for _, v := range x {
				walk(v)
			}
		}
	}
	walk(anyv)
	return keys
}

// TestNoLiveBatchWithoutTheLiveRate: at the default -live-rate of 0 nothing of the live stream is sent or written,
// even with every running session watched and its turn prefix asked for, so a run without the flag, and its report,
// are what they were before task O3 and every earlier baseline stays comparable. The prefix requests are answered.
func TestNoLiveBatchWithoutTheLiveRate(t *testing.T) {
	gw := newWatchGateway("session-0-0", "session-1-0", "session-2-0")
	sum := playWatched(t, gw, 0, nil)
	gw.mu.Lock()
	defer gw.mu.Unlock()
	for s, seen := range gw.live {
		t.Errorf("%d LiveBatch frames for %s without -live-rate", len(seen), s)
	}
	answered := 0
	for id, resp := range gw.prefixes {
		if resp == nil {
			t.Errorf("turn prefix request %s was not answered", id)
			continue
		}
		answered++
		if resp.GetThroughLiveSeq() != 0 || resp.GetText() != "" {
			t.Errorf("turn prefix answer %s: %v", id, resp)
		}
	}
	if answered == 0 {
		t.Fatal("no turn prefix request was asked")
	}
	keys := jsonKeys(t, sum)
	for k := range keys {
		if strings.Contains(strings.ToLower(k), "live") || k == "watched" {
			t.Errorf("summary.json has %q without -live-rate", k)
		}
	}
	// What series.jsonl carries likewise.
	line := seriesLine{counters: sum.Whole.Counters, Errors: sum.Whole.Errors}
	for k := range jsonKeys(t, line) {
		if strings.Contains(strings.ToLower(k), "live") || k == "watched" {
			t.Errorf("series.jsonl has %q without -live-rate", k)
		}
	}
}

var stampRE = regexp.MustCompile(`^@@(\d{13})@@ `)

// TestLiveDeltasGoOnlyToWatchedSessions: with -live-rate, the deltas are sent on the running sessions the gateway says
// are watched and on no other, they stop when it says nobody watches any more, each LiveBatch holds what gathered in
// runner-go's 50 ms, live_seq rises without a repeat, each delta's text starts with when it was produced, and the
// summary counts what the gateway received. The durable stream goes on as before (playWatched).
func TestLiveDeltasGoOnlyToWatchedSessions(t *testing.T) {
	const rate = 300.0
	gw := newWatchGateway("session-0-0", "session-1-0")
	sum := playWatched(t, gw, rate, func() { gw.unwatch("session-1-0") })
	gw.mu.Lock()
	defer gw.mu.Unlock()
	if n := len(gw.live["session-2-0"]); n > 0 {
		t.Errorf("%d LiveBatch frames for session-2-0, which nobody watches", n)
	}
	if gw.unwatchedAt["session-1-0"].IsZero() {
		t.Fatal("session-1-0 was never unwatched")
	}
	var batches, events int64
	for session, seen := range gw.live {
		seqs := map[uint64]bool{}
		last := map[int]uint64{}
		for _, b := range seen {
			batches++
			evs := b.batch.GetEvents()
			events += int64(len(evs))
			if len(evs) == 0 {
				t.Errorf("%s: an empty LiveBatch", session)
				continue
			}
			// The Hint says so at once; a HintState without it comes with the runner's next HeartbeatAck (200 ms).
			if session == "session-1-0" && b.at.After(gw.unwatchedAt[session].Add(500*time.Millisecond)) {
				t.Errorf("%s: a LiveBatch %s after nobody watched it", session, b.at.Sub(gw.unwatchedAt[session]))
			}
			first, lastTs := evs[0].GetTsUnixMs(), evs[len(evs)-1].GetTsUnixMs()
			// Produced within one gathering: its 50 ms, and what a loop on a loaded host may be late by.
			if lastTs-first > (liveFlushEvery + 100*time.Millisecond).Milliseconds() {
				t.Errorf("%s: one LiveBatch spans %d ms of deltas", session, lastTs-first)
			}
			if waited := b.at.UnixMilli() - first; waited < (liveFlushEvery - 10*time.Millisecond).Milliseconds() {
				t.Errorf("%s: a LiveBatch went %d ms after its first delta, before the 50 ms gathering", session, waited)
			}
			for _, e := range evs {
				if e.GetType() != "text_delta" {
					t.Errorf("%s: a live event of type %q", session, e.GetType())
				}
				if seqs[e.GetLiveSeq()] || e.GetLiveSeq() <= last[b.conn] {
					t.Errorf("%s: live_seq %d after %d on connection %d", session, e.GetLiveSeq(), last[b.conn], b.conn)
				}
				seqs[e.GetLiveSeq()] = true
				last[b.conn] = e.GetLiveSeq()
				var p struct {
					Text string `json:"text"`
				}
				if err := json.Unmarshal(e.GetPayloadJson(), &p); err != nil {
					t.Fatalf("%s: payload %q: %v", session, e.GetPayloadJson(), err)
				}
				m := stampRE.FindStringSubmatch(p.Text)
				if m == nil || m[1] != strconv.FormatInt(e.GetTsUnixMs(), 10) {
					t.Errorf("%s: the delta's text %q does not start with its time %d", session, p.Text, e.GetTsUnixMs())
				}
				if n := len(e.GetPayloadJson()); n < 70 || n > 130 {
					t.Errorf("%s: a delta of %d bytes", session, n)
				}
			}
		}
	}
	w := sum.Whole.Counters
	if w.LiveEventsSent != events || w.LiveBatchesSent != batches {
		t.Errorf("the summary counts %d deltas in %d batches; the gateway received %d in %d", w.LiveEventsSent, w.LiveBatchesSent, events, batches)
	}
	if w.LiveEventsProduced < w.LiveEventsSent || w.TurnPrefixAnswers == 0 {
		t.Errorf("produced %d, sent %d, prefix answers %d", w.LiveEventsProduced, w.LiveEventsSent, w.TurnPrefixAnswers)
	}
	// The rate is the fleet's, shared by the sessions watched: about rate a second while the run generated.
	if min := int64(rate * 2); events < min {
		t.Errorf("%d deltas reached the gateway, want at least %d at %v/s over the run", events, min, rate)
	}
	keys := jsonKeys(t, sum)
	for _, k := range []string{"liveRate", "liveEventsSent", "liveBatchesSent", "liveEventsSentPerSecond"} {
		if !keys[k] {
			t.Errorf("summary.json lacks %q", k)
		}
	}
	t.Logf("deltas: produced %d, sent %d in %d batches, dropped %d; prefix answers %d", w.LiveEventsProduced, w.LiveEventsSent,
		w.LiveBatchesSent, w.LiveEventsDropped, w.TurnPrefixAnswers)
}
