package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

const (
	heartbeatInterval                   = 30 * time.Second
	selfUpdateCheckInterval             = 10 * time.Minute
	runtimeDefaultRefreshHeartbeatTicks = 10 // ~5 minutes
	// Refreshed once at startup and daily after that. Each pass spawns one `claude -p
	// "/model <alias>"` per tier alias, so an hourly cadence was launching the engine
	// four times an hour purely to re-read a list that changes on CLI releases.
	modelCatalogRefreshHeartbeatTicks = 2880 // ~24 hours
)

// On shutdown the runner stops claiming, signals each session to drain, and waits up
// to this long for in-flight turns to finish + ack before exiting. Idle sessions detach
// immediately; only a mid-turn session consumes any of this budget. Keep systemd's
// TimeoutStopSec comfortably above it (see service.go) so we exit before any SIGKILL.
const shutdownDrainTimeout = 100 * time.Second

type runLoopStopReason uint8

const (
	runLoopStopNone runLoopStopReason = iota
	runLoopStopSignal
	runLoopStopUpdate
)

type selfUpdateChecker func(context.Context, string) (string, bool)

// waitForRunLoopStop owns the two reasons a healthy runner deliberately leaves
// its claim loop. It is kept independent of the rest of runLoop so update timing
// and signal precedence can be exercised without starting sessions or heartbeats.
func waitForRunLoopStop(ctx context.Context, signals <-chan os.Signal, server string, interval time.Duration, check selfUpdateChecker) (runLoopStopReason, string) {
	var ticker *time.Ticker
	var ticks <-chan time.Time
	if check != nil {
		ticker = time.NewTicker(interval)
		ticks = ticker.C
		defer ticker.Stop()
	}
	for {
		select {
		case <-ctx.Done():
			return runLoopStopNone, ""
		case <-signals:
			return runLoopStopSignal, ""
		case <-ticks:
			if remote, ok := check(ctx, server); ok {
				// The manifest request may have overlapped an operator/service stop.
				// Prefer that explicit signal to an automatic restart when both are
				// ready, rather than turning SIGTERM into an update by select lottery.
				select {
				case <-signals:
					return runLoopStopSignal, ""
				default:
				}
				return runLoopStopUpdate, remote
			}
		}
	}
}

// restartForUpdate gives a stop signal received during session drain the final
// say. signal.Stop is called before this in runLoop, so an empty channel is a
// stable result rather than a race with a later signal delivery.
func restartForUpdate(updateRequested, drainTimedOut bool, signals <-chan os.Signal) bool {
	if !updateRequested || drainTimedOut {
		return false
	}
	select {
	case <-signals:
		return false
	default:
		return true
	}
}

// carryOverModelCatalog keeps a provider's last good model list when this round's refresh produced
// nothing for it. The heartbeat replaces the server's stored catalog wholesale, so a half-failed
// round — `codex debug models` erroring mid-`codex update`, one CLI briefly off PATH — would
// otherwise blank the other provider until the next hourly refresh. The clients read Codex context
// windows from this catalog and nowhere else, so a blanked list is a visibly wrong context gauge.
func carryOverModelCatalog(prev, next *ModelCatalog) *ModelCatalog {
	if prev == nil || next == nil {
		return next
	}
	if len(next.Codex) == 0 {
		next.Codex = prev.Codex
	}
	if len(next.Claude) == 0 {
		next.Claude = prev.Claude
	}
	if len(next.Kimi) == 0 {
		next.Kimi = prev.Kimi
	}
	if len(next.OpenCode) == 0 {
		next.OpenCode = prev.OpenCode
	}
	return next
}

// Older servers omitted status and reclaimed RUNNING sessions only. Newer
// servers return every open session so its checkout remains protected across a
// runner restart; only an explicitly RUNNING session owns an active-turn permit.
func reclaimInitiallyActive(status string) bool {
	return status == "" || status == stRunning
}

// reclaimStatusOpen is a second, runner-side terminal fence. Current servers
// reject takeover for terminal rows, but an older server may return a status from
// the row lock; never build a worktree/supervisor for one of those rows.
func reclaimStatusOpen(status string) bool {
	switch status {
	case "", stPending, stRunning, stAwaitingInput, stInterrupted:
		return true
	default:
		return false
	}
}

func claimedSessionFromReclaim(r ReclaimSession) *ClaimedSession {
	agent := r.Agent
	if agent.Provider == "" {
		agent.Provider = r.Provider
	}
	return &ClaimedSession{
		SessionID:          r.SessionID,
		Title:              r.Title,
		Provider:           r.Provider,
		Agent:              agent,
		WorkDir:            r.WorkDir,
		Branch:             r.Branch,
		AutoInitGit:        r.AutoInitGit,
		MergeTarget:        r.MergeTarget,
		AgentID:            r.AgentID,
		TaskID:             r.TaskID,
		AllowOrchestration: r.AllowOrchestration,
		OrchestrationToken: r.OrchestrationToken,
		Reclaimed:          true,
		SessionUUID:        r.SessionUUID,
		RuntimeSessionID:   r.RuntimeSessionID,
		LeaseOwner:         r.LeaseOwner,
		MaxSeq:             r.MaxSeq,
	}
}

type reclaimedStart struct {
	job             *ClaimedSession
	initiallyActive bool
}

// takeoverConflictLimit caps how many snapshot refreshes one session's takeover
// conflict may force before that session is set aside for the current reclaim. A
// snapshot-owner race resolves within a round or two; a row the server keeps
// fail-closing (e.g. a fenced worktree operation left behind by a dead process)
// would otherwise retry-loop this function forever — silently, since the claim
// loop never starts — starving every queued session on the machine.
const takeoverConflictLimit = 5

// A reclaim that set sessions aside leaves them unsupervised on the server (their
// rows stay RUNNING/PENDING with no local process). Retry on this cadence until
// the conflict clears — e.g. the server fails the abandoned operation over.
const reclaimRetryInterval = 45 * time.Second

