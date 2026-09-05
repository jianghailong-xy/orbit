package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const maxRespawns = 3

func coordinatorContextBoundaryEvent(eventType string, payload map[string]interface{}) bool {
	if eventType != evSystem {
		return false
	}
	subtype, _ := payload["subtype"].(string)
	return subtype == "compact_boundary" || subtype == "compact_summary" ||
		subtype == "context_compacted" || payload["compactMetadata"] != nil
}

// coordinatorContextFlushBarrier orders the one event that invalidates coordinator context
// ahead of the turn acknowledgement that may dequeue the next message. Generations, rather than
// a boolean, matter because another compaction can be emitted while an earlier /events request is
// in flight.
type coordinatorContextFlushBarrier struct {
	observed atomic.Uint64
	flushed  atomic.Uint64
}

func (b *coordinatorContextFlushBarrier) mark() {
	b.observed.Add(1)
}

func (b *coordinatorContextFlushBarrier) flush(
	ctx context.Context,
	flushEvents func(context.Context) error,
) error {
	for {
		target := b.observed.Load()
		if target <= b.flushed.Load() {
			return nil
		}
		if err := flushEvents(ctx); err != nil {
			return err
		}
		b.flushed.Store(target)
		// A second compaction may have arrived while the first batch was in flight. Loop so
		// turn-complete can never open the next inbox turn ahead of that newer boundary.
	}
}

func (b *coordinatorContextFlushBarrier) markFlushedThrough(target uint64) {
	for {
		current := b.flushed.Load()
		if current >= target || b.flushed.CompareAndSwap(current, target) {
			return
		}
	}
}

func (b *coordinatorContextFlushBarrier) beforeTurnComplete(
	ctx context.Context,
	flushEvents func(context.Context) error,
	turnComplete func(context.Context) (string, error),
) (string, error) {
	// CURRENT_WORK terminalization treats an acknowledged USER/USER_DELIVERY receipt as the
	// runtime ACK. Flush every ordinary batch before completion, not only compaction batches: a
	// Claude/Codex acknowledgement can otherwise remain in the 250ms buffer while the target's
	// completion commits FAILED for the very same receipt.
	target := b.observed.Load()
	if err := flushEvents(ctx); err != nil {
		return "", err
	}
	b.markFlushedThrough(target)
	// A compaction may have been emitted while that request was in flight. Drain every newer
	// generation before the completion opens the next turn.
	if err := b.flush(ctx, flushEvents); err != nil {
		return "", err
	}
	return turnComplete(ctx)
}

// Wait between crash respawns, escalating with the attempt number (5s, 10s, 15s at the
// cap of 3). Long enough to outlast a transient hiccup, short enough not to park the
// user's turn behind a dead engine.
const crashRespawnBackoff = 5 * time.Second

// Consecutive 500s on the same event batch before it is given up as unacceptable. Retries cap at
// idempotentRetryMaxDelay, so this is roughly a minute of a server that keeps throwing — far
// longer than a deploy (which fails the connection or answers 502, neither of which counts here)
// and far shorter than forever.
const maxEventFlushServerRejections = 30

func isCriticalDeliveryAcknowledgement(event RunEvent) bool {
	if event.Type != evUser && event.Type != evUserDelivery {
		return false
	}
	delivery, _ := event.Payload["delivery"].(string)
	return delivery == string(deliveryAcknowledged)
}

// A general transcript batch may be dropped after a sustained poison-row 500 so later output can
// continue. A CURRENT_WORK engine-read acknowledgement is different: turn-complete relies on its
// durability to decide FAILED versus delivered. If such a batch reaches the rejection ceiling,
// keep a sticky fence even after the in-memory queue is empty. Every later flush (especially the
// ACK-before-complete barrier) returns the same error, so an empty buffer can never masquerade as a
// successful proof. Runner teardown then leaves the control plane's receipt UNCONFIRMED.
type criticalEventFlushFence struct {
	mu  sync.Mutex
	err error
}

func (f *criticalEventFlushFence) recordDropped(events []RunEvent, cause error) error {
	critical := false
	for _, event := range events {
		if isCriticalDeliveryAcknowledgement(event) {
			critical = true
			break
		}
	}
	if !critical {
		return cause
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err == nil {
		f.err = fmt.Errorf("CURRENT_WORK delivery acknowledgement could not be persisted: %w", cause)
	}
	return f.err
}

func (f *criticalEventFlushFence) check() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.err
}

// Whether a failed event flush is worth replaying, counting sustained server rejections through
// serverRejections.
//
// A 500 means the control plane received the batch and its own handler threw. Unlike a network
// error or the 502/503 of a restarting apiserver, that verdict does not change on replay — and
// the event buffer is strictly ordered, so a batch the server will never accept parks every
// later event for the session behind it. Not hypothetical: one tool_result carrying a NUL (an
// agent read a binary file) was refused by Postgres, and with no ceiling here the flush replayed
// it for 14 hours while the transcript sat frozen and neither side logged a word. Past the
// ceiling the caller drops the batch: losing it costs a slice of transcript, keeping it costs
// the rest of the session.
func eventFlushRetryPolicy(serverRejections *int) func(error) bool {
	return func(err error) bool {
		if !isRetryableTransportError(err) {
			return false
		}
		if !isTransportHTTPStatus(err, http.StatusInternalServerError) {
			// Anything that can clear on its own (a restart, a timeout, a throttle) is retried as
			// before, and is evidence that this batch is not the problem.
			*serverRejections = 0
			return true
		}
		*serverRejections++
		return *serverRejections < maxEventFlushServerRejections
	}
}

const (
	leaseActivationTimeout    = 20 * time.Second
	finalLeaseReleaseTimeout  = 10 * time.Second
	eventFlushShutdownGrace   = 20 * time.Second
	terminalEventFlushTimeout = 5 * time.Second
	finalizeRunShutdownGrace  = 20 * time.Second
	shutdownSupervisorTimeout = shutdownDrainTimeout + 2*finalLeaseReleaseTimeout + eventFlushShutdownGrace + finalizeRunShutdownGrace + 10*time.Second
)

func newLeaseGeneration() (string, error) {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", err
	}
	id[6] = (id[6] & 0x0f) | 0x40 // UUID v4
	id[8] = (id[8] & 0x3f) | 0x80 // RFC 4122 variant
	return fmt.Sprintf("%x-%x-%x-%x-%x", id[0:4], id[4:6], id[6:8], id[8:10], id[10:16]), nil
}

// mcpToolTimeoutMs is the largest per-server MCP tool timeout claude accepts (~24.8
// days), which is as close to "never" as its config allows. Setting it raises BOTH of
// claude's limits for that server: the idle timeout (no response or progress; 30 min
// by default on stdio) and the hard wall-clock cap. It has to be a large number rather
// than a disabling 0 — claude silently drops any timeout below 1000ms and falls back
// to those same defaults, so 0 would look configured while changing nothing.
const mcpToolTimeoutMs = 2147483647

const (
	providerClaude   = "claude"
	providerCodex    = "codex"
	providerKimi     = "kimi"
	providerOpenCode = "opencode"
)

// runInteractiveSession drives a long-lived `claude` process for an interactive
// session (Route B): it pulls user turns from the per-run inbox, feeds them over
// stdin as stream-json, streams events back, acks each turn via /turn-complete,
// and respawns with --resume on an unexpected crash. It finalizes the run on exit.
// sessionMeta is written to the scratch directory so `orbit resume` can find
// the claude session UUID and work directory without querying the server.
type sessionMeta struct {
	Provider            string `json:"provider,omitempty"`
	SessionUUID         string `json:"sessionUuid"`
	RuntimeSessionID    string `json:"runtimeSessionId,omitempty"`
	CodexStateLayout    string `json:"codexStateLayout,omitempty"`
	CodexStatePartition string `json:"codexStatePartition,omitempty"`
	CodexStateHome      string `json:"codexStateHome,omitempty"`
	WorkDir             string `json:"workDir"`
	Title               string `json:"title"`
}

func runtimeProvider(job *ClaimedSession) string {
	p := strings.ToLower(strings.TrimSpace(job.Provider))
	if p == "" {
		p = strings.ToLower(strings.TrimSpace(job.Agent.Provider))
	}
	switch p {
	case providerCodex, providerKimi, providerOpenCode:
		return p
	}
	return providerClaude
}

func syncJobProvider(job *ClaimedSession) {
	p := runtimeProvider(job)
	job.Provider = p
	if job.Agent.Provider == "" {
		job.Agent.Provider = p
	}
	if p == providerClaude && job.RuntimeSessionID == "" {
		job.RuntimeSessionID = job.SessionUUID
	}
}

func currentRuntimeSessionID(job *ClaimedSession) string {
	if job.RuntimeSessionID != "" {
		return job.RuntimeSessionID
	}
	if runtimeProvider(job) == providerClaude {
		return job.SessionUUID
	}
	return ""
}

func writeSessionMeta(scratch string, job *ClaimedSession, execDir string) {
	writeSessionMetaWithCodexState(scratch, job, execDir, "", "", "")
}

func writeSessionMetaWithCodexState(scratch string, job *ClaimedSession, execDir, layout, partition, codexHome string) {
	// Generic writes happen before the provider starts and on cold claims. Preserve
	// the Codex state scope learned by an earlier successful start so a resume never
	// falls back from runner-shared state to a stale legacy session directory.
	if layout == "" {
		if existing := readSessionMeta(filepath.Join(scratch, "meta.json")); existing != nil {
			layout = existing.CodexStateLayout
			partition = existing.CodexStatePartition
			codexHome = existing.CodexStateHome
		}
	}
	meta := sessionMeta{
		Provider:            runtimeProvider(job),
		SessionUUID:         job.SessionUUID,
		RuntimeSessionID:    currentRuntimeSessionID(job),
		CodexStateLayout:    layout,
		CodexStatePartition: partition,
		CodexStateHome:      codexHome,
		WorkDir:             execDir,
		Title:               job.Title,
	}
	if b, err := json.Marshal(meta); err == nil {
		_ = writeFileAtomically(filepath.Join(scratch, "meta.json"), b, 0o644)
	}
}

func writeFileAtomically(path string, data []byte, perm os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+"-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	ok := false
	defer func() {
		_ = tmp.Close()
		if !ok {
			_ = os.Remove(tmpPath)
		}
	}()
	if err := tmp.Chmod(perm); err != nil {
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return err
	}
	ok = true
	return nil
}

// The optional context bounds provider-owned asynchronous completion workers.
// Synchronous provider paths omit it and retain the session-wide retry budget.
type turnCompleter func(TurnCompleteRequest, ...context.Context) error
type turnPermitWaiter func(context.Context) bool
type leaseLossHandler func(error)

type terminalTurnAck struct {
	request          TurnCompleteRequest
	permitGeneration uint64
}

// terminalTurnAckHandoff transfers one failed-turn completion from a provider
// generation to its session supervisor. A session has only one active turn, so a
// different pending turn is an invariant violation and is rejected fail-closed.
type terminalTurnAckHandoff struct {
	mu      sync.Mutex
	pending *terminalTurnAck
}

func (h *terminalTurnAckHandoff) store(req TurnCompleteRequest, permitGeneration uint64) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.pending != nil {
		return h.pending.request.TurnID == req.TurnID && h.pending.permitGeneration == permitGeneration
	}
	h.pending = &terminalTurnAck{request: req, permitGeneration: permitGeneration}
	return true
}

func (h *terminalTurnAckHandoff) load() (terminalTurnAck, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.pending == nil {
		return terminalTurnAck{}, false
	}
	return *h.pending, true
}

func (h *terminalTurnAckHandoff) clear(turnID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.pending != nil && h.pending.request.TurnID == turnID {
		h.pending = nil
	}
}

func terminalTurnCompleteStatus(status string) bool {
	switch status {
	case stSucceeded, stFailed, stCancelled:
		return true
	default:
		return false
	}
}

