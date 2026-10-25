package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	"orbit/link-gateway/linkpb"
)

func TestHistogramQuantilesAreWithinOnePercent(t *testing.T) {
	h := newHist()
	for i := 1; i <= 10_000; i++ {
		h.add(time.Duration(i)*time.Millisecond, 1)
	}
	for _, c := range []struct {
		q    float64
		want time.Duration
	}{{0.5, 5 * time.Second}, {0.99, 9900 * time.Millisecond}, {0.999, 9990 * time.Millisecond}} {
		got := h.quantile(c.q)
		if diff := float64(got-c.want) / float64(c.want); diff < 0 || diff > 0.0101 {
			t.Errorf("p%v = %s, want %s to within 1%% above", c.q*100, got, c.want)
		}
	}
	if h.quantile(1) != 10*time.Second || h.max != 10*time.Second {
		t.Errorf("the top quantile is %s and max %s, want the largest value, 10s", h.quantile(1), h.max)
	}
	other := newHist()
	other.add(time.Minute, 1)
	h.merge(other)
	if h.total != 10_001 || h.max != time.Minute {
		t.Errorf("merged: total %d max %s", h.total, h.max)
	}
}

func TestSessionEventsCycleWithToolCallsPaired(t *testing.T) {
	s := &session{id: "s", seq: 41}
	r := rand.New(rand.NewPCG(1, 2))
	var lastUse string
	for i := 0; i < 4*stepsPerTurn+4; i++ {
		ev, boundary := s.nextEvent(r, 1_700_000_000_000)
		if ev.GetSeq() != uint64(42+i) {
			t.Fatalf("event %d has seq %d", i, ev.GetSeq())
		}
		if want := cycle[i%len(cycle)]; ev.GetType() != want || boundary != (want == "tool_result") {
			t.Fatalf("event %d is %s (boundary %v), want %s", i, ev.GetType(), boundary, want)
		}
		var payload map[string]any
		if err := json.Unmarshal(ev.GetPayloadJson(), &payload); err != nil {
			t.Fatalf("event %d payload is not a JSON object: %v", i, err)
		}
		switch ev.GetType() {
		case "tool_use":
			lastUse, _ = payload["id"].(string)
		case "tool_result":
			if payload["toolUseId"] != lastUse || lastUse == "" {
				t.Fatalf("a result names %v, its call was %q", payload["toolUseId"], lastUse)
			}
		}
		if ev.GetTurnId() == "" {
			t.Fatalf("event %d has no turn", i)
		}
	}
}

func TestFactsCarryTheDigestOfTheirOwnBytes(t *testing.T) {
	facts := runnerFacts(7)
	kinds := map[string]bool{}
	for i, f := range facts {
		sum := sha256.Sum256(f.GetJson())
		if hex.EncodeToString(sum[:]) != f.GetSha256() || !json.Valid(f.GetJson()) {
			t.Errorf("fact %s: digest or JSON wrong", f.GetKind())
		}
		if d := digestsOf(facts)[i]; len(d.GetJson()) != 0 || d.GetSha256() != f.GetSha256() || d.GetKind() != f.GetKind() {
			t.Errorf("digest-only fact %s carries %d bytes", d.GetKind(), len(d.GetJson()))
		}
		kinds[f.GetKind()] = true
	}
	for _, kind := range []string{"engines", "modelCatalog", "commands", "skills", "runtimeDefaultModels", "runsAsRoot", "reposRoot", "selfUpdate", "repos"} {
		if !kinds[kind] {
			t.Errorf("no %s fact", kind)
		}
	}
}