// reclaimMissingSessions repairs both startup state and an ambiguous claim
// response (the server may have committed PENDING -> RUNNING before the HTTP
// response was lost). Every process takes rows over in stable session-id order,
// and no supervisor starts until the whole snapshot's CAS operations succeed.
// The bool result reports that at least one conflicted session was set aside;
// the caller must schedule another reclaim so it does not stay unsupervised.
func reclaimMissingSessions(
	ctx context.Context,
	t *Transport,
	knownStates func() map[string]bool,
	prepareTakeover func(*ClaimedSession) error,
) ([]reclaimedStart, bool, error) {
	delay := 250 * time.Millisecond
	conflicts := map[string]int{}
	for ctx.Err() == nil {
		rec, err := t.reclaim(ctx)
		if err != nil {
			if !isRetryableTransportError(err) {
				return nil, false, err
			}
			select {
			case <-ctx.Done():
				return nil, false, ctx.Err()
			case <-time.After(delay):
			}
			if delay < 5*time.Second {
				delay *= 2
			}
			continue
		}

		sessions := append([]ReclaimSession(nil), rec.Sessions...)
		sort.SliceStable(sessions, func(i, j int) bool {
			return sessions[i].SessionID < sessions[j].SessionID
		})
		localStates := knownStates()
		pending := make([]reclaimedStart, 0, len(sessions))
		retrySnapshot := false
		skippedAny := false
		lastID := ""
		for i := range sessions {
			r := sessions[i]
			if r.SessionID == "" || r.SessionID == lastID {
				continue
			}
			lastID = r.SessionID
			if conflicts[r.SessionID] >= takeoverConflictLimit {
				skippedAny = true
				continue
			}
			knownActive, locallyKnown := localStates[r.SessionID]
			// A rotated owner marks a fresh terminal-revive epoch. Even if the old
			// local supervisor still looks active, it cannot represent this RUNNING
			// claim and must be drained before takeover.
			ownerChanged := !strings.EqualFold(r.LeaseOwner, t.leaseOwner)
			if knownActive && !ownerChanged {
				continue
			}
			// Only a RUNNING (or legacy RUNNING-only) reclaim can represent a
			// response-lost follow-up for an existing warm/cold supervisor.
			// Do not steal an idle local supervisor back from a newer process.
			if locallyKnown && !reclaimInitiallyActive(r.Status) {
				continue
			}
			job := claimedSessionFromReclaim(r)
			if prepareTakeover != nil {
				if prepareErr := prepareTakeover(job); prepareErr != nil {
					return nil, false, prepareErr
				}
			}
			status, takeoverErr := takeoverClaimedSession(ctx, t, job)
			if takeoverErr != nil {
				// 409 means another process advanced the snapshot owner or the server
				// is fail-closing the row (e.g. a fenced worktree operation); 403 means
				// the assignment changed after reclaim. Refresh the whole ordered set —
				// a bounded number of times per session, so one persistently rejected
				// row cannot livelock this loop and starve the claim loop.
				if isTransportHTTPStatus(takeoverErr, 409) || isTransportHTTPStatus(takeoverErr, 403) {
					conflicts[r.SessionID]++
					if conflicts[r.SessionID] >= takeoverConflictLimit {
						logln(fmt.Sprintf("reclaim: setting session %s aside after %d takeover conflicts (last: %v); retrying on a later reclaim",
							r.SessionID, conflicts[r.SessionID], takeoverErr))
						skippedAny = true
						continue
					}
					logln(fmt.Sprintf("reclaim: takeover conflict for %s: %v; refreshing snapshot", r.SessionID, takeoverErr))
					retrySnapshot = true
					break
				}
				return nil, false, takeoverErr
			}
			if !reclaimStatusOpen(status) {
				continue
			}
			if locallyKnown && !reclaimInitiallyActive(status) {
				continue
			}
			pending = append(pending, reclaimedStart{
				job:             job,
				initiallyActive: reclaimInitiallyActive(status),
			})
		}
		if !retrySnapshot {
			return pending, skippedAny, nil
		}
		select {
		case <-ctx.Done():
			return nil, false, ctx.Err()
		case <-time.After(delay):
		}
		if delay < 5*time.Second {
			delay *= 2
		}
	}
	return nil, false, ctx.Err()
}

