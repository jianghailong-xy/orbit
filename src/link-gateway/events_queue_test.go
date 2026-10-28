package main

import (
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"net/http"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"orbit/link-gateway/linkpb"
)

// The ingest queue's bound across connections, its line, and the credit's share of it (events.go, creditBook).

// queueBook is a credit book of the tuning mutate gives it, on a gateway that holds no connection.
func queueBook(t *testing.T, mutate func(*linkTuning)) *creditBook {
	t.Helper()
	h := newLinkHarness(t, nil, func(c *config) { mutate(&c.link) })
	return h.g.credit
}

// queueSim plays sessions against a credit book as connections do (events.go onEvents and ingestLoop): a session sends
// its next batch when it has none in the queue, the queue stores what it took one batch at a time, oldest first, and
// the book's depth is checked against MaxQueued after every step.
type queueSim struct {
	t        *testing.T
	b        *creditBook
	sessions []*simSession
	stored   []*simSession // taken, oldest first: their batch is stored next
	maxDepth creditLevel
}

type simSession struct {
	l      *linkState
	id     string
	next   creditLevel // the batch it sends next
	queued bool        // its batch is in the queue
	// taken counts its batches the queue took; waited is how many rounds its batch has been refused in a row, and
	// longest the most of those.
	taken, waited, longest int
}

func (s *queueSim) send(ss *simSession) {
	admitted, _ := s.b.admit(ss.l, ss.id, ss.next)
	depth := s.b.depth()
	if !depth.within(s.b.tune.MaxQueued) {
		s.t.Fatalf("the ingest queue holds %+v, past its bound %+v", depth, s.b.tune.MaxQueued)
	}
	s.maxDepth = creditLevel{Events: max(s.maxDepth.Events, depth.Events), Bytes: max(s.maxDepth.Bytes, depth.Bytes)}
	if !admitted {
		ss.waited++
		ss.longest = max(ss.longest, ss.waited)
		return
	}
	ss.queued, ss.waited = true, 0
	ss.taken++
	s.stored = append(s.stored, ss)
}

// store has the queue store its oldest n batches.
func (s *queueSim) store(n int) {
	for ; n > 0 && len(s.stored) > 0; n-- {
		ss := s.stored[0]
		s.stored = s.stored[1:]
		ss.queued = false
		s.b.give(ss.next)
	}
}

// round has every session without a batch in the queue send one, in an order of rng's, then the queue store n.
func (s *queueSim) round(rng *rand.Rand, n int) {
	order := slices.Clone(s.sessions)
	rng.Shuffle(len(order), func(i, j int) { order[i], order[j] = order[j], order[i] })
	for _, ss := range order {
		if !ss.queued {
			s.send(ss)
		}
	}
	s.store(n)
}