// fakeGateway acknowledges heartbeats and stores event batches as the link gateway and the ingest do (stored once per
// seq, refused when a batch would leave a gap), states in Welcome where each session the Hello names stands, and
// misbehaves on purpose: every failEvery-th batch fails retryable, the cutConn-th connection is cut right after it
// stores its third batch, before acknowledging it, and a process's new connection supersedes its old one. With
// supersedeFirst the old connection is closed before the new one's Welcome is sent, so the runner sees its old
// connection end before its renewal's dial comes back.
type fakeGateway struct {
	t              *testing.T
	failEvery      int
	cutConn        int
	beat           time.Duration
	supersedeFirst bool

	mu       sync.Mutex
	stored   map[string][]uint64
	batches  int
	failed   int
	conns    int
	beats    int
	byProc   map[string]*websocket.Conn
	gaps     int
	welcomes int
	// helloSessions is how many sessions each Hello named, in order.
	helloSessions []int
}

func (f *fakeGateway) serveHTTP(w http.ResponseWriter, r *http.Request) {
	ws, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	ws.SetReadLimit(readLimit)
	ctx := r.Context()
	read := func() (*linkpb.Frame, error) {
		_, data, err := ws.Read(ctx)
		if err != nil {
			return nil, err
		}
		fr := &linkpb.Frame{}
		return fr, proto.Unmarshal(data, fr)
	}
	write := func(fr *linkpb.Frame) error {
		b, _ := proto.Marshal(fr)
		return ws.Write(ctx, websocket.MessageBinary, b)
	}
	first, err := read()
	if err != nil || first.GetHello() == nil {
		_ = ws.CloseNow()
		return
	}
	process := first.GetHello().GetProcessId()
	f.mu.Lock()
	f.conns++
	n := f.conns
	old := f.byProc[process]
	f.byProc[process] = ws
	f.welcomes++
	f.helloSessions = append(f.helloSessions, len(first.GetHello().GetSessions()))
	var states []*linkpb.SessionState
	for _, named := range first.GetHello().GetSessions() {
		var durable uint64
		if seqs := f.stored[named.GetSessionId()]; len(seqs) > 0 {
			durable = seqs[len(seqs)-1]
		}
		states = append(states, &linkpb.SessionState{SessionId: named.GetSessionId(), DurableSeq: durable, LeaseHeld: true})
	}
	f.mu.Unlock()
	supersede := func() {
		if old != nil {
			b, _ := proto.Marshal(&linkpb.Frame{Body: &linkpb.Frame_Close{Close: &linkpb.Close{Code: linkpb.CloseCode_CLOSE_CODE_SUPERSEDED}}})
			_ = old.Write(context.Background(), websocket.MessageBinary, b)
			_ = old.Close(websocket.StatusNormalClosure, "superseded")
		}
	}
	if f.supersedeFirst {
		supersede()
		time.Sleep(50 * time.Millisecond)
	}
	if err := write(&linkpb.Frame{Body: &linkpb.Frame_Welcome{Welcome: &linkpb.Welcome{ProtocolVersion: 1, Mode: linkpb.Mode_MODE_LINK,
		HeartbeatIntervalMs: uint32(f.beat / time.Millisecond), ConnectionId: fmt.Sprintf("c-%d", n), Sessions: states,
		Credit: &linkpb.Credit{MaxUnackedEvents: 10_000, MaxUnackedBytes: 64 << 20}}}}); err != nil {
		return
	}
	if !f.supersedeFirst {
		supersede()
	}
	batches := 0
	for {
		fr, err := read()
		if err != nil {
			return
		}
		if eb := fr.GetEventBatch(); eb != nil && n == f.cutConn {
			if batches++; batches == 3 {
				f.storeWhole(eb)
				_ = ws.CloseNow() // stored, and gone without a word: the next Welcome says so
				return
			}
		}
		switch body := fr.GetBody().(type) {
		case *linkpb.Frame_Heartbeat:
			f.mu.Lock()
			f.beats++
			f.mu.Unlock()
			_ = write(&linkpb.Frame{Body: &linkpb.Frame_HeartbeatAck{HeartbeatAck: &linkpb.HeartbeatAck{Mode: linkpb.Mode_MODE_LINK,
				ReconcileJson: []byte(`{"cancelSessionIds":[],"leaseLostSessionIds":[]}`)}}})
		case *linkpb.Frame_EventBatch:
			// The cut connection's batches are stored without failures, so the one it stores before it is cut follows
			// what is stored: what the next Welcome says.
			_ = write(&linkpb.Frame{Body: &linkpb.Frame_EventAck{EventAck: f.store(body.EventBatch, n != f.cutConn)}})
		}
	}
}