// contextUntilEither is used by control-plane handshakes that must survive a
// provider process exit, but must still stop promptly when either the session is
// cancelled or the runner begins shutting down.
func contextUntilEither(ctx, stop context.Context) (context.Context, context.CancelFunc) {
	if ctx == nil {
		ctx = context.Background()
	}
	merged, cancel := context.WithCancel(ctx)
	if stop == nil {
		return merged, cancel
	}
	stopAfter := context.AfterFunc(stop, cancel)
	return merged, func() {
		stopAfter()
		cancel()
	}
}

// contextWithStopGrace stays live during the runner's graceful drain, then
// cancels any acknowledgement still retrying when that finite budget expires.
// Before shutdown it has no deadline, so a transient outage cannot lose an ack.
func contextWithStopGrace(ctx, stop context.Context, grace time.Duration) (context.Context, context.CancelFunc) {
	if ctx == nil {
		ctx = context.Background()
	}
	graceful, cancel := context.WithCancel(ctx)
	if stop == nil {
		return graceful, cancel
	}
	stopAfter := context.AfterFunc(stop, func() {
		timer := time.NewTimer(grace)
		defer timer.Stop()
		select {
		case <-timer.C:
			cancel()
		case <-graceful.Done():
		}
	})
	return graceful, func() {
		stopAfter()
		cancel()
	}
}

// Only RUNNING means the server handed the already-owned permit directly to a
// queued follow-up. Every other authoritative status means this turn no longer
// owns a permit; generation matching in sessionPool protects a newer claim.
func retainsTurnPermit(status string) bool { return status == stRunning }

// turnCompletionEndsSession reports whether reporting this turn ends the run: a failed turn
// terminalizes the Session server-side, so the runner seals event admission and drains its
// tail before saying so.
//
// A steer is the exception, and it matters more than it looks. It settles a message written
// INTO a turn that is still running — the server acks that row and touches nothing else —
// so treating its failure as the session's would seal the transcript of a run that is going
// perfectly well, and the reply the user is waiting for would simply stop appearing.
//
// An unrecognised turn kind is the same shape of exception for the same reason: the run is
// mid-conversation and in perfect health, and the only thing that failed is one instruction
// from a control plane newer than this binary. Ending the session over it would turn "your
// runner is out of date" into "your work stopped".
func turnCompletionEndsSession(req TurnCompleteRequest) bool {
	return req.Status == stFailed && req.Subtype != subtypeSteer && req.Subtype != subtypeUnknownKind
}

// subtypeUnknownKind marks the completion of an inbox turn whose kind this binary does not
// implement — the arm a half-upgraded fleet reaches, where the control plane is newer than
// some of the runners answering to it.
//
// It is reported FAILED because that is what happened: the instruction was not carried out
// and will not be. The subtype is what keeps that failure the turn's own (see above); it is
// also what a reader of the completion needs to tell "this runner is out of date" from a
// turn that ran and went wrong.
const subtypeUnknownKind = "unknown_kind"