// The acceptance's case: far more connections than the queue's bound has room for, at the reduced credit each, keep
// sending; the queue never holds more than its bound, in events or in bytes. Once the ingest keeps up, everything
// queued is stored, the line empties, and the credit comes back.
func TestTheIngestQueueStaysWithinItsBoundHoweverManyConnectionsSend(t *testing.T) {
	b := queueBook(t, func(tune *linkTuning) {
		tune.MaxQueued = creditLevel{Events: 2_000, Bytes: 512 << 10}
		tune.HighWater, tune.LowWater = tune.MaxQueued.half(), tune.MaxQueued.half().half()
	})
	// 1,500 connections at 1,000 events each is 1.5 million events: 750 times the bound.
	if n := uint64(1_500) * uint64(b.tune.Reduced.Events); n < 500*uint64(b.tune.MaxQueued.Events) {
		t.Fatalf("connections × reduced credit %d is not far past the bound", n)
	}
	rng := rand.New(rand.NewPCG(1, 2))
	sim := &queueSim{t: t, b: b}
	for i := 0; i < 1_500; i++ {
		l := &linkState{}
		b.join()
		for j := 0; j < 2; j++ {
			events := uint32(1 + rng.IntN(40))
			sim.sessions = append(sim.sessions, &simSession{l: l, id: fmt.Sprintf("s-%d-%d", i, j),
				next: creditLevel{Events: events, Bytes: uint64(events) * uint64(50+rng.IntN(800))}})
		}
	}
	// The ingest stores a fraction of what they send each round.
	for r := 0; r < 400; r++ {
		sim.round(rng, 5+rng.IntN(20))
	}
	if !b.reduced || b.current().Events != 1 || b.current().Bytes != b.tune.Reduced.Bytes {
		t.Fatalf("with 1,500 connections each gets %+v of a 2,000-event bound (reduced %v)", b.current(), b.reduced)
	}
	if sim.maxDepth.Events < b.tune.MaxQueued.Events*9/10 && sim.maxDepth.Bytes < b.tune.MaxQueued.Bytes*9/10 {
		t.Fatalf("the queue never filled: at most %+v", sim.maxDepth)
	}
	if b.waitingSessions() == 0 {
		t.Fatal("nobody waited in line")
	}
	t.Logf("1,500 connections × a reduced credit of %d = %d events against a bound of %+v: the queue held at most %+v; %d sessions in line",
		b.tune.Reduced.Events, 1_500*int(b.tune.Reduced.Events), b.tune.MaxQueued, sim.maxDepth, b.waitingSessions())
	// The ingest catches up: the senders stop, and it stores everything.
	for len(sim.stored) > 0 || b.waitingSessions() > 0 {
		for _, ss := range sim.sessions {
			if !ss.queued && b.waiting[ss.l][ss.id] != nil {
				sim.send(ss) // a session in line sends its refused batch again
			}
		}
		sim.store(50)
	}
	if b.depth() != (creditLevel{}) || b.held != (creditLevel{}) || b.line.Len() != 0 || b.called.Len() != 0 || len(b.waiting) != 0 {
		t.Fatalf("drained, the queue holds %+v, %+v held, %d in line, %d called", b.depth(), b.held, b.line.Len(), b.called.Len())
	}
	if b.current() != b.tune.Credit {
		t.Fatalf("the credit is %+v once the queue drained, not %+v", b.current(), b.tune.Credit)
	}
}

// Room goes to the sessions in line in the order they came, and is held for them until they send again, so a session
// whose batch takes nine tenths of the queue gets its turn among sessions whose small batches would always fit first.
func TestEverySessionInLineGetsItsTurnHoweverSmallTheOthersBatches(t *testing.T) {
	b := queueBook(t, func(tune *linkTuning) {
		tune.MaxQueued = creditLevel{Events: 100, Bytes: 1 << 20}
		tune.HighWater, tune.LowWater = tune.MaxQueued.half(), tune.MaxQueued.half().half()
	})
	rng := rand.New(rand.NewPCG(3, 4))
	sim := &queueSim{t: t, b: b}
	for i := 0; i < 60; i++ {
		events := uint32(1 + rng.IntN(3))
		if i == 17 {
			events = 90
		}
		sim.sessions = append(sim.sessions, &simSession{l: &linkState{}, id: fmt.Sprintf("s-%d", i),
			next: creditLevel{Events: events, Bytes: uint64(events) * 100}})
	}
	big := sim.sessions[17]
	// The queue stores one batch a round: about the 60 sessions' batches a turn takes, and the big one's ninety
	// events a drain of up to fifty small batches.
	const rounds = 3_000
	for r := 0; r < rounds; r++ {
		sim.round(rng, 1)
	}
	for _, ss := range sim.sessions {
		// Its turn comes within one pass of the line, and the queue's emptying for a big one.
		if ss.longest > 2*len(sim.sessions)+int(b.tune.MaxQueued.Events) {
			t.Errorf("session %s waited %d rounds in a row", ss.id, ss.longest)
		}
		if ss.taken < rounds/(4*len(sim.sessions)) {
			t.Errorf("session %s had %d batches taken in %d rounds", ss.id, ss.taken, rounds)
		}
	}
	if big.taken < 10 {
		t.Fatalf("the session of 90-event batches had %d taken in %d rounds", big.taken, rounds)
	}
	longest, fewest := 0, rounds
	for _, ss := range sim.sessions {
		if ss != big {
			longest, fewest = max(longest, ss.longest), min(fewest, ss.taken)
		}
	}
	t.Logf("in %d rounds the 90-event session had %d batches taken and waited at most %d rounds; the 59 others at least %d each, waiting at most %d",
		rounds, big.taken, big.longest, fewest, longest)
}

