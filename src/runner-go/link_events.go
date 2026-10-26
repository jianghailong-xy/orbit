package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	mrand "math/rand/v2"
	"net/http"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"google.golang.org/protobuf/proto"

	"orbit/linkpb"
)

// The runner link's durable event stream (docs/runner-link-design.md §5.8; task B8). While a session's work goes over
// the link, its durable events go in EventBatch frames on the work connection rather than in POSTs to
// /runner/sessions/<id>/events, and an EventAck says how far they are stored.
//
// What a session hands over stays here until an EventAck covers it: in memory up to linkSessionMemoryBytes for the
// session and linkTotalMemoryBytes for all of them, then on disk under ~/.orbit/link-spool, up to linkSpoolMaxBytes
// (link_events_spool.go), then in memory again, up to linkTotalOverBytes for all of them. Handing events over never
// waits for the network, for credit or for the disk filling up, so a session's emitters keep reading their engine's
// stdout whatever the link does (session.go). A session that would pass that last bound is given up instead
// (abandonLocked, below), rather than the runner run out of memory.
//
// Sending. One batch per session is in flight on a connection at a time. An EventAck names no batch, and the gateway
// acknowledges a batch it refuses on sight (a gap, no credit) ahead of one it is still storing, so a second batch in
// flight would leave an ack that cannot be told apart. A batch carries at most linkBatchMaxEvents events and
// linkBatchMaxBytes of payload. An event larger than that goes alone; one too large for any frame is trimmed
// (linkTrimmedPayload). Batches go out within the connection's Credit: the events and payload bytes in flight across
// sessions. A session's events go about once a linkEventCadence, at once for a boundary event (linkBoundaryEvent), and
// at once when somebody waits for them to be stored: a turn's completion, a failed turn, the session's end.
//
// Acknowledgements. EventAck.durable_seq covers what the batch carried, and the events it covers are dropped. Those it
// names in rejected are held by tombstones on the server and are never sent again. A retryable failure has everything
// after durable_seq sent again, in order, after the wait it names. One that is not retryable is the session's own
// (CONFLICT, FORBIDDEN, NOT_FOUND) when the server stores no more of its events: the session is no longer open, or this
// process lost its lease. Nothing is sent again, and the session's flush says so as the lease ownership error the
// HTTPS path would have met, which ends its supervisor. Any other refusal (a 413, a 500 the data decided) is one the
// HTTPS path sends again, flush after flush: the stream keeps the events and sends them again after a wait, as after a
// retryable failure, and a wait for them is told of the refusal, as an HTTPS flush is. As HTTPS does, it gives up after
// maxEventFlushServerRejections of them in a row (eventFlushRetryPolicy). HTTPS then drops the batch and goes on, but a
// stream holds its events in seq order, and a batch never stored would hold back every one after it: the stream is
// given up instead (abandonLocked). Nothing more is sent, what it holds is written to the spool rather than dropped,
// and the session's supervisor ends the session with the refusal as its error (session.go).
//
// Reconnecting. A new connection's Welcome says how far each session's events are stored (durable_seq, task B4a). What
// is held after that is sent again from its smallest seq, every seq of it: a seq skipped would be a hole on the server
// that nothing reports. For a session older than link mode, durable_seq stops at its first HTTPS-era hole (every delta
// took a seq there and none was stored), so it is a floor only. New events are numbered from the largest of it, the
// last seq handed over and the claim's MaxSeq, plus one. A Welcome that names no session says nothing about it, and
// everything held for it is sent again too.
//
// Back to HTTPS. When the link goes out of use (MODE_HTTP, the switch off), what is held is sent over HTTPS first, in
// seq order, before anything newer (session.go). The server stores each seq once whichever way it came.
//
// Stopping. When the runner stops, what is held is written to the spool, and the next process's supervisor for the
// session sends it first and numbers after it. A crash loses what was only in memory, at most linkSessionMemoryBytes
// per session, as a crash of the HTTPS runner does.

const (
	// linkEventCadence is how often a session's durable events are sent when nothing sends them sooner (§5.8: about
	// every one to three seconds). The HTTPS flush runs every 250ms, so an event that is not a boundary reaches
	// clients up to about 0.75s later over the link; a boundary goes at once.
	linkEventCadence = time.Second
	// The memory unacknowledged events may take before newer ones go to the spool on disk.
	linkSessionMemoryBytes = 8 << 20
	linkTotalMemoryBytes   = 256 << 20
	// linkTotalOverBytes is the memory every stream's over takes together: events held in memory again because the spool
	// would not take them, full at linkSpoolMaxBytes or failing. A quarter of what memory holds before the spool, it is
	// slack for a disk that fails for a while, not a third buffer: a session that would pass it is given up
	// (abandonLocked).
	linkTotalOverBytes = 64 << 20
	// The most one EventBatch carries, in events and in payload bytes. Well inside a frame's 8 MiB once joined from
	// Chunks, and inside the gateway's reduced credit (8 MiB, 1,000 events).
	linkBatchMaxEvents = 500
	linkBatchMaxBytes  = 1 << 20
	// linkEventFrameCeiling is the largest encoded frame an event may go in, alone: the largest frame one joins from
	// Chunks (the gateway's maxChunkedFrameBytes, this binary's linkMaxJoinedFrameBytes) less a margin. A larger frame
	// ends the connection as a protocol error, and the event would end every next one, so an event that would need
	// one is trimmed. The apiserver's internal listener takes a 10 MB body, and the gateway forwards the payload's JSON
	// as it came, already escaped as Go encodes it.
	linkEventFrameCeiling = linkMaxJoinedFrameBytes - 64<<10
	// linkEventsIdle is how long the sender sleeps with nothing due.
	linkEventsIdle = time.Hour
)

// linkEventRetryMax is how long a session waits before sending again after a failure, at most. A variable only so that
// a test can shorten it, to reach maxEventFlushServerRejections refusals in a row in good time.
var linkEventRetryMax = 10 * time.Second

var (
	// errLinkEventsOffLink is a wait for a session's events that ended because the link went out of use: what is held
	// goes over HTTPS instead.
	errLinkEventsOffLink = errors.New("the runner link is no longer in use: the session's events go over HTTPS")
	// errLinkEventsMoved is an HTTPS event batch answered UPGRADE_REQUIRED: the link carries the session's events now.
	errLinkEventsMoved = errors.New("the control plane takes this session's events only over the runner link now")
	// errLinkEventsSuperseded is events handed to a stream after its supervisor returned, while a newer supervisor of the
	// session holds a stream of its own: they are not sent (linkEventStream.submit).
	errLinkEventsSuperseded = errors.New("a newer supervisor holds the session's event stream: events handed over after their supervisor returned are not sent")
	// errLinkEventsAbandoned is a session's stream given up (linkEventStream.abandonLocked): the control plane refused the
	// same events maxEventFlushServerRejections times in a row, for a reason neither retryable nor the session's lease, or
	// the runner had no room left to hold them. What the stream held is in the spool. The session's supervisor ends the
	// session with it as its error (session.go).
	errLinkEventsAbandoned = errors.New("the runner link gave up the session's events")
)