func runInteractiveSession(t *Transport, job *ClaimedSession, ctx context.Context, shutdownCtx context.Context, execDir string, onCodexRateLimits func(map[string]interface{}), pool *sessionPool, live *liveSession) {
	syncJobProvider(job)
	// Stable across warm/cold claims. The outer loop swaps `job` to the newest
	// claim payload on a cold resume while the event flusher runs concurrently.
	// Capture the immutable id so that goroutine never races that pointer swap.
	sessionID := job.SessionID
	scratch := runDir(sessionID)
	_ = os.MkdirAll(scratch, 0o755)
	// A newer runner process may fence this process while it is still active. Keep that
	// signal separate from a UI cancel: lost ownership must detach without finalizing.
	ownershipCtx, cancelOwnership := context.WithCancel(context.Background())
	defer cancelOwnership()
	sessionCtx, cancelSessionCtx := contextUntilEither(ctx, ownershipCtx)
	defer cancelSessionCtx()
	var ownershipLost atomic.Bool
	markOwnershipLost := func(err error) {
		if ownershipLost.CompareAndSwap(false, true) {
			logln("session lease ownership lost for", sessionID+":", err)
			cancelOwnership()
		}
	}
	// A revived claim with a rotated owner drains this supervisor before takeover.
	// Reuse the ownership-loss path so provider teardown can never finalize the
	// newly reopened control-plane Session.
	localDetach := func() {
		markOwnershipLost(fmt.Errorf("local supervisor epoch was superseded"))
	}
	if pool.installDetach(live, localDetach) {
		localDetach()
	}
	eventCtx, cancelEventCtx := contextWithStopGrace(
		ownershipCtx,
		shutdownCtx,
		shutdownDrainTimeout+2*finalLeaseReleaseTimeout+eventFlushShutdownGrace,
	)
	defer cancelEventCtx()

	// Persist enough metadata for `orbit resume` to work offline.
	writeSessionMeta(scratch, job, execDir)

	// Session-scoped, monotonic event seq that survives respawn. Continues from the
	// server's high-water mark so post-respawn events don't collide (skipDuplicates).
	seq := job.MaxSeq + 1
	var seqMu sync.Mutex

	// turnId of the message currently being processed; stamped onto every emitted
	// event so output is attributable to the conversation_turn that produced it.
	// "" for session-level events (claude system init, resumed, stderr). Turns are
	// strictly serialized server-side, so a single tracked value suffices.
	var curTurnMu sync.Mutex
	curTurn := ""
	setTurn := func(id string) {
		curTurnMu.Lock()
		curTurn = id
		curTurnMu.Unlock()
	}

	var bufMu sync.Mutex
	var buf []RunEvent
	// A coordinator context can be acknowledged only after its compaction boundary is durable on
	// the control plane. The provider emits and completes on different goroutines, so count under
	// the same lock that appends the event and drain every generation before /turn-complete.
	coordinatorContextBarrier := &coordinatorContextFlushBarrier{}
	emissionGate := &eventEmissionGate{}
	flushGate := newEventFlushGate()
	criticalFlushFence := &criticalEventFlushFence{}
	flushWithContext := func(ctx context.Context) error {
		return flushGate.run(ctx, func(flushCtx context.Context) error {
			if err := criticalFlushFence.check(); err != nil {
				return err
			}
			bufMu.Lock()
			if len(buf) == 0 {
				bufMu.Unlock()
				return nil
			}
			events := buf
			buf = nil
			bufMu.Unlock()
			serverRejections := 0
			err := retryIdempotentWhile(flushCtx, func(attemptCtx context.Context) error {
				return t.postEvents(attemptCtx, sessionID, RunEventBatch{Events: events})
			}, eventFlushRetryPolicy(&serverRejections))
			if isLeaseOwnershipError(err) {
				markOwnershipLost(err)
				return err
			}
			if err != nil {
				if serverRejections >= maxEventFlushServerRejections {
					logln("dropping", len(events), "events for", sessionID,
						fmt.Sprintf("(seq %d-%d)", events[0].Seq, events[len(events)-1].Seq),
						"after", serverRejections, "server rejections:", err)
					return criticalFlushFence.recordDropped(events, err)
				}
				// Keep the batch available to the final flush. Requests are seq-idempotent, so
				// restoring after a lost committed response is safe and avoids dropping the tail.
				bufMu.Lock()
				buf = append(events, buf...)
				bufMu.Unlock()
			}
			return err
		})
	}
	periodicEventCtx, cancelPeriodicEvents := context.WithCancel(eventCtx)
	flushPeriodic := func() {
		if err := flushWithContext(periodicEventCtx); err != nil && periodicEventCtx.Err() == nil && !isLeaseOwnershipError(err) {
			logln("event flush failed for", sessionID+":", err)
		}
	}
	// The reason a run failed is emitted as an error event and, until now, went no
	// further: a session that died in the auth preflight showed FAILED with
	// `error: null` on its record, so the CLI and UI reported an unexplained
	// failure for something as actionable as "signed out". Measured on this
	// runner: 101 sessions failed that way and all 101 had a null error while
	// run_event held the message. Keep the last one so finalize can carry it.
	var lastErrMu sync.Mutex
	lastErrorMessage := ""
	// Baseline for the shared-checkout warning below, taken before this session runs anything
	// so pre-existing dirt is never blamed on it. Nil unless the session is isolated.
	sharedDirt := watchSharedCheckout(job.WT)
	// emitFor files one event against a turn the caller names, instead of against whatever
	// the attribution cursor happens to hold. Only one thing needs it: a steer's own `user`
	// event belongs to the steer's turn, while every byte the engine is streaming at that
	// moment still belongs to the turn being steered. Moving the cursor to emit it and
	// moving it back would file whatever the stdout reader emitted in between under the
	// wrong turn — which is the crossing this avoids rather than races.
	emitFor := func(turnID, eventType string, payload map[string]interface{}) {
		if eventType == evError {
			if msg, ok := payload["message"].(string); ok && strings.TrimSpace(msg) != "" {
				lastErrMu.Lock()
				lastErrorMessage = msg
				lastErrMu.Unlock()
			}
		}
		emissionGate.run(func() {
			seqMu.Lock()
			s := seq
			seq++
			seqMu.Unlock()
			bufMu.Lock()
			buf = append(buf, RunEvent{Seq: s, Type: eventType, TS: nowISO(), TurnID: turnID, Payload: payload})
			if coordinatorContextBoundaryEvent(eventType, payload) {
				coordinatorContextBarrier.mark()
			}
			bufMu.Unlock()
		})
		// Do NOT postEvents inline: emit runs on the stdout-reader goroutine, and a
		// slow post must never stall draining claude's stdout (backpressure freeze).
		// The 250ms flush goroutine owns all network sends.
	}
	// The ordinary path: whatever turn the session is attributing to right now.
	emit := func(eventType string, payload map[string]interface{}) {
		curTurnMu.Lock()
		tid := curTurn
		curTurnMu.Unlock()
		emitFor(tid, eventType, payload)
	}

	// Snappier streaming for interactive: flush every 250ms (vs 1s one-shot).
	stopFlush := make(chan struct{})
	var flushWg sync.WaitGroup
	flushWg.Add(1)
	go func() {
		defer flushWg.Done()
		tk := time.NewTicker(250 * time.Millisecond)
		defer tk.Stop()
		for {
			select {
			case <-stopFlush:
				return
			case <-tk.C:
				flushPeriodic()
			}
		}
	}()
	var stopFlushOnce sync.Once
	stopEventFlusher := func() {
		stopFlushOnce.Do(func() {
			close(stopFlush)
			// Interrupt a periodic retry before waiting for its goroutine. Its
			// batch is restored under bufMu, then the caller performs one final
			// send with its own terminal/shutdown context.
			cancelPeriodicEvents()
			flushWg.Wait()
		})
	}
	defer stopEventFlusher()

	// Watches background-shell output files for live output and turns Claude's
	// <task-notification> messages into durable completion events. Shared across respawns;
	// all tails stop when this session run returns.
	bg := newBgTailer(sessionCtx, emit)
	defer bg.stopAll()
	// Claude records background-shell completions in its transcript even while the session is
	// idle, but only streams them to stdout on the next turn; tail the transcript so a shell
	// that finishes between turns still clears from the "Background processes" tray. (Claude
	// only — Codex has no such transcript; the glob would simply never match.)
	if runtimeProvider(job) == providerClaude {
		bg.startTranscriptWatcher(job.SessionUUID)
	}

	logln(fmt.Sprintf("> interactive run %s — %s", job.SessionID, job.Title))
	status := stCancelled
	// A normal ack retries for as long as the session lives. During runner
	// shutdown it gets the same finite drain budget as the provider process, so a
	// dead control plane cannot keep shutdown blocked forever.
	turnAckCtx, cancelTurnAcks := contextWithStopGrace(sessionCtx, shutdownCtx, shutdownDrainTimeout)
	defer cancelTurnAcks()
	var pendingTerminalAck terminalTurnAckHandoff
	type engineStopHandle struct{ cancel context.CancelFunc }
	var engineStopMu sync.Mutex
	var currentEngine *engineStopHandle
	stopCurrentEngine := func() bool {
		engineStopMu.Lock()
		handle := currentEngine
		engineStopMu.Unlock()
		if handle == nil || handle.cancel == nil {
			return false
		}
		handle.cancel()
		return true
	}
	// A turn ack is the active-permit handoff point. The server keeps RUNNING when
	// a queued follow-up is immediately ready; every other authoritative status
	// releases this generation's permit (AWAITING_INPUT also starts the warm TTL).
	completeTurn := func(req TurnCompleteRequest, providerContexts ...context.Context) error {
		// Say it while the author is still here. Emitted before anything terminal below: a failed
		// turn seals event admission on its way out, and events posted after the session goes
		// terminal are persisted but no longer broadcast — the notice would exist and nobody
		// would see it. Every runtime's turn ends through this one function, so this covers all
		// of them; non-isolated sessions have no watch and skip it entirely.
		if paths := sharedDirt.newlyDirty(); len(paths) > 0 {
			emit(evSystem, map[string]interface{}{
				"notice":     sharedCheckoutNotice(job.WT.RepoDir, effectiveBranch(job.WT), paths),
				"noticeKind": "shared-checkout-dirty",
				"paths":      paths,
			})
		}
		completionCtx := turnAckCtx
		cancelCompletion := func() {}
		// A failed turn ends the Session (see /turn-complete), task-bound or not: the
		// control plane cannot show a failure it parked as AWAITING_INPUT. Both kinds take
		// the terminal handoff below, whose ordering — drain the events, THEN terminalize —
		// is what keeps the error itself on screen: events posted after the Session is
		// terminal are persisted but no longer broadcast, so a watching client would see the
		// status flip to Failed with no sign of what failed until it reloaded.
		failedTurn := turnCompletionEndsSession(req)
		var providerCtx context.Context
		// A provider's asynchronous finalizer must not keep its generation alive
		// after cleanup begins.
		if len(providerContexts) > 0 && providerContexts[0] != nil {
			providerCtx = providerContexts[0]
			completionCtx, cancelCompletion = contextUntilEither(turnAckCtx, providerCtx)
		}
		defer cancelCompletion()
		// A failed turn terminalizes the Session in /turn-complete. Its provider stage only
		// seals admission and attempts a bounded early flush; the supervisor performs the
		// reliable drain and terminal acknowledgement after all emitters join.
		if failedTurn {
			// Close event admission before asking the provider generation to exit. A
			// bounded early flush reduces latency; the supervisor performs the stable,
			// session-scoped drain after every provider/background emitter has joined.
			emissionGate.seal()
			stopEventFlusher()
			flushCtx, cancelFlush := context.WithTimeout(completionCtx, terminalEventFlushTimeout)
			flushErr := flushWithContext(flushCtx)
			cancelFlush()
			if isLeaseOwnershipError(flushErr) {
				markOwnershipLost(flushErr)
				stopCurrentEngine()
				return flushErr
			}
			if flushErr != nil {
				logln("pre-terminal event flush failed for", sessionID+":", flushErr)
			}
			permitGeneration := pool.permitGeneration(live)
			if permitGeneration == 0 || !pendingTerminalAck.store(req, permitGeneration) {
				stopCurrentEngine()
				return fmt.Errorf("failed-turn completion lost its exact local permit")
			}
			if !stopCurrentEngine() {
				pendingTerminalAck.clear(req.TurnID)
				return fmt.Errorf("failed-turn completion has no provider generation to stop")
			}
			logln("failed-turn completion handed to session supervisor for", sessionID)
			return nil
		}
		// Every completion first flushes runtime delivery acknowledgements. The same barrier also
		// drains every sparse-coordinator compaction generation, so neither a CURRENT_WORK receipt
		// nor the context boundary it rode can remain behind the completion that decides its fate.
		var permitGeneration uint64
		next, err := coordinatorContextBarrier.beforeTurnComplete(
			completionCtx,
			flushWithContext,
			func(turnCompleteCtx context.Context) (string, error) {
				// Capture before the network round-trip. Once the server commits
				// AWAITING_INPUT, a new send/claim may reach pool.activate before this
				// response returns; generation matching prevents this old ack from
				// releasing the new claim's permit.
				permitGeneration = pool.permitGeneration(live)
				return t.turnComplete(turnCompleteCtx, sessionID, req)
			},
		)
		if isLeaseOwnershipError(err) {
			markOwnershipLost(err)
		}
		if err == nil && terminalTurnCompleteStatus(next) {
			stopCurrentEngine()
		} else if err == nil && !retainsTurnPermit(next) {
			pool.park(live, permitGeneration)
		}
		return err
	}
	// The server changes PENDING -> RUNNING before returning a claim and may wake
	// this warm process's inbox before the claim HTTP response reaches runLoop.
	// Gate executable turns locally until pool.activate has installed that permit;
	// control turns deliberately bypass this hook in the provider loops.
	waitTurnPermit := func(waitCtx context.Context) bool {
		return pool.waitActive(live, waitCtx, shutdownCtx)
	}
	// A reclaimed or revived session's claude session already exists, so even its
	// first spawn must --resume (firstSpawn=false), not --session-id.
	firstSpawn := !job.Reclaimed && !job.Resume
	lastClaimJob := job
	respawns := 0
	terminalAckSettled := false
	leaseResetGeneration := ""
	retirePendingGeneration := func() error {
		if leaseResetGeneration == "" {
			return nil
		}
		generation := leaseResetGeneration
		releaseCtx, releaseCancel := context.WithTimeout(context.Background(), finalLeaseReleaseTimeout)
		err := retryReleaseTurnLeases(releaseCtx, func(attemptCtx context.Context) error {
			return t.releaseTurnLeases(attemptCtx, sessionID, generation)
		})
		releaseCancel()
		if err == nil && leaseResetGeneration == generation {
			leaseResetGeneration = ""
		}
		return err
	}
	for {
		if sessionCtx.Err() != nil || shutdownCtx.Err() != nil {
			break
		}
		if !pool.waitActive(live, sessionCtx, shutdownCtx) {
			break
		}
		leaseGeneration, generationErr := newLeaseGeneration()
		if generationErr != nil {
			logln("failed to create inbox lease generation for", sessionID+":", generationErr)
			break
		}
		engineGeneration, claimedJob, ok := pool.reserveEngine(live, sessionCtx, shutdownCtx)
		if !ok {
			continue
		}
		// A cold supervisor receives a fresh claim payload before it starts. Adopt
		// its current model/env/runtime ids while retaining the runner-local WT that
		// sessionPool.activate copied over.
		if claimedJob != nil && claimedJob != lastClaimJob {
			job = claimedJob
			lastClaimJob = claimedJob
			firstSpawn = !job.Reclaimed && !job.Resume
			writeSessionMeta(scratch, job, execDir)
		}
		// From the first activation attempt onward the server may have committed this
		// generation even if its response never reaches us. Keep a release backstop before
		// issuing the request so cancellation cannot strand an active fence.
		leaseResetGeneration = leaseGeneration
		activateBaseCtx, activateBaseCancel := contextUntilEither(sessionCtx, shutdownCtx)
		activateCtx, activateCancel := context.WithTimeout(activateBaseCtx, leaseActivationTimeout)
		var activated ActivateTurnLeasesResponse
		activateErr := retryActivateTurnLeases(activateCtx, func(attemptCtx context.Context) error {
			var err error
			activated, err = t.activateTurnLeases(attemptCtx, sessionID, leaseGeneration)
			return err
		})
		activateCancel()
		activateBaseCancel()
		if activateErr != nil {
			pool.engineStopped(live, engineGeneration)
			releaseErr := retirePendingGeneration()
			if releaseErr != nil {
				logln("inbox generation cleanup after activation failed for", sessionID+":", releaseErr)
			}
			if isLeaseOwnershipError(activateErr) {
				markOwnershipLost(activateErr)
			} else if isLeaseOwnershipError(releaseErr) {
				markOwnershipLost(releaseErr)
			} else if isRetryableTransportError(activateErr) && sessionCtx.Err() == nil && shutdownCtx.Err() == nil {
				// Bound each activation/release attempt so no resident engine is held while
				// the control plane is unavailable. Keep reconciling this already-RUNNING
				// turn without finalizing or forgetting its local supervisor.
				for releaseErr != nil && isRetryableTransportError(releaseErr) && sessionCtx.Err() == nil && shutdownCtx.Err() == nil {
					select {
					case <-sessionCtx.Done():
					case <-shutdownCtx.Done():
					case <-time.After(time.Second):
					}
					if sessionCtx.Err() == nil && shutdownCtx.Err() == nil {
						releaseErr = retirePendingGeneration()
					}
				}
				if releaseErr == nil && sessionCtx.Err() == nil && shutdownCtx.Err() == nil {
					time.Sleep(time.Second)
					continue
				}
				if releaseErr != nil && !isRetryableTransportError(releaseErr) {
					status = stFailed
				}
			} else if sessionCtx.Err() == nil && shutdownCtx.Err() == nil {
				logln("failed to activate inbox generation for", sessionID+":", activateErr)
				status = stFailed
			}
			break
		}
		// Whatever the process this generation replaces left leased. A mid-turn message is
		// delivered exactly once and never re-delivered, so a process that died holding one
		// leaves a row nothing else will ever come back for; the control plane cannot answer for
		// it either, because a steer's outcome is only ever visible on this event stream. Done
		// before the engine starts, so the answer is in the transcript before anything the new
		// generation says — and never re-delivered, whatever the engine turns out to be.
		for _, stranded := range activated.AbandonedSteers {
			reportAbandonedSteer(stranded, job, emitFor, completeTurn)
		}
		engineCtx, engineCancel := context.WithCancel(sessionCtx)
		engineHandle := &engineStopHandle{cancel: engineCancel}
		engineStopMu.Lock()
		currentEngine = engineHandle
		engineStopMu.Unlock()
		if pool.engineStarted(live, engineGeneration, engineCancel) {
			engineCancel() // timer/LRU won while this engine was being reserved
		}
		st, ended, reload := runSessionProcess(engineCtx, shutdownCtx, t, job, leaseGeneration, execDir, scratch, emit, emitFor, setTurn, firstSpawn, bg, onCodexRateLimits, completeTurn, waitTurnPermit, markOwnershipLost)
		engineStopMu.Lock()
		if currentEngine == engineHandle {
			currentEngine = nil
		}
		engineStopMu.Unlock()
		// A failed turn is deliberately not acknowledged by its provider generation.
		// That process and every provider worker are joined now. Stop runner-owned
		// background work too, perform one stable event drain, then settle the exact
		// request before releasing the inbox generation or allowing a replacement.
		var terminalAckErr error
		terminalAckStatus := ""
		if ack, ok := pendingTerminalAck.load(); ok {
			bg.stopAll()
			if pool.permitGeneration(live) != ack.permitGeneration {
				terminalAckErr = fmt.Errorf("failed-turn terminal ack crossed its local permit generation")
				localDetach()
			} else if flushErr := flushWithContext(turnAckCtx); flushErr != nil {
				terminalAckErr = flushErr
				if isLeaseOwnershipError(flushErr) {
					markOwnershipLost(flushErr)
				}
			} else {
				terminalAckStatus, terminalAckErr = t.turnComplete(turnAckCtx, sessionID, ack.request)
				if isLeaseOwnershipError(terminalAckErr) {
					markOwnershipLost(terminalAckErr)
				}
				if terminalAckErr == nil && !terminalTurnCompleteStatus(terminalAckStatus) {
					terminalAckErr = fmt.Errorf("failed-turn turn-complete returned non-terminal status %q", terminalAckStatus)
				}
				if terminalAckErr == nil {
					terminalAckSettled = true
					status = terminalAckStatus
					pendingTerminalAck.clear(ack.request.TurnID)
					// Every terminal lifecycle transaction retires the generation; do not
					// issue a redundant release against an already-terminal Session.
					leaseResetGeneration = ""
				}
			}
		}
		engineCancel()
		// This engine's process tree is gone, so the background shells it launched are too.
		// Claude only writes a <task-notification> for a shell that ends on its own, so report
		// them here: an idle warm engine recycled by the timer/LRU otherwise leaves its `vite`
		// or watcher marked running forever, painting a parked session as busy for the rest of
		// its life. (A crash respawn also emits `resumed`, which resets the server's set.)
		bg.killEngineShells()
		evicted := pool.engineStopped(live, engineGeneration)
		// Retire before any cold wait, branch handling, or crash backoff. The HTTP inbox
		// handler can outlive cancellation of the Go request, so leaving this until the next
		// activation would let that detached poll consume a control turn with no receiver.
		if releaseErr := retirePendingGeneration(); releaseErr != nil {
			logln("inbox generation cleanup after process stop failed for", sessionID+":", releaseErr)
			if sessionCtx.Err() == nil && shutdownCtx.Err() == nil {
				status = stFailed
			}
			break
		}
		if terminalAckErr != nil {
			if !isLeaseOwnershipError(terminalAckErr) {
				logln("supervisor failed-turn turn-complete failed for", sessionID+":", terminalAckErr)
			}
			if sessionCtx.Err() != nil || shutdownCtx.Err() != nil {
				status = stCancelled
			} else {
				status = stFailed
			}
			break
		}
		if terminalAckSettled {
			break
		}
		firstSpawn = false
		if evicted {
			// Silent warm recycle: the Orbit session stays AWAITING_INPUT. If a
			// claim raced the timer/LRU, active is already true and the next loop
			// transparently cold-resumes after releasing any lease the dying inbox
			// poll may have acquired; otherwise it sleeps cold.
			setTurn("")
			logln(fmt.Sprintf("○ interactive engine %s recycled (session remains resumable)", job.SessionID))
			continue
		}
		if sessionCtx.Err() != nil || shutdownCtx.Err() != nil {
			status = stCancelled
			break
		}
		if ended {
			status = st
			break
		}
		setTurn("") // 'resumed' is session-level, not part of any turn
		if reload {
			// The user changed the model / permission-mode mid-session: re-spawn with
			// --resume + the new flags (already applied to job.Agent). Not a crash, so
			// it doesn't consume the respawn budget. If the session is idle, leave it
			// cold rather than spawning a process that owns no active permit; its next
			// claim resumes directly with these updated flags.
			if !pool.isActive(live) {
				continue
			}
			emit(evSystem, map[string]interface{}{"subtype": "resumed", "reason": "config_changed"})
			logln(fmt.Sprintf("interactive run %s — config changed; resuming with model=%s mode=%s", job.SessionID, job.Agent.Model, job.Agent.PermissionMode))
			continue
		}
		if st == sessionProcessCurrentWorkFenced {
			// Claude had accepted a CURRENT_WORK frame whose target result won before the
			// replay ACK. That generation was deliberately killed so the frame cannot become
			// the next turn. It is a protocol fence, not a crash, and must not spend the crash
			// respawn budget. If a new claim is already waiting, resume it on a clean process.
			if !pool.isActive(live) {
				continue
			}
			emit(evSystem, map[string]interface{}{"subtype": "resumed", "reason": "current_work_target_fence"})
			logln(fmt.Sprintf("interactive run %s — CURRENT_WORK target fence; resuming on a clean runtime", job.SessionID))
			continue
		}
		// Any unexpectedly dead engine may have taken an executable inbox
		// lease with it. Expire that lease before the cold replacement starts;
		// otherwise the at-least-once turn is invisible until the server's
		// five-minute deadline (most visible with a crashed ACP process).
		// An idle warm engine that exits unexpectedly simply becomes cold. Only an
		// active turn spends the crash-respawn budget.
		if !pool.isActive(live) {
			continue
		}
		// Unexpected crash — resume up to maxRespawns times, waiting between attempts.
		respawns++
		if respawns > maxRespawns {
			status = stFailed
			break
		}
		emit(evSystem, map[string]interface{}{"subtype": "resumed", "attempt": respawns})
		logln(fmt.Sprintf("interactive run %s — %s exited unexpectedly; resuming (attempt %d)", job.SessionID, runtimeProvider(job), respawns))
		select {
		case <-sessionCtx.Done():
		case <-shutdownCtx.Done():
		case <-time.After(time.Duration(respawns) * crashRespawnBackoff):
		}
	}
	if ctx.Err() != nil && !terminalAckSettled {
		status = stCancelled
	}
	// Stop and join runner-owned background work before the final event drain and
	// before any git snapshot/commit/removal. Otherwise a `!cmd &` can write the
	// checkout after finalizeWorktree reported it clean (or after it was removed).
	bg.stopAll()
	// Provider and background emitters are joined above. Seal as the final local
	// backstop, then drain the now-stable buffer before any server finalization.
	emissionGate.seal()
	stopEventFlusher()
	if leaseResetGeneration != "" {
		if err := retirePendingGeneration(); err != nil {
			logln("final inbox lease release failed for", sessionID+":", err)
		}
	}

	if err := flushWithContext(eventCtx); err != nil && !isLeaseOwnershipError(err) {
		logln("final event flush failed for", sessionID+":", err)
	}
	if ownershipLost.Load() {
		logln(fmt.Sprintf("⏏ interactive run %s — detached after lease ownership changed", job.SessionID))
		return
	}
	if terminalAckSettled {
		// /turn-complete already committed the terminal lifecycle and retired its
		// inbox generation. Terminal takeover is intentionally forbidden, so do not
		// reinterpret its expected 409 as ownership loss or run stale finalization.
		// The wrapper keeps the local permit/worktree fence until pool.finish.
		logln(fmt.Sprintf("■ interactive run %s — failed turn terminal acknowledgement settled", job.SessionID))
		return
	}

	// Graceful drain: the runner is shutting down and this wasn't a real cancel/end (a
	// UI cancel sets ctx.Err; an end/crash sets stSucceeded/stFailed). Leave the session
	// AWAITING_INPUT — skip complete — so the next runner reclaims and --resumes it. Its
	// in-flight turn, if any, already finished and acked during the drain.
	if shutdownCtx.Err() != nil && ctx.Err() == nil && status == stCancelled {
		logln(fmt.Sprintf("⏸ interactive run %s — detached for shutdown (resumable)", job.SessionID))
		return
	}
	// Ownership loss must also abort a confirmation/finalize retry already in
	// progress. ownershipCtx deliberately ignores an ordinary UI cancel, so normal
	// terminal cleanup still gets its independent finalization budget.
	finalizeCtx, cancelFinalize := contextWithStopGrace(ownershipCtx, shutdownCtx, finalizeRunShutdownGrace)
	defer cancelFinalize()
	// Check the process fence before touching the shared git worktree. /finalize checks it
	// again transactionally, but computing its payload can itself commit a park checkpoint.
	confirmErr := retryTakeoverTurnLeases(finalizeCtx, func(attemptCtx context.Context) error {
		_, err := t.takeoverTurnLeases(attemptCtx, job.SessionID, t.leaseOwner)
		return err
	})
	if isLeaseOwnershipError(confirmErr) {
		markOwnershipLost(confirmErr)
		logln(fmt.Sprintf("⏏ interactive run %s — detached before stale worktree finalization", job.SessionID))
		return
	}
	if confirmErr != nil {
		logln("run ownership confirmation failed for", job.SessionID+":", confirmErr)
		return
	}
	if ownershipLost.Load() || !pool.beginFinalization(finalizeCtx, live) {
		logln(fmt.Sprintf("⏏ interactive run %s — detached before local worktree finalization", job.SessionID))
		return
	}

	// Finalize the session's worktree (when isolated): commit the work onto its branch and
	// compute the diff, so the branch is usable for a manual merge even after the checkout
	// is removed. Whether to drop the checkout is the SERVER's call (keepCheckout): Open
	// resumable ends — idle-park, user-end, or cancel — keep it; Complete, Move to Trash,
	// and a successfully completed task remove it. The finalize commit doubles as a *park
	// checkpoint* for a resumable end —
	// tagged for undo-on-resume rather than permanent.
	finalizeRequest := RunFinalizeRequest{Status: status, IsolationStatus: job.IsolationStatus, RuntimeSessionID: currentRuntimeSessionID(job)}
	// Carry the failure reason onto the session record. Only on failure: the
	// apiserver writes `error` straight through, so attaching a recovered-from
	// error to a successful run would mislabel it.
	if status == stFailed {
		lastErrMu.Lock()
		finalizeRequest.Error = lastErrorMessage
		lastErrMu.Unlock()
	}
	if runtimeProvider(job) == providerClaude {
		finalizeRequest.ClaudeSessionID = job.SessionUUID
	}
	if job.WT != nil {
		finalizeRequest.Branch = job.WT.Branch
		// The worktree's ACTUAL HEAD branch (before finalize/removal) differs from the reported
		// branch when the agent ran `git checkout -b` inside the checkout, so the server can flag
		// it / offer Adopt.
		finalizeRequest.WorktreeBranch = currentBranch(job.WT)
		finalizeRequest.ChangedFiles, finalizeRequest.ChangedDiff = finalizeWorktree(job.WT, status == stCancelled)
		// finalizeWorktree may heal a stale fork point while computing this snapshot.
		finalizeRequest.BaseSha = job.WT.baseSha()
		// Candidate merge targets for the ended session's "Merge to…" dropdown.
		finalizeRequest.MergeTargets = mergeTargetsForWT(job.WT)
	}
	keepCheckout := true
	err := retryIdempotentWhile(finalizeCtx, func(attemptCtx context.Context) error {
		var attemptErr error
		keepCheckout, attemptErr = t.finalizeRun(attemptCtx, job.SessionID, finalizeRequest)
		return attemptErr
	}, isRetryableTransportError)
	if isLeaseOwnershipError(err) {
		markOwnershipLost(err)
		logln(fmt.Sprintf("⏏ interactive run %s — detached before stale finalization", job.SessionID))
		return
	}
	if err != nil {
		logln("run finalization failed for", job.SessionID+":", err)
	} else {
		logln(fmt.Sprintf("■ interactive run %s → %s", job.SessionID, status))
	}
	if job.WT != nil && !keepCheckout {
		removeWorktree(job.WT)
	}
}

