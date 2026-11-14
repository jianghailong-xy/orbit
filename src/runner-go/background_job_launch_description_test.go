package main

import (
	"context"
	"sync"
	"testing"
)

// A bg_run job's launch is a Bash tool_use the runner writes itself. The Background
// processes tray titles a row with that call's description, so a job launched with
// one must carry it, or the tray shows its bgj_ id instead of its name.
func TestRunnerJobLaunchCarriesDescription(t *testing.T) {
	pool := newSessionPoolWithClock(1, newFakePoolClock())
	registerPoolSession(t, pool, "launchdesc", true)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var mu sync.Mutex
	inputs := map[string]map[string]interface{}{}
	emit := func(eventType string, payload map[string]interface{}) {
		if eventType != evToolUse {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		input, _ := payload["input"].(map[string]interface{})
		inputs[asString(payload["id"])] = input
	}
	bg := newBgTailer(ctx, emit, pool.worktreeHoldsFor("launchdesc"))
	t.Cleanup(func() {
		for _, job := range bg.listJobs(false) {
			bg.killJob(job.JobID, bgKillTeardownGrace)
		}
		bg.stopAll()
	})

	dir := t.TempDir()
	named, err := bg.startJob(bgJobSpec{Command: "true", Kind: bgKindJob, Dir: dir, ScratchDir: dir, Description: "Run web tests"})
	if err != nil {
		t.Fatalf("starting the described job: %v", err)
	}
	unnamed, err := bg.startJob(bgJobSpec{Command: "true", Kind: bgKindJob, Dir: dir, ScratchDir: dir})
	if err != nil {
		t.Fatalf("starting the undescribed job: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if got := asString(inputs[named.JobID]["description"]); got != "Run web tests" {
		t.Fatalf("launch input description = %q, want %q (input %v)", got, "Run web tests", inputs[named.JobID])
	}
	if _, has := inputs[unnamed.JobID]["description"]; has {
		t.Fatalf("a job without a description launched with one: %v", inputs[unnamed.JobID])
	}
	if inputs[named.JobID]["run_in_background"] != true || asString(inputs[named.JobID]["command"]) != "true" {
		t.Fatalf("launch input lost its command or run_in_background: %v", inputs[named.JobID])
	}
}
