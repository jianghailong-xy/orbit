package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"sync/atomic"
)

// The resident half of a Claude session: the one process a session speaks to for its whole
// life, plus the single queue every frame written to that process passes through.
//
// Two properties are what this type exists to make structural rather than incidental:
//
//   - Handing over a frame never blocks on the pipe. A `claude` busy inside a tool call
//     stops reading stdin, and a kernel pipe buffer is 64 KiB — smaller than one turn
//     carrying an inlined image. Writing on the caller's own goroutine (the previous shape:
//     a mutex around io.WriteString) parks that caller until the CLI drains, and for the
//     inbox poller that means no interrupt, no `end`, no shell turn and no diff refresh
//     until the tool finishes. send() hands the frame to a bounded queue and returns, so a
//     caller may hold a lock — the session pool's included — across it.
//   - Exactly one goroutine ever writes to stdin, and it writes frames in the order they
//     were accepted. Byte-level atomicity is not what is at stake — Go already serializes
//     concurrent Writes to one *os.File — what is at stake is the cost of that
//     serialization: an inline writer parks every other sender behind whoever currently
//     holds the fd, and whoever holds it is blocked on the CLI. Accepting into a queue
//     decouples the senders; draining it from one goroutine keeps the order the session
//     intended.
//
// A `result` is a turn boundary, not an end: it moves the runtime between waiting and idle
// and nothing more. Only stdout EOF or the child exiting is terminal, and that is when the
// process is reaped.

// claudeWriteQueueDepth bounds the frames accepted but not yet written. Turns are
// human-paced and the writer drains a healthy pipe as fast as the CLI reads it, so this is
// only ever approached when the child has stopped reading stdin altogether — which is why
// a full queue is reported (errWriteQueueFull) rather than waited on: blocking there is
// precisely the wedge this queue exists to prevent.
const claudeWriteQueueDepth = 32

// The three ways a frame can fail to reach the CLI. Each names a distinct condition a
// caller can act on and a test can observe, so none of them is a silent drop.
var (
	errWriteQueueFull = errors.New("claude stdin queue is full")
	errRuntimeClosed  = errors.New("claude stdin is closed")
	errRuntimeGone    = errors.New("claude process has exited")
)

// runtimePhase is what a session's engine process is doing right now. Deliberately not a
// control-plane status: the clients see AWAITING_INPUT for both waiting and idle.
type runtimePhase string

const (
	// phaseStarting: spawned, no turn fed yet.
	phaseStarting runtimePhase = "starting"
	// phaseWaiting: a turn has been accepted and its `result` has not arrived.
	phaseWaiting runtimePhase = "waiting"
	// phaseIdle: between turns. The process is alive and stdin is open — this is the phase
	// a `result` produces, and the reason a session's second message needs no second spawn.
	phaseIdle runtimePhase = "idle"
	// phaseTerminal: stdout hit EOF or the child exited. Absorbing: nothing revives it.
	phaseTerminal runtimePhase = "terminal"
)

// claudeRuntimeGeneration numbers process generations across the runner. A session that
// re-spawns (a crash, a --model reload) gets a new runtime with a new number, so two
// generations overlapping during a handoff are distinguishable in the logs.
var claudeRuntimeGeneration atomic.Uint64

// claudeRuntime is one session's resident engine process and its write queue.
type claudeRuntime struct {
	generation uint64
	cmd        *exec.Cmd
	stdin      io.WriteCloser
	writes     chan queuedFrame
	// slots is the queue's free space, one token per place. Held from reserve() to
	// commit(), which is what lets commit() hand a frame over without ever blocking: a
	// caller that holds a token is holding a place nothing else can take.
	slots chan struct{}
	wrote chan struct{} // closed once the writer goroutine has finished
	// ctrlSeq numbers this process's control requests. Paired with the generation it
	// makes a request id that is unique for the life of the runner (controlRequestID).
	ctrlSeq atomic.Uint64

	mu    sync.Mutex
	phase runtimePhase
	// announced is the CLI version THIS process named in its init handshake, or "" until
	// it has emitted one. Per-runtime rather than per-runner because that is what it is a
	// fact about: engines self-update underneath a running session, so `claude --version`
	// on PATH answers for the binary the NEXT spawn will use, not for the process being
	// spoken to here. Read by the one control frame whose effect cannot be read back
	// (claude_setconfig.go).
	announced string
	// control is every control_request sent to this process and not yet answered, keyed
	// by the request id its answer will carry. One table per process is what makes an
	// answer from a torn-down generation unroutable rather than merely unlikely
	// (claude_control.go).
	control  map[string]*controlWaiter
	closed   bool
	writeErr error
}