// builtinTaskTools are Claude's built-in task/todo tools. They are disabled for
// every session because they collide with Orbit's own mcp__orbit__task_* tools:
// an agent asked to "create tasks" reaches for these, but their todos live only in
// the claude process and never reach Orbit's database, so the tasks never show in
// the UI. Disabling them forces all task work through the orbit MCP server.
// Both families are listed because claude has shipped this feature under two names
// across versions; denying a name the installed claude does not have is a no-op, while
// missing the one it does have fails silently.
var builtinTaskTools = []string{
	"TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "TaskOutput", "TaskStop",
	"TodoWrite", "TodoRead",
}

// withBuiltinTaskToolsDisallowed appends builtinTaskTools to the agent's configured
// disallow list, de-duplicated and order-stable.
func withBuiltinTaskToolsDisallowed(configured []string) []string {
	seen := make(map[string]bool, len(configured)+len(builtinTaskTools))
	out := make([]string, 0, len(configured)+len(builtinTaskTools))
	for _, t := range append(append([]string{}, configured...), builtinTaskTools...) {
		if t != "" && !seen[t] {
			seen[t] = true
			out = append(out, t)
		}
	}
	return out
}

// envWithAgent returns the runner's own environment with the agent's custom env vars
// layered on top. Shared by the claude process and `!`-shells so a command run either
// way sees the same configured environment.
func sessionContextEnvKey(key string) bool {
	switch strings.ToUpper(key) {
	case "ORBIT_SESSION_ID", "ORBIT_AGENT_ID", "ORBIT_TASK_ID", envSpawnDepth,
		envMCPOrchestration, envOrchestrationToken, envMCPPermissionPrompt:
		return true
	default:
		return false
	}
}

