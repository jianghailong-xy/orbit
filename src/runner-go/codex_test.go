package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestNormalizeCodexReasoningEffort(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "empty", in: "", want: ""},
		{name: "max maps to xhigh", in: "max", want: "xhigh"},
		{name: "xhigh passes through", in: "xhigh", want: "xhigh"},
		{name: "minimal passes through", in: "minimal", want: "minimal"},
		{name: "unknown falls back to default", in: "ultra", want: ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := normalizeCodexReasoningEffort(tt.in); got != tt.want {
				t.Fatalf("normalizeCodexReasoningEffort(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
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
	roots, ok := got["runtimeWorkspaceRoots"].([]string)
	if !ok || len(roots) != 2 || roots[0] != "/repo" || roots[1] != "/tmp/uploads" {
		t.Fatalf("runtimeWorkspaceRoots = %#v", got["runtimeWorkspaceRoots"])
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
	job := &ClaimedSession{Agent: AgentExecConfig{Model: "gpt-5.5", Effort: "max"}}
	got := codexTurnParams("thread-1", job, "/repo", "/tmp/uploads", "orbit-turn-1", "hello", []string{"/tmp/a.png"})
	if got["threadId"] != "thread-1" {
		t.Fatalf("threadId = %v", got["threadId"])
	}
	if got["clientUserMessageId"] != "orbit-turn-1" {
		t.Fatalf("clientUserMessageId = %v", got["clientUserMessageId"])
	}
	if got["effort"] != "xhigh" {
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
	}, 1, 0)

	if got["contextTokens"] != 1280 {
		t.Fatalf("contextTokens = %v, want 1280", got["contextTokens"])
	}
	if got["subtype"] != "completed" || got["numTurns"] != 1 {
		t.Fatalf("payload = %#v", got)
	}

	noUsage := codexTurnEndPayload(codexTurnResult{Subtype: "completed"}, 1, 0)
	if noUsage["contextTokens"] != 0 {
		t.Fatalf("missing usage contextTokens = %v, want 0", noUsage["contextTokens"])
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
		handleCodexAppNotification(codexRPCMessage{Method: method, Params: raw}, emit, &mu, &active, func(codexTurnResult) {}, nil, nil)
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
