package main

import (
	"encoding/json"
	"fmt"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"orbit/linkpb"
)

// A session's events as its emitters number them (sessionEventBuffer, session.go) and its stream sends them over the
// link (link_events.go, link_events_live.go).

// linkSessionBuffer is a session's event buffer whose stream is the link mode's own, numbering from 1.
func linkSessionBuffer(r *linkWorkRig, sessionID string) (*linkEventStream, *sessionEventBuffer) {
	s := r.m.events.open(sessionID)
	return s, &sessionEventBuffer{next: 1, clock: &thinkingClock{}, link: s, provider: func() string { return providerCodex }}
}

// watch has the gateway say that n clients watch the session live, and waits until the stream has heard it.
func watch(t *testing.T, c *fakeWorkConn, s *linkEventStream, n uint32) {
	t.Helper()
	c.send(&linkpb.Frame{Body: &linkpb.Frame_Hint{Hint: &linkpb.Hint{Kind: &linkpb.Hint_Watchers{
		Watchers: &linkpb.WatchersHint{SessionId: s.id, Watchers: n}}}}})
	linkWaitFor(t, 5*time.Second, fmt.Sprintf("the stream to hear %d watchers", n), func() bool {
		s.live.mu.Lock()
		defer s.live.mu.Unlock()
		return s.live.watched == (n > 0)
	})
}

// Concurrent emitters (the stdout reader, background output, a suggestion, a steer) buffer their events in seq order:
// whatever the flush takes counts up by one, from where the last take ended, and each emitter's events keep their
// order. In link mode, live events among them take no seq and leave none behind.
func TestSessionEventBufferKeepsSeqOrderUnderConcurrentEmitters(t *testing.T) {
	for _, mode := range []string{"https", "link"} {
		t.Run(mode, func(t *testing.T) {
			var link *linkEventStream
			if mode == "link" {
				r, _ := newLinkEventsRig(t)
				r.useLink(t)
				link = r.m.events.open("session-cc")
				defer link.release()
			}
			buf := &sessionEventBuffer{next: 1, clock: &thinkingClock{}, link: link, provider: func() string { return providerClaude }}
			const emitters, each = 8, 3000
			var wg sync.WaitGroup
			start := make(chan struct{})
			for g := 0; g < emitters; g++ {
				wg.Add(1)
				go func(g int) {
					defer wg.Done()
					<-start
					for i := 0; i < each; i++ {
						typ := evAssistant
						if mode == "link" && i%3 == 0 {
							typ = evTextDelta
						}
						buf.add("", typ, map[string]interface{}{"emitter": float64(g), "i": float64(i)}, nil)
						if i%97 == 0 {
							runtime.Gosched()
						}
					}
				}(g)
			}
			done := make(chan struct{})
			go func() { wg.Wait(); close(done) }()
			close(start)
			var taken [][]RunEvent
			for running := true; running; {
				select {
				case <-done:
					running = false
				default:
				}
				if b := buf.take(); len(b) > 0 {
					taken = append(taken, b)
				}
				runtime.Gosched()
			}
			if b := buf.take(); len(b) > 0 {
				taken = append(taken, b)
			}
			next, last := 1, map[float64]float64{}
			for _, b := range taken {
				for _, ev := range b {
					if ev.Seq != next {
						t.Fatalf("the buffer holds seq %d where %d was due (take of %d events)", ev.Seq, next, len(b))
					}
					next++
					if ev.Type == evTextDelta {
						t.Fatalf("a live event took seq %d", ev.Seq)
					}
					g, i := ev.Payload["emitter"].(float64), ev.Payload["i"].(float64)
					if prev, ok := last[g]; ok && i <= prev {
						t.Fatalf("emitter %v's event %v follows its %v", g, i, prev)
					}
					last[g] = i
				}
			}
			want := emitters * each
			if mode == "link" {
				want = emitters * (each - (each+2)/3)
			}
			if next-1 != want || len(taken) < 2 {
				t.Fatalf("%d events numbered in %d takes, want %d over several", next-1, len(taken), want)
			}
		})
	}
}

