package main

// What a finished integration job came to, kept until the control plane has it.
//
// 2026-10-09 14:48Z: a CHECK_PROMOTION check on the HPC runner had finished, and
// POST /runner/integration-jobs/<id>/result answered 500 five times. The process gave up and the
// result was gone, so the control plane went on holding the job RUNNING — for a lease owner that
// never comes back, on the one machine that job's workspace routes to. Nothing could take it over,
// and nobody was told.
//
// Two halves fix that, and both are here. The report is sent again with a wait that grows to a cap
// and then stays there, for as long as this process lives (integrationResultRetry). And it is written
// to disk before the first send (spoolIntegrationResult), so a process that stops — a self-update, a
// restart, a crash — leaves the next one something to hand over, which it does before its first
// heartbeat (replaySpooledIntegrationResults), the heartbeat being what claims work.
//
// The contract asks for exactly this and names five-retries-then-drop as the status quo it replaces
// (docs/project-integration-line-contract.md §2.4, J-S8 REPORT and the revision-12 note under it): a
// failed report caches its result and sends it again, without re-running git, until the control plane
// confirms receipt or answers with a terminal or fence-invalidating one.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// spooledIntegrationResult is one undelivered report as it rests on disk: the job it is about and the
// claim it is fenced to, both repeated from the body so the file says what it is on its own, and the
// body this process would send.
type spooledIntegrationResult struct {
	JobID           string                      `json:"jobId"`
	ClaimGeneration string                      `json:"claimGeneration"`
	LeaseOwner      string                      `json:"leaseOwner"`
	Result          IntegrationJobResultRequest `json:"result"`
}

// spoolFileName is the file one job's undelivered result rests in. Job ids are the control plane's
// public ids; anything outside the characters those use is folded away, so the name cannot name a
// path outside the directory it is written to.
func spoolFileName(jobID string) string {
	safe := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			return r
		}
		return '_'
	}, jobID)
	return safe + ".json"
}

// spoolFilePath is where that file goes: the runner's own state directory (machineHome), beside its
// config and its runs, because it is this machine's copy of something the control plane owes.
func spoolFilePath(jobID string) string {
	return filepath.Join(integrationResultsDir(), spoolFileName(jobID))
}

// spoolIntegrationResult writes the report down, atomically: the file is complete or absent, whatever
// moment the process stops at.
func spoolIntegrationResult(entry spooledIntegrationResult) error {
	dir := integrationResultsDir()
	if err := os.MkdirAll(dir, machineHomePerm); err != nil {
		return err
	}
	data, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, spoolFileName(entry.JobID)+".tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(name)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(name)
		return err
	}
	if err := os.Rename(name, spoolFilePath(entry.JobID)); err != nil {
		os.Remove(name)
		return err
	}
	return nil
}

// dropSpooledIntegrationResult deletes the copy. Already gone is not an error: the copy is dropped
// once, and a second attempt at dropping it has nothing to do.
func dropSpooledIntegrationResult(jobID string) error {
	if err := os.Remove(spoolFilePath(jobID)); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// readSpooledIntegrationResults reads every report an earlier process left behind. A file that cannot
// be read or parsed stays where it is and is named in the log: it is the only copy of something, and
// a later build may understand it.
func readSpooledIntegrationResults() []spooledIntegrationResult {
	dir := integrationResultsDir()
	names, err := os.ReadDir(dir)
	if err != nil {
		if !os.IsNotExist(err) {
			logln("spooled integration results unreadable:", err)
		}
		return nil
	}
	var entries []spooledIntegrationResult
	for _, name := range names {
		if name.IsDir() || !strings.HasSuffix(name.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, name.Name()))
		if err != nil {
			logln("spooled integration result", name.Name(), "unreadable:", err)
			continue
		}
		var entry spooledIntegrationResult
		if err := json.Unmarshal(data, &entry); err != nil || entry.JobID == "" {
			logln("spooled integration result", name.Name(), "is not a report this build can send; leaving it where it is")
			continue
		}
		entries = append(entries, entry)
	}
	return entries
}

// integrationResultDelivery is one send's outcome. settled is true when the control plane has answered
// for good: it took the result, or refused it in a way that sending it again cannot change.
type integrationResultDelivery struct {
	answer  *IntegrationJobResultResponse
	err     error
	settled bool
}

// sendIntegrationJobResult makes one attempt at reporting a job's result.
func sendIntegrationJobResult(ctx context.Context, t *Transport, jobID string, body IntegrationJobResultRequest) integrationResultDelivery {
	answer, err := t.integrationJobResult(ctx, jobID, body)
	if err == nil {
		return integrationResultDelivery{answer: answer, settled: true}
	}
	return integrationResultDelivery{err: err, settled: !integrationResultWorthSendingAgain(err)}
}

// integrationResultWorthSendingAgain says whether an answer to a result could be a different one
// later. A failure with no answer at all — a connection that failed, a request that timed out — could:
// nothing was decided. So could the answers that say the control plane itself is unwell (5xx, and 408
// or 429 from the edge), and its 401 and 403: a credential the operator is about to fix is a runner
// nobody can send anything from *yet*, and a finished check's result must not be thrown away for it.
// Every other refusal — 404, 409 STALE_CLAIM or ALREADY_FINAL, 400 INVALID_RESULT — is the control
// plane saying it will not take this report, so sending it again is noise.
func integrationResultWorthSendingAgain(err error) bool {
	var httpErr *transportHTTPError
	if !errors.As(err, &httpErr) {
		return true
	}
	if httpErr.statusCode == http.StatusUnauthorized || httpErr.statusCode == http.StatusForbidden {
		return true
	}
	return isRetryableTransportError(err)
}

