package main

import (
	"context"
	"strings"
)

// ExecResult is the normalized outcome of one Claude Code run.
type ExecResult struct {
	Status          string
	Result          string
	Subtype         string
	ErrorMsg        string
	ClaudeSessionID string
	NumTurns        int
	DurationMs      int
	CostUsd         float64
	Usage           *TokenUsage
	ModelUsage      map[string]interface{}
}

type emitFn func(eventType string, payload map[string]interface{})

func handleMessage(msg map[string]interface{}, emit emitFn) {
	// A sub-agent's messages (spawned by the Task tool) carry the spawning Task's
	// tool_use id here; stamp it onto every event so the UI can nest the sub-agent's
	// transcript under that call. "" for the top-level agent.
	parentID, _ := msg["parent_tool_use_id"].(string)
	withParent := func(p map[string]interface{}) map[string]interface{} {
		if parentID != "" {
			p["parentToolUseId"] = parentID
		}
		return p
	}
	switch msg["type"] {
	case "system":
		emit(evSystem, map[string]interface{}{
			"subtype":   msg["subtype"],
			"model":     msg["model"],
			"sessionId": msg["session_id"],
		})
	case "assistant":
		message, _ := msg["message"].(map[string]interface{})
		content, _ := message["content"].([]interface{})
		for _, c := range content {
			block, _ := c.(map[string]interface{})
			switch block["type"] {
			case "text":
				emit(evAssistant, withParent(map[string]interface{}{"text": block["text"]}))
			case "thinking":
				emit(evThinking, withParent(map[string]interface{}{"text": block["thinking"]}))
			case "redacted_thinking":
				// Encrypted reasoning (block["data"]) the user can't read — surface a
				// placeholder so the block isn't silently missing, like Claude Code Web.
				emit(evThinking, withParent(map[string]interface{}{"text": "[redacted thinking]", "redacted": true}))
			case "tool_use":
				emit(evToolUse, withParent(map[string]interface{}{
					"id": block["id"], "name": block["name"], "input": block["input"],
				}))
			}
		}
	case "user":
		// Tool results arrive as user-role messages (the Anthropic SSE protocol puts
		// tool_result blocks in a `user` message, not an assistant one). Emit only
		// those: the user's own typed turns are emitted from the inbox and echoed back
		// here by --replay-user-messages, so re-emitting their text would double them.
		message, _ := msg["message"].(map[string]interface{})
		content, _ := message["content"].([]interface{})
		for _, c := range content {
			block, _ := c.(map[string]interface{})
			if block["type"] == "tool_result" {
				emit(evToolResult, withParent(map[string]interface{}{
					"toolUseId": block["tool_use_id"],
					"content":   block["content"],
					"isError":   block["is_error"],
				}))
			}
		}
	case "stream_event":
		// Partial-message deltas (--include-partial-messages) drive live typing. Only
		// the text/thinking deltas are surfaced as streaming animation; the durable
		// assistant/thinking events carry the authoritative full text.
		event, _ := msg["event"].(map[string]interface{})
		delta, _ := event["delta"].(map[string]interface{})
		switch delta["type"] {
		case "text_delta":
			emit(evTextDelta, map[string]interface{}{"text": delta["text"]})
		case "thinking_delta":
			emit(evThinkingDelta, map[string]interface{}{"text": delta["thinking"]})
		}
	}
}

func resultFrom(msg map[string]interface{}, ctx context.Context) ExecResult {
	subtype, _ := msg["subtype"].(string)
	isErr := false
	if b, ok := msg["is_error"].(bool); ok && b {
		isErr = true
	}
	if strings.HasPrefix(subtype, "error") {
		isErr = true
	}
	status := stSucceeded
	if ctx.Err() != nil {
		status = stCancelled
	} else if isErr {
		status = stFailed
	}
	r := ExecResult{Status: status, Subtype: subtype}
	r.Result, _ = msg["result"].(string)
	r.ClaudeSessionID, _ = msg["session_id"].(string)
	r.NumTurns = toInt(msg["num_turns"])
	r.DurationMs = toInt(msg["duration_ms"])
	r.CostUsd = toFloat(msg["total_cost_usd"])
	if u, ok := msg["usage"].(map[string]interface{}); ok {
		r.Usage = &TokenUsage{
			InputTokens:              toInt(u["input_tokens"]),
			OutputTokens:             toInt(u["output_tokens"]),
			CacheCreationInputTokens: toInt(u["cache_creation_input_tokens"]),
			CacheReadInputTokens:     toInt(u["cache_read_input_tokens"]),
		}
	}
	if mu, ok := msg["modelUsage"].(map[string]interface{}); ok {
		r.ModelUsage = mu
	}
	return r
}

func toInt(v interface{}) int {
	if f, ok := v.(float64); ok {
		return int(f)
	}
	return 0
}

func toFloat(v interface{}) float64 {
	if f, ok := v.(float64); ok {
		return f
	}
	return 0
}