func envWithAgent(agentEnv map[string]string) []string {
	// New provider processes must not inherit a stale orchestration credential from
	// launchd/the runner or from agent-configured environment. Their MCP child reads
	// the private session file and refreshes it lazily instead. Already-running
	// providers retain the environment fallback for compatibility.
	env := make([]string, 0, len(os.Environ())+len(agentEnv))
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if !sessionContextEnvKey(key) {
			env = append(env, entry)
		}
	}
	for k, v := range agentEnv {
		// ORBIT_HOME selects the owner-wide runner config and private session
		// credential store. It is runner context, not an agent-customizable value.
		// EqualFold also preserves this rule on Windows, whose environment keys are
		// case-insensitive.
		if sessionContextEnvKey(k) || strings.EqualFold(k, "ORBIT_HOME") {
			continue
		}
		env = append(env, k+"="+v)
	}
	return env
}

func runSessionProcess(ctx context.Context, shutdownCtx context.Context, t *Transport, job *ClaimedSession, leaseGeneration, execDir, scratchDir string, emit emitFn, emitFor emitTurnFn, setTurn func(string), firstSpawn bool, bg *bgTailer, onCodexRateLimits func(map[string]interface{}), completeTurn turnCompleter, waitTurnPermit turnPermitWaiter, onLeaseLost leaseLossHandler) (string, bool, bool) {
	provider := runtimeProvider(job)
	// The engine CLI is installed on demand, so this is where a runner that has never
	// run this provider gets it — and where a machine that can't (no consent, install
	// failed, installed but signed out) fails with something actionable instead of a
	// raw "failed to spawn" from exec. ended=true so we don't respawn.
	if msg := ensureEngine(ctx, provider, func(note string) {
		emit(evAssistant, map[string]interface{}{"text": note})
	}); msg != "" {
		emit(evError, map[string]interface{}{"message": msg})
		return stFailed, true, false
	}
	// Signed out is the other way a session can't run, and the engine's own report of it
	// is no use: codex answers a missing login with two rounds of five reconnects and a raw
	// "401 Unauthorized" twenty seconds later, which reads as a network problem. Ask before
	// spawning instead.
	//
	// Every spawn, not just the session's first. This used to run under `firstSpawn`, which
	// is false for a resume or a reclaim — the two cases where the credentials are most
	// likely to have died, because the last time anything checked them was whenever the
	// session last ran, hours or days ago. A local probe per engine start is cheap next to
	// what it replaces.
	if msg := engineAuthPreflight(provider, job.Agent.Env); msg != "" {
		emit(evError, map[string]interface{}{"message": msg})
		return stFailed, true, false
	}
	return providerRuntimeFor(provider).run(sessionProcessArgs{
		ctx: ctx, shutdownCtx: shutdownCtx, t: t, job: job, leaseGeneration: leaseGeneration,
		execDir: execDir, scratchDir: scratchDir, emit: emit, emitFor: emitFor, setTurn: setTurn,
		firstSpawn: firstSpawn, bg: bg, onCodexRateLimits: onCodexRateLimits,
		completeTurn: completeTurn, waitTurnPermit: waitTurnPermit, onLeaseLost: onLeaseLost,
	})
}

// How often the shutdown drain re-checks whether the in-flight turns have finished.
const drainPollInterval = 150 * time.Millisecond

// watchShutdownDrain is one claude supervisor's runner-shutdown watcher. It stops the inbox
// poller (no new turns), gives whatever was already fed to claude `timeout` to finish and ack
// — `pending` empties as the stdout reader acks each `result` — and then tears the process
// down via procCancel. The caller detaches without finalizing, so the next runner reclaims and
// --resumes. An idle session (`pending` empty) detaches at once.
//
// A turn still unfinished at the deadline loses its process without a result of its own, so it
// is marked interrupted in the transcript first. Otherwise the reply simply stops: the last
// thing the user sees is a half-finished thought or a tool call whose output never came, and
// nothing distinguishes that from the agent still thinking. The control plane then re-delivers
// the turn as a "carry on from where you were interrupted" prompt, so the marker is also what
// makes the repeated work that follows it legible.
//
// Returns as soon as the process is gone on its own (procCtx done): there is nothing left to
// tear down, and that turn's own crash path — not this one — owns what to report.
func watchShutdownDrain(procCtx, shutdownCtx context.Context, pending <-chan string,
	timeout time.Duration, pollCancel, procCancel context.CancelFunc,
	emit emitFn, sessionID string) {
	select {
	case <-procCtx.Done():
		return
	case <-shutdownCtx.Done():
	}
	pollCancel()
	tk := time.NewTicker(drainPollInterval)
	defer tk.Stop()
	deadline := time.After(timeout)
	for len(pending) > 0 {
		select {
		case <-tk.C:
		case <-procCtx.Done():
			return
		case <-deadline:
			emit(evInterrupt, map[string]interface{}{"reason": "runner_restart"})
			logln("drain timeout for", sessionID+"; tearing down mid-turn")
			procCancel()
			return
		}
	}
	procCancel()
}

// Internal provider-generation outcome. It never crosses the runner API; the supervisor uses it
// to replace a deliberately fenced Claude process without charging the crash-respawn budget.
const sessionProcessCurrentWorkFenced = "CURRENT_WORK_TARGET_FENCED"

