package main

// Workflow agents do not stream their messages through Claude's parent stdout. Their actual
// messages live beside the workflow journal. Relay them as ordinary nested transcript events,
// so the existing durable event store, payload refetch and transcript renderers work unchanged.

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type workflowTranscript struct {
	mu                sync.Mutex
	ctx               context.Context
	cancel            context.CancelFunc
	emit              emitFn
	toolID, dir       string
	journalOffset     int64
	agents            map[string]*workflowAgentTranscript
	started, finished bool
}

type workflowAgentTranscript struct {
	key                      string
	error                    string
	offset                   int64
	result                   interface{}
	hasResult, failed, ended bool
}

func (b *bgTailer) workflowTranscript(toolID string) *workflowTranscript {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.stopping || toolID == "" {
		return nil
	}
	if b.workflows == nil {
		b.workflows = map[string]*workflowTranscript{}
	}
	w := b.workflows[toolID]
	if w == nil {
		ctx, cancel := context.WithCancel(b.ctx)
		w = &workflowTranscript{ctx: ctx, cancel: cancel, emit: b.emit, toolID: toolID,
			agents: map[string]*workflowAgentTranscript{}}
		b.workflows[toolID] = w
	}
	return w
}

func (w *workflowTranscript) agent(id, label, phase string) *workflowAgentTranscript {
	if !bgShellIDShape.MatchString(id) {
		return nil
	}
	if a := w.agents[id]; a != nil {
		return a
	}
	a := &workflowAgentTranscript{key: w.toolID + ":workflow-agent:" + id}
	w.agents[id] = a
	w.emit(evToolUse, map[string]interface{}{
		"id": a.key, "name": "Agent", "parentToolUseId": w.toolID,
		"input": map[string]interface{}{"description": label, "workflow_phase": phase, "workflow_agent_id": id},
	})
	return a
}

