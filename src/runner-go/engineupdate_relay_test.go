package main

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"
)

// The browser-requested update shares one slot with the browser-requested install, because both
// drive a package manager against this machine's single global prefix. What the slot reports back
// is the only account of the run a user ever sees — the per-engine records behind it belong to
// rows the card with the button doesn't show — so a wrong verdict here is a silent one.
//
// Every test in this file reports each engine as busy. That is not incidental: updateEngines
// resolves engines against the service PATH, not the test's, so any engine actually installed on
// the machine running these tests would have its real updater executed. Busy is the one input
// that reaches the relay's own logic without running anything.

func runUpdateRelay(t *testing.T, activeCount func(string) int) []InstallResultRequest {
	t.Helper()
	t.Setenv("ORBIT_HOME", t.TempDir())

	var mu sync.Mutex
	var got []InstallResultRequest
	done := make(chan struct{})
	relay := &installRelay{}
	relay.startUpdate(activeCount, nil, func(res InstallResultRequest) {
		mu.Lock()
		got = append(got, res)
		mu.Unlock()
	}, func() { close(done) })

	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("the update relay never finished")
	}
	mu.Lock()
	defer mu.Unlock()
	return append([]InstallResultRequest(nil), got...)
}

func TestUpdateRelayReportsProgressThenOutcome(t *testing.T) {
	got := runUpdateRelay(t, func(string) int { return 1 })

	if len(got) != 2 {
		t.Fatalf("got %d reports, want progress then outcome: %+v", len(got), got)
	}
	// The first is published before the work starts: an update takes minutes, and a row that
	// only speaks at the end reads as a button that did nothing.
	if got[0].Status != installInstalling {
		t.Errorf("first report = %q, want %q", got[0].Status, installInstalling)
	}
	// Both carry the command, so a machine whose relay is broken stays fixable from a terminal.
	for i, r := range got {
		if r.Command != engineUpdateManualCmd {
			t.Errorf("report %d command = %q, want %q", i, r.Command, engineUpdateManualCmd)
		}
	}
	if got[1].Status != installDone {
		t.Errorf("outcome = %q, want %q", got[1].Status, installDone)
	}
	if strings.TrimSpace(got[1].Message) == "" {
		t.Error("the outcome carries no summary — 'done' with an empty panel reads as a button that did nothing")
	}
}

func TestUpdateRelayNamesEveryEngineItSkipped(t *testing.T) {
	// A machine mid-turn is the common case for this button, and engines skipped for it are
	// exactly what a summary listing only successes would hide: the run did less than the press
	// implied, and silence there is indistinguishable from having done the work.
	counts := map[string]int{providerClaude: 2, providerCodex: 1}
	// Default 1, not 0: an engine this map forgets is an engine whose real updater runs on the
	// machine running these tests. A map lookup returning the zero value is exactly how that
	// happens by accident, and adding a fifth engine spec would be enough to trigger it.
	got := runUpdateRelay(t, func(bin string) int {
		if n, ok := counts[bin]; ok {
			return n
		}
		return 1
	})

	outcome := got[len(got)-1]
	for _, want := range []string{"2 sessions running", "1 session running"} {
		if !strings.Contains(outcome.Message, want) {
			t.Errorf("outcome = %q, want it to contain %q", outcome.Message, want)
		}
	}
	// Busy is not failure: the daily pass picks these up, so the run as a whole succeeded.
	if outcome.Status != installDone {
		t.Errorf("status = %q, want %q — an engine skipped for being busy is not an error", outcome.Status, installDone)
	}
	// Each named engine is one line, so the panel reads as a list rather than a paragraph.
	if lines := strings.Count(outcome.Message, "\n") + 1; lines < 2 {
		t.Errorf("summary is %d line(s): %q", lines, outcome.Message)
	}
}

