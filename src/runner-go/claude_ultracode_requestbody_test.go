package main

// Whether Orbit's Ultra reaches Claude Code as ultracode, read off the API requests a real
// `claude` makes. Same recording proxy as claude_effort_requestbody_test.go, for the same
// reason: apply_flag_settings answers `success` to anything, so only the requests can say
// whether a frame did something.
//
// Ultracode shows in two places. Its effort is xhigh, in `output_config.effort`. And the engine
// tells the model the mode is on with a reminder in the conversation — "Ultracode is on: …" on
// entering, "Ultracode is off …" on leaving — which is the only thing that tells ultracode from
// a plain xhigh. The reminder is attached with a user turn: a frame sent mid-turn moves the
// effort of the calls that follow at once, and its reminder shows on the NEXT turn. So every
// probe here runs two turns.
//
// The Workflow tool's own description says "Ultracode is on for the session", so the reminders
// are matched on text only the reminders have.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	ultracodeOnReminder      = "Ultracode is on:"
	ultracodeStillOnReminder = "Ultracode is still on"
	ultracodeOffReminder     = "Ultracode is off"
)

// ultracodeCall is what one API call of the probe's turns carried.
type ultracodeCall struct {
	effort string
	on     bool // the conversation carries the entering (or standing) ultracode reminder
	off    bool // it carries the leaving one
}

// A session spawned on Ultra is in ultracode from its first request. The paired control is a
// plain xhigh spawn: the same effort, and no mode.
func TestRealClaudeUltraSpawnsIntoUltracode(t *testing.T) {
	ultra := driveUltracodeProbe(t, claudeUltraEffort, noEffortFrame)
	xhigh := driveUltracodeProbe(t, "xhigh", noEffortFrame)

	for i, c := range ultra {
		if c.effort != "xhigh" || !c.on {
			t.Errorf("call %d of a session spawned on ultra carried effort %q, ultracode reminder %v; want xhigh with the reminder",
				i+1, c.effort, c.on)
		}
	}
	for i, c := range xhigh {
		if c.effort != "xhigh" || c.on {
			t.Errorf("call %d of the xhigh control carried effort %q, ultracode reminder %v; want xhigh and no reminder",
				i+1, c.effort, c.on)
		}
	}
}

// Asked for Ultra mid-turn, the running engine moves to xhigh at once and says ultracode is on
// with the next turn.
func TestRealClaudeUltraFrameEntersUltracodeOnTheRunningEngine(t *testing.T) {
	entered := driveUltracodeProbe(t, "low", claudeUltraEffort)
	control := driveUltracodeProbe(t, "low", noEffortFrame)

	if c := entered[0]; c.effort != "low" || c.on {
		t.Errorf("the first call carried effort %q, ultracode reminder %v; it was built before the frame was sent", c.effort, c.on)
	}
	for i, c := range entered[1:] {
		if c.effort != "xhigh" {
			t.Errorf("call %d after the frame carried effort %q, want xhigh", i+2, c.effort)
		}
	}
	if last := entered[len(entered)-1]; !last.on {
		t.Errorf("the turn after the frame carried no ultracode reminder: the effort moved and the mode did not")
	}
	for i, c := range control {
		if c.effort != "low" || c.on {
			t.Errorf("call %d of the control carried effort %q, ultracode reminder %v; nothing asked it to change", i+1, c.effort, c.on)
		}
	}
}

// Leaving Ultra for xhigh — the one level where the effort cannot show the difference — switches
// ultracode off. An effortLevel on its own does not, so this is the arm that goes red if the
// frame stops saying `"ultracode":false`.
func TestRealClaudeLeavingUltraSwitchesUltracodeOff(t *testing.T) {
	left := driveUltracodeProbe(t, claudeUltraEffort, "xhigh")
	control := driveUltracodeProbe(t, claudeUltraEffort, noEffortFrame)

	if last := left[len(left)-1]; last.effort != "xhigh" || !last.off {
		t.Errorf("the turn after leaving ultra for xhigh carried effort %q, leaving reminder %v; want xhigh with ultracode switched off",
			last.effort, last.off)
	}
	for i, c := range control {
		if c.off {
			t.Errorf("call %d of the control carried the leaving reminder; nothing asked it to leave", i+1)
		}
	}
}

