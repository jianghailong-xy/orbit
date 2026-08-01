package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

const heartbeatInterval = 30 * time.Second

// On shutdown the runner stops claiming, signals each session to drain, and waits up
// to this long for in-flight turns to finish + ack before exiting. Idle sessions detach
// immediately; only a mid-turn session consumes any of this budget. Keep systemd's
// TimeoutStopSec comfortably above it (see service.go) so we exit before any SIGKILL.
const shutdownDrainTimeout = 120 * time.Second

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

func runLoop(cfg *RunnerConfig) {
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
	go func() { <-sig; loopCancel() }()

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
	go func() {
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
		login := &loginRelay{}
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
					go func(req MergeCommand) {
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
					go func(req CommitCommand) {
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
					go func(req ArtifactCommand) {
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

	// startSession creates a lightweight supervisor for a newly-known session, or
	// activates an existing warm/cold supervisor when a new turn claim arrives.
	// A supervisor that was silently engine-evicted remains registered cold; its
	// next claim wakes it without creating a duplicate supervisor.
	startSession := func(job *ClaimedSession, initiallyActive bool) {
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
			// An OPEN reclaim can contain many idle sessions. Keep those supervisors
			// lightweight until their first real claim instead of starting one flush
			// ticker, background tailer, and transcript watcher per cold session.
			if !activeAtRegister && !pool.waitActive(live, jobCtx, loopCtx) {
				if loopCtx.Err() != nil || jobCtx.Err() == nil {
					pool.remove(live)
					forgetMergeTarget(j.SessionID)
					return
				}
				// A real cancel of a never-activated cold supervisor still needs the
				// normal worktree/server finalization below. Its cancelled context makes
				// runInteractiveSession take that path without spawning an engine.
			}
			runInteractiveSession(t, j, jobCtx, loopCtx, dir, codexUsageProbe.mergeCodexRateLimits, pool, live)
			pool.remove(live)
			forgetMergeTarget(j.SessionID)
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
	for delay := time.Second; loopCtx.Err() == nil; {
		rec, err := t.reclaim()
		if err != nil {
			logln("reclaim failed:", err)
			select {
			case <-loopCtx.Done():
			case <-time.After(delay):
			}
			if delay < 30*time.Second {
				delay *= 2
			}
			continue
		}
		for i := range rec.Sessions {
			r := rec.Sessions[i]
			logln(fmt.Sprintf("reclaiming session %s — %s", r.SessionID, r.Title))
			agent := r.Agent
			if agent.Provider == "" {
				agent.Provider = r.Provider
			}
			job := &ClaimedSession{
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
				MaxSeq:             r.MaxSeq,
			}
			startSession(job, reclaimInitiallyActive(r.Status))
		}
		reclaimed = true
		break
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
			time.Sleep(500 * time.Millisecond)
			continue
		}
		job, err := t.claimSession(loopCtx)
		if err != nil {
			if loopCtx.Err() != nil {
				break
			}
			logln("claim failed:", err)
			time.Sleep(2 * time.Second)
			continue
		}
		if job == nil {
			continue
		}
		startSession(job, true)
	}

	logln("runner stopping; draining session supervisors...")
	// Keep the heartbeat goroutine alive through the drain: the server's reaper force-fails
	// any live session whose runner has been silent >90s, so going quiet while we finish an
	// in-flight turn would get the very session we're trying to preserve marked FAILED.
	// Give sessions a little longer than their own drain budget to detach cleanly; past
	// that we exit anyway (process teardown / systemd SIGKILL reaps any stragglers).
	drainDeadline := time.Now().Add(shutdownDrainTimeout + 30*time.Second)
	for {
		n := pool.count()
		if n == 0 {
			break
		}
		if time.Now().After(drainDeadline) {
			logln(fmt.Sprintf("drain deadline reached; %d session supervisor(s) still attached, exiting", n))
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	close(hbStop)
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
