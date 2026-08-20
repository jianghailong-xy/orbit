package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"unicode/utf8"
)

func TestNormalizeCodexReasoningEffort(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "empty", in: "", want: ""},
		{name: "max passes through", in: "max", want: "max"},
		{name: "xhigh passes through", in: "xhigh", want: "xhigh"},
		{name: "ultra passes through", in: "ultra", want: "ultra"},
		{name: "minimal passes through", in: "minimal", want: "minimal"},
		{name: "unknown falls back to default", in: "project-custom", want: ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := normalizeCodexReasoningEffort(tt.in); got != tt.want {
				t.Fatalf("normalizeCodexReasoningEffort(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func assertCodexOrbitMCPContextForwarded(t *testing.T, args []string) {
	t.Helper()
	want := `mcp_servers.orbit.env_vars=["ORBIT_HOME","ORBIT_SESSION_ID","ORBIT_AGENT_ID","ORBIT_TASK_ID","ORBIT_ALLOW_ORCHESTRATION","ORBIT_MCP_PERMISSION_PROMPT"]`
	for i, arg := range args {
		if arg == want {
			if i == 0 || args[i-1] != "-c" {
				t.Fatalf("Orbit MCP env_vars config is not a -c value: %v", args)
			}
			return
		}
	}
	t.Fatalf("args do not forward the full Orbit MCP context: %v", args)
}

func TestCodexExecArgsForwardOrbitMCPContext(t *testing.T) {
	job := &ClaimedSession{Agent: AgentExecConfig{Model: "gpt-5.5"}}
	args := codexExecCommandArgs(job, "/repo", "/tmp/uploads", nil, "/usr/local/bin/orbit")
	assertCodexOrbitMCPContextForwarded(t, args)
}

func TestCodexAppServerArgsForwardOrbitMCPContext(t *testing.T) {
	job := &ClaimedSession{Agent: AgentExecConfig{Model: "gpt-5.5"}}
	args := codexAppServerCommandArgs(job, "/tmp/codex-state", "/usr/local/bin/orbit")
	assertCodexOrbitMCPContextForwarded(t, args)
}

func TestCodexAppServerThreadParams(t *testing.T) {
	job := &ClaimedSession{Agent: AgentExecConfig{Model: "gpt-5.5"}}
	got := codexThreadParams(job, "/repo", "/tmp/uploads")
	if got["cwd"] != "/repo" {
		t.Fatalf("cwd = %v", got["cwd"])
	}
	if got["model"] != "gpt-5.5" {
		t.Fatalf("model = %v", got["model"])
	}
	if got["approvalPolicy"] != "never" {
		t.Fatalf("approvalPolicy = %v", got["approvalPolicy"])
	}
	if got["sandbox"] != "danger-full-access" {
		t.Fatalf("sandbox = %v", got["sandbox"])
	}
	if _, ok := got["developerInstructions"]; ok {
		t.Fatalf("thread params must not replace effective developer instructions: %q", got["developerInstructions"])
	}
	if _, ok := got["baseInstructions"]; ok {
		t.Fatalf("baseInstructions should be absent without a system prompt: %q", got["baseInstructions"])
	}
	roots, ok := got["runtimeWorkspaceRoots"].([]string)
	if !ok || len(roots) != 2 || roots[0] != "/repo" || roots[1] != "/tmp/uploads" {
		t.Fatalf("runtimeWorkspaceRoots = %#v", got["runtimeWorkspaceRoots"])
	}
}

func TestCodexAppServerThreadParamsForwardSystemInstructions(t *testing.T) {
	job := &ClaimedSession{Agent: AgentExecConfig{
		SystemPrompt:       "Base agent instructions.",
		AppendSystemPrompt: "Owner developer instructions.",
	}}
	got := codexThreadParams(job, "/repo", "/tmp/uploads")
	if got["baseInstructions"] != "Base agent instructions." {
		t.Fatalf("baseInstructions = %q", got["baseInstructions"])
	}
	if _, ok := got["developerInstructions"]; ok {
		t.Fatalf("developerInstructions unexpectedly overrides local config: %q", got["developerInstructions"])
	}
}

func TestCodexAppServerIDExtraction(t *testing.T) {
	result := map[string]interface{}{
		"thread": map[string]interface{}{"id": "thread-1"},
		"turn":   map[string]interface{}{"id": "turn-1"},
	}
	if got := threadIDFromResult(result); got != "thread-1" {
		t.Fatalf("threadIDFromResult = %q", got)
	}
	if got := turnIDFromResult(result); got != "turn-1" {
		t.Fatalf("turnIDFromResult = %q", got)
	}
}

func TestCodexAppServerTurnParams(t *testing.T) {
	job := &ClaimedSession{Agent: AgentExecConfig{Model: "gpt-5.5", Effort: "max", AppendSystemPrompt: "Owner instructions."}}
	exe := "/usr/local/bin/orbit"
	got := codexTurnParams("thread-1", job, "/repo", "/tmp/uploads", "orbit-turn-1", "hello", []string{"/tmp/a.png"}, codexTurnContextOptions{
		Executable: exe,
		Mode:       codexInstructionsAdditionalContext,
	})
	if got["threadId"] != "thread-1" {
		t.Fatalf("threadId = %v", got["threadId"])
	}
	if got["clientUserMessageId"] != "orbit-turn-1" {
		t.Fatalf("clientUserMessageId = %v", got["clientUserMessageId"])
	}
	if got["effort"] != "max" {
		t.Fatalf("effort = %v", got["effort"])
	}
	input, ok := got["input"].([]map[string]interface{})
	if !ok || len(input) != 2 || input[0]["type"] != "text" || input[1]["type"] != "localImage" {
		t.Fatalf("input = %#v", got["input"])
	}
	sandbox, ok := got["sandboxPolicy"].(map[string]interface{})
	if !ok || sandbox["type"] != "dangerFullAccess" {
		t.Fatalf("sandboxPolicy = %#v", got["sandboxPolicy"])
	}
	additional, ok := got["additionalContext"].(map[string]interface{})
	if !ok {
		t.Fatalf("additionalContext = %#v", got["additionalContext"])
	}
	orbit, ok := additional["orbit_00000000_cli"].(map[string]interface{})
	if !ok || orbit["kind"] != "application" {
		t.Fatalf("orbit CLI context = %#v", additional["orbit_00000000_cli"])
	}
	if orbit["value"] != orbitCLIInstructions(exe) {
		t.Fatalf("orbit_cli value = %q, want %q", orbit["value"], orbitCLIInstructions(exe))
	}
	owner, ok := additional["orbit_00000000_agent_append_00000000"].(map[string]interface{})
	if !ok || owner["kind"] != "application" || owner["value"] != "Owner instructions." {
		t.Fatalf("owner append context = %#v", additional["orbit_00000000_agent_append_00000000"])
	}
}

func TestCodexInstructionModeForUserAgent(t *testing.T) {
	tests := []struct {
		userAgent string
		want      codexInstructionMode
	}{
		{"orbit/0.124.0 (Linux)", codexInstructionsUserInput},
		{"orbit/0.125.0 (Linux)", codexInstructionsInjectItems},
		{"orbit/0.134.9 (Linux)", codexInstructionsInjectItems},
		{"orbit/0.135.0 (Linux)", codexInstructionsAdditionalContext},
		{"orbit/1.0.0 (Linux)", codexInstructionsAdditionalContext},
		{"malformed", codexInstructionsUserInput},
		{"", codexInstructionsUserInput},
	}
	for _, tt := range tests {
		if got := codexInstructionModeForUserAgent(tt.userAgent); got != tt.want {
			t.Errorf("codexInstructionModeForUserAgent(%q) = %v, want %v", tt.userAgent, got, tt.want)
		}
	}
}

func TestCodexInitializeResponseUserAgentPath(t *testing.T) {
	var message codexRPCMessage
	if err := json.Unmarshal([]byte(`{"id":1,"result":{"userAgent":"orbit/0.146.0 (Linux)","codexHome":"/tmp/codex"}}`), &message); err != nil {
		t.Fatal(err)
	}
	result := rawObject(message.Result)
	if got := codexInstructionModeForUserAgent(firstString(result, "userAgent")); got != codexInstructionsAdditionalContext {
		t.Fatalf("initialize result mode = %v, result %#v", got, result)
	}
}

func TestCodexCompactionRefreshesInstructionContextOnNextTurn(t *testing.T) {
	additional := &codexAppServer{instructionMode: codexInstructionsAdditionalContext}
	mode, generation := additional.prepareInstructionContext(func() error {
		t.Fatal("additionalContext mode must not inject raw items")
		return nil
	})
	if mode != codexInstructionsAdditionalContext || generation != 0 {
		t.Fatalf("initial additional context = mode %v generation %d", mode, generation)
	}
	additional.markInstructionContextForRefresh()
	_, generation = additional.prepareInstructionContext(func() error {
		t.Fatal("additionalContext mode must not inject raw items")
		return nil
	})
	if generation != 1 {
		t.Fatalf("post-compaction generation = %d, want 1", generation)
	}
	_, stableGeneration := additional.prepareInstructionContext(func() error { return nil })
	if stableGeneration != generation {
		t.Fatalf("ordinary next turn changed generation from %d to %d", generation, stableGeneration)
	}

	legacy := &codexAppServer{instructionMode: codexInstructionsInjectItems}
	injections := 0
	legacy.markInstructionContextForRefresh()
	mode, _ = legacy.prepareInstructionContext(func() error {
		injections++
		return nil
	})
	if mode != codexInstructionsInjectItems || injections != 1 {
		t.Fatalf("legacy refresh = mode %v injections %d", mode, injections)
	}
	legacy.prepareInstructionContext(func() error {
		injections++
		return nil
	})
	if injections != 1 {
		t.Fatalf("ordinary next legacy turn reinjected context %d times", injections)
	}
}

func TestCodexCompactionNotificationShapes(t *testing.T) {
	itemCamel, _ := json.Marshal(map[string]interface{}{"item": map[string]interface{}{"type": "contextCompaction"}})
	itemSnake, _ := json.Marshal(map[string]interface{}{"item": map[string]interface{}{"type": "context_compaction"}})
	for _, message := range []codexRPCMessage{
		{Method: "thread/compacted"},
		{Method: "item/completed", Params: itemCamel},
		{Method: "item/completed", Params: itemSnake},
	} {
		if !codexNotificationCompacted(message) {
			t.Fatalf("compaction notification not recognized: %#v", message)
		}
	}
	normal, _ := json.Marshal(map[string]interface{}{"item": map[string]interface{}{"type": "agentMessage"}})
	if codexNotificationCompacted(codexRPCMessage{Method: "item/completed", Params: normal}) {
		t.Fatal("ordinary completed item reported as compaction")
	}
}

func TestCodexLegacyInstructionDeliveryDoesNotReplaceDeveloperInstructions(t *testing.T) {
	job := &ClaimedSession{Agent: AgentExecConfig{AppendSystemPrompt: "Owner instructions."}}
	got := codexTurnParams("thread-1", job, "/repo", "/tmp/uploads", "turn-1", "hello", nil, codexTurnContextOptions{
		Executable: "/usr/local/bin/orbit",
		Mode:       codexInstructionsUserInput,
	})
	if _, ok := got["additionalContext"]; ok {
		t.Fatalf("legacy params unexpectedly contain additionalContext: %#v", got)
	}
	injectedTurn := codexTurnParams("thread-1", job, "/repo", "/tmp/uploads", "turn-2", "hello", nil, codexTurnContextOptions{
		Executable: "/usr/local/bin/orbit",
		Mode:       codexInstructionsInjectItems,
	})
	if _, ok := injectedTurn["additionalContext"]; ok {
		t.Fatalf("inject-items turn unexpectedly contains additionalContext: %#v", injectedTurn)
	}
	if input := injectedTurn["input"].([]map[string]interface{}); len(input) != 1 || input[0]["text"] != "hello" {
		t.Fatalf("inject-items turn input = %#v", input)
	}
	input := got["input"].([]map[string]interface{})
	if len(input) != 2 || !strings.Contains(input[0]["text"].(string), "<orbit_application_context>") || input[1]["text"] != "hello" {
		t.Fatalf("legacy input = %#v", input)
	}
	items := codexInjectedAgentItems(job.Agent, "/usr/local/bin/orbit")
	if len(items) != 1 || items[0]["role"] != "developer" {
		t.Fatalf("injected items = %#v", items)
	}
	content, ok := items[0]["content"].([]map[string]interface{})
	if !ok || len(content) != 1 || content[0]["type"] != "input_text" || !strings.Contains(content[0]["text"].(string), "Owner instructions.") {
		t.Fatalf("injected content = %#v", items[0]["content"])
	}
	thread := codexThreadParams(job, "/repo", "/tmp/uploads")
	if _, ok := thread["developerInstructions"]; ok {
		t.Fatalf("thread params replace developer instructions: %#v", thread)
	}
}

func TestCodexAdditionalContextChunksLongOwnerInstructionsLosslessly(t *testing.T) {
	want := strings.Repeat("界abc", 900)
	context := codexAgentAdditionalContext(AgentExecConfig{AppendSystemPrompt: want}, "/usr/local/bin/orbit", 7)
	keys := make([]string, 0, len(context))
	for key := range context {
		if strings.HasPrefix(key, "orbit_00000007_agent_append_") {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	var got strings.Builder
	for _, key := range keys {
		entry := context[key].(map[string]interface{})
		part := entry["value"].(string)
		if len(part) > 900 || !utf8.ValidString(part) {
			t.Fatalf("invalid context chunk %q: %d bytes", key, len(part))
		}
		got.WriteString(part)
	}
	if got.String() != want || len(keys) < 2 {
		t.Fatalf("chunked owner instructions: %d keys, equal=%v", len(keys), got.String() == want)
	}
}

func TestCodexUsageMapsOnlyTokenCounters(t *testing.T) {
	got := codexUsage(map[string]interface{}{
		"input_tokens":                float64(11),
		"output_tokens":               float64(7),
		"cache_creation_input_tokens": float64(3),
		"cached_input_tokens":         float64(5),
		"cost_usd":                    1.23,
		"modelUsage":                  map[string]interface{}{"gpt-5.5": map[string]interface{}{"costUSD": 1.23}},
	})
	if got == nil {
		t.Fatalf("codexUsage = nil")
	}
	if got.InputTokens != 11 || got.OutputTokens != 7 || got.CacheCreationInputTokens != 3 || got.CacheReadInputTokens != 5 {
		t.Fatalf("codexUsage = %#v", got)
	}
}

func TestCodexTurnEndPayloadIncludesContextTokens(t *testing.T) {
	got := codexTurnEndPayload(codexTurnResult{
		Subtype: "completed",
		Usage: &TokenUsage{
			InputTokens:              1200,
			OutputTokens:             80,
			CacheCreationInputTokens: 300,
			CacheReadInputTokens:     400,
		},
	}, 1, 0, &ClaimedSession{})

	if got["contextTokens"] != 1280 {
		t.Fatalf("contextTokens = %v, want 1280", got["contextTokens"])
	}
	if got["subtype"] != "completed" || got["numTurns"] != 1 {
		t.Fatalf("payload = %#v", got)
	}

	noUsage := codexTurnEndPayload(codexTurnResult{Subtype: "completed"}, 1, 0, &ClaimedSession{})
	if noUsage["contextTokens"] != 0 {
		t.Fatalf("missing usage contextTokens = %v, want 0", noUsage["contextTokens"])
	}
}

func TestCodexTurnEndPayloadPrefersAppServerContextTokens(t *testing.T) {
	got := codexTurnEndPayload(codexTurnResult{
		Subtype:       "completed",
		ContextTokens: 91_000,
		Usage: &TokenUsage{
			InputTokens:  1200,
			OutputTokens: 80,
		},
	}, 1, 0, &ClaimedSession{})

	if got["contextTokens"] != 91_000 {
		t.Fatalf("contextTokens = %v, want 91000", got["contextTokens"])
	}
}

func TestCodexAppServerTokenUsageUpdatesActiveTurn(t *testing.T) {
	var mu sync.Mutex
	active := &codexAppActiveTurn{orbitTurnID: "orbit-turn-1", codexTurnID: "codex-turn-1"}
	raw, _ := json.Marshal(map[string]interface{}{
		"threadId": "thread-1",
		"turnId":   "codex-turn-1",
		"tokenUsage": map[string]interface{}{
			"total": map[string]interface{}{
				"totalTokens":           91_000,
				"inputTokens":           70_000,
				"cachedInputTokens":     15_000,
				"outputTokens":          5_000,
				"reasoningOutputTokens": 1_000,
			},
			"last": map[string]interface{}{
				"totalTokens":           1_500,
				"inputTokens":           1_000,
				"cachedInputTokens":     200,
				"outputTokens":          250,
				"reasoningOutputTokens": 50,
			},
			"modelContextWindow": 400_000,
		},
	})

	handleCodexAppNotification("thread-1", codexRPCMessage{Method: "thread/tokenUsage/updated", Params: raw}, nil, &mu, &active, func(codexTurnResult) {}, nil, nil, nil)

	if active.result.ContextTokens != 91_000 {
		t.Fatalf("ContextTokens = %d, want 91000", active.result.ContextTokens)
	}
	if active.result.Usage == nil {
		t.Fatalf("Usage = nil")
	}
	if active.result.Usage.InputTokens != 1_000 || active.result.Usage.CacheReadInputTokens != 200 || active.result.Usage.OutputTokens != 300 {
		t.Fatalf("Usage = %#v", active.result.Usage)
	}
}

func TestCodexAppServerIgnoresSubagentTurnCompletion(t *testing.T) {
	var mu sync.Mutex
	active := &codexAppActiveTurn{
		orbitTurnID: "orbit-turn-1",
		codexTurnID: "root-turn-1",
		result:      codexTurnResult{Status: stSucceeded},
	}
	finalized := 0
	finalize := func(codexTurnResult) { finalized++ }
	notify := func(threadID, turnID, status string) {
		raw, _ := json.Marshal(map[string]interface{}{
			"threadId": threadID,
			"turn": map[string]interface{}{
				"id":     turnID,
				"status": status,
			},
		})
		handleCodexAppNotification(
			"root-thread", codexRPCMessage{Method: "turn/completed", Params: raw}, nil,
			&mu, &active, finalize, nil, nil, nil,
		)
	}

	// App-server multiplexes spawned-agent notifications onto the root connection. A child
	// completion (including an interrupted audit agent) must not park the still-running root.
	notify("child-thread", "child-turn-1", "interrupted")
	if finalized != 0 {
		t.Fatalf("child turn finalized root %d times, want 0", finalized)
	}
	if active.result.Status != stSucceeded {
		t.Fatalf("child turn changed active result to %q", active.result.Status)
	}

	// A stale completion on the right thread is equally unsafe after a resumed turn starts.
	notify("root-thread", "older-root-turn", "completed")
	if finalized != 0 {
		t.Fatalf("stale root turn finalized current turn %d times, want 0", finalized)
	}

	notify("root-thread", "root-turn-1", "completed")
	if finalized != 1 {
		t.Fatalf("current root completion finalized %d times, want 1", finalized)
	}
}

func TestCodexNotificationThreadIDReadsThreadStartedShape(t *testing.T) {
	raw, _ := json.Marshal(map[string]interface{}{
		"thread": map[string]interface{}{"id": "child-thread", "parentThreadId": "root-thread"},
	})
	got := codexNotificationThreadID(codexRPCMessage{Method: "thread/started", Params: raw})
	if got != "child-thread" {
		t.Fatalf("thread id = %q, want child-thread", got)
	}
}

func TestCodexAppInterruptWaitsForTurnID(t *testing.T) {
	var mu sync.Mutex
	active := &codexAppActiveTurn{orbitTurnID: "orbit-turn-1", startSent: true}
	if got, beforeStart := requestCodexAppInterrupt(&mu, &active); got != "" || beforeStart {
		t.Fatalf("requestCodexAppInterrupt before turn id = %q, want empty", got)
	}
	if !active.interruptRequested {
		t.Fatalf("interruptRequested = false, want true")
	}
	if got := markCodexAppTurnStarted(&mu, &active, "orbit-turn-1", "codex-turn-1"); got != "codex-turn-1" {
		t.Fatalf("markCodexAppTurnStarted = %q, want codex-turn-1", got)
	}
	if got, beforeStart := requestCodexAppInterrupt(&mu, &active); got != "" || beforeStart {
		t.Fatalf("duplicate requestCodexAppInterrupt = %q, want empty", got)
	}
}

func TestCodexAppInterruptBeforeStartSkipsTurnStart(t *testing.T) {
	var mu sync.Mutex
	active := &codexAppActiveTurn{orbitTurnID: "orbit-turn-1"}
	if got, beforeStart := requestCodexAppInterrupt(&mu, &active); got != "" || !beforeStart {
		t.Fatalf("requestCodexAppInterrupt before start = %q, want empty", got)
	}
	ok, interrupted := beginCodexAppTurnStart(&mu, &active, "orbit-turn-1")
	if !ok || !interrupted {
		t.Fatalf("beginCodexAppTurnStart = (%v, %v), want (true, true)", ok, interrupted)
	}
	if active.startSent {
		t.Fatalf("startSent = true, want false")
	}
}

func TestCodexAppFinalizeKeepsTurnActiveUntilAckFinishes(t *testing.T) {
	var mu sync.Mutex
	active := &codexAppActiveTurn{
		orbitTurnID: "orbit-turn-1",
		result:      codexTurnResult{Status: stSucceeded},
	}
	active.fullText.WriteString("done")

	finishing, snapshot, ok := beginCodexAppTurnFinalize(&mu, &active)
	if !ok || finishing == nil {
		t.Fatal("first finalizer did not acquire the active turn")
	}
	if snapshot.orbitTurnID != "orbit-turn-1" || snapshot.fullText != "done" {
		t.Fatalf("finalize snapshot = %#v", snapshot)
	}
	if active == nil || !active.finishing {
		t.Fatal("turn became idle before its Orbit ack completed")
	}
	if _, _, duplicate := beginCodexAppTurnFinalize(&mu, &active); duplicate {
		t.Fatal("a duplicate completion acquired the same turn")
	}
	if turnID, beforeStart := requestCodexAppInterrupt(&mu, &active); turnID != "" || beforeStart {
		t.Fatalf("finishing turn was interrupted: (%q, %v)", turnID, beforeStart)
	}

	finishCodexAppTurnFinalize(&mu, &active, finishing)
	if active != nil {
		t.Fatal("turn remained active after its Orbit ack completed")
	}
}

type emittedEvent struct {
	typ     string
	payload map[string]interface{}
}

func captureCodexItem(item map[string]interface{}, completed bool) []emittedEvent {
	var got []emittedEvent
	emit := func(eventType string, payload map[string]interface{}) {
		got = append(got, emittedEvent{eventType, payload})
	}
	var result codexTurnResult
	var last strings.Builder
	handleCodexItem(map[string]interface{}{"item": item}, emit, &result, &last, completed, nil)
	return got
}

// The app-server (thread) protocol tags a completed reply item with the
// camelCase type "agentMessage" (see item/agentMessage/delta), not the CLI's
// snake_case "agent_message". handleCodexItem must emit a durable `assistant`
// event for it — otherwise the reply is only ever streamed and vanishes at
// turn end / on reload.
func TestHandleCodexItemAppServerAgentMessage(t *testing.T) {
	for _, itemType := range []string{"agentMessage", "agent_message", "message"} {
		t.Run(itemType, func(t *testing.T) {
			var got []string
			var result codexTurnResult
			var last strings.Builder
			emit := func(eventType string, payload map[string]interface{}) {
				if eventType == evAssistant {
					got = append(got, payload["text"].(string))
				}
			}
			item := map[string]interface{}{"type": itemType, "id": "msg_1", "text": "hello world"}
			handleCodexItem(map[string]interface{}{"item": item}, emit, &result, &last, true, nil)
			if len(got) != 1 || got[0] != "hello world" {
				t.Fatalf("assistant events = %v, want [\"hello world\"]", got)
			}
			if result.Result != "hello world" {
				t.Fatalf("result.Result = %q, want %q", result.Result, "hello world")
			}
		})
	}
}

func TestHandleCodexItemProcessesCompletedAssistantText(t *testing.T) {
	var got []string
	var result codexTurnResult
	var last strings.Builder
	emit := func(eventType string, payload map[string]interface{}) {
		if eventType == evAssistant {
			got = append(got, payload["text"].(string))
		}
	}
	item := map[string]interface{}{"type": "agentMessage", "id": "msg_1", "text": "see ![x](/tmp/x.png)"}
	handleCodexItem(map[string]interface{}{"item": item}, emit, &result, &last, true, func(text string) string {
		return strings.ReplaceAll(text, "/tmp/x.png", "orbit-attachment:att-1")
	})
	want := "see ![x](orbit-attachment:att-1)"
	if len(got) != 1 || got[0] != want {
		t.Fatalf("assistant events = %v, want [%q]", got, want)
	}
	if result.Result != want {
		t.Fatalf("result.Result = %q, want %q", result.Result, want)
	}
}

// The app-server carries shell output under `aggregatedOutput`, not
// output/stdout/stderr — the tool_result must read it or the shell card is blank.
func TestHandleCodexItemAppServerCommand(t *testing.T) {
	item := map[string]interface{}{
		"type": "commandExecution", "id": "call_1",
		"command": "/bin/bash -lc 'echo hi'", "aggregatedOutput": "hi\n", "exitCode": float64(0),
	}
	got := captureCodexItem(item, true)
	if len(got) != 1 || got[0].typ != evToolResult {
		t.Fatalf("events = %+v, want one tool_result", got)
	}
	if got[0].payload["content"] != "hi\n" {
		t.Fatalf("content = %q, want %q", got[0].payload["content"], "hi\n")
	}
}

// mcpToolCall (camelCase, capital T) must still hit the tool branch — a
// case-sensitive Contains(itemType, "tool") missed it entirely.
func TestHandleCodexItemAppServerMcpTool(t *testing.T) {
	item := map[string]interface{}{
		"type": "mcpToolCall", "id": "call_9", "toolName": "orbit__task_create",
		"arguments": map[string]interface{}{"title": "x"},
	}
	started := captureCodexItem(item, false)
	if len(started) != 1 || started[0].typ != evToolUse || started[0].payload["name"] != "orbit__task_create" {
		t.Fatalf("started events = %+v, want tool_use named orbit__task_create", started)
	}
}

// Codex 0.147 splits that name across `server` and `tool`, and dropped `toolName`. Reading only
// the old field left every MCP tool card in the transcript with a blank name.
func TestHandleCodexItemAppServerMcpToolSplitName(t *testing.T) {
	item := map[string]interface{}{
		"type": "mcpToolCall", "id": "exec-9", "server": "orbit", "tool": "task_list",
		"arguments": map[string]interface{}{"status": "CANCELLED"},
	}
	started := captureCodexItem(item, false)
	if len(started) != 1 || started[0].payload["name"] != "orbit__task_list" {
		t.Fatalf("started events = %+v, want tool_use named orbit__task_list", started)
	}
}

// fileChange renders as an apply_patch tool: paths on the call, diff on the result.
func TestHandleCodexItemAppServerFileChange(t *testing.T) {
	item := map[string]interface{}{
		"type": "fileChange", "id": "call_2",
		"changes": []interface{}{
			map[string]interface{}{"path": "/tmp/a.txt", "kind": map[string]interface{}{"type": "add"}, "diff": "hello\n"},
		},
	}
	started := captureCodexItem(item, false)
	if len(started) != 1 || started[0].typ != evToolUse || started[0].payload["name"] != "apply_patch" {
		t.Fatalf("started = %+v, want apply_patch tool_use", started)
	}
	files, _ := started[0].payload["input"].(map[string]interface{})["files"].([]string)
	if len(files) != 1 || files[0] != "/tmp/a.txt" {
		t.Fatalf("files = %v, want [/tmp/a.txt]", files)
	}
	done := captureCodexItem(item, true)
	if len(done) != 1 || done[0].typ != evToolResult || done[0].payload["content"] != "hello\n" {
		t.Fatalf("completed = %+v, want tool_result with the diff", done)
	}
}

// The thread protocol streams reasoning only as deltas; the completed reasoning
// item carries no text. The deltas must animate live (thinking_delta, ephemeral)
// and be flushed as ONE durable `thinking` on completion — not one persisted row
// per delta, and not lost entirely.
func TestCodexAppServerReasoningFlushesOnceOnComplete(t *testing.T) {
	var mu sync.Mutex
	active := &codexAppActiveTurn{orbitTurnID: "t1"}
	var events []emittedEvent
	emit := func(typ string, payload map[string]interface{}) {
		events = append(events, emittedEvent{typ, payload})
	}
	notify := func(method string, params interface{}) {
		raw, _ := json.Marshal(params)
		handleCodexAppNotification("thread-1", codexRPCMessage{Method: method, Params: raw}, emit, &mu, &active, func(codexTurnResult) {}, nil, nil, nil)
	}

	notify("item/reasoning/summaryTextDelta", map[string]interface{}{"delta": "Think"})
	notify("item/reasoning/summaryTextDelta", map[string]interface{}{"delta": "ing…"})
	notify("item/completed", map[string]interface{}{"item": map[string]interface{}{"type": "reasoning", "id": "rs_1", "summary": []interface{}{}, "content": []interface{}{}}})

	var deltas, thinking []string
	for _, e := range events {
		switch e.typ {
		case evThinkingDelta:
			deltas = append(deltas, e.payload["text"].(string))
		case evThinking:
			thinking = append(thinking, e.payload["text"].(string))
		default:
			t.Fatalf("unexpected event %q", e.typ)
		}
	}
	if len(deltas) != 2 {
		t.Fatalf("thinking_delta count = %d, want 2", len(deltas))
	}
	if len(thinking) != 1 || thinking[0] != "Thinking…" {
		t.Fatalf("durable thinking = %v, want [\"Thinking…\"]", thinking)
	}
	if active.thinkText.Len() != 0 {
		t.Fatalf("thinkText not reset after flush: %q", active.thinkText.String())
	}
}

func TestCodexAppServerForwardsRateLimitUpdates(t *testing.T) {
	var mu sync.Mutex
	var active *codexAppActiveTurn
	var got map[string]interface{}
	raw, _ := json.Marshal(map[string]interface{}{
		"rateLimits": map[string]interface{}{
			"limitId": "codex-other",
			"primary": map[string]interface{}{
				"usedPercent":        7,
				"windowDurationMins": 300,
			},
		},
	})
	handleCodexAppNotification(
		"thread-1",
		codexRPCMessage{Method: "account/rateLimits/updated", Params: raw},
		func(string, map[string]interface{}) {},
		&mu,
		&active,
		func(codexTurnResult) {},
		nil,
		nil,
		func(snapshot map[string]interface{}) { got = snapshot },
	)

	if got == nil || firstString(got, "limitId") != "codex-other" {
		t.Fatalf("forwarded snapshot = %#v", got)
	}
	window := mapValue(got["primary"])
	if mins, _ := int64Value(window["windowDurationMins"]); mins != 300 {
		t.Fatalf("window duration = %d, want 300", mins)
	}
}

func TestRewriteLocalMarkdownImagesUploadsAllowedImage(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "mockup.png")
	if err := os.WriteFile(path, []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}, 0o644); err != nil {
		t.Fatal(err)
	}
	var uploadedPath, uploadedMime string
	got := rewriteLocalMarkdownImagesWithUploader(
		context.Background(),
		"preview ![mock]("+path+" \"full\")",
		[]string{dir},
		func(ctx context.Context, path, mimeType string) (string, error) {
			uploadedPath = path
			uploadedMime = mimeType
			return "att-1", nil
		},
	)
	if uploadedPath != path {
		t.Fatalf("uploaded path = %q, want %q", uploadedPath, path)
	}
	if uploadedMime != "image/png" {
		t.Fatalf("uploaded mime = %q, want image/png", uploadedMime)
	}
	if got != `preview ![mock](orbit-attachment:att-1 "full")` {
		t.Fatalf("rewritten = %q", got)
	}
}

func TestRewriteLocalMarkdownImagesUploadsAllowedFileLink(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tool-group-success-mockup.svg")
	if err := os.WriteFile(path, []byte("<svg></svg>"), 0o644); err != nil {
		t.Fatal(err)
	}
	var uploadedPath, uploadedMime string
	got := rewriteLocalMarkdownImagesWithUploader(
		context.Background(),
		"files: [SVG source]("+path+")",
		[]string{dir},
		func(ctx context.Context, path, mimeType string) (string, error) {
			uploadedPath = path
			uploadedMime = mimeType
			return "att-1", nil
		},
	)
	if uploadedPath != path {
		t.Fatalf("uploaded path = %q, want %q", uploadedPath, path)
	}
	if uploadedMime != "image/svg+xml" {
		t.Fatalf("uploaded mime = %q, want image/svg+xml", uploadedMime)
	}
	if got != `files: [SVG source](orbit-attachment:att-1 "tool-group-success-mockup.svg")` {
		t.Fatalf("rewritten = %q", got)
	}
}

func TestCodexGeneratedImagesDirFollowsCodexHome(t *testing.T) {
	got := codexGeneratedImagesDir([]string{"HOME=/home/agent", "CODEX_HOME=/custom/codex"}, "/work")
	if want := filepath.Join("/custom", "codex", "generated_images"); got != want {
		t.Fatalf("generated images dir = %q, want %q", got, want)
	}
}

func TestCodexGeneratedImagesDirFallsBackToHome(t *testing.T) {
	got := codexGeneratedImagesDir([]string{"HOME=/home/agent"}, "/work")
	if want := filepath.Join("/home/agent", ".codex", "generated_images"); got != want {
		t.Fatalf("generated images dir = %q, want %q", got, want)
	}
}

// The imagegen tool writes outside the worktree, so its directory has to be an upload root of its
// own — otherwise the reply keeps a path only the runner can read.
func TestRewriteLocalMarkdownImagesUploadsGeneratedImage(t *testing.T) {
	home := t.TempDir()
	genDir := filepath.Join(home, ".codex", "generated_images", "thread-1")
	if err := os.MkdirAll(genDir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(genDir, "exec-1.png")
	if err := os.WriteFile(path, []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}, 0o644); err != nil {
		t.Fatal(err)
	}
	roots := []string{t.TempDir(), codexGeneratedImagesDir([]string{"HOME=" + home}, "/work")}
	got := rewriteLocalMarkdownImagesWithUploader(
		context.Background(),
		"[download PNG]("+path+")",
		roots,
		func(ctx context.Context, path, mimeType string) (string, error) { return "att-1", nil },
	)
	if got != `[download PNG](orbit-attachment:att-1 "exec-1.png")` {
		t.Fatalf("rewritten = %q", got)
	}
}

func TestRewriteLocalMarkdownImagesSkipsOutsideRoot(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(t.TempDir(), "mockup.png")
	if err := os.WriteFile(outside, []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}, 0o644); err != nil {
		t.Fatal(err)
	}
	called := false
	text := "preview ![mock](" + outside + ")"
	got := rewriteLocalMarkdownImagesWithUploader(context.Background(), text, []string{dir}, func(ctx context.Context, path, mimeType string) (string, error) {
		called = true
		return "att-1", nil
	})
	if called {
		t.Fatalf("uploader called for outside-root image")
	}
	if got != text {
		t.Fatalf("rewritten = %q, want unchanged", got)
	}
}

func TestRewriteLocalMarkdownImagesSkipsOutsideRootFileLink(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(t.TempDir(), "mockup.svg")
	if err := os.WriteFile(outside, []byte("<svg></svg>"), 0o644); err != nil {
		t.Fatal(err)
	}
	called := false
	text := "files: [SVG](" + outside + ")"
	got := rewriteLocalMarkdownImagesWithUploader(context.Background(), text, []string{dir}, func(ctx context.Context, path, mimeType string) (string, error) {
		called = true
		return "att-1", nil
	})
	if called {
		t.Fatalf("uploader called for outside-root file link")
	}
	if got != text {
		t.Fatalf("rewritten = %q, want unchanged", got)
	}
}

// update_plan is codex's scratch checklist, and Orbit cannot deny the tool. Dropping
// the item left a task recorded there invisible in the transcript AND absent from
// tool_call, so there was nothing to diagnose with. Both stream casings must render.
func TestHandleCodexItemRendersPlanUpdate(t *testing.T) {
	for _, itemType := range []string{"todo_list", "todoList"} {
		t.Run(itemType, func(t *testing.T) {
			item := map[string]interface{}{
				"type": itemType, "id": "plan_1",
				"items": []interface{}{
					map[string]interface{}{"text": "ship the fix", "completed": true},
					map[string]interface{}{"text": "write the test", "status": "in_progress"},
				},
			}
			started := captureCodexItem(item, false)
			if len(started) != 1 || started[0].typ != evToolUse || started[0].payload["name"] != "update_plan" {
				t.Fatalf("started = %+v, want an update_plan tool_use", started)
			}
			done := captureCodexItem(item, true)
			if len(done) != 1 || done[0].typ != evToolResult {
				t.Fatalf("completed = %+v, want one tool_result", done)
			}
			want := "- [x] ship the fix\n- [ ] write the test"
			if done[0].payload["content"] != want {
				t.Fatalf("content = %q, want %q", done[0].payload["content"], want)
			}
		})
	}
}

// webSearch has no result body — render the query/opened page as the summary.
func TestHandleCodexItemAppServerWebSearch(t *testing.T) {
	item := map[string]interface{}{
		"type": "webSearch", "id": "ws_1", "query": "latest Go release",
		"action": map[string]interface{}{"type": "search", "query": "latest Go release"},
	}
	done := captureCodexItem(item, true)
	if len(done) != 1 || done[0].typ != evToolResult {
		t.Fatalf("completed = %+v, want one tool_result", done)
	}
	if done[0].payload["content"] != "Searched: latest Go release" {
		t.Fatalf("content = %q", done[0].payload["content"])
	}
}
