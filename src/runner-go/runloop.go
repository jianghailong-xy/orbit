package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

const heartbeatInterval = 30 * time.Second

// On shutdown the runner stops claiming, signals each session to drain, and waits up
// to this long for in-flight turns to finish + ack before exiting. Idle sessions detach
// immediately; only a mid-turn session consumes any of this budget. Keep systemd's
// TimeoutStopSec comfortably above it (see service.go) so we exit before any SIGKILL.
const shutdownDrainTimeout = 120 * time.Second

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

	var mu sync.Mutex
	active := map[string]context.CancelFunc{}

	// Server-authoritative concurrency cap. Seeded from the local config (the value
	// `orbit register --max-concurrent` baked in), then kept in sync with the DB value
	// the control plane returns on each heartbeat — so editing a runner's max-concurrent
	// in the UI takes effect within one heartbeat, no restart. The local config value is
	// only the initial seed; the DB value is authoritative once the first heartbeat lands.
	var maxConcurrent atomic.Int64
	maxConcurrent.Store(int64(cfg.MaxConcurrent))

	loopCtx, loopCancel := context.WithCancel(context.Background())
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() { <-sig; loopCancel() }()

	// Slash assets (commands/skills) discovered on this machine, surfaced to the web
	// composer's `/` autocomplete. Scanned now and refreshed every ~5 min; the cached
	// value rides each heartbeat. Roots = the runner's default dir (host-level) plus
	// each agent's workDir, tagged with the agent's id so the composer can scope the
	// `/` menu to the session's agent (host-level assets show for every agent).
	assetRoots := func() []assetRoot {
		roots := []assetRoot{{base: cfg.WorkDir}}
		if me, err := t.me(); err == nil {
			for _, a := range me.Agents {
				roots = append(roots, assetRoot{base: a.WorkDir, agentID: a.ID})
			}
		}
		return roots
	}
	var assetMu sync.Mutex
	hbCommands, hbSkills := scanSlashAssets(assetRoots())

	// Heartbeat every 30s; honor server-requested cancellations.
	hbStop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(heartbeatInterval)
		defer ticker.Stop()
		cycles := 0
		for {
			select {
			case <-hbStop:
				return
			case <-ticker.C:
				cycles++
				if cycles%10 == 0 { // re-scan assets every ~5 min
					c, s := scanSlashAssets(assetRoots())
					assetMu.Lock()
					hbCommands, hbSkills = c, s
					assetMu.Unlock()
				}
				mu.Lock()
				idle := int(maxConcurrent.Load()) - len(active)
				cancels := make(map[string]context.CancelFunc, len(active))
				for k, v := range active {
					cancels[k] = v
				}
				mu.Unlock()
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
				resp, err := t.heartbeat(HeartbeatRequest{
					Status: "ONLINE", IdleCapacity: idle, Version: version,
					Commands: cmds, Skills: skills,
				})
				if err != nil {
					logln("heartbeat failed:", err)
					continue
				}
				// Adopt the control plane's authoritative max-concurrent (the editable DB
				// value). 0 means an older server that doesn't report it — keep current.
				if resp.MaxConcurrent > 0 {
					if prev := maxConcurrent.Swap(int64(resp.MaxConcurrent)); prev != int64(resp.MaxConcurrent) {
						logln(fmt.Sprintf("max-concurrent updated %d -> %d (from control plane)", prev, resp.MaxConcurrent))
					}
				}
				for _, id := range resp.CancelSessionIDs {
					if c, ok := cancels[id]; ok {
						c()
					}
				}
			}
		}
	}()

	logln(fmt.Sprintf("runner %q online -> %s (max %d concurrent)", cfg.Name, cfg.ServerURL, cfg.MaxConcurrent))

	// startSession registers a session in `active` and drives it in its own
	// goroutine, removing it on exit. Shared by fresh claims and reclaimed sessions.
	startSession := func(job *ClaimedSession) {
		// Per-session git worktree isolation: when the agent's workDir is a git repo, run
		// claude in its own checkout on job.Branch instead of the shared dir. Falls back to
		// the shared dir (recording why on job.IsolationStatus) for non-git workDirs.
		execDir := setupWorktree(job, sessionExecDir(job.WorkDir))
		jobCtx, cancel := context.WithCancel(context.Background())
		mu.Lock()
		active[job.SessionID] = cancel
		mu.Unlock()
		go func(j *ClaimedSession, dir string) {
			// loopCtx doubles as the shutdown signal: cancelled on SIGTERM/SIGINT, it tells
			// the session to drain (finish its turn, then detach) rather than be killed.
			runInteractiveSession(t, j, jobCtx, loopCtx, dir)
			mu.Lock()
			delete(active, j.SessionID)
			mu.Unlock()
		}(job, execDir)
	}

	// Re-attach to still-live interactive sessions from a previous process: without
	// this a restart orphans them (they stay AWAITING_INPUT, leaking a concurrency
	// slot and never seeing their inbox 'end'/cancel). Resume each before claiming
	// new work so the slot accounting is correct from the first heartbeat.
	if rec, err := t.reclaim(); err != nil {
		logln("reclaim failed:", err)
	} else {
		for i := range rec.Sessions {
			r := rec.Sessions[i]
			logln(fmt.Sprintf("reclaiming session %s — %s", r.SessionID, r.Title))
			startSession(&ClaimedSession{
				SessionID:   r.SessionID,
				Title:       r.Title,
				Agent:       r.Agent,
				WorkDir:     r.WorkDir,
				Branch:      r.Branch,
				AutoInitGit: r.AutoInitGit,
				AgentID:     r.AgentID,
				TaskID:      r.TaskID,
				Reclaimed:   true,
				SessionUUID: r.SessionUUID,
				MaxSeq:      r.MaxSeq,
			})
		}
	}

	// Reap orphan worktrees from a previous process — any checkout whose session we did
	// not just reclaim (a crash mid-finalize, or a cancelled session never resumed). The
	// branches are kept; only the stray checkout dirs are removed.
	mu.Lock()
	liveSet := make(map[string]bool, len(active))
	for id := range active {
		liveSet[id] = true
	}
	mu.Unlock()
	gcWorktrees(liveSet)

	for loopCtx.Err() == nil {
		mu.Lock()
		n := len(active)
		mu.Unlock()
		if n >= int(maxConcurrent.Load()) {
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
		startSession(job)
	}

	logln("runner stopping; draining active sessions...")
	// Keep the heartbeat goroutine alive through the drain: the server's reaper force-fails
	// any live session whose runner has been silent >90s, so going quiet while we finish an
	// in-flight turn would get the very session we're trying to preserve marked FAILED.
	// Give sessions a little longer than their own drain budget to detach cleanly; past
	// that we exit anyway (process teardown / systemd SIGKILL reaps any stragglers).
	drainDeadline := time.Now().Add(shutdownDrainTimeout + 30*time.Second)
	for {
		mu.Lock()
		n := len(active)
		mu.Unlock()
		if n == 0 {
			break
		}
		if time.Now().After(drainDeadline) {
			logln(fmt.Sprintf("drain deadline reached; %d session(s) still active, exiting", n))
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	close(hbStop)
}

func logln(args ...interface{}) {
	fmt.Print("[orbit-runner ", nowISO(), "] ")
	fmt.Println(args...)
}

func nowISO() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00")
}
