package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

type codexTurnResult struct {
	Status           string
	Result           string
	Subtype          string
	Error            string
	RuntimeSessionID string
	Usage            *TokenUsage
}

type codexPreparedTurn struct {
	Prompt         string
	AttachmentRefs []map[string]interface{}
	ImagePaths     []string
}

func runCodexSessionProcess(ctx context.Context, shutdownCtx context.Context, t *Transport, job *ClaimedSession, execDir, scratchDir string, emit emitFn, setTurn func(string), firstSpawn bool, bg *bgTailer) (string, bool, bool) {
	return runCodexAppServerSessionProcess(ctx, shutdownCtx, t, job, execDir, scratchDir, emit, setTurn, firstSpawn, bg)
}

// runCodexExecSessionProcess keeps the Orbit session alive while executing each user
// message as one non-interactive `codex exec --json` turn. Codex owns conversation
// continuity via the thread/session id returned by `thread.started`.
func runCodexExecSessionProcess(ctx context.Context, shutdownCtx context.Context, t *Transport, job *ClaimedSession, execDir, scratchDir string, emit emitFn, setTurn func(string), _ bool, bg *bgTailer) (string, bool, bool) {
	setTurn("")
	var pendingShellCtx []string
	inflight := map[string]bool{}

	for ctx.Err() == nil && shutdownCtx.Err() == nil {
		resp, err := t.inbox(ctx, job.SessionID)
		if err != nil {
			if ctx.Err() != nil || shutdownCtx.Err() != nil {
				break
			}
			logln("inbox poll failed for", job.SessionID+":", err)
			time.Sleep(time.Second)
			continue
		}
		if resp == nil {
			continue
		}

		switch resp.Kind {
		case "message":
			if inflight[resp.TurnID] {
				continue
			}
			inflight[resp.TurnID] = true
			setTurn(resp.TurnID)
			prepared := prepareCodexTurn(ctx, t, job, resp, pendingShellCtx)
			pendingShellCtx = nil
			userEv := map[string]interface{}{"text": resp.Content}
			if len(prepared.AttachmentRefs) > 0 {
				userEv["attachments"] = prepared.AttachmentRefs
			}
			emit(evUser, userEv)

			result := runCodexTurn(ctx, job, execDir, prepared.Prompt, prepared.ImagePaths, emit)
			if result.RuntimeSessionID != "" {
				job.RuntimeSessionID = result.RuntimeSessionID
				writeSessionMeta(scratchDir, job, execDir)
			}
			emit(evTurnEnd, map[string]interface{}{
				"subtype":  result.Subtype,
				"numTurns": 1,
				"costUsd":  0,
			})
			liveFiles, livePatches := liveDiff(job.WT)
			if err := t.turnComplete(job.SessionID, TurnCompleteRequest{
				TurnID:           resp.TurnID,
				Status:           result.Status,
				Result:           result.Result,
				Subtype:          result.Subtype,
				NumTurns:         1,
				CostUsd:          0,
				Usage:            result.Usage,
				RuntimeSessionID: currentRuntimeSessionID(job),
				IsolationStatus:  job.IsolationStatus,
				ChangedFiles:     liveFiles,
				ChangedDiff:      livePatches,
				WorktreeDirty:    worktreeIsDirty(job.WT),
				BranchMerged:     branchMergedInto(job.WT),
			}); err != nil {
				logln("turn-complete failed for", job.SessionID+":", err)
			}
			delete(inflight, resp.TurnID)
			setTurn("")

		case "shell":
			if inflight[resp.TurnID] {
				continue
			}
			inflight[resp.TurnID] = true
			setTurn(resp.TurnID)
			if shCmd, isBg := splitBackground(resp.Content); isBg {
				runShellTurnBackground(bg, execDir, scratchDir, shCmd, resp.TurnID, emit, job.Agent.Env)
				if err := t.turnComplete(job.SessionID, TurnCompleteRequest{
					TurnID: resp.TurnID, Status: stSucceeded,
					Result: "started in background", Subtype: "shell",
					RuntimeSessionID: currentRuntimeSessionID(job),
				}); err != nil {
					logln("shell turn-complete failed for", job.SessionID+":", err)
				}
			} else {
				shOut, shExit := runShellTurn(ctx, execDir, resp.Content, emit, resp.TurnID, job.Agent.Env)
				pendingShellCtx = append(pendingShellCtx,
					fmt.Sprintf("<bash-input>%s</bash-input>\n<bash-stdout>%s</bash-stdout>", resp.Content, shOut))
				if err := t.turnComplete(job.SessionID, TurnCompleteRequest{
					TurnID: resp.TurnID, Status: stSucceeded,
					Result: fmt.Sprintf("exit %d", shExit), Subtype: "shell",
					RuntimeSessionID: currentRuntimeSessionID(job),
				}); err != nil {
					logln("shell turn-complete failed for", job.SessionID+":", err)
				}
			}
			delete(inflight, resp.TurnID)
			setTurn("")

		case "interrupt":
			emit(evInterrupt, map[string]interface{}{})

		case "reload":
			applyRuntimeReload(job, resp.Content)
			emit(evSystem, map[string]interface{}{"subtype": "resumed", "reason": "config_changed"})

		case "diff":
			liveFiles, livePatches := liveDiff(job.WT)
			if err := t.diffResult(job.SessionID, DiffResultRequest{
				ChangedFiles:  liveFiles,
				ChangedDiff:   livePatches,
				WorktreeDirty: worktreeIsDirty(job.WT),
				BranchMerged:  branchMergedInto(job.WT),
			}); err != nil {
				logln("diff-result failed for", job.SessionID+":", err)
			}

		case "end":
			return stSucceeded, true, false
		}
	}

	if shutdownCtx.Err() != nil && ctx.Err() == nil {
		return stCancelled, true, false
	}
	return stCancelled, true, false
}

