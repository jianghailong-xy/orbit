package main

// Whether a reasoning-effort control frame actually changes anything, read off the API
// requests a real `claude` makes.
//
// Every other test of this feature can only assert what Orbit sent. This one is here
// because that is not enough for THIS frame: apply_flag_settings answers
// `{"subtype":"success"}` whatever it is handed — an unknown settings key, a level that is
// not a level, an empty settings object, a CLI that never had the setting — emits no status
// frame afterwards, and puts nothing in its init handshake. So a suite built on the
// engine's answers would stay green with the feature completely dead, and the runner would
// go on reporting "applied to the running engine" while every request carried the old
// level.
//
// The only place the truth is visible is `output_config.effort` on the requests the CLI
// sends to /v1/messages. So the probe stands where the API is: ANTHROPIC_BASE_URL points at
// a local server, which records each request body and answers it with a canned stream. That
// makes this hermetic and free — no credentials, no network, no tokens — and it is why this
// can sit in the default suite rather than in a manual procedure nobody runs. The engine
// still does everything it really does: reads its flags, services its control channel, runs
// a tool, and builds each request from whatever state it is actually in.
//
// Every arm is paired with a control that runs the identical script and sends no frame.
// Without that, "the second call says xhigh" would be satisfied by a CLI that had been
// spawned that way — which is exactly the mistake the earlier judgement about effort was
// built on.
//
// One environment variable would invalidate all of it: CLAUDE_CODE_EFFORT_LEVEL makes the
// frame inert while still answering `success`. Orbit never sets it, and the probes assert
// that nothing in the environment they inherit does either.

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

// effortProbeTimeout bounds one whole scripted turn — three canned API round trips over
// loopback and one Read of a file the test wrote. Generous because a cold `claude` on a
// loaded machine is slow to start and a test that reds for that teaches people to re-run it.
const effortProbeTimeout = 120 * time.Second

// The level a probe spawns on, and the one it asks for. Different on purpose, and neither is
// the model's own default, so "the request changed" cannot be confused with "the request was
// always going to say that".
const (
	effortProbeSpawnLevel = "low"
	effortProbeAskedLevel = "xhigh"
	// Effort is a per-MODEL capability, not a per-CLI one: a request for a model that does
	// not take it carries no output_config.effort at all (measured: haiku 4.5 sends the key
	// nowhere, which would make every arm here read the same empty string and agree). The
	// probe therefore names a model that does, and can afford to — nothing it says reaches a
	// real API, so the choice costs neither tokens nor time.
	effortProbeModel = "claude-sonnet-5"
)

// A frame injected mid-turn moves every request the turn goes on to make.
//
// The frame is sent while the engine is inside its first API call — the recorder holds that
// response until the control_response has come back — so the two calls after it are calls
// the engine builds with the frame already applied. The control arm waits at the same point
// and sends nothing.
func TestRealClaudeEffortFrameMovesTheRequestsOfTheRunningTurn(t *testing.T) {
	changed := driveEffortProbe(t, effortProbeSpawnLevel, effortProbeAskedLevel)
	control := driveEffortProbe(t, effortProbeSpawnLevel, noEffortFrame)

	if len(control) < 2 {
		t.Fatalf("the control turn made %d API call(s) %v; this probe needs at least two to say anything", len(control), control)
	}
	for i, effort := range control {
		if effort != effortProbeSpawnLevel {
			t.Errorf("the control turn's call %d carried effort %q, want the %q it was spawned with — nothing asked it to change",
				i+1, effort, effortProbeSpawnLevel)
		}
	}
	if len(changed) != len(control) {
		t.Errorf("the two arms made different numbers of API calls (%v vs %v); they are meant to run the same script", changed, control)
	}
	if len(changed) < 2 {
		t.Fatalf("the turn that was told made %d API call(s) %v; there is no post-frame call to read", len(changed), changed)
	}
	// The call already in flight when the frame was sent was built before it, and is left
	// exactly where the control arm's is. A CLI that retroactively changed it would be
	// reporting something other than what it did.
	if changed[0] != effortProbeSpawnLevel {
		t.Errorf("the first call carried effort %q, want %q: it was built before the frame was sent", changed[0], effortProbeSpawnLevel)
	}
	for i, effort := range changed[1:] {
		if effort != effortProbeAskedLevel {
			t.Errorf("call %d of the turn carried effort %q, want %q — the frame was answered `success` and the request did not move",
				i+2, effort, effortProbeAskedLevel)
		}
	}
}

