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
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

)

// What a stopped runner left unacknowledged in the link spool is the session's, whatever carries its events next (task
// 34mumXbJjOvZUwNmDNzmY, from the C1a rollback drill of 2026-10-27). There a runner stopped with its link gateway down
// and kept seqs 10..65 of a session in the spool; started again with ORBIT_LINK_MODE=off, it never read them and
// numbered its own events from the server's seq 9, so seqs 10..21 went to other events and 12 of the spool's were
// acknowledged as stored when the link mode sent them later. So:
//
//   - the session's next supervisor sends what the spool holds first, by its own seqs, in link mode or not, and emits
//     nothing until it is stored;
//   - it numbers its own events after the spool's, never over them;
//   - a runner that stops while its link is down sends what it holds over HTTPS, when the control plane still takes
//     HTTPS, and keeps only what is left in the spool;
//   - the spool's 72-hour cleanup says, session by session, what it loses.

// spoolLeftBehind writes, in the spool in dir, what a runner in link mode leaves of a session when it stops with its link
// down: n events from seq from, ticks of the turn, the last its turn_end, as linkEventStream.persist writes them.
func spoolLeftBehind(t *testing.T, dir, sessionID string, from, n int, turnID string) []*linkEvent {
	t.Helper()
	at := time.Now().Add(-time.Minute).UnixMilli()
	events := make([]*linkEvent, n)
	for i := range events {
		typ, payload := evAssistant, fmt.Sprintf(`{"text":"tick %d"}`, from+i-4)
		if i == n-1 {
			typ, payload = evTurnEnd, `{"subtype":"success","numTurns":1}`
		}
		events[i] = &linkEvent{seq: uint64(from + i), typ: typ, tsMs: at + int64(i), turnID: turnID, payload: []byte(payload),
			boundary: typ == evTurnEnd, row: true}
	}
	if err := newLinkSpool(dir, func(...any) {}).queue(decodeSessionID(sessionID)).persist(nil, events); err != nil {
		t.Fatal(err)
	}
	return events
}

// spoolFiles is every segment the spool in dir holds.
func spoolFiles(dir string) []string {
	files, _ := filepath.Glob(filepath.Join(dir, "*", "*.jsonl"))
	return files
}

// seqStore is the control plane's run_event as a test sees it over HTTPS: the first event at each seq, and every
// later delivery at a seq that is another event (what run-event-seq-conflicts.ts counts on the server).
type seqStore struct {
	mu        sync.Mutex
	stored    map[int]RunEvent
	conflicts []string
}

func (st *seqStore) take(events []RunEvent) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.stored == nil {
		st.stored = map[int]RunEvent{}
	}
	for _, e := range events {
		prev, ok := st.stored[e.Seq]
		if !ok {
			st.stored[e.Seq] = e
			continue
		}
		if prev.Type != e.Type || prev.TurnID != e.TurnID || prev.TS != e.TS {
			st.conflicts = append(st.conflicts, fmt.Sprintf("seq %d: %s %v where %s %v is stored", e.Seq, e.Type, e.Payload, prev.Type, prev.Payload))
		}
	}
}

