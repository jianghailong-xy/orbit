//go:build linux

package main

// Contract tests for Antigravity sessions on the runner's Google sign-in (docs/antigravity-runtime-contract.md
// §16.4, §16.9): the real agy installed on this machine, driven through runAntigravitySessionProcess as a
// session runs it. No Google account is involved. The runner's sign-in is a placeholder in the recorded
// shape (googleSignInPlaceholder), and the spawn copies it into the session's directory; agy takes it
// to Google to refresh, and Google refuses the placeholder — the path a revoked or lapsed sign-in takes.
// So these need Google's token endpoint to answer, as the runner itself would. Run them before taking a
// new agy release, with the TestAntigravityContract* ones.

import (
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// newGoogleSessionContract is newAgyContract on a runner whose saved Google sign-in is a placeholder, with
// no GEMINI_API_KEY of its own, counting the re-probes a sign-out asks for.
func newGoogleSessionContract(t *testing.T) (*agyContract, []byte, *atomic.Int32) {
	t.Helper()
	c := newAgyContract(t)
	t.Setenv("GEMINI_API_KEY", "")
	return c, saveGoogleSignIn(t), countEngineSignOuts(t)
}

// googleJob is a built-in Antigravity session: no key of its own, so it runs on the runner's sign-in.
func (c *agyContract) googleJob(sessionID, mode string, env map[string]string) *ClaimedSession {
	merged := map[string]string{testOrbitMCPEnv: "1"}
	for key, value := range env {
		merged[key] = value
	}
	return &ClaimedSession{SessionID: sessionID, Provider: providerAntigravity, Agent: AgentExecConfig{
		Provider: providerAntigravity, PermissionMode: mode, Env: merged,
	}}
}

// waitSignedOut waits for a session that should end signed out. That takes Google's token endpoint
// answering: when agy could not reach it, the session rightly goes on, and the test says so at once.
func (c *agyContract) waitSignedOut(s *agyContractSession) agyContractRun {
	c.t.Helper()
	deadline := time.After(agyContractWait)
	for {
		select {
		case <-s.done:
			return s.result
		case <-deadline:
			c.t.Fatalf("the session did not end; events:\n%s", c.describeEvents())
		case <-time.After(100 * time.Millisecond):
			if strings.Contains(string(readAgyLog(antigravityGoogleLogFile(c.geminiDir()))), "due to network error") {
				c.t.Fatal("agy could not reach Google to refresh the placeholder sign-in (its log says a network error): this contract needs Google's token endpoint to answer")
			}
		}
	}
}

// signedOutEnd checks what is left once agy refused the session's copy of the sign-in.
func (c *agyContract) signedOutEnd(token []byte, signOuts *atomic.Int32) {
	t := c.t
	t.Helper()
	errs := c.eventsOf("*", evError)
	if len(errs) != 1 || errs[0]["message"] != antigravityGoogleSignedOutMessage || !isAuthError(asString(errs[0]["message"])) {
		t.Fatalf("errors = %v; events:\n%s", errs, c.describeEvents())
	}
	for _, e := range c.eventsOf("*", evSystem) {
		if strings.Contains(asString(e["stderr"]), "Run 'agy' to log in") {
			t.Fatalf("agy's own sign-in advice reached the transcript: %v", e)
		}
	}
	if n := signOuts.Load(); n != 1 {
		t.Fatalf("re-probe asked %d times, want once", n)
	}
	gd := c.geminiDir()
	if _, err := os.Stat(antigravityTokenFile(gd)); !os.IsNotExist(err) {
		t.Fatalf("the session's sign-in copy outlived agy: %v", err)
	}
	// agy read the copy in the session's directory and took it to Google, which refused it.
	if log := readAgyLog(antigravityGoogleLogFile(gd)); !strings.Contains(string(log), `"invalid_grant"`) {
		t.Fatalf("agy's log does not show Google refusing the copy:\n%s", log)
	}
	// agy 1.2.16 rewrites settings.json as it starts, in either mode, with only what it keeps: a false
	// useG1Credits (an omitempty bool, so absent is false) and enableTelemetry are left out. What Orbit
	// writes before each start is TestAntigravityGoogleSessionSettingsInBothModes's to check; here, that
	// agy put back neither API-key mode nor the paid credits.
	var settings map[string]interface{}
	readJSONFile(t, filepath.Join(gd, "antigravity-cli", "settings.json"), &settings)
	if _, ok := settings["modelProvider"]; ok || settings["useG1Credits"] == true {
		t.Fatalf("Google-mode settings after agy = %v", settings)
	}
	if got, err := os.ReadFile(antigravityGoogleTokenPath()); err != nil || string(got) != string(token) {
		t.Fatal("agy changed the runner's own sign-in: a session runs on its copy only")
	}
	c.homeIsUntouched()
}

// A session that starts on a sign-in Google refuses (Bypass permissions: the session's own agy is the
// first to check it) fails with the sign-in card's error and ends, and the runner is told to re-probe.
func TestAntigravityGoogleSessionContractInvalidSignInIsSignedOut(t *testing.T) {
	c, token, signOuts := newGoogleSessionContract(t)
	session := c.start(c.googleJob("google-signed-out", "bypassPermissions", nil))
	if run := c.waitSignedOut(session); run.status != stFailed || !run.ended {
		t.Fatalf("session = %+v, want it failed and ended; events:\n%s", run, c.describeEvents())
	}
	c.signedOutEnd(token, signOuts)
}

// In a mode that asks, agy's first start is the approval gate's `--print=/hooks`, which checks the
// sign-in before it lists anything — from a pipe, or it would wait for a person to sign in.
func TestAntigravityGoogleSessionContractApprovalCheckIsSignedOut(t *testing.T) {
	c, token, signOuts := newGoogleSessionContract(t)
	session := c.start(c.googleJob("google-signed-out-gated", "default", nil))
	if run := c.waitSignedOut(session); run.status != stFailed || !run.ended {
		t.Fatalf("session = %+v, want it failed and ended; events:\n%s", run, c.describeEvents())
	}
	if procs := c.agyProcesses(); len(procs) != 0 {
		t.Fatalf("agy still running after a refused check: %v", procs)
	}
	c.signedOutEnd(token, signOuts)
}

// agy ends a sign-in check it could not send exactly as it ends one Google refused; only its own log
// says which (google-session-auth-failures.json). A network failure is no sign-out: the turn fails with
// a network error, the session goes on, and nothing is re-probed.
func TestAntigravityGoogleSessionContractNetworkFailureIsNotSignedOut(t *testing.T) {
	c, token, signOuts := newGoogleSessionContract(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	proxy := "http://127.0.0.1:" + strconv.Itoa(listener.Addr().(*net.TCPAddr).Port)
	_ = listener.Close() // nothing listens there now: every connection is refused
	session := c.start(c.googleJob("google-offline", "bypassPermissions", map[string]string{
		"HTTPS_PROXY": proxy, "https_proxy": proxy, "HTTP_PROXY": proxy, "http_proxy": proxy,
	}))
	c.send(RunInboxResponse{TurnID: "t1", Kind: "message", Content: "Reply exactly: orbit-ok."})
	if got := c.completion("t1"); got.Status != stFailed || got.Error != antigravityGoogleUnreachableMessage || isAuthError(got.Error) {
		t.Fatalf("t1 = %+v; events:\n%s", got, c.describeEvents())
	}
	c.send(RunInboxResponse{TurnID: "end", Kind: "end"})
	if run := session.wait(t); run.status != stSucceeded {
		t.Fatalf("session = %+v: a network failure must not end it", run)
	}
	for _, e := range c.eventsOf("*", evError) {
		if isAuthError(asString(e["message"])) {
			t.Fatalf("a network failure was reported as a sign-out: %v", e)
		}
	}
	if n := signOuts.Load(); n != 0 {
		t.Fatalf("re-probe asked %d times for a network failure", n)
	}
	gd := c.geminiDir()
	if _, err := os.Stat(antigravityTokenFile(gd)); !os.IsNotExist(err) {
		t.Fatalf("the session's sign-in copy outlived agy: %v", err)
	}
	if log := readAgyLog(antigravityGoogleLogFile(gd)); !strings.Contains(string(log), "due to network error") {
		t.Fatalf("agy's log no longer says a network error is one — classifyAgyAuthEnd depends on it:\n%s", log)
	}
	if got, err := os.ReadFile(antigravityGoogleTokenPath()); err != nil || string(got) != string(token) {
		t.Fatal("agy changed the runner's own sign-in")
	}
	c.homeIsUntouched()
}
