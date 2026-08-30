package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
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
	"unicode/utf8"
)

type codexRPCError struct {
	Code    int         `json:"code"`
	Message string      `json:"message"`
	Data    interface{} `json:"data,omitempty"`
}

type codexRPCMessage struct {
	ID     interface{}     `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *codexRPCError  `json:"error,omitempty"`
}

type codexInstructionMode uint8

const (
	codexInstructionsUserInput codexInstructionMode = iota
	codexInstructionsInjectItems
	codexInstructionsAdditionalContext
)

// codexApprovalFn answers one inbound approval request. nil keeps the fail-closed behaviour that
// predates the bridge, which is also what the protocol tests exercise.
type codexApprovalFn func(context.Context, codexApprovalRequest, map[string]interface{}) bool

type codexAppServer struct {
	cmd     *exec.Cmd
	ctx     context.Context // cancelled with the process; bounds a pending approval poll
	cancel  context.CancelFunc
	stdin   io.WriteCloser
	ioWg    sync.WaitGroup
	approve codexApprovalFn
	emit    emitFn

	writeMu sync.Mutex
	mu      sync.Mutex
	nextID  int64
	pending map[string]chan codexRPCMessage
	// stdoutErr is set before done/pending are closed so a request interrupted by a
	// framing or pipe error reports that cause instead of the generic process closure.
	stdoutErr error

	notifications chan codexRPCMessage
	done          chan struct{}
	doneOnce      sync.Once

	orbitExecutable     string
	instructionMode     codexInstructionMode
	instructionMu       sync.Mutex
	contextGeneration   uint64
	contextRefreshEpoch uint64
	contextNeedsRefresh bool

	// Set from the stderr reader when Codex died bringing up its SQLite state, which is the
	// one start failure worth another attempt. Read only after close() has joined that reader.
	stateInitFailed atomic.Bool

	// Set the first time this build answers a turn/steer with "unknown variant", which is the
	// authoritative signal that it predates the method. It is a property of the process, not of
	// a version guess, so once it is set no later steer spends a round trip finding out again
	// (docs/codex-turn-steer-contract.md §5.2).
	steerUnsupported atomic.Bool
}

type codexAppActiveTurn struct {
	orbitTurnID         string
	codexTurnID         string
	startSent           bool
	finishing           bool
	interruptRequested  bool
	interruptSent       bool
	runtimeAcknowledged bool
	result              codexTurnResult
	fullText            strings.Builder
	deltaText           strings.Builder
	thinkText           strings.Builder
	// steers: the mid-turn messages written into this turn, keyed by the Orbit turn id sent as
	// clientUserMessageId — the only key Codex echoes back (codex_steer.go).
	steers map[string]*codexSteerDelivery
}

type codexAppTurnSnapshot struct {
	orbitTurnID string
	result      codexTurnResult
	fullText    string
	deltaText   string
	// openSteers: mid-turn messages this turn was still holding when it ended. Codex discards a
	// steer it never got to inject, silently, so they are this turn's to answer for.
	openSteers []string
}

// beginCodexAppTurnFinalize makes completion single-flight while deliberately
// leaving active non-nil. Shutdown waits for active to clear, so the supervisor
// cannot tear down the event/turn-ack contexts after Codex reports completion but
// before Orbit durably records it.
func beginCodexAppTurnFinalize(activeMu *sync.Mutex, active **codexAppActiveTurn) (*codexAppActiveTurn, codexAppTurnSnapshot, bool) {
	activeMu.Lock()
	defer activeMu.Unlock()
	if *active == nil || (*active).finishing {
		return nil, codexAppTurnSnapshot{}, false
	}
	a := *active
	a.finishing = true
	return a, codexAppTurnSnapshot{
		orbitTurnID: a.orbitTurnID,
		result:      a.result,
		fullText:    a.fullText.String(),
		deltaText:   a.deltaText.String(),
		openSteers:  takeOpenCodexSteers(a),
	}, true
}

func finishCodexAppTurnFinalize(activeMu *sync.Mutex, active **codexAppActiveTurn, finishing *codexAppActiveTurn) {
	activeMu.Lock()
	if *active == finishing {
		*active = nil
	}
	activeMu.Unlock()
}

func runCodexAppServerSessionProcess(ctx context.Context, shutdownCtx context.Context, t *Transport, job *ClaimedSession, leaseGeneration, execDir, scratchDir string, emit emitFn, emitFor emitTurnFn, setTurn func(string), _ bool, bg *bgTailer, onRateLimits func(map[string]interface{}), completeTurn turnCompleter, waitTurnPermit turnPermitWaiter, onLeaseLost leaseLossHandler) (string, bool, bool) {
	setTurn("")
	upDir := uploadsDir(job.SessionID)
	_ = os.MkdirAll(upDir, 0o755)

	processEnv := envWithAgent(job.Agent.Env)
	meta := readSessionMeta(filepath.Join(scratchDir, "meta.json"))
	state, err := resolveCodexStateDir(scratchDir, job.RuntimeSessionID, meta, processEnv, execDir)
	if err != nil {
		emit(evError, map[string]interface{}{"message": "failed to prepare codex state: " + err.Error()})
		return stFailed, true, false
	}
	if state.Shared {
		// Once selected, both the SQLite partition and the rollout/config source
		// remain sticky. This prevents a later HOME change from backfilling a new
		// account's history into the existing partition.
		processEnv = envWithValue(processEnv, "CODEX_HOME", state.CodexHome)
	}
	// Persist the layout before spawning. A pre-thread failure can leave a directory
	// behind; the marker prevents a later resume from mistaking shared state for an
	// old session-local runtime (or vice versa).
	writeSessionMetaWithCodexState(scratchDir, job, execDir, state.Layout, state.Partition, state.CodexHome)
	if state.Shared {
		if err := ensureSharedCodexStateReady(ctx, shutdownCtx, state, processEnv); err != nil {
			if ctx.Err() != nil || shutdownCtx.Err() != nil {
				return stCancelled, true, false
			}
			emit(evError, map[string]interface{}{"message": "failed to initialize shared codex state: " + err.Error()})
			return stFailed, true, false
		}
	}
	// Shared state has already crossed the expensive backfill gate. Legacy and
	// credential-isolated state may still need that work, so keep the same bounded
	// long window instead of reintroducing the old two-minute interruption.
	initTimeout := codexConnectionInitTimeout
	if !state.Shared {
		initTimeout = codexStateInitTimeout
	}
	app, err := startReadyCodexAppServer(ctx, state, initTimeout, func() (*codexAppServer, error) {
		return startCodexAppServer(ctx, job, execDir, state.Dir, processEnv, emit,
			func(approvalCtx context.Context, request codexApprovalRequest, params map[string]interface{}) bool {
				return bridgeCodexApproval(approvalCtx, t, job, request, params)
			})
	})
	if err != nil {
		emit(evError, map[string]interface{}{"message": err.Error()})
		return stFailed, true, false
	}
	workerCtx, cancelWorkers := context.WithCancel(ctx)
	var asyncWg sync.WaitGroup
	defer func() {
		// Stop attachment preparation and RPC helpers first, then close the process
		// so every pending request/notification unblocks. No worker that can emit or
		// complete a turn may outlive this provider generation.
		cancelWorkers()
		app.close()
		asyncWg.Wait()
	}()

	// A resumed thread already carries the developer message an earlier generation
	// injected, and inject_items appends rather than replaces. Injecting again on every
	// warm restart / LRU reload would accumulate a copy of the agent context per
	// generation. Compaction still replays it through prepareInstructionContext.
	// The assumption only breaks for a thread first created under a different
	// instruction mode, which needs the engine to cross 0.125 mid-session; the
	// inject_items band is itself a narrow compatibility window, so prefer the
	// bounded transcript over a per-generation copy.
	resumedThread := job.RuntimeSessionID != ""
	threadID, err := app.startOrResumeThread(ctx, job, execDir, upDir)
	if err != nil {
		emit(evError, map[string]interface{}{"message": "failed to start codex thread: " + err.Error()})
		return stFailed, true, false
	}
	if !resumedThread && app.currentInstructionMode() == codexInstructionsInjectItems {
		if err := app.injectAgentContext(ctx, threadID, job.Agent); err != nil {
			// Some downstream builds can report a newer-looking user agent while
			// omitting the experimental method. Preserve discoverability through
			// the lower-priority user-input fallback instead of failing the session.
			logln("codex thread/inject_items unavailable; using user context:", err)
			app.setInstructionMode(codexInstructionsUserInput)
		}
	}
	job.RuntimeSessionID = threadID
	writeSessionMetaWithCodexState(scratchDir, job, execDir, state.Layout, state.Partition, state.CodexHome)
	emit(evSystem, map[string]interface{}{"subtype": "init", "sessionId": threadID, "provider": providerCodex, "runtime": "app-server"})

	var activeMu sync.Mutex
	var active *codexAppActiveTurn
	inflight := map[string]bool{}
	var inflightMu sync.Mutex

	clearInflight := func(turnID string) {
		if turnID == "" {
			return
		}
		inflightMu.Lock()
		delete(inflight, turnID)
		inflightMu.Unlock()
	}

	steerDispatch := &codexSteerDispatcher{
		app: app, t: t, job: job, threadID: threadID,
		activeMu: &activeMu, active: &active, emitFor: emitFor, completeTurn: completeTurn,
	}

	finalizeActive := func(result codexTurnResult) {
		a, snapshot, ok := beginCodexAppTurnFinalize(&activeMu, &active)
		if !ok {
			return
		}
		// Every steer this turn was still holding is answered before the turn itself is, and
		// individually: a failed turn seals the session's event stream, so a report filed after
		// that settlement would be dropped and the message would go unaccounted for in the one
		// place a person reads.
		for _, steerTurnID := range snapshot.openSteers {
			steerDispatch.fail(steerTurnID, errCodexSteerDropped)
		}
		if result.Status == "" {
			result.Status = snapshot.result.Status
		}
		if result.Subtype == "" {
			result.Subtype = snapshot.result.Subtype
		}
		if result.Result == "" {
			result.Result = snapshot.result.Result
		}
		if result.Result == "" {
			result.Result = strings.TrimSpace(snapshot.fullText)
		}
		if result.Result == "" {
			result.Result = strings.TrimSpace(snapshot.deltaText)
		}
		if result.Error == "" {
			result.Error = snapshot.result.Error
		}
		if result.Usage == nil {
			result.Usage = snapshot.result.Usage
		}

		if result.Status == "" {
			result.Status = stSucceeded
		}
		if result.Subtype == "" {
			result.Subtype = "completed"
		}
		if result.Status == stFailed && result.Result == "" {
			result.Result = result.Error
		}
		emit(evTurnEnd, codexTurnEndPayload(result, 1, 0, job))
		liveFiles, livePatches := liveDiff(job.WT)
		liveBaseSha := job.WT.baseSha()
		if err := completeTurn(TurnCompleteRequest{
			TurnID:           snapshot.orbitTurnID,
			Status:           result.Status,
			Result:           result.Result,
			Subtype:          result.Subtype,
			NumTurns:         1,
			CostUsd:          0,
			Usage:            result.Usage,
			RuntimeSessionID: currentRuntimeSessionID(job),
			IsolationStatus:  job.IsolationStatus,
			ChangedFiles:     liveFiles,
			ChangedDiff:      livePatches,
			BaseSha:          liveBaseSha,
			WorktreeDirty:    worktreeIsDirty(job.WT),
			BranchSha:        effectiveBranchSha(job.WT),
			BranchMerged:     branchMergedInto(job.WT),
			WorktreeBranch:   currentBranch(job.WT),
		}, workerCtx); err != nil {
			logln("turn-complete failed for", job.SessionID+":", err)
		}
		finishCodexAppTurnFinalize(&activeMu, &active, a)
		clearInflight(snapshot.orbitTurnID)
		setTurn("")
	}

	sendInterrupt := func(codexTurnID string) {
		if codexTurnID == "" {
			return
		}
		asyncWg.Add(1)
		go func(turnID string) {
			defer asyncWg.Done()
			reqCtx, cancel := context.WithTimeout(workerCtx, 10*time.Second)
			defer cancel()
			if _, err := app.request(reqCtx, "turn/interrupt", map[string]interface{}{"threadId": threadID, "turnId": turnID}); err != nil {
				logln("codex turn/interrupt failed for", job.SessionID+":", err)
			}
		}(codexTurnID)
	}

	requestActiveInterrupt := func(finalizeBeforeStart bool) {
		codexTurnID, beforeStart := requestCodexAppInterrupt(&activeMu, &active)
		if beforeStart && finalizeBeforeStart {
			finalizeActive(codexTurnResult{Status: stInterrupted, Subtype: "interrupted"})
			return
		}
		sendInterrupt(codexTurnID)
	}

	recordCodexTurnID := func(orbitTurnID, codexTurnID string) {
		interruptID, acknowledgedOrbitID := markCodexAppTurnStarted(
			&activeMu, &active, orbitTurnID, codexTurnID,
		)
		if acknowledgedOrbitID != "" {
			emitFor(acknowledgedOrbitID, evUserDelivery, map[string]interface{}{
				"turnId": acknowledgedOrbitID, "delivery": string(deliveryAcknowledged),
			})
		}
		sendInterrupt(interruptID)
	}

	// Resolved from the env the app-server process was spawned with, so it tracks the same
	// CODEX_HOME the tool writes under (see codexGeneratedImagesDir).
	genImagesDir := codexGeneratedImagesDir(processEnv, execDir)

	asyncWg.Add(1)
	go func() {
		defer asyncWg.Done()
		// app-server reports token usage mid-turn (thread/tokenUsage/updated), but the figure
		// only leaves the runner on turn_end — report it to the clients' gauge as it moves.
		var ctxPing contextPinger
		for {
			select {
			case <-workerCtx.Done():
				return
			case <-app.done:
				return
			case msg := <-app.notifications:
				handleCodexAppNotification(threadID, msg, emit, &activeMu, &active, finalizeActive, func(codexTurnID string) {
					recordCodexTurnID("", codexTurnID)
				}, func(text string) string {
					return rewriteLocalMarkdownImages(workerCtx, t, job.SessionID, text, []string{execDir, upDir, genImagesDir})
				}, onRateLimits, steerDispatch.acknowledge)
				activeMu.Lock()
				tokens := 0
				if active != nil {
					tokens = active.result.ContextTokens
				}
				activeMu.Unlock()
				ctxPing.ping(emit, tokens, job)
			}
		}
	}()

	pollCtx, pollCancel := context.WithCancel(workerCtx)
	defer pollCancel()
	asyncWg.Add(1)
	go func() {
		defer asyncWg.Done()
		select {
		case <-app.done:
			pollCancel()
		case <-shutdownCtx.Done():
			pollCancel()
		case <-workerCtx.Done():
		}
	}()

	// Steers are delivered off the inbox loop, which has to stay free to take `interrupt` and
	// `end` — a stop button that waits out a delivery is a broken stop button — but through a
	// single worker, so they reach Codex in the order the inbox handed them out. Codex inserts
	// them in arrival order, so two deliveries racing would reorder what the user wrote.
	steerQueue := make(chan *RunInboxResponse, codexSteerQueueDepth)
	asyncWg.Add(1)
	go func() {
		defer asyncWg.Done()
		// Whatever is still queued when this generation ends is answered rather than dropped:
		// the control plane never re-delivers a steer, so an unanswered one is simply gone.
		defer func() {
			for {
				select {
				case resp := <-steerQueue:
					steerDispatch.refuse(resp, errCodexSteerEngineGone)
				default:
					return
				}
			}
		}()
		for {
			select {
			case <-workerCtx.Done():
				return
			case resp := <-steerQueue:
				steerDispatch.deliver(workerCtx, resp)
			}
		}
	}()

	startTurn := func(resp *RunInboxResponse, pendingShellCtx []string) {
		activeMu.Lock()
		if active != nil {
			activeMu.Unlock()
			emit(evError, map[string]interface{}{"message": "codex app-server already has an active turn"})
			clearInflight(resp.TurnID)
			setTurn("")
			return
		}
		active = &codexAppActiveTurn{
			orbitTurnID: resp.TurnID,
			result:      codexTurnResult{Status: stSucceeded, Subtype: "completed", RuntimeSessionID: threadID},
		}
		activeMu.Unlock()

		userEv := map[string]interface{}{"text": resp.Content}
		if refs := turnAttachmentRefs(resp.Attachments); len(refs) > 0 {
			userEv["attachments"] = refs
		}
		emit(evUser, userEv)

		respCopy := *resp
		shellCtx := append([]string(nil), pendingShellCtx...)
		asyncWg.Add(1)
		go func() {
			defer asyncWg.Done()
			prepared := prepareCodexTurn(workerCtx, t, job, &respCopy, shellCtx)
			if workerCtx.Err() != nil {
				return
			}

			ok, interrupted := beginCodexAppTurnStart(&activeMu, &active, respCopy.TurnID)
			if !ok {
				return
			}
			if interrupted {
				finalizeActive(codexTurnResult{Status: stInterrupted, Subtype: "interrupted"})
				return
			}

			codexTurnID, err := app.startTurn(workerCtx, threadID, job, execDir, upDir, respCopy.TurnID, prepared.Prompt, prepared.ImagePaths)
			if err != nil {
				// Cleanup cancellation is a resumable detach, not a failed turn. In
				// particular, never synthesize FAILED after a shutdown drain timeout.
				if workerCtx.Err() != nil {
					return
				}
				activeMu.Lock()
				same := active != nil && active.orbitTurnID == respCopy.TurnID
				interrupted := same && active.interruptRequested
				activeMu.Unlock()
				if !same {
					return
				}
				if interrupted {
					finalizeActive(codexTurnResult{Status: stInterrupted, Subtype: "interrupted"})
					return
				}
				emit(evError, map[string]interface{}{"message": "failed to start codex turn: " + err.Error()})
				finalizeActive(codexTurnResult{
					Status:  stFailed,
					Subtype: "turn_start_failed",
					Error:   err.Error(),
					Result:  err.Error(),
				})
				return
			}
			recordCodexTurnID(respCopy.TurnID, codexTurnID)
		}()
	}

	waitForIdle := func() {
		tk := time.NewTicker(150 * time.Millisecond)
		defer tk.Stop()
		deadline := time.After(shutdownDrainTimeout)
		for {
			activeMu.Lock()
			idle := active == nil
			activeMu.Unlock()
			if idle {
				return
			}
			select {
			case <-tk.C:
			case <-deadline:
				logln("codex app-server drain timeout for", job.SessionID)
				return
			case <-ctx.Done():
				return
			}
		}
	}

	var pendingShellCtx []string
	for {
		select {
		case <-ctx.Done():
			return stCancelled, true, false
		case <-shutdownCtx.Done():
			pollCancel()
			waitForIdle()
			return stCancelled, true, false
		case <-app.done:
			select {
			case <-shutdownCtx.Done():
				return stCancelled, true, false
			default:
				return stFailed, false, false
			}
		default:
		}

		resp, err := t.inbox(pollCtx, job.SessionID, leaseGeneration)
		if err != nil {
			if pollCtx.Err() != nil {
				continue
			}
			if isLeaseOwnershipError(err) {
				onLeaseLost(err)
				return stCancelled, true, false
			}
			logln("inbox poll failed for", job.SessionID+":", err)
			time.Sleep(time.Second)
			continue
		}
		if resp == nil {
			continue
		}
		// A warm timer/LRU eviction may cancel the engine while its inbox
		// long-poll response is in flight. Never feed a newly-claimed message to
		// the process generation that just lost that race.
		if pollCtx.Err() != nil || ctx.Err() != nil {
			return stCancelled, true, false
		}

		switch resp.Kind {
		case "message":
			if !waitTurnPermit(ctx) {
				return stCancelled, true, false
			}
			setTurn(resp.TurnID)
			inflightMu.Lock()
			dup := inflight[resp.TurnID]
			if !dup {
				inflight[resp.TurnID] = true
			}
			inflightMu.Unlock()
			if dup {
				continue
			}
			startTurn(resp, pendingShellCtx)
			pendingShellCtx = nil

		case "steer":
			// A message meant to join the turn already running. Codex takes one natively —
			// turn/steer writes it into the turn in progress, which produces no second turn and
			// no reply of its own (codex_steer.go). It consumes no turn permit and never moves
			// the session's turn cursor: the turn it joins owns both.
			select {
			case steerQueue <- resp:
			default:
				steerDispatch.refuse(resp, errCodexSteerBacklogged)
			}

		case "shell":
			if !waitTurnPermit(ctx) {
				return stCancelled, true, false
			}
			inflightMu.Lock()
			if inflight[resp.TurnID] {
				inflightMu.Unlock()
				continue
			}
			inflight[resp.TurnID] = true
			inflightMu.Unlock()
			setTurn(resp.TurnID)
			if shCmd, isBg := shellTurnBackgroundCommand(resp); isBg {
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
				req, shellErr := runSynchronousShellTurn(ctx, t, job, execDir, resp, emit)
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
			clearInflight(resp.TurnID)
			setTurn("")

		case "interrupt":
			emit(evInterrupt, map[string]interface{}{})
			requestActiveInterrupt(true)

		case "reload":
			applyRuntimeReload(job, resp.Content)
			if applyProviderEnv(job, resp) {
				// Model and effort are per-turn request params, but the endpoint and key are
				// this app-server process's environment. Hand the outer loop a re-spawn so the
				// next turn actually reaches the provider the session was just moved to; the
				// thread id is on the job, so it comes back on the same conversation.
				return stCancelled, false, true
			}
			emit(evSystem, map[string]interface{}{"subtype": "resumed", "reason": "config_changed", "runtime": "app-server"})

		case "diff":
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
			requestActiveInterrupt(false)
			// A turn/completed notification may already be flushing turn_end and
			// /turn-complete on the notification goroutine. Keep the app-server and
			// its ack context alive until that finalizer clears active.
			waitForIdle()
			return stSucceeded, true, false
		}
	}
}

func requestCodexAppInterrupt(activeMu *sync.Mutex, active **codexAppActiveTurn) (string, bool) {
	activeMu.Lock()
	defer activeMu.Unlock()
	if *active == nil {
		return "", false
	}
	if (*active).finishing {
		return "", false
	}
	(*active).interruptRequested = true
	if !(*active).startSent && (*active).codexTurnID == "" {
		return "", true
	}
	if (*active).codexTurnID == "" || (*active).interruptSent {
		return "", false
	}
	(*active).interruptSent = true
	return (*active).codexTurnID, false
}

func markCodexAppTurnStarted(activeMu *sync.Mutex, active **codexAppActiveTurn, orbitTurnID, codexTurnID string) (string, string) {
	if codexTurnID == "" {
		return "", ""
	}
	activeMu.Lock()
	defer activeMu.Unlock()
	if *active == nil || (*active).finishing {
		return "", ""
	}
	if orbitTurnID != "" && (*active).orbitTurnID != orbitTurnID {
		return "", ""
	}
	(*active).codexTurnID = codexTurnID
	acknowledgedOrbitID := ""
	if !(*active).runtimeAcknowledged {
		(*active).runtimeAcknowledged = true
		acknowledgedOrbitID = (*active).orbitTurnID
	}
	if !(*active).interruptRequested || (*active).interruptSent {
		return "", acknowledgedOrbitID
	}
	(*active).interruptSent = true
	return codexTurnID, acknowledgedOrbitID
}

func beginCodexAppTurnStart(activeMu *sync.Mutex, active **codexAppActiveTurn, orbitTurnID string) (bool, bool) {
	activeMu.Lock()
	defer activeMu.Unlock()
	if *active == nil || (*active).finishing || (*active).orbitTurnID != orbitTurnID {
		return false, false
	}
	if (*active).interruptRequested {
		return true, true
	}
	(*active).startSent = true
	return true, false
}

func turnAttachmentRefs(atts []TurnAttachment) []map[string]interface{} {
	if len(atts) == 0 {
		return nil
	}
	refs := make([]map[string]interface{}, 0, len(atts))
	for _, att := range atts {
		refs = append(refs, map[string]interface{}{"id": att.ID, "mime": att.MimeType, "name": att.FileName})
	}
	return refs
}

// codexStderrIsExpectedRefusal recognizes the internal log Codex writes when a tool call was
// refused. Answering "decline" is the approval bridge working, not a fault, but Codex reports it
// at ERROR level and the runner mirrors stderr into the transcript — so a user who had just
// pressed Deny was shown a red Rust panic-looking line for the outcome they chose. The refusal
// itself stays visible: the tool card now reads "Denied — the command did not run".
//
// Deliberately narrow. It matches only a rejection that names the user, so a genuine exec failure
// (permissions, missing binary, sandbox) still reaches the transcript intact.
func codexStderrIsExpectedRefusal(line string) bool {
	if !strings.Contains(line, "ERROR") {
		return false
	}
	lower := strings.ToLower(line)
	return strings.Contains(lower, "rejected by user") || strings.Contains(lower, "rejected(\\\"rejected by user")
}

// codexStderrIsStateInitFailure recognizes Codex refusing to bring up the SQLite state it keeps
// under `sqlite_home`, which it reports on stderr and then exits — leaving the runner holding
// nothing but its own "codex app-server closed" from the unanswered initialize.
//
// This is the start failure worth retrying: Codex opens that home per process, so a start racing
// another one can lose a directory that is in fact healthy. Keyed on Codex's own line so that
// configuration, permission and data damage keep failing on the first attempt.
func codexStderrIsStateInitFailure(line string) bool {
	return strings.Contains(strings.ToLower(line), "failed to initialize sqlite state runtime")
}

// codexApprovalPolicy is the `approvalPolicy` Codex is started with, derived from the session's
// permission mode. This is what makes an "ask me first" mode mean that on Codex too: `untrusted`
// auto-approves only known-safe read-only commands and asks about everything else, which Orbit
// then routes to the same approval card Claude and Kimi use.
//
// Auto maps to `on-request`, which Codex documents as "the model decides when to ask the user for
// approval" — that is what Auto is, so the mode means the same thing here as on Claude rather
// than being a Claude-only feature. Its requests reach the same card `untrusted` already uses.
//
// dontAsk deliberately stays on `never`. Orbit's Don't Ask is fail-closed ("deny anything not
// pre-approved"), but Codex is never handed an allowlist — so switching it to `untrusted` would
// deny every command in the mode agents default to, breaking task-launched runs wholesale. Codex
// therefore still does not enforce Don't Ask; the session payload says so (permissionSemantics)
// rather than the UI implying otherwise. Closing that gap needs an allowlist plumbed to Codex,
// which is a separate change.
func codexApprovalPolicy(permissionMode string) string {
	switch permissionMode {
	case "default", "acceptEdits", "plan":
		return "untrusted"
	case "auto":
		return "on-request"
	default:
		return "never"
	}
}

// codexAutomaticApproval applies the parts of a permission mode that need no human, mirroring
// kimiAutomaticPermissionOption. The second result reports whether the mode decided at all;
// otherwise the request goes to the user.
func codexAutomaticApproval(permissionMode string, request codexApprovalRequest) (allowed, decided bool) {
	// Codex asks for MCP tool-call consent on every call, including under the `never` policy the
	// non-asking modes run on. Decide those here: a card in a mode that promises not to interrupt
	// would be a new prompt, and the task runs that mode exists for would wait on a human forever.
	if request.mcpTool && codexApprovalPolicy(permissionMode) == "never" {
		return true, true
	}
	// Auto means the model decides when to ask — but Codex's MCP consent is not the model's
	// judgement, it fires on every MCP tool call regardless. Left to the card, Auto would raise a
	// prompt for each `task_list`, which is not the posture that mode describes. Orbit answers it
	// for the server Orbit itself registers and scopes to this owner; a third-party MCP server
	// still reaches the user, and the modes whose whole point is being consulted (default,
	// acceptEdits) still ask about every server.
	if request.mcpTool && permissionMode == "auto" && request.server == codexOrbitMCPServer {
		return true, true
	}
	switch permissionMode {
	case "plan":
		// Plan mode is read-only by definition: nothing it proposes may execute or edit.
		return false, true
	case "acceptEdits":
		if request.fileChange {
			return true, true
		}
	}
	return false, false
}

// bridgeCodexApproval answers one Codex approval request: the agent's own policy first, then a
// human via the same approval card the other runtimes use. Fails CLOSED on every error path —
// a control-plane outage must never auto-approve a command.
func bridgeCodexApproval(ctx context.Context, t *Transport, job *ClaimedSession, request codexApprovalRequest, params map[string]interface{}) bool {
	if ctx.Err() != nil || t == nil || job == nil {
		return false
	}
	if allowed, decided := codexAutomaticApproval(job.Agent.PermissionMode, request); decided {
		return allowed
	}
	input := map[string]interface{}{}
	if request.mcpTool {
		// The elicitation's own wording ("Allow the orbit MCP server to run tool …?") is what the
		// card should read; the rest of its params are transport detail.
		if message := firstString(params, "message"); message != "" {
			input["message"] = message
		}
		if meta := mapValue(params["_meta"]); meta != nil {
			if args, ok := meta["tool_params"]; ok {
				input["arguments"] = args
			}
		}
	}
	for _, key := range []string{"command", "cwd", "reason", "grantRoot"} {
		if value := firstString(params, key); value != "" {
			input[key] = value
		}
	}
	if len(input) == 0 {
		input["detail"] = params
	}
	approvalID, err := t.createApproval(ctx, job.SessionID, map[string]interface{}{
		"toolName":  request.toolName(),
		"input":     input,
		"toolUseId": firstString(params, "itemId", "item_id"),
	})
	if err != nil {
		return false
	}
	// Poll without a wall-clock cap, as the MCP and Kimi bridges do: an unanswered approval is a
	// human who has not looked yet, not a denial. Cancelling the session cancels ctx and unblocks.
	for {
		if ctx.Err() != nil {
			return false
		}
		decision, pollErr := t.pollApproval(ctx, job.SessionID, approvalID)
		if pollErr != nil {
			return false
		}
		if decision.Status == "PENDING" {
			continue
		}
		return decision.Status == "ALLOWED"
	}
}

// codexStateHandshakeRetries is how many further starts Codex gets after dying on its SQLite
// state. Two collided starters only need one to step back, so a couple of short retries covers
// the contention this exists for, while a state directory that is genuinely broken still fails
// in seconds instead of minutes.
const codexStateHandshakeRetries = 2

func shouldRetryCodexHandshake(attempt int, stateInitFailed bool, ctxErr error) bool {
	return stateInitFailed && ctxErr == nil && attempt < codexStateHandshakeRetries
}

// startReadyCodexAppServer returns an app-server that has completed its initialize handshake,
// holding the partition's handshake lock across the pair and retrying a start Codex lost to a
// concurrent one. Its errors carry the phase they failed in, because that is what the session
// transcript reports.
//
// spawn keeps the caller's context: the process outlives this call, so only the handshake runs
// on the bounded one. Every attempt shares that single budget rather than getting its own.
func startReadyCodexAppServer(ctx context.Context, state codexStateSelection, initTimeout time.Duration, spawn func() (*codexAppServer, error)) (*codexAppServer, error) {
	initCtx, cancelInit := context.WithTimeout(ctx, initTimeout)
	defer cancelInit()
	for attempt := 0; ; attempt++ {
		unlock := lockCodexStateHandshake(initCtx, state)
		app, err := spawn()
		if err != nil {
			unlock()
			return nil, fmt.Errorf("failed to spawn codex app-server: %w", err)
		}
		err = app.initialize(initCtx)
		unlock()
		if err == nil {
			return app, nil
		}
		// close() joins the stderr reader, so Codex's own account of the failure is complete
		// by the time the retry decision reads it.
		app.close()
		if !shouldRetryCodexHandshake(attempt, app.stateInitFailed.Load(), initCtx.Err()) {
			return nil, fmt.Errorf("failed to initialize codex app-server: %w", err)
		}
		logln("codex app-server lost its shared state handshake, retrying:", err)
		timer := time.NewTimer(codexStateRetryDelay)
		select {
		case <-initCtx.Done():
			timer.Stop()
			return nil, fmt.Errorf("failed to initialize codex app-server: %w", err)
		case <-timer.C:
		}
	}
}

func startCodexAppServer(ctx context.Context, job *ClaimedSession, execDir, stateDir string, processEnv []string, emit emitFn, approve codexApprovalFn) (*codexAppServer, error) {
	procCtx, cancel := context.WithCancel(ctx)
	exe, err := os.Executable()
	if err != nil {
		exe = ""
	}
	args := codexAppServerCommandArgs(job, stateDir, exe)
	cmd := exec.CommandContext(procCtx, "codex", args...)
	configureSessionProcessTree(cmd)
	cmd.Dir = execDir
	cmd.Env = processEnv
	cmd.Env = append(cmd.Env,
		"ORBIT_SESSION_ID="+publicID(job.SessionID),
		"ORBIT_AGENT_ID="+publicID(job.AgentID),
		"ORBIT_TASK_ID="+publicID(job.TaskID),
		"ORBIT_ALLOW_ORCHESTRATION="+orchestrationEnv(job.AllowOrchestration),
		envMCPPermissionPrompt+"=0",
	)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	app := &codexAppServer{
		cmd:             cmd,
		ctx:             procCtx,
		cancel:          cancel,
		stdin:           stdin,
		approve:         approve,
		emit:            emit,
		pending:         map[string]chan codexRPCMessage{},
		notifications:   make(chan codexRPCMessage, 256),
		done:            make(chan struct{}),
		orbitExecutable: orbitCLIExecutable(),
	}
	if err := startSessionProcess(cmd); err != nil {
		cancel()
		return nil, err
	}
	app.ioWg.Add(2)
	go func() {
		defer app.ioWg.Done()
		app.readLoop(stdout)
	}()
	go func() {
		defer app.ioWg.Done()
		s := bufio.NewScanner(stderr)
		s.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		for s.Scan() {
			line := stripANSI(s.Text())
			if codexStderrIsStateInitFailure(line) {
				app.stateInitFailed.Store(true)
			}
			if codexStderrIsExpectedRefusal(line) {
				continue
			}
			emit(evSystem, map[string]interface{}{"stderr": line + "\n"})
		}
	}()
	return app, nil
}

func codexAppServerCommandArgs(job *ClaimedSession, stateDir, exe string) []string {
	args := []string{"app-server", "--stdio", "-c", fmt.Sprintf("sqlite_home=%q", stateDir)}
	args = appendCodexOrbitMCPConfig(args, exe)
	return append(args, codexProviderArgs(job.Agent.Env)...)
}

func (a *codexAppServer) initialize(ctx context.Context) error {
	result, err := a.request(ctx, "initialize", map[string]interface{}{
		"clientInfo": map[string]interface{}{
			"name":    "orbit",
			"title":   "Orbit",
			"version": "0.1.0",
		},
		"capabilities": map[string]interface{}{"experimentalApi": true},
	})
	if err != nil {
		return err
	}
	a.setInstructionMode(codexInstructionModeForUserAgent(firstString(result, "userAgent")))
	return a.notify("initialized", map[string]interface{}{})
}

func (a *codexAppServer) startOrResumeThread(ctx context.Context, job *ClaimedSession, execDir, upDir string) (string, error) {
	params := codexThreadParams(job, execDir, upDir)
	method := "thread/start"
	if job.RuntimeSessionID != "" {
		method = "thread/resume"
		params["threadId"] = job.RuntimeSessionID
	}
	result, err := a.request(ctx, method, params)
	if err != nil {
		return "", err
	}
	if id := threadIDFromResult(result); id != "" {
		return id, nil
	}
	if job.RuntimeSessionID != "" {
		return job.RuntimeSessionID, nil
	}
	return "", fmt.Errorf("%s response did not include thread.id", method)
}

func (a *codexAppServer) startTurn(ctx context.Context, threadID string, job *ClaimedSession, execDir, upDir, orbitTurnID, prompt string, imagePaths []string) (string, error) {
	mode, generation := a.prepareInstructionContext(func() error {
		return a.injectAgentContext(ctx, threadID, job.Agent)
	})
	result, err := a.request(ctx, "turn/start", codexTurnParams(
		threadID, job, execDir, upDir, orbitTurnID, prompt, imagePaths,
		codexTurnContextOptions{
			Executable: a.orbitExecutable,
			Mode:       mode,
			Generation: generation,
		},
	))
	if err != nil {
		return "", err
	}
	return turnIDFromResult(result), nil
}

func (a *codexAppServer) injectAgentContext(ctx context.Context, threadID string, agent AgentExecConfig) error {
	items := codexInjectedAgentItems(agent, a.orbitExecutable)
	if len(items) == 0 {
		return nil
	}
	_, err := a.request(ctx, "thread/inject_items", map[string]interface{}{
		"threadId": threadID,
		"items":    items,
	})
	return err
}

func codexInjectedAgentItems(agent AgentExecConfig, executable string) []map[string]interface{} {
	context := withOrbitCLIInstructions(agent.AppendSystemPrompt, executable)
	if strings.TrimSpace(context) == "" {
		return nil
	}
	return []map[string]interface{}{
		{
			"type": "message",
			"role": "developer",
			"content": []map[string]interface{}{
				{"type": "input_text", "text": context},
			},
		},
	}
}

type codexTurnContextOptions struct {
	Executable string
	Mode       codexInstructionMode
	Generation uint64
}

func (a *codexAppServer) setInstructionMode(mode codexInstructionMode) {
	a.instructionMu.Lock()
	a.instructionMode = mode
	a.contextNeedsRefresh = false
	a.instructionMu.Unlock()
}

func (a *codexAppServer) currentInstructionMode() codexInstructionMode {
	a.instructionMu.Lock()
	defer a.instructionMu.Unlock()
	return a.instructionMode
}

func (a *codexAppServer) markInstructionContextForRefresh() bool {
	a.instructionMu.Lock()
	newlyInvalidated := !a.contextNeedsRefresh
	a.contextNeedsRefresh = true
	a.contextRefreshEpoch++
	a.instructionMu.Unlock()
	return newlyInvalidated
}

// prepareInstructionContext runs immediately before turn/start. Compaction
// notifications only mark state; refresh work is delayed until here so raw
// history is never injected while Codex still has an active turn.
func (a *codexAppServer) prepareInstructionContext(inject func() error) (codexInstructionMode, uint64) {
	a.instructionMu.Lock()
	mode := a.instructionMode
	needsRefresh := a.contextNeedsRefresh
	epoch := a.contextRefreshEpoch
	if mode == codexInstructionsAdditionalContext && needsRefresh {
		a.contextGeneration++
		a.contextNeedsRefresh = false
	} else if mode == codexInstructionsUserInput {
		// User-input fallback is included on every turn, so compaction requires no
		// special replay beyond the normal turn payload.
		a.contextNeedsRefresh = false
	}
	generation := a.contextGeneration
	a.instructionMu.Unlock()

	if mode != codexInstructionsInjectItems || !needsRefresh {
		return mode, generation
	}
	if err := inject(); err != nil {
		logln("codex instruction refresh failed; using user context:", err)
		a.setInstructionMode(codexInstructionsUserInput)
		return codexInstructionsUserInput, generation
	}
	a.instructionMu.Lock()
	if a.contextRefreshEpoch == epoch {
		a.contextNeedsRefresh = false
	}
	mode = a.instructionMode
	generation = a.contextGeneration
	a.instructionMu.Unlock()
	return mode, generation
}

func codexNotificationCompacted(msg codexRPCMessage) bool {
	if msg.Method == "thread/compacted" {
		return true
	}
	if msg.Method != "item/completed" {
		return false
	}
	params := rawObject(msg.Params)
	item := mapValue(firstPresent(params, "item"))
	kind := strings.ToLower(firstString(item, "type", "kind"))
	kind = strings.ReplaceAll(kind, "_", "")
	return kind == "contextcompaction"
}

func codexInstructionModeForUserAgent(userAgent string) codexInstructionMode {
	fields := strings.Fields(userAgent)
	if len(fields) == 0 {
		return codexInstructionsUserInput
	}
	slash := strings.IndexByte(fields[0], '/')
	if slash < 0 || slash == len(fields[0])-1 {
		return codexInstructionsUserInput
	}
	parts := strings.Split(fields[0][slash+1:], ".")
	if len(parts) < 2 {
		return codexInstructionsUserInput
	}
	major, err := strconv.Atoi(parts[0])
	if err != nil {
		return codexInstructionsUserInput
	}
	minor, err := strconv.Atoi(parts[1])
	if err != nil {
		return codexInstructionsUserInput
	}
	if major > 0 || major == 0 && minor >= 135 {
		return codexInstructionsAdditionalContext
	}
	if major == 0 && minor >= 125 {
		return codexInstructionsInjectItems
	}
	return codexInstructionsUserInput
}

func splitUTF8ByBytes(value string, maxBytes int) []string {
	if value == "" || maxBytes <= 0 {
		return nil
	}
	parts := []string{}
	for len(value) > maxBytes {
		end := maxBytes
		for end > 0 && !utf8.RuneStart(value[end]) {
			end--
		}
		if end == 0 {
			end = maxBytes
		}
		parts = append(parts, value[:end])
		value = value[end:]
	}
	if value != "" {
		parts = append(parts, value)
	}
	return parts
}

func codexAgentAdditionalContext(agent AgentExecConfig, executable string, generation uint64) map[string]interface{} {
	context := map[string]interface{}{}
	prefix := fmt.Sprintf("orbit_%08d_", generation)
	if instruction := orbitCLIInstructions(executable); instruction != "" {
		context[prefix+"cli"] = map[string]interface{}{
			"kind":  "application",
			"value": instruction,
		}
	}
	// Codex caps each application-context value at 1,000 tokens. A UTF-8 byte
	// budget is conservative because a token cannot encode less than one byte.
	for i, part := range splitUTF8ByBytes(agent.AppendSystemPrompt, 900) {
		context[fmt.Sprintf("%sagent_append_%08d", prefix, i)] = map[string]interface{}{
			"kind":  "application",
			"value": part,
		}
	}
	return context
}

func codexLegacyAgentContext(agent AgentExecConfig, executable string) string {
	context := withOrbitCLIInstructions(agent.AppendSystemPrompt, executable)
	if strings.TrimSpace(context) == "" {
		return ""
	}
	return "<orbit_application_context>\n" + context + "\n</orbit_application_context>"
}

func codexTurnParams(threadID string, job *ClaimedSession, execDir, upDir, orbitTurnID, prompt string, imagePaths []string, contextOptions codexTurnContextOptions) map[string]interface{} {
	input := []map[string]interface{}{}
	if contextOptions.Mode == codexInstructionsUserInput {
		if context := codexLegacyAgentContext(job.Agent, contextOptions.Executable); context != "" {
			input = append(input, map[string]interface{}{"type": "text", "text": context})
		}
	}
	if strings.TrimSpace(prompt) != "" || len(imagePaths) == 0 {
		input = append(input, map[string]interface{}{"type": "text", "text": prompt})
	}
	for _, p := range imagePaths {
		input = append(input, map[string]interface{}{"type": "localImage", "path": p})
	}
	params := map[string]interface{}{
		"threadId":            threadID,
		"clientUserMessageId": orbitTurnID,
		"input":               input,
		"cwd":                 execDir,
		"approvalPolicy":      codexApprovalPolicy(job.Agent.PermissionMode),
		"runtimeWorkspaceRoots": []string{
			execDir,
			upDir,
		},
		// danger-full-access mirrors the Claude path, which runs unsandboxed in execDir.
		// approvalPolicy is already "never" (Orbit fully trusts the agent), so codex's
		// sandbox is the only thing left restricting it — and workspace-write (network off,
		// writableRoots limited to the uploads dir) breaks git: fetch has no network, and a
		// worktree session's real .git lives outside the workspace so FETCH_HEAD writes get
		// denied. Full access removes that asymmetry with Claude.
		"sandboxPolicy": map[string]interface{}{"type": "dangerFullAccess"},
	}
	if contextOptions.Mode == codexInstructionsAdditionalContext {
		if additional := codexAgentAdditionalContext(job.Agent, contextOptions.Executable, contextOptions.Generation); len(additional) > 0 {
			// Application context becomes developer-role fragments without replacing
			// local/project developer_instructions. Keys stay stable across ordinary
			// turns and advance a generation after history compaction so the context
			// is restored when Codex has discarded prior developer messages.
			params["additionalContext"] = additional
		}
	}
	if job.Agent.Model != "" {
		params["model"] = job.Agent.Model
	}
	if effort := normalizeCodexReasoningEffort(job.Agent.Effort); effort != "" {
		params["effort"] = effort
	}
	return params
}

func codexThreadParams(job *ClaimedSession, execDir, upDir string) map[string]interface{} {
	params := map[string]interface{}{
		"cwd":            execDir,
		"approvalPolicy": codexApprovalPolicy(job.Agent.PermissionMode),
		"sandbox":        "danger-full-access", // see codexTurnParams: parity with unsandboxed Claude
		"runtimeWorkspaceRoots": []string{
			execDir,
			upDir,
		},
		"threadSource": "orbit",
	}
	if job.Agent.Model != "" {
		params["model"] = job.Agent.Model
	}
	if job.Agent.SystemPrompt != "" {
		params["baseInstructions"] = job.Agent.SystemPrompt
	}
	return params
}

func (a *codexAppServer) request(ctx context.Context, method string, params map[string]interface{}) (map[string]interface{}, error) {
	id := a.nextRequestID()
	ch := make(chan codexRPCMessage, 1)
	a.mu.Lock()
	a.pending[id] = ch
	a.mu.Unlock()
	if err := a.write(map[string]interface{}{"id": id, "method": method, "params": params}); err != nil {
		a.forget(id)
		return nil, err
	}
	select {
	case msg, ok := <-ch:
		if !ok {
			return nil, a.closedError()
		}
		if msg.Error != nil {
			return nil, fmt.Errorf("%s: %s", method, msg.Error.Message)
		}
		return rawObject(msg.Result), nil
	case <-ctx.Done():
		a.forget(id)
		return nil, ctx.Err()
	case <-a.done:
		a.forget(id)
		return nil, a.closedError()
	}
}

func (a *codexAppServer) closedError() error {
	a.mu.Lock()
	err := a.stdoutErr
	a.mu.Unlock()
	if err != nil {
		return fmt.Errorf("codex app-server stdout: %w", err)
	}
	return fmt.Errorf("codex app-server closed")
}

func (a *codexAppServer) recordStdoutError(err error) {
	if err == nil || errors.Is(err, io.EOF) {
		return
	}
	a.mu.Lock()
	if a.stdoutErr == nil {
		a.stdoutErr = err
	}
	a.mu.Unlock()
}

func (a *codexAppServer) notify(method string, params map[string]interface{}) error {
	return a.write(map[string]interface{}{"method": method, "params": params})
}

func (a *codexAppServer) nextRequestID() string {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.nextID++
	return fmt.Sprintf("orbit-%d", a.nextID)
}

func (a *codexAppServer) forget(id string) {
	a.mu.Lock()
	delete(a.pending, id)
	a.mu.Unlock()
}

func (a *codexAppServer) write(msg map[string]interface{}) error {
	b, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	a.writeMu.Lock()
	defer a.writeMu.Unlock()
	if _, err := a.stdin.Write(append(b, '\n')); err != nil {
		return err
	}
	return nil
}

func (a *codexAppServer) readLoop(r io.Reader) {
	var readErr error
	defer func() {
		a.recordStdoutError(readErr)
		a.closeDone()
	}()

	// App-server speaks one JSON-RPC message per line. Responses can include an
	// entire resumed thread and legitimately exceed Scanner's fixed token limit, so
	// use a dynamically growing line reader instead of imposing a framing ceiling.
	rd := bufio.NewReaderSize(r, 64*1024)
	for {
		line, err := rd.ReadBytes('\n')
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			if err != nil {
				readErr = err
				return
			}
			continue
		}
		var msg codexRPCMessage
		if json.Unmarshal(line, &msg) == nil {
			if msg.Method != "" && msg.ID != nil {
				a.handleServerRequest(msg)
			} else if msg.ID != nil {
				a.deliverResponse(msg)
			} else if msg.Method != "" {
				// Never lose this state transition even if the high-volume notification
				// channel is full; the next turn must restore compacted instructions. The
				// durable system event is the control plane's matching boundary for sparse
				// project-coordinator context, emitted only once when two protocol shapes
				// describe the same compaction before another turn starts.
				if codexNotificationCompacted(msg) {
					if a.markInstructionContextForRefresh() && a.emit != nil {
						a.emit(evSystem, map[string]interface{}{"subtype": "context_compacted"})
					}
				}
				select {
				case a.notifications <- msg:
				default:
					logln("codex app-server notification dropped:", msg.Method)
				}
			}
		}
		if err != nil {
			readErr = err
			return
		}
	}
}

func (a *codexAppServer) deliverResponse(msg codexRPCMessage) {
	id := rpcIDKey(msg.ID)
	a.mu.Lock()
	ch := a.pending[id]
	delete(a.pending, id)
	a.mu.Unlock()
	if ch != nil {
		ch <- msg
		close(ch)
	}
}

// codexMCPElicitationMethod is how Codex forwards an MCP server's `elicitation/create`. Codex
// asks for its own MCP tool-call consent through it — see isCodexMCPToolConsent.
const codexMCPElicitationMethod = "mcpServer/elicitation/request"

// codexApprovalRequest classifies an inbound approval so the answer uses the vocabulary that
// request family expects. Codex ships three: the v2 thread protocol
// (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`) answers with
// accept/decline, the older exec/apply-patch requests answer with approved/denied, and MCP
// tool-call consent answers with an elicitation result (see codexElicitationResult).
type codexApprovalRequest struct {
	fileChange bool
	legacy     bool
	mcpTool    bool
	// server is the MCP server behind an mcpTool request, for the card's name.
	server string
}