func applyRuntimeReload(job *ClaimedSession, content string) {
	var cfg struct {
		Model          string  `json:"model"`
		PermissionMode string  `json:"permissionMode"`
		Effort         *string `json:"effort"`
	}
	if json.Unmarshal([]byte(content), &cfg) != nil {
		return
	}
	if cfg.Model != "" {
		job.Agent.Model = cfg.Model
	}
	if cfg.PermissionMode != "" {
		job.Agent.PermissionMode = cfg.PermissionMode
	}
	if cfg.Effort != nil {
		job.Agent.Effort = *cfg.Effort
	}
}

func prepareCodexTurn(ctx context.Context, t *Transport, job *ClaimedSession, resp *RunInboxResponse, pendingShellCtx []string) codexPreparedTurn {
	feedText := resp.Content
	if len(pendingShellCtx) > 0 {
		feedText = strings.Join(pendingShellCtx, "\n") + "\n\n" + resp.Content
	}
	prepared := codexPreparedTurn{}
	var writtenPaths []string
	for _, att := range resp.Attachments {
		data, ferr := t.fetchAttachment(ctx, job.SessionID, att.ID)
		if ferr != nil {
			logln("attachment fetch failed for", job.SessionID, att.ID+":", ferr)
			continue
		}
		abs, werr := writeUpload(job.SessionID, att.FileName, att.ID, data)
		if werr != nil {
			logln("attachment write failed for", job.SessionID, att.ID+":", werr)
			continue
		}
		if isCodexImage(att.MimeType) {
			prepared.ImagePaths = append(prepared.ImagePaths, abs)
		} else {
			writtenPaths = append(writtenPaths, abs)
		}
		prepared.AttachmentRefs = append(prepared.AttachmentRefs, map[string]interface{}{
			"id": att.ID, "mime": att.MimeType, "name": att.FileName,
		})
	}
	if len(writtenPaths) > 0 {
		note := fmt.Sprintf("[The user uploaded %d file(s), saved at: %s - read or process them with your tools as needed.]",
			len(writtenPaths), strings.Join(writtenPaths, ", "))
		if feedText != "" {
			feedText = note + "\n\n" + feedText
		} else {
			feedText = note
		}
	}
	prepared.Prompt = feedText
	return prepared
}

func isCodexImage(mime string) bool {
	switch mime {
	case "image/png", "image/jpeg", "image/webp", "image/gif":
		return true
	default:
		return false
	}
}

