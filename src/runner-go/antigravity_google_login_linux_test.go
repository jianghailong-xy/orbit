//go:build linux

package main

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

const googleReplayURL = "https://accounts.google.com/o/oauth2/auth?response_type=code&state=fixture&code_challenge=fixture"
const googleReplayCode = "FAKE-GOOGLE-CODE-NEVER-LOG"

func googleLoginRecording(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "docs", "evidence", "antigravity-cli-1.2.16", name))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Output string `json:"output"`
	}
	if err := json.Unmarshal(b, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture.Output
}

func googleRecordingPart(t *testing.T, text, start, end string) string {
	t.Helper()
	i := strings.Index(text, start)
	if i < 0 {
		t.Fatalf("recording lacks %q", start)
	}
	text = text[i:]
	if end != "" {
		j := strings.Index(text, end)
		if j < 0 {
			t.Fatalf("recording lacks end %q", end)
		}
		text = text[:j]
	}
	return text
}

const googleReplayScript = `#!/bin/bash
set -eu
gd=""
for arg in "$@"; do
 case "$arg" in
 --gemini_dir=*) gd="${arg#*=}" ;;
 esac
done
if [[ " $* " == *" --print=/usage "* ]]; then
 cat "$GOOGLE_REPLAY_DIR/usage"
 exit "${GOOGLE_REPLAY_PROBE_EXIT:-0}"
fi
printf '%s' "$$" > "$GOOGLE_REPLAY_DIR/pid"
stty -echo -icanon min 1 time 0
take() {
 local key
 IFS= read -rsn1 key
 [[ "$key" == "$1" || ( "$1" == $'\r' && -z "$key" ) ]] || exit 9
}
if [[ "$GOOGLE_REPLAY_MODE" == no_url ]]; then sleep 30; exit 0; fi
onboard() {
 cat "$GOOGLE_REPLAY_DIR/theme"; take $'\r'
 cat "$GOOGLE_REPLAY_DIR/terms"; take $'\r'; take $'\t'; take $'\t'; take $'\r'
 cat "$GOOGLE_REPLAY_DIR/trust"; take $'\r'
}
if [[ "$GOOGLE_REPLAY_MODE" != post_setup ]]; then onboard; fi
cat "$GOOGLE_REPLAY_DIR/menu"; take $'\r'
cat "$GOOGLE_REPLAY_DIR/prompt"
if [[ "$GOOGLE_REPLAY_MODE" == exit_zero ]]; then exit 0; fi
while true; do
 IFS= read -r code
 # Bubble Tea echoes fragmented input with cursor movement: none of this may escape the relay.
 printf '%s\b\b\x1b[2K%s' "${code:0:8}" "${code:8}"
 if [[ "$GOOGLE_REPLAY_MODE" == reject && ! -f "$GOOGLE_REPLAY_DIR/rejected" ]]; then
  cat "$GOOGLE_REPLAY_DIR/rejection"
  touch "$GOOGLE_REPLAY_DIR/rejected"
 elif [[ "$GOOGLE_REPLAY_MODE" == hang ]]; then sleep 30
 else
  mkdir -p "$gd/antigravity-cli"
  printf '{"placeholder":true}' > "$gd/antigravity-cli/antigravity-oauth-token"
  chmod 600 "$gd/antigravity-cli/antigravity-oauth-token"
  if [[ "$GOOGLE_REPLAY_MODE" == post_setup ]]; then onboard; fi
  printf '\n? for shortcuts'
  # The real login remains interactive even after it has saved the token.
  sleep 30
 fi
done
`

type googleLoginHarness struct {
	relay   *loginRelay
	reports chan LoginResultRequest
	dir     string
}

