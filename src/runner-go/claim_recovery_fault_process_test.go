//go:build claimrecoveryfault

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"sync"
	"testing"
	"time"
)

// TestClaimRecoveryFaultProcess is one runner process of the claim-recovery end-to-end harness
// (src/apiserver/src/runner-api/claim-recovery-e2e.pg.spec.ts): this repository's own Transport,
// reclaim path and session supervisor against a live control plane, with the harness's proxy
// dropping the claim's HTTP response in between. It exists to drive the branch runloop.go takes
// when a claim fails for a reason that may have committed anyway —
//
//	claimSession -> error -> reclaimMissingSessions -> "recovering ambiguously claimed session"
//	  -> the supervisor -> the first spawn of an engine that has never run
//
// — as one process, so the spec on the other side can ask the database what it ended in.
//
// Commands on stdin, one JSON object per line, one `CLAIMREC {json}` answer per command on
// stderr (the runner's own log stays on stdout and never shares a line with an answer):
//
//	{"id":1,"cmd":"recover","execDir":"/tmp/x"}   run the claim-error branch; answer what it decided
//	{"id":2,"cmd":"status"}                       whether a supervisor is running, and on what
//	{"id":3,"cmd":"stop"}                         cancel every supervisor and exit
//
// Built only with -tags claimrecoveryfault, so `go test ./...` neither runs nor skips it.
func TestClaimRecoveryFaultProcess(t *testing.T) {
	base := os.Getenv("ORBIT_CLAIMREC_URL")
	if base == "" {
		t.Fatal("ORBIT_CLAIMREC_URL is not set")
	}
	tr := NewTransport(base, os.Getenv("ORBIT_CLAIMREC_TOKEN"))
	// The concurrency cap is not what this harness is about; a value above one only keeps
	// registration from refusing the session on an admission it never competes for.
	pool := newSessionPool(4)

	var mu sync.Mutex
	sessions := map[string]*ClaimedSession{}
	var runs sync.WaitGroup

	ctx, stop := context.WithCancel(context.Background())
	defer stop()

	reply := func(id int64, fields map[string]interface{}) {
		fields["id"] = id
		b, err := json.Marshal(fields)
		if err != nil {
			return
		}
		fmt.Fprintln(os.Stderr, "CLAIMREC "+string(b))
	}

	// startSupervisor is the half of runLoop's startSession closure that matters here: the
	// takeover reclaimMissingSessions prepared for this job has already run, so the session has
	// no supervisor yet and the job is registered and left to run. Everything after that —
	// activate-leases, the inbox poll, the spawn, the events, turn-complete — is
	// runInteractiveSession, unchanged.
	startSupervisor := func(job *ClaimedSession, initiallyActive bool, execDir string) {
		if _, ok := pool.activatePrepared(job, nil); ok {
			return
		}
		jobCtx, cancelJob := context.WithCancel(context.Background())
		live, added := pool.register(job, cancelJob, initiallyActive)
		if !added {
			cancelJob()
			return
		}
		runs.Add(1)
		go func() {
			defer runs.Done()
			defer pool.finish(live)
			// No rate-limit probe: runLoop's own is an idle-time reader for Codex, and this
			// session is a Claude one whose only turn arrives from the inbox.
			runInteractiveSession(tr, job, jobCtx, ctx, execDir, nil, pool, live)
		}()
	}

	recover := func(id int64, execDir string) {
		started := time.Now()
		out := map[string]interface{}{"cmd": "recover"}
		// The harness's proxy answers the claim with a dropped connection, so this returns a
		// transport error rather than a job — the same thing runLoop sees when a control plane
		// committed the claim and never got to say so.
		job, claimErr := tr.claimSession(ctx)
		if claimErr == nil {
			out["fatal"] = "the claim was answered; the harness's proxy did not drop it"
			reply(id, out)
			return
		}
		out["claimError"] = claimErr.Error()
		out["retryable"] = isRetryableTransportError(claimErr)
		out["claimDurationMs"] = time.Since(started).Milliseconds()
		if job != nil {
			out["fatal"] = "a job came back with an error"
			reply(id, out)
			return
		}
		recovered, skipped, reclaimErr := reclaimMissingSessions(ctx, tr, pool.reclaimStates, func(j *ClaimedSession) (func(), error) {
			return prepareLocalSupervisorTakeover(ctx, pool, j, tr.leaseOwner)
		})
		out["skipped"] = skipped
		if reclaimErr != nil {
			out["reclaimError"] = reclaimErr.Error()
			reply(id, out)
			return
		}
		entries := []map[string]interface{}{}
		for _, pending := range recovered {
			logln(fmt.Sprintf("recovering ambiguously claimed session %s — %s", pending.job.SessionID, pending.job.Title))
			mu.Lock()
			sessions[pending.job.SessionID] = pending.job
			mu.Unlock()
			entries = append(entries, map[string]interface{}{
				"sessionId":        pending.job.SessionID,
				"title":            pending.job.Title,
				"reclaimed":        pending.job.Reclaimed,
				"resume":           pending.job.Resume,
				"maxSeq":           pending.job.MaxSeq,
				"runtimeSessionId": pending.job.RuntimeSessionID,
				"sessionUuid":      pending.job.SessionUUID,
				"firstSpawn":       firstSpawnFor(pending.job),
				"initiallyActive":  pending.initiallyActive,
				"provider":         runtimeProvider(pending.job),
			})
			startSupervisor(pending.job, pending.initiallyActive, execDir)
			pending.endTakeover()
		}
		out["recovered"] = entries
		reply(id, out)
	}

	status := func(id int64) {
		mu.Lock()
		ids := make([]string, 0, len(sessions))
		for sid := range sessions {
			ids = append(ids, sid)
		}
		mu.Unlock()
		reply(id, map[string]interface{}{"cmd": "status", "sessions": ids, "activeCount": pool.activeCount()})
	}

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var cmd struct {
			ID        int64  `json:"id"`
			Cmd       string `json:"cmd"`
			ExecDir   string `json:"execDir"`
			TimeoutMs int64  `json:"timeoutMs"`
		}
		if err := json.Unmarshal(line, &cmd); err != nil {
			continue
		}
		switch cmd.Cmd {
		case "recover":
			recover(cmd.ID, cmd.ExecDir)
		case "status":
			status(cmd.ID)
		case "wait":
			// Wait for the supervisors to go quiet, bounded by the caller's budget. An engine
			// that answered parks its session, so "quiet" is observable as the pool's active
			// count returning to zero — the harness still judges the outcome from the database.
			deadline := time.Now().Add(time.Duration(cmd.TimeoutMs) * time.Millisecond)
			for time.Now().Before(deadline) && pool.activeCount() > 0 {
				time.Sleep(50 * time.Millisecond)
			}
			reply(cmd.ID, map[string]interface{}{"cmd": "wait", "activeCount": pool.activeCount()})
		case "stop":
			stop()
			waitForRuns(&runs, 20*time.Second)
			reply(cmd.ID, map[string]interface{}{"cmd": "stop", "stopped": true})
			return
		}
	}
	stop()
	waitForRuns(&runs, 20*time.Second)
}

// waitForRuns joins the supervisors with a bound, so a wedged one fails the harness rather than
// holding its process open past the spec's timeout. The number is the harness's own budget, not
// a runner policy.
func waitForRuns(runs *sync.WaitGroup, timeout time.Duration) {
	done := make(chan struct{})
	go func() { runs.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(timeout):
		logln("claimrec: supervisors still running after " + strconv.FormatInt(int64(timeout/time.Second), 10) + "s; exiting anyway")
	}
}