// driveUltracodeProbe runs two scripted turns against a real CLI spawned on `spawnEffort` and
// returns what each API call carried: three calls for the first turn (two Reads, then an
// answer), one for the second. `askFor` is the effort a frame asks for while the first call is
// held, and noEffortFrame sends none. Spawn flags and frame both come from production
// (realClaudeTransportArgs spells --effort as claudeCommandArgs does; setConfigFrames builds
// the frame).
func driveUltracodeProbe(t *testing.T, spawnEffort, askFor string) []ultracodeCall {
	t.Helper()
	exe := requireRealClaude(t)
	if version := engineVersion(exe); !claudeVersionAtLeast(version, claudeUltracodeFloor) {
		t.Skipf("claude %q is older than %s, the version ultracode was measured on; Orbit re-spawns such an engine rather than send it the frame",
			version, claudeUltracodeFloor)
	}
	requireNoEffortEnvOverride(t)
	for _, name := range []string{"CLAUDE_CODE_WORKFLOWS", "CLAUDE_CODE_DISABLE_WORKFLOWS"} {
		if got := os.Getenv(name); got != "" {
			t.Fatalf("%s=%q is set in this environment; it decides whether ultracode can be on at all, so this probe cannot measure through it", name, got)
		}
	}

	work := t.TempDir()
	readable := filepath.Join(work, "probe.txt")
	if err := os.WriteFile(readable, []byte("orbit ultracode probe\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	rec := &ultracodeRecorder{read: readable, firstCall: make(chan struct{}), release: make(chan struct{}), turnTwo: make(chan struct{})}
	api := httptest.NewServer(rec)
	t.Cleanup(api.Close)

	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	if err := os.WriteFile(filepath.Join(home, ".claude.json"),
		[]byte(`{"hasCompletedOnboarding":true}`), 0o600); err != nil {
		t.Fatal(err)
	}

	job := &ClaimedSession{
		SessionID:   "real-claude-ultracode-requestbody",
		SessionUUID: newContractSessionUUID(t),
		Provider:    providerClaude,
		Agent: AgentExecConfig{
			Provider:       providerClaude,
			Model:          effortProbeModel,
			PermissionMode: "default",
			Effort:         spawnEffort,
			Env: map[string]string{
				"ANTHROPIC_BASE_URL":   api.URL,
				"ANTHROPIC_AUTH_TOKEN": "orbit-ultracode-probe",
			},
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	proc, err := spawnClaude(ctx, job, work, realClaudeTransportArgs(job))
	if err != nil {
		cancel()
		t.Fatalf("spawning claude: %v", err)
	}
	rt := newClaudeRuntime(proc)
	var stderr strings.Builder
	var stderrMu sync.Mutex
	go func() {
		b, _ := io.ReadAll(proc.stderr)
		stderrMu.Lock()
		stderr.Write(b)
		stderrMu.Unlock()
	}()
	engineOutput := func() string {
		stderrMu.Lock()
		defer stderrMu.Unlock()
		if stderr.Len() == 0 {
			return ""
		}
		return "\nclaude stderr:\n" + stderr.String()
	}
	results := make(chan struct{}, 4)
	done := make(chan struct{})
	go func() {
		defer close(done)
		readUltracodeProbeStdout(proc.stdout, rt, results)
	}()
	t.Cleanup(func() {
		rec.releaseFirstCall()
		cancel()
		<-done
	})

	await := func(what string, ch <-chan struct{}) {
		t.Helper()
		select {
		case <-ch:
		case <-done:
			t.Fatalf("claude exited waiting for %s; API calls so far: %+v%s", what, rec.snapshot(), engineOutput())
		case <-time.After(effortProbeTimeout):
			t.Fatalf("no %s within %s; API calls so far: %+v%s", what, effortProbeTimeout, rec.snapshot(), engineOutput())
		}
	}

	if err := rt.send(userFrame(job.SessionUUID, []map[string]interface{}{
		{"type": "text", "text": "Read " + readable + " twice, then say DONE."},
	})); err != nil {
		t.Fatalf("feeding the first turn: %v", err)
	}
	await("first API call", rec.firstCall)
	if askFor != noEffortFrame {
		frames, err := setConfigFrames(`{"effort":`+quoteJSON(askFor)+`}`, job.Agent)
		if err != nil || len(frames) != 1 {
			t.Fatalf("setConfigFrames for effort %q = %v, %v; want exactly one frame", askFor, subtypesOf(frames), err)
		}
		w, err := rt.requestControlWith(frames[0].subtype, frames[0].payload)
		if err != nil {
			t.Fatalf("sending the effort frame: %v", err)
		}
		if err := rt.awaitControl(context.Background(), w, effortProbeTimeout); err != nil {
			t.Fatalf("claude refused the effort frame: %v%s", err, engineOutput())
		}
	}
	rec.releaseFirstCall()
	await("first turn's result", results)

	if err := rt.send(userFrame(job.SessionUUID, []map[string]interface{}{
		{"type": "text", "text": "Say DONE again."},
	})); err != nil {
		t.Fatalf("feeding the second turn: %v", err)
	}
	await("second turn's API call", rec.turnTwo)
	await("second turn's result", results)

	calls := rec.snapshot()
	if len(calls) != ultracodeProbeCalls {
		t.Fatalf("the two turns made %d API calls %+v, want %d", len(calls), calls, ultracodeProbeCalls)
	}
	t.Logf("spawn effort %q, asked for %q: %+v", spawnEffort, askFor, calls)
	return calls
}

// The two turns' script, by call: two Reads and an answer, then one answer.
const (
	ultracodeProbeToolCalls = 2
	ultracodeProbeCalls     = 4
)

// ultracodeRecorder is the API `claude` talks to. It records what each completion carried and
// holds the first one open until the test has decided whether to send a frame.
type ultracodeRecorder struct {
	read string

	mu    sync.Mutex
	calls []ultracodeCall

	firstCall   chan struct{}
	release     chan struct{}
	turnTwo     chan struct{}
	releaseOnce sync.Once
}

func (rec *ultracodeRecorder) releaseFirstCall() {
	rec.releaseOnce.Do(func() { close(rec.release) })
}

func (rec *ultracodeRecorder) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	if r.Method != http.MethodPost || !strings.HasSuffix(r.URL.Path, "/v1/messages") {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
		return
	}
	var req struct {
		OutputConfig map[string]interface{} `json:"output_config"`
	}
	_ = json.Unmarshal(body, &req)
	if _, side := req.OutputConfig["format"]; side { // the conversation-title side call
		writeCannedStream(w, textReply(`{"title":"orbit ultracode probe","isNewTopic":false}`))
		return
	}
	effort, _ := req.OutputConfig["effort"].(string)
	text := string(body)
	rec.mu.Lock()
	n := len(rec.calls)
	rec.calls = append(rec.calls, ultracodeCall{
		effort: effort,
		on:     strings.Contains(text, ultracodeOnReminder) || strings.Contains(text, ultracodeStillOnReminder),
		off:    strings.Contains(text, ultracodeOffReminder),
	})
	rec.mu.Unlock()
	switch {
	case n == 0:
		close(rec.firstCall)
		<-rec.release
	case n == ultracodeProbeCalls-1:
		close(rec.turnTwo)
	}
	if n < ultracodeProbeToolCalls {
		writeCannedStream(w, readToolReply(fmt.Sprintf("toolu_%d", n+1), rec.read))
		return
	}
	writeCannedStream(w, textReply("DONE"))
}

func (rec *ultracodeRecorder) snapshot() []ultracodeCall {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	return append([]ultracodeCall(nil), rec.calls...)
}

// readUltracodeProbeStdout is readEffortProbeStdout plus the one frame a second turn has to
// wait for: each turn's `result`.
func readUltracodeProbeStdout(stdout io.Reader, rt *claudeRuntime, results chan<- struct{}) {
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 1024*1024), 16*1024*1024)
	for sc.Scan() {
		var msg map[string]interface{}
		if json.Unmarshal(sc.Bytes(), &msg) != nil {
			continue
		}
		if resp, ok := parseControlResponse(msg); ok {
			rt.resolveControl(resp)
		}
		if msg["type"] == "result" {
			select {
			case results <- struct{}{}:
			default:
			}
		}
	}
	rt.failPendingControl(errRuntimeGone)
}