func classifyCodexApproval(method string) (codexApprovalRequest, bool) {
	lower := strings.ToLower(method)
	switch {
	case strings.Contains(lower, "commandexecution"):
		return codexApprovalRequest{}, true
	case strings.Contains(lower, "filechange"):
		return codexApprovalRequest{fileChange: true}, true
	case strings.Contains(lower, "execcommand"):
		return codexApprovalRequest{legacy: true}, true
	case strings.Contains(lower, "applypatch"):
		return codexApprovalRequest{fileChange: true, legacy: true}, true
	}
	return codexApprovalRequest{}, false
}

func (r codexApprovalRequest) decision(allowed bool) string {
	if r.legacy {
		if allowed {
			return "approved"
		}
		return "denied"
	}
	if allowed {
		return "accept"
	}
	return "decline"
}

// toolName mirrors what codexEmitItem already calls these in the transcript, so an approval card
// and the tool card it authorizes name the same thing. MCP consent names the server rather than
// the tool, which is all the elicitation carries — its message names the tool.
func (r codexApprovalRequest) toolName() string {
	switch {
	case r.mcpTool && r.server != "":
		return "mcp__" + r.server
	case r.mcpTool:
		return "mcp"
	case r.fileChange:
		return "apply_patch"
	}
	return "Bash"
}

