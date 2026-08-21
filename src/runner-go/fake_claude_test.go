package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A scripted stand-in for the `claude` CLI, so the stream-json protocol can be exercised
// without an account, a network or a real model. The fake is this very test binary
// re-executed through a tiny shim named `claude`: point PATH (or exec.Command) at
// fakeClaude.Dir and the code under test spawns it exactly as it spawns the real CLI.
//
// What it gives a test:
//   - every spawn's argv/cwd/pid recorded in spawns.jsonl (so "did it spawn twice?" is answerable)
//   - every stdin JSONL frame recorded in stdin.jsonl, in order, as received
//   - a script of frames to emit and frames to wait for, so timing is driven by the
//     protocol itself rather than by sleeps
//   - life after `result`: result is only a turn boundary, so the process keeps running
//     until stdin closes or the script says eof
const fakeClaudeDirEnv = "ORBIT_FAKE_CLAUDE_DIR"

// How long the fake waits on an `await` step, and how long the parent side waits for a
// frame or a recording, before giving up. Only ever hit when something is wedged: a
// bounded failure beats a ten-minute test timeout with no output.
const fakeClaudeTimeout = 10 * time.Second

// TestMain doubles as the fake CLI's entry point. The shim sets fakeClaudeDirEnv, so the
// dispatch happens before the testing flags are parsed — claude's own argv (`-p`,
// `--input-format`…) never reaches the test framework.
func TestMain(m *testing.M) {
	if dir := os.Getenv(fakeClaudeDirEnv); dir != "" {
		os.Exit(runFakeClaude(dir))
	}
	os.Exit(m.Run())
}

// fakeStep is one instruction of a fake CLI script: emit a frame, or block until one
// arrives. Steps run in order; the process outlives the last one.
type fakeStep struct {
	// Emit: system_init | assistant | tool_use | tool_result | result | control_request |
	// control_response | replay_user | stop_reading | eof (eof exits, closing stdout).
	//
	// replay_user is what --replay-user-messages does: echo the user frame just awaited
	// back on stdout, verbatim, as the CLI does when it reads one off stdin.
	//
	// stop_reading stands in for a CLI busy inside a tool call: the process stays up and
	// keeps writing to stdout, but never takes another byte off stdin, so its pipe fills
	// and stays full. It must be the whole script's decision — it is read before the
	// reader starts — and a script that uses it has no `await` steps to run.
	Emit string `json:"emit,omitempty"`
	// Await: user | control_request | control_response, optionally narrowed by Subtype
	// (control_request) or RequestID (control_response).
	Await     string                 `json:"await,omitempty"`
	Subtype   string                 `json:"subtype,omitempty"`
	Text      string                 `json:"text,omitempty"`
	ToolUseID string                 `json:"toolUseId,omitempty"`
	ToolName  string                 `json:"toolName,omitempty"`
	Input     map[string]interface{} `json:"input,omitempty"`
	// RequestID of a control_request to emit, or of the control_response to await. Empty
	// on an emitted control_response means "answer the last control_request awaited".
	RequestID string                 `json:"requestId,omitempty"`
	Request   map[string]interface{} `json:"request,omitempty"`
	Response  map[string]interface{} `json:"response,omitempty"`
	IsError   bool                   `json:"isError,omitempty"`
}

type fakeSpawn struct {
	PID  int      `json:"pid"`
	Argv []string `json:"argv"`
	Cwd  string   `json:"cwd"`
}

// ---------------------------------------------------------------------------
// child side: the fake CLI itself
// ---------------------------------------------------------------------------

