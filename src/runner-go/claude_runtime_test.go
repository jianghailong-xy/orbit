package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// the queue, without a process in the way
// ---------------------------------------------------------------------------

// pipeRuntime is a claudeRuntime whose stdin is a real OS pipe — the same kind of fd a
// spawned CLI is handed, with the same 64 KiB buffer and the same lack of write atomicity
// above PIPE_BUF. An in-memory io.Pipe would not do: it serializes writes internally, so
// it cannot show whether the runtime serializes them.
type pipeRuntime struct {
	*claudeRuntime
	r     *os.File
	lines chan string
}

// newUnreadPipeRuntime leaves the read end alone, so writes fill the pipe buffer and then
// block — what a `claude` busy inside a tool call does to its stdin.
func newUnreadPipeRuntime(t *testing.T) *pipeRuntime {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	p := &pipeRuntime{claudeRuntime: newClaudeRuntime(&claudeSpawn{stdin: w}), r: r}
	t.Cleanup(func() {
		r.Close() // releases a writer parked on a full pipe
		p.close()
		<-p.wrote
	})
	return p
}

// newPipeRuntime drains the pipe into whole lines as fast as they arrive.
func newPipeRuntime(t *testing.T) *pipeRuntime {
	t.Helper()
	p := newUnreadPipeRuntime(t)
	p.lines = make(chan string, 256)
	go func() {
		defer close(p.lines)
		sc := bufio.NewScanner(p.r)
		sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
		for sc.Scan() {
			p.lines <- sc.Text()
		}
	}()
	return p
}

func (p *pipeRuntime) nextLine(t *testing.T) string {
	t.Helper()
	select {
	case line, ok := <-p.lines:
		if !ok {
			t.Fatal("claude stdin closed before the frame arrived")
		}
		return line
	case <-time.After(fakeClaudeTimeout):
		t.Fatal("timed out waiting for a frame to reach claude stdin")
		return ""
	}
}

func textFrame(text string) string {
	return userFrame("11111111-2222-3333-4444-555555555555", []map[string]interface{}{
		{"type": "text", "text": text},
	})
}

// Frames leave the queue in the order they were accepted, one whole JSONL line each.
func TestClaudeRuntimeWritesAcceptedFramesInOrder(t *testing.T) {
	rt := newPipeRuntime(t)
	want := []string{"first", "second", "third"}
	for _, text := range want {
		if err := rt.send(textFrame(text)); err != nil {
			t.Fatalf("send(%q): %v", text, err)
		}
	}
	for i, text := range want {
		if got := userFrameText(t, decodeWrittenFrame(t, rt.nextLine(t))); got != text {
			t.Errorf("frame %d carried %q, want %q", i, got, text)
		}
	}
}

// Turns offered concurrently — a message racing an interrupt, two devices sending at once
// — are every one of them accepted, and every one of them arrives exactly once as a whole
// JSONL line. So the queue is deep enough for real concurrency, and draining it neither
// drops nor duplicates. (Whole lines are not this code's doing: Go serializes Writes to
// one *os.File. What is this code's doing is that none of these senders had to wait.)
func TestClaudeRuntimeAcceptsConcurrentSendsAndDeliversEachOnce(t *testing.T) {
	rt := newPipeRuntime(t)
	const senders = 8
	// Frames far larger than the pipe buffer, so the writer really is mid-write while the
	// rest of the senders arrive.
	filler := strings.Repeat("x", 128*1024)
	var wg sync.WaitGroup
	for i := 0; i < senders; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if err := rt.send(textFrame(fmt.Sprintf("turn-%d %s", i, filler))); err != nil {
				t.Errorf("concurrent send %d: %v", i, err)
			}
		}(i)
	}
	wg.Wait()

	seen := map[string]bool{}
	for i := 0; i < senders; i++ {
		// Parsing is the assertion: a torn line is not valid JSON.
		text := userFrameText(t, decodeWrittenFrame(t, rt.nextLine(t)))
		if seen[text] {
			t.Errorf("frame %q arrived twice", text[:16])
		}
		seen[text] = true
	}
	for i := 0; i < senders; i++ {
		if want := fmt.Sprintf("turn-%d %s", i, filler); !seen[want] {
			t.Errorf("frame turn-%d never arrived whole", i)
		}
	}
}