// With the link mode off, the supervisor of a session the spool holds events of sends them over HTTPS before it emits
// anything, by their own seqs, and numbers its own events after them: none of them takes a seq of the spool's.
func TestTheSpoolGoesFirstOverHTTPSWithTheLinkModeOff(t *testing.T) {
	pool := newSessionPool(4)
	logs := &linkTestLog{}
	var spool []*linkEvent
	var spoolDir string
	var store seqStore
	var mu sync.Mutex
	var batches [][]int
	var spoolAnswered, firstInbox time.Time
	release := make(chan struct{})
	s := superviseClaudeSessionVia(t, pool, t.TempDir(), context.Background(), func(s *supervisedSession, apiURL string) *Transport {
		// The server holds the session's seqs 1..9; the spool, 10..65: ticks 6 to 60 and the turn's end.
		s.job.MaxSeq = 9
		spoolDir = linkSpoolDir()
		spool = spoolLeftBehind(t, spoolDir, s.job.SessionID, 10, 56, "turn-0")
		front := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case strings.HasSuffix(r.URL.Path, "/inbox"):
				mu.Lock()
				if firstInbox.IsZero() {
					firstInbox = time.Now()
				}
				mu.Unlock()
			case strings.HasSuffix(r.URL.Path, "/events") && r.Method == http.MethodPost:
				body, _ := io.ReadAll(r.Body)
				r.Body = io.NopCloser(bytes.NewReader(body))
				var batch RunEventBatch
				_ = json.Unmarshal(body, &batch)
				var seqs []int
				for _, e := range batch.Events {
					seqs = append(seqs, e.Seq)
				}
				mu.Lock()
				batches = append(batches, seqs)
				first := len(batches) == 1
				mu.Unlock()
				if first {
					// The spool's batch is answered only once the test has looked at what the supervisor did meanwhile.
					select {
					case <-release:
					case <-time.After(20 * time.Second):
					}
				}
				store.take(batch.Events)
				s.serve(w, r)
				if first {
					mu.Lock()
					spoolAnswered = time.Now()
					mu.Unlock()
				}
				return
			}
			s.serve(w, r)
		}))
		t.Cleanup(front.Close)
		tr := NewTransport(front.URL, "runner-token")
		tr.spooled = newLinkEvents(nil, logs.log)
		t.Cleanup(tr.spooled.close)
		return tr
	},
		fakeStep{Await: "user"},
		fakeStep{Emit: "replay_user"},
		fakeStep{Emit: "system_init"},
		fakeStep{Emit: "assistant", Text: "answered after the restart"},
		fakeStep{Emit: "result", Text: "answered after the restart"},
	)

	// While the spool's batch waits for its answer, the supervisor emits nothing: no other batch, no turn fetched, no
	// engine started.
	waitUntil(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(batches) == 1
	}, "the spool's events were never sent")
	time.Sleep(300 * time.Millisecond)
	mu.Lock()
	sentMeanwhile, fetched := len(batches)-1, !firstInbox.IsZero()
	mu.Unlock()
	if sentMeanwhile != 0 || fetched || len(s.fake.Spawns()) != 0 {
		t.Errorf("before the spool was stored the supervisor sent %d other batch(es), fetched a turn %v, started %d engine(s)",
			sentMeanwhile, fetched, len(s.fake.Spawns()))
	}
	close(release)

	s.awaitEvents("the turn's end", 1, func(e RunEvent) bool { return e.Type == evTurnEnd && e.TurnID == "turn-1" })
	s.awaitParked("turn-1")
	mu.Lock()
	defer mu.Unlock()
	if want := seqRange(10, 65); fmt.Sprint(batches[0]) != fmt.Sprint(want) {
		t.Fatalf("the first batch carried %v, want the spool's seqs %v", batches[0], want)
	}
	if !firstInbox.After(spoolAnswered) {
		t.Errorf("the first turn was fetched at %s, before the spool was stored at %s", firstInbox, spoolAnswered)
	}
	// Every seq once, from the spool's on, the spool's events at their own seqs and the session's after them.
	store.mu.Lock()
	defer store.mu.Unlock()
	if len(store.conflicts) > 0 {
		t.Errorf("events were sent at seqs holding others: %v", store.conflicts)
	}
	last := 0
	for seq := range store.stored {
		last = max(last, seq)
	}
	for seq := 10; seq <= last; seq++ {
		e, ok := store.stored[seq]
		if !ok {
			t.Fatalf("seq %d was never sent (seqs 10..%d)", seq, last)
		}
		if seq <= 65 {
			want := spool[seq-10]
			if e.Type != want.typ || e.TurnID != "turn-0" || e.Payload["text"] != want.runEvent().Payload["text"] {
				t.Errorf("seq %d carried %s %v, want the spool's %s %s", seq, e.Type, e.Payload, want.typ, want.payload)
			}
		} else if e.TurnID == "turn-0" {
			t.Errorf("seq %d is the session's own event, yet carries the spool's turn: %+v", seq, e)
		}
	}
	if last <= 65 {
		t.Fatalf("the session's own events stop at seq %d: none was numbered after the spool", last)
	}
	if files := spoolFiles(spoolDir); len(files) != 0 {
		t.Errorf("the spool still holds %v once its events are stored", files)
	}
	if !logged(logs, "has 56 events through seq 65 an earlier process could not send; they go first") {
		t.Errorf("the runner never said what it found in the spool: %v", logs.all())
	}
}