func runCodexTurn(ctx context.Context, job *ClaimedSession, execDir, prompt string, imagePaths []string, emit emitFn) codexTurnResult {
	result := codexTurnResult{Status: stSucceeded, Subtype: "success"}
	upDir := uploadsDir(job.SessionID)
	_ = os.MkdirAll(upDir, 0o755)

	args := []string{"-C", execDir, "-s", "workspace-write", "-a", "never", "--add-dir", upDir, "exec"}
	if job.RuntimeSessionID != "" {
		args = append(args, "resume")
	}
	args = append(args, "--json")
	if job.Agent.Model != "" {
		args = append(args, "-m", job.Agent.Model)
	}
	if effort := normalizeCodexReasoningEffort(job.Agent.Effort); effort != "" {
		args = append(args, "-c", fmt.Sprintf("model_reasoning_effort=%q", effort))
	}
	if exe, err := os.Executable(); err == nil {
		args = append(args,
			"-c", fmt.Sprintf("mcp_servers.orbit.command=%q", exe),
			"-c", `mcp_servers.orbit.args=["mcp"]`,
		)
	}
	args = append(args, "--skip-git-repo-check")
	for _, p := range imagePaths {
		args = append(args, "-i", p)
	}
	if job.RuntimeSessionID != "" {
		args = append(args, job.RuntimeSessionID)
	}
	args = append(args, "-")

	cmd := exec.CommandContext(ctx, "codex", args...)
	cmd.Dir = execDir
	cmd.Env = envWithAgent(job.Agent.Env)
	cmd.Env = append(cmd.Env,
		"ORBIT_SESSION_ID="+job.SessionID,
		"ORBIT_AGENT_ID="+job.AgentID,
		"ORBIT_TASK_ID="+job.TaskID,
	)
	cmd.Stdin = strings.NewReader(prompt)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		result.Status = stFailed
		result.Subtype = "spawn_failed"
		result.Error = err.Error()
		result.Result = err.Error()
		emit(evError, map[string]interface{}{"message": "failed to prepare codex stdout: " + err.Error()})
		return result
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		result.Status = stFailed
		result.Subtype = "spawn_failed"
		result.Error = err.Error()
		result.Result = err.Error()
		emit(evError, map[string]interface{}{"message": "failed to prepare codex stderr: " + err.Error()})
		return result
	}
	if err := cmd.Start(); err != nil {
		result.Status = stFailed
		result.Subtype = "spawn_failed"
		result.Error = err.Error()
		result.Result = err.Error()
		emit(evError, map[string]interface{}{"message": "failed to spawn codex: " + err.Error()})
		return result
	}

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		s := bufio.NewScanner(stderr)
		s.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		for s.Scan() {
			emit(evSystem, map[string]interface{}{"stderr": s.Text() + "\n"})
		}
	}()

	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 1024*1024), 16*1024*1024)
	var lastAssistant strings.Builder
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var msg map[string]interface{}
		if json.Unmarshal([]byte(line), &msg) != nil {
			continue
		}
		handleCodexEvent(msg, emit, &result, &lastAssistant)
	}
	waitErr := cmd.Wait()
	wg.Wait()
	if ctx.Err() != nil {
		result.Status = stCancelled
		result.Subtype = "cancelled"
		return result
	}
	if sc.Err() != nil && result.Status == stSucceeded {
		result.Status = stFailed
		result.Subtype = "stream_error"
		result.Error = sc.Err().Error()
	}
	if waitErr != nil && result.Status == stSucceeded {
		result.Status = stFailed
		result.Subtype = "process_error"
		result.Error = waitErr.Error()
	}
	if result.Result == "" {
		result.Result = strings.TrimSpace(lastAssistant.String())
	}
	if result.Status == stFailed && result.Result == "" {
		result.Result = result.Error
	}
	return result
}

func normalizeCodexReasoningEffort(effort string) string {
	switch strings.TrimSpace(effort) {
	case "":
		return ""
	case "max":
		return "xhigh"
	case "none", "minimal", "low", "medium", "high", "xhigh":
		return strings.TrimSpace(effort)
	default:
		logln(fmt.Sprintf("unsupported Codex reasoning effort %q; using model default", effort))
		return ""
	}
}

func handleCodexEvent(msg map[string]interface{}, emit emitFn, result *codexTurnResult, lastAssistant *strings.Builder) {
	eventType, _ := msg["type"].(string)
	switch eventType {
	case "thread.started":
		if id := firstString(msg, "thread_id", "threadId", "session_id", "sessionId"); id != "" {
			result.RuntimeSessionID = id
			emit(evSystem, map[string]interface{}{"subtype": "init", "sessionId": id, "provider": providerCodex})
		}
	case "turn.completed":
		if usage := codexUsage(msg["usage"]); usage != nil {
			result.Usage = usage
		}
	case "turn.failed", "error":
		result.Status = stFailed
		result.Subtype = eventType
		result.Error = firstString(msg, "message", "error", "details")
		if result.Error != "" {
			emit(evError, map[string]interface{}{"message": result.Error})
		}
	case "item.started":
		handleCodexItem(msg, emit, result, lastAssistant, false)
	case "item.completed":
		handleCodexItem(msg, emit, result, lastAssistant, true)
	default:
		if strings.Contains(eventType, "delta") {
			if text := codexText(msg); text != "" {
				emit(evTextDelta, map[string]interface{}{"text": text})
			}
		}
	}
}