// runClaudeSessionProcess spawns ONE claude process and drives it until the session
// ends (an 'end' turn closes stdin) or the process exits. Returns (status, ended,
// reload). ended=false means the caller should re-spawn: reload=true for a requested
// model/permission-mode change, reload=false for an unexpected crash.
func runClaudeSessionProcess(ctx context.Context, shutdownCtx context.Context, t *Transport, job *ClaimedSession, leaseGeneration, execDir, scratchDir string, emit emitFn, emitFor emitTurnFn, setTurn func(string), firstSpawn bool, bg *bgTailer, completeTurn turnCompleter, waitTurnPermit turnPermitWaiter, onLeaseLost leaseLossHandler) (string, bool, bool) {
	// Reset turn attribution for this (possibly re-spawned) process: events before
	// the first turn is (re-)fed — claude's system/init — are session-level (null).
	setTurn("")
	// Set when an inbox 'reload' turn asks us to re-spawn with a new model/mode.
	var reloadRequested atomic.Bool
	// Set by the stdout reader on the first stream-json message. A process that exits
	// without ever producing one never got past its own startup, so its exit is a
	// refusal, not a crash (see startupRefusal).
	var sawOutput atomic.Bool
	// Set by the stderr reader when claude refuses the --session-id we asked it to open
	// because that id already names a conversation (see sessionIDInUse).
	var sessionIDTaken atomic.Bool
	if !firstSpawn {
		// claude keeps the conversation in a local file keyed by cwd + session id, which this
		// machine may simply not have: the session's first spawn on a different runner, a wiped
		// ~/.claude, a moved worktree. Orbit still has every event, so rebuild the file instead
		// of letting --resume fail with "No conversation found with session ID".
		ensureClaudeTranscript(ctx, t, job, execDir, emit)
	}
	args := claudeCommandArgs(job, scratchDir, firstSpawn)

	procCtx, procCancel := context.WithCancel(ctx)
	defer procCancel()
	// pollCtx gates only the inbox poller. On runner shutdown we cancel it to stop
	// pulling new turns WITHOUT tearing down claude, so an in-flight turn can finish and
	// ack before we detach. It derives from procCtx, so procCancel also stops the poller.
	pollCtx, pollCancel := context.WithCancel(procCtx)
	defer pollCancel()
	proc, err := spawnClaude(procCtx, job, execDir, args)
	if err != nil {
		emit(evError, map[string]interface{}{"message": "failed to spawn claude: " + err.Error()})
		return stFailed, true, false // a spawn failure won't be fixed by respawning
	}
	// The resident runtime for this session: the child, its generation and phase, and the
	// bounded single-writer queue every frame to its stdin goes through (claude_runtime.go).
	rt := newClaudeRuntime(proc)
	defer rt.close()
	cmd, stdout, stderr := proc.cmd, proc.stdout, proc.stderr

	var stderrWg sync.WaitGroup
	stderrWg.Add(1)
	go func() {
		defer stderrWg.Done()
		s := bufio.NewScanner(stderr)
		s.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		for s.Scan() {
			line := stripANSI(s.Text())
			if sessionIDInUse(line) {
				sessionIDTaken.Store(true)
			}
			emit(evSystem, map[string]interface{}{"stderr": line + "\n"})
		}
	}()

	pending := make(chan string, 8) // message turnIds fed but not yet resulted (FIFO)
	inflight := map[string]bool{}   // turnIds being processed (dedup lease re-delivery)
	var inflightMu sync.Mutex
	// Exact Orbit executable turn owned by this Claude generation. It is separate from the
	// transcript attribution cursor: the poller and stdout reader use it as one linearization
	// boundary for target-bearing steer commit versus target result.
	var activeOrbitMu sync.Mutex
	activeOrbitTurnID := ""
	// How far each user message got on its way into the conversation, and what the CLI's
	// replays (--replay-user-messages) answer (claude_delivery.go).
	deliveries := &deliveryLedger{}
	// reportDelivery publishes one message's delivery state. The turn is named in the
	// payload rather than left to the event's own attribution: a delivery settles on the
	// writer's schedule, not the conversation's, so the turn in progress when it settles
	// is often a different one.
	reportDelivery := deliveryReporter(func(turnID string, state deliveryState, reason string, retryable bool) {
		p := map[string]interface{}{"turnId": turnID, "delivery": string(state)}
		if reason != "" {
			p["reason"] = reason
			p["retryable"] = retryable
		}
		emit(evUserDelivery, p)
	})
	// requeueSteer takes a steer back before it has been offered to anything and files it as the
	// ordinary queued message it would have been had it arrived a moment later.
	//
	// Deliberately silent — no `user` event, no delivery report. Nothing has been said about this
	// message yet (the refusal below is what would have opened its bubble), so the delivery that
	// eventually runs it writes the one bubble it ever gets. Announcing it here would leave a
	// second one behind, showing what the person sent twice. Same reasoning as codex's requeue.
	requeueSteer := func(resp *RunInboxResponse) {
		requeueSteerTurn(resp.TurnID, job, completeTurn)
		inflightMu.Lock()
		delete(inflight, resp.TurnID)
		inflightMu.Unlock()
	}
	refuseSteer := func(resp *RunInboxResponse, cause error, retryable bool) {
		emitFor(resp.TurnID, evUser, map[string]interface{}{
			"text": resp.Content, "delivery": string(deliveryFailed), "steer": true,
		})
		reportDelivery(resp.TurnID, deliveryFailed, cause.Error(), retryable)
		settleSteerTurn(resp.TurnID, cause, job, completeTurn)
		inflightMu.Lock()
		delete(inflight, resp.TurnID)
		inflightMu.Unlock()
	}
	steerTargetCause := func(resp *RunInboxResponse) error {
		if rt.currentPhase() != phaseWaiting || activeOrbitTurnID == "" {
			return errNoTurnToSteer
		}
		if resp.TargetTurnID != "" && resp.TargetTurnID != activeOrbitTurnID {
			return errCurrentWorkTargetEnded
		}
		return nil
	}
	endedCh := make(chan struct{})
	var endOnce sync.Once
	endSession := func() {
		endOnce.Do(func() {
			close(endedCh)
			rt.close()
		})
	}

	// Inbox poller: pulls turns and acts immediately so interrupt/end land mid-turn.
	pollDone := make(chan struct{})
	go func() {
		defer close(pollDone)
		// Buffered `!`-shell output: each shell turn appends command+output here; the next
		// real message prepends + clears it so claude sees it as context (CLI `!` semantics).
		// Poller-goroutine-local (no lock), and intentionally lost on respawn.
		var pendingShellCtx []string
		for pollCtx.Err() == nil {
			resp, err := t.inbox(pollCtx, job.SessionID, leaseGeneration)
			if err != nil {
				if pollCtx.Err() != nil {
					return
				}
				if isLeaseOwnershipError(err) {
					onLeaseLost(err)
					return
				}
				logln("inbox poll failed for", job.SessionID+":", err)
				time.Sleep(time.Second)
				continue
			}
			if resp == nil {
				continue // long-poll timeout, re-poll
			}
			if pollCtx.Err() != nil {
				return // drain raced a pulled turn: drop it (the next runner re-delivers)
			}
			switch resp.Kind {
			case "message", "steer":
				// A steer is a user message for the turn that is ALREADY running: the server
				// hands it over only while an executable turn holds the slot, and it goes
				// down the same stdin to the same process, to be folded into that turn at
				// the engine's next tool boundary. Everything that belongs to the turn it
				// joins — the active-turn permit, the attribution cursor, the ack queue that
				// a `result` pops — therefore stays with that turn and is not touched here.
				steer := resp.Kind == "steer"
				if !steer {
					if !waitTurnPermit(procCtx) {
						return
					}
					// Attribute this process's output to this turn. Set BEFORE the dedup
					// early-return so a lease re-delivery (turn still running) still tags
					// the resumed/replayed output with the correct turn.
					setTurn(resp.TurnID)
				}
				// The inbox lease can re-deliver a turn still running (turn > lease).
				// Dedup by turnId so we never double-feed claude or desync `pending`.
				inflightMu.Lock()
				dup := inflight[resp.TurnID]
				if !dup {
					inflight[resp.TurnID] = true
				}
				inflightMu.Unlock()
				if dup {
					continue
				}
				// A steer only means anything while a turn is actually in progress. The
				// server decides that from the lease, and this is the same question asked of
				// the process itself: writing into an idle engine would open a turn nobody
				// asked for, whose `result` no queued turn is waiting to answer.
				activeOrbitMu.Lock()
				preflightCause := error(nil)
				if steer {
					preflightCause = steerTargetCause(resp)
				}
				activeOrbitMu.Unlock()
				if preflightCause != nil {
					if resp.SteerRequeue {
						// Both preflight causes are proof of non-delivery: there is no turn to
						// join, or the one this message named is over. Nothing has read it, so
						// it is not a failure to report — it is a message that turned out to be
						// an ordinary one, and the control plane will run it as such.
						logln("re-filing a steer for", job.SessionID, "as an ordinary message —",
							preflightCause.Error())
						requeueSteer(resp)
						continue
					}
					logln("dropping a steer for", job.SessionID, "— no turn is running on", rt.String())
					// A refused steer is the one refusal that has to enter the transcript. A
					// refused message fails its session, which is loud; a steer settles only
					// itself, so with no event at all the sender is left watching their own
					// optimistic bubble wait for something that is never coming. It goes in
					// as the failure it is — never as a message that looks sent.
					refuseSteer(resp, preflightCause, true)
					continue
				}
				// Opened here, where the turn is first taken on, so the interval spent
				// assembling it below (every attachment is fetched over the network) is
				// `pending` — pulled, promised nothing.
				delivery := newMessageDelivery(resp.TurnID, steer)
				delivery.targetTurnID = resp.TargetTurnID
				delivery.requeueable = resp.SteerRequeue
				// Build the claude user message by dispatching each attachment on its MIME
				// type: images and PDFs are inlined as base64 content blocks; anything else is
				// written to the session's uploads dir outside the worktree for claude to read
				// with its tools (its path is announced in the text below, kept out of git so it
				// isn't auto-committed or merged). The runner fetches each blob (runner-scoped); a
				// fetch/write failure drops just that one so the turn still goes through rather
				// than stalling. attRefs (id+mime+name) ride on the `user` event so the web can
				// render the attachments (image thumbnails / file chips) after a reload.
				content := []map[string]interface{}{}
				var attRefs []map[string]interface{}
				var writtenPaths []string
				for _, att := range resp.Attachments {
					data, ferr := t.fetchAttachment(procCtx, job.SessionID, att.ID)
					if ferr != nil {
						logln("attachment fetch failed for", job.SessionID, att.ID+":", ferr)
						continue
					}
					switch {
					// Only the media types Claude accepts as image blocks; other image/* (svg,
					// bmp, tiff) and every non-image, non-PDF type fall through to disk.
					case att.MimeType == "image/png" || att.MimeType == "image/jpeg" ||
						att.MimeType == "image/webp" || att.MimeType == "image/gif":
						content = append(content, map[string]interface{}{
							"type": "image",
							"source": map[string]interface{}{
								"type":       "base64",
								"media_type": att.MimeType,
								"data":       base64.StdEncoding.EncodeToString(data),
							},
						})
					case att.MimeType == "application/pdf":
						content = append(content, map[string]interface{}{
							"type": "document",
							"source": map[string]interface{}{
								"type":       "base64",
								"media_type": att.MimeType,
								"data":       base64.StdEncoding.EncodeToString(data),
							},
						})
					default:
						abs, werr := writeUpload(job.SessionID, att.FileName, att.ID, data)
						if werr != nil {
							logln("attachment write failed for", job.SessionID, att.ID+":", werr)
							continue
						}
						writtenPaths = append(writtenPaths, abs)
					}
					attRefs = append(attRefs, map[string]interface{}{"id": att.ID, "mime": att.MimeType, "name": att.FileName})
				}
				// Prepend any buffered `!`-shell output as context - claude sees the
				// command+output with this message (CLI `!` semantics), no turn spent on it.
				feedText := resp.Content
				if len(pendingShellCtx) > 0 {
					feedText = strings.Join(pendingShellCtx, "\n") + "\n\n" + resp.Content
					// NOT cleared here: a message the runtime refuses below is never fed, and
					// the shell output it was carrying still belongs to whatever is fed next.
				}
				// Tell claude where the written-to-disk uploads landed (absolute paths outside
				// the worktree), so it reads them with its tools instead of expecting inline
				// content it never received.
				if len(writtenPaths) > 0 {
					note := fmt.Sprintf("[The user uploaded %d file(s), saved at: %s - read or process them with your tools as needed.]",
						len(writtenPaths), strings.Join(writtenPaths, ", "))
					if feedText != "" {
						feedText = note + "\n\n" + feedText
					} else {
						feedText = note
					}
				}
				// Keep the text block unless this is an inline-attachment-only turn with
				// nothing to feed.
				if feedText != "" || len(content) == 0 {
					content = append(content, map[string]interface{}{"type": "text", "text": feedText})
				}
				userEv := map[string]interface{}{"text": resp.Content}
				if len(attRefs) > 0 {
					userEv["attachments"] = attRefs
				}
				// Take a place in the write queue BEFORE anything records the message as
				// sent. A turn the runtime refuses — a CLI that stopped reading stdin, an
				// `end` that closed the queue, a process already gone — leaves no user
				// bubble, no entry in the ack queue and no unanswered turn: it is reported
				// as the failure it is, and the poller keeps polling so `interrupt` and
				// `end` still land on a session whose CLI is wedged.
				slot, err := rt.reserve()
				if err != nil {
					logln("feeding a turn to", rt.String(), "failed for", job.SessionID+":", err)
					deliveries.fail(delivery)
					reportDelivery(resp.TurnID, deliveryFailed, err.Error(), true)
					if steer {
						settleSteerTurn(resp.TurnID, err, job, completeTurn)
					} else {
						failUndeliveredTurn(resp.TurnID, err, job, completeTurn)
						setTurn("")
					}
					inflightMu.Lock()
					delete(inflight, resp.TurnID)
					inflightMu.Unlock()
					continue
				}
				// Linearize the last target check with result handling. If A ends while the
				// attachment fetch/reservation above is in progress, its result takes this lock
				// first and this frame is abandoned without ever entering stdin. If commit wins,
				// the result sees the ledger entry and fences the generation unless replay ACK won.
				activeOrbitMu.Lock()
				finalCause := error(nil)
				if steer {
					finalCause = steerTargetCause(resp)
				}
				if finalCause != nil {
					activeOrbitMu.Unlock()
					slot.abandon()
					deliveries.fail(delivery)
					refuseSteer(resp, finalCause, true)
					continue
				}
				if !steer {
					activeOrbitTurnID = resp.TurnID
				}
				// Accepted: from here the frame WILL be offered to the CLI, in this order,
				// so everything that answers for it can be put in place before it can be
				// answered.
				deliveries.accept(delivery, slot.receipt)
				pendingShellCtx = nil // this message carries it now
				userEv["delivery"] = string(deliveryEnqueued)
				if steer {
					// Which kind this message was filed as, on the one event that survives a
					// reload. A steer is answered by the turn it joined rather than by one of
					// its own, so how far it got IS its whole visible outcome — a client that
					// cannot tell it from an ordinary message has nothing to show for it, and
					// would show the same silence for a steer still on its way and one that
					// never landed.
					userEv["steer"] = true
				}
				// Filed against its own turn either way. For a message that is the turn the
				// cursor already names; for a steer it is the only event of its turn, and
				// naming it explicitly is what keeps the steered turn's stream out of it.
				emitFor(resp.TurnID, evUser, userEv)
				if !steer {
					// `pending` is what a `result` pops to ack a turn. A steer produces no
					// result of its own — it is answered by the result of the turn it joined
					// — so putting it here would ack the wrong turn.
					select {
					case pending <- resp.TurnID:
					case <-procCtx.Done():
						slot.abandon()
						if activeOrbitTurnID == resp.TurnID {
							activeOrbitTurnID = ""
						}
						activeOrbitMu.Unlock()
						return
					}
				}
				receipt := slot.commit(userFrame(job.SessionUUID, content))
				if !steer {
					rt.beginTurn() // a steer joins a turn that is already waiting
				}
				activeOrbitMu.Unlock()
				// The writer answers on its own schedule — a frame behind a CLI that
				// stopped reading stdin is accepted now and written whenever the tool
				// finishes — so watch the receipt off to the side rather than making the
				// poller wait on the pipe it exists not to wait on.
				go func(d *messageDelivery, turnID string, steer bool) {
					switch err := receipt.wait(procCtx); {
					case err == nil:
						if deliveries.markWritten(d) {
							reportDelivery(turnID, deliveryWritten, "", false)
						}
					case procCtx.Err() != nil:
						// The process is going away; its teardown accounts for what it
						// still owed (see settleUndeliveredMessages).
					default:
						if deliveries.fail(d) {
							reportDelivery(turnID, deliveryFailed, err.Error(), true)
							if steer {
								settleSteerTurn(turnID, err, job, completeTurn)
							} else {
								failUndeliveredTurn(turnID, err, job, completeTurn)
							}
						}
					}
				}(delivery, resp.TurnID, steer)
			case "shell":
				if !waitTurnPermit(procCtx) {
					return
				}
				// `!`-prefixed shell command: run it on the runner (no claude), echo the
				// output, and buffer it for the next message's context. Dedup on turnId so
				// a lease re-delivery can't re-run side effects.
				inflightMu.Lock()
				if inflight[resp.TurnID] {
					inflightMu.Unlock()
					continue
				}
				inflight[resp.TurnID] = true
				inflightMu.Unlock()
				setTurn(resp.TurnID)
				if shCmd, isBg := shellTurnBackgroundCommand(resp); isBg {
					// `!cmd &`: launch detached and finish the turn now — the process keeps
					// running, surfaced in the Background-processes tray (output + completion),
					// not buffered into the next message's context.
					runShellTurnBackground(bg, execDir, scratchDir, shCmd, resp.TurnID, emit, job.Agent.Env)
					if err := completeTurn(TurnCompleteRequest{
						TurnID: resp.TurnID, Status: stSucceeded,
						Result: "started in background", Subtype: "shell",
						RuntimeSessionID: currentRuntimeSessionID(job),
						BranchSha:        effectiveBranchSha(job.WT),
					}); err != nil {
						logln("shell turn-complete failed for", job.SessionID+":", err)
					}
				} else {
					req, shellErr := runSynchronousShellTurn(procCtx, t, job, execDir, resp, emit)
					if shellErr != nil {
						logln("executable shell start failed for", job.SessionID+":", shellErr)
						req = TurnCompleteRequest{TurnID: resp.TurnID, Status: stFailed, Result: shellErr.Error(), Subtype: "shell"}
					}
					if req.ShellOutput != nil {
						pendingShellCtx = append(pendingShellCtx,
							fmt.Sprintf("<bash-input>%s</bash-input>\n<bash-stdout>%s</bash-stdout>", resp.Content, *req.ShellOutput))
					}
					req.RuntimeSessionID = currentRuntimeSessionID(job)
					req.BranchSha = effectiveBranchSha(job.WT)
					if err := completeTurn(req); err != nil {
						logln("shell turn-complete failed for", job.SessionID+":", err)
					}
				}
				inflightMu.Lock()
				delete(inflight, resp.TurnID)
				inflightMu.Unlock()
				setTurn("")
			case "interrupt":
				// Stopping a turn is a request with an answer, not a shout into the pipe:
				// the CLI is asked over the control protocol and has to confirm, and the
				// process — with its conversation, its stdin and its place in the session —
				// is left standing either way. Ending the session is the separate operation
				// that takes the process away (`end`, below), and the drain's own interrupt
				// marker names its reason, so the three are told apart in the transcript.
				//
				// Asked unconditionally, without first checking whether a turn of OURS is in
				// flight. The engine also runs turns nobody sent it — a background task
				// reporting in, a scheduled wake-up — and those are exactly the ones somebody
				// reaches for stop over. Gating on the runtime's own phase would leave those
				// unstoppable, with the button doing nothing and saying nothing.
				//
				// Queued on the poller's own goroutine, so the request keeps its place in
				// the order the session intended; waited on off to the side, because this
				// same goroutine is how `end` and the next interrupt arrive.
				w, err := rt.requestControl(ctrlInterrupt)
				if err != nil {
					logln("interrupting", rt.String(), "failed for", job.SessionID+":", err)
					emit(evError, map[string]interface{}{"message": interruptFailureMessage(err)})
					continue
				}
				go func(w *controlWaiter) {
					err := rt.awaitControl(procCtx, w, claudeInterruptTimeout)
					switch {
					case err == nil:
						// The marker goes up only now. Emitting it on the way out would say
						// the turn was stopped before anything had agreed to stop it — which
						// is precisely the claim an unconfirmed interrupt cannot make.
						emit(evInterrupt, map[string]interface{}{"requestId": w.id})
					case w.resp.Subtype == ctrlError:
						// An explicit refusal is a completed protocol answer, even if the CLI
						// writes its result and exits immediately afterwards. Process teardown
						// may cancel procCtx before this goroutine is scheduled; it must not erase
						// an answer the person needs to know their stop did not take.
						logln("interrupt", w.id, "for", job.SessionID, "failed:", err)
						emit(evError, map[string]interface{}{"message": interruptFailureMessage(err)})
					case procCtx.Err() != nil:
						// The process is going away; its teardown owns that account.
						logln("interrupt", w.id, "for", job.SessionID, "abandoned:", err)
					default:
						logln("interrupt", w.id, "for", job.SessionID, "failed:", err)
						emit(evError, map[string]interface{}{"message": interruptFailureMessage(err)})
					}
				}(w)
			case "setconfig":
				// Model / permission mode / reasoning effort changed, on a session whose engine
				// is up. None of the three is built into that process the way the provider
				// environment is: a resident CLI can be TOLD about them, over the same control
				// channel it already services for interrupts. So the change lands in the
				// conversation that is already going — mid-turn included, which is the whole
				// reason this is a kind of its own — and `reload` below keeps the half that
				// really does need another process.
				//
				// Answered on this goroutine, unlike the interrupt above, because the answer
				// decides whether this process survives: a refusal ends in procCancel, and that
				// decision belongs where the poller can simply stop. The cost is that an `end` or
				// `interrupt` queued behind it waits out the deadline — only ever reached by a CLI
				// that has stopped servicing control at all, which would have left the interrupt
				// unanswered too.
				frames, err := setConfigFrames(resp.Content, job.Agent)
				if err != nil {
					// The control plane builds this payload with JSON.stringify, so an unreadable
					// one is version skew rather than anything a person did. Nothing to apply, and
					// nothing a re-spawn would apply either — the flags it would come back with are
					// the ones already running.
					logln("unreadable setconfig payload for", job.SessionID+":", err)
					settleSetConfigTurn(resp.TurnID, "unreadable payload: "+err.Error(), job, completeTurn)
					continue
				}
				var refused error
				for _, f := range frames {
					// Asked before the frame is built, and only of the one frame whose effect
					// cannot be read back: an effort this CLI would answer `success` to and
					// ignore is not sent at all, it is degraded to the re-spawn below, which
					// applies it the way it has always been applied.
					err := f.unsupportedBy(rt.announcedVersion())
					if err == nil {
						var w *controlWaiter
						if w, err = rt.requestControlWith(f.subtype, f.payload); err == nil {
							err = rt.awaitControl(procCtx, w, claudeSetConfigTimeout)
						}
					}
					if err != nil {
						refused = fmt.Errorf("%s: %w", f.what, err)
						break
					}
				}
				// Written whichever way it went. These values are what the session's config now
				// IS, and the next process built for it — by the fallback just below, by a crash,
				// by a later effort change — has to be built with them. A runner that skipped this
				// would come back up on the model the user stopped using, with the control plane
				// showing the one they chose.
				for _, f := range frames {
					f.apply(&job.Agent)
				}
				if refused == nil {
					// In place: no procCancel, no reloadRequested, and so no `resumed` marker
					// either. Nothing was resumed, and a transcript that says otherwise teaches
					// people to read a restart into every setting they change.
					logln("interactive run", job.SessionID, "— setconfig:", setConfigApplied(frames))
					settleSetConfigTurn(resp.TurnID, setConfigApplied(frames), job, completeTurn)
					continue
				}
				settleSetConfigTurn(resp.TurnID, "fell back to a re-spawn: "+refused.Error(), job, completeTurn)
				if procCtx.Err() != nil {
					// The process is going away underneath the request; its teardown owns what
					// happens next, and there is no re-spawn here to promise anybody.
					logln("setconfig for", job.SessionID, "abandoned:", refused)
					return
				}
				// The engine said no, or said nothing. Fall back to the path this kind exists to
				// avoid — the re-spawn below — and say so where a person can see it: a control
				// frame that was refused and then quietly covered up by a restart looks, from the
				// outside, exactly like the feature working.
				logln("setconfig for", job.SessionID, "fell back to a re-spawn:", refused)
				emit(evSystem, map[string]interface{}{
					"notice":     setConfigDegradedNotice(refused),
					"noticeKind": "setconfig-degraded",
				})
				reloadRequested.Store(true)
				procCancel() // kill claude; the main loop returns reload=true to re-spawn
				return
			case "reload":
				// Model / permission-mode / effort / provider changed, and this session gets the
				// change by being rebuilt. --model, --permission-mode and --effort are spawn
				// flags, so we apply the new values to job.Agent and tear claude down; the outer
				// loop re-spawns with --resume + the new flags (full context preserved).
				// Only the changed fields are carried, so an untouched field keeps its
				// running value. Effort is a *string so present-but-empty can clear it
				// back to the model default (drop --effort) — "" that model/mode can't.
				// A provider switch arrives as a new environment, applied the same way:
				// the process it belongs to is the one this re-spawn creates.
				//
				// Still the only path for the runtimes with no control channel (codex, kimi and
				// opencode reload for every field), and for a provider switch, which really does
				// need a different process. What no longer arrives here on its own is a claude
				// session's model, mode or effort: those are `setconfig` above.
				var cfg struct {
					Model          string  `json:"model"`
					PermissionMode string  `json:"permissionMode"`
					Effort         *string `json:"effort"`
				}
				if json.Unmarshal([]byte(resp.Content), &cfg) == nil {
					if cfg.Model != "" {
						job.Agent.Model = cfg.Model
					}
					if cfg.PermissionMode != "" {
						job.Agent.PermissionMode = cfg.PermissionMode
					}
					if cfg.Effort != nil {
						job.Agent.Effort = *cfg.Effort
					}
				}
				applyProviderEnv(job, resp)
				reloadRequested.Store(true)
				procCancel() // kill claude; the main loop returns reload=true to re-spawn
				return
			case "diff":
				// On-demand live-diff refresh: the web opened a file's diff and the stored
				// snapshot may lag the current worktree (the heartbeat refreshes the file list
				// but not the patch text). Recompute the full live diff and push it back so the
				// drawer shows the real diff within a second or two. Read-only (throwaway temp
				// index, like the heartbeat's liveDiffStat), so it's safe even mid-turn; no
				// claude involvement and no turn consumed. Acked server-side on delivery, so
				// there's no redelivery to dedup against.
				liveFiles, livePatches := liveDiff(job.WT)
				liveBaseSha := job.WT.baseSha()
				if err := t.diffResult(job.SessionID, DiffResultRequest{
					ChangedFiles:   liveFiles,
					ChangedDiff:    livePatches,
					BaseSha:        liveBaseSha,
					WorktreeDirty:  worktreeIsDirty(job.WT),
					BranchSha:      effectiveBranchSha(job.WT),
					BranchMerged:   branchMergedInto(job.WT),
					WorktreeBranch: currentBranch(job.WT),
				}); err != nil {
					logln("diff-result failed for", job.SessionID+":", err)
				}
			case "end":
				endSession()
				return
			default:
				// A kind this binary has never heard of. The control plane is deployed ahead of
				// the runners on purpose, so a newer one WILL hand this fleet instructions some
				// of its members do not know — and with no arm here, that was silent on every
				// side at once: nothing in the log, nothing in the transcript, and a turn this
				// runner never answered. Whatever the person did — changed a model, changed a
				// permission mode — simply did not happen, with no sign anywhere that it hadn't.
				//
				// So it is reported, and settled as a failure of THIS turn — see
				// subtypeUnknownKind for why it must not be a failure of the session. Settling it
				// is belt and braces rather than the point: today's control plane acks a control
				// turn as it delivers it, so this completion is normally an idempotent no-op
				// there. The runner is still the only side that knows the instruction was not
				// carried out, and leaving a turn it was handed unanswered is not an option.
				logln(fmt.Sprintf("interactive run %s — ignoring an inbox turn of unknown kind %q; this runner is older than the control plane that sent it", job.SessionID, resp.Kind))
				if err := completeTurn(TurnCompleteRequest{
					TurnID:           resp.TurnID,
					Status:           stFailed,
					Result:           fmt.Sprintf("this runner does not understand turns of kind %q; upgrade the runner", resp.Kind),
					Subtype:          subtypeUnknownKind,
					RuntimeSessionID: currentRuntimeSessionID(job),
					BranchSha:        effectiveBranchSha(job.WT),
				}); err != nil {
					logln("unknown-kind turn-complete failed for", job.SessionID+":", err)
				}
			}
		}
	}()

	go watchShutdownDrain(procCtx, shutdownCtx, pending, shutdownDrainTimeout,
		pollCancel, procCancel, emit, job.SessionID)

	// Stdout reader (this goroutine): normalize messages; on each per-turn `result`
	// ack the oldest fed message turn via /turn-complete.
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 1024*1024), 16*1024*1024)
	// Text of the most recent assistant message this turn — a Claude API error (e.g.
	// content filtering) shows up here while the trailing `result` still says success,
	// so we use it to fail the turn below. Reset once the turn's `result` is handled.
	var lastAssistantText string
	// Running context-window occupancy: the latest top-level assistant message's total
	// tokens (input + cache + output). Carried into each turn_end event so the clients'
	// context gauge updates live and, via event replay, on session reopen. Persists
	// across turns within this process — the latest value is always the current context.
	// A long turn is many minutes from its turn_end, so ctxPing also reports it mid-turn.
	var contextTokens int
	var ctxPing contextPinger
	targetFenceTripped := false
