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

// A workflow on the real supervisor, its calls run by the scripted child engine of subagent_lifecycle_test.go
// against the stub control plane of session_pool_self_driven_turn_test.go.

const twoCallWorkflow = `export const meta = { name: 'two', description: 'two calls', phases: [{ title: 'Write' }] }
phase('Write')
const results = await parallel([() => agent('write one', { label: 'one' }), () => agent('write two', { label: 'two' })])
log('both returned')
return results
`

func (r *subagentRig) startWorkflow(script string) workflowReport {
	r.t.Helper()
	waitUntil(r.t, func() bool { _, err := os.Stat(bgTokenPath(r.job.SessionID)); return err == nil },
		"the session's job socket never came up")
	token, _ := os.ReadFile(bgTokenPath(r.job.SessionID))
	raw, err := bgSocketCall(bgSocketPath(r.job.SessionID), string(token), "workflow_start", map[string]interface{}{
		"toolUseId": "toolu_workflow", "description": "run two calls", "script": script,
	})
	if err != nil {
		r.t.Fatalf("workflow_start: %v", err)
	}
	var report workflowReport
	if err := json.Unmarshal(raw, &report); err != nil || report.WorkflowRunID == "" {
		r.t.Fatalf("workflow_start answered %s", raw)
	}
	return report
}

func (r *subagentRig) awaitWorkflowReport() map[string]interface{} {
	r.t.Helper()
	var found map[string]interface{}
	waitUntil(r.t, func() bool {
		r.mu.Lock()
		defer r.mu.Unlock()
		if len(r.workflowReports) > 0 {
			found = r.workflowReports[0]
			return true
		}
		return false
	}, "the runner never reported the workflow's end")
	return found
}