func handleCodexItem(msg map[string]interface{}, emit emitFn, result *codexTurnResult, lastAssistant *strings.Builder, completed bool) {
	item := mapValue(msg["item"])
	if item == nil {
		item = msg
	}
	itemType := firstString(item, "type", "kind")
	id := firstString(item, "id", "item_id", "call_id")
	switch {
	case itemType == "agent_message" || itemType == "message":
		if text := codexText(item); text != "" {
			emit(evAssistant, map[string]interface{}{"text": text})
			if lastAssistant.Len() > 0 {
				lastAssistant.WriteString("\n")
			}
			lastAssistant.WriteString(text)
			result.Result = text
		}
	case itemType == "reasoning" || strings.Contains(itemType, "reasoning"):
		if text := codexText(item); text != "" {
			emit(evThinking, map[string]interface{}{"text": text})
		}
	case strings.Contains(itemType, "command") || strings.Contains(itemType, "shell"):
		if !completed {
			emit(evToolUse, map[string]interface{}{
				"id":    fallbackID(id, itemType),
				"name":  "Bash",
				"input": map[string]interface{}{"command": firstString(item, "command", "cmd")},
			})
			return
		}
		emit(evToolResult, map[string]interface{}{
			"toolUseId": fallbackID(id, itemType),
			"content":   firstString(item, "output", "stdout", "stderr", "text"),
			"isError":   codexItemIsError(item),
		})
	case strings.Contains(itemType, "tool"):
		name := firstString(item, "name", "tool_name", "toolName")
		if !completed {
			emit(evToolUse, map[string]interface{}{
				"id":    fallbackID(id, itemType),
				"name":  name,
				"input": firstPresent(item, "input", "arguments", "args"),
			})
			return
		}
		emit(evToolResult, map[string]interface{}{
			"toolUseId": fallbackID(id, itemType),
			"content":   firstPresent(item, "output", "result", "content"),
			"isError":   codexItemIsError(item),
		})
	}
}

func codexUsage(v interface{}) *TokenUsage {
	u := mapValue(v)
	if u == nil {
		return nil
	}
	return &TokenUsage{
		InputTokens:          toInt(firstPresent(u, "input_tokens", "inputTokens")),
		OutputTokens:         toInt(firstPresent(u, "output_tokens", "outputTokens")),
		CacheReadInputTokens: toInt(firstPresent(u, "cached_input_tokens", "cache_read_input_tokens", "cacheReadInputTokens")),
	}
}

func codexText(m map[string]interface{}) string {
	if s := firstString(m, "text", "message", "content", "summary"); s != "" {
		return s
	}
	if arr, ok := m["content"].([]interface{}); ok {
		var b strings.Builder
		for _, part := range arr {
			pm := mapValue(part)
			if pm == nil {
				if s := asString(part); s != "" {
					b.WriteString(s)
				}
				continue
			}
			if s := firstString(pm, "text", "content"); s != "" {
				b.WriteString(s)
			}
		}
		return b.String()
	}
	return ""
}

func firstString(m map[string]interface{}, keys ...string) string {
	for _, k := range keys {
		if s := asString(m[k]); s != "" {
			return s
		}
	}
	return ""
}

func firstPresent(m map[string]interface{}, keys ...string) interface{} {
	for _, k := range keys {
		if v, ok := m[k]; ok && v != nil {
			return v
		}
	}
	return nil
}

func mapValue(v interface{}) map[string]interface{} {
	if m, ok := v.(map[string]interface{}); ok {
		return m
	}
	return nil
}

func fallbackID(id, typ string) string {
	if id != "" {
		return id
	}
	if typ != "" {
		return typ
	}
	return "codex-item"
}

func codexItemIsError(item map[string]interface{}) bool {
	if b, ok := item["is_error"].(bool); ok {
		return b
	}
	status := strings.ToLower(firstString(item, "status", "outcome"))
	return status == "failed" || status == "error"
}