// isCodexMCPToolConsent reports whether an elicitation is Codex's own "Allow the X MCP server to
// run tool Y?" prompt: a form whose requested schema is empty because the only answer wanted is
// accept or decline. Codex raises it for every MCP tool call whatever the turn's approvalPolicy
// is, so this is the one elicitation Orbit can answer with the approval card it already has.
func isCodexMCPToolConsent(params map[string]interface{}) bool {
	return firstString(mapValue(params["_meta"]), "codex_approval_kind") == "mcp_tool_call"
}

// codexElicitationResult is the McpServerElicitationRequestResponse Codex expects. An accepted
// consent form answers with an empty object because its schema asked for no fields; content is
// null only for decline.
func codexElicitationResult(allowed bool) map[string]interface{} {
	if allowed {
		return map[string]interface{}{"action": "accept", "content": map[string]interface{}{}}
	}
	return map[string]interface{}{"action": "decline", "content": nil}
}

// answerElicitation replies to an MCP elicitation. Tool-call consent goes to the same approval
// card commands use; anything else — a real input form, or a URL the server wants opened — has no
// card that can collect it and is declined. Both beat the JSON-RPC error this used to return,
// which failed the tool call outright.
func (a *codexAppServer) answerElicitation(msg codexRPCMessage) {
	params := rawObject(msg.Params)
	if !isCodexMCPToolConsent(params) {
		logln("codex elicitation declined; Orbit cannot render", firstString(params, "mode"), "elicitations")
		_ = a.write(map[string]interface{}{"id": msg.ID, "result": codexElicitationResult(false)})
		return
	}
	request := codexApprovalRequest{mcpTool: true, server: firstString(params, "serverName")}
	// Same reason approvals answer on a goroutine: this runs inline on the only reader of codex's
	// stdout, and the card blocks on a human.
	go func() {
		allowed := false
		if a.approve != nil {
			allowed = a.approve(a.ctx, request, params)
		}
		_ = a.write(map[string]interface{}{"id": msg.ID, "result": codexElicitationResult(allowed)})
	}()
}