// Over the link, live events go in LiveBatches and noise pings nowhere, and neither takes a durable seq; a ping-shaped
// coordinator-context boundary goes with "provider" at its own seq. What the ingest holds is every durable seq, without
// a gap, a tombstone or a ping it acknowledged and did not store. The ingest answers once the live events have gone: a
// delta still unsent when the durable event ending it is stored never goes (link_events_live.go), so an ack that beat
// the sender's live pass would leave four of the six unsent, as it should.
func TestLinkModeKeepsLiveEventsAndPingsOffTheDurableSeqs(t *testing.T) {
	r, in := newLinkEventsRig(t)
	in.ackHold = make(chan struct{})
	c := r.useLink(t)
	s, buf := linkSessionBuffer(r, "session-k")
	defer s.release()
	watch(t, c, s, 1)
	emits := []struct {
		typ     string
		payload map[string]interface{}
	}{
		{evSystem, map[string]interface{}{"subtype": "init", "sessionId": "rt-1", "provider": "codex"}},
		{evSystem, map[string]interface{}{"subtype": "status", "model": nil, "sessionId": "rt-1"}}, // a noise ping
		{evThinkingDelta, map[string]interface{}{"text": "let me "}},
		{evThinking, map[string]interface{}{"text": "let me think"}},
		{evTextDelta, map[string]interface{}{"text": "Hel"}},
		{evTextDelta, map[string]interface{}{"text": "lo"}},
		{evAssistant, map[string]interface{}{"text": "Hello"}},
		{evToolUse, map[string]interface{}{"id": "toolu_1", "name": "Bash", "input": map[string]interface{}{"command": "ls"}}},
		{evToolOutput, map[string]interface{}{"toolUseId": "toolu_1", "content": "a.go"}},
		{evBackgroundOutput, map[string]interface{}{"shellId": "bg-1", "toolUseId": "toolu_0", "content": "listening"}},
		{evTaskProgress, map[string]interface{}{"toolUseId": "toolu_2", "description": "working"}},
		{evToolResult, map[string]interface{}{"toolUseId": "toolu_1", "content": "a.go", "isError": false}},
		{evSystem, map[string]interface{}{"subtype": "context_compacted"}},               // a ping-shaped boundary
		{evSystem, map[string]interface{}{"subtype": "step_start", "sessionId": "rt-1"}}, // a noise ping
		{evTurnEnd, map[string]interface{}{"status": "completed"}},
	}
	for _, e := range emits {
		buf.add("turn-1", e.typ, e.payload, nil)
	}
	taken := buf.take()
	var types []string
	for i, ev := range taken {
		if ev.Seq != i+1 {
			t.Fatalf("event %d took seq %d", i, ev.Seq)
		}
		types = append(types, ev.Type)
	}
	if got := strings.Join(types, " "); got != "system thinking assistant tool_use tool_result system turn_end" {
		t.Fatalf("durable events: %s", got)
	}
	if err := s.submit(taken); err != nil {
		t.Fatal(err)
	}
	live := in.waitLive(t, "session-k", 6)
	close(in.ackHold)
	linkWaitStored(t, s, 10*time.Second)
	in.assertContiguous(t, "session-k", 1, 7)
	var boundary map[string]interface{}
	_ = json.Unmarshal(in.event("session-k", 6).GetPayloadJson(), &boundary)
	if boundary["subtype"] != "context_compacted" || boundary["provider"] != providerCodex {
		t.Errorf("seq 6 holds %v, want the compaction boundary with its provider", boundary)
	}
	if codes := in.refusalCodes(); len(codes) != 0 {
		t.Errorf("batches refused: %v", codes)
	}
	var liveTypes []string
	for i, e := range live {
		liveTypes = append(liveTypes, e.event.GetType())
		if i > 0 && e.event.GetLiveSeq() <= live[i-1].event.GetLiveSeq() {
			t.Errorf("live_seq %d follows %d", e.event.GetLiveSeq(), live[i-1].event.GetLiveSeq())
		}
	}
	if got := strings.Join(liveTypes, " "); got != "thinking_delta text_delta text_delta tool_output background_output task_progress" {
		t.Errorf("live events: %s", got)
	}
}