func TestUpdateRelayRefusesToRunTwice(t *testing.T) {
	// The control plane redelivers a pending request on every heartbeat until the first report
	// moves it on, so a second delivery must be a no-op rather than a second package manager
	// against the same prefix.
	t.Setenv("ORBIT_HOME", t.TempDir())

	relay := &installRelay{}
	release := make(chan struct{})
	first := make(chan struct{})
	var mu sync.Mutex
	var reports int

	relay.startUpdate(func(string) int { return 1 }, nil, func(InstallResultRequest) {
		mu.Lock()
		reports++
		if reports == 1 {
			close(first)
		}
		mu.Unlock()
		<-release // hold the first run open so the redelivery lands mid-flight
	}, nil)

	<-first
	relay.startUpdate(func(string) int { return 1 }, nil, func(InstallResultRequest) {
		t.Error("a redelivered update started a second run")
	}, nil)
	close(release)
	relay.stop()
}

func TestUpdateRelayRefusesWhileAnInstallHoldsTheSlot(t *testing.T) {
	// The same slot, so the guard has to hold across the two kinds of job — not just against
	// another update.
	relay := &installRelay{}
	relay.mu.Lock()
	relay.running = true
	relay.mu.Unlock()

	relay.startUpdate(func(string) int { return 1 }, nil, func(InstallResultRequest) {
		t.Error("an update started while an install held the slot")
	}, func() { t.Error("the after-hook ran for a job that never started") })
}

// The verdict has to actually reach the report. Testing updateRunFailed alone leaves the wiring
// unguarded: delete the two lines that call it and every other test here still passes, while the
// card cheerfully says "done" over a failure.
func TestUpdateRelayReportsAFailedEngineAsAFailedRun(t *testing.T) {
	orig := updateEnginesFn
	t.Cleanup(func() { updateEnginesFn = orig })
	updateEnginesFn = func(context.Context, func(string) int, []envVar) []string {
		return []string{
			"Claude Code — already up to date (2.1.221)",
			"OpenCode — update failed: npm error code EACCES",
		}
	}

	got := runUpdateRelay(t, func(string) int { return 1 })
	outcome := got[len(got)-1]

	if outcome.Status != installFailed {
		t.Errorf("status = %q, want %q — one engine's failure is the run's news", outcome.Status, installFailed)
	}
	// The successful engines stay in the summary: the panel is the account of the whole run,
	// not just of what went wrong.
	for _, want := range []string{"already up to date", "EACCES"} {
		if !strings.Contains(outcome.Message, want) {
			t.Errorf("summary = %q, want it to contain %q", outcome.Message, want)
		}
	}
}

func TestUpdateRelayReportsADeliberateSkipAsASuccessfulRun(t *testing.T) {
	orig := updateEnginesFn
	t.Cleanup(func() { updateEnginesFn = orig })
	updateEnginesFn = func(context.Context, func(string) int, []envVar) []string {
		return []string{"OpenCode — owned by another user, left alone"}
	}

	got := runUpdateRelay(t, func(string) int { return 1 })

	if outcome := got[len(got)-1]; outcome.Status != installDone {
		t.Errorf("status = %q, want %q — a deliberate skip is not a failed run", outcome.Status, installDone)
	}
}

func TestUpdateRunFailedReadsTheVerdictOffTheLines(t *testing.T) {
	// The per-engine detail lands on rows the card with the button doesn't show, so a run
	// reported "done" with a failure buried in its body goes silent about an engine that has
	// stopped being updated.
	for _, line := range []string{
		"OpenCode — update failed: npm error code EACCES",
		"OpenCode — update timed out after 5m0s",
	} {
		if !updateRunFailed([]string{"Claude Code — already up to date (2.1.221)", line}) {
			t.Errorf("a run containing %q should be reported as failed", line)
		}
	}
	// The deliberate outcomes are not failures — retrying them changes nothing, and a daily
	// warning about a choice Orbit made is how a real warning gets tuned out.
	for _, line := range []string{
		"Kimi Code — package-managed install, left alone",
		"OpenCode — owned by another user, left alone",
		"Codex — 2 sessions running, it'll update once they finish",
		"Claude Code — not reached, the update pass ran out of time",
		"Claude Code — already up to date (2.1.221)",
		"Claude Code updated 2.1.220 → 2.1.221",
	} {
		if updateRunFailed([]string{line}) {
			t.Errorf("%q is a deliberate outcome, not a failure", line)
		}
	}
	if updateRunFailed(nil) {
		t.Error("a run with nothing to report is not a failure")
	}
}