func (a *codexAppServer) handleServerRequest(msg codexRPCMessage) {
	if msg.Method == codexMCPElicitationMethod {
		a.answerElicitation(msg)
		return
	}
	request, isApproval := classifyCodexApproval(msg.Method)
	if !isApproval {
		_ = a.write(map[string]interface{}{
			"id": msg.ID,
			"error": map[string]interface{}{
				"code":    -32601,
				"message": "Orbit runner does not implement app-server request " + msg.Method,
			},
		})
		return
	}
	// Answer on a goroutine: readLoop calls this inline, and an approval blocks on a human who
	// may take minutes. Blocking here would stall the only reader of codex's stdout — no
	// notifications, no responses to our own requests, a wedged session. write() is mutex-guarded.
	go func() {
		allowed := false
		if a.approve != nil {
			allowed = a.approve(a.ctx, request, rawObject(msg.Params))
		}
		_ = a.write(map[string]interface{}{
			"id":     msg.ID,
			"result": map[string]interface{}{"decision": request.decision(allowed)},
		})
	}()
}

func (a *codexAppServer) closeDone() {
	a.doneOnce.Do(func() {
		close(a.done)
		a.mu.Lock()
		for id, ch := range a.pending {
			delete(a.pending, id)
			close(ch)
		}
		a.mu.Unlock()
	})
}

