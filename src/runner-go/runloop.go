package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

const heartbeatInterval = 30 * time.Second

func runLoop(cfg *RunnerConfig) {
	t := NewTransport(cfg.ServerURL, cfg.RunnerToken)

	// Claude Code's cwd is per session: the server hands each claimed/reclaimed
	// session the project directory of its agent. sessionExecDir resolves it, falling
	// back to the config's workDir (the last dir registered) then the process cwd.
	sessionExecDir := func(workDir string) string {
		if workDir != "" {
			return workDir
		}
		if cfg.WorkDir != "" {
			return cfg.WorkDir
		}
		cwd, _ := os.Getwd()
		return cwd
	}

	var mu sync.Mutex
	active := map[string]context.CancelFunc{}

	loopCtx, loopCancel := context.WithCancel(context.Background())
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() { <-sig; loopCancel() }()

	// Heartbeat every 30s; honor server-requested cancellations.
	hbStop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(heartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-hbStop:
				return
			case <-ticker.C:
				mu.Lock()
				idle := cfg.MaxConcurrent - len(active)
				cancels := make(map[string]context.CancelFunc, len(active))
				for k, v := range active {
					cancels[k] = v
				}
				mu.Unlock()
				if idle < 0 {
					idle = 0
				}
				resp, err := t.heartbeat(HeartbeatRequest{Status: "ONLINE", IdleCapacity: idle, Version: version})
				if err != nil {
					logln("heartbeat failed:", err)
					continue
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
		execDir := sessionExecDir(job.WorkDir)
		jobCtx, cancel := context.WithCancel(context.Background())
		mu.Lock()
		active[job.SessionID] = cancel
		mu.Unlock()
		go func(j *ClaimedSession, dir string) {
			runInteractiveSession(t, j, jobCtx, dir)
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
				Reclaimed:   true,
				SessionUUID: r.SessionUUID,
				MaxSeq:      r.MaxSeq,
			})
		}
	}

	for loopCtx.Err() == nil {
		mu.Lock()
		n := len(active)
		mu.Unlock()
		if n >= cfg.MaxConcurrent {
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

	close(hbStop)
	logln("runner stopping; waiting for active jobs...")
	for {
		mu.Lock()
		n := len(active)
		mu.Unlock()
		if n == 0 {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func logln(args ...interface{}) {
	fmt.Print("[orbit-runner ", nowISO(), "] ")
	fmt.Println(args...)
}

func nowISO() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00")
}
