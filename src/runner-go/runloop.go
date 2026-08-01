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
	heartbeatInterval       = 30 * time.Second
	selfUpdateCheckInterval = 10 * time.Minute
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

// reclaimMissingSessions repairs both startup state and an ambiguous claim
// response (the server may have committed PENDING -> RUNNING before the HTTP
// response was lost). Every process takes rows over in stable session-id order,
// and no supervisor starts until the whole snapshot's CAS operations succeed.
func reclaimMissingSessions(
	ctx context.Context,
	t *Transport,
	knownStates func() map[string]bool,
) ([]reclaimedStart, error) {
	delay := 250 * time.Millisecond
	for ctx.Err() == nil {
		rec, err := t.reclaim(ctx)
		if err != nil {
			if !isRetryableTransportError(err) {
				return nil, err
			}
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
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
		lastID := ""
		for i := range sessions {
			r := sessions[i]
			if r.SessionID == "" || r.SessionID == lastID {
				continue
			}
			lastID = r.SessionID
			knownActive, locallyKnown := localStates[r.SessionID]
			if knownActive {
				continue
			}
			// Only a RUNNING (or legacy RUNNING-only) reclaim can represent a
			// response-lost follow-up for an existing warm/cold supervisor.
			// Do not steal an idle local supervisor back from a newer process.
			if locallyKnown && !reclaimInitiallyActive(r.Status) {
				continue
			}
			job := claimedSessionFromReclaim(r)
			status, takeoverErr := takeoverClaimedSession(ctx, t, job)
			if takeoverErr != nil {
				// 409 means another process advanced the snapshot owner; 403 means
				// the assignment changed after reclaim. Refresh the whole ordered set.
				if isTransportHTTPStatus(takeoverErr, 409) || isTransportHTTPStatus(takeoverErr, 403) {
					retrySnapshot = true
					break
				}
				return nil, takeoverErr
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
			return pending, nil
		}
		delay = 250 * time.Millisecond
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(delay):
		}
	}
	return nil, ctx.Err()
}

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
	// composer's `/` autocomplete. Scanned now and refreshed every ~5 min; the cached
	// value rides each heartbeat. Roots = the runner's default dir (host-level) plus
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
	var assetMu sync.Mutex
	refreshRunnerAgents()
	hbCommands, hbSkills := slashAssetsForHeartbeat(assetRoots())

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

	// Runtime model catalogs, reported by the runtimes themselves. Codex ships new
	// model slugs in its local catalog, so cache `codex debug models` and let the UI
	// follow the runner instead of a hardcoded web/mobile list.
	var modelCatalogMu sync.Mutex
	var hbModelCatalog *ModelCatalog
	// Let the UI follow the runner's own CLIs (Codex `codex debug models`, Claude `claude -p
	// "/model"`, which auto-track new releases) instead of a hardcoded web/mobile list. Refreshed
	// hourly (see the heartbeat loop): model lineups change rarely, and the Claude fetch spawns a
	// few `claude -p` processes, so there's no reason to run it often.
	refreshModelCatalog := func() {
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
		if len(catalog.Codex) == 0 && len(catalog.Claude) == 0 {
			return // nothing fetched this round — leave the last good catalog in place
		}
		modelCatalogMu.Lock()
		hbModelCatalog = carryOverModelCatalog(hbModelCatalog, catalog)
		modelCatalogMu.Unlock()
	}
	go refreshModelCatalog()

	// Keep the machine's Claude/Codex CLIs current: the runner execs whatever engine
	// binary is on PATH, and the control plane pins new model slugs a stale CLI rejects.
	// Daily, best-effort, skips any engine with a live session (see engineUpdateLoop).
	go engineUpdateLoop(loopCtx, residentProviderCount, doctorProxyVars(cfg.ServerURL))

	// Engines are installed on demand rather than at register time; this is the consent
	// that was collected there (see ensureEngine).
	configureEngineInstall(cfg.AutoInstallEngines, doctorProxyVars(cfg.ServerURL))

	// Heartbeat every 30s; honor server-requested cancellations.
	hbStop := make(chan struct{})
	hbDone := make(chan struct{})
	// Heartbeat-delivered work may spawn git subprocesses that outlive the heartbeat
	// goroutine itself. Stop dispatching it as soon as drain begins and join anything
	// already running before a self-update replaces this process image.
	var heartbeatOps sync.WaitGroup
	login := &loginRelay{}
	go func() {
		defer close(hbDone)
		ticker := time.NewTicker(heartbeatInterval)
		defer ticker.Stop()
		cycles := 0
		// Sessions whose "merge to main" / "commit" is in flight, so the at-least-once
		// heartbeat redelivery doesn't kick off the same operation twice before its result
		// is recorded.
		var mergeMu sync.Mutex
		mergingNow := map[string]bool{}
		committingNow := map[string]bool{}
		artifactNow := map[string]bool{}
		// The one browser-less sign-in this runner may have in flight — it writes the machine's
		// single credentials file, so it guards itself rather than keying off a request id.
		for {
			select {
			case <-hbStop:
				return
			case <-ticker.C:
				cycles++
				if cycles%10 == 0 { // re-scan assets every ~5 min
					refreshRunnerAgents()
					c, s := slashAssetsForHeartbeat(assetRoots())
					assetMu.Lock()
					hbCommands, hbSkills = c, s
					assetMu.Unlock()
				}
				if cycles%120 == 0 { // model catalog (Codex + Claude) every ~60 min
					go refreshModelCatalog()
				}
				cancels, jobs := pool.snapshot()
				supervisedSessionIDs := make([]string, 0, len(cancels))
				for id := range cancels {
					supervisedSessionIDs = append(supervisedSessionIDs, id)
				}
				sort.Strings(supervisedSessionIDs)
				idle := pool.maxConcurrent() - pool.activeCount()
				if idle < 0 {
					idle = 0
				}
				if loopCtx.Err() != nil {
					idle = 0 // draining: keep heartbeating (so the reaper spares our sessions)
					// but advertise no capacity so the server routes no new work here
				}
				assetMu.Lock()
				cmds, skills := hbCommands, hbSkills
				assetMu.Unlock()
				modelCatalogMu.Lock()
				modelCatalog := hbModelCatalog
				modelCatalogMu.Unlock()
				// Live worktree diff per running session, so the web's status bar appears
				// mid-turn instead of only after a turn completes. Computed outside the lock
				// (git can be slow); a just-finalized session is filtered server-side by status.
				var liveSessions []SessionLiveState
				for _, j := range jobs {
					if j.IsolationStatus == "" {
						continue
					}
					liveSessions = append(liveSessions, SessionLiveState{
						SessionID:       j.SessionID,
						IsolationStatus: j.IsolationStatus,
						ChangedFiles:    liveDiffStat(j.WT),
						WorktreeDirty:   worktreeIsDirty(j.WT),
						MergeTargets:    mergeTargetsForWT(j.WT),
						BranchMerged:    branchMergedInto(j.WT),
						WorktreeBranch:  currentBranch(j.WT),
					})
				}
				resp, err := t.heartbeat(HeartbeatRequest{
					Status: "ONLINE", IdleCapacity: idle, Version: version,
					LeaseOwner: t.leaseOwner, SupervisedSessionIDs: supervisedSessionIDs,
					Commands: cmds, Skills: skills,
					PlanUsage:    combinePlanUsage(claudeUsageProbe.snapshot(), codexUsageProbe.snapshot()),
					ModelCatalog: modelCatalog,
					Sessions:     liveSessions,
				})
				if err != nil {
					logln("heartbeat failed:", err)
					continue
				}
				// Adopt the control plane's authoritative max-concurrent (the editable DB
				// value). 0 means an older server that doesn't report it — keep current.
				if resp.MaxConcurrent > 0 {
					if prev := pool.maxConcurrent(); prev != resp.MaxConcurrent {
						pool.setMax(resp.MaxConcurrent)
						logln(fmt.Sprintf("max-concurrent updated %d -> %d (from control plane)", prev, resp.MaxConcurrent))
					}
				}
				for _, id := range resp.CancelSessionIDs {
					if c, ok := cancels[id]; ok {
						c()
					}
				}
				for _, id := range resp.LeaseLostSessionIDs {
					if pool.detachCold(id) {
						logln("detached cold supervisor after lease ownership changed:", id)
					}
				}
				if loopCtx.Err() != nil {
					continue
				}
				// Honor "merge to main" requests: merge each session's branch into main on
				// our local repo and report the outcome. Each runs once (guarded against the
				// heartbeat's at-least-once redelivery) in its own goroutine, so a slow merge
				// never stalls the heartbeat that keeps the reaper off our sessions.
				for _, m := range resp.MergeRequests {
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
					go func(req MergeCommand) {
						defer heartbeatOps.Done()
						res := mergeToMain(req)
						// Record where this session's work went, so a later "already merged"
						// check (after a resume clears mergeStatus) looks at that branch and
						// not at main.
						rememberMergeTarget(req.SessionID, req.TargetBranch)
						if err := t.mergeResult(req.SessionID, MergeResultRequest{
							Status: res.Status, MergedSha: res.MergedSha, Message: res.Message,
						}); err != nil {
							logln("merge-result POST failed for", req.SessionID+":", err)
						}
						mergeMu.Lock()
						delete(mergingNow, req.SessionID)
						mergeMu.Unlock()
					}(m)
				}
				// Honor "commit" requests: commit each live session's uncommitted worktree
				// changes onto its branch (guarded against redelivery, in its own goroutine).
				for _, c := range resp.CommitRequests {
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
					go func(req CommitCommand) {
						defer heartbeatOps.Done()
						res := commitWorktree(req)
						if err := t.commitResult(req.SessionID, CommitResultRequest{
							Status: res.Status, Message: res.Message,
						}); err != nil {
							logln("commit-result POST failed for", req.SessionID+":", err)
						}
						mergeMu.Lock()
						delete(committingNow, req.SessionID)
						mergeMu.Unlock()
					}(c)
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
					}
					switch lr.Action {
					case "start":
						login.start(lr.Attempt, lr.Engine, report)
					case "code":
						login.submitCode(lr.Code, report)
					}
				}
			}
		}
	}()

	logln(fmt.Sprintf("runner %q online -> %s (max %d concurrent)", cfg.Name, cfg.ServerURL, cfg.MaxConcurrent))

	takeoverSession := func(job *ClaimedSession) (string, error) {
		return takeoverClaimedSession(loopCtx, t, job)
	}

	// startSession creates a lightweight supervisor for a newly-known session, or
	// activates an existing warm/cold supervisor when a new turn claim arrives.
	// A supervisor that was silently engine-evicted remains registered cold; its
	// next claim wakes it without creating a duplicate supervisor.
	startSession := func(job *ClaimedSession, initiallyActive bool) {
		// Keep the signed proof out of the provider environment. New MCP/CLI calls read
		// this private file for every operation, so a refreshed proof becomes visible
		// without respawning Claude/Codex. A storage failure safely disables discovery
		// for this process; the control plane remains the authorization boundary.
		if err := stageOrchestrationCredential(job); err != nil {
			logln("cannot stage orchestration credential for", job.SessionID+":", err)
			job.AllowOrchestration = false
		}
		if initiallyActive {
			if _, ok := pool.activate(job); ok {
				return // warm reuse, or wake a cold supervisor for transparent resume
			}
		}
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
				pool.remove(live)
				forgetMergeTarget(j.SessionID)
			}()

			// An OPEN reclaim can contain many idle sessions. Keep those supervisors
			// lightweight until their first real claim instead of starting one flush
			// ticker, background tailer, and transcript watcher per cold session.
			if !activeAtRegister && !pool.waitActive(live, jobCtx, loopCtx) {
				if loopCtx.Err() != nil || jobCtx.Err() == nil {
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
	pendingStarts, reclaimErr := reclaimMissingSessions(loopCtx, t, pool.reclaimStates)
	if reclaimErr != nil && loopCtx.Err() == nil {
		logln("reclaim permanently failed; stopping runner:", reclaimErr)
		loopCancel()
	} else if reclaimErr == nil {
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
	// an orphan and we would delete the checkouts we are about to resume.
	if reclaimed {
		liveSet := pool.ids()
		gcWorktrees(t, liveSet)
		gcUploads(liveSet)
	}

	for loopCtx.Err() == nil {
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
			recovered, recoverErr := reclaimMissingSessions(loopCtx, t, pool.reclaimStates)
			if recoverErr != nil {
				if loopCtx.Err() == nil {
					logln("ambiguous claim reconciliation failed; stopping runner:", recoverErr)
					loopCancel()
				}
				break
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
			recovered, recoverErr := reclaimMissingSessions(loopCtx, t, pool.reclaimStates)
			if recoverErr != nil {
				if loopCtx.Err() == nil {
					logln("claim lease reconciliation failed for", job.SessionID+":", recoverErr)
					loopCancel()
				}
				break
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
	login.stop()
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
