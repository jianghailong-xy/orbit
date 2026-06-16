package main

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
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

// executeJob drives `claude -p --output-format stream-json` for one job and
// normalizes its message stream into run events. The compiled runner only uses
// this CLI path (no in-process Agent SDK).
func executeJob(ctx context.Context, job *ClaimedJob, emit emitFn, execDir, scratchDir string) ExecResult {
	a := job.Agent
	args := []string{
		"-p", job.Prompt,
		"--output-format", "stream-json",
		"--verbose",
		"--model", a.Model,
		"--permission-mode", a.PermissionMode,
	}
	if len(a.AllowedTools) > 0 {
		args = append(args, "--allowedTools", strings.Join(a.AllowedTools, ","))
	}
	if len(a.DisallowedTools) > 0 {
		args = append(args, "--disallowedTools", strings.Join(a.DisallowedTools, ","))
	}
	if a.MaxTurns != nil {
		args = append(args, "--max-turns", strconv.Itoa(*a.MaxTurns))
	}
	if a.MaxBudgetUsd != nil {
		args = append(args, "--max-budget-usd", strconv.FormatFloat(*a.MaxBudgetUsd, 'f', -1, 64))
	}
	if job.ResumeSessionID != "" {
		args = append(args, "--resume", job.ResumeSessionID)
	}
	if a.McpConfig != nil {
		mcpPath := filepath.Join(scratchDir, "mcp.json")
		b, _ := json.Marshal(map[string]interface{}{"mcpServers": a.McpConfig})
		_ = os.WriteFile(mcpPath, b, 0o644)
		args = append(args, "--mcp-config", mcpPath)
	}

	cmd := exec.CommandContext(ctx, "claude", args...)
	cmd.Dir = execDir
	cmd.Env = os.Environ()
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()

	if err := cmd.Start(); err != nil {
		msg := "failed to spawn claude: " + err.Error()
		emit(evError, map[string]interface{}{"message": msg})
		return ExecResult{Status: stFailed, ErrorMsg: msg}
	}

	go func() {
		s := bufio.NewScanner(stderr)
		s.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		for s.Scan() {
			emit(evSystem, map[string]interface{}{"stderr": s.Text() + "\n"})
		}
	}()

	final := ExecResult{Status: stFailed, ErrorMsg: "claude produced no result"}
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 1024*1024), 16*1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var msg map[string]interface{}
		if json.Unmarshal([]byte(line), &msg) != nil {
			continue
		}
		handleMessage(msg, emit)
		if msg["type"] == "result" {
			final = resultFrom(msg, ctx)
		}
	}
	_ = cmd.Wait()

	if ctx.Err() != nil {
		final.Status = stCancelled
	}
	return final
}

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
