package main

import (
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
	writes     chan string
	wrote      chan struct{} // closed once the writer goroutine has finished

	mu       sync.Mutex
	phase    runtimePhase
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
		writes:     make(chan string, claudeWriteQueueDepth),
		wrote:      make(chan struct{}),
		phase:      phaseStarting,
	}
	go r.writeLoop()
	return r
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

// send queues one frame and returns immediately — accepted, not yet written. A nil error
// means the runtime took ownership of delivering it in order; every other outcome names
// why it will never arrive.
func (r *claudeRuntime) send(frame string) error {
	if frame == "" {
		return nil // marshalFrame's cannot-happen case; nothing to write
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	// Checked before `closed`: a pipe that broke is the more specific and more useful
	// answer, and teardown closes the queue right after.
	if r.writeErr != nil {
		return r.writeErr
	}
	if r.phase == phaseTerminal {
		return errRuntimeGone
	}
	if r.closed {
		return errRuntimeClosed
	}
	select {
	case r.writes <- frame:
		return nil
	default:
		return errWriteQueueFull
	}
}

// beginTurn records that a turn has been handed over and is unanswered; endTurn records
// its `result`. Only these two phases alternate while the process lives.
func (r *claudeRuntime) beginTurn() { r.setPhase(phaseWaiting) }
func (r *claudeRuntime) endTurn()   { r.setPhase(phaseIdle) }

// markTerminal records that the process is gone: stdout hit EOF, or the child exited.
func (r *claudeRuntime) markTerminal() { r.setPhase(phaseTerminal) }

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
// never wedge on a queue that nobody is emptying; send() reports the recorded error, so
// nothing is written into a pipe that is already gone.
func (r *claudeRuntime) writeLoop() {
	defer close(r.wrote)
	defer r.stdin.Close()
	for frame := range r.writes {
		if r.failed() {
			continue
		}
		if _, err := io.WriteString(r.stdin, frame); err != nil {
			r.recordWriteErr(err)
		}
	}
}

func (r *claudeRuntime) failed() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.writeErr != nil
}

func (r *claudeRuntime) recordWriteErr(err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.writeErr == nil {
		r.writeErr = err
	}
}