// Clearing an effort hands the model back its own default, which is what Orbit's empty
// effort has always meant at spawn (no --effort flag at all).
//
// Asserted against a process spawned that way rather than against a level written into this
// test: what the default IS belongs to the model, and a hard-coded "high" would go stale the
// day it changes and would say nothing about the two being the same thing.
func TestRealClaudeEffortFrameClearsBackToTheModelDefault(t *testing.T) {
	cleared := driveEffortProbe(t, effortProbeSpawnLevel, "")
	spawnedWithout := driveEffortProbe(t, "", noEffortFrame)
	held := driveEffortProbe(t, effortProbeSpawnLevel, noEffortFrame)

	if len(cleared) < 2 || len(spawnedWithout) < 1 || len(held) < 2 {
		t.Fatalf("an arm made too few API calls to compare: cleared=%v spawned-without=%v control=%v", cleared, spawnedWithout, held)
	}
	modelDefault := spawnedWithout[0]
	if modelDefault == effortProbeSpawnLevel {
		t.Fatalf("this model's own default is %q, the same level the other arms spawn on, so clearing could not be told from doing nothing",
			modelDefault)
	}
	for i, effort := range cleared[1:] {
		if effort != modelDefault {
			t.Errorf("call %d after the effort was cleared carried %q, want the model's default %q (what a spawn with no --effort sends)",
				i+2, effort, modelDefault)
		}
	}
	// The paired control: the same turn, not cleared, stays on the level it was spawned with.
	for i, effort := range held {
		if effort != effortProbeSpawnLevel {
			t.Errorf("the control turn's call %d carried %q, want %q", i+1, effort, effortProbeSpawnLevel)
		}
	}
}

// noEffortFrame marks the arm that sends no control frame at all — the control group, spelled
// so it cannot be confused with clearing the effort (which is the empty string).
const noEffortFrame = "\x00none"

