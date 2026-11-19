package main

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"testing"
	"time"
)

// The heartbeat states, for each session whose run installed its probe, what is executing in it (session_executing.go):
// the engine turn and the subagents its events say, and the jobs and shells its tailer runs.

func TestTheExecutingFoldFollowsSubagentsAsTheControlPlaneDoes(t *testing.T) {
	f := newExecutingFold()
	ev := f.observe
	ev(evToolUse, map[string]interface{}{"id": "toolu_async", "name": "Agent"})
	ev(evToolUse, map[string]interface{}{"id": "toolu_sync", "name": "Task"})
	ev(evToolUse, map[string]interface{}{"id": "toolu_delegate", "name": "mcp__orbit__delegate"})
	ev(evToolUse, map[string]interface{}{"id": "toolu_nested", "name": "Agent", "parentToolUseId": "toolu_async"})
	ev(evToolUse, map[string]interface{}{"id": "toolu_bash", "name": "Bash"})
	ev(evToolResult, map[string]interface{}{"toolUseId": "toolu_async", "content": "Async agent launched successfully. agentId: a1"})
	ev(evToolResult, map[string]interface{}{"toolUseId": "toolu_delegate", "content": `{"runId":"r1","status":"running"}`})
	if _, got := f.read(true); !reflect.DeepEqual(got, []string{"toolu_async", "toolu_sync", "toolu_delegate"}) {
		t.Fatalf("after the launches, subagents = %v", got)
	}
	// A synchronous agent ends with its own result; an async one and a SubAgent with their terminal background_task.
	ev(evToolResult, map[string]interface{}{"toolUseId": "toolu_sync", "content": "done"})
	ev(evBackgroundTask, map[string]interface{}{"toolUseId": "toolu_async", "status": "completed"})
	if _, got := f.read(true); !reflect.DeepEqual(got, []string{"toolu_delegate"}) {
		t.Fatalf("after the ends, subagents = %v", got)
	}
	// A respawn handshake empties the set; the runner's own SubAgent is announced again behind it.
	ev(evToolUse, map[string]interface{}{"id": "toolu_wf", "name": "Workflow"})
	ev(evSystem, map[string]interface{}{"subtype": "resumed"})
	if _, got := f.read(true); len(got) != 0 {
		t.Fatalf("after a respawn, subagents = %v", got)
	}
	ev(evBackgroundTask, map[string]interface{}{"toolUseId": "toolu_delegate", "status": "running", "kind": "subagent", "subagentRunId": "r1"})
	ev(evToolUse, map[string]interface{}{"id": "toolu_wf", "name": "Workflow"})
	ev(evToolResult, map[string]interface{}{"toolUseId": "toolu_wf", "content": "Workflow launched in background. Task ID: w1"})
	if _, got := f.read(true); !reflect.DeepEqual(got, []string{"toolu_delegate", "toolu_wf"}) {
		t.Fatalf("after the re-announcement, subagents = %v", got)
	}
	// With no engine resident, what ran inside the engine is gone for good; the runner's SubAgent is not.
	if _, got := f.read(false); !reflect.DeepEqual(got, []string{"toolu_delegate"}) {
		t.Fatalf("with no engine, subagents = %v", got)
	}
	if _, got := f.read(true); !reflect.DeepEqual(got, []string{"toolu_delegate"}) {
		t.Fatalf("a later engine inherited %v", got)
	}
}

func TestTheExecutingFoldFollowsTheEngineTurn(t *testing.T) {
	f := newExecutingFold()
	if turn, _ := f.read(true); turn {
		t.Fatal("a fresh run reads as in a turn")
	}
	f.observe(evAssistant, map[string]interface{}{"text": "working"})
	if turn, _ := f.read(true); !turn {
		t.Fatal("assistant output did not start a turn")
	}
	// The runner's own `!cmd` and a SubAgent's events say nothing of the engine.
	f.observe(evTurnEnd, map[string]interface{}{})
	f.observe(evToolUse, map[string]interface{}{"id": "shell-1", "name": "Bash"})
	f.observe(evAssistant, map[string]interface{}{"subagentRunId": "r1"})
	if turn, _ := f.read(true); turn {
		t.Fatal("a turn_end did not end the turn, or a runner shell or SubAgent event started one")
	}
	f.observe(evToolResult, map[string]interface{}{"toolUseId": "toolu_x"})
	if turn, _ := f.read(false); turn {
		t.Fatal("with no engine resident there is no turn")
	}
	if turn, _ := f.read(true); turn {
		t.Fatal("the turn of an engine that went away came back")
	}
}