// newClaudeRuntime adopts a started process and brings up its writer. The runtime owns
// stdin from here on: it is closed by close(), and by nothing else.
func newClaudeRuntime(proc *claudeSpawn) *claudeRuntime {
	r := &claudeRuntime{
		generation: claudeRuntimeGeneration.Add(1),
		cmd:        proc.cmd,
		stdin:      proc.stdin,
		writes:     make(chan queuedFrame, claudeWriteQueueDepth),
		slots:      make(chan struct{}, claudeWriteQueueDepth),
		wrote:      make(chan struct{}),
		phase:      phaseStarting,
	}
	for i := 0; i < claudeWriteQueueDepth; i++ {
		r.slots <- struct{}{}
	}
	go r.writeLoop()
	return r
}

// noteAnnouncedVersion records the version out of one init handshake. The CLI emits that
// frame at the start of every turn, so this is written repeatedly with the same value —
// and after a re-spawn it is a NEW runtime that starts blank again, which is the point.
func (r *claudeRuntime) noteAnnouncedVersion(version string) {
	if version == "" {
		return
	}
	r.mu.Lock()
	r.announced = version
	r.mu.Unlock()
}

// announcedVersion is the CLI version this process named, or "" if it has not named one
// yet — a process spawned but not yet asked for a turn has said nothing.
func (r *claudeRuntime) announcedVersion() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.announced
}

func (r *claudeRuntime) pid() int {
	if r.cmd == nil || r.cmd.Process == nil {
		return 0
	}
	return r.cmd.Process.Pid
}

// String identifies the generation in log lines, so a write failure can be attributed to
// one concrete process rather than to "the session".
func (r *claudeRuntime) String() string {
	return fmt.Sprintf("claude runtime %d (pid %d)", r.generation, r.pid())
}

// queuedFrame is one accepted frame on its way to the writer, with the receipt that
// answers for it. Every frame taken out of the queue settles its receipt exactly once —
// written, or named as never arriving — so nothing the runtime accepted is dropped in
// silence.
type queuedFrame struct {
	frame   string
	receipt *writeReceipt
}

// A writeReceipt answers one question: did those bytes reach the CLI? It resolves when
// the writer has written the frame, or when it has established that it never will.
//
// Acceptance and arrival are separate facts and a user message needs both. Acceptance is
// what makes the message the runtime's responsibility — the point at which showing it as
// sent stops being a guess. Arrival is what makes it the CLI's. Between them sits the
// case this type exists for: a `claude` inside a tool call that has stopped reading
// stdin, where a frame can sit accepted-but-unwritten for as long as the tool runs.
type writeReceipt struct {
	once sync.Once
	done chan struct{}
	err  error
}

func newWriteReceipt() *writeReceipt {
	return &writeReceipt{done: make(chan struct{})}
}

// settle records the frame's fate. Idempotent: whichever of the writer's paths reaches it
// first is the answer.
func (w *writeReceipt) settle(err error) {
	w.once.Do(func() {
		w.err = err
		close(w.done)
	})
}