// linkCredit is an amount of durable events: a count and their payload bytes (proto Credit).
type linkCredit struct {
	events uint32
	bytes  uint64
}

// linkDefaultCredit is what a Welcome that grants none is taken to grant: the gateway's own default.
var linkDefaultCredit = linkCredit{events: 10_000, bytes: 64 << 20}

func (c linkCredit) fits(more linkCredit, limit linkCredit) bool {
	return c.events+more.events <= limit.events && c.bytes+more.bytes <= limit.bytes
}

// linkEvent is one durable event held for a session: what its EventBatch entry carries, and what the stream knows of
// it.
type linkEvent struct {
	seq     uint64
	typ     string
	tsMs    int64
	turnID  string
	payload []byte
	// boundary sends the session's events at once; critical is a CURRENT_WORK delivery acknowledgement, whose refusal
	// fails the session's next flush (criticalEventFlushFence); progress names a report a newer one may take the place
	// of (linkProgressKind); row is whether the control plane stores it as a row (linkRowEvent): not the bare ping
	// that holds an HTTPS-era live event's seq.
	boundary bool
	critical bool
	progress string
	row      bool
}

// size is what the event takes in memory, near enough.
func (ev *linkEvent) size() int64 { return int64(len(ev.payload)+len(ev.typ)+len(ev.turnID)) + 64 }

func (ev *linkEvent) proto() *linkpb.Event {
	return &linkpb.Event{Seq: ev.seq, Type: ev.typ, TsUnixMs: ev.tsMs, TurnId: ev.turnID, PayloadJson: ev.payload}
}

// runEvent is the event as an HTTPS batch carries it.
func (ev *linkEvent) runEvent() RunEvent {
	var payload map[string]interface{}
	_ = json.Unmarshal(ev.payload, &payload)
	return RunEvent{Seq: int(ev.seq), Type: ev.typ, TS: time.UnixMilli(ev.tsMs).UTC().Format("2006-01-02T15:04:05.000Z07:00"),
		TurnID: ev.turnID, Payload: payload}
}

// linkEventTime is an event's ts in Unix milliseconds: the time the runner recorded, or now when it cannot be read.
func linkEventTime(ts string) int64 {
	if t, err := time.Parse(time.RFC3339Nano, ts); err == nil {
		return t.UnixMilli()
	}
	return time.Now().UnixMilli()
}

// linkEvents is the durable event stream of one link mode: every session's unacknowledged events, the connection they
// go out on, and its credit.
type linkEvents struct {
	m     *linkMode
	log   func(...any)
	spool *linkSpool
	// wake has the sender look again; stop ends it, and done is closed once it has.
	wake chan struct{}
	stop chan struct{}
	done chan struct{}
	// onLink is whether the link is in use (linkMode.inUse), kept here so that nothing of the stream asks the link mode,
	// which calls into the stream while it holds its own lock. useChanged is closed, and replaced, whenever it changes.
	onLink atomic.Bool
	// creditBlocked is set while a session holds events the connection's credit has no room for (§5.8: the live stream
	// is dropped then, and progress reports merge).
	creditBlocked atomic.Bool
	// trimmed counts the events sent without the fields that made them too large for the link.
	trimmed atomic.Uint64
	// memBytes is what every stream holds in memory. Not under mu: an emitter adjusts it (mergeProgress), and an
	// emitter never waits.
	memBytes atomic.Int64
	// overBytes is what every stream's over takes (linkTotalOverBytes).
	overBytes atomic.Int64

	// mu is held only for moments, never across the disk or the network: emitters and the sender take it.
	mu         sync.Mutex
	streams    map[string]*linkEventStream // by session, as decodeSessionID spells it
	loading    map[string]chan struct{}    // sessions whose stream open reads from the spool, closed once it is in streams
	conn       *linkWorkConn               // the welcomed connection batches go out on; nil while there is none
	credit     linkCredit                  // conn's
	inflight   linkCredit                  // sent on conn and not acknowledged
	useChanged chan struct{}
	order      int // where the sender's next pass starts, so that no session always goes last
	closed     bool
}

func newLinkEvents(m *linkMode, log func(...any)) *linkEvents {
	e := &linkEvents{
		m: m, log: log, spool: newLinkSpool(linkSpoolDir(), log),
		wake: make(chan struct{}, 1), stop: make(chan struct{}), done: make(chan struct{}),
		streams: map[string]*linkEventStream{}, loading: map[string]chan struct{}{}, credit: linkDefaultCredit,
		useChanged: make(chan struct{}),
	}
	go e.run()
	return e
}

// poke has the sender look again, without waiting.
func (e *linkEvents) poke() {
	select {
	case e.wake <- struct{}{}:
	default:
	}
}

// setOnLink takes whether the link is in use now. A wait for a session's events ends when it goes out of use.
func (e *linkEvents) setOnLink(use bool) {
	if e.onLink.Swap(use) == use {
		return
	}
	e.mu.Lock()
	close(e.useChanged)
	e.useChanged = make(chan struct{})
	if !use {
		e.conn = nil
	}
	e.mu.Unlock()
	if !use {
		e.creditBlocked.Store(false) // credit is the link's: over HTTPS nothing holds events back
	}
	e.poke()
}

func (e *linkEvents) useChange() <-chan struct{} {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.useChanged
}

// open is the stream of a session a supervisor starts for, held until it releases it: the one this process already
// holds for the session, or one with whatever an earlier process left in the spool for it. Finding the stream and
// holding it are one step under mu, so that an ack that empties it cannot let it go in between: the supervisor would
// hold a stream the sender no longer sees, whose events nobody sends. Reading the spool is not under mu, which the
// sender and the emitters of every other session take; an open of the same session meanwhile waits for it.
func (e *linkEvents) open(sessionID string) *linkEventStream {
	key := decodeSessionID(sessionID)
	for {
		e.mu.Lock()
		if s := e.streams[key]; s != nil {
			s.held++
			e.mu.Unlock()
			return s
		}
		if loading := e.loading[key]; loading != nil {
			e.mu.Unlock()
			<-loading
			continue
		}
		loaded := make(chan struct{})
		e.loading[key] = loaded
		e.mu.Unlock()
		s := newLinkEventStream(e, sessionID, key)
		e.mu.Lock()
		s.held = 1
		e.streams[key] = s
		delete(e.loading, key)
		e.mu.Unlock()
		close(loaded)
		return s
	}
}

// stream is the stream of a session, nil when there is none.
func (e *linkEvents) stream(sessionID string) *linkEventStream {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.streams[decodeSessionID(sessionID)]
}

func (e *linkEvents) snapshot() []*linkEventStream {
	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([]*linkEventStream, 0, len(e.streams))
	for _, s := range e.streams {
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].key < out[j].key })
	if n := len(out); n > 1 {
		start := e.order % n
		e.order++
		out = append(out[start:], out[:start]...)
	}
	return out
}