// The session's limit (here 1) holds the second call back until the first ends; both then run as SubAgents
// owing no wake of their own, and the workflow's end is reported once, owing the parent its one wake, and clears
// the workflow call from the running set.
func TestWorkflowRunsItsCallsWithinTheLimitAndOwesOneWake(t *testing.T) {
	retry := workflowLimitRetry
	workflowLimitRetry = 50 * time.Millisecond
	t.Cleanup(func() { workflowLimitRetry = retry })

	pool := newSessionPoolWithClock(1, newFakePoolClock())
	s := superviseClaudeSession(t, pool, oneTurn()...)
	s.awaitParked("turn-1")
	s.mu.Lock()
	s.subagentLimit = 1
	s.mu.Unlock()
	r := installSubagentChild(t, s)
	started := r.startWorkflow(twoCallWorkflow)

	waitUntil(t, func() bool { _, err := os.Stat(filepath.Join(r.marks, "started")); return err == nil },
		"the first call's child engine never started")
	waitUntil(t, func() bool { r.mu.Lock(); defer r.mu.Unlock(); return r.subagentRefusals > 0 },
		"the second call never met the session's limit")
	r.mu.Lock()
	opened := r.subagentsOpened
	r.mu.Unlock()
	if opened != 1 {
		t.Fatalf("%d SubAgents opened while the limit is 1", opened)
	}

	r.finishChild()
	end := r.awaitWorkflowReport()
	if end["workflowRunId"] != started.WorkflowRunID || end["status"] != subagentStatusDone || end["wake"] != true ||
		end["callsDone"] != float64(2) || end["callsFailed"] != float64(0) {
		t.Fatalf("the workflow's end was reported as %v", end)
	}
	var results []string
	if err := json.Unmarshal([]byte(asString(end["result"])), &results); err != nil || len(results) != 2 ||
		!strings.Contains(results[0], "half.txt is written") {
		t.Fatalf("the workflow returned %v (%v)", end["result"], err)
	}

	r.mu.Lock()
	bodies := append([]map[string]interface{}(nil), r.subagentOpenBodies...)
	workflowOpen := r.workflowOpens[0]
	r.mu.Unlock()
	if workflowOpen["name"] != "two" || workflowOpen["toolUseId"] != "toolu_workflow" || workflowOpen["description"] != "run two calls" {
		t.Fatalf("the workflow opened as %v", workflowOpen)
	}
	if len(bodies) != 2 {
		t.Fatalf("%d SubAgents opened, want 2", len(bodies))
	}
	indexes := map[float64]bool{}
	for _, b := range bodies {
		indexes[b["callIndex"].(float64)] = true
		if b["workflowRunId"] != started.WorkflowRunID || b["phase"] != "Write" || b["background"] != false ||
			!strings.HasPrefix(asString(b["toolUseId"]), "toolu_workflow#") {
			t.Fatalf("a call opened as %v", b)
		}
	}
	if !indexes[0] || !indexes[1] {
		t.Fatalf("call indexes %v", indexes)
	}
	for _, report := range r.reports() {
		if report["wake"] == true {
			t.Fatalf("a workflow's call owed a wake of its own: %v", report)
		}
	}
	// Each call drawn as a delegate call nested under the workflow call, and ended with its result.
	r.awaitEvents("the calls' nested tool_use", 2, func(e RunEvent) bool {
		return e.Type == evToolUse && e.Payload["name"] == delegateEngineToolName && e.Payload["parentToolUseId"] == "toolu_workflow"
	})
	r.awaitEvents("the calls' nested tool_result", 2, func(e RunEvent) bool {
		return e.Type == evToolResult && e.Payload["parentToolUseId"] == "toolu_workflow" && e.Payload["isError"] == false
	})
	r.awaitEvents("the log line", 1, func(e RunEvent) bool {
		return e.Type == evAssistant && e.Payload["text"] == "both returned" && e.Payload["parentToolUseId"] == "toolu_workflow"
	})
	r.awaitEvents("the workflow call's terminal background_task", 1, func(e RunEvent) bool {
		return e.Type == evBackgroundTask && e.Payload["toolUseId"] == "toolu_workflow" && e.Payload["status"] == bgStatusCompleted
	})
	if n := r.countEvents(func(e RunEvent) bool {
		return e.Type == evBackgroundTask && strings.HasPrefix(asString(e.Payload["toolUseId"]), "toolu_workflow#")
	}); n != 0 {
		t.Fatalf("%d background_task events for the workflow's calls: they are not the running set's", n)
	}
}

// The runner stops mid-workflow: its running call is interrupted, and the workflow is reported INTERRUPTED,
// owing the parent the wake, while the call owes none.
func TestWorkflowInterruptedByRunnerStopOwesTheWake(t *testing.T) {
	grace := subagentStopGrace
	subagentStopGrace = 300 * time.Millisecond
	t.Cleanup(func() { subagentStopGrace = grace })

	pool := newSessionPoolWithClock(1, newFakePoolClock())
	shutdown, stop := context.WithCancel(context.Background())
	defer stop()
	s := superviseClaudeSessionUntil(t, pool, t.TempDir(), shutdown, oneTurn()...)
	s.awaitParked("turn-1")
	r := installSubagentChild(t, s)
	r.startWorkflow(`export const meta = { name: 'one', description: 'one call' }
return await agent('write one')`)
	waitUntil(t, func() bool { _, err := os.Stat(filepath.Join(r.marks, "started")); return err == nil },
		"the call's child engine never started")

	stop()
	end := r.awaitWorkflowReport()
	if end["status"] != subagentStatusInterrupted || end["wake"] != true || !strings.Contains(asString(end["error"]), "runner process hosting it stopped") {
		t.Fatalf("the workflow's end was reported as %v", end)
	}
	call := r.awaitReport(subagentStatusInterrupted)
	if call["wake"] == true {
		t.Fatalf("the interrupted call owed a wake of its own: %v", call)
	}
	waitUntil(t, func() bool { return !childAlive(t, r.marks) }, "the call's child engine outlived the runner's stop")
}