func newGoogleLoginHarness(t *testing.T, mode string) *googleLoginHarness {
	t.Helper()
	t.Setenv("ORBIT_HOME", t.TempDir())
	dir := t.TempDir()
	initial := googleLoginRecording(t, "google-auth-owner-login-initial.json")
	final := googleLoginRecording(t, "google-auth-owner-login-final.json")
	logout := googleLoginRecording(t, "google-auth-logout-real-one-turn.json")
	prompt := googleRecordingPart(t, initial, "Open the URL below", "")
	prompt = strings.ReplaceAll(prompt, "https://accounts.google.com/o/oauth2/auth?<AUTH_QUERY_REDACTED>", "https://accounts.google.com/o/oauth2/auth?response_type=\ncode&state=fixture")
	// Preserve the recorded wrapped text; only the OSC target carries the complete URL.
	prompt = strings.ReplaceAll(prompt, "→ Click here to authenticate", "\x1b]8;;"+googleReplayURL+"\x07→ Click here to authenticate\x1b]8;;\x07")
	rejection, err := os.ReadFile("testdata/antigravity/google-auth-invalid-code.json")
	if err != nil {
		t.Fatal(err)
	}
	var reject struct {
		Output string `json:"output"`
	}
	if err := json.Unmarshal(rejection, &reject); err != nil {
		t.Fatal(err)
	}
	usage, err := os.ReadFile("../../docs/evidence/antigravity-cli-1.2.16/google-auth-print-usage.json")
	if err != nil {
		t.Fatal(err)
	}
	var recordedUsage struct {
		Stdout string `json:"stdout"`
	}
	if err := json.Unmarshal(usage, &recordedUsage); err != nil {
		t.Fatal(err)
	}
	for name, text := range map[string]string{
		"theme":  googleRecordingPart(t, final, "Choose your color scheme", "Terms of Service & Data Use"),
		"terms":  googleRecordingPart(t, final, "Terms of Service & Data Use", ""),
		"trust":  googleRecordingPart(t, logout, "Do you trust the contents", "Gemini 3.8"),
		"menu":   initial[:strings.Index(initial, "Open the URL below")],
		"prompt": prompt, "rejection": reject.Output, "usage": recordedUsage.Stdout,
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	bin := filepath.Join(dir, "agy")
	if err := os.WriteFile(bin, []byte(googleReplayScript), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GOOGLE_REPLAY_DIR", dir)
	t.Setenv("GOOGLE_REPLAY_MODE", mode)
	previous := lookLoginEngine
	lookLoginEngine = func(engine string) (string, bool) { return bin, engine == providerAntigravity }
	t.Cleanup(func() { lookLoginEngine = previous })
	h := &googleLoginHarness{relay: &loginRelay{}, reports: make(chan LoginResultRequest, 32), dir: dir}
	t.Cleanup(h.relay.stop)
	return h
}

func (h *googleLoginHarness) start() {
	h.relay.start(LoginCommand{Engine: providerAntigravity, Attempt: "google-attempt"}, func(r LoginResultRequest) { h.reports <- r })
}

func (h *googleLoginHarness) wait(t *testing.T, status string) LoginResultRequest {
	t.Helper()
	select {
	case r := <-h.reports:
		if r.Status != status {
			t.Fatalf("status = %q, want %q: %s", r.Status, status, r.Message)
		}
		return r
	case <-time.After(30 * time.Second):
		t.Fatal("relay report timed out")
	}
	return LoginResultRequest{}
}

func (h *googleLoginHarness) code() {
	h.relay.submitCode(LoginCommand{Engine: providerAntigravity, Attempt: "google-attempt", Code: googleReplayCode}, func(r LoginResultRequest) { h.reports <- r })
}

func TestAntigravityGoogleLoginReplaySuccess(t *testing.T) {
	h := newGoogleLoginHarness(t, "success")
	logs, err := os.CreateTemp(t.TempDir(), "runner-log")
	if err != nil {
		t.Fatal(err)
	}
	oldLog, oldOut, oldErr := log.Writer(), os.Stdout, os.Stderr
	log.SetOutput(logs)
	os.Stdout, os.Stderr = logs, logs
	t.Cleanup(func() { log.SetOutput(oldLog); os.Stdout, os.Stderr = oldOut, oldErr; _ = logs.Close() })
	h.start()
	res := h.wait(t, loginAwaitingCode)
	if res.URL != googleReplayURL {
		t.Fatal("OSC target was not preserved")
	}
	h.relay.mu.Lock()
	run := h.relay.runs[loginAccountKey(providerAntigravity, "")]
	h.relay.mu.Unlock()
	h.code()
	done := h.wait(t, loginDone)
	h.relay.stop()
	wire, err := json.Marshal([]LoginResultRequest{res, done})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := logs.Seek(0, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	logBytes, err := io.ReadAll(logs)
	if err != nil {
		t.Fatal(err)
	}
	for _, output := range []string{string(logBytes), string(wire), run.out.String(), run.google.String()} {
		if strings.Contains(output, googleReplayCode) || strings.Contains(output, googleReplayCode[:8]) || strings.Contains(output, googleReplayCode[8:]) {
			t.Fatal("authorization input leaked")
		}
	}
	if stat, err := os.Stat(antigravityGoogleTokenPath()); err != nil || stat.Mode().Perm() != 0o600 {
		t.Fatal("token missing or not private")
	}
}

func TestAntigravityGoogleLoginReplaySetupAfterOAuth(t *testing.T) {
	h := newGoogleLoginHarness(t, "post_setup")
	h.start()
	h.wait(t, loginAwaitingCode)
	h.code()
	h.wait(t, loginDone)
	// Fake agy publishes the normal prompt only after every recorded setting received its keys.
}

func TestAntigravityGoogleLoginReplayReplaceAndRollback(t *testing.T) {
	for _, mode := range []string{"hang", "success"} {
		t.Run(mode, func(t *testing.T) {
			h := newGoogleLoginHarness(t, mode)
			if err := os.MkdirAll(filepath.Dir(antigravityGoogleTokenPath()), 0o700); err != nil {
				t.Fatal(err)
			}
			const oldToken = "PRIVATE-OLD-TOKEN"
			if err := os.WriteFile(antigravityGoogleTokenPath(), []byte(oldToken), 0o600); err != nil {
				t.Fatal(err)
			}
			h.start()
			h.wait(t, loginAwaitingCode)
			if _, err := os.Stat(antigravityGoogleTokenPath()); !os.IsNotExist(err) {
				t.Fatal("old login was not isolated from new OAuth exchange")
			}
			if mode == "hang" {
				h.relay.cancelLogin(LoginCommand{Engine: providerAntigravity, Attempt: "google-attempt"})
				h.wait(t, loginFailed)
			} else {
				h.code()
				h.wait(t, loginDone)
			}
			h.relay.stop()
			body, err := os.ReadFile(antigravityGoogleTokenPath())
			if err != nil {
				t.Fatal(err)
			}
			if (mode == "hang") != (string(body) == oldToken) {
				t.Fatal("replacement did not commit/rollback the right token")
			}
			backups, err := filepath.Glob(filepath.Join(filepath.Dir(antigravityGoogleTokenPath()), ".oauth-before-login-*"))
			if err != nil || len(backups) != 0 {
				t.Fatal("completed attempt left a backup")
			}
		})
	}
}

func TestAntigravityGoogleLoginIgnoresStaleCode(t *testing.T) {
	h := newGoogleLoginHarness(t, "success")
	h.start()
	h.wait(t, loginAwaitingCode)
	h.relay.submitCode(LoginCommand{Engine: providerAntigravity, Attempt: "old-attempt", Code: googleReplayCode}, func(r LoginResultRequest) { h.reports <- r })
	h.relay.mu.Lock()
	run := h.relay.runs[loginAccountKey(providerAntigravity, "")]
	h.relay.mu.Unlock()
	run.google.mu.Lock()
	submitted := run.google.submitted
	run.google.mu.Unlock()
	if submitted {
		t.Fatal("stale code was sent to the new OAuth challenge")
	}
	h.code()
	h.wait(t, loginDone)
}

func TestAntigravityGoogleOSC8ChunksAndProtection(t *testing.T) {
	initial := googleLoginRecording(t, "google-auth-owner-login-initial.json")
	for _, terminator := range []string{"\x07", "\x1b\\"} {
		t.Run(terminator, func(t *testing.T) {
			out := &antigravityGoogleLoginOutput{}
			text := "\x1b]8;id=wrapped;" + googleReplayURL + terminator + initial
			for i := 0; i < len(text); i++ {
				_, _ = out.Write([]byte{text[i]})
			}
			progress := antigravityGoogleLoginProgress(out.String())
			if progress == nil || progress.URL != googleReplayURL {
				t.Fatal("fragmented OSC target or recorded prompt was lost")
			}
			out.url = progress.URL
			if !out.protect() {
				t.Fatal("code protection did not start")
			}
			for _, fragment := range []string{googleReplayCode[:8], "\b\x1b[2K", googleReplayCode[8:], antigravityGoogleInvalidCodeMarker} {
				for i := 0; i < len(fragment); i++ {
					_, _ = out.Write([]byte{fragment[i]})
				}
			}
			if out.String() != "" || !out.rejected {
				t.Fatal("protected chunks exposed text or lost rejection")
			}
		})
	}
	if !contains(strings.Split(runnerCapabilitiesV1, ","), antigravityGoogleLoginCapabilityV1) {
		t.Fatal("runner did not declare Google login capability")
	}
}

func TestAntigravityGoogleLoginReplayRejectThenSuccess(t *testing.T) {
	h := newGoogleLoginHarness(t, "reject")
	h.start()
	first := h.wait(t, loginAwaitingCode)
	h.code()
	rejected := h.wait(t, loginAwaitingCode)
	if rejected.URL != first.URL || rejected.Message == "" {
		t.Fatal("rejection must keep the challenge and explain retry")
	}
	if strings.Contains(rejected.Message, googleReplayCode) {
		t.Fatal("code leaked in rejection")
	}
	h.code()
	h.wait(t, loginDone)
}

func TestAntigravityGoogleLoginReplayExitZeroIsNotSuccess(t *testing.T) {
	h := newGoogleLoginHarness(t, "exit_zero")
	h.start()
	h.wait(t, loginAwaitingCode)
	h.wait(t, loginFailed)
}

func TestAntigravityGoogleLoginReplayFailedUsageIsNotSuccess(t *testing.T) {
	h := newGoogleLoginHarness(t, "success")
	t.Setenv("GOOGLE_REPLAY_PROBE_EXIT", "1")
	if err := os.WriteFile(filepath.Join(h.dir, "usage"), []byte(`{"event":"result","result":{"status":"ERROR","error":"network failure"}}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	h.start()
	h.wait(t, loginAwaitingCode)
	h.code()
	h.wait(t, loginFailed)
}

func TestAntigravityGoogleLoginReplayTimeout(t *testing.T) {
	for _, mode := range []string{"no_url", "hang"} {
		t.Run(mode, func(t *testing.T) {
			h := newGoogleLoginHarness(t, mode)
			h.relay.timeout = 2 * time.Second
			h.start()
			if mode == "hang" {
				h.wait(t, loginAwaitingCode)
				h.code()
			}
			res := h.wait(t, loginFailed)
			if !strings.Contains(res.Message, "timed out") {
				t.Fatalf("missing timeout explanation: %s", res.Message)
			}
		})
	}
}

func TestAntigravityGoogleLoginReplayCancel(t *testing.T) {
	h := newGoogleLoginHarness(t, "hang")
	h.start()
	h.wait(t, loginAwaitingCode)
	// A cancellation belonging to an old attempt must not kill this one.
	h.relay.cancelLogin(LoginCommand{Engine: providerAntigravity, Attempt: "old-attempt"})
	h.relay.mu.Lock()
	run := h.relay.runs[loginAccountKey(providerAntigravity, "")]
	h.relay.mu.Unlock()
	if run.ctx.Err() != nil {
		t.Fatal("stale cancellation killed the current login")
	}
	h.relay.cancelLogin(LoginCommand{Engine: providerAntigravity, Attempt: "google-attempt"})
	h.wait(t, loginFailed)
	h.relay.stop()
	b, err := os.ReadFile(filepath.Join(h.dir, "pid"))
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(string(b))
	if err != nil {
		t.Fatal(err)
	}
	if err := syscall.Kill(-pid, 0); err != syscall.ESRCH {
		t.Fatalf("owned process group survived cancellation: %v", err)
	}
}

func TestAntigravityGoogleContractSignedOut(t *testing.T) {
	path, err := exec.LookPath(agyExecutable)
	if err != nil {
		t.Fatal("real agy is required for the Linux Google contract tests:", err)
	}
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv("GEMINI_API_KEY", "")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if probe := probeAntigravityGoogle(ctx, path, nil); probe.auth != authNo {
		t.Fatalf("real agy unlogged /usage: %s", authWord(probe.auth))
	}
	if auth, _, _ := probeAntigravityAuth(ctx, path, nil); auth != authNo {
		t.Fatalf("unlogged directory status: %s", authWord(auth))
	}
}

func TestAntigravityGoogleContractAuthorizationLinkThenCancel(t *testing.T) {
	path, err := exec.LookPath(agyExecutable)
	if err != nil {
		t.Fatal("real agy is required for the Linux Google contract tests:", err)
	}
	t.Setenv("ORBIT_HOME", t.TempDir())
	previous := lookLoginEngine
	lookLoginEngine = func(engine string) (string, bool) { return path, engine == providerAntigravity }
	t.Cleanup(func() { lookLoginEngine = previous })
	h := &googleLoginHarness{relay: &loginRelay{}, reports: make(chan LoginResultRequest, 32)}
	t.Cleanup(h.relay.stop)
	h.start()
	result := h.wait(t, loginAwaitingCode)
	if !strings.HasPrefix(result.URL, "https://accounts.google.com/o/oauth2/auth?") {
		t.Fatal("real agy did not publish a Google authorization target")
	}
	h.relay.cancelLogin(LoginCommand{Engine: providerAntigravity, Attempt: "google-attempt"})
	h.wait(t, loginFailed)
	h.relay.stop()
	if _, err := os.Stat(antigravityGoogleTokenPath()); !os.IsNotExist(err) {
		t.Fatal("cancelling before submission must not create a token")
	}
}
