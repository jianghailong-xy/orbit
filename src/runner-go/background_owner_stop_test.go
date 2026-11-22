//go:build linux || darwin

package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The owner's stop of one bg_run job from the app reaches the runner as a heartbeat's
// stopBackgroundJobs (background_owner_stop.go). It kills the job as bg_kill does, but under its own
// reason: the job's record, its terminal background_task and its wake all say a person stopped it,
// while the agent's own bg_kill beside it keeps "requested" and wakes nobody. A repeat of the stop,
// and a stop naming a job or a session this runner does not have, change nothing.
func TestTheOwnersStopKillsTheJobAndItsWakeSaysAPersonStoppedIt(t *testing.T) {
	job := runnerStopJob(t, "sess-owner-stop")
	api := newWakeControlPlane()
	superviseParkedSession(t, job, api)

	stopped := bgRunWith(t, job.SessionID, map[string]interface{}{
		"command": "exec sleep 300", "kind": "job", "wakeOnExit": true, "description": "a long sleep",
	})
	killedByAgent := bgRunWith(t, job.SessionID, map[string]interface{}{
		"command": "exec sleep 300", "kind": "job", "wakeOnExit": true,
	})

	stopBackgroundJobsForOwner([]BgJobStopCommand{
		{SessionID: job.SessionID, JobID: stopped.JobID},
		// Neither of these is anything here: the first names no job of the session, the second no session.
		{SessionID: job.SessionID, JobID: "bgj_nosuchjob0"},
		{SessionID: "sess-not-on-this-runner", JobID: stopped.JobID},
	})
	bgCall(t, job.SessionID, "kill", map[string]interface{}{"jobId": killedByAgent.JobID})

	awaitCondition(t, 30*time.Second, "the stopped job's end never reached the control plane", func() bool {
		return len(api.terminalReports(stopped.JobID)) > 0 && len(api.terminalReports(killedByAgent.JobID)) > 0
	})
	end := api.terminalReports(stopped.JobID)[0]
	if got := asString(end["status"]); got != bgStatusKilled {
		t.Errorf("the stopped job ended %q, want killed", got)
	}
	if got := asString(end["reason"]); got != bgStoppedByOwnerReason {
		t.Errorf("the stopped job's terminal background_task says reason %q, want %q", got, bgStoppedByOwnerReason)
	}
	if got := asString(api.terminalReports(killedByAgent.JobID)[0]["reason"]); got != "requested" {
		t.Errorf("the agent's bg_kill says reason %q, want requested", got)
	}

	// The wake: the agent did not ask for this kill, so a job that asked to be woken when it exits is.
	awaitCondition(t, 30*time.Second, "the owner's stop woke nobody", func() bool {
		return len(api.wakesFor(stopped.JobID)) > 0
	})
	wake := api.wakesFor(stopped.JobID)[0]
	if got := asString(wake["trigger"]); got != bgWakeOnExit {
		t.Errorf("wake trigger = %q, want exit", got)
	}
	if got := asString(wake["status"]); got != bgStatusKilled {
		t.Errorf("wake status = %q, want killed", got)
	}
	if got := asString(wake["reason"]); got != bgStoppedByOwnerReason {
		t.Errorf("wake reason = %q, want %q", got, bgStoppedByOwnerReason)
	}

	// The runner's own record of the job, as bg_list reads it.
	var listed struct {
		Jobs []bgJobStatus `json:"jobs"`
	}
	if raw := bgCall(t, job.SessionID, "list", map[string]interface{}{"includeFinished": true}); json.Unmarshal(raw, &listed) != nil {
		t.Fatalf("bg_list result: %s", raw)
	}
	reasons := map[string]string{}
	for _, j := range listed.Jobs {
		reasons[j.JobID] = j.Status + "/" + j.Reason
	}
	if got := reasons[stopped.JobID]; got != bgStatusKilled+"/"+bgStoppedByOwnerReason {
		t.Errorf("bg_list says the stopped job is %q, want killed/%s", got, bgStoppedByOwnerReason)
	}
	if got := reasons[killedByAgent.JobID]; got != bgStatusKilled+"/requested" {
		t.Errorf("bg_list says the agent's kill is %q, want killed/requested", got)
	}

	// The heartbeat lists the stop again until the control plane hears the job ended: a repeat ends
	// nothing twice, renames nothing, and wakes nobody again.
	stopBackgroundJobsForOwner([]BgJobStopCommand{
		{SessionID: job.SessionID, JobID: stopped.JobID},
		{SessionID: job.SessionID, JobID: killedByAgent.JobID},
	})
	time.Sleep(2 * time.Second)
	if got := len(api.terminalReports(stopped.JobID)); got != 1 {
		t.Errorf("terminal reports of the stopped job after a repeat = %d, want 1", got)
	}
	if got := asString(api.terminalReports(killedByAgent.JobID)[0]["reason"]); got != "requested" {
		t.Errorf("a stop after the agent's bg_kill renamed it %q", got)
	}
	if got := len(api.wakesFor(stopped.JobID)); got != 1 {
		t.Errorf("wakes for the stopped job = %d, want exactly one", got)
	}
	if got := api.wakesFor(killedByAgent.JobID); len(got) != 0 {
		t.Errorf("the agent's own kill woke the session that killed it: %v", got)
	}
}

// A stop that lands while the job is already being killed keeps the reason it is being killed for.
func TestAJobAlreadyBeingKilledKeepsItsReason(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	bg := newBgTailer(ctx, func(string, map[string]interface{}) {}, nil)
	t.Cleanup(bg.stopAll)
	// The owner's stop arrives once the agent's kill has named the job's end, whether or not its
	// process has gone yet: either way the kill stays the agent's.
	status, err := bg.startJob(bgJobSpec{
		Command: "exec sleep 300", Kind: bgKindJob, Dir: t.TempDir(), ScratchDir: t.TempDir(),
	})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = bg.killJob(status.JobID, bgKillTeardownGrace)
	}()
	awaitCondition(t, 5*time.Second, "the agent's kill never began", func() bool {
		bg.mu.Lock()
		defer bg.mu.Unlock()
		return bg.jobs[status.JobID].killReason != ""
	})
	if _, err := bg.killJobFor(status.JobID, bgKillTeardownGrace, bgStoppedByOwnerReason); err != nil {
		t.Fatal(err)
	}
	<-done
	got, _ := bg.jobStatus(status.JobID)
	if got.Status != bgStatusKilled || got.Reason != "requested" {
		t.Errorf("job = %s/%s, want killed/requested: the first ask names the kill", got.Status, got.Reason)
	}
	if _, err := bg.killJobFor("bgj_nosuchjob0", time.Second, bgStoppedByOwnerReason); err == nil {
		t.Error("a stop of a job this tailer never started was not refused")
	}
}

// The runner declares the stop under the name the control plane checks, and names the kill with the
// reason the control plane glosses.
func TestTheRunnerDeclaresTheOwnersJobStop(t *testing.T) {
	if !strings.Contains(","+runnerCapabilitiesV1+",", ","+bgOwnerStopCapabilityV1+",") {
		t.Fatalf("this runner does not declare %s: %q", bgOwnerStopCapabilityV1, runnerCapabilitiesV1)
	}
	shared, err := os.ReadFile(filepath.Join("..", "shared", "src", "dto.ts"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"BG_OWNER_STOP_V1 = '" + bgOwnerStopCapabilityV1 + "'",
		"BG_JOB_STOPPED_BY_OWNER = '" + bgStoppedByOwnerReason + "'",
	} {
		if !strings.Contains(string(shared), want) {
			t.Errorf("@orbit/shared does not say %s", want)
		}
	}
}
