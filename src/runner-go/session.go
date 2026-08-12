package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const maxRespawns = 5

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

var ctrlReqCounter int64

func nextReqID() string {
	return "req-" + strconv.FormatInt(atomic.AddInt64(&ctrlReqCounter, 1), 10)
}

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

func runInteractiveSession(t *Transport, job *ClaimedSession, ctx context.Context, shutdownCtx context.Context, execDir string, onCodexRateLimits func(map[string]interface{}), pool *sessionPool, live *liveSession) {
	syncJobProvider(job)
	// Stable across warm/cold claims. The outer loop swaps `job` to the newest
	// claim payload on a cold resume while the event flusher runs concurrently.
	// Capture the immutable id so that goroutine never races that pointer swap.
	sessionID := job.SessionID
	scratch := filepath.Join(runsDir(), sessionID)
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
	emissionGate := &eventEmissionGate{}
	flushGate := newEventFlushGate()
	flushWithContext := func(ctx context.Context) error {
		return flushGate.run(ctx, func(flushCtx context.Context) error {
			bufMu.Lock()
			if len(buf) == 0 {
				bufMu.Unlock()
				return nil
			}
			events := buf
			buf = nil
			bufMu.Unlock()
			err := retryIdempotentWhile(flushCtx, func(attemptCtx context.Context) error {
				return t.postEvents(attemptCtx, sessionID, RunEventBatch{Events: events})
			}, isRetryableTransportError)
			if isLeaseOwnershipError(err) {
				markOwnershipLost(err)
				return err
			}
			if err != nil {
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
	emit := func(eventType string, payload map[string]interface{}) {
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
			curTurnMu.Lock()
			tid := curTurn
			curTurnMu.Unlock()
			bufMu.Lock()
			buf = append(buf, RunEvent{Seq: s, Type: eventType, TS: nowISO(), TurnID: tid, Payload: payload})
			bufMu.Unlock()
		})
		// Do NOT postEvents inline: emit runs on the stdout-reader goroutine, and a
		// slow post must never stall draining claude's stdout (backpressure freeze).
		// The 250ms flush goroutine owns all network sends.
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
		completionCtx := turnAckCtx
		cancelCompletion := func() {}
		// A failed turn ends the Session (see /turn-complete), task-bound or not: the
		// control plane cannot show a failure it parked as AWAITING_INPUT. Both kinds take
		// the terminal handoff below, whose ordering — drain the events, THEN terminalize —
		// is what keeps the error itself on screen: events posted after the Session is
		// terminal are persisted but no longer broadcast, so a watching client would see the
		// status flip to Failed with no sign of what failed until it reloaded.
		failedTurn := req.Status == stFailed
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
		// Capture before the network round-trip. Once the server commits
		// AWAITING_INPUT, a new send/claim may reach pool.activate before this
		// response returns; generation matching prevents this old ack from
		// releasing the new claim's permit.
		permitGeneration := pool.permitGeneration(live)
		next, err := t.turnComplete(completionCtx, sessionID, req)
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
		activateErr := retryActivateTurnLeases(activateCtx, func(attemptCtx context.Context) error {
			return t.activateTurnLeases(attemptCtx, sessionID, leaseGeneration)
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
		engineCtx, engineCancel := context.WithCancel(sessionCtx)
		engineHandle := &engineStopHandle{cancel: engineCancel}
		engineStopMu.Lock()
		currentEngine = engineHandle
		engineStopMu.Unlock()
		if pool.engineStarted(live, engineGeneration, engineCancel) {
			engineCancel() // timer/LRU won while this engine was being reserved
		}
		st, ended, reload := runSessionProcess(engineCtx, shutdownCtx, t, job, leaseGeneration, execDir, scratch, emit, setTurn, firstSpawn, bg, onCodexRateLimits, completeTurn, waitTurnPermit, markOwnershipLost)
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
		// Any unexpectedly dead engine may have taken an executable inbox
		// lease with it. Expire that lease before the cold replacement starts;
		// otherwise the at-least-once turn is invisible until the server's
		// five-minute deadline (most visible with a crashed ACP process).
		// An idle warm engine that exits unexpectedly simply becomes cold. Only an
		// active turn spends the crash-respawn budget.
		if !pool.isActive(live) {
			continue
		}
		// Unexpected crash — resume up to maxRespawns times with a small back-off.
		respawns++
		if respawns > maxRespawns {
			status = stFailed
			break
		}
		emit(evSystem, map[string]interface{}{"subtype": "resumed", "attempt": respawns})
		logln(fmt.Sprintf("interactive run %s — %s exited unexpectedly; resuming (attempt %d)", job.SessionID, runtimeProvider(job), respawns))
		time.Sleep(time.Duration(respawns) * time.Second)
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
		finalizeRequest.BaseSha = job.WT.baseSha()
		// The worktree's ACTUAL HEAD branch (before finalize/removal) differs from the reported
		// branch when the agent ran `git checkout -b` inside the checkout, so the server can flag
		// it / offer Adopt.
		finalizeRequest.WorktreeBranch = currentBranch(job.WT)
		finalizeRequest.ChangedFiles, finalizeRequest.ChangedDiff = finalizeWorktree(job.WT, status == stCancelled)
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
var builtinTaskTools = []string{"TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "TaskOutput", "TaskStop"}

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
	case "ORBIT_SESSION_ID", "ORBIT_AGENT_ID", "ORBIT_TASK_ID",
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

func runSessionProcess(ctx context.Context, shutdownCtx context.Context, t *Transport, job *ClaimedSession, leaseGeneration, execDir, scratchDir string, emit emitFn, setTurn func(string), firstSpawn bool, bg *bgTailer, onCodexRateLimits func(map[string]interface{}), completeTurn turnCompleter, waitTurnPermit turnPermitWaiter, onLeaseLost leaseLossHandler) (string, bool, bool) {
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
	if provider == providerCodex {
		return runCodexSessionProcess(ctx, shutdownCtx, t, job, leaseGeneration, execDir, scratchDir, emit, setTurn, firstSpawn, bg, onCodexRateLimits, completeTurn, waitTurnPermit, onLeaseLost)
	}
	if provider == providerKimi {
		return runKimiSessionProcess(ctx, shutdownCtx, t, job, leaseGeneration, execDir, scratchDir, emit, setTurn, firstSpawn, bg, completeTurn, waitTurnPermit, onLeaseLost)
	}
	if provider == providerOpenCode {
		return runOpenCodeSessionProcess(ctx, shutdownCtx, t, job, leaseGeneration, execDir, scratchDir, emit, setTurn, firstSpawn, bg, completeTurn, waitTurnPermit, onLeaseLost)
	}
	return runClaudeSessionProcess(ctx, shutdownCtx, t, job, leaseGeneration, execDir, scratchDir, emit, setTurn, firstSpawn, bg, completeTurn, waitTurnPermit, onLeaseLost)
}

// runClaudeSessionProcess spawns ONE claude process and drives it until the session
// ends (an 'end' turn closes stdin) or the process exits. Returns (status, ended,
// reload). ended=false means the caller should re-spawn: reload=true for a requested
// model/permission-mode change, reload=false for an unexpected crash.
func runClaudeSessionProcess(ctx context.Context, shutdownCtx context.Context, t *Transport, job *ClaimedSession, leaseGeneration, execDir, scratchDir string, emit emitFn, setTurn func(string), firstSpawn bool, bg *bgTailer, completeTurn turnCompleter, waitTurnPermit turnPermitWaiter, onLeaseLost leaseLossHandler) (string, bool, bool) {
	// Reset turn attribution for this (possibly re-spawned) process: events before
	// the first turn is (re-)fed — claude's system/init — are session-level (null).
	setTurn("")
	a := job.Agent
	// Set when an inbox 'reload' turn asks us to re-spawn with a new model/mode.
	var reloadRequested atomic.Bool
	// --max-turns / --max-budget-usd are process-wide (Phase 0), so they are
	// intentionally NOT passed for a long-lived interactive session.
	args := []string{
		"-p",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--include-partial-messages",
		"--replay-user-messages",
		"--verbose",
		"--model", a.Model,
		"--permission-mode", a.PermissionMode,
	}
	if a.Effort != "" {
		args = append(args, "--effort", a.Effort)
	}
	// Apply the agent's configured prompts (claim payload carries both; previously
	// dropped here). --system-prompt replaces the default, --append-system-prompt adds.
	// The Orbit CLI discovery instructions are platform instructions and therefore
	// always join the append prompt rather than replacing the provider's defaults.
	orbitExe := orbitCLIExecutable()
	args = appendClaudeAgentInstructionArgs(
		args,
		a,
		orbitExe,
		job.AllowOrchestration,
	)
	// Orbit ships its own task tools via the `orbit` MCP server (mcp__orbit__task_*).
	// Claude's built-in Task* tools collide by intent: an agent told to "create tasks"
	// reaches for them, but those entries are session-local todos that never reach
	// Orbit's DB — so the tasks never appear in the UI. Always disable the built-in
	// family so task work is forced through the orbit MCP server.
	if disallowed := withBuiltinTaskToolsDisallowed(a.DisallowedTools); len(disallowed) > 0 {
		args = append(args, "--disallowedTools", strings.Join(disallowed, ","))
	}
	// Always pass an --mcp-config: merge the agent's configured servers with the
	// built-in `orbit` server (this same binary in `mcp` mode), so every session can
	// manage Tasks. os.Executable() is resolved per-spawn, so it survives self-update.
	// The orbit entry carries an explicit timeout because permission_prompt blocks on a
	// human, which claude otherwise aborts after its 30-minute idle default (see
	// mcpToolTimeoutMs). Scoping it to this server leaves the agent's own MCP servers on
	// claude's normal timeouts, where an unresponsive server SHOULD self-heal.
	servers := map[string]interface{}{}
	for k, v := range a.McpConfig {
		servers[k] = v
	}
	if orbitExe != "" {
		servers["orbit"] = map[string]interface{}{
			"command": orbitExe,
			"args":    []string{"mcp"},
			"timeout": mcpToolTimeoutMs,
		}
	}
	if len(servers) > 0 {
		mcpPath := filepath.Join(scratchDir, "mcp.json")
		b, _ := json.Marshal(map[string]interface{}{"mcpServers": servers})
		_ = os.WriteFile(mcpPath, b, 0o644)
		args = append(args, "--mcp-config", mcpPath)
		// Route tool-permission prompts (incl. plan-mode ExitPlanMode) to the orbit MCP
		// server's permission_prompt tool, which blocks on a human allow/deny in the UI.
		// The orbit server is always injected above, so this target always exists.
		args = append(args, "--permission-prompt-tool", "mcp__orbit__permission_prompt")
	}
	if firstSpawn {
		args = append(args, "--session-id", job.SessionUUID)
	} else {
		// claude keeps the conversation in a local file keyed by cwd + session id, which this
		// machine may simply not have: the session's first spawn on a different runner, a wiped
		// ~/.claude, a moved worktree. Orbit still has every event, so rebuild the file instead
		// of letting --resume fail with "No conversation found with session ID".
		ensureClaudeTranscript(ctx, t, job, execDir, emit)
		args = append(args, "--resume", job.SessionUUID)
	}
	// Uploaded attachments land in the session's uploads dir, which is OUTSIDE execDir so they
	// stay out of git (see writeUpload). Add it as an explicit working dir so claude can read
	// them without a per-read permission prompt; created up front so the flag points at an
	// existing dir even before the first upload arrives.
	upDir := uploadsDir(job.SessionID)
	if err := os.MkdirAll(upDir, 0o755); err == nil {
		args = append(args, "--add-dir", upDir)
	}

	procCtx, procCancel := context.WithCancel(ctx)
	defer procCancel()
	// pollCtx gates only the inbox poller. On runner shutdown we cancel it to stop
	// pulling new turns WITHOUT tearing down claude, so an in-flight turn can finish and
	// ack before we detach. It derives from procCtx, so procCancel also stops the poller.
	pollCtx, pollCancel := context.WithCancel(procCtx)
	defer pollCancel()
	cmd := exec.CommandContext(procCtx, "claude", args...)
	configureSessionProcessTree(cmd)
	cmd.Dir = execDir
	// Start from the runner's own env, then layer the agent's custom env vars on top.
	cmd.Env = envWithAgent(job.Agent.Env)
	// Inject session context so the built-in `orbit mcp` server (a child of claude)
	// knows where it is. The runner token is NOT passed here — `orbit mcp` reads it
	// from config.json so it never lands in the claude process environment.
	// Appended last so a custom env var can't shadow the session context.
	cmd.Env = append(cmd.Env,
		"ORBIT_SESSION_ID="+job.SessionID,
		"ORBIT_AGENT_ID="+job.AgentID, // empty => orbit mcp falls back to USER attribution
		"ORBIT_TASK_ID="+job.TaskID,   // empty => no "current task"
		"ORBIT_ALLOW_ORCHESTRATION="+orchestrationEnv(job.AllowOrchestration),
	)
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()
	if err := cmd.Start(); err != nil {
		emit(evError, map[string]interface{}{"message": "failed to spawn claude: " + err.Error()})
		return stFailed, true, false // a spawn failure won't be fixed by respawning
	}

	var stderrWg sync.WaitGroup
	stderrWg.Add(1)
	go func() {
		defer stderrWg.Done()
		s := bufio.NewScanner(stderr)
		s.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		for s.Scan() {
			emit(evSystem, map[string]interface{}{"stderr": s.Text() + "\n"})
		}
	}()

	pending := make(chan string, 8) // message turnIds fed but not yet resulted (FIFO)
	inflight := map[string]bool{}   // turnIds being processed (dedup lease re-delivery)
	var inflightMu sync.Mutex
	endedCh := make(chan struct{})
	var endOnce sync.Once
	endSession := func() {
		endOnce.Do(func() {
			close(endedCh)
			_ = stdin.Close()
		})
	}

	var stdinMu sync.Mutex
	writeStdin := func(line string) error {
		stdinMu.Lock()
		defer stdinMu.Unlock()
		_, err := io.WriteString(stdin, line)
		return err
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
			case "message":
				if !waitTurnPermit(procCtx) {
					return
				}
				// Attribute this process's output to this turn. Set BEFORE the dedup
				// early-return so a lease re-delivery (turn still running) still tags
				// the resumed/replayed output with the correct turn.
				setTurn(resp.TurnID)
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
					pendingShellCtx = nil
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
				emit(evUser, userEv)
				select {
				case pending <- resp.TurnID:
				case <-procCtx.Done():
					return
				}
				line, _ := json.Marshal(map[string]interface{}{
					"type": "user",
					"message": map[string]interface{}{
						"role":    "user",
						"content": content,
					},
				})
				if err := writeStdin(string(line) + "\n"); err != nil {
					logln("stdin write failed for", job.SessionID+":", err)
					return
				}
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
				if shCmd, isBg := splitBackground(resp.Content); isBg {
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
					shOut, shExit := runShellTurn(procCtx, execDir, resp.Content, emit, resp.TurnID, job.Agent.Env)
					pendingShellCtx = append(pendingShellCtx,
						fmt.Sprintf("<bash-input>%s</bash-input>\n<bash-stdout>%s</bash-stdout>", resp.Content, shOut))
					if err := completeTurn(TurnCompleteRequest{
						TurnID: resp.TurnID, Status: stSucceeded,
						Result: fmt.Sprintf("exit %d", shExit), Subtype: "shell",
						RuntimeSessionID: currentRuntimeSessionID(job),
						BranchSha:        effectiveBranchSha(job.WT),
					}); err != nil {
						logln("shell turn-complete failed for", job.SessionID+":", err)
					}
				}
				inflightMu.Lock()
				delete(inflight, resp.TurnID)
				inflightMu.Unlock()
				setTurn("")
			case "interrupt":
				ctrl, _ := json.Marshal(map[string]interface{}{
					"type":       "control_request",
					"request_id": nextReqID(),
					"request":    map[string]interface{}{"subtype": "interrupt"},
				})
				_ = writeStdin(string(ctrl) + "\n")
				emit(evInterrupt, map[string]interface{}{})
			case "reload":
				// Model / permission-mode / effort changed on this idle session.
				// --model, --permission-mode and --effort are spawn flags, so we apply
				// the new values to job.Agent and tear claude down; the outer loop
				// re-spawns with --resume + the new flags (full context preserved).
				// Only the changed fields are carried, so an untouched field keeps its
				// running value. Effort is a *string so present-but-empty can clear it
				// back to the model default (drop --effort) — "" that model/mode can't.
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
				if err := t.diffResult(job.SessionID, DiffResultRequest{
					ChangedFiles:   liveFiles,
					ChangedDiff:    livePatches,
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
			}
		}
	}()

	// Drain watcher: on runner shutdown, stop pulling new turns and let any in-flight
	// turn finish + ack (pending drains as the stdout reader acks each `result`), then
	// tear claude down. The caller detaches without finalizing, so the next runner
	// reclaims + --resumes. Idle sessions (pending empty) detach at once.
	go func() {
		select {
		case <-procCtx.Done():
			return
		case <-shutdownCtx.Done():
		}
		pollCancel()
		tk := time.NewTicker(150 * time.Millisecond)
		defer tk.Stop()
		deadline := time.After(shutdownDrainTimeout)
		for len(pending) > 0 {
			select {
			case <-tk.C:
			case <-procCtx.Done():
				return
			case <-deadline:
				logln("drain timeout for", job.SessionID+"; tearing down mid-turn")
				procCancel()
				return
			}
		}
		procCancel()
	}()

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
	var contextTokens int
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var msg map[string]interface{}
		if json.Unmarshal([]byte(line), &msg) != nil {
			continue
		}
		handleMessage(msg, emit, bg)
		if msg["type"] == "assistant" {
			if txt := assistantText(msg); txt != "" {
				lastAssistantText = txt
			}
			if ct := contextTokensFromAssistant(msg); ct > 0 {
				contextTokens = ct
			}
		}
		if msg["type"] == "result" {
			r := resultFrom(msg, procCtx)
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
			if r.ClaudeSessionID != "" {
				job.RuntimeSessionID = r.ClaudeSessionID
				writeSessionMeta(scratchDir, job, execDir)
			}
			emit(evTurnEnd, map[string]interface{}{
				"subtype":       r.Subtype,
				"numTurns":      r.NumTurns,
				"costUsd":       r.CostUsd,
				"contextTokens": contextTokens,
			})
			var turnID string
			select {
			case turnID = <-pending:
			default:
			}
			if turnID != "" {
				// Live worktree state for the composer's status bar: what this turn left in
				// the worktree (uncommitted), so the diff updates each turn, not just at end.
				liveFiles, livePatches := liveDiff(job.WT)
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
		}
	}
	_ = waitSessionProcessTree(cmd)
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
	select {
	case <-endedCh:
		return stSucceeded, true, false // user ended the session
	default:
	}
	if shutdownCtx.Err() != nil {
		return stCancelled, true, false // graceful drain -> caller detaches without finalizing
	}
	return stFailed, false, false // unexpected exit -> respawn with --resume
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