// wait blocks until the frame is written (nil) or established as undeliverable (the write
// error), or until ctx ends — which says nothing about the frame, only that the caller
// stopped waiting.
func (w *writeReceipt) wait(ctx context.Context) error {
	select {
	case <-w.done:
		return w.err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// settled reports the frame's fate without waiting: (err, true) once it is known, (nil,
// false) while it is still queued. Once the runtime has been waited on, every receipt it
// ever handed out has settled — the writer answers for each frame it takes out of the
// queue, including the ones it declines to write — so this is how a session that is
// shutting down reads off what it actually delivered.
func (w *writeReceipt) settled() (error, bool) {
	select {
	case <-w.done:
		return w.err, true
	default:
		return nil, false
	}
}

// writeSlot is a reserved place in the queue: the frame's delivery is already guaranteed
// to be attempted, and its bytes have not been handed over yet.
//
// Splitting the two is what lets a caller record a message as sent without racing the
// answer to it. Everything that says "this turn is on its way" — the transcript event,
// the ack queue, the delivery ledger — has to be in place before the CLI can possibly
// reply, and none of it may happen for a frame the queue refuses. reserve() decides that
// question without writing anything; commit() hands the bytes over afterwards.
type writeSlot struct {
	rt *claudeRuntime
	// receipt exists from the reservation, before the frame does, so a caller can file it
	// alongside whatever it records about the message and never has to consult a record it
	// has not finished writing.
	receipt *writeReceipt
	once    sync.Once
}

// reserve takes a place in the queue for one frame, or names why the frame will never
// arrive. Nothing is written and nothing is queued until the slot is committed.
func (r *claudeRuntime) reserve() (*writeSlot, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	// Checked before `closed`: a pipe that broke is the more specific and more useful
	// answer, and teardown closes the queue right after.
	if r.writeErr != nil {
		return nil, r.writeErr
	}
	if r.phase == phaseTerminal {
		return nil, errRuntimeGone
	}
	if r.closed {
		return nil, errRuntimeClosed
	}
	select {
	case <-r.slots:
		return &writeSlot{rt: r, receipt: newWriteReceipt()}, nil
	default:
		return nil, errWriteQueueFull
	}
}

// commit hands the frame to the writer and returns immediately — accepted, not yet
// written. The receipt is what says when (or whether) it arrives. Never blocks: the slot
// is a place in the queue nothing else can take.
func (s *writeSlot) commit(frame string) *writeReceipt {
	s.once.Do(func() {
		r := s.rt
		r.mu.Lock()
		defer r.mu.Unlock()
		if r.closed {
			// close() raced this reservation. The queue is shut, so the frame is not going
			// to be written, and the receipt says so rather than the send panicking on a
			// closed channel.
			r.slots <- struct{}{}
			s.receipt.settle(errRuntimeClosed)
			return
		}
		r.writes <- queuedFrame{frame: frame, receipt: s.receipt}
	})
	return s.receipt
}

// abandon gives the place back for a frame the caller decided not to send, and settles its
// receipt: a message withdrawn before it was handed over did not arrive either.
func (s *writeSlot) abandon() {
	s.once.Do(func() {
		s.receipt.settle(errRuntimeGone)
		s.rt.slots <- struct{}{}
	})
}

// send queues one frame and returns immediately — accepted, not yet written. A nil error
// means the runtime took ownership of delivering it in order; every other outcome names
// why it will never arrive. For a caller that also needs to know when the bytes land,
// reserve/commit hands back a receipt.
func (r *claudeRuntime) send(frame string) error {
	if frame == "" {
		return nil // marshalFrame's cannot-happen case; nothing to write
	}
	slot, err := r.reserve()
	if err != nil {
		return err
	}
	slot.commit(frame)
	return nil
}

// beginTurn records that a turn has been handed over and is unanswered; endTurn records
// its `result`. Only these two phases alternate while the process lives.
func (r *claudeRuntime) beginTurn() { r.setPhase(phaseWaiting) }
func (r *claudeRuntime) endTurn()   { r.setPhase(phaseIdle) }

// markTerminal records that the process is gone: stdout hit EOF, or the child exited. A
// process that has exited answers nothing, so every control request still outstanding is
// failed here rather than left to time out on a reply that cannot come.
func (r *claudeRuntime) markTerminal() {
	r.setPhase(phaseTerminal)
	r.failPendingControl(errRuntimeGone)
}

func (r *claudeRuntime) setPhase(p runtimePhase) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.phase == phaseTerminal {
		return // a frame arriving late cannot revive a dead process
	}
	r.phase = p
}

func (r *claudeRuntime) currentPhase() runtimePhase {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.phase
}

// close stops accepting frames and lets the writer drain what was already accepted before
// closing stdin, so the EOF that ends the CLI is ordered after the last frame the session
// agreed to deliver. Idempotent: an `end` turn and the teardown path both call it.
func (r *claudeRuntime) close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return
	}
	r.closed = true
	close(r.writes)
}

// wait reclaims the process: stop accepting frames, let the writer finish, then reap the
// child and everything it left running (MCP servers, detached shell descendants).
func (r *claudeRuntime) wait() error {
	r.close()
	<-r.wrote
	return waitSessionProcessTree(r.cmd)
}

// writeLoop is the single writer. It keeps draining after a failed write so a sender can
// never wedge on a queue that nobody is emptying; reserve() reports the recorded error, so
// nothing is written into a pipe that is already gone. Every frame it takes out settles
// its receipt, including the ones it declines to write.
func (r *claudeRuntime) writeLoop() {
	defer close(r.wrote)
	defer r.stdin.Close()
	for qf := range r.writes {
		r.slots <- struct{}{} // out of the queue: its place is free again
		if err := r.failed(); err != nil {
			qf.receipt.settle(err)
			continue
		}
		if _, err := io.WriteString(r.stdin, qf.frame); err != nil {
			r.recordWriteErr(err)
			qf.receipt.settle(err)
			continue
		}
		qf.receipt.settle(nil)
	}
}

// failed returns the write error that ended this runtime's stdin, or nil while it is
// healthy.
func (r *claudeRuntime) failed() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.writeErr
}

func (r *claudeRuntime) recordWriteErr(err error) {
	r.mu.Lock()
	if r.writeErr == nil {
		r.writeErr = err
	}
	r.mu.Unlock()
	// Nothing more will reach this CLI, so nothing it was already asked can still be
	// answered: fail what is outstanding rather than letting it sit out its deadline.
	r.failPendingControl(err)
}