func TestTheTailerStatesItsJobsAndShells(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	bg := newBgTailer(ctx, (&bgJobEvents{}).emit, nil)
	t.Cleanup(func() {
		for _, job := range bg.listJobs(false) {
			bg.killJob(job.JobID, bgKillTeardownGrace)
		}
		bg.stopAll()
		cancel()
	})
	start := func(kind string) string {
		t.Helper()
		job, err := bg.startJob(bgJobSpec{Command: "exec sleep 300", Kind: kind, Dir: t.TempDir(), ScratchDir: t.TempDir()})
		if err != nil {
			t.Fatalf("a %s job was refused: %v", kind, err)
		}
		return job.JobID
	}
	job, service, watch, ended := start(bgKindJob), start(bgKindService), start(bgKindWatch), start(bgKindJob)
	bg.killJob(ended, bgKillTeardownGrace)
	awaitCondition(t, 10*time.Second, "the killed job never ended", func() bool {
		status, _ := bg.jobStatus(ended)
		return status.Status != bgStatusRunning
	})
	bg.noteEngineBackgroundShell("toolu_shell", "s1")
	bg.mu.Lock()
	bg.monitors["toolu_monitor"] = engineMonitor{taskID: "m1"}
	bg.mu.Unlock()

	jobs, shells := bg.executingSets()
	sort.Strings(jobs)
	sort.Strings(shells)
	wantJobs := []string{job, watch}
	sort.Strings(wantJobs)
	wantShells := []string{job, service, watch, "toolu_monitor", "toolu_shell"}
	sort.Strings(wantShells)
	if !reflect.DeepEqual(jobs, wantJobs) {
		t.Fatalf("jobs = %v, want %v (no service, no ended job)", jobs, wantJobs)
	}
	if !reflect.DeepEqual(shells, wantShells) {
		t.Fatalf("shells = %v, want %v", shells, wantShells)
	}
}

// The beat names every session whose run installed its probe, in id order, each set whole; a session with nothing
// executing is named with empty sets, a set too long to state is left out, and a run that ended is not named.
func TestTheHeartbeatStatesWhatIsExecutingPerSession(t *testing.T) {
	pool := newSessionPool(5)
	b := registerPoolSession(t, pool, "b", true)
	a := registerPoolSession(t, pool, "a", false)
	registerPoolSession(t, pool, "unprobed", false)
	var residentSeen []bool
	clearB := pool.setExecutingProbe(b, func(resident bool) executingSnapshot {
		residentSeen = append(residentSeen, resident)
		return executingSnapshot{engineTurnActive: true, subagents: []string{"toolu_z", "toolu_y"}, jobs: []string{"bgj_1"}, shells: []string{"bgj_1", "toolu_s"}}
	})
	many := make([]string, executingIDsMax+1)
	for i := range many {
		many[i] = fmt.Sprintf("toolu_%d", i)
	}
	pool.setExecutingProbe(a, func(bool) executingSnapshot { return executingSnapshot{shells: many} })

	beat := func() (HeartbeatRequest, map[string]json.RawMessage) {
		t.Helper()
		var sent HeartbeatRequest
		if _, _, err := sendHeartbeatCycle(pool, newHeartbeatTelemetryProbe(time.Hour, nil), HeartbeatRequest{},
			func(r HeartbeatRequest) (*HeartbeatResponse, error) { sent = r; return &HeartbeatResponse{}, nil }); err != nil {
			t.Fatal(err)
		}
		raw, err := json.Marshal(sent)
		if err != nil {
			t.Fatal(err)
		}
		var body map[string]json.RawMessage
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatal(err)
		}
		return sent, body
	}

	_, body := beat()
	want := `[{"sessionId":"a","engineTurnActive":false,"subagents":[],"jobs":[]},` +
		`{"sessionId":"b","engineTurnActive":true,"subagents":["toolu_y","toolu_z"],"jobs":["bgj_1"],"shells":["bgj_1","toolu_s"]}]`
	if got := string(body["executing"]); got != want {
		t.Fatalf("executing =\n  %s\nwant\n  %s", got, want)
	}
	if !reflect.DeepEqual(residentSeen, []bool{false}) {
		t.Fatalf("the probe was told resident %v, want [false]: no engine was started", residentSeen)
	}

	// A run that ended is not named; with no run probed, the member is left out, as an older runner leaves it.
	clearB()
	pool.setExecutingProbe(a, nil)
	sent, body := beat()
	if _, ok := body["executing"]; ok || sent.Executing != nil {
		t.Fatalf("with no probe, the body carries executing: %s", body["executing"])
	}
}