// driveEffortProbe runs one whole scripted turn against a real CLI and returns the effort
// each of its API calls carried, in order.
//
// `spawnEffort` is what the process is built with ("" leaves --effort off, as production
// does for a session with no effort). `askFor` is the level a mid-turn frame asks for, ""
// clears it, and noEffortFrame sends nothing.
//
// The frame goes out through the production path — setConfigFrames builds it,
// requestControlWith writes it, awaitControl reads the answer — so what is being measured is
// the runner's own bytes and not a re-implementation of them.
func driveEffortProbe(t *testing.T, spawnEffort, askFor string) []string {
	t.Helper()
	requireRealClaude(t)
	requireNoEffortEnvOverride(t)

	work := t.TempDir()
	// The tool call that makes the turn take more than one API call. Read needs no approval
	// under the default permission mode, so the probe spawns with production's own flags
	// rather than widening them for the test.
	readable := filepath.Join(work, "probe.txt")
	if err := os.WriteFile(readable, []byte("orbit effort probe\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	rec := &effortRecorder{read: readable, firstCall: make(chan struct{}), release: make(chan struct{})}
	api := httptest.NewServer(rec)
	t.Cleanup(api.Close)

	// Nothing here may touch this machine's own Claude Code state, and nothing here needs a
	// credential: the API this process talks to is the recorder above.
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	if err := os.WriteFile(filepath.Join(home, ".claude.json"),
		[]byte(`{"hasCompletedOnboarding":true}`), 0o600); err != nil {
		t.Fatal(err)
	}

	job := &ClaimedSession{
		SessionID:   "real-claude-effort-requestbody",
		SessionUUID: newContractSessionUUID(t),
		Provider:    providerClaude,
		Agent: AgentExecConfig{
			Provider:       providerClaude,
			Model:          effortProbeModel,
			PermissionMode: "default",
			Effort:         spawnEffort,
			// The same door a configured (BYOK) provider comes through, which is why this
			// needs no test-only hook in the spawn path.
			Env: map[string]string{
				"ANTHROPIC_BASE_URL":   api.URL,
				"ANTHROPIC_AUTH_TOKEN": "orbit-effort-probe",
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
	done := make(chan struct{})
	go func() {
		defer close(done)
		readEffortProbeStdout(proc.stdout, rt)
	}()
	t.Cleanup(func() {
		rec.releaseFirstCall() // never leave the engine parked on a response
		cancel()
		<-done
	})

	if err := rt.send(userFrame(job.SessionUUID, []map[string]interface{}{
		{"type": "text", "text": "Read " + readable + " twice, then say DONE."},
	})); err != nil {
		t.Fatalf("feeding the turn: %v", err)
	}

	select {
	case <-rec.firstCall:
	case <-done:
		t.Fatalf("claude exited before it called the API at all%s", engineOutput())
	case <-time.After(effortProbeTimeout):
		t.Fatalf("claude made no API call within %s%s", effortProbeTimeout, engineOutput())
	}
	// Mid-turn by construction: the engine is inside its first request, which the recorder
	// is holding, and the frame is answered before that request is allowed to complete. So
	// every later request is one the engine builds afterwards — no sleep, no ordering luck.
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

	select {
	case <-rec.turnDone():
	case <-done:
	case <-time.After(effortProbeTimeout):
		t.Fatalf("the turn did not finish within %s; API calls so far: %v%s", effortProbeTimeout, rec.snapshot(), engineOutput())
	}
	efforts := rec.snapshot()
	for i, effort := range efforts {
		// An empty one is not a level, it is the field being absent — which is what a model
		// that does not take an effort at all sends. Said here rather than left to the
		// assertions above, where every arm would agree on "" and the suite would go green
		// having measured nothing.
		if effort == "" {
			t.Fatalf("call %d of the turn carried no output_config.effort; %s does not take one, so this probe cannot measure a change to it (calls: %v)",
				i+1, effortProbeModel, efforts)
		}
	}
	t.Logf("spawn effort %q, asked for %q: %v", spawnEffort, askFor, efforts)
	return efforts
}

// requireNoEffortEnvOverride fails rather than skips: this variable does not stop the frame
// being answered `success`, it stops it doing anything, so a run that inherited one would
// report a green suite for a feature that is dead.
func requireNoEffortEnvOverride(t *testing.T) {
	t.Helper()
	if got := os.Getenv("CLAUDE_CODE_EFFORT_LEVEL"); got != "" {
		t.Fatalf("CLAUDE_CODE_EFFORT_LEVEL=%q is set in this environment, which makes an effort control frame inert while still answering success; nothing in Orbit sets it and this probe cannot measure anything through it", got)
	}
}

// effortRecorder is the API `claude` talks to: it records what each request asked for and
// answers with a canned stream.
type effortRecorder struct {
	read string // the file the scripted tool call reads

	mu      sync.Mutex
	efforts []string
	done    chan struct{}

	// firstCall is closed when the engine's first API call arrives; release is what lets
	// that call finish. Between them is the only window in which a frame is guaranteed to
	// reach the engine before it builds its next request.
	firstCall chan struct{}
	release   chan struct{}
	// Both closes are idempotent: the release also happens in cleanup, for an arm that
	// failed before it got there, and the turn's end is signalled once.
	releaseOnce sync.Once
	doneOnce    sync.Once
}

// releaseFirstCall lets the held first API call complete.
func (rec *effortRecorder) releaseFirstCall() {
	rec.releaseOnce.Do(func() { close(rec.release) })
}

// The turn's script, decided by which main call this is: two tool calls, then an answer.
// Two are needed rather than one, because a single post-frame request would leave "the
// frame arrived in time" and "the frame changed the request" indistinguishable.
const effortProbeToolCalls = 2

func (rec *effortRecorder) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	// Everything that is not a completion is waved through without being counted or held.
	// A CLI does more than ask for completions — `HEAD /api/hello` is its reachability
	// check — and one of those arriving first would take the hold this probe places on the
	// first API call, which is what puts the frame ahead of the engine's second request.
	if r.Method != http.MethodPost || !strings.HasSuffix(r.URL.Path, "/v1/messages") {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
		return
	}
	var req struct {
		OutputConfig map[string]interface{} `json:"output_config"`
	}
	_ = json.Unmarshal(body, &req)
	// The CLI titles a new conversation with a second, structured call of its own. It is not
	// the turn, it is not affected by the flag under test (it always asks for `high`), and
	// counting it would make the assertions above meaningless.
	if _, side := req.OutputConfig["format"]; side {
		writeCannedStream(w, textReply(`{"title":"orbit effort probe","isNewTopic":false}`))
		return
	}
	effort, _ := req.OutputConfig["effort"].(string)
	rec.mu.Lock()
	n := len(rec.efforts)
	rec.efforts = append(rec.efforts, effort)
	rec.mu.Unlock()
	if n == 0 {
		close(rec.firstCall)
		<-rec.release // held open while the test decides whether to tell the engine anything
	}
	if n < effortProbeToolCalls {
		writeCannedStream(w, readToolReply(fmt.Sprintf("toolu_%d", n+1), rec.read))
		return
	}
	rec.signalDone()
	writeCannedStream(w, textReply("DONE"))
}

func (rec *effortRecorder) turnDone() <-chan struct{} {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if rec.done == nil {
		rec.done = make(chan struct{})
	}
	return rec.done
}

func (rec *effortRecorder) signalDone() {
	rec.mu.Lock()
	if rec.done == nil {
		rec.done = make(chan struct{})
	}
	done := rec.done
	rec.mu.Unlock()
	rec.doneOnce.Do(func() { close(done) })
}

func (rec *effortRecorder) snapshot() []string {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	return append([]string(nil), rec.efforts...)
}

// readEffortProbeStdout is session.go's reader loop narrowed to what this probe needs: a
// control_response goes to the request waiting for it, exactly as production routes it, and
// everything else is read and dropped. Dropped rather than buffered on purpose — a turn with
// --include-partial-messages emits thousands of frames, and a channel nobody drains would
// block the same goroutine that has to deliver the control answer.
func readEffortProbeStdout(stdout io.Reader, rt *claudeRuntime) {
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
	}
	rt.failPendingControl(errRuntimeGone)
}

// The canned Anthropic stream. Written from literals rather than through anything Orbit
// parses: what it has to satisfy is the CLI's own reader, so agreement here is agreement
// with the engine.
func writeCannedStream(w http.ResponseWriter, events []map[string]interface{}) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	for _, e := range events {
		payload, err := json.Marshal(e)
		if err != nil {
			return
		}
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", e["type"], payload); err != nil {
			return
		}
	}
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
}

func messageStart() map[string]interface{} {
	return map[string]interface{}{
		"type": "message_start",
		"message": map[string]interface{}{
			"id": "msg_probe", "type": "message", "role": "assistant",
			"model": effortProbeModel, "content": []interface{}{},
			"stop_reason": nil, "stop_sequence": nil,
			"usage": map[string]interface{}{
				"input_tokens": 1, "output_tokens": 1,
				"cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
			},
		},
	}
}

func textBlock(index int, text string) []map[string]interface{} {
	return []map[string]interface{}{
		{"type": "content_block_start", "index": index, "content_block": map[string]interface{}{"type": "text", "text": ""}},
		{"type": "content_block_delta", "index": index, "delta": map[string]interface{}{"type": "text_delta", "text": text}},
		{"type": "content_block_stop", "index": index},
	}
}

func messageEnd(stopReason string) []map[string]interface{} {
	return []map[string]interface{}{
		{"type": "message_delta", "delta": map[string]interface{}{"stop_reason": stopReason, "stop_sequence": nil},
			"usage": map[string]interface{}{"output_tokens": 2}},
		{"type": "message_stop"},
	}
}

func textReply(text string) []map[string]interface{} {
	out := []map[string]interface{}{messageStart()}
	out = append(out, textBlock(0, text)...)
	return append(out, messageEnd("end_turn")...)
}

func readToolReply(id, path string) []map[string]interface{} {
	input, err := json.Marshal(map[string]interface{}{"file_path": path})
	if err != nil {
		return textReply("DONE")
	}
	out := []map[string]interface{}{messageStart()}
	out = append(out, textBlock(0, "reading it")...)
	out = append(out,
		map[string]interface{}{"type": "content_block_start", "index": 1,
			"content_block": map[string]interface{}{"type": "tool_use", "id": id, "name": "Read", "input": map[string]interface{}{}}},
		map[string]interface{}{"type": "content_block_delta", "index": 1,
			"delta": map[string]interface{}{"type": "input_json_delta", "partial_json": string(input)}},
		map[string]interface{}{"type": "content_block_stop", "index": 1},
	)
	return append(out, messageEnd("tool_use")...)
}

// quoteJSON renders one string as a JSON value, so a probe can build the payload the control
// plane sends without hand-escaping it.
func quoteJSON(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		return `""`
	}
	return string(b)
}