// forget lets a stream that holds nothing go, unless a supervisor holds it, and reports whether it did. Called with
// s.mu held.
func (e *linkEvents) forget(s *linkEventStream) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if s.held > 0 || e.streams[s.key] != s {
		return false
	}
	delete(e.streams, s.key)
	return true
}

// welcomed takes a connection the work just adopted: its credit, how far each session's events are stored, and who
// watches which session. Everything held is sent again on it, from the smallest seq. Nothing goes out on it until every
// stream has started over: a batch sent before its stream started over would be forgotten by the stream while it still
// counted against the credit, and sent a second time.
func (e *linkEvents) welcomed(conn *linkWorkConn, w *linkpb.Welcome) {
	credit := linkDefaultCredit
	if c := w.GetCredit(); c != nil {
		credit = linkCredit{events: c.GetMaxUnackedEvents(), bytes: c.GetMaxUnackedBytes()}
	}
	durable := map[string]uint64{}
	for _, st := range w.GetSessions() {
		durable[decodeSessionID(st.GetSessionId())] = st.GetDurableSeq()
	}
	e.mu.Lock()
	e.conn = nil
	e.mu.Unlock()
	for _, s := range e.snapshot() {
		d, named := durable[s.key]
		s.resend(d, named)
	}
	e.mu.Lock()
	e.conn, e.credit, e.inflight = conn, credit, linkCredit{}
	e.mu.Unlock()
	e.creditBlocked.Store(false)
	e.hintState(w.GetHints())
	e.poke()
}

// onCredit takes a Credit frame: what may be in flight on conn from now on.
func (e *linkEvents) onCredit(conn *linkWorkConn, c *linkpb.Credit) {
	e.mu.Lock()
	if e.conn == conn {
		e.credit = linkCredit{events: c.GetMaxUnackedEvents(), bytes: c.GetMaxUnackedBytes()}
	}
	e.mu.Unlock()
	e.poke()
}

// onAck takes an EventAck that came on conn.
func (e *linkEvents) onAck(conn *linkWorkConn, ack *linkpb.EventAck) {
	if s := e.stream(ack.GetSessionId()); s != nil {
		s.acked(conn, ack)
	}
	e.poke()
}

// hurry has a session's events sent at once: a call is about to wait for them to be stored (after_seq).
func (e *linkEvents) hurry(sessionID string) {
	if s := e.stream(sessionID); s != nil {
		s.mu.Lock()
		s.urgent = true
		s.mu.Unlock()
		e.poke()
	}
}

// held is every session the stream holds events of, with the highest seq handed over for each: what a Hello resumes.
func (e *linkEvents) held() map[string]uint64 {
	out := map[string]uint64{}
	for _, s := range e.snapshot() {
		s.mu.Lock()
		if s.tail > 0 {
			out[s.id] = s.tail
		}
		s.mu.Unlock()
	}
	return out
}

// rowSeqs is, for a session, the highest seq handed over of an event the control plane stores as a row, and the
// highest of those known stored: what a call that depends on the session's events waits for (after_seq).
func (e *linkEvents) rowSeqs(sessionID string) (handed, stored uint64) {
	if s := e.stream(sessionID); s != nil {
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.lastRow, s.storedRow
	}
	return 0, 0
}

// reserveMemory takes n bytes of the memory all streams share, when there is room.
func (e *linkEvents) reserveMemory(n int64) bool {
	for {
		cur := e.memBytes.Load()
		if cur+n > linkTotalMemoryBytes {
			return false
		}
		if e.memBytes.CompareAndSwap(cur, cur+n) {
			return true
		}
	}
}

func (e *linkEvents) releaseMemory(n int64) {
	if n != 0 {
		e.memBytes.Add(-n)
	}
}

// reserveOver takes n bytes of what every stream's over may take together, when there is room.
func (e *linkEvents) reserveOver(n int64) bool {
	for {
		cur := e.overBytes.Load()
		if cur+n > linkTotalOverBytes {
			return false
		}
		if e.overBytes.CompareAndSwap(cur, cur+n) {
			return true
		}
	}
}

func (e *linkEvents) releaseOver(n int64) {
	if n != 0 {
		e.overBytes.Add(-n)
	}
}

// close stops the sender and writes what every session still holds to the spool, for the next process to send: the
// runner is stopping.
func (e *linkEvents) close() {
	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return
	}
	e.closed = true
	close(e.stop)
	e.mu.Unlock()
	<-e.done
	for _, s := range e.snapshot() {
		s.persist()
		// Handed to the next process: no longer this one's unflushed work (managed_sleep.go).
		s.dropBacklog()
	}
}

// run is the sender: it sends what is due, and sleeps until something else is.
func (e *linkEvents) run() {
	defer close(e.done)
	timer := time.NewTimer(linkEventsIdle)
	defer timer.Stop()
	for {
		next := e.pass(time.Now())
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(max(time.Until(next), time.Millisecond))
		select {
		case <-e.stop:
			return
		case <-e.wake:
		case <-timer.C:
		}
	}
}

// pass sends every batch and live batch that is due on the current connection, and returns when the next one is.
func (e *linkEvents) pass(now time.Time) time.Time {
	next := now.Add(linkEventsIdle)
	e.mu.Lock()
	conn := e.conn
	e.mu.Unlock()
	if conn == nil || conn.ended() || !e.onLink.Load() {
		return next
	}
	blocked := false
	for _, s := range e.snapshot() {
		for {
			frame, due, starved := s.nextBatch(conn, now)
			blocked = blocked || starved
			if frame == nil {
				if due.Before(next) {
					next = due
				}
				break
			}
			if _, err := conn.send(frame); err != nil {
				// The write failed, which ends the connection: what it carried goes again on the next one.
				_ = conn.ws.CloseNow()
				return next
			}
		}
	}
	e.creditBlocked.Store(blocked)
	if due := e.passLive(conn, now); due.Before(next) {
		next = due
	}
	return next
}

