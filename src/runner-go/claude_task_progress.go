package main

// How far a background agent or workflow has got, relayed while it runs.
//
// Claude Code reports that on two `system` frames: `task_started` when an Agent or Workflow call
// starts its work (task_type, workflow_name, description), and `task_progress` every time that work
// moves (usage, last tool, and for a workflow its whole `workflow_progress`: the phases, and per
// agent its label, phase, state, tokens and tool calls). handleMessage used to forward every system
// frame as the bare {subtype, model, sessionId}, which the control plane rightly drops as noise
// (apiserver common/system-noise.ts) — so a workflow running twenty agents for half an hour showed
// nothing at all between its launch receipt and its completion.
//
// These frames now travel as their own live-only event, keyed by the launching call's tool_use id
// so the clients can hang them on that call. Live-only because they are frequent (one per agent
// tool call) and each one restates everything: persisting them would starve every transcript page
// the way the old pings did. What survives a reload is the last one, attached to the durable
// background_task that ends the task (bgTaskFromNotification).
//
// Compacted on the way through: prompt and result previews are dropped, text is clipped and the
// lists are capped, so a frame stays a few KB however large the workflow.

const (
	taskProgressMaxAgents = 64
	taskProgressMaxPhases = 32
	taskProgressMaxLogs   = 3
)

// taskProgressPayload is the relayed event for a `task_started`/`task_progress` frame, or nil for
// any other message and for a frame with no tool_use id (nothing on the client to hang it on).
func taskProgressPayload(msg map[string]interface{}) map[string]interface{} {
	subtype, _ := msg["subtype"].(string)
	if subtype != "task_started" && subtype != "task_progress" {
		return nil
	}
	toolUseID := asString(msg["tool_use_id"])
	if toolUseID == "" {
		return nil
	}
	p := map[string]interface{}{"toolUseId": toolUseID}
	putString := func(key, wireKey string, max int) {
		if s := asString(msg[wireKey]); s != "" {
			p[key] = clip(s, max)
		}
	}
	putString("taskId", "task_id", 64)
	putString("taskType", "task_type", 40)
	putString("description", "description", 200)
	putString("workflowName", "workflow_name", 120)
	putString("subagentType", "subagent_type", 60)
	putString("lastToolName", "last_tool_name", 60)
	putString("summary", "summary", 300)
	if u, ok := msg["usage"].(map[string]interface{}); ok {
		p["usage"] = map[string]interface{}{
			"totalTokens": toInt(u["total_tokens"]),
			"toolUses":    toInt(u["tool_uses"]),
			"durationMs":  toInt(u["duration_ms"]),
		}
	}
	if entries, ok := msg["workflow_progress"].([]interface{}); ok {
		var phases, agents []interface{}
		var logs []string
		for _, e := range entries {
			entry, _ := e.(map[string]interface{})
			switch entry["type"] {
			case "workflow_phase":
				if len(phases) < taskProgressMaxPhases {
					phases = append(phases, map[string]interface{}{
						"index": toInt(entry["index"]),
						"title": clip(asString(entry["title"]), 80),
					})
				}
			case "workflow_agent":
				if len(agents) < taskProgressMaxAgents {
					agents = append(agents, workflowAgentPayload(entry))
				}
			case "workflow_log":
				if m := asString(entry["message"]); m != "" {
					logs = append(logs, clip(m, 200))
				}
			}
		}
		if len(logs) > taskProgressMaxLogs {
			logs = logs[len(logs)-taskProgressMaxLogs:]
		}
		p["phases"] = nonNilList(phases)
		p["agents"] = nonNilList(agents)
		if len(logs) > 0 {
			p["logs"] = logs
		}
	}
	return p
}

// workflowAgentPayload keeps what a row about one agent shows: who it is, where it is, how much it
// has done and what it is doing now. Its prompt and result previews stay behind.
func workflowAgentPayload(entry map[string]interface{}) map[string]interface{} {
	a := map[string]interface{}{"index": toInt(entry["index"])}
	for key, max := range map[string]int{
		"label": 80, "phaseTitle": 80, "state": 20, "model": 60, "lastToolName": 60,
		"lastToolSummary": 160, "lastAttemptReason": 40, "error": 240,
	} {
		if s := asString(entry[key]); s != "" {
			a[key] = clip(s, max)
		}
	}
	for _, key := range []string{"phaseIndex", "tokens", "toolCalls", "attempt", "startedAt", "lastProgressAt"} {
		if v, ok := entry[key].(float64); ok {
			a[key] = v
		}
	}
	for _, key := range []string{"cached", "blocked"} {
		if b, ok := entry[key].(bool); ok && b {
			a[key] = true
		}
	}
	return a
}

func nonNilList(l []interface{}) []interface{} {
	if l == nil {
		return []interface{}{}
	}
	return l
}

// noteTaskProgress folds one frame into the task's latest progress and returns what to relay:
// the whole picture so far, since `task_progress` frames do not repeat what `task_started` said
// (task_type, workflow_name), and a client that joins mid-run gets everything from any one frame.
func (b *bgTailer) noteTaskProgress(p map[string]interface{}) map[string]interface{} {
	id := asString(p["toolUseId"])
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.progress == nil {
		b.progress = map[string]map[string]interface{}{}
	}
	merged := map[string]interface{}{}
	for k, v := range b.progress[id] {
		merged[k] = v
	}
	for k, v := range p {
		merged[k] = v
	}
	b.progress[id] = merged
	out := make(map[string]interface{}, len(merged))
	for k, v := range merged {
		out[k] = v
	}
	return out
}

// takeTaskProgress hands over — and forgets — the last progress relayed for a task, for the
// durable event that ends it.
func (b *bgTailer) takeTaskProgress(toolUseID string) map[string]interface{} {
	b.mu.Lock()
	defer b.mu.Unlock()
	p := b.progress[toolUseID]
	delete(b.progress, toolUseID)
	return p
}
