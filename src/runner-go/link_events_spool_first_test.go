package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// What a stopped runner left unacknowledged in the link spool goes first (task 34mumXbJjOvZUwNmDNzmY, from the C1a
// rollback drill of 2026-10-27):
//
//   - the session's next supervisor sends what the spool holds first, by its own seqs, and emits nothing until it is
//     stored;
//   - it numbers its own events after the spool's, never over them;
//   - a runner that stops while its link is down keeps what it holds in the spool;
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

// The spool goes first on the link, the supervisor emits nothing until it is stored, and its own events are numbered
// after it.
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

// The seq the next supervisor numbers from is after both the server's last seq and the spool's, whichever is later: the
// spool's seqs are never taken again.
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

// down has the gateway refuse every connection from now on, as one that is not there does.
func down(g *fakeWorkGateway) {
	g.mu.Lock()
	g.refuse = func(*http.Request) (int, string, string) {
		return http.StatusServiceUnavailable, "the gateway is down", ""
	}
	g.mu.Unlock()
}

// A session whose turn ends while the link is down, on a runner that then stops: nothing goes over HTTPS, and what the
// stream holds is kept for the next process.
func TestARunnerStoppingWithItsLinkDownKeepsWhatItHolds(t *testing.T) {
	r, _ := newLinkEventsRig(t)
	first := r.useLink(t)
	stream, buf := linkSessionBuffer(r, "session-down")
	defer stream.release()
	down(r.g)
	first.drop()
	linkWaitFor(t, 5*time.Second, "the connection to be lost", func() bool { return r.m.work.current() == nil })
	buf.add("turn-1", evAssistant, map[string]interface{}{"text": "with the link down"}, nil)
	buf.add("turn-1", evTurnEnd, map[string]interface{}{}, nil)
	if err := stream.submit(buf.take()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if err := stream.waitStored(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("a wait for events with the link down: %v, want it to last its deadline", err)
	}

	r.m.close()
	if n := len(r.cp.requests("/api/runner/sessions/session-down/events")); n != 0 {
		t.Errorf("%d batches went over HTTPS", n)
	}
	files := spoolFiles(r.m.events.spool.dir)
	if len(files) == 0 {
		t.Fatal("the runner stopped with its link down and left nothing in the spool")
	}
	body, err := os.ReadFile(files[0])
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(body, []byte(evTurnEnd)) {
		t.Errorf("the spool holds %s, without the turn's end", body)
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