// While the connection's credit leaves no room, the session's emitters are never held up: every event is numbered and
// handed over at once, whatever the link does. The credit comes back only once the last of them is in, so what shows
// that is that the last of them gets in, with nothing sent meanwhile: the wait below is for an emitter that would never
// return, and nothing here says how fast one is, which is the host's to say. Progress reports merge into the unsent one
// before them, at its seq, taking no seq of their own; the live stream is dropped. Once the credit comes back, every
// seq is stored, without a gap.
func TestTheEngineIsNeverHeldUpWhileTheCreditIsSpent(t *testing.T) {
	r, in := newLinkEventsRig(t)
	in.credit = linkCredit{} // nothing may be in flight
	c := r.useLink(t)
	s, buf := linkSessionBuffer(r, "session-credit")
	defer s.release()
	watch(t, c, s, 1)
	buf.add("turn-1", evAssistant, map[string]interface{}{"text": "first"}, nil)
	if err := s.submit(buf.take()); err != nil {
		t.Fatal(err)
	}
	r.m.events.poke()
	linkWaitFor(t, 5*time.Second, "the credit to hold the session back", r.m.events.creditBlocked.Load)
	lastTokens := 0
	var emitted atomic.Bool
	go func() {
		defer emitted.Store(true)
		for i := 0; i < 20000; i++ {
			switch i % 5 {
			case 0:
				buf.add("turn-1", evTextDelta, map[string]interface{}{"text": "x"}, nil)
			case 1, 2, 3:
				lastTokens = 1000 + i
				buf.add("turn-1", evSystem, map[string]interface{}{"subtype": "context", "contextTokens": float64(lastTokens)}, nil)
			case 4:
				buf.add("turn-1", evToolResult, map[string]interface{}{"toolUseId": fmt.Sprint("toolu_", i), "content": "ok"}, nil)
			}
			if i%500 == 499 {
				if err := s.submit(buf.take()); err != nil {
					t.Error(err)
					return
				}
			}
		}
	}()
	linkWaitFor(t, time.Minute, "every event to be numbered and handed over with the credit spent", emitted.Load)
	if n := len(in.batchesOf("session-credit")); n != 0 {
		t.Errorf("%d batches went while the credit was spent", n)
	}
	if n := len(in.liveOf("session-credit")); n != 0 {
		t.Errorf("%d live events went while the credit was spent", n)
	}
	// Each run of three gauges between a delta and a tool result took one seq: 1 + 4000 x (gauge + result).
	s.mu.Lock()
	tail := s.tail
	s.mu.Unlock()
	if tail != 1+4000*2 {
		t.Fatalf("the session numbered %d events, want %d", tail, 1+4000*2)
	}
	// The credit comes back.
	c.send(&linkpb.Frame{Body: &linkpb.Frame_Credit{Credit: &linkpb.Credit{MaxUnackedEvents: 10_000, MaxUnackedBytes: 64 << 20}}})
	in.mu.Lock()
	in.conns[c].maxUnacked = linkDefaultCredit
	in.mu.Unlock()
	linkWaitStored(t, s, 60*time.Second)
	in.assertContiguous(t, "session-credit", 1, tail)
	var gauge map[string]interface{}
	_ = json.Unmarshal(in.event("session-credit", tail-1).GetPayloadJson(), &gauge)
	if gauge["contextTokens"] != float64(lastTokens) {
		t.Errorf("the last gauge holds %v, want the newest of its run, %d", gauge["contextTokens"], lastTokens)
	}
}

// An emitter takes nothing the disk or the network can hold: a hand-over writing the spool, or the sender reading it
// back, holds the stream's lock, and a write the network does not take holds the connection's. With both held, every
// kind of event is still numbered and buffered, a progress report that finds the stream busy taking a seq of its own.
func TestAnEmitterWaitsForNeitherTheSpoolNorTheConnection(t *testing.T) {
	r, _ := newLinkEventsRig(t)
	r.useLink(t)
	s, buf := linkSessionBuffer(r, "session-busy")
	defer s.release()
	s.mu.Lock()
	defer s.mu.Unlock()
	conn := r.m.work.current()
	conn.writeMu.Lock()
	defer conn.writeMu.Unlock()
	r.m.events.creditBlocked.Store(true) // what has a progress report look for an unsent one to merge into
	var emitted atomic.Bool
	go func() {
		defer emitted.Store(true)
		buf.add("turn-1", evSystem, map[string]interface{}{"subtype": "context", "contextTokens": float64(1)}, nil)
		buf.take() // so that the next one looks in the stream
		buf.add("turn-1", evSystem, map[string]interface{}{"subtype": "context", "contextTokens": float64(2)}, nil)
		buf.add("turn-1", evTextDelta, map[string]interface{}{"text": "x"}, nil)
		buf.add("turn-1", evAssistant, map[string]interface{}{"text": "x"}, nil)
		buf.add("turn-1", evTurnEnd, map[string]interface{}{"status": "completed"}, nil)
	}()
	linkWaitFor(t, time.Minute, "the emitter, with the stream and the connection held", emitted.Load)
}