// linkEventStream is one session's durable events between their emitter and the control plane, and its live stream
// (link_events_live.go).
type linkEventStream struct {
	e   *linkEvents
	id  string // the session as the daemon names it, which its EventBatches carry and its EventAcks name
	key string // decodeSessionID(id)
	// floor is the seq a Welcome says the session is stored through: new events are numbered after it.
	floor atomic.Uint64
	// held counts the supervisors holding the stream. Under e.mu, so that open finds a stream and holds it in one step.
	held int

	mu sync.Mutex
	// forgotten is set once the stream has been let go, holding nothing and held by nobody; successor is the stream a
	// newer supervisor of the session opened since, which keeps whatever is still handed to this one from being sent
	// (registered, submit).
	forgotten bool
	successor *linkEventStream
	// lastRow is the highest seq handed over of an event the control plane stores as a row, and storedRow the highest
	// of those known stored (linkEventStream.rowSeqs).
	lastRow, storedRow uint64
	// refused is the last refusal that was neither retryable nor the session's own, which the stream sends again after
	// like a retryable failure; refusals counts them, so that a wait tells of one that came while it waited. refusedInARow
	// counts those since the last ack that stored or failed retryably, as the HTTPS flush counts its 500s: at
	// maxEventFlushServerRejections the stream is given up (abandonLocked).
	refused       error
	refusals      int
	refusedInARow int
	// The events held, in seq order: mem, then those on disk, then over (in memory again, when the disk refused them),
	// which takes overBytes of linkTotalOverBytes. mem[:sentN] went out in the batch in flight on batchConn.
	mem       []*linkEvent
	memBytes  int64
	disk      *linkSpoolQueue
	over      []*linkEvent
	overBytes int64
	sentN     int
	// The batch in flight: the connection it went out on, nil while there is none, and what it takes of the credit.
	batchConn   *linkWorkConn
	batchAmount linkCredit
	// tail is the highest seq ever handed over; stored, the highest seq the control plane is known to hold every event
	// of the session through (acks, Welcomes, and what went over HTTPS).
	tail, stored uint64
	// unsentSince is when the earliest event not yet sent was handed over; urgent sends the session's events without
	// waiting for the cadence.
	unsentSince time.Time
	urgent      bool
	// After a retryable failure: when to send again, and how many failures in a row there have been.
	retryAt  time.Time
	failures int
	// failure is a refusal that was not retryable: the server stores nothing more of the session's.
	failure error
	// changed is closed, and replaced, whenever stored or failure changes.
	changed chan struct{}
	// backlog counts what is held for the managed workload report (managed_sleep.go); fence is the session's own,
	// which a refused CURRENT_WORK acknowledgement makes fail its flushes.
	backlog     *eventBacklog
	dropBacklog func()
	fence       *criticalEventFlushFence
	// diskFull is set once the disk refused an event, so that it is said once.
	diskFull bool

	live linkLiveStream
}

func newLinkEventStream(e *linkEvents, id, key string) *linkEventStream {
	s := &linkEventStream{e: e, id: id, key: key, changed: make(chan struct{}), fence: &criticalEventFlushFence{}}
	s.backlog, s.dropBacklog = newEventBacklog()
	s.disk = e.spool.queue(key)
	if s.disk.count() > 0 {
		// An earlier process left these: they are sent first, and new events numbered after them.
		s.tail = s.disk.last()
		for _, seg := range s.disk.segs {
			s.lastRow = max(s.lastRow, seg.lastRow)
		}
		s.backlog.n.Add(int64(s.disk.count()))
		s.unsentSince, s.urgent = time.Now(), true
		e.log(fmt.Sprintf("runner link: session %s has %d events through seq %d an earlier process could not send; they go first",
			id, s.disk.count(), s.tail))
	}
	return s
}

// onLink reports whether the session's events go over the link now.
func (s *linkEventStream) onLink() bool { return s.e.onLink.Load() }

// setFence makes fence the one a refused CURRENT_WORK acknowledgement is recorded in: the holder's own.
func (s *linkEventStream) setFence(fence *criticalEventFlushFence) {
	s.mu.Lock()
	s.fence = fence
	s.mu.Unlock()
}

// firstSeq is the seq a supervisor numbers the session's next event from: claimed, the claim's MaxSeq plus one, or
// after the last seq handed over or the floor a Welcome set, whichever is later.
func (s *linkEventStream) firstSeq(claimed int) int {
	s.mu.Lock()
	tail := s.tail
	s.mu.Unlock()
	return s.numberFrom(max(claimed, int(min(tail, math.MaxInt32))+1))
}

// numberFrom is next, or the seq after the floor a Welcome set when that is later: the server holds every seq through
// the floor, and one numbered again is skipped by its stored-once ingest.
func (s *linkEventStream) numberFrom(next int) int {
	if f := s.floor.Load(); f >= uint64(next) && f < math.MaxInt32 {
		return int(f) + 1
	}
	return next
}

// raiseFloor takes a seq the session is stored through, learnt after its supervisor started numbering.
func (s *linkEventStream) raiseFloor(seq uint64) {
	for {
		f := s.floor.Load()
		if seq <= f || s.floor.CompareAndSwap(f, seq) {
			return
		}
	}
}

// release lets go of the stream for a supervisor that is ending. What it still holds keeps being sent, and goes to the
// spool if the runner stops first; what is handed to it later is too (registered).
func (s *linkEventStream) release() {
	s.e.mu.Lock()
	s.held--
	s.e.mu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.forgetIfIdleLocked()
}

// registered is the stream that takes the session's events now. Usually s. A stream let go once it held nothing and
// nobody held it can still be handed events: a supervisor's background-job report comes after the supervisor returned
// (bg.recordJobs, session.go). It is then the session's stream again, sent from as before; or, when a newer
// supervisor opened a stream of the session meanwhile, that one is, and what is handed to s is not sent (submit).
func (s *linkEventStream) registered() *linkEventStream {
	for {
		s.mu.Lock()
		if next := s.successor; next != nil {
			s.mu.Unlock()
			return next.registered()
		}
		if !s.forgotten || s.failure != nil {
			// A stream the session's own refusal ended is never the session's again: its submit says why, and a
			// newer supervisor opens a stream of its own.
			s.mu.Unlock()
			return s
		}
		e := s.e
		e.mu.Lock()
		other, loading := e.streams[s.key], e.loading[s.key]
		if other == nil && loading == nil {
			e.streams[s.key] = s
			s.forgotten = false
			if s.batchConn != e.conn {
				s.batchConn, s.batchAmount, s.sentN = nil, linkCredit{}, 0 // went on a connection that is gone
			}
			e.mu.Unlock()
			s.backlog, s.dropBacklog = newEventBacklog()
			s.mu.Unlock()
			return s
		}
		e.mu.Unlock()
		if other != nil {
			s.successor = other
			s.mu.Unlock()
			continue
		}
		s.mu.Unlock()
		<-loading
	}
}

func (s *linkEventStream) emptyLocked() bool {
	return len(s.mem) == 0 && s.disk.count() == 0 && len(s.over) == 0
}

func (s *linkEventStream) notifyLocked() {
	close(s.changed)
	s.changed = make(chan struct{})
}