// A terminal revive rotates the Session owner before it can be claimed. If this
// process still has the predecessor supervisor, drain it while that rotated owner
// fences every old write, then let takeover restore the process owner. Waiting for
// full cleanup prevents two epochs sharing a credential file or worktree.
func prepareLocalSupervisorTakeover(
	ctx context.Context,
	pool *sessionPool,
	job *ClaimedSession,
	processOwner string,
) error {
	if job == nil {
		return nil
	}
	// Close manual Commit/Merge admission before inspecting the supervisor.
	// This also covers a completed session with no supervisor: a heartbeat op
	// that linearized first must finish before setupWorktree/takeover begins.
	operationDone := pool.fenceWorktreeOperations(job.SessionID)
	var done <-chan struct{}
	if strings.EqualFold(job.LeaseOwner, processOwner) {
		// Normally this is a warm reuse. If a heartbeat already began detaching
		// the advertised epoch, however, join that cleanup instead of reviving it.
		done, _ = pool.detachingDone(job.SessionID)
	} else {
		done, _ = pool.detachForTakeover(job.SessionID)
	}
	for _, barrier := range []<-chan struct{}{operationDone, done} {
		if barrier == nil {
			continue
		}
		select {
		case <-barrier:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

// Modern manual-worktree commands are bound to this exact runner process.
// A fieldless pair is accepted only for a command decoded from an older control
// plane during runner-first rollout; a partial pair always fails closed.
func manualWorktreeCommandAllowed(operationID, leaseOwner, processOwner string) bool {
	if operationID == "" && leaseOwner == "" {
		return true
	}
	return operationID != "" && leaseOwner != "" && strings.EqualFold(leaseOwner, processOwner)
}

type manualWorktreeOperationKey struct {
	kind        string
	sessionID   string
	operationID string
	leaseOwner  string
}

// unstartedWorktreeCommands picks the merge/commit commands a draining process must hand
// back instead of strand. The server claims heartbeat-delivered git work before it returns
// the response, so a drain beginning mid-cycle leaves commands owned by an epoch that will
// never run them: pending, fencing takeover/messages/resume for their session until the
// staleness backstop expires minutes later. A released command is simply unclaimed again,
// so the successor process performs it.
//
// Excluded: commands this process is already executing or whose local outcome it still owes
// the server (`started`), and legacy commands that carry no claim to give back. Handing back
// half-applied git work so another process can repeat it is exactly what the owner fence
// exists to prevent.
func unstartedWorktreeCommands(
	resp *HeartbeatResponse,
	processOwner string,
	started func(manualWorktreeOperationKey) bool,
) []worktreeCommandRelease {
	if resp == nil {
		return nil
	}
	var out []worktreeCommandRelease
	add := func(kind, sessionID, operationID, leaseOwner string) {
		if operationID == "" || leaseOwner == "" {
			return
		}
		if !manualWorktreeCommandAllowed(operationID, leaseOwner, processOwner) {
			return
		}
		key := manualWorktreeOperationKey{
			kind: kind, sessionID: sessionID,
			operationID: operationID, leaseOwner: leaseOwner,
		}
		if started(key) {
			return
		}
		out = append(out, worktreeCommandRelease(key))
	}
	for _, m := range resp.MergeRequests {
		add("merge", m.SessionID, m.OperationID, m.LeaseOwner)
	}
	for _, c := range resp.CommitRequests {
		add("commit", c.SessionID, c.OperationID, c.LeaseOwner)
	}
	return out
}

// worktreeCommandRelease is one claimed-but-unexecuted git command to hand back.
type worktreeCommandRelease manualWorktreeOperationKey

// runLoop returns true only when it drained because a newer runner release was
// published. The caller performs the existing atomic self-update after all live
// sessions have detached; SIGINT/SIGTERM continue to return false and exit.
func runLoop(cfg *RunnerConfig) bool {
	t := NewTransport(cfg.ServerURL, cfg.RunnerToken)

	// Claude Code's cwd is per session: the server hands each claimed/reclaimed
	// session the project directory of its agent. sessionExecDir resolves it, falling
	// back to the config's workDir (the last dir registered) then the process cwd.
	sessionExecDir := func(workDir string) string {
		dir := workDir
		if dir == "" {
			dir = cfg.WorkDir
		}
		if dir == "" {
			dir, _ = os.Getwd()
		}
		// Agent/config workDirs may carry a leading ~; chdir won't expand it.
		return expandTilde(dir)
	}

	// Server-authoritative concurrency cap. Seeded from the local config (the value
	// `orbit register --max-concurrent` baked in), then kept in sync with the DB value
	// the control plane returns on each heartbeat — so editing a runner's max-concurrent
	// in the UI takes effect within one heartbeat, no restart. The local config value is
	// only the initial seed; the DB value is authoritative once the first heartbeat lands.
	pool := newSessionPool(cfg.MaxConcurrent)

	loopCtx, loopCancel := context.WithCancel(context.Background())
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	monitorCtx, stopMonitor := context.WithCancel(context.Background())
	monitorDone := make(chan struct{})
	var updateRequested atomic.Bool
	var check selfUpdateChecker
	if selfUpdateEnabled() {
		check = availableSelfUpdate
	}
	go func() {
		defer close(monitorDone)
		reason, remote := waitForRunLoopStop(monitorCtx, sig, cfg.ServerURL, selfUpdateCheckInterval, check)
		if reason == runLoopStopNone {
			return
		}
		if reason == runLoopStopUpdate {
			updateRequested.Store(true)
			logln(fmt.Sprintf("orbit %s update available; stopping claims and draining sessions", remote))
		}
		loopCancel()
	}()
	defer func() {
		stopMonitor()
		signal.Stop(sig)
		<-monitorDone
		loopCancel()
	}()

	// Slash assets (commands/skills) discovered on this machine, surfaced to the web
	// composer's `/` autocomplete. A background scan refreshes the cache every ~5 min;
	// filesystem or control-plane latency must never delay runner liveness. Roots = the
	// runner's default dir (host-level) plus
	// each agent's workDir, tagged with the agent's id so the composer can scope the
	// `/` menu to the session's agent (host-level assets show for every agent).
	var runnerAgentsMu sync.Mutex
	var runnerAgents []RunnerAgent
	refreshRunnerAgents := func() {
		me, err := t.me()
		if err != nil {
			return
		}
		runnerAgentsMu.Lock()
		runnerAgents = append([]RunnerAgent(nil), me.Agents...)
		runnerAgentsMu.Unlock()
	}
	agentSnapshot := func() []RunnerAgent {
		runnerAgentsMu.Lock()
		defer runnerAgentsMu.Unlock()
		return append([]RunnerAgent(nil), runnerAgents...)
	}
	providerConfigured := func(provider string) bool {
		for _, a := range agentSnapshot() {
			p := strings.ToLower(strings.TrimSpace(a.Provider))
			if p == "" {
				p = providerClaude
			}
			if p == provider {
				return true
			}
		}
		return false
	}
	assetRoots := func() []assetRoot {
		roots := []assetRoot{{base: cfg.WorkDir}}
		for _, a := range agentSnapshot() {
			roots = append(roots, assetRoot{base: a.WorkDir, agentID: a.ID})
		}
		return roots
	}
	// The same dirs, for the shared-checkout health scan the heartbeat carries. Read fresh each
	// scan so an agent added after startup is covered without a restart.
	repoHealth := &repoHealthProbe{dirs: func() []agentWorkDir {
		dirs := []agentWorkDir{{Dir: cfg.WorkDir}}
		for _, a := range agentSnapshot() {
			dirs = append(dirs, agentWorkDir{AgentID: a.ID, Dir: a.WorkDir})
		}
		return dirs
	}}
	go repoHealth.run(loopCtx)
	var assetMu sync.Mutex
	var hbCommands, hbSkills []SlashCommandInfo
	refreshHeartbeatAssets := func() {
		refreshRunnerAgents()
		commands, skills := slashAssetsForHeartbeat(assetRoots())
		assetMu.Lock()
		hbCommands, hbSkills = commands, skills
		assetMu.Unlock()
	}
	go func() {
		// Publish the disk scan first — it's local and instant, so the first heartbeat carries
		// the machine's own commands/skills without waiting on a process spawn. The CLI's own
		// registry (built-ins, plugin skills, namespaced commands) is invisible to that scan and
		// is learned right after, then re-published; retried on each tick while it stays empty,
		// since engines install on demand and `claude` may not be on PATH yet.
		refreshHeartbeatAssets()
		if ensureClaudeSlashRegistry(loopCtx, cfg.WorkDir) {
			refreshHeartbeatAssets()
		}
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-loopCtx.Done():
				return
			case <-ticker.C:
				ensureClaudeSlashRegistry(loopCtx, cfg.WorkDir)
				refreshHeartbeatAssets()
			}
		}
	}()

	// Provider quota for this machine's logins, refreshed in the background so the
	// heartbeat attaches the latest snapshot without ever blocking on external calls.
	// Each probe refreshes quickly while active and slowly while an agent for that
	// provider exists, so idle reset windows do not leave stale UI gauges behind.
	activeProviderCount := func(provider string) int {
		return pool.providerCount(provider, true)
	}
	residentProviderCount := func(provider string) int { return pool.providerCount(provider, false) }
	claudeUsageProbe := newClaudePlanUsageProbe()
	claudeActive := func() int { return activeProviderCount(providerClaude) }
	claudeIdle := func() bool { return providerConfigured(providerClaude) }
	go claudeUsageProbe.run(loopCtx, claudeActive, claudeIdle)
	codexUsageProbe := newCodexPlanUsageProbe()
	codexActive := func() int { return activeProviderCount(providerCodex) }
	codexIdle := func() bool { return providerConfigured(providerCodex) }
	go codexUsageProbe.run(loopCtx, codexActive, codexIdle)

	// Runtime model catalogs and effective defaults, reported by the runtimes themselves. Catalogs
	// change rarely and are expensive to discover; defaults are cheap config reads that users may
	// change deliberately, so independent background refreshers update the two cached snapshots.
	var modelSnapshotMu sync.Mutex
	var hbModelCatalog *ModelCatalog
	var hbRuntimeDefaultModels map[string]string
	var modelCatalogRefreshMu sync.Mutex
	// Let the UI follow the runner's own CLIs (Codex `codex debug models`, Claude `claude -p
	// "/model"`, which auto-track new releases) instead of a hardcoded web/mobile list. Refreshed
	// hourly in the background: model lineups change rarely, and the Claude fetch spawns a
	// few `claude -p` processes, so there's no reason to run it often.
	refreshModelCatalog := func() {
		if !modelCatalogRefreshMu.TryLock() {
			return
		}
		defer modelCatalogRefreshMu.Unlock()
		catalog := &ModelCatalog{}
		if codexCLIAvailable() {
			if models, err := fetchCodexModelCatalog(loopCtx); err != nil {
				logln("codex model catalog refresh failed:", err)
			} else {
				catalog.Codex = models
			}
		}
		if claudeCLIAvailable() {
			if models, err := fetchClaudeModelCatalog(loopCtx); err != nil {
				logln("claude model catalog refresh failed:", err)
			} else {
				catalog.Claude = models
			}
		}
		if kimiCLIAvailable() {
			if models, err := fetchKimiModelCatalog(loopCtx); err != nil {
				logln("kimi model catalog refresh failed:", err)
			} else {
				catalog.Kimi = models
			}
		}
		if openCodeCLIAvailable() {
			// A heartbeat catalog is runner-wide, while OpenCode project config is
			// workDir-scoped. Report only globally available models from a neutral
			// directory; unioning project catalogs would offer agent A a model that
			// exists only in agent B's checkout. The empty-model picker sentinel still
			// leaves selection to OpenCode; guarded modes use its global/current choice,
			// while Auto/Bypass may also opt into project configuration.
			if models, err := fetchGlobalOpenCodeModelCatalog(loopCtx); err != nil {
				logln("opencode model catalog refresh failed:", err)
			} else {
				catalog.OpenCode = models
			}
		}
		modelSnapshotMu.Lock()
		if len(catalog.Codex) > 0 || len(catalog.Claude) > 0 || len(catalog.Kimi) > 0 ||
			len(catalog.OpenCode) > 0 {
			hbModelCatalog = carryOverModelCatalog(hbModelCatalog, catalog)
		}
		modelSnapshotMu.Unlock()
	}
	// Runtime defaults come from user-owned config/environment only, so refresh them more often
	// without paying the catalog's process-spawn cost. Probe errors remain visible in logs, while
	// mergeRuntimeDefaultModels applies the null/empty/last-good heartbeat semantics.
	refreshRuntimeDefaults := func() {
		results := probeRuntimeDefaultModels()
		for _, result := range results {
			if result.err != nil {
				logln(result.runtime, "default model refresh failed:", result.err)
			}
		}
		modelSnapshotMu.Lock()
		hbRuntimeDefaultModels = mergeRuntimeDefaultModels(hbRuntimeDefaultModels, results)
		modelSnapshotMu.Unlock()
	}
	go func() {
		refreshModelCatalog()
		ticker := time.NewTicker(time.Duration(modelCatalogRefreshHeartbeatTicks) * heartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-loopCtx.Done():
				return
			case <-ticker.C:
				refreshModelCatalog()
			}
		}
	}()
	go func() {
		refreshRuntimeDefaults()
		ticker := time.NewTicker(time.Duration(runtimeDefaultRefreshHeartbeatTicks) * heartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-loopCtx.Done():
				return
			case <-ticker.C:
				refreshRuntimeDefaults()
			}
		}
	}()

	// Keep the machine's coding-engine CLIs current: the runner execs whatever engine
	// binary is on PATH, and the control plane pins new model slugs a stale CLI rejects.
	// Daily, best-effort, skips any engine with a live session (see engineUpdateLoop).
	go engineUpdateLoop(loopCtx, residentProviderCount, doctorProxyVars(cfg.ServerURL))

	// Engines are installed on demand rather than at register time; this is the consent
	// that was collected there (see ensureEngine).
	configureEngineInstall(cfg.AutoInstallEngines, doctorProxyVars(cfg.ServerURL))

	// Which engine CLIs this machine has, and whether they're signed in — the Providers page's
	// "On your runners" section. Probed in the background: it spawns a couple of processes per
	// engine, so the heartbeat only ever reads the last completed snapshot.
	engineHealth := &engineHealthProbe{}
	go engineHealth.run(loopCtx)

	telemetry := newHeartbeatTelemetryProbe(heartbeatTelemetryTimeout, nil)
	go telemetry.run(loopCtx)

	// Agent working-directory state for the web's config form, on the same cached, off-path
	// footing: the control plane names the directories in its heartbeat response, we stat them
	// in the background, and the answer rides the next heartbeat.
	agentDirs := newAgentDirProbe(agentDirProbeTimeout)
	go agentDirs.run(loopCtx)

	// Heartbeat every 30s; honor server-requested cancellations.
	hbStop := make(chan struct{})
	hbDone := make(chan struct{})
	// Heartbeat-delivered work may spawn git subprocesses that outlive the heartbeat
	// goroutine itself. Stop dispatching it as soon as drain begins and join anything
	// already running before a self-update replaces this process image.
	var heartbeatOps sync.WaitGroup
	login := &loginRelay{}
	install := &installRelay{}
	go func() {
		defer close(hbDone)
		ticker := time.NewTicker(heartbeatInterval)
		defer ticker.Stop()
		// Sessions whose "merge to main" / "commit" is in flight, so the at-least-once
		// heartbeat redelivery doesn't kick off the same operation twice before its result
		// is recorded.
		var mergeMu sync.Mutex
		mergingNow := map[string]bool{}
		committingNow := map[string]bool{}
		mergeOutcomes := map[manualWorktreeOperationKey]mergeOutcome{}
		commitOutcomes := map[manualWorktreeOperationKey]commitOutcome{}
		artifactNow := map[string]bool{}
		// The one browser-less sign-in this runner may have in flight — it writes the machine's
		// single credentials file, so it guards itself rather than keying off a request id.
		runHeartbeatTicks(hbStop, ticker.C, func() {
			idle := pool.maxConcurrent() - pool.activeCount()
			if idle < 0 {
				idle = 0
			}
			draining := loopCtx.Err() != nil
			if draining {
				idle = 0 // draining: keep heartbeating (so the reaper spares our sessions)
				// but advertise no capacity so the server routes no new work here
			}
			assetMu.Lock()
			cmds, skills := hbCommands, hbSkills
			assetMu.Unlock()
			modelSnapshotMu.Lock()
			modelCatalog := hbModelCatalog
			runtimeDefaultModels := hbRuntimeDefaultModels
			modelSnapshotMu.Unlock()
			resp, supervisors, err := sendHeartbeatCycle(pool, telemetry, HeartbeatRequest{
				Status: "ONLINE", IdleCapacity: idle, Version: version,
				LeaseOwner: t.leaseOwner, Draining: draining,
				Commands: cmds, Skills: skills,
				PlanUsage:            combinePlanUsage(claudeUsageProbe.snapshot(), codexUsageProbe.snapshot()),
				ModelCatalog:         modelCatalog,
				RuntimeDefaultModels: runtimeDefaultModels,
				Engines:              engineHealth.snapshotNow(),
				AgentDirProbes:       agentDirs.snapshot(),
				Repos:                repoHealth.snapshotNow(),
			}, t.heartbeat)
			if err != nil {
				logln("heartbeat failed:", err)
				return
			}
			// Scan the directories this response named, ready for the next heartbeat. An older
			// control plane sends none, which parks the scanner rather than clearing what it
			// last found.
			if resp.AgentDirs != nil {
				agentDirs.trigger(resp.AgentDirs)
			}
			// Adopt the control plane's authoritative max-concurrent (the editable DB
			// value). 0 means an older server that doesn't report it — keep current.
			if resp.MaxConcurrent > 0 {
				if prev := pool.maxConcurrent(); prev != resp.MaxConcurrent {
					pool.setMax(resp.MaxConcurrent)
					logln(fmt.Sprintf("max-concurrent updated %d -> %d (from control plane)", prev, resp.MaxConcurrent))
				}
			}
			// Process ownership loss first. A terminal row can appear in both lists;
			// marking its exact advertised epoch detaching before a durable cancel
			// makes that overlap take the no-finalize path.
			for _, id := range resp.LeaseLostSessionIDs {
				if snapshot, ok := supervisors[id]; ok {
					if _, detached := pool.detachExpectedForTakeover(snapshot.supervisor); detached {
						logln("detaching supervisor after lease ownership changed:", id)
					}
				}
			}
			for _, id := range resp.CancelSessionIDs {
				if snapshot, ok := supervisors[id]; ok && snapshot.cancel != nil {
					snapshot.cancel()
				}
			}
			if loopCtx.Err() != nil {
				// Drain began after the server claimed this cycle's git commands, so nothing
				// below will run them and this process image is about to be replaced. Hand
				// each one back rather than strand it under a dead epoch.
				startedLocally := func(key manualWorktreeOperationKey) bool {
					mergeMu.Lock()
					defer mergeMu.Unlock()
					if key.kind == "merge" {
						_, owed := mergeOutcomes[key]
						return mergingNow[key.sessionID] || owed
					}
					_, owed := commitOutcomes[key]
					return committingNow[key.sessionID] || owed
				}
				for _, r := range unstartedWorktreeCommands(resp, t.leaseOwner, startedLocally) {
					var err error
					if r.kind == "merge" {
						err = t.mergeResult(r.sessionID, MergeResultRequest{
							OperationID: r.operationID, LeaseOwner: r.leaseOwner, Status: "released",
						})
					} else {
						err = t.commitResult(r.sessionID, CommitResultRequest{
							OperationID: r.operationID, LeaseOwner: r.leaseOwner, Status: "released",
						})
					}
					if err != nil {
						logln("releasing claimed "+r.kind+" for", r.sessionID+":", err)
					}
				}
				return
			}
			// Honor "merge to main" requests: merge each session's branch into main on
			// our local repo and report the outcome. Each runs once (guarded against the
			// heartbeat's at-least-once redelivery) in its own goroutine, so a slow merge
			// never stalls the heartbeat that keeps the reaper off our sessions.
			for _, m := range resp.MergeRequests {
				if !manualWorktreeCommandAllowed(m.OperationID, m.LeaseOwner, t.leaseOwner) {
					logln("ignoring unfenced merge command for", m.SessionID)
					continue
				}
				snapshot := supervisors[m.SessionID]
				mergeMu.Lock()
				busy := mergingNow[m.SessionID]
				if !busy {
					mergingNow[m.SessionID] = true
				}
				mergeMu.Unlock()
				if busy {
					continue
				}
				heartbeatOps.Add(1)
				go func(req MergeCommand, advertised heartbeatSupervisorSnapshot) {
					defer heartbeatOps.Done()
					defer func() {
						mergeMu.Lock()
						delete(mergingNow, req.SessionID)
						mergeMu.Unlock()
					}()
					key := manualWorktreeOperationKey{
						kind: "merge", sessionID: req.SessionID,
						operationID: req.OperationID, leaseOwner: req.LeaseOwner,
					}
					mergeMu.Lock()
					res, cached := mergeOutcomes[key]
					mergeMu.Unlock()
					if !cached {
						release, admitted := pool.beginHeartbeatWorktreeOperation(
							req.SessionID,
							advertised.supervisor,
							advertised.permitGeneration,
							false,
						)
						if !admitted {
							// The server already claimed this exact epoch before returning
							// the heartbeat. Close it explicitly; a silent drop would leave
							// Resume permanently blocked on its operation owner.
							res = mergeOutcome{
								Status:  "error",
								Message: "merge was superseded before local execution",
							}
						} else {
							res = mergeToMain(req)
							// Record where this session's work went before opening the gate.
							rememberMergeTarget(req.SessionID, req.TargetBranch)
							release()
						}
						if req.OperationID != "" {
							mergeMu.Lock()
							for old := range mergeOutcomes {
								if old.sessionID == req.SessionID && old != key {
									delete(mergeOutcomes, old)
								}
							}
							mergeOutcomes[key] = res
							mergeMu.Unlock()
						}
					}
					if err := t.mergeResult(req.SessionID, MergeResultRequest{
						OperationID: req.OperationID, LeaseOwner: req.LeaseOwner,
						Status: res.Status, MergedSha: res.MergedSha, SourceSha: res.SourceSha, Message: res.Message,
					}); err != nil {
						logln("merge-result POST failed for", req.SessionID+":", err)
						if !isRetryableTransportError(err) {
							mergeMu.Lock()
							delete(mergeOutcomes, key)
							mergeMu.Unlock()
						}
					} else {
						mergeMu.Lock()
						delete(mergeOutcomes, key)
						mergeMu.Unlock()
					}
				}(m, snapshot)
			}
			// Honor "commit" requests: commit each live session's uncommitted worktree
			// changes onto its branch (guarded against redelivery, in its own goroutine).
			for _, c := range resp.CommitRequests {
				if !manualWorktreeCommandAllowed(c.OperationID, c.LeaseOwner, t.leaseOwner) {
					logln("ignoring unfenced commit command for", c.SessionID)
					continue
				}
				snapshot := supervisors[c.SessionID]
				mergeMu.Lock()
				busy := committingNow[c.SessionID]
				if !busy {
					committingNow[c.SessionID] = true
				}
				mergeMu.Unlock()
				if busy {
					continue
				}
				heartbeatOps.Add(1)
				go func(req CommitCommand, advertised heartbeatSupervisorSnapshot) {
					defer heartbeatOps.Done()
					defer func() {
						mergeMu.Lock()
						delete(committingNow, req.SessionID)
						mergeMu.Unlock()
					}()
					key := manualWorktreeOperationKey{
						kind: "commit", sessionID: req.SessionID,
						operationID: req.OperationID, leaseOwner: req.LeaseOwner,
					}
					mergeMu.Lock()
					res, cached := commitOutcomes[key]
					mergeMu.Unlock()
					if !cached {
						release, admitted := pool.beginHeartbeatWorktreeOperation(
							req.SessionID,
							advertised.supervisor,
							advertised.permitGeneration,
							true,
						)
						if !admitted {
							res = commitOutcome{
								Status:  "error",
								Message: "commit was superseded before local execution",
							}
						} else {
							res = commitWorktree(req)
							release()
						}
						if req.OperationID != "" {
							mergeMu.Lock()
							for old := range commitOutcomes {
								if old.sessionID == req.SessionID && old != key {
									delete(commitOutcomes, old)
								}
							}
							commitOutcomes[key] = res
							mergeMu.Unlock()
						}
					}
					if err := t.commitResult(req.SessionID, CommitResultRequest{
						OperationID: req.OperationID, LeaseOwner: req.LeaseOwner,
						Status: res.Status, Message: res.Message,
					}); err != nil {
						logln("commit-result POST failed for", req.SessionID+":", err)
						if !isRetryableTransportError(err) {
							mergeMu.Lock()
							delete(commitOutcomes, key)
							mergeMu.Unlock()
						}
					} else {
						mergeMu.Lock()
						delete(commitOutcomes, key)
						mergeMu.Unlock()
					}
				}(c, snapshot)
			}
			for _, a := range resp.ArtifactRequests {
				mergeMu.Lock()
				busy := artifactNow[a.RequestID]
				if !busy {
					artifactNow[a.RequestID] = true
				}
				mergeMu.Unlock()
				if busy {
					continue
				}
				heartbeatOps.Add(1)
				go func(req ArtifactCommand) {
					defer heartbeatOps.Done()
					res := uploadLegacyArtifact(loopCtx, t, req)
					if err := t.artifactResult(req.SessionID, res); err != nil {
						logln("artifact-result POST failed for", req.SessionID+":", err)
					}
					mergeMu.Lock()
					delete(artifactNow, req.RequestID)
					mergeMu.Unlock()
				}(a)
			}
			// Drive the browser-less sign-in the user started from the web. Both actions are
			// idempotent: the server redelivers each one until a status report moves it on,
			// and the relay itself refuses to start a second CLI while one is running.
			if lr := resp.LoginRequest; lr != nil {
				report := func(res LoginResultRequest) {
					if err := t.loginResult(res); err != nil {
						logln("login-result POST failed:", err)
					}
					// A sign-in that just landed changes what the engine probe would say, and
					// the Providers page shouldn't keep calling this engine signed out for the
					// rest of the refresh interval.
					if res.Status == loginDone {
						go engineHealth.refresh()
					}
				}
				switch lr.Action {
				case "start":
					login.start(lr.Attempt, lr.Engine, report)
				case "code":
					login.submitCode(lr.Code, report)
				}
			}
			// Install an engine CLI the user asked for from the web. Idempotent for the same
			// reason: the server redelivers until our first report moves it on, and the relay
			// refuses to start a second installer while one is running.
			if ir := resp.InstallRequest; ir != nil {
				report := func(res InstallResultRequest) {
					if err := t.installResult(res); err != nil {
						logln("install-result POST failed:", err)
					}
				}
				// The same slot also carries "update every engine now" (the daily loop's work,
				// on demand). Live sessions are visible from here, so unlike `orbit
				// engine-update` this one won't swap a binary mid-turn.
				if ir.Mode == "update" {
					install.startUpdate(residentProviderCount, doctorProxyVars(cfg.ServerURL), report, engineHealth.refresh)
				} else {
					install.start(ir.Engine, report, engineHealth.refresh)
				}
			}
			// Repair a shared checkout the user saw reported as wedged. Runs here, on the
			// heartbeat's own goroutine, because it's short and must not overlap the next one:
			// the request is redelivered until we report, and a second repair racing the first
			// would rescue the tree the first one already cleared. Only paths this runner's
			// agents actually work in are accepted — the control plane names the root, but the
			// machine decides what it will rewrite.
			if rc := resp.RepoCleanupRequest; rc != nil && rc.Root != "" {
				out := cleanupRepoRoot(rc.Root, func(root string) bool {
					for _, r := range scanRepoHealth(repoHealth.dirs()) {
						if r.Root == root {
							return true
						}
					}
					return false
				})
				if err := t.repoCleanupResult(RepoCleanupResultRequest{
					Root: rc.Root, Status: out.Status, State: out.State,
					RescueBranch: out.RescueBranch, Message: out.Message,
				}); err != nil {
					logln("repo-cleanup-result POST failed:", err)
				}
				repoHealth.refresh() // report the repaired state on the next heartbeat, not in a minute
			}
		})
	}()

	logln(fmt.Sprintf("runner %q online -> %s (max %d concurrent)", cfg.Name, cfg.ServerURL, cfg.MaxConcurrent))

	takeoverSession := func(job *ClaimedSession) (string, error) {
		return takeoverClaimedSession(loopCtx, t, job)
	}
	prepareTakeover := func(job *ClaimedSession) error {
		return prepareLocalSupervisorTakeover(loopCtx, pool, job, t.leaseOwner)
	}

	// startSession creates a lightweight supervisor for a newly-known session, or
	// activates an existing warm/cold supervisor when a new turn claim arrives.
	// A supervisor that was silently engine-evicted remains registered cold; its
	// next claim wakes it without creating a duplicate supervisor.
	startSession := func(job *ClaimedSession, initiallyActive bool) {
		stageCredential := func() {
			// Keep the signed proof out of the provider environment. New MCP/CLI calls read
			// this private file for every operation, so a refreshed proof becomes visible
			// without respawning Claude/Codex. A storage failure safely disables discovery
			// for this process; the control plane remains the authorization boundary.
			if err := stageOrchestrationCredential(job); err != nil {
				logln("cannot stage orchestration credential for", job.SessionID+":", err)
				job.AllowOrchestration = false
			}
		}
		if initiallyActive {
			if _, ok := pool.activatePrepared(job, stageCredential); ok {
				return // warm reuse, or wake a cold supervisor for transparent resume
			}
			// A lease-loss heartbeat can start detaching a cold supervisor in the
			// narrow interval after the claim's prepare step. Join its exact cleanup
			// before staging resources or registering the replacement epoch.
			if err := prepareTakeover(job); err != nil {
				logln("local supervisor activation barrier failed for", job.SessionID+":", err)
				loopCancel()
				return
			}
			if _, ok := pool.activatePrepared(job, stageCredential); ok {
				return
			}
		}
		// No predecessor remains. Stage before registering/waking the new supervisor;
		// stale heartbeat responses are pointer-bound and cannot remove this credential.
		stageCredential()
		// Per-session git worktree isolation: when the agent's workDir is a git repo, run
		// claude in its own checkout on job.Branch instead of the shared dir. Falls back to
		// the shared dir (recording why on job.IsolationStatus) for non-git workDirs.
		// The branch this session merges into, so branchMergedInto's "already merged" check
		// judges the target the Merge button names rather than main (see mergeTargetBySession).
		rememberMergeTarget(job.SessionID, job.MergeTarget)
		execDir := setupWorktree(job, sessionExecDir(job.WorkDir))
		// A resumed/reclaimed session whose last act was a park checkpoint: undo it so the
		// agent continues from an uncommitted working tree, not a committed snapshot — no
		// stray checkpoint left in history. No-op for fresh sessions and permanent ends.
		if job.WT != nil {
			uncommitParkCheckpoint(job.WT)
		}
		jobCtx, cancel := context.WithCancel(context.Background())
		s, added := pool.register(job, cancel, initiallyActive)
		if !added {
			cancel()
			if initiallyActive {
				pool.activate(job)
			}
			return
		}
		go func(j *ClaimedSession, dir string, live *liveSession, activeAtRegister bool) {
			// loopCtx doubles as the shutdown signal: cancelled on SIGTERM/SIGINT, it tells
			// the session to drain (finish its turn, then detach) rather than be killed.
			defer func() {
				if err := removeOrchestrationCredential(j.SessionID); err != nil {
					logln("cannot remove orchestration credential for", j.SessionID+":", err)
				}
				forgetMergeTarget(j.SessionID)
				pool.finish(live)
			}()

			// An OPEN reclaim can contain many idle sessions. Keep those supervisors
			// lightweight until their first real claim instead of starting one flush
			// ticker, background tailer, and transcript watcher per cold session.
			if !activeAtRegister && !pool.waitActive(live, jobCtx, loopCtx) {
				if loopCtx.Err() != nil || jobCtx.Err() == nil {
					return
				}
				if pool.isDetaching(live) {
					return
				}
				// A real cancel of a never-activated cold supervisor still needs the
				// normal worktree/server finalization below. Its cancelled context makes
				// runInteractiveSession take that path without spawning an engine.
			}
			runInteractiveSession(t, j, jobCtx, loopCtx, dir, codexUsageProbe.mergeCodexRateLimits, pool, live)
		}(job, execDir, s, initiallyActive)
	}

	// Rebuild supervisors for every open session before garbage-collecting old
	// checkouts. Only sessions that were RUNNING re-acquire an active-turn permit;
	// PENDING/AWAITING_INPUT/INTERRUPTED sessions remain registered cold until a
	// normal claim activates them.
	// Retried with backoff: on a joint restart the apiserver is often still down when
	// we come up, and a single failed attempt would orphan every resumable session for
	// the rest of this process — their queued turns then sit PENDING forever.
	reclaimed := false
	// When a reclaim sets conflicted sessions aside, retry at this time so they do
	// not stay unsupervised; zero means nothing is waiting.
	var reclaimRetryAt time.Time
	pendingStarts, reclaimSkipped, reclaimErr := reclaimMissingSessions(loopCtx, t, pool.reclaimStates, prepareTakeover)
	if reclaimErr != nil && loopCtx.Err() == nil {
		logln("reclaim permanently failed; stopping runner:", reclaimErr)
		loopCancel()
	} else if reclaimErr == nil {
		if reclaimSkipped {
			reclaimRetryAt = time.Now().Add(reclaimRetryInterval)
		}
		// Prune crash leftovers before any reclaimed provider can start and refresh
		// its credential. This avoids racing cleanup against the atomic temp file used
		// by a live refresh.
		credentialLiveSet := make(map[string]bool, len(pendingStarts))
		for _, pending := range pendingStarts {
			credentialLiveSet[pending.job.SessionID] = true
		}
		if err := pruneOrchestrationCredentials(credentialLiveSet); err != nil {
			logln("credential cleanup failed:", err)
		}
		for _, pending := range pendingStarts {
			logln(fmt.Sprintf("reclaiming session %s — %s", pending.job.SessionID, pending.job.Title))
			startSession(pending.job, pending.initiallyActive)
		}
		reclaimed = true
	}

	// Reap orphan worktrees from a previous process — any checkout whose session we did
	// not just reclaim (a crash mid-finalize, or a cancelled session never resumed). The
	// branches are kept; only the stray checkout dirs are removed. Skipped unless the
	// reclaim above actually answered: without that list every live session looks like
	// an orphan and we would delete the checkouts we are about to resume. A session set
	// aside over a takeover conflict is not in the pool either, so its checkout would
	// look orphaned too — defer GC to a later clean start rather than remove it.
	if reclaimed && !reclaimSkipped {
		liveSet := pool.ids()
		gcWorktrees(t, liveSet)
		gcUploads(liveSet)
	}

	for loopCtx.Err() == nil {
		// Sessions set aside by an earlier reclaim have authoritative rows but no local
		// supervisor; their inbox is never polled until a takeover succeeds. Keep retrying
		// here — the server fails an abandoned worktree operation over after its staleness
		// window, at which point the takeover passes and the session re-attaches.
		if !reclaimRetryAt.IsZero() && time.Now().After(reclaimRetryAt) {
			recovered, skipped, recoverErr := reclaimMissingSessions(loopCtx, t, pool.reclaimStates, prepareTakeover)
			if recoverErr != nil {
				if loopCtx.Err() == nil {
					logln("deferred reclaim retry failed; stopping runner:", recoverErr)
					loopCancel()
				}
				break
			}
			for _, pending := range recovered {
				logln(fmt.Sprintf("reclaiming session %s — %s", pending.job.SessionID, pending.job.Title))
				startSession(pending.job, pending.initiallyActive)
			}
			reclaimRetryAt = time.Time{}
			if skipped {
				reclaimRetryAt = time.Now().Add(reclaimRetryInterval)
			}
		}
		if pool.activeCount() >= pool.maxConcurrent() {
			select {
			case <-loopCtx.Done():
			case <-time.After(500 * time.Millisecond):
			}
			continue
		}
		job, err := t.claimSession(loopCtx)
		if err != nil {
			if loopCtx.Err() != nil {
				break
			}
			logln("claim failed:", err)
			if !isRetryableTransportError(err) {
				logln("claim failure is permanent; stopping runner")
				loopCancel()
				break
			}
			// The claim transaction may have committed before its response was lost.
			// Reclaim all runner-owned rows and attach any authoritative RUNNING row
			// missing from the local pool before issuing another claim.
			recovered, skipped, recoverErr := reclaimMissingSessions(loopCtx, t, pool.reclaimStates, prepareTakeover)
			if recoverErr != nil {
				if loopCtx.Err() == nil {
					logln("ambiguous claim reconciliation failed; stopping runner:", recoverErr)
					loopCancel()
				}
				break
			}
			if skipped {
				reclaimRetryAt = time.Now().Add(reclaimRetryInterval)
			}
			for _, pending := range recovered {
				logln(fmt.Sprintf("recovering ambiguously claimed session %s — %s", pending.job.SessionID, pending.job.Title))
				startSession(pending.job, pending.initiallyActive)
			}
			continue
		}
		if job == nil {
			continue
		}
		// A successful claim response can narrowly win the race with loopCtx
		// cancellation. Register it rather than orphaning an already-claimed session;
		// startSession observes the cancelled shutdown context and detaches without
		// activating a lease generation or spawning an engine.
		if loopCtx.Err() != nil {
			startSession(job, true)
			continue
		}
		if prepareErr := prepareTakeover(job); prepareErr != nil {
			logln("local supervisor takeover drain failed for", job.SessionID+":", prepareErr)
			loopCancel()
			break
		}
		status, err := takeoverSession(job)
		if err != nil {
			if loopCtx.Err() != nil {
				startSession(job, true)
				continue
			}
			logln("claim lease takeover failed for", job.SessionID+":", err)
			if !isRetryableTransportError(err) && !isTransportHTTPStatus(err, 409) && !isTransportHTTPStatus(err, 403) {
				logln("lease takeover failure is permanent; stopping runner")
				loopCancel()
				break
			}
			recovered, skipped, recoverErr := reclaimMissingSessions(loopCtx, t, pool.reclaimStates, prepareTakeover)
			if recoverErr != nil {
				if loopCtx.Err() == nil {
					logln("claim lease reconciliation failed for", job.SessionID+":", recoverErr)
					loopCancel()
				}
				break
			}
			if skipped {
				reclaimRetryAt = time.Now().Add(reclaimRetryInterval)
			}
			for _, pending := range recovered {
				startSession(pending.job, pending.initiallyActive)
			}
			continue
		}
		if reclaimStatusOpen(status) {
			startSession(job, reclaimInitiallyActive(status))
		}
	}

	logln("runner stopping; draining session supervisors...")
	// Keep the heartbeat goroutine alive through the drain: the server's reaper force-fails
	// any live session whose runner has been silent >90s, so going quiet while we finish an
	// in-flight turn would get the very session we're trying to preserve marked FAILED.
	// Cover provider drain, both release backstops, the final event flush, and a racing
	// terminal finalization. systemd's stop timeout remains above this whole envelope.
	drainDeadline := time.Now().Add(shutdownSupervisorTimeout)
	drainTimedOut := false
	for {
		n := pool.count()
		if n == 0 {
			break
		}
		if time.Now().After(drainDeadline) {
			logln(fmt.Sprintf("drain deadline reached; %d session supervisor(s) still attached, exiting", n))
			drainTimedOut = true
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	close(hbStop)
	<-hbDone
	telemetry.wait()
	agentDirs.wait()
	login.stop()
	// An installer already running is joined, not killed: a half-applied `curl | bash` is worse
	// than one that finishes while the runner shuts down.
	install.stop()
	heartbeatOps.Wait()
	// A SIGTERM delivered after update discovery still means "stop", not
	// "install". Stop signal forwarding first so this final channel check cannot
	// miss a delivery racing with the return value.
	signal.Stop(sig)
	// Never enter another run loop in this process while an old session goroutine
	// may still own its credential or worktree. The service manager can restart a
	// timed-out daemon; foreground mode exits cleanly for operator intervention.
	return restartForUpdate(updateRequested.Load(), drainTimedOut, sig)
}

func uploadLegacyArtifact(ctx context.Context, t *Transport, req ArtifactCommand) ArtifactResultRequest {
	out := ArtifactResultRequest{RequestID: req.RequestID}
	if req.RequestID == "" || req.SessionID == "" || req.Path == "" {
		out.Status = "error"
		out.Message = "invalid artifact request"
		return out
	}
	clean := filepath.Clean(req.Path)
	root := uploadsDir(req.SessionID)
	if !pathWithinRoots(clean, []string{root}) {
		out.Status = "missing"
		out.Message = "artifact is outside session uploads or missing"
		return out
	}
	id, err := t.uploadSessionAttachment(ctx, req.SessionID, clean, attachmentMime(clean))
	if err != nil {
		out.Status = "error"
		out.Message = err.Error()
		return out
	}
	out.Status = "uploaded"
	out.AttachmentID = id
	return out
}

func logln(args ...interface{}) {
	fmt.Print("[orbit-runner ", nowISO(), "] ")
	fmt.Println(args...)
}

func nowISO() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00")
}
