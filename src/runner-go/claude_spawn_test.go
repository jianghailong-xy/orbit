package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func claudeSpawnJob(t *testing.T) *ClaimedSession {
	t.Helper()
	t.Setenv("ORBIT_HOME", t.TempDir())
	return &ClaimedSession{
		SessionID:   "sess-1",
		SessionUUID: "11111111-2222-3333-4444-555555555555",
		// The two pieces of user text a claim carries. Neither belongs on a command line.
		Title:  "please rename the widget",
		Prompt: "rename the widget and explain why",
		Agent: AgentExecConfig{
			Model:          "claude-opus-5",
			PermissionMode: "acceptEdits",
		},
	}
}

// The transport contract, read off the argv: print mode, stream-json both ways, and
// --replay-user-messages so a turn written to stdin is echoed back as delivered.
func TestClaudeCommandArgsAskForBidirectionalStreamJSON(t *testing.T) {
	args := claudeCommandArgs(claudeSpawnJob(t), t.TempDir(), true)
	for _, want := range [][]string{
		{"-p"},
		{"--input-format", "stream-json"},
		{"--output-format", "stream-json"},
		{"--replay-user-messages"},
		{"--verbose"},
	} {
		if !containsArgs(args, want) {
			t.Errorf("argv %v is missing %v", args, want)
		}
	}
}

// A persistent-JSONL provider takes every turn as a `user` frame on stdin, so nothing the
// user typed may reach argv — not as a positional prompt, and not smuggled into a flag.
func TestClaudeCommandArgsKeepThePromptOffTheCommandLine(t *testing.T) {
	job := claudeSpawnJob(t)
	args := claudeCommandArgs(job, t.TempDir(), true)
	for _, arg := range args {
		if strings.Contains(arg, job.Prompt) || strings.Contains(arg, job.Title) {
			t.Errorf("argv carries user text: %q", arg)
		}
	}
	for i, arg := range args {
		if strings.HasPrefix(arg, "-") {
			continue
		}
		if i == 0 || !strings.HasPrefix(args[i-1], "-") {
			t.Errorf("argv[%d] = %q is a positional argument; claude takes its prompt on stdin (argv %v)", i, arg, args)
		}
	}
}

// A first spawn opens the conversation; every later one continues it.
func TestClaudeCommandArgsOpenThenResumeTheSameConversation(t *testing.T) {
	job := claudeSpawnJob(t)
	if got := claudeCommandArgs(job, t.TempDir(), true); !containsArgs(got, []string{"--session-id", job.SessionUUID}) {
		t.Errorf("first spawn argv %v does not open %s", got, job.SessionUUID)
	}
	if got := claudeCommandArgs(job, t.TempDir(), false); !containsArgs(got, []string{"--resume", job.SessionUUID}) {
		t.Errorf("re-spawn argv %v does not resume %s", got, job.SessionUUID)
	}
}

// End to end against the fake CLI: the flags we build are the flags the process is started
// with, the handle's stdin is a real open pipe, and `result` is a turn boundary — the same
// process takes the next turn, with no second spawn.
func TestSpawnClaudeDrivesOneProcessAcrossTurns(t *testing.T) {
	fake := newFakeClaude(t,
		fakeStep{Await: "user"},
		fakeStep{Emit: "system_init"},
		fakeStep{Emit: "assistant", Text: "first"},
		fakeStep{Emit: "result", Text: "first"},
		fakeStep{Await: "user"},
		fakeStep{Emit: "result", Text: "second"},
	)
	job := claudeSpawnJob(t)
	t.Setenv("PATH", fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	execDir := t.TempDir()
	args := claudeCommandArgs(job, t.TempDir(), true)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	proc, err := spawnClaude(ctx, job, execDir, args)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { proc.stdin.Close(); proc.cmd.Wait() })

	frames := readFrames(t, proc.stdout)
	for _, turn := range []string{"rename the widget", "and now revert it"} {
		if _, err := io.WriteString(proc.stdin, userFrame(job.SessionUUID, []map[string]interface{}{
			{"type": "text", "text": turn},
		})); err != nil {
			t.Fatalf("write turn to claude stdin: %v", err)
		}
		if got := waitFrameType(t, frames, "result"); got["result"] == nil {
			t.Errorf("result frame without a result: %v", got)
		}
	}

	spawns := fake.Spawns()
	if len(spawns) != 1 {
		t.Fatalf("claude was spawned %d time(s), want 1 for a whole session", len(spawns))
	}
	if diff := argvDiff(spawns[0].Argv, args); diff != "" {
		t.Errorf("the process was started with different flags than we built: %s", diff)
	}
	if spawns[0].Cwd != resolvedPath(t, execDir) {
		t.Errorf("claude cwd = %q, want %q", spawns[0].Cwd, execDir)
	}
	stdin := fake.WaitStdin(2)
	for i, want := range []string{"rename the widget", "and now revert it"} {
		if got := userFrameText(t, stdin[i]); got != want {
			t.Errorf("stdin frame %d carried %q, want %q", i, got, want)
		}
	}
}

