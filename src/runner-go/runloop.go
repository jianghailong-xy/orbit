package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

const heartbeatInterval = 30 * time.Second

func runLoop(cfg *RunnerConfig) {
	t := NewTransport(cfg.ServerURL, cfg.RunnerToken)

	// Claude Code runs in the registered project directory (so it can work on that
	// project), not a per-run scratch dir. Old configs without WorkDir fall back to
	// the process cwd — re-register to set it explicitly (correct under the service).
	execDir := cfg.WorkDir
	if execDir == "" {
		execDir, _ = os.Getwd()
		logln("warning: no workDir in config — running tasks in", execDir, "(re-register to set the project directory)")
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
				for _, id := range resp.CancelRunIDs {
					if c, ok := cancels[id]; ok {
						c()
					}
				}
			}
		}
	}()

	logln(fmt.Sprintf("runner %q online -> %s (max %d concurrent)", cfg.Name, cfg.ServerURL, cfg.MaxConcurrent))

	// startJob registers a job in `active` and drives it in its own goroutine,
	// removing it on exit. Shared by fresh claims and reclaimed sessions.
	startJob := func(job *ClaimedJob) {
		jobCtx, cancel := context.WithCancel(context.Background())
		mu.Lock()
		active[job.RunID] = cancel
		mu.Unlock()
		go func(j *ClaimedJob) {
			if j.Interactive {
				runInteractiveSession(t, j, jobCtx, execDir)
			} else {
				executeAndReport(t, j, jobCtx, execDir)
			}
			mu.Lock()
			delete(active, j.RunID)
			mu.Unlock()
		}(job)
	}

	// Re-attach to still-live interactive sessions from a previous process: without
	// this a restart orphans them (they stay AWAITING_INPUT, leaking a concurrency
	// slot and never seeing their inbox 'end'/cancel). Resume each before claiming
	// new work so the slot accounting is correct from the first heartbeat.
	if rec, err := t.reclaim(); err != nil {
		logln("reclaim failed:", err)
	} else {
		for i := range rec.Runs {
			r := rec.Runs[i]
			logln(fmt.Sprintf("reclaiming interactive run %s — %s", r.RunID, r.Title))
			startJob(&ClaimedJob{
				RunID:       r.RunID,
				TaskID:      r.TaskID,
				Title:       r.Title,
				Agent:       r.Agent,
				Interactive: true,
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
		job, err := t.claimJob(loopCtx)
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
		startJob(job)
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

func executeAndReport(t *Transport, job *ClaimedJob, ctx context.Context, execDir string) {
	var bufMu sync.Mutex
	var buf []RunEvent
	seq := 0

	flush := func() {
		bufMu.Lock()
		if len(buf) == 0 {
			bufMu.Unlock()
			return
		}
		events := buf
		buf = nil
		bufMu.Unlock()
		if err := t.postEvents(job.RunID, RunEventBatch{Events: events}); err != nil {
			logln("event flush failed for", job.RunID+":", err)
		}
	}
	emit := func(eventType string, payload map[string]interface{}) {
		bufMu.Lock()
		buf = append(buf, RunEvent{Seq: seq, Type: eventType, TS: nowISO(), Payload: payload})
		seq++
		full := len(buf) >= 25
		bufMu.Unlock()
		if full {
			flush()
		}
	}

	stopFlush := make(chan struct{})
	go func() {
		tk := time.NewTicker(1 * time.Second)
		defer tk.Stop()
		for {
			select {
			case <-stopFlush:
				return
			case <-tk.C:
				flush()
			}
		}
	}()

	logln(fmt.Sprintf("> run %s — %s", job.RunID, job.Title))
	scratch := filepath.Join(runsDir(), job.RunID)
	_ = os.MkdirAll(scratch, 0o755)
	res := executeJob(ctx, job, emit, execDir, scratch)

	close(stopFlush)
	flush()

	err := t.complete(job.RunID, CompleteRequest{
		Status:          res.Status,
		Result:          res.Result,
		Subtype:         res.Subtype,
		Error:           res.ErrorMsg,
		ClaudeSessionID: res.ClaudeSessionID,
		NumTurns:        res.NumTurns,
		DurationMs:      res.DurationMs,
		CostUsd:         res.CostUsd,
		Usage:           res.Usage,
		ModelUsage:      res.ModelUsage,
	})
	if err != nil {
		logln("complete failed for", job.RunID+":", err)
	} else {
		logln(fmt.Sprintf("■ run %s → %s ($%.4f)", job.RunID, res.Status, res.CostUsd))
	}
}

func logln(args ...interface{}) {
	fmt.Print("[orbit-runner ", nowISO(), "] ")
	fmt.Println(args...)
}

func nowISO() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00")
}