// storeWhole stores a batch with no failure injected, as the ingest does when its answer is what goes missing.
func (f *fakeGateway) storeWhole(eb *linkpb.EventBatch) {
	f.mu.Lock()
	defer f.mu.Unlock()
	seqs := f.stored[eb.GetSessionId()]
	for _, e := range eb.GetEvents() {
		if len(seqs) == 0 && e.GetSeq() == 1 || len(seqs) > 0 && e.GetSeq() == seqs[len(seqs)-1]+1 {
			seqs = append(seqs, e.GetSeq())
		}
	}
	f.stored[eb.GetSessionId()] = seqs
}

func (f *fakeGateway) store(eb *linkpb.EventBatch, inject bool) *linkpb.EventAck {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.batches++
	seqs := f.stored[eb.GetSessionId()]
	durable := uint64(0)
	if len(seqs) > 0 {
		durable = seqs[len(seqs)-1]
	}
	ack := &linkpb.EventAck{SessionId: eb.GetSessionId(), DurableSeq: durable}
	if eb.GetEvents()[0].GetSeq() > durable+1 {
		f.gaps++
		ack.Failure = &linkpb.Failure{Code: "EVENT_SEQ_GAP", Retryable: true}
		return ack
	}
	if inject && f.failEvery > 0 && f.batches%f.failEvery == 0 {
		f.failed++
		ack.Failure = &linkpb.Failure{Code: "TEST_FAILURE", Retryable: true, RetryAfterMs: 20}
		return ack
	}
	for _, e := range eb.GetEvents() {
		if e.GetSeq() == durable+1 {
			seqs = append(seqs, e.GetSeq())
			durable = e.GetSeq()
		}
	}
	f.stored[eb.GetSessionId()] = seqs
	ack.DurableSeq = durable
	return ack
}

// TestTheFleetStoresEveryEventOnceInOrder plays a small fleet against a gateway that fails batches, cuts a connection
// and supersedes renewed ones: every event produced is acknowledged and stored once, in seq order, and every failure is
// counted as an error.
func TestTheFleetStoresEveryEventOnceInOrder(t *testing.T) {
	for _, first := range []bool{false, true} {
		t.Run(fmt.Sprintf("supersededFirst=%v", first), func(t *testing.T) { playFleet(t, first) })
	}
}

