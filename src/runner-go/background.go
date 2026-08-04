package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
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
	bgPollInterval            = 2 * time.Second
	bgTailCap                 = 16 * 1024 // emit at most the last 16 KB of a (possibly huge) output file
	transcriptReadBuffer      = 64 * 1024
	transcriptRelevantLineCap = 1024 * 1024
)

type bgTailer struct {
	ctx    context.Context    // session lifetime; all tails + the transcript watcher stop when cancelled
	cancel context.CancelFunc // cancels ctx (invoked by stopAll on session teardown)
	emit   emitFn
	mu     sync.Mutex
	wg     sync.WaitGroup
	// stopping is protected by mu and closes the WaitGroup registration gate.
	// stopAll sets it before Wait, so no goroutine can Add concurrently with Wait.
	stopping bool
	live     map[string]liveShell // toolUseId → its running tail
	seen     map[string]bool      // "<toolUseId>\x00<status>" already emitted (dedupe across sources)
	terminal map[string]bool      // toolUseId already reported in a terminal state
}

// liveShell is a background shell with a tail running. engineOwned separates the agent's
// Bash(run_in_background) shells — children of the provider process, so they die with it —
// from user `!cmd &` shells, which the runner owns and which outlive an engine restart.
type liveShell struct {
	cancel      context.CancelFunc
	shellID     string
	engineOwned bool
}

func newBgTailer(ctx context.Context, emit emitFn) *bgTailer {
	// Own a cancellable child so stopAll reliably ends the watcher goroutine even when the
	// parent context outlives a normally-ended session run.
	ctx, cancel := context.WithCancel(ctx)
	return &bgTailer{
		ctx:      ctx,
		cancel:   cancel,
		emit:     emit,
		live:     map[string]liveShell{},
		seen:     map[string]bool{},
		terminal: map[string]bool{},
	}
}

// markSeen records a (toolUseId, status) transition, returning true only the first time it's
// seen. It de-dupes background_task emissions across the two sources that both carry the same
// <task-notification> — the stdout stream and the transcript tail (watchJSONL) — so a
// notification observed both ways is emitted once.
func (b *bgTailer) markSeen(toolUseID, status string) bool {
	key := toolUseID + "\x00" + status
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.seen[key] {
		return false
	}
	b.seen[key] = true
	return true
}

// markTerminal records that a shell reached a terminal state, returning true only for the
// first report. A shell terminalizes exactly once: whichever of its own <task-notification>
// and killEngineShells lands first wins, so a shell that finished just as its engine stopped
// isn't also reported as killed.
func (b *bgTailer) markTerminal(toolUseID string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.terminal[toolUseID] {
		return false
	}
	b.terminal[toolUseID] = true
	return true
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
	b.startTail(toolUseID, idM[1], pathM[1], true)
}