// The beat names at most executingSessionsMax sessions.
func TestTheHeartbeatBoundsTheSessionsItStates(t *testing.T) {
	pool := newSessionPool(executingSessionsMax + 10)
	for i := 0; i < executingSessionsMax+10; i++ {
		s := registerPoolSession(t, pool, fmt.Sprintf("s%04d", i), false)
		pool.setExecutingProbe(s, func(bool) executingSnapshot { return executingSnapshot{} })
	}
	entries := pool.executingEntries()
	if len(entries) != executingSessionsMax || entries[0].SessionID != "s0000" {
		t.Fatalf("%d entries from %s, want %d from s0000", len(entries), entries[0].SessionID, executingSessionsMax)
	}
}

// The beat says when its sets were composed, read before any probe is: a change a probe misses happens after that
// instant, so the TS of the event that reports it is no earlier, which is what lets the control plane keep a batch over
// an older beat. With nothing probed, the instant is left out with the sets.
func TestTheHeartbeatStampsItsExecutingBeforeReadingProbes(t *testing.T) {
	pool := newSessionPool(2)
	s := registerPoolSession(t, pool, "s", false)
	var probedAt int64
	clear := pool.setExecutingProbe(s, func(bool) executingSnapshot {
		time.Sleep(2 * time.Millisecond)
		probedAt = time.Now().UnixMilli()
		return executingSnapshot{}
	})
	beat := func() (HeartbeatRequest, map[string]json.RawMessage) {
		t.Helper()
		var sent HeartbeatRequest
		if _, _, err := sendHeartbeatCycle(pool, newHeartbeatTelemetryProbe(time.Hour, nil), HeartbeatRequest{},
			func(r HeartbeatRequest) (*HeartbeatResponse, error) { sent = r; return &HeartbeatResponse{}, nil }); err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(sent)
		var body map[string]json.RawMessage
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatal(err)
		}
		return sent, body
	}
	before := time.Now().UnixMilli()
	sent, body := beat()
	if sent.ExecutingAt < before || sent.ExecutingAt >= probedAt {
		t.Fatalf("executingAt = %d, want in [%d, %d): taken before the probe was read", sent.ExecutingAt, before, probedAt)
	}
	if _, ok := body["executingAt"]; !ok {
		t.Fatalf("the body carries no executingAt: %v", body)
	}
	// An event emitted after the probe read is stamped no earlier than the beat's instant.
	if ts, err := time.Parse(time.RFC3339Nano, nowISO()); err != nil || ts.UnixMilli() < sent.ExecutingAt {
		t.Fatalf("an event after the beat is stamped %v (%v), before executingAt %d", ts, err, sent.ExecutingAt)
	}

	clear()
	sent, body = beat()
	if _, ok := body["executingAt"]; ok || sent.ExecutingAt != 0 {
		t.Fatalf("with no probe, the body carries executingAt %d", sent.ExecutingAt)
	}
}
