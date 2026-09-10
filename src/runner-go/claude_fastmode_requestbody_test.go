package main

// Whether Orbit's fast-mode opt-in actually reaches the API, read off the requests a real
// `claude` makes.
//
// Here for the same reason the effort probe is (claude_effort_requestbody_test.go): the
// engine's own answers cannot settle it. Fast mode has no flag to inspect, no field in the
// init handshake and no status frame — Orbit writes `fastMode: true` into the session's
// private settings file and the CLI silently decides, at startup, whether a headless
// session is allowed to have it. Every test that reads only what Orbit WROTE would stay
// green with the feature completely dead.
//
// The only place the truth is visible is the requests the CLI sends: fast mode is `speed:
// "fast"` in the body plus the `fast-mode-2026-02-01` beta on `anthropic-beta`. So the
// probe stands where the API is — ANTHROPIC_BASE_URL points at a local recorder that
// answers with a canned stream — which makes it hermetic and free: no credentials, no
// network, no tokens. The engine still does everything it really does: reads its settings
// file, services its control channel, runs a tool, and builds each request from the state
// it is actually in.
//
// The third arm is the one that decided the design. An apply_flag_settings carrying
// `fastMode` is answered `{"subtype":"success"}` and changes nothing, because the opt-in is
// settled when the process starts — so fast mode cannot be a `setconfig` the way effort is,
// and a session that changes it is re-spawned instead (session.go's `reload`). That arm is
// what keeps anyone from "fixing" the re-spawn away on the strength of a success answer.

