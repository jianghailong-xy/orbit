package main

import (
	"context"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Background shells the agent launches with Bash(run_in_background) write their output to a
// file (…/tasks/<id>.output) and Claude reports completion via a <task-notification> user
// message. The runner already forwards the tool_use/tool_result verbatim; this adds the two
// things it didn't surface before:
//   • bgTailer watches the output file so the UI gets LIVE output, independent of the agent's
//     own Read polling (broadcast-only background_output events).
//   • bgTaskFromNotification turns the <task-notification> into a durable background_task
//     event — the reliable "this background process finished" signal — and stops the tail.

// Parsed from the Bash(run_in_background) tool_result, e.g.
// "Command running in background with ID: bei75180m. Output is being written to: /…/bei75180m.output. …"
var (
	bgLaunchID   = regexp.MustCompile(`running in background with ID:\s+(\S+?)[.\s]`)
	bgLaunchPath = regexp.MustCompile(`written to:\s+(\S+\.output)`)
)

// Fields of the <task-notification> user message Claude injects on a background state change.
var (
	bgNotifTaskID  = regexp.MustCompile(`<task-id>([^<]+)</task-id>`)
	bgNotifToolUse = regexp.MustCompile(`<tool-use-id>([^<]+)</tool-use-id>`)
	bgNotifStatus  = regexp.MustCompile(`<status>([^<]+)</status>`)
	bgNotifFile    = regexp.MustCompile(`<output-file>([^<]+)</output-file>`)
	bgNotifSummary = regexp.MustCompile(`(?s)<summary>(.*?)</summary>`)
)

const (
	bgPollInterval = 2 * time.Second
	bgTailCap      = 16 * 1024 // emit at most the last 16 KB of a (possibly huge) output file
)

type bgTailer struct {
	ctx  context.Context // session lifetime; all tails stop when it's cancelled
	emit emitFn
	mu   sync.Mutex
	live map[string]context.CancelFunc // toolUseId → stop its tail
}

func newBgTailer(ctx context.Context, emit emitFn) *bgTailer {
	return &bgTailer{ctx: ctx, emit: emit, live: map[string]context.CancelFunc{}}
}

// onToolResult inspects a tool_result's text for the "running in background" confirmation and,
// when found, starts tailing that process's output file. toolUseID correlates the tail (and
// the later completion) with the launching Bash call.
func (b *bgTailer) onToolResult(toolUseID, content string) {
	if toolUseID == "" || content == "" {
		return
	}
	idM := bgLaunchID.FindStringSubmatch(content)
	pathM := bgLaunchPath.FindStringSubmatch(content)
	if idM == nil || pathM == nil {
		return
	}
	shellID, path := idM[1], pathM[1]
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok := b.live[toolUseID]; ok {
		return // already tailing
	}
	ctx, cancel := context.WithCancel(b.ctx)
	b.live[toolUseID] = cancel
	go b.tail(ctx, toolUseID, shellID, path)
}

// stop ends the tail for a completed/failed/killed background task.
func (b *bgTailer) stop(toolUseID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if cancel, ok := b.live[toolUseID]; ok {
		cancel()
		delete(b.live, toolUseID)
	}
}

// stopAll ends every tail — called when the session run ends.
func (b *bgTailer) stopAll() {
	b.mu.Lock()
	defer b.mu.Unlock()
	for id, cancel := range b.live {
		cancel()
		delete(b.live, id)
	}
}

func (b *bgTailer) tail(ctx context.Context, toolUseID, shellID, path string) {
	tk := time.NewTicker(bgPollInterval)
	defer tk.Stop()
	var last string
	read := func() {
		data, err := os.ReadFile(path)
		if err != nil {
			return // file not there yet / transient — try again next tick
		}
		s := string(data)
		if len(s) > bgTailCap {
			s = s[len(s)-bgTailCap:]
		}
		if s == last {
			return // unchanged — don't spam an identical snapshot
		}
		last = s
		b.emit(evBackgroundOutput, map[string]interface{}{
			"shellId": shellID, "toolUseId": toolUseID, "content": s,
		})
	}
	read() // emit an initial snapshot promptly rather than waiting a full tick
	for {
		select {
		case <-ctx.Done():
			return
		case <-tk.C:
			read()
		}
	}
}

// bgTaskFromNotification parses a <task-notification> user message into a durable
// background_task event and stops the tail on a terminal status. Returns true if the string
// was a task-notification (so the caller skips the normal user-message handling).
func bgTaskFromNotification(s string, emit emitFn, bg *bgTailer) bool {
	if !strings.Contains(s, "<task-notification>") {
		return false
	}
	get := func(re *regexp.Regexp) string {
		if m := re.FindStringSubmatch(s); m != nil {
			return strings.TrimSpace(m[1])
		}
		return ""
	}
	toolUseID := get(bgNotifToolUse)
	status := get(bgNotifStatus)
	emit(evBackgroundTask, map[string]interface{}{
		"shellId":    get(bgNotifTaskID),
		"toolUseId":  toolUseID,
		"status":     status,
		"summary":    get(bgNotifSummary),
		"outputFile": get(bgNotifFile),
	})
	if bg != nil && toolUseID != "" {
		switch status {
		case "completed", "failed", "killed", "stopped":
			bg.stop(toolUseID)
		}
	}
	return true
}

func asString(v interface{}) string {
	s, _ := v.(string)
	return s
}