// Live events go only while somebody watches the session: a Hint{watchers: 0} stops them, and one with watchers starts
// them again. Their live_seq counts up whether they went or not.
func TestLiveEventsGoOnlyWhileTheSessionIsWatched(t *testing.T) {
	r, in := newLinkEventsRig(t)
	c := r.useLink(t)
	s, buf := linkSessionBuffer(r, "session-lv")
	defer s.release()
	buf.add("turn-1", evTextDelta, map[string]interface{}{"text": "a"}, nil)
	time.Sleep(300 * time.Millisecond)
	if n := len(in.liveOf("session-lv")); n != 0 {
		t.Fatalf("%d live events went with nobody watching", n)
	}
	watch(t, c, s, 2)
	buf.add("turn-1", evTextDelta, map[string]interface{}{"text": "b"}, nil)
	buf.add("turn-1", evTextDelta, map[string]interface{}{"text": "c"}, nil)
	live := in.waitLive(t, "session-lv", 2)
	if live[0].event.GetLiveSeq() != 2 || live[1].event.GetLiveSeq() != 3 {
		t.Errorf("live_seqs %d, %d; want 2 and 3", live[0].event.GetLiveSeq(), live[1].event.GetLiveSeq())
	}
	watch(t, c, s, 0)
	buf.add("turn-1", evTextDelta, map[string]interface{}{"text": "d"}, nil)
	time.Sleep(300 * time.Millisecond)
	if n := len(in.liveOf("session-lv")); n != 2 {
		t.Errorf("%d live events, want 2: one went after Hint{watchers: 0}", n)
	}
	if n := len(in.batchesOf("session-lv")); n != 0 {
		t.Errorf("%d durable batches for live events", n)
	}
}

// A watched session's live stream stops with its connection and goes again at the next connection's first
// HeartbeatAck, whose HintState names the session: a Welcome's HintState is empty.
func TestTheLiveStreamResumesAtTheFirstHeartbeatAckAfterAReconnect(t *testing.T) {
	r, in := newLinkEventsRig(t)
	first := r.useLink(t)
	s, buf := linkSessionBuffer(r, "session-hb")
	defer s.release()
	watch(t, first, s, 1)
	buf.add("turn-1", evTextDelta, map[string]interface{}{"text": "before"}, nil)
	in.waitLive(t, "session-hb", 1)
	r.g.mu.Lock()
	r.g.ackHints = &linkpb.HintState{Watchers: []*linkpb.WatchersHint{{SessionId: "session-hb", Watchers: 1}}}
	r.g.mu.Unlock()
	first.drop()
	second := r.g.waitWelcomed(t, 2)
	linkWaitFor(t, 5*time.Second, "the new connection's Welcome", func() bool {
		cur := r.m.work.current()
		return cur != nil && cur.id == second.id
	})
	buf.add("turn-1", evTextDelta, map[string]interface{}{"text": "between"}, nil)
	time.Sleep(300 * time.Millisecond)
	if n := len(in.liveOf("session-hb")); n != 1 {
		t.Fatalf("%d live events: one went before the new connection's HeartbeatAck said who watches", n)
	}
	if _, err := r.t.heartbeat(linkTestHeartbeat(r.t.leaseOwner)); err != nil {
		t.Fatal(err)
	}
	buf.add("turn-1", evTextDelta, map[string]interface{}{"text": "after"}, nil)
	live := in.waitLive(t, "session-hb", 2)
	if live[1].conn != second.id || string(live[1].event.GetPayloadJson()) != `{"text":"after"}` {
		t.Errorf("after the HeartbeatAck the live stream went %+v", live[1])
	}
}