// submit hands events over, in seq order. The stream holds each until it is stored. Nothing here waits for the network
// or for credit: events past the memory bounds go to the spool, and to memory again when the disk will not take them.
// An event already handed over, or one the control plane is known to hold, is skipped. It returns the refusal that
// ended the stream, if one did: the events are dropped then, since nothing will store them. Events handed to a stream
// whose supervisor returned, once a newer supervisor holds a stream of the session, are not sent either
// (errLinkEventsSuperseded).
func (s *linkEventStream) submit(events []RunEvent) error {
	if len(events) == 0 {
		return nil
	}
	for {
		if next := s.registered(); next != s {
			// The newer supervisor numbers its events from what the control plane held when it was claimed, so these,
			// numbered by the supervisor before it, may be at seqs it numbers too. Handed to its stream ahead of its own
			// they would have it skip its own as handed over already (seq <= tail), and say nothing of it.
			s.e.log(fmt.Sprintf("runner link: %d events of session %s, seq %d to %d, were handed over after their supervisor returned, and a newer supervisor holds the session's stream; they are not sent",
				len(events), s.id, events[0].Seq, events[len(events)-1].Seq))
			return errLinkEventsSuperseded
		}
		s.mu.Lock()
		if s.forgotten && s.failure == nil {
			// Let go again since registered took it up: a Welcome found it holding nothing, and nobody holds it. What it
			// held now, the sender would never send.
			s.mu.Unlock()
			continue
		}
		err := s.submitLocked(events)
		s.mu.Unlock()
		return err
	}
}

// submitLocked is submit to a stream that is the session's.
func (s *linkEventStream) submitLocked(events []RunEvent) error {
	if errors.Is(s.failure, errLinkEventsAbandoned) {
		s.keepGivenUpLocked(events)
	}
	if s.failure != nil {
		return s.failure
	}
	now := time.Now()
	added := false
	for _, re := range events {
		seq := uint64(re.Seq)
		if re.Seq <= 0 || seq <= s.tail || seq <= s.stored {
			continue
		}
		ev := s.linkEventOf(re)
		s.tail = seq
		if ev.row {
			s.lastRow = seq
		}
		s.backlog.buffered()
		if err := s.holdLocked(ev); err != nil {
			s.keepGivenUpLocked(events) // those after ev, behind it in the spool
			return err
		}
		if ev.boundary {
			s.urgent = true
		}
		added = true
	}
	if added && s.unsentSince.IsZero() {
		s.unsentSince = now
	}
	if added {
		s.e.poke()
	}
	return nil
}

// holdLocked keeps ev after everything held: in memory while there is room and nothing waits on disk, else on disk,
// else in memory after all, within what every stream's over may take together (linkTotalOverBytes). Past that the
// stream is given up (abandonLocked), and holdLocked returns why.
func (s *linkEventStream) holdLocked(ev *linkEvent) error {
	size := ev.size()
	if len(s.over) == 0 && s.disk.count() == 0 && s.memBytes+size <= linkSessionMemoryBytes && s.e.reserveMemory(size) {
		s.mem = append(s.mem, ev)
		s.memBytes += size
		return nil
	}
	if len(s.over) == 0 {
		err := s.disk.append(ev)
		if err == nil {
			return nil
		}
		if !s.diskFull {
			s.diskFull = true
			s.e.log(fmt.Sprintf("runner link: session %s holds its events in memory: the link spool did not take seq %d (%v)",
				s.id, ev.seq, err))
		}
	}
	if !s.e.reserveOver(size) {
		s.abandonLocked(fmt.Errorf("%w: memory, the link spool and the %d MiB of memory past them that every session shares are full, at seq %d",
			errLinkEventsAbandoned, linkTotalOverBytes>>20, ev.seq), ev)
		return s.failure
	}
	s.over = append(s.over, ev)
	s.overBytes += size
	return nil
}

// linkEventOf is re as the stream holds it. A live-only event numbered while the session's events went over HTTPS goes
// as a bare ping holding its seq (linkLiveEventSeqPlaceholder). An event too large for any frame is trimmed.
func (s *linkEventStream) linkEventOf(re RunEvent) *linkEvent {
	payload := re.Payload
	if linkLiveOnlyTypes[re.Type] {
		re.Type, payload = evSystem, linkLiveEventSeqPlaceholder()
	}
	raw, err := json.Marshal(payload)
	if err != nil || payload == nil {
		raw = []byte("{}")
	}
	ev := &linkEvent{
		seq: uint64(re.Seq), typ: re.Type, tsMs: linkEventTime(re.TS), turnID: re.TurnID, payload: raw,
		boundary: linkBoundaryEvent(re.Type, payload), critical: isCriticalDeliveryAcknowledgement(re),
		progress: linkProgressKind(re.Type, payload), row: linkRowEvent(re.Type, payload),
	}
	if size := s.oneEventFrameSize(ev); size > linkEventFrameCeiling {
		ev.payload = linkTrimmedPayload(payload, len(raw))
		n := s.e.trimmed.Add(1)
		s.e.log(fmt.Sprintf("runner link: event seq %d (%s) of session %s is %d bytes, more than one frame carries (%d); it goes without its large fields (%d trimmed so far)",
			ev.seq, ev.typ, s.id, len(raw), linkEventFrameCeiling, n))
	}
	return ev
}

// oneEventFrameSize is the encoded size of the frame ev would go in alone.
func (s *linkEventStream) oneEventFrameSize(ev *linkEvent) int {
	return proto.Size(&linkpb.Frame{Id: math.MaxUint64, Body: &linkpb.Frame_EventBatch{EventBatch: &linkpb.EventBatch{
		SessionId: s.id, Events: []*linkpb.Event{ev.proto()},
	}}})
}

// mergeProgress lets a progress report take the place of the session's newest event, at that event's seq, while the
// link's credit holds the session's events back (§5.8): when that event is a report of the same kind and turn not sent
// yet, still in the session's buffer (buf) or handed over to the stream. newest is the seq the session numbered last.
// It reports whether it did; the report then takes no seq of its own, so no seq is left without its event. It runs on
// an emitter, which never waits: a stream busy with its spool leaves the report to take a seq of its own.
func (s *linkEventStream) mergeProgress(buf []RunEvent, newest int, turnID, eventType string, payload map[string]interface{}) bool {
	kind := linkProgressKind(eventType, payload)
	if kind == "" || !s.onLink() || !s.e.creditBlocked.Load() {
		return false
	}
	if n := len(buf); n > 0 {
		last := &buf[n-1]
		if last.Seq != newest || last.TurnID != turnID || linkProgressKind(last.Type, last.Payload) != kind {
			return false
		}
		last.Payload, last.TS = payload, nowISO()
		return true
	}
	if !s.mu.TryLock() {
		return false
	}
	defer s.mu.Unlock()
	if len(s.over) > 0 || s.disk.count() > 0 || len(s.mem) <= s.sentN {
		return false
	}
	last := s.mem[len(s.mem)-1]
	if newest <= 0 || last.seq != uint64(newest) || last.progress != kind || last.turnID != turnID {
		return false
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return false
	}
	grown := int64(len(raw) - len(last.payload))
	last.payload, last.tsMs = raw, time.Now().UnixMilli()
	s.memBytes += grown
	s.e.memBytes.Add(grown)
	return true
}