// startTail begins tailing path for the given background shell (no-op if already tailing
// toolUseID). Shared by agent shells (engineOwned: file parsed from a tool_result) and user
// `!`-shells (file the runner owns).
func (b *bgTailer) startTail(toolUseID, shellID, path string, engineOwned bool) {
	b.mu.Lock()
	if b.stopping {
		b.mu.Unlock()
		return
	}
	if _, ok := b.live[toolUseID]; ok {
		b.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(b.ctx)
	b.live[toolUseID] = liveShell{cancel: cancel, shellID: shellID, engineOwned: engineOwned}
	b.wg.Add(1)
	b.mu.Unlock()
	go func() {
		defer b.wg.Done()
		b.tail(ctx, toolUseID, shellID, path)
	}()
}

func (b *bgTailer) startTranscriptWatcher(sessionUUID string) {
	b.mu.Lock()
	if b.stopping {
		b.mu.Unlock()
		return
	}
	b.wg.Add(1)
	b.mu.Unlock()
	go func() {
		defer b.wg.Done()
		b.watchJSONL(sessionUUID)
	}()
}

// startUserShell runs a user `!cmd &` shell in the background: it spawns the process with its
// output going to a file, tails that file for live output, and emits a background_task on exit
// (the runner owns the process, so completion + exit code are exact — no notification needed).
// Bound to the session context, so the process is killed when the session ends.
func (b *bgTailer) startUserShell(execDir, command, toolUseID, shellID, outputPath string, env map[string]string) error {
	// Reserve the waiter before doing any slow setup. stopAll closes this
	// registration gate under the same mutex before it starts waiting.
	b.mu.Lock()
	if b.stopping {
		b.mu.Unlock()
		return context.Canceled
	}
	b.wg.Add(1)
	b.mu.Unlock()
	waiterStarted := false
	defer func() {
		if !waiterStarted {
			b.wg.Done()
		}
	}()
	if err := os.MkdirAll(filepath.Dir(outputPath), 0o755); err != nil {
		return err
	}
	f, err := os.Create(outputPath)
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(b.ctx, "bash", "-lc", command)
	configureSessionProcessTree(cmd)
	cmd.Dir = execDir
	cmd.Env = envWithAgent(env)
	cmd.Stdout = f
	cmd.Stderr = f
	if err := cmd.Start(); err != nil {
		f.Close()
		return err
	}
	b.startTail(toolUseID, shellID, outputPath, false)
	waiterStarted = true
	go func() {
		defer b.wg.Done()
		werr := waitSessionProcessTree(cmd)
		f.Close()
		b.stop(toolUseID) // stop the live tail
		if b.ctx.Err() != nil {
			return // session ending — the kill isn't a real completion, don't report it
		}
		exit := 0
		if werr != nil {
			if ee, ok := werr.(*exec.ExitError); ok {
				exit = ee.ExitCode()
			} else {
				exit = -1
			}
		}
		status := "completed"
		if exit != 0 {
			status = "failed"
		}
		// `output` carries the final snapshot so it survives a reload (background_output is
		// broadcast-only); for agent shells this field is absent and the agent's Read snapshots
		// persist instead.
		b.emit(evBackgroundTask, map[string]interface{}{
			"shellId":   shellID,
			"toolUseId": toolUseID,
			"status":    status,
			"summary":   fmt.Sprintf("Background command completed (exit code %d)", exit),
			"output":    readCapped(outputPath),
		})
	}()
	return nil
}

// readCapped reads a file, returning at most the last bgTailCap bytes ("" on any error).
func readCapped(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	if info, statErr := f.Stat(); statErr == nil && info.Size() > bgTailCap {
		if _, err := f.Seek(info.Size()-bgTailCap, io.SeekStart); err != nil {
			return ""
		}
	}
	data, err := io.ReadAll(io.LimitReader(f, bgTailCap))
	if err != nil {
		return ""
	}
	return string(data)
}

// stop ends the tail for a completed/failed/killed background task.
func (b *bgTailer) stop(toolUseID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if s, ok := b.live[toolUseID]; ok {
		s.cancel()
		delete(b.live, toolUseID)
	}
}

// killEngineShells reports every still-running shell of the provider process as killed and
// stops its tail. Those shells are children of that process, so they're gone the moment it
// stops — but Claude only writes a <task-notification> for a shell that ends on its own, so
// without this a left-up dev server or watcher stays "running" for the rest of the session:
// the tray never resolves it, and Session.runningBgShells keeps painting a parked session as
// busy until it's resumed or ended, which may never happen. Runner-owned `!`-shells are left
// alone — they survive an engine restart and report their own exit.
func (b *bgTailer) killEngineShells() {
	type killedShell struct{ toolUseID, shellID string }
	b.mu.Lock()
	killed := make([]killedShell, 0, len(b.live))
	for id, s := range b.live {
		if !s.engineOwned {
			continue
		}
		s.cancel()
		delete(b.live, id)
		killed = append(killed, killedShell{toolUseID: id, shellID: s.shellID})
	}
	b.mu.Unlock()
	for _, s := range killed {
		if !b.markTerminal(s.toolUseID) {
			continue // its own notification already reported a terminal state
		}
		b.emit(evBackgroundTask, map[string]interface{}{
			"shellId":   s.shellID,
			"toolUseId": s.toolUseID,
			"status":    "killed",
			"summary":   "Background command stopped with the session runtime that launched it",
		})
	}
}

// stopAll ends and joins every tail, transcript watcher, and runner-owned
// background shell. Returning is the supervisor handoff barrier: no old epoch
// goroutine may emit or retain the worktree after it completes.
func (b *bgTailer) stopAll() {
	b.mu.Lock()
	b.stopping = true
	for id, s := range b.live {
		s.cancel()
		delete(b.live, id)
	}
	b.mu.Unlock()
	if b.cancel != nil {
		b.cancel() // ends watchJSONL (and anything else bound to b.ctx)
	}
	b.wg.Wait()
}

func (b *bgTailer) tail(ctx context.Context, toolUseID, shellID, path string) {
	tk := time.NewTicker(bgPollInterval)
	defer tk.Stop()
	var last string
	read := func() {
		s := readCapped(path)
		if s == "" {
			return // file not there yet / transient — try again next tick
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
	terminal := isTerminalBgStatus(status)
	if bg != nil && toolUseID != "" {
		// Skip a notification we've already turned into an event (the same <task-notification>
		// reaches us via both the stdout stream and the transcript tail — see watchJSONL).
		if !bg.markSeen(toolUseID, status) {
			return true
		}
		// A shell already reported as killed with its engine must not terminalize twice.
		if terminal && !bg.markTerminal(toolUseID) {
			return true
		}
	}
	emit(evBackgroundTask, map[string]interface{}{
		"shellId":    get(bgNotifTaskID),
		"toolUseId":  toolUseID,
		"status":     status,
		"summary":    get(bgNotifSummary),
		"outputFile": get(bgNotifFile),
	})
	if bg != nil && toolUseID != "" && terminal {
		bg.stop(toolUseID)
	}
	return true
}

// isTerminalBgStatus reports whether a <task-notification> status ends the shell's life
// (mirrors the server's own terminal set in runner-api.controller).
func isTerminalBgStatus(status string) bool {
	switch status {
	case "completed", "failed", "killed", "stopped":
		return true
	}
	return false
}

func asString(v interface{}) string {
	s, _ := v.(string)
	return s
}

// watchJSONL tails Claude's own session transcript for <task-notification> user messages and
// turns each into a background_task event — the reliable "this background process finished"
// signal for agent Bash(run_in_background) shells (and sub-agents).
//
// Why the stdout stream isn't enough: when a background shell finishes, Claude records the
// notification in its transcript (~/.claude/projects/<cwd>/<sessionUUID>.jsonl) promptly — even
// while the session sits idle between turns — but it only *streams* that notification to stdout
// when it's consumed at the start of the next turn. So a shell that completes while the user is
// away is written here yet never reaches the runner's stdout reader, leaving Session.runningBgShells
// (and the "Background processes" tray) stuck at "N running" until the next turn, which may never
// come. Reading the transcript closes that gap. Emissions are de-duped against the stdout path via
// the shared seen set, so a notification delivered both ways produces one event.
//
// The first pass reads the whole file (self-healing any shell already stale from a prior runner);
// later passes read only what was appended. Bound to the session context — it stops with the run.
func (b *bgTailer) watchJSONL(sessionUUID string) {
	if sessionUUID == "" {
		return
	}
	tk := time.NewTicker(bgPollInterval)
	defer tk.Stop()
	var path string
	var offset int64
	for {
		if path == "" {
			path = findClaudeTranscript(sessionUUID) // may not exist until the first turn writes it
		}
		if path != "" {
			offset = b.scanTranscript(path, offset)
		}
		select {
		case <-b.ctx.Done():
			return
		case <-tk.C:
		}
	}
}

// scanTranscript reads newline-terminated JSONL entries from offset to EOF, emitting a
// background_task for each new <task-notification>, and returns the offset past the last complete
// line (a partial trailing line is left to be re-read on the next tick). A shrunken file (rotated
// or truncated on resume) is rescanned from the start.
func (b *bgTailer) scanTranscript(path string, offset int64) int64 {
	f, err := os.Open(path)
	if err != nil {
		return offset
	}
	defer f.Close()
	if fi, err := f.Stat(); err == nil && fi.Size() < offset {
		offset = 0
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return offset
	}
	r := bufio.NewReaderSize(f, transcriptReadBuffer)
	completeOffset := offset
	var line []byte
	var lineBytes int64
	truncated := false
	for {
		select {
		case <-b.ctx.Done():
			return completeOffset
		default:
		}
		fragment, readErr := r.ReadSlice('\n')
		lineBytes += int64(len(fragment))
		if !truncated {
			remaining := transcriptRelevantLineCap - len(line)
			if remaining > 0 {
				if len(fragment) <= remaining {
					line = append(line, fragment...)
				} else {
					line = append(line, fragment[:remaining]...)
					truncated = true
				}
			} else {
				truncated = true
			}
		}
		switch {
		case readErr == nil:
			completeOffset += lineBytes
			if !truncated {
				b.notificationFromLine(string(line))
			}
			line = line[:0]
			lineBytes = 0
			truncated = false
		case errors.Is(readErr, bufio.ErrBufferFull):
			continue
		default:
			// EOF leaves a partial trailing entry unconsumed for the next tick.
			return completeOffset
		}
	}
}

// notificationFromLine emits a background_task if the JSONL entry is a user message carrying a
// <task-notification> (de-duped via bgTaskFromNotification's shared seen set).
func (b *bgTailer) notificationFromLine(line string) {
	if !strings.Contains(line, "task-notification") {
		return // cheap pre-filter before the JSON parse
	}
	if txt := userTextFromJSONL(line); strings.Contains(txt, "<task-notification>") {
		bgTaskFromNotification(txt, b.emit, b)
	}
}

// userTextFromJSONL pulls the text of a transcript entry's `message.content`, which Claude writes
// either as a plain string or as an array of content blocks.
func userTextFromJSONL(line string) string {
	var entry struct {
		Message struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal([]byte(line), &entry) != nil {
		return ""
	}
	var s string
	if json.Unmarshal(entry.Message.Content, &s) == nil {
		return s
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(entry.Message.Content, &blocks) == nil {
		var sb strings.Builder
		for _, bl := range blocks {
			if bl.Type == "text" {
				sb.WriteString(bl.Text)
				sb.WriteByte('\n')
			}
		}
		return sb.String()
	}
	return ""
}

// findClaudeTranscript resolves the transcript path for a Claude session by its UUID. Globbing
// on the filename avoids reproducing Claude's cwd→directory escaping; the UUID is unique.
func findClaudeTranscript(sessionUUID string) string {
	base := os.Getenv("CLAUDE_CONFIG_DIR")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil || home == "" {
			return ""
		}
		base = filepath.Join(home, ".claude")
	}
	matches, _ := filepath.Glob(filepath.Join(base, "projects", "*", sessionUUID+".jsonl"))
	if len(matches) > 0 {
		return matches[0]
	}
	return ""
}
