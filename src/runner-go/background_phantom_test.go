package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// bgAllEvents captures every background event, not just background_task: the
// negative below has to show that nothing at all was emitted, and the positive
// has to show the tail's background_output really was.
type bgAllEvents struct {
	mu   sync.Mutex
	seen []bgSeenEvent
}

type bgSeenEvent struct {
	kind    string
	payload map[string]interface{}
}

func (e *bgAllEvents) emit(eventType string, payload map[string]interface{}) {
	copied := map[string]interface{}{}
	for k, v := range payload {
		copied[k] = v
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.seen = append(e.seen, bgSeenEvent{kind: eventType, payload: copied})
}

func (e *bgAllEvents) ofKind(kind string) []map[string]interface{} {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []map[string]interface{}
	for _, ev := range e.seen {
		if ev.kind == kind {
			out = append(out, ev.payload)
		}
	}
	return out
}

// phantomToolResults are tool_result texts that only DESCRIBE the launch format.
// The two launch regexes cannot tell them from a launch, so production scraped
// three background shells out of text like this (`${shellId}` once, `<id>…`
// twice). Each one entered b.live, and — since stage 1 made b.live the set of
// worktree writers — held its session's checkout with no process behind it,
// waiting for a <task-notification> that could never arrive. They were finally
// found by the `killed` event killEngineShells emitted for them at engine stop.
var phantomToolResults = []string{
	// A template literal, read back out of source or documentation.
	"Command running in background with ID: ${shellId}. Output is being" +
		" written to: ${tasksDir}/${shellId}.output",
	// The same format spelled out with angle-bracket placeholders.
	"Command running in background with ID: <id>. Output is being" +
		" written to: <tasks-dir>/<id>.output. Use BashOutput to read it.",
	// Elided mid-sentence, which is the shape the production rows carried.
	"Command running in background with ID: <id>… Output is being" +
		" written to: /tmp/tasks/<id>.output …",
	// background.go's own doc comment: an id of an entirely plausible shape
	// paired with an elided path. Any agent that reads that file to work on this
	// code carries this exact sentence back in a tool_result.
	`// "Command running in background with ID: bei75180m. Output is being written to: /…/bei75180m.output. …"`,
}

// An identity nothing ever launched must be falsified before it is registered as
// a writer of the checkout: it has no process, so nothing will ever release it,
// and until its engine stops it fences that session's merges and commits shut.
func TestPhantomShellIdIsNotAWorktreeHolder(t *testing.T) {
	p := newSessionPool(1)
	sess := registerPoolSession(t, p, "phantom", false)
	events := &bgAllEvents{}
	bg := newBgTailer(context.Background(), events.emit, p.worktreeHoldsFor("phantom"))
	defer bg.stopAll()

	for i, content := range phantomToolResults {
		bg.onToolResult(fmt.Sprintf("toolu_%d", i), content)
	}

	bg.mu.Lock()
	tracked := make([]string, 0, len(bg.live))
	for id, s := range bg.live {
		tracked = append(tracked, id+"="+s.shellID)
	}
	bg.mu.Unlock()
	if len(tracked) != 0 {
		t.Fatalf("text describing the launch format was taken for a running shell: %v", tracked)
	}
	if holders := p.worktreeHolders("phantom"); len(holders) != 0 {
		t.Fatalf("a shell with no process behind it holds the checkout: %v", holders)
	}

	// How the production rows were observed: whatever got into b.live is reported
	// killed when the engine stops. A phantom never entered it, so it has no death
	// to report either — a tray entry for a command nobody ran.
	bg.killEngineShells()
	if evs := events.ofKind(evBackgroundTask); len(evs) != 0 {
		t.Fatalf("a background_task was emitted for a command that was never launched: %v", evs)
	}
	p.finish(sess)
}

// The paired positive, and the reason the negative above cannot be satisfied by
// simply switching the path off. A shell the engine really launched is really
// writing in the checkout — including via the native run_in_background the agent
// falls back to when the hook is unavailable — so it must go on being tailed,
// go on fencing the checkout, and go on being reported when its engine takes it
// down with it.
func TestRealEngineOwnedShellStillHoldsTheWorktree(t *testing.T) {
	p := newSessionPool(1)
	sess := registerPoolSession(t, p, "realbg", false)
	events := &bgAllEvents{}
	bg := newBgTailer(context.Background(), events.emit, p.worktreeHoldsFor("realbg"))
	defer bg.stopAll()

	output := filepath.Join(t.TempDir(), "bei75180m.output")
	if err := os.WriteFile(output, []byte("[1/4] compiling\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	bg.onToolResult("toolu_real", "Command running in background with ID: bei75180m. Output is being"+
		" written to: "+output+". You will be notified when it completes.")

	bg.mu.Lock()
	shell, live := bg.live["toolu_real"]
	bg.mu.Unlock()
	if !live {
		t.Fatal("a real engine-owned background shell was not registered as live")
	}
	if !shell.engineOwned || shell.shellID != "bei75180m" {
		t.Fatalf("registered as the wrong kind of shell: %+v", shell)
	}
	if holders := p.worktreeHolders("realbg"); !holdersInclude(holders, worktreeHeldByBackgroundJob, "bei75180m") {
		t.Fatalf("a shell that is really writing in the checkout does not hold it: %v", holders)
	}
	if !worktreeFenceRaised(p, "realbg") {
		t.Fatal("the checkout is unfenced while a background shell writes in it")
	}
	awaitTailedOutput(t, events, "toolu_real", "[1/4] compiling")

	// The engine is recycled. The shell is its child, so it is gone — and the
	// user is told, because Claude writes no notification for a shell it did not
	// see end on its own.
	bg.killEngineShells()
	killed := 0
	for _, ev := range events.ofKind(evBackgroundTask) {
		if asString(ev["toolUseId"]) == "toolu_real" && asString(ev["status"]) == "killed" {
			killed++
		}
	}
	if killed != 1 {
		t.Fatalf("engine eviction reported the shell killed %d times, want exactly 1", killed)
	}
	if holders := p.worktreeHolders("realbg"); len(holders) != 0 {
		t.Fatalf("the hold outlived the shell it stood for: %v", holders)
	}
	if worktreeFenceRaised(p, "realbg") {
		t.Fatal("the fence stayed up after the last writer left: nothing would ever merge this session again")
	}
	p.finish(sess)
}

// awaitTailedOutput waits for the tail goroutine's snapshot of the shell's output
// file — the live pane the agent's own Read polling is not needed for.
func awaitTailedOutput(t *testing.T, events *bgAllEvents, toolUseID, want string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		for _, ev := range events.ofKind(evBackgroundOutput) {
			if asString(ev["toolUseId"]) == toolUseID && strings.Contains(asString(ev["content"]), want) {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("no background_output carrying %q for %s: the shell is not being tailed",
				want, toolUseID)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