// A `claude` inside a tool call stops reading stdin. Handing a frame over must still
// return at once — the inbox poller is the caller, and parking it there means no
// interrupt and no `end` until the tool finishes — and a queue with nowhere to drain
// must say so rather than wait.
func TestClaudeRuntimeSendDoesNotBlockOnAChildThatStoppedReading(t *testing.T) {
	rt := newUnreadPipeRuntime(t)
	// Larger than the pipe buffer, so the writer is parked inside its very first write
	// rather than being absorbed by the kernel.
	frame := textFrame(strings.Repeat("x", 128*1024))
	done := make(chan error, 1)
	go func() {
		// One frame is taken by the writer and blocks there; the queue absorbs the depth
		// after it, and the send past that reports instead of waiting.
		for i := 0; i < claudeWriteQueueDepth+8; i++ {
			if err := rt.send(frame); err != nil {
				done <- err
				return
			}
		}
		done <- nil
	}()
	select {
	case err := <-done:
		if !errors.Is(err, errWriteQueueFull) {
			t.Fatalf("sending into a wedged child returned %v, want %v", err, errWriteQueueFull)
		}
	case <-time.After(fakeClaudeTimeout):
		t.Fatal("send blocked on a child that stopped reading stdin")
	}
}

// A pipe that breaks under the writer is reported to the next sender, so a frame is never
// silently accepted into a process that cannot receive it.
func TestClaudeRuntimeReportsABrokenPipe(t *testing.T) {
	rt := newUnreadPipeRuntime(t)
	rt.r.Close() // no reader left: the next write is EPIPE

	if err := rt.send(textFrame("into the void")); err != nil {
		t.Fatalf("the frame was rejected before the write was even tried: %v", err)
	}
	rt.close()
	<-rt.wrote // the writer has now discovered the break

	err := rt.send(textFrame("and another"))
	if err == nil {
		t.Fatal("a frame was accepted into a broken pipe")
	}
	// The write failure itself, not a generic "closed": what broke has to be reportable.
	if errors.Is(err, errRuntimeClosed) || errors.Is(err, errWriteQueueFull) || errors.Is(err, errRuntimeGone) {
		t.Errorf("send after a broken pipe reported %v, want the write error", err)
	}
}

// `result` is a turn boundary: it moves the runtime to idle with stdin still open. Only
// EOF is terminal, and after it a frame is refused rather than queued for nobody.
func TestClaudeRuntimeResultIsATurnBoundaryAndEOFIsTerminal(t *testing.T) {
	rt := newPipeRuntime(t)
	if got := rt.currentPhase(); got != phaseStarting {
		t.Errorf("a fresh runtime is %q, want %q", got, phaseStarting)
	}
	if err := rt.send(textFrame("first")); err != nil {
		t.Fatal(err)
	}
	rt.beginTurn()
	if got := rt.currentPhase(); got != phaseWaiting {
		t.Errorf("a fed turn leaves the runtime %q, want %q", got, phaseWaiting)
	}
	rt.nextLine(t)

	rt.endTurn()
	if got := rt.currentPhase(); got != phaseIdle {
		t.Errorf("a result leaves the runtime %q, want %q", got, phaseIdle)
	}
	if err := rt.send(textFrame("second")); err != nil {
		t.Fatalf("stdin was closed by a result: %v", err)
	}
	if got := userFrameText(t, decodeWrittenFrame(t, rt.nextLine(t))); got != "second" {
		t.Errorf("the turn after a result carried %q, want %q", got, "second")
	}

	rt.markTerminal()
	if got := rt.currentPhase(); got != phaseTerminal {
		t.Errorf("EOF leaves the runtime %q, want %q", got, phaseTerminal)
	}
	if err := rt.send(textFrame("third")); !errors.Is(err, errRuntimeGone) {
		t.Errorf("send after EOF returned %v, want %v", err, errRuntimeGone)
	}
	rt.endTurn()
	if got := rt.currentPhase(); got != phaseTerminal {
		t.Errorf("terminal was reverted to %q by a late turn boundary", got)
	}
}