// integrationResultRetryPolicy is the wait between sends of a result.
//
// HOW LONG, AND WHY THESE NUMBERS. The first wait is 2 seconds — where the wiki door's calls start —
// doubling to a 60-second cap, jittered 75-125% like theirs, so a control plane that is down costs one
// request a minute per stranded job, and one that comes back is heard from within a minute of it.
// There is no total budget: this process keeps sending for as long as it lives. A budget is what turned
// five 500s into a lost result, and a job that ran an hour of checks inside a runner must not be lost
// to a control plane that was unwell for six minutes. The cap is what makes an unbounded retry polite;
// the file the result rests in is what makes stopping free, since the next process sends it before
// claiming anything.
type integrationResultRetryPolicy struct {
	first, max time.Duration
	// jitter spreads one wait, so that runners which failed together do not all come back together.
	jitter func(time.Duration) time.Duration
	// sleep waits, or returns early when ctx ends: a runner that is stopping must not be held back by a
	// report it can send again next time.
	sleep func(ctx context.Context, d time.Duration)
}

var integrationResultRetry = integrationResultRetryPolicy{
	first:  2 * time.Second,
	max:    60 * time.Second,
	jitter: wikiRetryJitter,
	sleep: func(ctx context.Context, d time.Duration) {
		timer := time.NewTimer(d)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-ctx.Done():
		}
	},
}

// wait is the pause after n failed sends: first, doubled n-1 times, jittered, never more than max.
func (p integrationResultRetryPolicy) wait(n int) time.Duration {
	d := p.max
	if n <= 20 && p.first<<(n-1) < p.max {
		d = p.first << (n - 1)
	}
	return min(p.jitter(d), p.max)
}

// settle sends a spooled report until the control plane answers for good, or this process stops.
// sends is how many attempts were already made before this call, so the wait after a failure is the
// one its place in the sequence asks for. Every retry and the ending are logged.
func (p integrationResultRetryPolicy) settle(ctx context.Context, t *Transport, entry spooledIntegrationResult, sends int) {
	for attempt := sends + 1; ; attempt++ {
		delivery := sendIntegrationJobResult(ctx, t, entry.JobID, entry.Result)
		if delivery.settled {
			finishIntegrationResult(entry, delivery)
			return
		}
		if ctx.Err() != nil {
			logln("integration job", entry.JobID, "result not delivered and this runner is stopping; it stays spooled for the next start:", delivery.err)
			return
		}
		wait := p.wait(attempt)
		logln("integration job", entry.JobID, fmt.Sprintf("result not delivered on attempt %d:", attempt), delivery.err,
			"sending it again in", wait.Round(100*time.Millisecond))
		p.sleep(ctx, wait)
	}
}

// finishIntegrationResult writes down how the report ended and drops the spooled copy: the control
// plane has answered for good either way, so there is nothing left to send.
func finishIntegrationResult(entry spooledIntegrationResult, delivery integrationResultDelivery) {
	if delivery.err != nil {
		logln("integration job", entry.JobID, "result refused, so it will not be sent again:", delivery.err)
	} else {
		logln("integration job", entry.JobID, "result delivered:", entry.Result.State,
			fmt.Sprintf("accepted=%v receipts=%d", delivery.answer.Accepted, len(delivery.answer.ReceiptIDs)))
	}
	if err := dropSpooledIntegrationResult(entry.JobID); err != nil {
		logln("integration job", entry.JobID, "spooled result could not be removed:", err)
	}
}

// deliverIntegrationResult hands the control plane what a job came to. The spool comes first and the
// send follows it, so the window in which a job has run and the control plane has not been told is as
// small as writing a file: a process that stops inside it leaves the next one the report to send.
// A spool that cannot be written is named and the send goes on — the report is still worth making.
func deliverIntegrationResult(ctx context.Context, t *Transport, jobID string, body IntegrationJobResultRequest) {
	entry := spooledIntegrationResult{
		JobID:           jobID,
		ClaimGeneration: body.ClaimGeneration,
		LeaseOwner:      body.LeaseOwner,
		Result:          body,
	}
	if err := spoolIntegrationResult(entry); err != nil {
		logln("integration job", jobID, "result could not be spooled:", err)
	}
	integrationResultRetry.settle(ctx, t, entry, 0)
}

// replaySpooledIntegrationResults offers the control plane every report an earlier process left
// behind, once each, before this process claims anything. The heartbeat is what claims work — the
// control plane picks the job and hands it over — so this runs before the heartbeat loop starts, and
// a job whose result is already on this disk is settled before this machine can be handed it again.
//
// A report the control plane refuses, or takes, goes. One it cannot answer for yet stays on disk, and
// this process keeps trying it while it lives: a control plane that comes back in a minute must not
// wait for the next restart to hear about a job it is holding RUNNING.
func replaySpooledIntegrationResults(ctx context.Context, t *Transport) {
	for _, entry := range readSpooledIntegrationResults() {
		logln("integration job", entry.JobID, "has a result an earlier process could not deliver; sending it before this one claims anything")
		delivery := sendIntegrationJobResult(ctx, t, entry.JobID, entry.Result)
		if delivery.settled {
			finishIntegrationResult(entry, delivery)
			continue
		}
		logln("integration job", entry.JobID, "spooled result not accepted yet:", delivery.err)
		go integrationResultRetry.settle(ctx, t, entry, 1)
	}
}