func playFleet(t *testing.T, supersedeFirst bool) {
	fg := &fakeGateway{t: t, failEvery: 7, cutConn: 2, beat: 200 * time.Millisecond, supersedeFirst: supersedeFirst,
		stored: map[string][]uint64{}, byProc: map[string]*websocket.Conn{}}
	link := httptest.NewServer(http.HandlerFunc(fg.serveHTTP))
	defer link.Close()
	linkURL := "ws" + strings.TrimPrefix(link.URL, "http")
	var mints sync.Map
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/runner/link-token" || r.Header.Get("Authorization") == "" {
			http.Error(w, "no", http.StatusNotFound)
			return
		}
		n, _ := mints.LoadOrStore(r.Header.Get("Authorization"), new(int))
		*(n.(*int))++
		_ = json.NewEncoder(w).Encode(map[string]string{"token": "t", "linkUrl": linkURL,
			"expiresAt": time.Now().Add(1500 * time.Millisecond).UTC().Format(time.RFC3339Nano)})
	}))
	defer api.Close()

	dir := t.TempDir()
	var lines []string
	sessions := map[string]bool{}
	for i := 0; i < 3; i++ {
		fr := fleetRunner{Runner: newUUID(rand.New(rand.NewPCG(9, uint64(i)))), Token: fmt.Sprintf("tok-%d", i), Process: fmt.Sprintf("proc-%d", i)}
		for j := 0; j < 2; j++ {
			id := fmt.Sprintf("session-%d-%d", i, j)
			fr.Sessions = append(fr.Sessions, id)
			if j == 0 {
				fr.Active = append(fr.Active, activeSession{ID: id})
				sessions[id] = true
			}
		}
		b, _ := json.Marshal(fr)
		lines = append(lines, string(b))
	}
	fleet := filepath.Join(dir, "fleet.jsonl")
	if err := os.WriteFile(fleet, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	g, err := newLoadgen(options{fleet: fleet, api: api.URL, out: dir, rampRate: 100, duration: 3 * time.Second,
		drainTimeout: 5 * time.Second, interval: time.Second, eventRate: 150, flushMin: 30 * time.Millisecond,
		flushMax: 120 * time.Millisecond, maxBatch: 10, renewBefore: 500 * time.Millisecond, seed: 3})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	sum, _ := g.run(ctx)
	if sum == nil || sum.Steady == nil {
		t.Fatalf("no steady window: %+v", sum)
	}

	fg.mu.Lock()
	defer fg.mu.Unlock()
	t.Logf("gateway: %d connections, %d beats, %d batches (%d failed, %d gaps); loadgen: %+v, errors %v",
		fg.conns, fg.beats, fg.batches, fg.failed, fg.gaps, sum.Whole.Counters, sum.Whole.Errors)
	if sum.Unacknowledged != 0 {
		t.Errorf("%d events were never acknowledged", sum.Unacknowledged)
	}
	w := sum.Whole.Counters
	var stored int64
	for id, seqs := range fg.stored {
		if !sessions[id] {
			t.Errorf("events stored for %s, which streams none", id)
		}
		for k, seq := range seqs {
			if seq != uint64(k+1) {
				t.Fatalf("session %s: stored seq %d at position %d", id, seq, k)
			}
		}
		stored += int64(len(seqs))
	}
	if stored != w.EventsProduced || w.EventsAcked != w.EventsProduced || stored < 100 {
		t.Errorf("produced %d, acknowledged %d, stored %d", w.EventsProduced, w.EventsAcked, stored)
	}
	if fg.failed == 0 || sum.Whole.Errors["event_failure_TEST_FAILURE"] == 0 {
		t.Errorf("failed %d batches; the loadgen counted %v", fg.failed, sum.Whole.Errors)
	}
	if w.EventsResent == 0 {
		t.Errorf("nothing was sent again after a failure")
	}
	if sum.Whole.Errors["connection_lost"] != 1 || w.Reconnects != 1 {
		t.Errorf("the cut connection: errors %v, reconnects %d", sum.Whole.Errors, w.Reconnects)
	}
	if w.Renewals == 0 {
		t.Errorf("no connection was renewed before its token expired")
	}
	if supersedeFirst && sum.Notes["superseded_before_adoption"] == 0 {
		t.Errorf("no renewal saw its old connection end first: notes %v", sum.Notes)
	}
	for i, n := range fg.helloSessions {
		if n != 2 {
			t.Errorf("Hello %d named %d sessions, want the runner's 2", i, n)
		}
	}
	if sum.Notes["events_acknowledged_by_welcome"] == 0 {
		t.Errorf("the batch stored on the cut connection was not taken from the next Welcome: notes %v", sum.Notes)
	}
	for kind := range sum.Whole.Errors {
		switch kind {
		case "event_failure_TEST_FAILURE", "connection_lost", "event_failure_EVENT_SEQ_GAP":
		default:
			t.Errorf("unexpected error %s: %v", kind, sum.ErrorSamples[kind])
		}
	}
	if w.HeartbeatAcks == 0 || w.HeartbeatAcks > w.HeartbeatsSent {
		t.Errorf("heartbeats sent %d, acknowledged %d", w.HeartbeatsSent, w.HeartbeatAcks)
	}
	if sum.Whole.AckBatch.Count == 0 || sum.Whole.AckBatch.MaxMs <= 0 {
		t.Errorf("no acknowledgement latency recorded: %+v", sum.Whole.AckBatch)
	}
}