// A TurnPrefixRequest is answered with what the session's current turn has streamed since its last boundary, by the
// rules the API's own buffer kept (supersededPrefixes), with the live_seq of the last delta in it; the session counts
// as watched from then on.
func TestATurnPrefixIsWhatTheTurnHasStreamedSoFar(t *testing.T) {
	r, in := newLinkEventsRig(t)
	c := r.useLink(t)
	s, buf := linkSessionBuffer(r, "session-tp")
	defer s.release()
	ask := func(id string) *linkpb.TurnPrefixResponse {
		t.Helper()
		before := len(in.prefixAnswers)
		c.send(&linkpb.Frame{Body: &linkpb.Frame_TurnPrefixRequest{TurnPrefixRequest: &linkpb.TurnPrefixRequest{RequestId: id, SessionId: "session-tp"}}})
		var got *linkpb.TurnPrefixResponse
		linkWaitFor(t, 5*time.Second, "the answer to "+id, func() bool {
			in.mu.Lock()
			defer in.mu.Unlock()
			if len(in.prefixAnswers) > before {
				got = in.prefixAnswers[len(in.prefixAnswers)-1]
				return true
			}
			return false
		})
		if got.GetRequestId() != id || got.GetSessionId() != "session-tp" {
			t.Fatalf("answered %+v", got)
		}
		return got
	}
	buf.add("turn-1", evUser, map[string]interface{}{"text": "hi"}, nil)
	buf.add("turn-1", evThinkingDelta, map[string]interface{}{"text": "let me "}, nil)
	buf.add("turn-1", evThinkingDelta, map[string]interface{}{"text": "think"}, nil)
	buf.add("turn-1", evTextDelta, map[string]interface{}{"text": "Hello "}, nil)
	buf.add("turn-1", evUser, map[string]interface{}{"text": "and also", "steer": true}, nil) // ends nothing
	buf.add("turn-1", evTextDelta, map[string]interface{}{"text": "wor"}, nil)
	got := ask("rq-1")
	if got.GetTurnId() != "turn-1" || got.GetText() != "Hello wor" || got.GetThinking() != "let me think" || got.GetThroughLiveSeq() != 4 {
		t.Errorf("the prefix is turn %q text %q thinking %q through %d", got.GetTurnId(), got.GetText(), got.GetThinking(), got.GetThroughLiveSeq())
	}
	s.live.mu.Lock()
	watched := s.live.watched
	s.live.mu.Unlock()
	if !watched {
		t.Error("a TurnPrefixRequest did not count as a watcher")
	}
	buf.add("turn-1", evThinking, map[string]interface{}{"text": "let me think"}, nil) // ends the thinking only
	if got := ask("rq-2"); got.GetText() != "Hello wor" || got.GetThinking() != "" {
		t.Errorf("after the thinking block: text %q thinking %q", got.GetText(), got.GetThinking())
	}
	buf.add("turn-1", evAssistant, map[string]interface{}{"text": "Hello world"}, nil) // ends both
	if got := ask("rq-3"); got.GetTurnId() != "" || got.GetText() != "" || got.GetThinking() != "" {
		t.Errorf("after the reply: %+v", got)
	}
	// Past the server's cap the text is given up until the next boundary, as the server gave it up.
	buf.add("turn-2", evTextDelta, map[string]interface{}{"text": strings.Repeat("é", linkTurnPrefixMaxChars)}, nil)
	buf.add("turn-2", evTextDelta, map[string]interface{}{"text": "x"}, nil)
	buf.add("turn-2", evThinkingDelta, map[string]interface{}{"text": "still"}, nil)
	if got := ask("rq-4"); got.GetText() != "" || got.GetThinking() != "still" || got.GetTurnId() != "turn-2" {
		t.Errorf("past the cap: turn %q, %d characters of text, thinking %q", got.GetTurnId(), len(got.GetText()), got.GetThinking())
	}
	// A session the stream does not hold is answered empty at once.
	c.send(&linkpb.Frame{Body: &linkpb.Frame_TurnPrefixRequest{TurnPrefixRequest: &linkpb.TurnPrefixRequest{RequestId: "rq-5", SessionId: "nobody"}}})
	linkWaitFor(t, 5*time.Second, "the answer for a session nobody holds", func() bool {
		in.mu.Lock()
		defer in.mu.Unlock()
		last := in.prefixAnswers[len(in.prefixAnswers)-1]
		return last.GetRequestId() == "rq-5" && last.GetText() == "" && last.GetTurnId() == ""
	})
}