scanLoop:
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var msg map[string]interface{}
		if json.Unmarshal([]byte(line), &msg) != nil {
			continue
		}
		sawOutput.Store(true)
		// A control_response is the answer to something Orbit asked, not part of the
		// conversation: route it to the request waiting for it and read the next line. An
		// id no request here is waiting for is dropped — a straggler from a process that
		// is already gone, or a second answer to a request that has already been settled
		// (claude_control.go).
		if resp, ok := parseControlResponse(msg); ok {
			if !rt.resolveControl(resp) {
				logln("dropping an unmatched control_response", resp.RequestID,
					fmt.Sprintf("(generation %d)", controlIDGeneration(resp.RequestID)),
					"for", job.SessionID, "on", rt.String())
			}
			continue
		}
		handleMessage(msg, emit, bg)
		// The init handshake is where the CLI names its own version, and it is the only place
		// it does. One control frame has to know it — apply_flag_settings answers `success`
		// whether or not it acted, so the version is all there is to gate on (claude_setconfig.go)
		// — and it is recorded on the runtime rather than the session because it describes THIS
		// process: an engine that self-updates underneath a live session does not change it.
		if msg["type"] == "system" && msg["subtype"] == "init" {
			version, _ := msg["claude_code_version"].(string)
			rt.noteAnnouncedVersion(version)
		}
		// --replay-user-messages: the CLI echoes back each user turn it reads, which is the
		// only signal that a message became part of the conversation rather than just bytes
		// in a pipe. Replays arrive in the order the frames were read, so the oldest
		// unacknowledged message is the one this answers (deliveryLedger).
		if isReplayedUserTurn(msg) {
			if d, ok := deliveries.acknowledgeNext(); ok {
				reportDelivery(d.turnID, deliveryAcknowledged, "", false)
				if d.steer {
					// The echo is a steer's only answer: it has no `result` of its own, so
					// this is the moment its turn is settled. The turn it joined carries on.
					settleSteerTurn(d.turnID, nil, job, completeTurn)
				}
			}
		}
		if msg["type"] == "assistant" {
			if txt := assistantText(msg); txt != "" {
				lastAssistantText = txt
			}
			if ct := contextTokensFromAssistant(msg); ct > 0 {
				contextTokens = ct
				ctxPing.ping(emit, ct, job)
			}
		}
		if msg["type"] == "result" {
			r := resultFrom(msg, procCtx)
			// Recorded before the carrier check below: the id claude runs the conversation
			// under is session-level, and a resume can report it on a result that belongs to
			// no turn of ours.
			if r.ClaudeSessionID != "" {
				job.RuntimeSessionID = r.ClaudeSessionID
				writeSessionMeta(scratchDir, job, execDir)
			}
			// Claude's own synthetic resume turn (see isResumeCarrierResult) ends here too.
			// Nothing was asked and nothing was produced, so publish no turn_end — the clients
			// read one as "the turn is over" and would paint the session idle in the middle of
			// the reply the user is waiting for — and leave `pending` untouched: the message
			// that was fed is still unanswered, and the result of the work it actually starts
			// is what acks it.
			if isResumeCarrierResult(r, lastAssistantText) {
				continue
			}
			var turnID string
			select {
			case turnID = <-pending:
			default:
			}
			// A target result and a target-bearing frame commit share activeOrbitMu. If the
			// frame committed but its replay ACK has not been observed, Claude may still have
			// it in stdin after emitting this result. Kill this generation before any B can be
			// fed; the durable failure belongs to the steer, while A's own result remains valid.
			activeOrbitMu.Lock()
			fenced := deliveries.failUnacknowledgedTarget(turnID)
			if activeOrbitTurnID == turnID {
				activeOrbitTurnID = ""
			}
			if len(fenced) > 0 {
				targetFenceTripped = true
				rt.markTerminal()
				procCancel()
			} else {
				// A normal turn boundary, not an exit: the process stays up with stdin open,
				// which lets the next message reuse it instead of spawning again.
				rt.endTurn()
			}
			activeOrbitMu.Unlock()
			for _, d := range fenced {
				if d.requeueable {
					// The generation that could have read this frame is being killed above, so
					// "unacknowledged at this boundary" is proof it never became part of the
					// conversation — the same proof that used to justify calling it failed. It
					// goes back to the queue and runs as its own turn instead.
					//
					// Said out loud, unlike the preflight re-file: this message's bubble is
					// already open (it was accepted, and its bytes may have been written), so
					// leaving it on "Delivering…" until the re-delivery lands would be the one
					// thing every state in this vocabulary exists to prevent.
					reportDelivery(d.turnID, deliveryRequeued, "", false)
					requeueSteerTurn(d.turnID, job, completeTurn)
					continue
				}
				reportDelivery(d.turnID, deliveryFailed, errCurrentWorkTargetEnded.Error(), false)
				settleSteerTurn(d.turnID, errCurrentWorkTargetEnded, job, completeTurn)
			}
			turnStatus := stSucceeded
			if r.Subtype == "error_during_execution" {
				turnStatus = stInterrupted
			} else if r.Status == stFailed {
				turnStatus = stFailed
			}
			// A Claude API error — or an expired sign-in — returns as assistant text + a
			// "success" result with no is_error, so it slips past resultFrom. Treat the turn
			// as failed so the control plane surfaces it (and reclaims a task session)
			// instead of parking the session as if the turn succeeded.
			if turnStatus == stSucceeded &&
				(isAPIError(r.Result) || isAPIError(lastAssistantText) ||
					isAuthError(r.Result) || isAuthError(lastAssistantText)) {
				turnStatus = stFailed
			}
			lastAssistantText = ""
			emit(evTurnEnd, withContextWindow(map[string]interface{}{
				"subtype":       r.Subtype,
				"numTurns":      r.NumTurns,
				"costUsd":       r.CostUsd,
				"contextTokens": contextTokens,
			}, job))
			if turnID != "" {
				// Live worktree state for the composer's status bar: what this turn left in
				// the worktree (uncommitted), so the diff updates each turn, not just at end.
				liveFiles, livePatches := liveDiff(job.WT)
				liveBaseSha := job.WT.baseSha()
				if err := completeTurn(TurnCompleteRequest{
					TurnID:           turnID,
					Status:           turnStatus,
					Result:           r.Result,
					Subtype:          r.Subtype,
					NumTurns:         r.NumTurns,
					CostUsd:          r.CostUsd,
					Usage:            r.Usage,
					ModelUsage:       r.ModelUsage,
					RuntimeSessionID: currentRuntimeSessionID(job),
					IsolationStatus:  job.IsolationStatus,
					ChangedFiles:     liveFiles,
					ChangedDiff:      livePatches,
					BaseSha:          liveBaseSha,
					WorktreeDirty:    worktreeIsDirty(job.WT),
					BranchSha:        effectiveBranchSha(job.WT),
					BranchMerged:     branchMergedInto(job.WT),
					WorktreeBranch:   currentBranch(job.WT),
				}); err != nil {
					logln("turn-complete failed for", job.SessionID+":", err)
				}
				inflightMu.Lock()
				delete(inflight, turnID)
				inflightMu.Unlock()
				setTurn("") // turn acked; until the next message, events are session-level
			}
			if len(fenced) > 0 {
				break scanLoop
			}
		}
	}
	// stdout EOF: the CLI is on its way out. Reclaim the child (and anything it left
	// running) once the writer has finished with stdin.
	rt.markTerminal()
	_ = rt.wait()
	// Account for the messages this process still owed before anything re-delivers them.
	settleUndeliveredMessages(deliveries, job, completeTurn, reportDelivery)
	// stderr is an event source too. Join it before the provider generation
	// returns, otherwise it can append after the supervisor's final flush.
	stderrWg.Wait()
	procCancel()
	<-pollDone

	if ctx.Err() != nil {
		return stCancelled, true, false
	}
	if reloadRequested.Load() {
		return stCancelled, false, true // config changed -> respawn with the new flags
	}
	if targetFenceTripped {
		return sessionProcessCurrentWorkFenced, false, false
	}
	select {
	case <-endedCh:
		return stSucceeded, true, false // user ended the session
	default:
	}
	if shutdownCtx.Err() != nil {
		return stCancelled, true, false // graceful drain -> caller detaches without finalizing
	}
	// One startup refusal is not deterministic in its arguments: claude rejects
	// `--session-id X` when X already names a conversation, which happens when the server
	// asks for a first spawn on an id an earlier spawn already opened (a turn that never
	// settled leaves numTurns at 0 — see queue.buildSession). Failing here would wedge the
	// session for good, since every later message repeats the same refusal. The conversation
	// is exactly what we want, so respawn onto it with --resume.
	if firstSpawn && sessionIDTaken.Load() {
		logln(fmt.Sprintf("interactive run %s — session id already opened; resuming it instead", job.SessionID))
		return stFailed, false, false
	}
	// A clean exit with nothing on stdout is a startup refusal (bad flags, a resume
	// target that can't be rebuilt, running --dangerously-skip-permissions as root):
	// the same spawn with the same arguments refuses the same way, so respawning just
	// burns retries on a deterministic error. Fail the session instead.
	if cmd.ProcessState != nil && startupRefusal(cmd.ProcessState.ExitCode(), sawOutput.Load()) {
		return stFailed, true, false
	}
	return stFailed, false, false // unexpected exit -> respawn with --resume
}