// stderr is a pipe of its own, not folded into stdout: the session loop scans it for
// startup refusals that never appear as stream-json.
func TestSpawnClaudeGivesStderrItsOwnPipe(t *testing.T) {
	fake := newFakeClaude(t, fakeStep{Emit: "no-such-frame"})
	job := claudeSpawnJob(t)
	t.Setenv("PATH", fake.Dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	proc, err := spawnClaude(ctx, job, t.TempDir(), claudeCommandArgs(job, t.TempDir(), true))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { proc.stdin.Close(); proc.cmd.Wait() })
	out, err := io.ReadAll(proc.stderr)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), "unknown emit") {
		t.Errorf("stderr pipe carried %q, want the CLI's complaint", out)
	}
	if got, err := io.ReadAll(proc.stdout); err != nil || len(got) != 0 {
		t.Errorf("stdout = %q, %v; want it empty and separate from stderr", got, err)
	}
}

// ---------------------------------------------------------------------------

// containsArgs reports whether want appears in args as a contiguous run.
func containsArgs(args, want []string) bool {
	for i := 0; i+len(want) <= len(args); i++ {
		if equalArgs(args[i:i+len(want)], want) {
			return true
		}
	}
	return false
}

func equalArgs(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func argvDiff(got, want []string) string {
	if equalArgs(got, want) {
		return ""
	}
	return "\n got: " + strings.Join(got, " ") + "\nwant: " + strings.Join(want, " ")
}

// readFrames decodes the CLI's stdout into stream-json frames, so a test can wait on the
// protocol instead of on a duration.
func readFrames(t *testing.T, stdout io.Reader) <-chan map[string]interface{} {
	t.Helper()
	out := make(chan map[string]interface{}, 64)
	go func() {
		defer close(out)
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
		for sc.Scan() {
			var m map[string]interface{}
			if json.Unmarshal(sc.Bytes(), &m) == nil {
				out <- m
			}
		}
	}()
	return out
}

func waitFrameType(t *testing.T, frames <-chan map[string]interface{}, frameType string) map[string]interface{} {
	t.Helper()
	for {
		select {
		case m, ok := <-frames:
			if !ok {
				t.Fatalf("claude stdout closed before a %q frame", frameType)
			}
			if m["type"] == frameType {
				return m
			}
		case <-time.After(fakeClaudeTimeout):
			t.Fatalf("timed out waiting for a %q frame", frameType)
		}
	}
}

// resolvedPath matches the fake's os.Getwd() against a t.TempDir() that may sit behind a
// symlink (/var -> /private/var on macOS).
func resolvedPath(t *testing.T, path string) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return path
	}
	return resolved
}

func userFrameText(t *testing.T, frame map[string]interface{}) string {
	t.Helper()
	msg, _ := frame["message"].(map[string]interface{})
	content, _ := msg["content"].([]interface{})
	for _, block := range content {
		b, _ := block.(map[string]interface{})
		if b["type"] == "text" {
			text, _ := b["text"].(string)
			return text
		}
	}
	t.Fatalf("no text block in user frame %v", frame)
	return ""
}