// In link mode the same holds: the spool goes first on the link, the supervisor emits nothing until it is stored, and
// its own events are numbered after it.
func TestTheSpoolGoesFirstOverTheLinkBeforeTheSupervisorEmits(t *testing.T) {
	r, in := newLinkEventsRig(t)
	pool := newSessionPool(4)
	var spool []*linkEvent
	s := superviseClaudeSessionOverLinkVia(t, r, pool, context.Background(), func(s *supervisedSession) {
		s.job.MaxSeq = 9
		in.preload(s.job.SessionID, seqRangeU(1, 9)...)
		spool = spoolLeftBehind(t, r.m.events.spool.dir, s.job.SessionID, 10, 56, "turn-0")
		in.setDown(true) // the control plane cannot store anything yet
	},
		fakeStep{Await: "user"},
		fakeStep{Emit: "replay_user"},
		fakeStep{Emit: "system_init"},
		fakeStep{Emit: "assistant", Text: "answered on the link"},
		fakeStep{Emit: "result", Text: "answered on the link"},
	)
	linkWaitFor(t, 10*time.Second, "the spool's events to be sent", func() bool { return len(in.batchesOf(s.job.SessionID)) > 0 })
	time.Sleep(300 * time.Millisecond)
	if rpcs := r.g.rpcsTo("/inbox"); len(rpcs) != 0 || len(s.fake.Spawns()) != 0 {
		t.Errorf("before the spool was stored the supervisor fetched %d turn(s) and started %d engine(s)", len(rpcs), len(s.fake.Spawns()))
	}
	if stream := r.m.events.stream(s.job.SessionID); stream == nil {
		t.Fatal("the session has no stream")
	} else if _, tail := stream.holding(); tail != 65 {
		t.Fatalf("the stream was handed events through seq %d before the spool was stored, want 65", tail)
	}
	in.setDown(false)

	linkWaitFor(t, 20*time.Second, "the turn's end to be stored", func() bool {
		seqs, _, _ := in.storedSeqs(s.job.SessionID)
		for _, seq := range seqs {
			if e := in.event(s.job.SessionID, seq); e != nil && e.GetType() == evTurnEnd && e.GetTurnId() == "turn-1" {
				return true
			}
		}
		return false
	})
	seqs, tombstones, _ := in.storedSeqs(s.job.SessionID)
	last := seqs[len(seqs)-1]
	in.assertContiguous(t, s.job.SessionID, 1, last)
	if tombstones != 0 || last <= 65 {
		t.Fatalf("seqs 1..%d stored with %d tombstones, want the session's own events after seq 65 and no tombstone", last, tombstones)
	}
	for seq := uint64(10); seq <= last; seq++ {
		e := in.event(s.job.SessionID, seq)
		if seq <= 65 {
			want := spool[seq-10]
			if e.GetType() != want.typ || e.GetTurnId() != "turn-0" || !bytes.Equal(e.GetPayloadJson(), want.payload) {
				t.Errorf("seq %d holds %s %s, want the spool's %s %s", seq, e.GetType(), e.GetPayloadJson(), want.typ, want.payload)
			}
		} else if e.GetTurnId() == "turn-0" {
			t.Errorf("seq %d is the session's own event, yet carries the spool's turn", seq)
		}
	}
	batches := in.batchesOf(s.job.SessionID)
	for _, b := range batches {
		if b.result == "stored" && b.first <= 65 && b.last > 65 {
			t.Errorf("a batch stored the spool's events with the session's own: %+v", b)
		}
	}
	if files := spoolFiles(r.m.events.spool.dir); len(files) != 0 {
		t.Errorf("the spool still holds %v once its events are stored", files)
	}
}

// The seq the next supervisor numbers from is after both the server's last seq and the spool's, whichever is later,
// with the link mode off as on: the spool's seqs are never taken again.
func TestNumberingStartsAfterTheSpoolAndTheServer(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	spoolLeftBehind(t, linkSpoolDir(), "session-n", 10, 56, "turn-0")
	e := newLinkEvents(nil, func(...any) {})
	t.Cleanup(e.close)
	s := e.open("session-n")
	defer s.release()
	for _, c := range []struct{ maxSeq, want int }{{0, 66}, {9, 66}, {64, 66}, {65, 66}, {70, 71}} {
		if got := s.firstSeq(c.maxSeq + 1); got != c.want {
			t.Errorf("with the server at seq %d the next supervisor numbers from %d, want %d", c.maxSeq, got, c.want)
		}
	}
}