func runFakeClaude(dir string) int {
	argv := os.Args[1:]
	cwd, _ := os.Getwd()
	appendJSONL(filepath.Join(dir, "spawns.jsonl"), fakeSpawn{PID: os.Getpid(), Argv: argv, Cwd: cwd})

	var steps []fakeStep
	b, err := os.ReadFile(filepath.Join(dir, "script.json"))
	if err == nil {
		err = json.Unmarshal(b, &steps)
	}
	if err != nil {
		io.WriteString(os.Stderr, "fake claude: bad script: "+err.Error()+"\n")
		return 2
	}

	// One channel per frame kind so a frame nobody is waiting for yet (an interrupt during
	// a turn, say) never blocks the reader.
	users := make(chan map[string]interface{}, 64)
	ctrlReqs := make(chan map[string]interface{}, 64)
	ctrlResps := make(chan map[string]interface{}, 64)
	closed := make(chan struct{})
	if !scriptStopsReading(steps) {
		go readFakeStdin(filepath.Join(dir, "stdin.jsonl"), users, ctrlReqs, ctrlResps, closed)
	}

	sessionID := argValue(argv, "--session-id")
	if sessionID == "" {
		sessionID = argValue(argv, "--resume")
	}
	lastReqID := ""
	// The user frame most recently read off stdin, kept so a replay_user step can echo the
	// real thing rather than a reconstruction — that is what --replay-user-messages emits.
	var lastUser map[string]interface{}
	for _, s := range steps {
		if s.Await != "" {
			var msg map[string]interface{}
			var ok bool
			switch s.Await {
			case "user":
				msg, ok = awaitFrame(users, closed, func(map[string]interface{}) bool { return true })
				if ok {
					lastUser = msg
				}
			case "control_request":
				msg, ok = awaitFrame(ctrlReqs, closed, func(m map[string]interface{}) bool {
					req, _ := m["request"].(map[string]interface{})
					return s.Subtype == "" || (req != nil && req["subtype"] == s.Subtype)
				})
				if ok {
					lastReqID, _ = msg["request_id"].(string)
				}
			case "control_response":
				msg, ok = awaitFrame(ctrlResps, closed, func(m map[string]interface{}) bool {
					resp, _ := m["response"].(map[string]interface{})
					return s.RequestID == "" || (resp != nil && resp["request_id"] == s.RequestID)
				})
			default:
				io.WriteString(os.Stderr, "fake claude: unknown await "+s.Await+"\n")
				return 2
			}
			if !ok {
				return 0 // stdin closed or timed out: nothing left to answer
			}
			continue
		}
		if s.Emit == "eof" {
			return 0
		}
		if s.Emit == "stop_reading" {
			continue // stdin is simply never read; see scriptStopsReading
		}
		if s.Emit == "replay_user" {
			if lastUser == nil {
				io.WriteString(os.Stderr, "fake claude: replay_user with no user frame read\n")
				return 2
			}
			if _, err := io.WriteString(os.Stdout, marshalFrame(lastUser)); err != nil {
				return 1
			}
			continue
		}
		frame, err := fakeFrame(s, sessionID, lastReqID, argValue(argv, "--model"))
		if err != nil {
			io.WriteString(os.Stderr, "fake claude: "+err.Error()+"\n")
			return 2
		}
		if _, err := io.WriteString(os.Stdout, frame); err != nil {
			return 1
		}
	}
	// `result` is a turn boundary, not the end of the process: stay up for the next turn
	// until the driver closes stdin.
	<-closed
	return 0
}

func scriptStopsReading(steps []fakeStep) bool {
	for _, s := range steps {
		if s.Emit == "stop_reading" {
			return true
		}
	}
	return false
}

// readFakeStdin records every frame verbatim, in arrival order, then routes it by type.
func readFakeStdin(recordPath string, users, ctrlReqs, ctrlResps chan<- map[string]interface{}, closed chan<- struct{}) {
	defer close(closed)
	rec, err := os.OpenFile(recordPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	defer rec.Close()
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024) // image blocks are large
	for sc.Scan() {
		line := sc.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}
		rec.WriteString(line + "\n") // unbuffered: the parent may be polling this file
		var msg map[string]interface{}
		if json.Unmarshal([]byte(line), &msg) != nil {
			continue
		}
		switch msg["type"] {
		case frameUser:
			users <- msg
		case frameControlRequest:
			ctrlReqs <- msg
		case frameControlResponse:
			ctrlResps <- msg
		}
	}
}

func awaitFrame(ch <-chan map[string]interface{}, closed <-chan struct{}, match func(map[string]interface{}) bool) (map[string]interface{}, bool) {
	deadline := time.After(fakeClaudeTimeout)
	for {
		select {
		case msg := <-ch:
			if match(msg) {
				return msg, true
			}
		case <-closed:
			// Drain what already arrived before stdin ended, then give up.
			for {
				select {
				case msg := <-ch:
					if match(msg) {
						return msg, true
					}
				default:
					return nil, false
				}
			}
		case <-deadline:
			io.WriteString(os.Stderr, "fake claude: timed out waiting for a frame\n")
			return nil, false
		}
	}
}