// A session supervised over the link, from its first turn to its completion: the engine's deltas go live, its pings
// nowhere, and its durable events in EventBatches whose seqs count up from 1 without a gap or a tombstone; the turn's
// completion waits for them (after_seq).
func TestASessionOverTheLink(t *testing.T) {
	r, in := newLinkEventsRig(t)
	pool := newSessionPool(2)
	sup := superviseClaudeSessionOverLink(t, r, pool,
		fakeStep{Await: "user"},
		fakeStep{Emit: "replay_user"},
		fakeStep{Emit: "system_init"},
		fakeStep{Emit: "system_status"},
		fakeStep{Emit: "thinking_delta", Text: "pondering"},
		fakeStep{Emit: "thinking", Text: "pondering"},
		fakeStep{Emit: "text_delta", Text: "Hel"},
		fakeStep{Emit: "text_delta", Text: "lo"},
		fakeStep{Emit: "assistant", Text: "Hello"},
		fakeStep{Emit: "tool_use", ToolUseID: "toolu_1", ToolName: "Bash", Input: map[string]interface{}{"command": "ls"}},
		fakeStep{Emit: "system_status"},
		fakeStep{Emit: "tool_result", ToolUseID: "toolu_1", Text: "a.go"},
		// A compaction boundary without its metadata: ping-shaped, and read by the ingest for the coordinator's context.
		fakeStep{Emit: "system_status", Subtype: "compact_boundary"},
		fakeStep{Emit: "result", Text: "Hello"},
	)
	sup.awaitParked("turn-1")
	seqs, tombstones, pings := in.storedSeqs(sup.job.SessionID)
	if tombstones != 0 || pings != 0 || len(seqs) == 0 {
		t.Fatalf("the ingest holds %v, %d tombstones, %d unstored pings", seqs, tombstones, pings)
	}
	var types []string
	for i, seq := range seqs {
		if seq != uint64(i+1) {
			t.Fatalf("the session's seqs %v have a gap", seqs)
		}
		ev := in.event(sup.job.SessionID, seq)
		types = append(types, ev.GetType())
		if linkLiveOnlyTypes[ev.GetType()] {
			t.Errorf("seq %d is a %s", seq, ev.GetType())
		}
	}
	joined := strings.Join(types, " ")
	for _, want := range []string{"user", "system", "thinking", "assistant", "tool_use", "tool_result", "turn_end"} {
		if !strings.Contains(joined, want) {
			t.Errorf("no %s among the stored events: %s", want, joined)
		}
	}
	boundaries := 0
	for _, seq := range seqs {
		ev := in.event(sup.job.SessionID, seq)
		var p map[string]interface{}
		_ = json.Unmarshal(ev.GetPayloadJson(), &p)
		if ev.GetType() == evSystem && p["subtype"] == "compact_boundary" {
			boundaries++
			if p["provider"] != providerClaude {
				t.Errorf("the compaction boundary at seq %d went as %v", seq, p)
			}
		}
		if ev.GetType() == evSystem && p["subtype"] == "status" {
			t.Errorf("the status ping took seq %d", seq)
		}
	}
	if boundaries != 1 {
		t.Errorf("%d compaction boundaries stored, want 1", boundaries)
	}
	calls := r.g.rpcsTo("/runner/sessions/" + sup.job.SessionID + "/turn-complete")
	if len(calls) == 0 || calls[0].afterSeq != seqs[len(seqs)-1] {
		t.Errorf("the turn completion waited for seq %v, the last event is %d", calls, seqs[len(seqs)-1])
	}
	if codes := in.refusalCodes(); len(codes) != 0 {
		t.Errorf("batches refused: %v", codes)
	}
	reads := 0
	for _, c := range r.g.rpcsTo("/runner/sessions/" + sup.job.SessionID + "/events") {
		if c.method != "GET" {
			t.Errorf("an event batch went as a call: %s %s", c.method, c.path)
			continue
		}
		reads++ // the supervisor's read of what is stored after its claim's MaxSeq (linkStoredSeqAfterTakeover)
		if !strings.Contains(c.path, "after=0&") {
			t.Errorf("the supervisor read stored events from %s", c.path)
		}
	}
	if reads != 1 {
		t.Errorf("the supervisor read the session's stored events %d times at its start, want once", reads)
	}
}