// nextBatch is the frame of the session's next batch on conn, when one is due and the credit has room for it. Else
// it is nil, with when the next one will be due, and whether the credit is what holds it.
func (s *linkEventStream) nextBatch(conn *linkWorkConn, now time.Time) (*linkpb.Frame, time.Time, bool) {
	never := now.Add(linkEventsIdle)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failure != nil || s.batchConn != nil {
		return nil, never, false
	}
	s.fillLocked()
	unsent := s.mem[s.sentN:]
	if len(unsent) == 0 {
		return nil, never, false
	}
	if now.Before(s.retryAt) {
		return nil, s.retryAt, false
	}
	if !s.urgent && now.Sub(s.unsentSince) < linkEventCadence {
		return nil, s.unsentSince.Add(linkEventCadence), false
	}
	e := s.e
	e.mu.Lock()
	if e.conn != conn {
		e.mu.Unlock()
		return nil, never, false
	}
	var amount linkCredit
	n := 0
	for _, ev := range unsent {
		more := linkCredit{events: 1, bytes: uint64(len(ev.payload))}
		if n > 0 && (n >= linkBatchMaxEvents || amount.bytes+more.bytes > linkBatchMaxBytes) {
			break
		}
		if n > 0 && ev.seq != unsent[n-1].seq+1 {
			break // a batch's seqs count up by one; what follows a gap goes in a batch of its own
		}
		if !e.inflight.fits(linkCredit{events: amount.events + more.events, bytes: amount.bytes + more.bytes}, e.credit) {
			break
		}
		amount.events += more.events
		amount.bytes += more.bytes
		n++
	}
	if n == 0 {
		e.mu.Unlock()
		return nil, never, true // an ack or a Credit frame makes room, and wakes the sender
	}
	e.inflight.events += amount.events
	e.inflight.bytes += amount.bytes
	e.mu.Unlock()
	batch := &linkpb.EventBatch{SessionId: s.id, Events: make([]*linkpb.Event, n)}
	for i, ev := range unsent[:n] {
		batch.Events[i] = ev.proto()
	}
	s.sentN += n
	s.batchConn, s.batchAmount = conn, amount
	if s.sentN == len(s.mem) && s.disk.count() == 0 && len(s.over) == 0 {
		s.urgent, s.unsentSince = false, time.Time{}
	}
	return &linkpb.Frame{Body: &linkpb.Frame_EventBatch{EventBatch: batch}}, never, false
}

// fillLocked brings what waits on disk, or in over behind it, into memory when nothing in memory is left to send.
func (s *linkEventStream) fillLocked() {
	if s.sentN < len(s.mem) {
		return
	}
	if s.disk.count() > 0 {
		before := s.disk.count()
		events := s.disk.takeFirst(s.stored)
		if gone := before - s.disk.count() - len(events); gone > 0 {
			s.backlog.settled(gone) // stored already, or lost with a damaged segment
		}
		for _, ev := range events {
			size := ev.size()
			s.e.memBytes.Add(size) // the head is needed to go on, whatever the bound says
			s.mem = append(s.mem, ev)
			s.memBytes += size
		}
		return
	}
	if len(s.over) > 0 {
		for _, ev := range s.over {
			size := ev.size()
			s.e.memBytes.Add(size)
			s.memBytes += size
		}
		s.mem = append(s.mem, s.over...)
		s.e.releaseOver(s.overBytes)
		s.over, s.overBytes = nil, 0
	}
}

// acked takes the EventAck of the session's batch that came on conn.
func (s *linkEventStream) acked(conn *linkWorkConn, ack *linkpb.EventAck) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if rejected := ack.GetRejected(); len(rejected) > 0 {
		s.rejectedLocked(rejected)
	}
	durable := ack.GetDurableSeq()
	if conn == nil || s.batchConn != conn {
		// From a connection replaced since. How far the events are stored still holds for whoever waits for them, but
		// they stay to be sent again on the connection that replaced it: that one's batches have to count up from
		// where that connection has got to, which this ack says nothing about.
		s.raiseStoredLocked(durable)
		return
	}
	// Only the current connection's batches count against its credit: a Welcome started the count afresh.
	s.e.mu.Lock()
	if s.e.conn == conn {
		s.e.inflight.events -= min(s.e.inflight.events, s.batchAmount.events)
		s.e.inflight.bytes -= min(s.e.inflight.bytes, s.batchAmount.bytes)
	}
	s.e.mu.Unlock()
	s.batchConn, s.batchAmount = nil, linkCredit{}
	s.raiseStoredLocked(durable)
	s.dropThroughLocked(durable)
	// Whatever of the batch the ack does not cover goes again.
	s.sentN = 0
	f := ack.GetFailure()
	if f == nil {
		s.failures, s.retryAt, s.refusedInARow = 0, time.Time{}, 0
		return
	}
	if !f.GetRetryable() {
		refusal := linkEventsRefusal(s.id, f)
		if isLeaseOwnershipError(refusal) {
			s.failLocked(refusal)
			return
		}
		// Not the session's own: HTTPS sends such a batch again, and so does the stream, until it has been refused
		// maxEventFlushServerRejections times in a row (eventFlushRetryPolicy). A wait for the events hears of each
		// refusal, as an HTTPS flush would.
		s.refusedInARow++
		if s.refusedInARow >= maxEventFlushServerRejections {
			s.abandonLocked(fmt.Errorf("%w: the control plane refused the events after seq %d %d times in a row: %w",
				errLinkEventsAbandoned, durable, s.refusedInARow, refusal))
			return
		}
		s.refused, s.refusals = refusal, s.refusals+1
		s.notifyLocked()
	} else {
		// One that may clear on its own (a restart, the database failing over) says nothing against these events, as
		// for the HTTPS flush's count.
		s.refusedInARow = 0
	}
	s.failures++
	wait := max(time.Duration(f.GetRetryAfterMs())*time.Millisecond, linkEventRetryBackoff(s.failures))
	s.retryAt, s.urgent = time.Now().Add(wait), true
	if s.failures == 1 || s.failures%10 == 0 {
		s.e.log(fmt.Sprintf("runner link: the events of session %s after seq %d were not stored (%s, retryable %v: %s); sending them again in %s (failure %d)",
			s.id, durable, f.GetCode(), f.GetRetryable(), f.GetMessage(), wait.Round(time.Millisecond), s.failures))
	}
	if f.GetCode() == "EVENT_SEQ_GAP" {
		// What the session holds does not follow on from what this connection forwarded: a segment of its spool was
		// lost. A connection's first batch of a session may start anywhere, so the gap is crossed on a new one.
		s.e.log(fmt.Sprintf("runner link: the events session %s holds do not follow on from seq %d; connection %s is replaced to send them",
			s.id, durable, conn.id))
		go func() { _ = conn.ws.CloseNow() }()
	}
}

// linkEventRetryBackoff is the wait before a session's events are sent again after its nth failure in a row: full
// jitter, from 250ms up to linkEventRetryMax.
func linkEventRetryBackoff(n int) time.Duration {
	ceiling := min(250*time.Millisecond<<min(n-1, 6), linkEventRetryMax)
	return time.Duration(mrand.Int64N(int64(ceiling))) + time.Millisecond
}

