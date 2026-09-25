package main

import (
	"context"
	"strings"
	"testing"
)

// The frames Claude Code 2.1.282 emits for a background workflow, trimmed to the fields it sends
// (the shapes are the CLI's own `task_started` / `task_progress` emitters).
func workflowStartedFrame() map[string]interface{} {
	return map[string]interface{}{
		"type": "system", "subtype": "task_started", "session_id": "s1",
		"task_id": "w2f3yv1s8", "tool_use_id": "toolu_wf", "description": "Review: 3 designs, 2 judges",
		"task_type": "local_workflow", "workflow_name": "orbit-knowledge-form-and-api",
		"prompt": strings.Repeat("the whole script ", 500),
	}
}

func workflowProgressFrame() map[string]interface{} {
	agent := func(index float64, label, state string, tokens, calls float64) map[string]interface{} {
		return map[string]interface{}{
			"type": "workflow_agent", "index": index, "label": label, "phaseIndex": float64(1),
			"phaseTitle": "Design", "state": state, "tokens": tokens, "toolCalls": calls,
			"lastToolName": "Bash", "lastToolSummary": strings.Repeat("grep -rn wiki ", 40),
			"promptPreview": strings.Repeat("a long prompt ", 200), "resultPreview": "# Design",
			"queuedAt": float64(1790000000000), "lastProgressAt": float64(1790000060000),
		}
	}
	progress := []interface{}{
		map[string]interface{}{"type": "workflow_phase", "index": float64(0), "title": "Ground", "kind": "parallel"},
		map[string]interface{}{"type": "workflow_phase", "index": float64(1), "title": "Design"},
		agent(4, "design:page-wiki", "done", 412000, 34),
		agent(5, "design:typed-records", "running", 380000, 29),
	}
	for i := 0; i < 5; i++ {
		progress = append(progress, map[string]interface{}{"type": "workflow_log", "message": "log line"})
	}
	return map[string]interface{}{
		"type": "system", "subtype": "task_progress", "session_id": "s1",
		"task_id": "w2f3yv1s8", "tool_use_id": "toolu_wf", "description": "Review: 3 designs, 2 judges",
		"usage":          map[string]interface{}{"total_tokens": float64(792000), "tool_uses": float64(63), "duration_ms": float64(780000)},
		"last_tool_name": "Bash", "workflow_progress": progress,
	}
}

func TestTaskProgressIsRelayedLiveInsteadOfAsAPing(t *testing.T) {
	emit, got := collect()
	bg := newBgTailer(context.Background(), emit, nil)
	defer bg.stopAll()

	handleMessage(workflowStartedFrame(), emit, bg)
	handleMessage(workflowProgressFrame(), emit, bg)

	if len(*got) != 2 || (*got)[0].typ != evTaskProgress || (*got)[1].typ != evTaskProgress {
		t.Fatalf("want two task_progress events and no system ping, got %v", *got)
	}
	p := (*got)[1].payload
	if p["toolUseId"] != "toolu_wf" || p["taskId"] != "w2f3yv1s8" {
		t.Fatalf("not keyed to the launching call: %v", p)
	}
	// task_progress never repeats what task_started said; a client joining mid-run still gets it.
	if p["taskType"] != "local_workflow" || p["workflowName"] != "orbit-knowledge-form-and-api" {
		t.Fatalf("the started frame's facts were not carried forward: %v", p)
	}
	usage, _ := p["usage"].(map[string]interface{})
	if usage["totalTokens"] != 792000 || usage["toolUses"] != 63 || usage["durationMs"] != 780000 {
		t.Fatalf("usage = %v", usage)
	}
	agents, _ := p["agents"].([]interface{})
	phases, _ := p["phases"].([]interface{})
	if len(agents) != 2 || len(phases) != 2 {
		t.Fatalf("agents=%v phases=%v", agents, phases)
	}
	a := agents[1].(map[string]interface{})
	if a["label"] != "design:typed-records" || a["state"] != "running" || a["toolCalls"] != float64(29) ||
		a["phaseTitle"] != "Design" || a["phaseIndex"] != float64(1) {
		t.Fatalf("agent row lost what it shows: %v", a)
	}
	if _, kept := a["promptPreview"]; kept {
		t.Fatalf("prompt previews must stay behind: %v", a)
	}
	if n := len([]rune(a["lastToolSummary"].(string))); n > 161 {
		t.Fatalf("lastToolSummary not clipped: %d runes", n)
	}
	if logs, _ := p["logs"].([]string); len(logs) != taskProgressMaxLogs {
		t.Fatalf("logs = %v", p["logs"])
	}
	if _, kept := (*got)[0].payload["prompt"]; kept {
		t.Fatalf("the workflow script must not ride the started frame: %v", (*got)[0].payload)
	}
}

// Nothing on a client can place a frame without the launching call's id, so it stays what it was.
func TestTaskProgressWithoutAToolUseIdStaysABarePing(t *testing.T) {
	emit, got := collect()
	frame := workflowProgressFrame()
	delete(frame, "tool_use_id")

	handleMessage(frame, emit, nil)

	if len(*got) != 1 || (*got)[0].typ != evSystem || len((*got)[0].payload) != 3 {
		t.Fatalf("want the bare three-key system ping, got %v", *got)
	}
}

// The live frames are never stored, so the durable event that ends the task carries the last one:
// after a reload, which agents ran and how far each got is still there.
func TestTheEndOfATaskCarriesItsLastProgress(t *testing.T) {
	emit, got := collect()
	bg := newBgTailer(context.Background(), emit, nil)
	defer bg.stopAll()
	handleMessage(workflowStartedFrame(), emit, bg)
	handleMessage(workflowProgressFrame(), emit, bg)

	bgTaskFromNotification(taskNotif("w2f3yv1s8", "toolu_wf", "completed"), emit, bg)

	last := (*got)[len(*got)-1]
	if last.typ != evBackgroundTask {
		t.Fatalf("want the background_task last, got %v", last)
	}
	p, _ := last.payload["progress"].(map[string]interface{})
	if agents, _ := p["agents"].([]interface{}); len(agents) != 2 || p["taskType"] != "local_workflow" {
		t.Fatalf("the ending lost the progress: %v", last.payload)
	}
	// Handed over once: the same ending re-delivered by the transcript tail carries nothing more.
	if bg.takeTaskProgress("toolu_wf") != nil {
		t.Fatal("the progress outlived the task it described")
	}
}