// fakeFrame renders the CLI-side wire shape for one emit step. Written from literals
// rather than through claude_protocol.go so the two sides of the contract stay
// independent: a test that passes proves agreement, not shared code.
func fakeFrame(s fakeStep, sessionID, lastReqID, model string) (string, error) {
	switch s.Emit {
	case "system_init":
		return marshalFrame(map[string]interface{}{
			"type": "system", "subtype": "init", "session_id": sessionID,
			"model": model, "slash_commands": []interface{}{}, "skills": []interface{}{},
		}), nil
	case "assistant":
		return assistantFrame(sessionID, map[string]interface{}{"type": "text", "text": s.Text}), nil
	case "tool_use":
		input := s.Input
		if input == nil {
			input = map[string]interface{}{}
		}
		return assistantFrame(sessionID, map[string]interface{}{
			"type": "tool_use", "id": s.ToolUseID, "name": s.ToolName, "input": input,
		}), nil
	case "tool_result":
		// Tool results come back as a user-role message, per the Anthropic message protocol.
		return marshalFrame(map[string]interface{}{
			"type": "user", "session_id": sessionID, "parent_tool_use_id": nil,
			"message": map[string]interface{}{"role": "user", "content": []interface{}{
				map[string]interface{}{
					"type": "tool_result", "tool_use_id": s.ToolUseID,
					"content": s.Text, "is_error": s.IsError,
				},
			}},
		}), nil
	case "result":
		subtype := s.Subtype
		if subtype == "" {
			subtype = "success"
		}
		return marshalFrame(map[string]interface{}{
			"type": "result", "subtype": subtype, "is_error": s.IsError,
			"num_turns": 1, "result": s.Text, "session_id": sessionID,
		}), nil
	case "control_request":
		req := map[string]interface{}{"subtype": s.Subtype}
		for k, v := range s.Request {
			req[k] = v
		}
		return marshalFrame(map[string]interface{}{
			"type": "control_request", "request_id": s.RequestID, "request": req,
		}), nil
	case "control_response":
		id := s.RequestID
		if id == "" {
			id = lastReqID // answer whatever we last waited for
		}
		resp := map[string]interface{}{"subtype": "success", "request_id": id, "response": s.Response}
		if s.IsError {
			resp = map[string]interface{}{"subtype": "error", "request_id": id, "error": s.Text}
		}
		return marshalFrame(map[string]interface{}{"type": "control_response", "response": resp}), nil
	}
	return "", errors.New("unknown emit " + s.Emit)
}

func assistantFrame(sessionID string, block map[string]interface{}) string {
	return marshalFrame(map[string]interface{}{
		"type": "assistant", "session_id": sessionID, "parent_tool_use_id": nil,
		"message": map[string]interface{}{
			"role": "assistant", "content": []interface{}{block},
		},
	})
}

func argValue(argv []string, flag string) string {
	for i, a := range argv {
		if a == flag && i+1 < len(argv) {
			return argv[i+1]
		}
		if v, ok := strings.CutPrefix(a, flag+"="); ok {
			return v
		}
	}
	return ""
}

func appendJSONL(path string, v interface{}) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	b, _ := json.Marshal(v)
	f.Write(append(b, '\n'))
}

// ---------------------------------------------------------------------------
// parent side: the fixture a test holds
// ---------------------------------------------------------------------------

type fakeClaude struct {
	t   *testing.T
	Dir string // holds the `claude` shim; prepend to PATH to have it spawned as the CLI
	rec string // recordings + script
}

// newFakeClaude writes a `claude` shim running the given script.
func newFakeClaude(t *testing.T, steps ...fakeStep) *fakeClaude {
	t.Helper()
	base := t.TempDir()
	binDir, rec := filepath.Join(base, "bin"), filepath.Join(base, "rec")
	for _, d := range []string{binDir, rec} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	script, err := json.Marshal(steps)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rec, "script.json"), script, 0o644); err != nil {
		t.Fatal(err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	// The env var is set by the shim, not exported into the test process, so no other
	// subprocess a test spawns can be turned into a fake CLI by accident.
	shim := "#!/bin/sh\n" + fakeClaudeDirEnv + "='" + rec + "' exec '" + self + "' \"$@\"\n"
	if err := os.WriteFile(filepath.Join(binDir, "claude"), []byte(shim), 0o755); err != nil {
		t.Fatal(err)
	}
	return &fakeClaude{t: t, Dir: binDir, rec: rec}
}

func (f *fakeClaude) Path() string { return filepath.Join(f.Dir, "claude") }

// Spawns returns one record per exec of the fake, oldest first.
func (f *fakeClaude) Spawns() []fakeSpawn {
	f.t.Helper()
	var out []fakeSpawn
	for _, line := range f.readLines("spawns.jsonl") {
		var s fakeSpawn
		if err := json.Unmarshal([]byte(line), &s); err != nil {
			f.t.Fatalf("bad spawn record %q: %v", line, err)
		}
		out = append(out, s)
	}
	return out
}

// Stdin returns the frames written to the fake's stdin so far, in arrival order.
func (f *fakeClaude) Stdin() []map[string]interface{} {
	f.t.Helper()
	var out []map[string]interface{}
	for _, line := range f.readLines("stdin.jsonl") {
		var m map[string]interface{}
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			f.t.Fatalf("bad stdin record %q: %v", line, err)
		}
		out = append(out, m)
	}
	return out
}