// rejectedLocked logs the events the server refused, which tombstones hold the seqs of. A refused CURRENT_WORK delivery
// acknowledgement fails the session's next flush: its turn's completion relies on it being stored.
func (s *linkEventStream) rejectedLocked(rejected []*linkpb.RejectedEvent) {
	var parts []string
	for _, r := range rejected {
		if len(parts) < 10 {
			parts = append(parts, fmt.Sprintf("seq %d %s", r.GetSeq(), r.GetCode()))
		}
		for _, ev := range s.mem {
			if ev.seq == r.GetSeq() && ev.critical {
				_ = s.fence.recordDropped([]RunEvent{ev.runEvent()}, fmt.Errorf("the control plane refused it: %s %s", r.GetCode(), r.GetMessage()))
			}
		}
	}
	if len(rejected) > len(parts) {
		parts = append(parts, "…")
	}
	s.e.log(fmt.Sprintf("runner link: the control plane refused %d event(s) of session %s, held by tombstones: %s",
		len(rejected), s.id, strings.Join(parts, ", ")))
}

// raiseStoredLocked takes that the control plane holds the session's events through seq, and tells whoever waits for
// them.
func (s *linkEventStream) raiseStoredLocked(seq uint64) {
	if seq <= s.stored {
		return
	}
	s.stored = seq
	s.notifyLocked()
}

// dropThroughLocked drops the events held through seq: they are stored, and never sent again.
func (s *linkEventStream) dropThroughLocked(seq uint64) {
	n := 0
	var freed int64
	for n < len(s.mem) && s.mem[n].seq <= seq {
		freed += s.mem[n].size()
		if s.mem[n].row {
			s.storedRow = max(s.storedRow, s.mem[n].seq)
		}
		n++
	}
	if n > 0 {
		s.mem = append([]*linkEvent(nil), s.mem[n:]...)
		s.memBytes -= freed
		s.e.releaseMemory(freed)
		s.sentN = max(s.sentN-n, 0)
		s.backlog.settled(n)
	}
	if dropped, lastRow := s.disk.dropThrough(seq); dropped > 0 {
		s.storedRow = max(s.storedRow, lastRow)
		s.backlog.settled(dropped)
	}
	if len(s.mem) == 0 && s.disk.count() == 0 {
		k := 0
		var overFreed int64
		for k < len(s.over) && s.over[k].seq <= seq {
			overFreed += s.over[k].size()
			if s.over[k].row {
				s.storedRow = max(s.storedRow, s.over[k].seq)
			}
			k++
		}
		if k > 0 {
			s.over = append([]*linkEvent(nil), s.over[k:]...)
			s.overBytes -= overFreed
			s.e.releaseOver(overFreed)
			s.backlog.settled(k)
		}
	}
	if s.emptyLocked() {
		s.urgent, s.unsentSince = false, time.Time{}
		s.forgetIfIdleLocked()
	}
}

// forgetIfIdleLocked lets the stream go once no supervisor holds it and it holds nothing more to send.
func (s *linkEventStream) forgetIfIdleLocked() {
	if !s.forgotten && (s.emptyLocked() || s.failure != nil) && s.e.forget(s) {
		s.forgotten = true
		s.dropBacklog()
	}
}

// fail ends the stream for a refusal that came another way: over HTTPS, while the link was out of use.
func (s *linkEventStream) fail(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failure == nil {
		s.failLocked(err)
	}
}

// failLocked ends the stream: the server stores nothing more of the session's, so what is held is dropped.
func (s *linkEventStream) failLocked(err error) {
	s.failure = err
	n := len(s.mem) + s.disk.count() + len(s.over)
	s.e.releaseMemory(s.memBytes)
	s.e.releaseOver(s.overBytes)
	s.mem, s.memBytes, s.over, s.overBytes, s.sentN = nil, 0, nil, 0, 0
	s.disk.remove()
	s.backlog.settled(n)
	s.e.log(fmt.Sprintf("runner link: the control plane will store no more events of session %s (%v); %d held events are not sent", s.id, err, n))
	s.notifyLocked()
	s.forgetIfIdleLocked()
}

// abandonLocked gives the stream up (errLinkEventsAbandoned, err): nothing more is sent, and a wait for its events,
// its supervisor's among them, ends with err, which ends the session (session.go). Unlike failLocked's refusal this
// one says nothing about the session's later events, so what is held, and unheld (an event there was no room for), is
// not dropped but written to the spool, as when the runner stops: there the next supervisor of the session sends it
// first, and anyone looking finds it. What the disk will not take the spool logs and counts as lost.
func (s *linkEventStream) abandonLocked(err error, unheld ...*linkEvent) {
	s.failure = err
	n := len(s.mem) + s.disk.count() + len(s.over) + len(unheld)
	persistErr := s.disk.persist(s.mem, append(s.over, unheld...))
	s.e.releaseMemory(s.memBytes)
	s.e.releaseOver(s.overBytes)
	s.mem, s.memBytes, s.over, s.overBytes, s.sentN = nil, 0, nil, 0, 0
	s.backlog.settled(n)
	kept := fmt.Sprintf("%d are kept in the spool for the session's next supervisor", s.disk.count())
	if persistErr != nil {
		kept += fmt.Sprintf(" (the rest could not be written: %v)", persistErr)
	}
	s.e.log(fmt.Sprintf("runner link: the events of session %s are given up (%v); of %d held, through seq %d, %s",
		s.id, err, n, s.tail, kept))
	s.notifyLocked()
	s.forgetIfIdleLocked()
}

// keepGivenUpLocked writes events handed to a stream after it was given up to the spool, behind what it held: the
// session's last ones, emitted while its supervisor ends it. Nothing of them is sent. Once the supervisor has let the
// stream go they are not written: the spool is a newer supervisor's of the session from then on.
func (s *linkEventStream) keepGivenUpLocked(events []RunEvent) {
	var late []*linkEvent
	for _, re := range events {
		if seq := uint64(re.Seq); re.Seq > 0 && seq > s.tail && seq > s.stored {
			late = append(late, s.linkEventOf(re))
			s.tail = seq
		}
	}
	if len(late) == 0 {
		return
	}
	if s.forgotten {
		s.e.log(fmt.Sprintf("runner link: %d events of session %s, through seq %d, were handed to its given-up stream after its supervisor returned; they are not kept",
			len(late), s.id, s.tail))
		return
	}
	if err := s.disk.persist(nil, late); err != nil {
		s.e.log(fmt.Sprintf("runner link: of %d events handed to the given-up stream of session %s, through seq %d, some could not be kept in the spool: %v",
			len(late), s.id, s.tail, err))
	}
}

// givenUp is why the stream was given up (abandonLocked), and nil while it was not.
func (s *linkEventStream) givenUp() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if errors.Is(s.failure, errLinkEventsAbandoned) {
		return s.failure
	}
	return nil
}

