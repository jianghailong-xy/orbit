package main

import (
	"context"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

type capturedShellEvent struct {
	kind    string
	payload map[string]interface{}
}

func TestForegroundShellSnapshotReplayPolicy(t *testing.T) {
	base := time.Unix(1_000, 0)
	var state foregroundShellSnapshotState
	if state.shouldEmit("", base) {
		t.Fatal("empty output must never be replayed")
	}
	if !state.shouldEmit("first", base) {
		t.Fatal("first non-empty snapshot was suppressed")
	}
	if state.shouldEmit("first", base.Add(foregroundShellReplay-time.Nanosecond)) {
		t.Fatal("unchanged snapshot replayed before five seconds")
	}
	if !state.shouldEmit("first", base.Add(foregroundShellReplay)) {
		t.Fatal("unchanged snapshot was not replayed at five seconds")
	}
	if !state.shouldEmit("changed", base.Add(foregroundShellReplay+time.Nanosecond)) {
		t.Fatal("changed snapshot did not emit immediately")
	}
	if state.shouldEmit("changed", base.Add(2*foregroundShellReplay-time.Nanosecond)) {
		t.Fatal("replay interval did not reset after changed output")
	}
	if !state.shouldEmit("changed", base.Add(2*foregroundShellReplay+time.Nanosecond)) {
		t.Fatal("unchanged changed-output snapshot was not eventually replayed")
	}
}

func TestForegroundShellStreamsOutputBeforeItsAuthoritativeResult(t *testing.T) {
	execDir := t.TempDir()
	gate := execDir + "/release"
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	defer func() { _ = os.WriteFile(gate, []byte("release"), 0o644) }()

	var mu sync.Mutex
	var events []capturedShellEvent
	live := make(chan struct{}, 1)
	emit := func(kind string, payload map[string]interface{}) {
		mu.Lock()
		events = append(events, capturedShellEvent{kind: kind, payload: payload})
		mu.Unlock()
		if kind == evToolOutput {
			select {
			case live <- struct{}{}:
			default:
			}
		}
	}

	done := make(chan struct{})
	var output string
	var exit int
	go func() {
		output, exit = runShellTurn(
			ctx,
			execDir,
			"printf stdout; printf stderr >&2; while [ ! -f release ]; do sleep 0.02; done; printf done",
			emit,
			"turn-live",
			nil,
			shellTurnTimeout,
		)
		close(done)
	}()

	select {
	case <-live:
	case <-time.After(3 * time.Second):
		cancel()
		t.Fatal("foreground shell produced no live tool_output while it was blocked")
	}

	mu.Lock()
	snapshot := append([]capturedShellEvent(nil), events...)
	mu.Unlock()
	if len(snapshot) < 2 || snapshot[0].kind != evToolUse || snapshot[1].kind != evToolOutput {
		t.Fatalf("running events = %#v, want tool_use then tool_output", snapshot)
	}
	liveContent, _ := snapshot[1].payload["content"].(string)
	if snapshot[1].payload["toolUseId"] != "shell-turn-live" ||
		!strings.Contains(liveContent, "stdout") || !strings.Contains(liveContent, "stderr") {
		t.Fatalf("live payload = %#v", snapshot[1].payload)
	}
	for _, event := range snapshot {
		if event.kind == evToolResult {
			t.Fatal("tool_result was emitted while the shell was still running")
		}
	}

	if err := os.WriteFile(gate, []byte("release"), 0o644); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		cancel()
		t.Fatal("foreground shell did not finish after release")
	}
	if exit != 0 || !strings.Contains(output, "stdout") || !strings.Contains(output, "stderr") ||
		!strings.Contains(output, "done") {
		t.Fatalf("shell result = (%q, %d)", output, exit)
	}

	mu.Lock()
	snapshot = append([]capturedShellEvent(nil), events...)
	mu.Unlock()
	results := 0
	for i, event := range snapshot {
		if event.kind != evToolResult {
			continue
		}
		results++
		if i != len(snapshot)-1 || event.payload["content"] != output {
			t.Fatalf("authoritative result = %#v at %d of %d", event, i, len(snapshot))
		}
	}
	if results != 1 {
		t.Fatalf("events = %#v, want exactly one final tool_result", snapshot)
	}
}

func TestForegroundShellSnapshotIsTheCappedCurrentTail(t *testing.T) {
	var output shellOutputBuffer
	prefix := strings.Repeat("p", foregroundShellOutputCap)
	tail := strings.Repeat("t", foregroundShellOutputCap)
	if _, err := output.Write([]byte(prefix + tail)); err != nil {
		t.Fatal(err)
	}
	if got := output.snapshot(foregroundShellOutputCap); got != tail {
		t.Fatalf("snapshot length/content = %d/%q", len(got), got[:min(len(got), 16)])
	}
	if got := output.output(); got != prefix+tail {
		t.Fatalf("authoritative output was capped at %d bytes", len(got))
	}
}

func TestForegroundShellSnapshotsDoNotSplitMultibyteUTF8(t *testing.T) {
	tests := []struct {
		name   string
		unit   string
		suffix string
	}{
		// These suffix lengths deliberately put the 1024-byte cut inside the first retained
		// multibyte code point for the corresponding UTF-8 width.
		{name: "CJK", unit: "你", suffix: "xx"},
		{name: "emoji", unit: "🙂", suffix: "x"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			text := strings.Repeat(tc.unit, foregroundShellOutputCap) + tc.suffix
			var ordinary shellOutputBuffer
			_, _ = ordinary.Write([]byte(text))
			// 0227 removed the acceptance runtime's own capped buffer with the typed-termination
			// protocol it streamed for; the foreground shell buffer is the only one left.
			for name, got := range map[string]string{
				"ordinary": ordinary.snapshot(foregroundShellOutputCap),
			} {
				if len(got) > foregroundShellOutputCap {
					t.Fatalf("%s snapshot = %d bytes, exceeds cap", name, len(got))
				}
				if !utf8.ValidString(got) || strings.ContainsRune(got, '\ufffd') {
					t.Fatalf("%s snapshot split %s UTF-8: %q", name, tc.name, got[:min(len(got), 16)])
				}
				if !strings.HasSuffix(text, got) || !strings.HasSuffix(got, tc.suffix) {
					t.Fatalf("%s snapshot is not a whole-character tail", name)
				}
			}
		})
	}
}

func TestCappedUTF8TailDropsAWriterSplitIncompleteRune(t *testing.T) {
	emoji := []byte("🙂")
	for split := 1; split < len(emoji); split++ {
		partial := append([]byte("complete"), emoji[:split]...)
		if got := string(cappedUTF8Tail(partial, foregroundShellOutputCap)); got != "complete" {
			t.Fatalf("split %d kept incomplete UTF-8 suffix: %q", split, got)
		}
	}
	complete := "complete🙂"
	if got := string(cappedUTF8Tail([]byte(complete), foregroundShellOutputCap)); got != complete {
		t.Fatalf("complete rune was removed: %q", got)
	}
	// A complete invalid byte is binary best-effort rather than mistaken for an incomplete rune.
	invalid := []byte{'o', 'k', 0xff}
	if got := cappedUTF8Tail(invalid, foregroundShellOutputCap); len(got) != len(invalid) {
		t.Fatalf("complete invalid binary suffix was removed: %v", got)
	}
}