// Room held for a session whose runner does not send again goes, after HoldFor, to the next in line; and a session
// that sends more than was held for it keeps its place, first in line.
func TestRoomHeldForASessionGoesToTheNextWhenItDoesNotSendAgain(t *testing.T) {
	b := queueBook(t, func(tune *linkTuning) {
		tune.MaxQueued = creditLevel{Events: 10, Bytes: 1 << 20}
		tune.HighWater, tune.LowWater = tune.MaxQueued.half(), tune.MaxQueued.half().half()
		tune.HoldFor = 100 * time.Millisecond
	})
	l1, l2, l3 := &linkState{}, &linkState{}, &linkState{}
	amount := func(n uint32) creditLevel { return creditLevel{Events: n, Bytes: uint64(n)} }
	admit := func(l *linkState, session string, n uint32) bool {
		t.Helper()
		ok, _ := b.admit(l, session, amount(n))
		return ok
	}
	if !admit(l1, "full", 10) {
		t.Fatal("an empty queue refused a batch within its bound")
	}
	if admit(l1, "a", 4) || admit(l2, "b", 3) || admit(l3, "c", 2) {
		t.Fatal("a full queue took a batch")
	}
	b.give(amount(10))
	// a, then b, then c have room held: nobody else may take it, not even a batch that fits.
	if b.called.Len() != 3 || b.held != amount(9) {
		t.Fatalf("%d called, %+v held", b.called.Len(), b.held)
	}
	if admit(l3, "d", 2) {
		t.Fatal("a newcomer took room held for the line")
	}
	// b sends again, past its room: c's is held, a's too, so b goes first in line, and is called once room frees.
	if admit(l2, "b", 6) {
		t.Fatal("b took more than was held for it")
	}
	if b.line.Front().Value.(*waiter).session != "b" {
		t.Fatal("b lost its place")
	}
	if !admit(l3, "c", 2) {
		t.Fatal("c was refused the room held for it")
	}
	// a never sends again: past HoldFor its room goes, and b's turn comes.
	time.Sleep(150 * time.Millisecond)
	if !admit(l2, "b", 6) {
		t.Fatalf("b was refused once a's room was let go: %+v held, %+v queued", b.held, b.depth())
	}
	// d, refused while b waited, was next: room is held for it, until its connection closes.
	if b.line.Len() != 0 || b.called.Len() != 1 || b.called.Front().Value.(*waiter).session != "d" {
		t.Fatalf("%d in line, %d called", b.line.Len(), b.called.Len())
	}
	b.leave(l3)
	if b.waitingSessions() != 0 || len(b.waiting) != 0 {
		t.Fatalf("%d sessions wait after their connection closed", b.waitingSessions())
	}
}

// While the queue is deep, each connection's credit is its share of the bound in events, at most Reduced, so that what
// all of them may have in flight fits in it; the bytes stay Reduced's, which the largest event needs.
func TestTheReducedCreditSharesTheBoundBetweenConnections(t *testing.T) {
	b := queueBook(t, func(tune *linkTuning) {
		tune.MaxQueued = creditLevel{Events: 200_000, Bytes: 128 << 20}
		tune.HighWater, tune.LowWater = tune.MaxQueued.half(), tune.MaxQueued.half().half()
	})
	for i := 0; i < 15_000; i++ {
		b.join()
	}
	if b.current() != b.tune.Credit {
		t.Fatalf("a short queue grants %+v", b.current())
	}
	if ok, reduced := b.admit(&linkState{}, "s", creditLevel{Events: 100_001, Bytes: 1}); !ok || !reduced {
		t.Fatal("the queue did not pass its high-water mark")
	}
	if got := b.current(); got.Events != 13 || got.Bytes != b.tune.Reduced.Bytes {
		t.Fatalf("15,000 connections get %+v each", got)
	}
	if n := uint64(b.current().Events) * 15_000; n > uint64(b.tune.MaxQueued.Events) {
		t.Fatalf("what the connections may have in flight, %d events, is past the bound", n)
	}
	for i := 0; i < 14_900; i++ {
		b.leave(&linkState{})
	}
	if got := b.current(); got != b.tune.Reduced {
		t.Fatalf("100 connections get %+v each, not Reduced", got)
	}
}