// The CLI already supplies an agentId in each running/done progress row. Keep a direct link;
// labels are not identities (two attempts or two phases may use the same label).
func (b *bgTailer) noteWorkflowAgents(p map[string]interface{}) {
	agents, _ := p["agents"].([]interface{})
	if len(agents) == 0 {
		return
	}
	w := b.workflowTranscript(asString(p["toolUseId"]))
	if w == nil {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.finished {
		return
	}
	for _, raw := range agents {
		row, _ := raw.(map[string]interface{})
		if a := w.agent(asString(row["agentId"]), asString(row["label"]), asString(row["phaseTitle"])); a != nil {
			row["transcriptKey"] = a.key
			if reason := asString(row["error"]); reason != "" {
				a.error = reason
			}
		}
	}
}

// Trust only the transcript directory of this runtime's own session, including account slots.
// A tool result quoting a receipt must never make us read arbitrary files on the runner.
func workflowReceiptDir(content, sessionUUID, configDir string) string {
	if !strings.HasPrefix(content, "Workflow launched in background.") || sessionUUID == "" {
		return ""
	}
	transcript := findClaudeTranscriptIn(configDir, sessionUUID)
	if transcript == "" {
		return ""
	}
	root := filepath.Join(strings.TrimSuffix(transcript, ".jsonl"), "subagents", "workflows")
	for _, line := range strings.Split(content, "\n") {
		if !strings.HasPrefix(line, "Transcript dir: ") {
			continue
		}
		dir := strings.TrimSpace(strings.TrimPrefix(line, "Transcript dir: "))
		name := filepath.Base(dir)
		if !filepath.IsAbs(dir) || filepath.Clean(dir) != dir || filepath.Dir(dir) != root || !strings.HasPrefix(name, "wf_") || !bgShellIDShape.MatchString(name) {
			return ""
		}
		realRoot, rootErr := filepath.EvalSymlinks(root)
		realDir, dirErr := filepath.EvalSymlinks(dir)
		if rootErr == nil && dirErr == nil && filepath.Dir(realDir) == realRoot {
			return realDir
		}
	}
	return ""
}

func (b *bgTailer) startWorkflowTranscript(toolID, content string) bool {
	if !strings.HasPrefix(content, "Workflow launched in background.") {
		return false
	}
	b.mu.Lock()
	sessionUUID, configDir := b.claudeSessionUUID, b.claudeConfigDir
	b.mu.Unlock()
	dir := workflowReceiptDir(content, sessionUUID, configDir)
	if dir == "" {
		return true
	}
	w := b.workflowTranscript(toolID)
	if w == nil {
		return true
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.started || w.finished {
		return true
	}
	b.mu.Lock()
	if b.stopping {
		b.mu.Unlock()
		return true
	}
	b.wg.Add(1)
	b.mu.Unlock()
	w.dir, w.started = dir, true
	go func() {
		defer b.wg.Done()
		ticker := time.NewTicker(bgPollInterval)
		defer ticker.Stop()
		for {
			w.mu.Lock()
			if !w.finished {
				w.scan()
			}
			w.mu.Unlock()
			select {
			case <-w.ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return true
}

func (w *workflowTranscript) scan() {
	if w.dir == "" {
		return
	}
	w.journalOffset = scanWorkflowJSONL(w.ctx, filepath.Join(w.dir, "journal.jsonl"), w.journalOffset, func(row map[string]interface{}) {
		id := asString(row["agentId"])
		if row["type"] == "started" {
			w.agent(id, asString(row["label"]), asString(row["phase"]))
		} else if a := w.agents[id]; a != nil && (row["type"] == "result" || row["type"] == "failed") {
			a.result, a.hasResult, a.failed = row["result"], true, row["type"] == "failed"
			if reason := asString(row["error"]); reason != "" {
				a.error = reason
			}
		}
	})
	for id, a := range w.agents {
		a.offset = scanWorkflowJSONL(w.ctx, filepath.Join(w.dir, "agent-"+id+".jsonl"), a.offset, func(row map[string]interface{}) {
			if row["type"] != "assistant" && row["type"] != "user" {
				return
			}
			message, _ := row["message"].(map[string]interface{})
			if _, ok := message["content"].([]interface{}); !ok {
				return
			}
			row["parent_tool_use_id"] = a.key
			handleMessage(row, w.emit, nil)
		})
		if a.hasResult && !a.ended {
			w.endAgent(a)
		}
	}
}

func (w *workflowTranscript) endAgent(a *workflowAgentTranscript) {
	content := a.result
	if content == nil && a.failed {
		content = a.error
		if content == "" {
			content = "Workflow agent failed before recording a result."
		}
	}
	if _, ok := content.(string); !ok {
		if encoded, err := json.Marshal(content); err == nil {
			content = string(encoded)
		}
	}
	w.emit(evToolResult, map[string]interface{}{
		"toolUseId": a.key, "parentToolUseId": w.toolID, "content": content, "isError": a.failed,
	})
	a.ended = true
}

func (b *bgTailer) finishWorkflowTranscript(toolID, status string) {
	b.mu.Lock()
	w := b.workflows[toolID]
	b.mu.Unlock()
	if w == nil {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.finished {
		return
	}
	w.scan()
	for _, a := range w.agents {
		if !a.ended {
			a.result = a.error
			if a.result == "" {
				a.result = "Workflow " + status + "; no agent result was recorded."
			}
			a.failed = status != "completed"
			w.endAgent(a)
		}
	}
	w.finished = true
	w.cancel()
}

// Incremental, complete-line reads with a fixed memory ceiling. Oversized records are skipped
// without blocking the valid records after them; an unfinished last line is retried next tick.
func scanWorkflowJSONL(ctx context.Context, path string, offset int64, visit func(map[string]interface{})) int64 {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return offset
	}
	f, err := os.Open(path)
	if err != nil {
		return offset
	}
	defer f.Close()
	// Never replay an already published prefix if a transcript is truncated on resume.
	if info.Size() < offset {
		return offset
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return offset
	}
	r := bufio.NewReaderSize(f, transcriptReadBuffer)
	var line []byte
	var consumed int64
	oversized := false
	for {
		if ctx.Err() != nil {
			return offset
		}
		fragment, err := r.ReadSlice('\n')
		consumed += int64(len(fragment))
		if !oversized {
			if len(line)+len(fragment) > transcriptRelevantLineCap {
				oversized = true
				line = nil
			} else {
				line = append(line, fragment...)
			}
		}
		if err == bufio.ErrBufferFull {
			continue
		}
		if err != nil {
			return offset
		}
		offset += consumed
		if !oversized {
			var row map[string]interface{}
			if json.Unmarshal(line, &row) == nil {
				visit(row)
			}
		}
		line, consumed, oversized = line[:0], 0, false
	}
}