// linkEventsRefusal is a refusal that was not retryable, as the HTTPS answer the session's flush reads it as: the
// session no longer open or this process's lease lost (CONFLICT, FORBIDDEN, NOT_FOUND) as the lease ownership error it
// is (isLeaseOwnershipError).
func linkEventsRefusal(sessionID string, f *linkpb.Failure) error {
	status := http.StatusBadRequest
	switch f.GetCode() {
	case "CONFLICT":
		status = http.StatusConflict
	case "FORBIDDEN":
		status = http.StatusForbidden
	case "NOT_FOUND":
		status = http.StatusNotFound
	}
	body, _ := json.Marshal(map[string]any{"code": f.GetCode(), "message": f.GetMessage(), "retryable": false})
	return &transportHTTPError{method: "EventBatch", path: "/runner/sessions/" + sessionID + "/events", statusCode: status, body: string(body)}
}

// resend takes a new connection: how far its Welcome says the session's events are stored, when it says, and that
// everything held after that goes again on it, from the smallest seq.
func (s *linkEventStream) resend(durable uint64, named bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if named {
		s.raiseFloor(durable)
		s.raiseStoredLocked(durable)
		s.dropThroughLocked(durable)
	}
	s.sentN, s.batchConn, s.batchAmount = 0, nil, linkCredit{}
	s.retryAt, s.failures = time.Time{}, 0
	if !s.emptyLocked() {
		s.urgent = true
		if s.unsentSince.IsZero() {
			s.unsentSince = time.Now()
		}
	}
	s.live.reconnected()
}

// waitStored waits until everything handed over so far is stored. It returns the refusal that ended the stream, if one
// does, and errLinkEventsOffLink once the link is out of use: what is held then goes over HTTPS. A refusal the stream
// sends again after (linkEventStream.refused) ends the wait too, as an HTTPS flush returns its error and keeps the
// events for the next one. A stream a newer supervisor's took the place of waits only for what it holds itself: what
// was handed to it after that was not sent (submit).
func (s *linkEventStream) waitStored(ctx context.Context) error {
	s.mu.Lock()
	target, refusals := s.tail, s.refusals
	s.urgent = true
	s.mu.Unlock()
	s.e.poke()
	for {
		useChanged := s.e.useChange()
		if !s.onLink() {
			return errLinkEventsOffLink
		}
		s.mu.Lock()
		failure, stored, changed := s.failure, s.stored, s.changed
		refused := s.refused
		if s.refusals == refusals {
			refused = nil
		}
		s.mu.Unlock()
		if failure != nil {
			return failure
		}
		if stored >= target {
			return nil
		}
		if refused != nil {
			return refused
		}
		select {
		case <-changed:
		case <-useChanged:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// heldHead is the earliest events held, up to about maxBytes of payload, as an HTTPS batch carries them: what goes
// over HTTPS before anything newer once the link is out of use. Nothing while the link is in use again: the link sends
// them, and the batch it has in flight stays as it is, counted against its connection's credit until its ack.
func (s *linkEventStream) heldHead(maxBytes int) []RunEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failure != nil || s.onLink() {
		return nil
	}
	// A batch in flight went on a connection that is gone: what it carried goes over HTTPS.
	s.sentN, s.batchConn, s.batchAmount = 0, nil, linkCredit{}
	s.fillLocked()
	var out []RunEvent
	size := 0
	for _, ev := range s.mem {
		if len(out) > 0 && size+len(ev.payload) > maxBytes {
			break
		}
		out = append(out, ev.runEvent())
		size += len(ev.payload)
	}
	return out
}

// storedOverHTTPS takes that HTTPS stored the session's events first through last. What the stream holds of them is
// dropped, unless it still holds something older: HTTPS stores whatever it is given, so the batch says nothing about
// the seqs before it.
func (s *linkEventStream) storedOverHTTPS(first, last int) {
	if last <= 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if head, ok := s.headLocked(); ok && head < uint64(first) {
		return
	}
	s.raiseStoredLocked(uint64(last))
	s.dropThroughLocked(uint64(last))
}

// headLocked is the smallest seq the stream holds, if it holds any.
func (s *linkEventStream) headLocked() (uint64, bool) {
	switch {
	case len(s.mem) > 0:
		return s.mem[0].seq, true
	case s.disk.count() > 0:
		return s.disk.first(), true
	case len(s.over) > 0:
		return s.over[0].seq, true
	}
	return 0, false
}

// linkStoredSeqAfterTakeover is next, or one more than the highest seq the session has stored after it, when that is
// later: where a supervisor that starts in link mode numbers from. The claim's MaxSeq was read before this process
// took over the session's lease, and a batch the process it took the session from had in flight can commit between
// the two: a seq numbered again is skipped by the stored-once ingest, and its event is lost. Once the takeover has run,
// which it has when a supervisor starts, the lease fence holds and the read sees every such batch. It cannot see a
// tombstone at the very end of one (the route returns what a transcript replays), and a failed read leaves next as it
// was; HTTPS reads nothing, and has the same window.
func linkStoredSeqAfterTakeover(ctx context.Context, t *Transport, sessionID string, next int) int {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	after := next - 1
	for {
		page, err := t.sessionEvents(ctx, sessionID, after, 50)
		if err != nil || len(page.Events) == 0 {
			return next
		}
		for _, ev := range page.Events {
			if ev.Seq >= next {
				next = ev.Seq + 1
			}
			after = max(after, ev.Seq)
		}
		if !page.HasMore {
			return next
		}
	}
}

// deliver hands a session's events to its stream and waits until they are stored: postEvents, for a caller that is not
// the session's supervisor, which holds its stream itself (session.go).
func (e *linkEvents) deliver(ctx context.Context, sessionID string, events []RunEvent) error {
	// What a Hello resumes the session from, and what its turn completion waits for, as over HTTPS (link_mode.go):
	// kept beyond the stream, which goes once it holds nothing.
	e.m.sentEvents(sessionID, events)
	s := e.open(sessionID)
	defer s.release()
	if err := s.submit(events); err != nil {
		return err
	}
	err := s.waitStored(ctx)
	if err == nil {
		e.m.storedEvents(sessionID, events)
	}
	return err
}

// persist writes what the stream holds to the spool, for the next process: the runner is stopping. What the disk
// takes is kept, whatever else it refuses; what it refuses is logged and counted as lost (linkSpoolQueue.persist).
func (s *linkEventStream) persist() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failure != nil || s.emptyLocked() {
		return
	}
	n := len(s.mem) + s.disk.count() + len(s.over)
	err := s.disk.persist(s.mem, s.over)
	s.e.releaseMemory(s.memBytes)
	s.e.releaseOver(s.overBytes)
	s.mem, s.memBytes, s.over, s.overBytes, s.sentN = nil, 0, nil, 0, 0
	if err != nil {
		s.e.log(fmt.Sprintf("runner link: of %d unacknowledged events of session %s, through seq %d, %d are kept for the next process: %v",
			n, s.id, s.tail, s.disk.count(), err))
		return
	}
	s.e.log(fmt.Sprintf("runner link: %d unacknowledged events of session %s, through seq %d, are kept for the next process", n, s.id, s.tail))
}