// sessionIDInUse reports whether a stderr line is claude refusing to open the
// --session-id it was given because that id already has a conversation on this machine
// ("Error: Session ID <uuid> is already in use."). Only meaningful for a first spawn:
// a resume never passes --session-id.
func sessionIDInUse(line string) bool {
	return strings.Contains(line, "Session ID") && strings.Contains(line, "is already in use")
}

// startupRefusal reports whether a process exit was a startup refusal rather than a
// crash: the CLI exited on its own (exitCode >= 0 — ProcessState.ExitCode returns -1
// when a signal killed it) without ever producing a stream-json message on stdout, i.e.
// it died inside its own startup, where a respawn with the same arguments fails the
// same way.
func startupRefusal(exitCode int, sawOutput bool) bool {
	return !sawOutput && exitCode >= 0
}

// writeUpload saves a non-image/-PDF attachment into the session's uploads dir, which lives
// OUTSIDE the git worktree (see uploadsDir) so attachments are never swept into the session's
// auto-commit, surfaced in the live diff, or merged to main. Returns the ABSOLUTE path to hand
// to claude. The name is reduced to its base (no path traversal) and falls back to the
// attachment id when unusable.
func writeUpload(sessionID, name, id string, data []byte) (string, error) {
	base := filepath.Base(strings.TrimSpace(name))
	if base == "." || base == ".." || base == string(filepath.Separator) || base == "" {
		base = id
	}
	dir := uploadsDir(sessionID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	p := filepath.Join(dir, base)
	if err := os.WriteFile(p, data, 0o644); err != nil {
		return "", err
	}
	return p, nil
}