// A runner stopping while its link has no connection does not wait for it: unless the control plane refused HTTPS, the
// work goes back to HTTPS at once, so what the sessions' streams hold goes there within the stop's grace. One that
// still has its connection keeps it, and goes back to HTTPS at once if it loses it while stopping.
func TestAStoppingRunnerDoesNotWaitForALinkWithoutAConnection(t *testing.T) {
	t.Run("not connected", func(t *testing.T) {
		r, _ := newLinkEventsRig(t)
		c := r.useLink(t)
		down(r.g)
		c.drop()
		linkWaitFor(t, 5*time.Second, "the connection to be lost", func() bool { return r.m.work.current() == nil })
		r.m.stopping()
		if r.m.inUse() {
			t.Fatal("a stopping runner without a link connection still waits for the link")
		}
		if !logged(r.logs, "runner link mode: off — the runner is stopping and the runner link is not connected; daemon calls go over HTTPS") {
			t.Errorf("the runner never said why it went back to HTTPS: %v", r.logs.all())
		}
	})
	t.Run("HTTPS refused", func(t *testing.T) {
		r, _ := newLinkEventsRig(t)
		c := r.useLink(t)
		r.m.upgradeRequired("POST /runner/sessions/s/events") // RUNNER_LINK_REQUIRED: nothing else carries the work
		down(r.g)
		c.drop()
		linkWaitFor(t, 5*time.Second, "the connection to be lost", func() bool { return r.m.work.current() == nil })
		r.m.stopping()
		time.Sleep(200 * time.Millisecond)
		if !r.m.inUse() {
			t.Fatal("with HTTPS refused, a stopping runner gave up the link")
		}
	})
	t.Run("connected, then lost", func(t *testing.T) {
		r, _ := newLinkEventsRig(t)
		c := r.useLink(t)
		r.m.stopping()
		if !r.m.inUse() {
			t.Fatal("a stopping runner gave up a link that is connected")
		}
		down(r.g)
		c.drop()
		linkWaitFor(t, 5*time.Second, "the work to go back to HTTPS", func() bool { return !r.m.inUse() })
		if !logged(r.logs, "the runner is stopping and lost its runner link connection") {
			t.Errorf("the runner never said why it went back to HTTPS: %v", r.logs.all())
		}
	})
}

// down has the gateway refuse every connection from now on, as one that is not there does.
func down(g *fakeWorkGateway) {
	g.mu.Lock()
	g.refuse = func(*http.Request) (int, string, string) { return http.StatusServiceUnavailable, "the gateway is down", "" }
	g.mu.Unlock()
}

// A session whose turn ends while the link is down, on a runner that then stops with the control plane still taking
// HTTPS: the turn's events and its completion go over HTTPS within the stop's grace, and the spool is left empty.
func TestARunnerStoppingWithItsLinkDownSendsWhatItHoldsOverHTTPS(t *testing.T) {
	r, in := newLinkEventsRig(t)
	pool := newSessionPool(4)
	shutdown, stop := context.WithCancel(context.Background())
	defer stop()
	s := superviseClaudeSessionOverLinkVia(t, r, pool, shutdown, nil,
		fakeStep{Await: "user"},
		fakeStep{Emit: "replay_user"},
		fakeStep{Emit: "system_init"},
		fakeStep{Emit: "assistant", Text: "on the link"},
		fakeStep{Await: "release", Text: "gateway-down"},
		fakeStep{Emit: "assistant", Text: "with the link down"},
		fakeStep{Emit: "result", Text: "with the link down"},
	)
	linkWaitFor(t, 20*time.Second, "the first answer to be stored over the link", func() bool {
		seqs, _, _ := in.storedSeqs(s.job.SessionID)
		for _, seq := range seqs {
			if e := in.event(s.job.SessionID, seq); e != nil && strings.Contains(string(e.GetPayloadJson()), "on the link") {
				return true
			}
		}
		return false
	})
	down(r.g)
	for _, c := range r.g.open() {
		c.drop()
	}
	linkWaitFor(t, 5*time.Second, "the connection to be lost", func() bool { return r.m.work.current() == nil })
	s.fake.Release("gateway-down")
	stream := r.m.events.stream(s.job.SessionID)
	linkWaitFor(t, 10*time.Second, "the turn's end to be handed to the stream", func() bool {
		return streamHolds(stream, func(ev *linkEvent) bool { return ev.typ == evTurnEnd && ev.turnID == "turn-1" })
	})
	if n := s.countEvents(func(RunEvent) bool { return true }); n != 0 {
		t.Fatalf("%d events went over HTTPS while the link was in use", n)
	}

	// The runner stops, as runLoop's loopCtx tells the link mode and the supervisors.
	stop()
	r.m.stopping()
	s.awaitEvents("the turn's end over HTTPS", 1, func(e RunEvent) bool { return e.Type == evTurnEnd && e.TurnID == "turn-1" })
	waitUntil(t, func() bool { return s.settledTurn("turn-1") != nil }, "the turn's completion never reached the control plane")
	if s.countEvents(func(e RunEvent) bool { return e.Payload["text"] == "with the link down" }) != 1 {
		t.Errorf("the answer written with the link down reached the control plane over HTTPS %d time(s), want once",
			s.countEvents(func(e RunEvent) bool { return e.Payload["text"] == "with the link down" }))
	}
	waitUntil(t, func() bool { held, _ := stream.holding(); return held == 0 }, "the stream still holds events once HTTPS stored them")
	r.m.close()
	if files := spoolFiles(r.m.events.spool.dir); len(files) != 0 {
		t.Errorf("the spool holds %v after a stop that could send everything over HTTPS", files)
	}
}