import (
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

// fastModeProbeTimeout bounds one whole scripted turn. Generous for the same reason the
// effort probe's is: a cold `claude` on a loaded machine is slow to start, and a test that
// reds for that teaches people to re-run it.
const fastModeProbeTimeout = 120 * time.Second

// Fast mode is a per-MODEL capability — the CLI allows it on Opus 5 and Opus 4.8 and
// refuses it elsewhere ("<model> is not in your organization's allowed models"), so a probe
// naming anything else would read the same empty speed on every arm and agree with itself.
const fastModeProbeModel = "claude-opus-5"

// What the wire says when the session is in fast mode, and what a body that says nothing
// reads as here.
const (
	fastModeSpeed   = "fast"
	fastModeUnsaid  = ""
	fastModeBetaTag = "fast-mode-2026-02-01"
)

// The org gate, short-circuited — and the one thing in this file that is not production's
// own behaviour.
//
// Whether an account may use fast mode is decided by a call to the real Anthropic API
// (`/api/claude_code_penguin_mode`), which this probe has no credential for and no
// intention of making. With no answer the CLI guesses "disabled by your organization" and
// every arm would read the same empty speed — a green suite that measured nothing. This
// variable makes the CLI treat the org as enabled without asking anyone.
//
// It is set on ALL arms, including the controls, so it can never be the thing that makes
// them differ. Orbit itself must never set it: the org's answer is the org's to give, and a
// runner that forged it would be turning on a paid lane for accounts that were told no.
const fastModeSkipOrgCheck = "CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK"

// A session Orbit spawned in fast mode says so on every request it makes.
//
// Paired with the identical run that is not in fast mode. Without that control, "the
// request says fast" would be satisfied by a CLI that says it for everybody.
func TestRealClaudeFastModeSettingReachesTheAPIRequests(t *testing.T) {
	on := driveFastModeProbe(t, true, false)
	off := driveFastModeProbe(t, false, false)

	if len(off) < 2 {
		t.Fatalf("the control turn made %d API call(s) %v; this probe needs at least two to say anything", len(off), off)
	}
	for i, speed := range off {
		if speed != fastModeUnsaid {
			t.Errorf("the control turn's call %d asked for speed %q, want none — nothing put that session in fast mode", i+1, speed)
		}
	}
	if len(on) != len(off) {
		t.Errorf("the two arms made different numbers of API calls (%v vs %v); they are meant to run the same script", on, off)
	}
	if len(on) == 0 {
		t.Fatalf("the fast-mode turn made no API call at all")
	}
	for i, speed := range on {
		if speed != fastModeSpeed {
			t.Errorf("call %d of the fast-mode turn asked for speed %q, want %q — the settings file said fastMode and the request did not carry it",
				i+1, speed, fastModeSpeed)
		}
	}
}

// The frame that does nothing, and the reason fast mode is a re-spawn.
//
// The engine is inside its first API call — the recorder holds that response until the
// control_response has come back — so every later request is one it builds with the frame
// already answered. It answers `success` and every one of them still asks for no speed at
// all. Asserted rather than left as a comment because the mistake it guards against is
// cheap to make and invisible once made: a `setconfig` carrying fastMode would look, from
// the control plane, exactly like the feature working.
func TestRealClaudeIgnoresAFastModeControlFrameMidSession(t *testing.T) {
	speeds := driveFastModeProbe(t, false, true)

	if len(speeds) < 2 {
		t.Fatalf("the turn made %d API call(s) %v; there is no post-frame call to read", len(speeds), speeds)
	}
	for i, speed := range speeds[1:] {
		if speed != fastModeUnsaid {
			t.Errorf("call %d asked for speed %q after an apply_flag_settings the engine answered `success`; if the frame works now, fast mode no longer needs a re-spawn and session.go should say so",
				i+2, speed)
		}
	}
}

// driveFastModeProbe runs one scripted turn and returns the `speed` each API call asked
// for, in order. `fastMode` is the session's own setting, written into the settings file by
// production's own writer; `sendFrame` injects an apply_flag_settings asking for fast mode
// while the first call is held open.
func driveFastModeProbe(t *testing.T, fastMode, sendFrame bool) []string {
	t.Helper()
	requireRealClaude(t)
	work := t.TempDir()
	// A real tool call, so the turn makes more than one request: with a single call, "the
	// setting was read at startup" and "the setting is on every request" are the same
	// observation. Read is allowed under the default permission mode, so the probe spawns
	// with production's own flags rather than widening them for the test.
	readable := filepath.Join(work, "probe.txt")
	if err := os.WriteFile(readable, []byte("orbit fast mode probe\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	rec := &fastModeRecorder{read: readable, firstCall: make(chan struct{}), release: make(chan struct{})}
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
		SessionID:   "real-claude-fastmode-requestbody",
		SessionUUID: newContractSessionUUID(t),
		Provider:    providerClaude,
		Agent: AgentExecConfig{
			Provider:       providerClaude,
			Model:          fastModeProbeModel,
			PermissionMode: "default",
			FastMode:       fastMode,
			// The same door a configured (BYOK) provider comes through, which is why this
			// needs no test-only hook in the spawn path.
			Env: map[string]string{
				"ANTHROPIC_BASE_URL":   api.URL,
				"ANTHROPIC_AUTH_TOKEN": "orbit-fastmode-probe",
				fastModeSkipOrgCheck:   "1",
			},
		},
	}
	// Production's own settings writer, on production's own argument — the file IS the
	// feature, so a probe that hand-wrote one would be measuring the test's spelling of it.
	// The rest of claudeCommandArgs is left out for the same reason the effort probe leaves
	// it out: the MCP config and the extra working dirs have no bearing on this.
	args := realClaudeTransportArgs(job)
	settings, err := writeClaudeSettings(work, "", job.Agent.FastMode)
	if err != nil {
		t.Fatalf("writing the session's settings file: %v", err)
	}
	if fastMode && settings == "" {
		t.Fatalf("a fast-mode session wrote no settings file, so nothing could ask for fast mode")
	}
	if settings != "" {
		args = append(args, "--settings", settings)
	}

	ctx, cancel := context.WithCancel(context.Background())
	proc, err := spawnClaude(ctx, job, work, args)
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
	case <-time.After(fastModeProbeTimeout):
		t.Fatalf("claude made no API call within %s%s", fastModeProbeTimeout, engineOutput())
	}
	if sendFrame {
		w, err := rt.requestControlWith(ctrlApplyFlagSettings,
			map[string]interface{}{"settings": map[string]interface{}{"fastMode": true}})
		if err != nil {
			t.Fatalf("sending the fast-mode frame: %v", err)
		}
		// A refusal would be a different world from the one this arm is about — it would
		// mean the engine says no rather than saying yes and doing nothing — so it is a
		// failure here rather than a skip.
		if err := rt.awaitControl(context.Background(), w, fastModeProbeTimeout); err != nil {
			t.Fatalf("the engine refused the fast-mode frame (this probe is about the one it ACCEPTS): %v%s", err, engineOutput())
		}
	}
	rec.releaseFirstCall()

	select {
	case <-rec.turnDone():
	case <-done:
	case <-time.After(fastModeProbeTimeout):
		t.Fatalf("the turn did not finish within %s; API calls so far: %v%s", fastModeProbeTimeout, rec.snapshot(), engineOutput())
	}
	speeds := rec.snapshot()
	t.Logf("fast mode %v, frame sent %v: %v (beta tags: %v)", fastMode, sendFrame, speeds, rec.betaTags())
	return speeds
}

// fastModeRecorder is the API `claude` talks to: it records what speed each request asked
// for and answers with a canned stream.
type fastModeRecorder struct {
	read string // the file the scripted tool call reads

	mu     sync.Mutex
	speeds []string
	betas  []string
	done   chan struct{}

	// firstCall is closed when the engine's first API call arrives; release is what lets
	// that call finish. Between them is the only window in which a frame is guaranteed to
	// reach the engine before it builds its next request.
	firstCall chan struct{}
	release   chan struct{}

	releaseOnce sync.Once
	doneOnce    sync.Once
}

func (rec *fastModeRecorder) releaseFirstCall() {
	rec.releaseOnce.Do(func() { close(rec.release) })
}

// The turn's script: two tool calls, then an answer. Two rather than one, so the mid-turn
// arm has a request the engine built after the frame was answered.
const fastModeProbeToolCalls = 2

func (rec *fastModeRecorder) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	// Everything that is not a completion is waved through without being counted or held.
	// A CLI does more than ask for completions — `HEAD /api/hello` is its reachability
	// check — and one of those arriving first would take the hold this probe places on the
	// first API call.
	if r.Method != http.MethodPost || !strings.HasSuffix(r.URL.Path, "/v1/messages") {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
		return
	}
	var req struct {
		Speed        string                 `json:"speed"`
		OutputConfig map[string]interface{} `json:"output_config"`
	}
	_ = json.Unmarshal(body, &req)
	// The CLI titles a new conversation with a second, structured call of its own. It is
	// not the turn and counting it would make the assertions above meaningless.
	if _, side := req.OutputConfig["format"]; side {
		writeCannedStream(w, textReply(`{"title":"orbit fast mode probe","isNewTopic":false}`))
		return
	}
	rec.mu.Lock()
	n := len(rec.speeds)
	rec.speeds = append(rec.speeds, req.Speed)
	rec.betas = append(rec.betas, r.Header.Get("anthropic-beta"))
	rec.mu.Unlock()
	if n == 0 {
		close(rec.firstCall)
		<-rec.release // held open while the test decides whether to tell the engine anything
	}
	if n < fastModeProbeToolCalls {
		writeCannedStream(w, readToolReply(fmt.Sprintf("toolu_%d", n+1), rec.read))
		return
	}
	rec.signalDone()
	writeCannedStream(w, textReply("DONE"))
}

func (rec *fastModeRecorder) turnDone() <-chan struct{} {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if rec.done == nil {
		rec.done = make(chan struct{})
	}
	return rec.done
}

func (rec *fastModeRecorder) signalDone() {
	rec.mu.Lock()
	if rec.done == nil {
		rec.done = make(chan struct{})
	}
	done := rec.done
	rec.mu.Unlock()
	rec.doneOnce.Do(func() { close(done) })
}

func (rec *fastModeRecorder) snapshot() []string {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	return append([]string(nil), rec.speeds...)
}

// betaTags reports, per call, whether the fast-mode beta rode along. Logged rather than
// asserted: the body field is what Orbit is asking for, and the header is the CLI's own
// business — a version that renames the tag has not broken anything here.
func (rec *fastModeRecorder) betaTags() []bool {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	out := make([]bool, 0, len(rec.betas))
	for _, b := range rec.betas {
		out = append(out, strings.Contains(b, fastModeBetaTag))
	}
	return out
}
