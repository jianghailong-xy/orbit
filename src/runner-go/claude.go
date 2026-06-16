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
				emit(evAssistant, map[string]interface{}{"text": block["text"]})
			case "tool_use":
				emit(evToolUse, map[string]interface{}{"name": block["name"], "input": block["input"]})
			case "tool_result":
				emit(evToolResult, map[string]interface{}{"content": block["content"], "isError": block["is_error"]})
			}
		}
	case "stream_event":
		event, _ := msg["event"].(map[string]interface{})
		delta, _ := event["delta"].(map[string]interface{})
		if delta["type"] == "text_delta" {
			emit(evTextDelta, map[string]interface{}{"text": delta["text"]})
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