// WaitStdin blocks until at least n frames have been recorded, then returns them. Bounded
// by fakeClaudeTimeout and returning the moment the count is reached, so a test never
// waits on a fixed duration.
func (f *fakeClaude) WaitStdin(n int) []map[string]interface{} {
	f.t.Helper()
	deadline := time.Now().Add(fakeClaudeTimeout)
	for {
		got := f.Stdin()
		if len(got) >= n {
			return got
		}
		if time.Now().After(deadline) {
			f.t.Fatalf("only %d stdin frame(s) recorded, want %d", len(got), n)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func (f *fakeClaude) readLines(name string) []string {
	b, err := os.ReadFile(filepath.Join(f.rec, name))
	if err != nil {
		return nil // not spawned yet, or nothing recorded
	}
	var out []string
	for _, line := range strings.Split(string(b), "\n") {
		if strings.TrimSpace(line) != "" {
			out = append(out, line)
		}
	}
	return out
}

// fakeClaudeRun is a running fake, driven directly (no session loop in between).
type fakeClaudeRun struct {
	t      *testing.T
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	frames chan map[string]interface{}
}

func (f *fakeClaude) start(args ...string) *fakeClaudeRun {
	f.t.Helper()
	cmd := exec.Command(f.Path(), args...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		f.t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		f.t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		f.t.Fatal(err)
	}
	r := &fakeClaudeRun{t: f.t, cmd: cmd, stdin: stdin, frames: make(chan map[string]interface{}, 64)}
	go func() {
		defer close(r.frames)
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
		for sc.Scan() {
			var m map[string]interface{}
			if json.Unmarshal(sc.Bytes(), &m) == nil {
				r.frames <- m
			}
		}
	}()
	f.t.Cleanup(func() {
		stdin.Close()
		cmd.Process.Kill()
		cmd.Wait()
	})
	return r
}

func (r *fakeClaudeRun) send(line string) {
	r.t.Helper()
	if _, err := io.WriteString(r.stdin, line); err != nil {
		r.t.Fatalf("write to fake claude: %v", err)
	}
}

// next returns the next frame the fake emitted; ok=false means its stdout hit EOF.
func (r *fakeClaudeRun) next() (map[string]interface{}, bool) {
	r.t.Helper()
	select {
	case m, ok := <-r.frames:
		return m, ok
	case <-time.After(fakeClaudeTimeout):
		r.t.Fatal("timed out waiting for a frame from the fake claude")
		return nil, false
	}
}

// nextOfType skips frames until one of the given type arrives (partial/streaming frames
// are not this fixture's business, but callers should not have to care about order noise).
func (r *fakeClaudeRun) nextOfType(frameType string) map[string]interface{} {
	r.t.Helper()
	for {
		m, ok := r.next()
		if !ok {
			r.t.Fatalf("stdout closed before a %q frame", frameType)
		}
		if m["type"] == frameType {
			return m
		}
	}
}

func (r *fakeClaudeRun) closeStdin() { r.stdin.Close() }

// waitExit asserts the process exits (i.e. stdin EOF is terminal) and returns its error.
func (r *fakeClaudeRun) waitExit() error {
	r.t.Helper()
	done := make(chan error, 1)
	go func() { done <- r.cmd.Wait() }()
	select {
	case err := <-done:
		return err
	case <-time.After(fakeClaudeTimeout):
		r.t.Fatal("fake claude did not exit after stdin closed")
		return nil
	}
}