// A client draws deltas into a draft the durable event that ends it replaces. Over the link the live stream is the
// faster of the two, so the deltas emitted before an assistant block go at once, ahead of it, and those emitted after
// it (the next block's) wait until it is stored: a client never draws a block's text again after its end, nor loses
// the next block's first words to it.
func TestLiveDeltasKeepTheirPlaceAroundTheDurableEventsThatEndThem(t *testing.T) {
	r, in := newLinkEventsRig(t)
	in.ackDelay = 400 * time.Millisecond
	c := r.useLink(t)
	s, buf := linkSessionBuffer(r, "session-ord")
	defer s.release()
	watch(t, c, s, 1)
	buf.add("turn-1", evTextDelta, map[string]interface{}{"text": "Hel"}, nil)
	buf.add("turn-1", evTextDelta, map[string]interface{}{"text": "lo"}, nil)
	buf.add("turn-1", evAssistant, map[string]interface{}{"text": "Hello"}, nil)
	buf.add("turn-1", evTextDelta, map[string]interface{}{"text": "Next"}, nil)
	if err := s.submit(buf.take()); err != nil {
		t.Fatal(err)
	}
	live := in.waitLive(t, "session-ord", 3)
	batches := in.batchesOf("session-ord")
	if len(batches) != 1 {
		t.Fatalf("%d durable batches", len(batches))
	}
	stored := batches[0].at.Add(in.ackDelay)
	for _, e := range live[:2] {
		if !e.at.Before(stored) {
			t.Errorf("a delta of the block went %s after the block was stored", e.at.Sub(stored))
		}
	}
	if next := live[2]; string(next.event.GetPayloadJson()) != `{"text":"Next"}` || next.at.Before(stored) {
		t.Errorf("the next block's delta went %s before the block that precedes it was stored", stored.Sub(next.at))
	}
}

// What the live stream queued that a stored durable event has since ended is stale, and never goes; what waits for an
// unstored one holds back everything behind it.
func TestLiveQueueDropsWhatAStoredEventEndedAndHoldsWhatWaits(t *testing.T) {
	l := &linkLiveStream{watched: true}
	q := func(typ, text string, waitFor, endedBy uint64) *linkQueuedLive {
		return &linkQueuedLive{ev: &linkpb.LiveEvent{Type: typ, PayloadJson: []byte(`{"text":"` + text + `"}`)}, waitFor: waitFor, endedBy: endedBy}
	}
	l.queue = []*linkQueuedLive{q(evTextDelta, "stale", 0, 5), q(evToolOutput, "snapshot", 0, 0), q(evTextDelta, "next", 5, 0),
		q(evTextDelta, "after", 0, 0)}
	now := time.Now()
	l.since = now.Add(-time.Second)
	frame, taken, _ := l.batch("s", now, 4) // seq 5 is not stored yet
	if got := linkLiveTexts(frame); got != "stale snapshot" || len(taken) != 2 {
		t.Fatalf("before seq 5 is stored the batch is %q", got)
	}
	frame, _, _ = l.batch("s", now, 4)
	if frame != nil {
		t.Fatalf("what waits for seq 5 went before it was stored: %q", linkLiveTexts(frame))
	}
	l.queue = append([]*linkQueuedLive{q(evTextDelta, "late", 0, 5)}, l.queue...)
	frame, _, _ = l.batch("s", now, 5)
	if got := linkLiveTexts(frame); got != "next after" {
		t.Errorf("once seq 5 is stored the batch is %q: what it ended went too, or what waited for it did not", got)
	}
}

func linkLiveTexts(f *linkpb.Frame) string {
	var out []string
	for _, e := range f.GetLiveBatch().GetEvents() {
		var p map[string]interface{}
		_ = json.Unmarshal(e.GetPayloadJson(), &p)
		out = append(out, fmt.Sprint(p["text"]))
	}
	return strings.Join(out, " ")
}

// A boundary event has the session's flush hand it over at once, not at its next tick.
func TestABoundaryOverTheLinkWakesTheFlush(t *testing.T) {
	r, _ := newLinkEventsRig(t)
	s, buf := linkSessionBuffer(r, "session-soon")
	defer s.release()
	buf.soon = make(chan struct{}, 1)
	r.useLink(t)
	buf.add("turn-1", evToolUse, map[string]interface{}{"id": "toolu_1"}, nil)
	select {
	case <-buf.soon:
		t.Fatal("a tool call, which waits for the cadence, woke the flush")
	default:
	}
	buf.add("turn-1", evTurnEnd, map[string]interface{}{}, nil)
	select {
	case <-buf.soon:
	default:
		t.Fatal("a boundary did not wake the flush")
	}
}