// Before the 72-hour cleanup removes a session's spool, it says which session, how many events and which seqs it
// loses, and counts them; a spool touched since is kept.
func TestTheSpoolCleanupSaysWhatItLoses(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "link-spool")
	spoolLeftBehind(t, dir, "session-old", 10, 56, "turn-0")
	spoolLeftBehind(t, dir, "session-new", 1, 3, "turn-1")
	// The old one also holds an open segment a process left as it died, two whole lines of it.
	old := filepath.Join(dir, spoolNamePart(decodeSessionID("session-old")))
	if err := linkSpoolWrite(filepath.Join(old, linkSpoolSegmentName(66, 66, true)), linkSpoolTestEvents(66, 2)); err != nil {
		t.Fatal(err)
	}
	stale := time.Now().Add(-linkSpoolStaleAfter - time.Hour)
	files, _ := os.ReadDir(old)
	for _, f := range files {
		if err := os.Chtimes(filepath.Join(old, f.Name()), stale, stale); err != nil {
			t.Fatal(err)
		}
	}
	logs := &linkTestLog{}
	sp := newLinkSpool(dir, logs.log)
	sp.queue(decodeSessionID("session-new"))
	want := fmt.Sprintf("runner link: removing the event spool of session %s, untouched since %s: its 58 events, of seqs 10-67, were never acknowledged by the control plane and are lost (58 lost so far)",
		spoolNamePart(decodeSessionID("session-old")), stale.Format(time.RFC3339))
	if !logged(logs, want) {
		t.Errorf("the cleanup did not say what it loses:\n%s\nwant\n%s", strings.Join(logs.all(), "\n"), want)
	}
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Errorf("the stale spool is still there: %v", err)
	}
	if sp.lost.Load() != 58 {
		t.Errorf("the spool counts %d events lost, want 58", sp.lost.Load())
	}
	if q := sp.queue(decodeSessionID("session-new")); q.count() != 3 {
		t.Errorf("the spool touched since holds %d events, want its 3", q.count())
	}
}

// logged reports whether the log has a line holding part.
func logged(l *linkTestLog, part string) bool {
	for _, line := range l.all() {
		if strings.Contains(line, part) {
			return true
		}
	}
	return false
}

// streamHolds reports whether the stream holds, in memory, an event match takes.
func streamHolds(s *linkEventStream, match func(*linkEvent) bool) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, ev := range append(append([]*linkEvent{}, s.mem...), s.over...) {
		if match(ev) {
			return true
		}
	}
	return false
}

func seqRange(from, to int) []int {
	out := make([]int, 0, to-from+1)
	for seq := from; seq <= to; seq++ {
		out = append(out, seq)
	}
	return out
}

func seqRangeU(from, to uint64) []uint64 {
	out := make([]uint64, 0, to-from+1)
	for seq := from; seq <= to; seq++ {
		out = append(out, seq)
	}
	return out
}