// Through the gateway: connections whose credit together is far past the bound send at once while the ingest holds
// its answers back. The queue never holds more than its bound; what it has no room for is refused CREDIT_EXCEEDED,
// retryable, without a call; and each connection's next batch tells it its share. Once the ingest answers again,
// every session's events are stored once each, in order, the queue drains, and the credit is restored.
func TestConnectionsPastTheBoundAreHeldBackAndStoredOnceTheIngestCatchesUp(t *testing.T) {
	release := make(chan struct{})
	var releaseOnce sync.Once
	open := func() { releaseOnce.Do(func() { close(release) }) }
	var storedSeqs sync.Map // session → []uint64
	var mu sync.Mutex
	backend := newFakeBackend(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		var req struct {
			Events []struct {
				Seq uint64 `json:"seq"`
			} `json:"events"`
		}
		_ = json.Unmarshal(body, &req)
		session := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/runner/sessions/"), "/events")
		mu.Lock()
		got, _ := storedSeqs.Load(session)
		seqs, _ := got.([]uint64)
		for _, e := range req.Events {
			if !slices.Contains(seqs, e.Seq) {
				seqs = append(seqs, e.Seq)
			}
		}
		storedSeqs.Store(session, seqs)
		mu.Unlock()
		stored(w, r, body)
	})
	const conns, perSession, perBatch = 8, 30, 3
	h := newLinkHarness(t, []*fakeBackend{backend}, func(c *config) {
		c.link.Credit = creditLevel{Events: 10, Bytes: 1 << 20}
		c.link.Reduced = creditLevel{Events: 10, Bytes: 1 << 20}
		c.link.MaxQueued = creditLevel{Events: 12, Bytes: 64 << 20}
		c.link.HighWater, c.link.LowWater = c.link.MaxQueued.half(), c.link.MaxQueued.half().half()
	})
	// A test that fails first must not leave the backend's handlers waiting: this runs before either server closes.
	t.Cleanup(open)
	// Eight connections at a credit of ten: 80 events in flight against a bound of 12.
	var maxDepth atomic.Uint32
	done := make(chan struct{})
	go func() {
		for {
			select {
			case <-done:
				return
			default:
			}
			maxDepth.Store(max(maxDepth.Load(), h.g.credit.depth().Events))
			time.Sleep(200 * time.Microsecond)
		}
	}()
	var wg sync.WaitGroup
	var errsMu sync.Mutex
	var errs []string
	fail := func(i int, err error) {
		errsMu.Lock()
		defer errsMu.Unlock()
		errs = append(errs, fmt.Sprintf("connection %d: %v", i, err))
	}
	for i := 0; i < conns; i++ {
		runner := fmt.Sprintf("0190a0b0-0000-7000-8000-%012x", 0x100+i)
		process := fmt.Sprintf("0190a0b0-0000-4000-8000-%012x", 0x200+i)
		session := fmt.Sprintf("0190a0b0-0000-7000-8000-%012x", 0x300+i)
		tc, w := h.connectLink(runner, process)
		credit := w.GetCredit().GetMaxUnackedEvents()
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			// A runner's stream (src/runner-go/link_events.go): one batch in flight, within its credit, sent again from
			// durable_seq + 1 after a retryable failure.
			var durable uint64
			for durable < perSession {
				n := min(uint64(perBatch), uint64(credit), perSession-durable)
				tc.send(eventsFrame(batch(session, durable+1, durable+n)))
				for {
					f, err := tc.next(20*time.Second, "credit", "event_ack")
					if err != nil {
						fail(i, err)
						return
					}
					if c := f.GetCredit(); c != nil {
						credit = c.GetMaxUnackedEvents()
						continue
					}
					ack := f.GetEventAck()
					durable = max(durable, ack.GetDurableSeq())
					if fl := ack.GetFailure(); fl != nil {
						if fl.GetCode() != "CREDIT_EXCEEDED" || !fl.GetRetryable() || fl.GetRetryAfterMs() != 1000 {
							fail(i, fmt.Errorf("%v", fl))
							return
						}
						time.Sleep(20 * time.Millisecond) // shorter than the 1s asked: the test's time
					}
					break
				}
			}
		}(i)
	}
	eventually(t, 10*time.Second, "batches refused for the queue's bound", func() bool {
		return h.g.metrics.eventBatches.get("queue_full")+h.g.metrics.eventBatches.get("credit_exceeded") >= conns
	})
	if h.g.metrics.creditReduced.get() != 1 {
		t.Fatal("the credit was not reduced")
	}
	open()
	wg.Wait()
	close(done)
	for _, e := range errs {
		t.Error(e)
	}
	if got := maxDepth.Load(); got > 12 {
		t.Fatalf("the ingest queue held %d events, past its bound of 12", got)
	}
	t.Logf("8 connections at a credit of 10 against a bound of 12: the queue held at most %d; refused %v for the bound, %v for a connection's credit",
		maxDepth.Load(), h.g.metrics.eventBatches.get("queue_full"), h.g.metrics.eventBatches.get("credit_exceeded"))
	for i := 0; i < conns; i++ {
		session := fmt.Sprintf("0190a0b0-0000-7000-8000-%012x", 0x300+i)
		got, _ := storedSeqs.Load(session)
		seqs, _ := got.([]uint64)
		slices.Sort(seqs)
		if len(seqs) != perSession || seqs[0] != 1 || seqs[len(seqs)-1] != perSession {
			t.Errorf("session %s stored %v", session, seqs)
		}
	}
	eventually(t, 5*time.Second, "the queue drained and the credit restored", func() bool {
		return h.g.credit.depth() == (creditLevel{}) && h.g.credit.waitingSessions() == 0 && h.g.metrics.creditReduced.get() == 0
	})
	if h.g.metrics.creditChanges.get("restored") < 1 {
		t.Fatal("the restored credit was not counted")
	}
	// No call was made for a batch refused on sight.
	if calls, taken := len(backend.requests()), h.g.metrics.eventBatches.get("stored"); float64(calls) != taken {
		t.Fatalf("%d calls for %v batches stored", calls, taken)
	}
}