// Generations are per process, so two runtimes overlapping during a re-spawn are
// distinguishable in a log line.
func TestClaudeRuntimeNumbersEachProcessGeneration(t *testing.T) {
	first, second := newPipeRuntime(t), newPipeRuntime(t)
	if first.generation == second.generation {
		t.Errorf("two runtimes share generation %d", first.generation)
	}
}

// ---------------------------------------------------------------------------
// against the fake CLI
// ---------------------------------------------------------------------------

// startFakeRuntime spawns the fake CLI through the production spawn path and adopts it,
// returning the runtime and its decoded stdout.
func startFakeRuntime(t *testing.T, fake *fakeClaude, job *ClaimedSession) (*claudeRuntime, <-chan map[string]interface{}) {
	t.Helper()
	t.Setenv("PATH", fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	proc, err := spawnClaude(ctx, job, t.TempDir(), claudeCommandArgs(job, t.TempDir(), true))
	if err != nil {
		t.Fatal(err)
	}
	rt := newClaudeRuntime(proc)
	t.Cleanup(func() { rt.close(); _ = rt.wait() })
	return rt, readFrames(t, proc.stdout)
}

// One process for the whole session: the opening message, the tool_use/tool_result round
// it runs, its `result`, and the message sent after that result all reach the same child.
func TestClaudeRuntimeKeepsOneProcessAcrossToolUseAndTurns(t *testing.T) {
	fake := newFakeClaude(t,
		fakeStep{Await: "user"},
		fakeStep{Emit: "system_init"},
		fakeStep{Emit: "assistant", Text: "on it"},
		fakeStep{Emit: "tool_use", ToolUseID: "toolu_1", ToolName: "Bash", Input: map[string]interface{}{"command": "ls"}},
		fakeStep{Emit: "tool_result", ToolUseID: "toolu_1", Text: "widget.go"},
		fakeStep{Emit: "result", Text: "renamed"},
		fakeStep{Await: "user"},
		fakeStep{Emit: "assistant", Text: "reverted"},
		fakeStep{Emit: "result", Text: "reverted"},
	)
	job := claudeSpawnJob(t)
	rt, frames := startFakeRuntime(t, fake, job)

	if err := rt.send(textFrame("rename the widget")); err != nil {
		t.Fatalf("opening turn: %v", err)
	}
	rt.beginTurn()
	if !sawToolUseBefore(t, frames, "result") {
		t.Error("the turn produced no tool_use before its result")
	}
	rt.endTurn()

	// The second turn is sent AFTER the first turn's result: if `result` had ended the
	// process, this is where a second spawn would happen.
	if err := rt.send(textFrame("and now revert it")); err != nil {
		t.Fatalf("turn after a result: %v", err)
	}
	rt.beginTurn()
	waitFrameType(t, frames, "result")
	rt.endTurn()

	if spawns := fake.Spawns(); len(spawns) != 1 {
		t.Fatalf("claude was spawned %d time(s), want 1 for the whole session", len(spawns))
	}
	stdin := fake.WaitStdin(2)
	for i, want := range []string{"rename the widget", "and now revert it"} {
		if got := userFrameText(t, stdin[i]); got != want {
			t.Errorf("stdin frame %d carried %q, want %q", i, got, want)
		}
	}
	if got := rt.currentPhase(); got != phaseIdle {
		t.Errorf("a live process between turns is %q, want %q", got, phaseIdle)
	}
}

// Ending a session closes stdin and reclaims the child — the CLI is not left running
// against a session nobody is driving any more.
func TestClaudeRuntimeCloseEndsAndReapsTheChild(t *testing.T) {
	fake := newFakeClaude(t, fakeStep{Await: "user"}, fakeStep{Emit: "result", Text: "done"})
	rt, frames := startFakeRuntime(t, fake, claudeSpawnJob(t))

	if err := rt.send(textFrame("do the thing")); err != nil {
		t.Fatal(err)
	}
	rt.beginTurn()
	waitFrameType(t, frames, "result")
	rt.endTurn()
	if rt.cmd.ProcessState != nil {
		t.Fatal("the child exited on its own result")
	}
	if rt.pid() == 0 {
		t.Fatal("a running runtime has no pid")
	}

	rt.close() // what an `end` turn does
	drainFrames(t, frames)
	rt.markTerminal()
	if err := rt.wait(); err != nil {
		t.Fatalf("reaping the child: %v", err)
	}
	if rt.cmd.ProcessState == nil || !rt.cmd.ProcessState.Exited() {
		t.Errorf("the child was not reaped after stdin closed: %v", rt.cmd.ProcessState)
	}
}

// A child that exits on its own is terminal too, and reported to whoever sends next.
func TestClaudeRuntimeRefusesFramesOnceTheChildIsGone(t *testing.T) {
	fake := newFakeClaude(t,
		fakeStep{Await: "user"},
		fakeStep{Emit: "result", Text: "done"},
		fakeStep{Emit: "eof"}, // the CLI exits of its own accord
	)
	rt, frames := startFakeRuntime(t, fake, claudeSpawnJob(t))

	if err := rt.send(textFrame("do the thing")); err != nil {
		t.Fatal(err)
	}
	rt.beginTurn()
	waitFrameType(t, frames, "result")
	rt.endTurn()

	drainFrames(t, frames) // stdout EOF: the child is on its way out
	rt.markTerminal()
	if err := rt.send(textFrame("too late")); !errors.Is(err, errRuntimeGone) {
		t.Errorf("send to an exited child returned %v, want %v", err, errRuntimeGone)
	}
	if err := rt.wait(); err != nil {
		t.Fatalf("reaping an exited child: %v", err)
	}
}

// ---------------------------------------------------------------------------

// decodeWrittenFrame parses one line as the stdin writer emitted it (the scanner has
// already taken the newline off). Torn or interleaved output fails here.
func decodeWrittenFrame(t *testing.T, line string) map[string]interface{} {
	t.Helper()
	var m map[string]interface{}
	if err := json.Unmarshal([]byte(line), &m); err != nil {
		t.Fatalf("frame is not whole JSON (%v): %.120q", err, line)
	}
	return m
}

// sawToolUseBefore reports whether an assistant frame carrying a tool_use block arrived
// before the named frame type.
func sawToolUseBefore(t *testing.T, frames <-chan map[string]interface{}, frameType string) bool {
	t.Helper()
	saw := false
	for {
		select {
		case m, ok := <-frames:
			if !ok {
				t.Fatalf("claude stdout closed before a %q frame", frameType)
			}
			if m["type"] == frameType {
				return saw
			}
			msg, _ := m["message"].(map[string]interface{})
			content, _ := msg["content"].([]interface{})
			for _, block := range content {
				if b, _ := block.(map[string]interface{}); b != nil && b["type"] == "tool_use" {
					saw = true
				}
			}
		case <-time.After(fakeClaudeTimeout):
			t.Fatalf("timed out waiting for a %q frame", frameType)
		}
	}
}

// drainFrames waits for the CLI's stdout to reach EOF.
func drainFrames(t *testing.T, frames <-chan map[string]interface{}) {
	t.Helper()
	for {
		select {
		case _, ok := <-frames:
			if !ok {
				return
			}
		case <-time.After(fakeClaudeTimeout):
			t.Fatal("claude stdout never reached EOF")
		}
	}
}