func (a *codexAppServer) close() {
	a.cancel()
	_ = a.stdin.Close()
	_ = waitSessionProcessTree(a.cmd)
	// Join both raw pipe readers here. The owning provider then joins the
	// notification/start workers they feed before it reaches the final flush.
	a.ioWg.Wait()
	a.closeDone()
}

// codexNotificationThreadID returns the thread a notification belongs to. App-server uses one
// connection for the root thread and every Codex sub-agent it spawns, so treating the stream as a
// single thread lets a child's item/turn events leak into the parent transcript. In particular, a
// child turn/completed used to finalize the active Orbit turn while the root Codex turn was still
// working, exposing AWAITING_INPUT and Commit over a live worktree.
func codexNotificationThreadID(msg codexRPCMessage) string {
	params := rawObject(msg.Params)
	if id := firstString(params, "threadId", "thread_id"); id != "" {
		return id
	}
	if msg.Method == "thread/started" {
		return nestedString(params, "thread", "id")
	}
	return ""
}

// onSteerAck is called with the Orbit turn id of a mid-turn message Codex has just echoed back,
// which is that message's only answer — it has no result of its own (codex_steer.go).
func handleCodexAppNotification(threadID string, msg codexRPCMessage, emit emitFn, activeMu *sync.Mutex, active **codexAppActiveTurn, finalize func(codexTurnResult), onTurnStarted func(string), processAssistant assistantTextProcessor, onRateLimits func(map[string]interface{}), onSteerAck func(string)) {
	// Empty is accepted for compatibility with older app-server notifications that were not
	// thread-scoped. Current turn/item notifications always carry threadId; when present it is
	// authoritative and child-thread activity must stay out of the Orbit root session.
	if notificationThreadID := codexNotificationThreadID(msg); threadID != "" && notificationThreadID != "" && notificationThreadID != threadID {
		return
	}
	params := rawObject(msg.Params)
	switch msg.Method {
	case "account/rateLimits/updated":
		if snapshot := mapValue(firstPresent(params, "rateLimits", "rate_limits")); snapshot != nil && onRateLimits != nil {
			onRateLimits(snapshot)
		}
	case "thread/started":
		if threadID := nestedString(params, "thread", "id"); threadID != "" {
			emit(evSystem, map[string]interface{}{"subtype": "resumed", "sessionId": threadID, "provider": providerCodex, "runtime": "app-server"})
		}
	case "turn/started":
		turnID := nestedString(params, "turn", "id")
		if turnID != "" {
			if onTurnStarted != nil {
				onTurnStarted(turnID)
			} else {
				activeMu.Lock()
				if *active != nil {
					(*active).codexTurnID = turnID
				}
				activeMu.Unlock()
			}
		}
	case "item/agentMessage/delta":
		if delta := firstString(params, "delta"); delta != "" {
			emit(evTextDelta, map[string]interface{}{"text": delta})
			activeMu.Lock()
			if *active != nil {
				(*active).deltaText.WriteString(delta)
			}
			activeMu.Unlock()
		}
	case "item/reasoning/textDelta", "item/reasoning/summaryTextDelta":
		// Streaming increment: animate it live via thinking_delta (ephemeral, not
		// persisted) and accumulate it — the completed reasoning item carries no
		// text of its own, so the durable `thinking` event is flushed from here.
		if delta := firstString(params, "delta"); delta != "" {
			emit(evThinkingDelta, map[string]interface{}{"text": delta})
			activeMu.Lock()
			if *active != nil {
				(*active).thinkText.WriteString(delta)
			}
			activeMu.Unlock()
		}
	case "item/started":
		item := mapValue(firstPresent(params, "item"))
		activeMu.Lock()
		if *active != nil {
			handleCodexItem(map[string]interface{}{"item": item}, emit, &(*active).result, &(*active).fullText, false, processAssistant)
		}
		activeMu.Unlock()
		reportCodexSteerEcho(activeMu, active, item, onSteerAck)
	case "item/completed":
		item := mapValue(firstPresent(params, "item"))
		// item/started and item/completed carry the same item id. Acknowledgement is
		// single-flight, and the steer record remembers that id so this normal lifecycle pair is
		// distinct from two actual items carrying one clientUserMessageId.
		reportCodexSteerEcho(activeMu, active, item, onSteerAck)
		activeMu.Lock()
		if *active != nil {
			if strings.Contains(strings.ToLower(firstString(item, "type", "kind")), "reasoning") {
				// Flush the streamed reasoning as ONE durable thinking event so it
				// survives turn end / reload, instead of a persisted row per delta.
				text := strings.TrimSpace((*active).thinkText.String())
				(*active).thinkText.Reset()
				if text == "" {
					text = codexText(item)
				}
				if text != "" {
					emit(evThinking, map[string]interface{}{"text": text})
				}
			} else {
				handleCodexItem(map[string]interface{}{"item": item}, emit, &(*active).result, &(*active).fullText, true, processAssistant)
			}
		}
		activeMu.Unlock()
	case "error":
		errMsg := nestedString(params, "error", "message")
		if errMsg == "" {
			errMsg = "codex app-server error"
		}
		errMsg = asAuthError(errMsg)
		emit(evError, map[string]interface{}{"message": errMsg})
		activeMu.Lock()
		if *active != nil {
			(*active).result.Status = stFailed
			(*active).result.Subtype = "error"
			(*active).result.Error = errMsg
		}
		activeMu.Unlock()
	case "thread/tokenUsage/updated":
		turnID := firstString(params, "turnId", "turn_id")
		tokenUsage := firstPresent(params, "tokenUsage", "token_usage")
		activeMu.Lock()
		if *active != nil && ((*active).codexTurnID == "" || turnID == "" || (*active).codexTurnID == turnID) {
			if contextTokens := codexThreadContextTokens(tokenUsage); contextTokens > 0 {
				(*active).result.ContextTokens = contextTokens
			}
			if usage := codexThreadLastUsage(tokenUsage); usage != nil {
				(*active).result.Usage = usage
			}
		}
		activeMu.Unlock()
	case "turn/completed":
		turn := mapValue(params["turn"])
		// A delayed completion from an older turn on the same resumed thread must not finish the
		// current Orbit turn. Normally app-server serializes turns, but this guard also makes retry
		// and reconnect ordering harmless. An empty id remains accepted for older protocol builds.
		completedTurnID := firstString(turn, "id")
		activeMu.Lock()
		matchesActive := *active != nil && (completedTurnID == "" || (*active).codexTurnID == "" || (*active).codexTurnID == completedTurnID)
		activeMu.Unlock()
		if !matchesActive {
			return
		}
		status := strings.ToLower(firstString(turn, "status"))
		errMsg := nestedString(turn, "error", "message")
		result := codexTurnResult{RuntimeSessionID: firstString(params, "threadId")}
		switch status {
		case "failed":
			result.Status = stFailed
			result.Subtype = "failed"
			result.Error = errMsg
		case "interrupted":
			result.Status = stInterrupted
			result.Subtype = "interrupted"
		default:
			result.Status = stSucceeded
			result.Subtype = "completed"
		}
		if usage := codexUsage(firstPresent(params, "usage")); usage != nil {
			result.Usage = usage
		} else if usage := codexUsage(firstPresent(turn, "usage")); usage != nil {
			result.Usage = usage
		}
		finalize(result)
	}
}

func rawObject(raw json.RawMessage) map[string]interface{} {
	if len(raw) == 0 {
		return map[string]interface{}{}
	}
	var m map[string]interface{}
	if json.Unmarshal(raw, &m) != nil || m == nil {
		return map[string]interface{}{}
	}
	return m
}

func rpcIDKey(id interface{}) string {
	switch v := id.(type) {
	case string:
		return v
	default:
		return fmt.Sprintf("%v", v)
	}
}

func threadIDFromResult(result map[string]interface{}) string {
	return nestedString(result, "thread", "id")
}

func turnIDFromResult(result map[string]interface{}) string {
	return nestedString(result, "turn", "id")
}

func nestedString(m map[string]interface{}, path ...string) string {
	cur := m
	for i, p := range path {
		if i == len(path)-1 {
			return asString(cur[p])
		}
		next := mapValue(cur[p])
		if next == nil {
			return ""
		}
		cur = next
	}
	return ""
}