// next is the next frame of one of the bodies, or why none came. Unlike await, it may be called from a goroutine of the
// test's own.
func (tc *testConn) next(timeout time.Duration, bodies ...string) (*linkpb.Frame, error) {
	deadline := time.After(timeout)
	for {
		select {
		case f := <-tc.frames:
			if slices.Contains(bodies, bodyName(f)) {
				return f, nil
			}
		case <-tc.done:
			return nil, fmt.Errorf("the connection ended waiting for %v: %v", bodies, tc.err)
		case <-deadline:
			return nil, fmt.Errorf("no %v within %s", bodies, timeout)
		}
	}
}

func TestTheIngestQueueBoundAndTheDrillIngestRateAreReadFromTheEnvironment(t *testing.T) {
	env := func(extra map[string]string) func(string) string {
		base := map[string]string{
			"LINK_TLS_MODE": "off", "LINK_API_URL": "http://api", "LINK_GATEWAY_TOKEN": strings.Repeat("g", 32),
			"LINK_PUBLIC_KEYS": publicPEM(t, newTestKeys(t).pub),
		}
		for k, v := range extra {
			base[k] = v
		}
		return func(name string) string { return base[name] }
	}
	cfg, err := configFromEnv(env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.link.MaxQueued != (creditLevel{Events: 200_000, Bytes: 128 << 20}) ||
		cfg.link.HighWater != (creditLevel{Events: 100_000, Bytes: 64 << 20}) ||
		cfg.link.LowWater != (creditLevel{Events: 50_000, Bytes: 32 << 20}) || cfg.DrillIngestRate != 0 {
		t.Fatalf("defaults: bound %+v, high %+v, low %+v, drill rate %v", cfg.link.MaxQueued, cfg.link.HighWater, cfg.link.LowWater, cfg.DrillIngestRate)
	}
	if defaultLinkTuning().MaxQueued != cfg.link.MaxQueued || defaultLinkTuning().HighWater != cfg.link.HighWater {
		t.Fatal("the default tuning and the environment's defaults differ")
	}
	cfg, err = configFromEnv(env(map[string]string{
		"LINK_INGEST_QUEUE_MAX_EVENTS": "40000", "LINK_INGEST_QUEUE_MAX_BYTES": "134217728", "LINK_DRILL_INGEST_RATE": "300",
	}))
	if err != nil || cfg.link.MaxQueued != (creditLevel{Events: 40_000, Bytes: 128 << 20}) ||
		cfg.link.HighWater != (creditLevel{Events: 20_000, Bytes: 64 << 20}) ||
		cfg.link.LowWater != (creditLevel{Events: 10_000, Bytes: 32 << 20}) || cfg.DrillIngestRate != 300 {
		t.Fatalf("set: %+v %+v %+v %v, %v", cfg.link.MaxQueued, cfg.link.HighWater, cfg.link.LowWater, cfg.DrillIngestRate, err)
	}
	for _, extra := range []map[string]string{
		{"LINK_INGEST_QUEUE_MAX_EVENTS": "9999"},
		{"LINK_INGEST_QUEUE_MAX_BYTES": "1048576"},
	} {
		if _, err := configFromEnv(env(extra)); err == nil || !strings.Contains(err.Error(), "at least one connection's credit") {
			t.Fatalf("%v accepted: %v", extra, err)
		}
	}
	for _, value := range []string{"0", "-1", "fast"} {
		if _, err := configFromEnv(env(map[string]string{"LINK_DRILL_INGEST_RATE": value})); err == nil ||
			!strings.Contains(err.Error(), "LINK_DRILL_INGEST_RATE") {
			t.Fatalf("LINK_DRILL_INGEST_RATE=%q accepted: %v", value, err)
		}
	}
}

// LINK_DRILL_INGEST_RATE holds what is forwarded to its rate, batch by batch in the order they came.
func TestTheDrillIngestRateHoldsForwardedEventsToIt(t *testing.T) {
	var mu sync.Mutex
	var at []time.Time
	backend := newFakeBackend(t, func(w http.ResponseWriter, r *http.Request, body []byte) {
		mu.Lock()
		at = append(at, time.Now())
		mu.Unlock()
		stored(w, r, body)
	})
	h := newLinkHarness(t, []*fakeBackend{backend}, func(c *config) { c.DrillIngestRate = 100 })
	tc, _ := h.connectLink(runnerA, processA)
	started := time.Now()
	for seq := uint64(1); seq <= 60; seq += 20 {
		tc.send(eventsFrame(batch(eventSession, seq, seq+19)))
	}
	for i := 0; i < 3; i++ {
		if ack := tc.eventAck(10 * time.Second); ack.GetFailure() != nil {
			t.Fatalf("ack %v", ack)
		}
	}
	// 60 events at 100 a second: the third batch goes 400ms after the first, which goes at once.
	mu.Lock()
	defer mu.Unlock()
	if len(at) != 3 || at[0].Sub(started) > 300*time.Millisecond || at[2].Sub(at[0]) < 380*time.Millisecond {
		t.Fatalf("forwarded at %v after the start", func() (d []time.Duration) {
			for _, a := range at {
				d = append(d, a.Sub(started).Round(time.Millisecond))
			}
			return
		}())
	}
}
