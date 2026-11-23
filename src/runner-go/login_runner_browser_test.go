package main

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// An engine's sign-in finished in the runner's browser (docs/runner-browser-engine-sign-in-design.md).

const runnerBrowserClaudeURL = "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=abc&code_challenge_method=S256&state=STATE-1"

func TestClaudeCodeCallbackAndItsCode(t *testing.T) {
	callback, state, ok := claudeCodeCallback(providerClaude, runnerBrowserClaudeURL)
	if !ok || callback.String() != "https://platform.claude.com/oauth/code/callback" || state != "STATE-1" {
		t.Fatalf("callback %v state %q ok %v", callback, state, ok)
	}
	// Only Claude Code's sign-in is captured; the others keep what they had.
	for _, engine := range []string{providerCodex, providerKimi, providerAntigravity, providerCursor} {
		if _, _, ok := claudeCodeCallback(engine, runnerBrowserClaudeURL); ok {
			t.Errorf("%s's link was taken for a callback", engine)
		}
	}
	if _, _, ok := claudeCodeCallback(providerClaude, "https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=S"); ok {
		t.Error("a localhost callback was taken")
	}
	for address, want := range map[string]string{
		"https://platform.claude.com/oauth/code/callback?code=CODE-9&state=STATE-1": "CODE-9",
		"https://PLATFORM.claude.com/oauth/code/callback?state=STATE-1&code=CODE-9": "CODE-9",
		"https://platform.claude.com/oauth/code/callback?code=CODE-9&state=OTHER":   "",
		"https://platform.claude.com/oauth/code/callback?code=CODE-9":               "",
		"https://evil.example/oauth/code/callback?code=CODE-9&state=STATE-1":        "",
		"https://platform.claude.com/oauth/code/other?code=CODE-9&state=STATE-1":    "",
		"http://platform.claude.com/oauth/code/callback?code=CODE-9&state=STATE-1":  "",
		"https://claude.com/cai/oauth/authorize?code=true&state=STATE-1":            "",
	} {
		if got := callbackCode(address, callback, state); got != want {
			t.Errorf("callbackCode(%s) = %q, want %q", address, got, want)
		}
	}
}

// fakeLoginBrowser stands in for the supervisor.
type fakeLoginBrowser struct {
	mu       sync.Mutex
	reserved string
	refuse   error
	ended    []string
}

func (b *fakeLoginBrowser) ReserveForEngineSignIn(attempt string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.refuse != nil {
		return b.refuse
	}
	b.reserved = attempt
	return nil
}

func (b *fakeLoginBrowser) EndEngineSignIn(attempt string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.ended = append(b.ended, attempt)
	if b.reserved == attempt {
		b.reserved = ""
	}
}

func (b *fakeLoginBrowser) DevToolsEndpoint() string { return "http://127.0.0.1:9222" }

func (b *fakeLoginBrowser) reservation() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.reserved
}

// runnerBrowserRig is a relay with one Claude Code sign-in waiting on its link, and Chrome stood in for.
type runnerBrowserRig struct {
	relay   *loginRelay
	run     *loginRun
	cancel  context.CancelFunc
	stdin   *io.PipeReader
	mu      sync.Mutex
	reports []LoginResultRequest
	opened  []string
	pages   []browserTarget
}

func newRunnerBrowserRig(t *testing.T, engine string, published LoginResultRequest) *runnerBrowserRig {
	t.Helper()
	rig := &runnerBrowserRig{}
	ctx, cancel := context.WithCancel(context.Background())
	rig.cancel = cancel
	stdinR, stdinW := io.Pipe()
	rig.stdin = stdinR
	run := &loginRun{key: loginAccountKey(engine, ""), attempt: "A1", stdin: stdinW, cancel: cancel, out: &syncBuffer{}, ctx: ctx, finished: make(chan struct{})}
	run.report = func(res LoginResultRequest) {
		res.Attempt = "A1"
		rig.mu.Lock()
		rig.reports = append(rig.reports, res)
		rig.mu.Unlock()
	}
	run.published = &published
	rig.run = run
	rig.relay = &loginRelay{runs: map[string]*loginRun{run.key: run}}
	oldOpen, oldTargets, oldReady := loginBrowserOpenTab, loginBrowserTargets, browserDevToolsReady
	loginBrowserOpenTab = func(_ context.Context, _ string, target string) error {
		rig.mu.Lock()
		rig.opened = append(rig.opened, target)
		rig.mu.Unlock()
		return nil
	}
	loginBrowserTargets = func(context.Context, string) ([]browserTarget, error) {
		rig.mu.Lock()
		defer rig.mu.Unlock()
		return append([]browserTarget(nil), rig.pages...), nil
	}
	browserDevToolsReady = func(string) {}
	t.Cleanup(func() {
		cancel()
		_ = stdinR.Close()
		loginBrowserOpenTab, loginBrowserTargets, browserDevToolsReady = oldOpen, oldTargets, oldReady
	})
	return rig
}

func (rig *runnerBrowserRig) snapshot() ([]LoginResultRequest, []string) {
	rig.mu.Lock()
	defer rig.mu.Unlock()
	return append([]LoginResultRequest(nil), rig.reports...), append([]string(nil), rig.opened...)
}

func (rig *runnerBrowserRig) showPage(address string) {
	rig.mu.Lock()
	rig.pages = append(rig.pages, browserTarget{Type: "page", URL: address})
	rig.mu.Unlock()
}

func TestLoginOpensTheLinkInTheRunnersBrowserAndTakesTheCode(t *testing.T) {
	rig := newRunnerBrowserRig(t, providerClaude, LoginResultRequest{Status: loginAwaitingCode, URL: runnerBrowserClaudeURL})
	browser := &fakeLoginBrowser{}
	cmd := LoginCommand{Action: "browser", Engine: providerClaude, Attempt: "A1"}
	rig.relay.openInLoginBrowser(context.Background(), cmd, browser)

	reports, opened := rig.snapshot()
	if len(opened) != 1 || opened[0] != runnerBrowserClaudeURL {
		t.Fatalf("opened %v", opened)
	}
	if browser.reservation() != "A1" {
		t.Fatalf("the browser is not reserved for the sign-in: %q", browser.reservation())
	}
	if len(reports) != 1 || reports[0].Browser != loginBrowserOpened || reports[0].Status != loginAwaitingCode || reports[0].URL != runnerBrowserClaudeURL {
		t.Fatalf("reports %+v", reports)
	}

	// A redelivery reports again and opens nothing more.
	rig.relay.openInLoginBrowser(context.Background(), cmd, browser)
	if reports, opened = rig.snapshot(); len(opened) != 1 || len(reports) != 2 || reports[1].Browser != loginBrowserOpened {
		t.Fatalf("after a redelivery: opened %v, reports %+v", opened, reports)
	}

	// Another attempt's callback is not this one's; this attempt's is, and its code goes to the CLI.
	rig.showPage("https://platform.claude.com/oauth/code/callback?code=WRONG&state=OTHER")
	rig.showPage("https://platform.claude.com/oauth/code/callback?code=CODE-9&state=STATE-1")
	typed := make(chan string, 1)
	go func() {
		buf := make([]byte, 256)
		n, _ := rig.stdin.Read(buf)
		typed <- string(buf[:n])
	}()
	select {
	case got := <-typed:
		if got != "CODE-9#STATE-1\n" {
			t.Fatalf("the CLI was handed %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the code was never handed to the CLI")
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		reports, _ = rig.snapshot()
		if len(reports) == 3 || time.Now().After(deadline) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if len(reports) != 3 || reports[2].Browser != loginBrowserCodeTaken || reports[2].Status != loginAwaitingCode {
		t.Fatalf("no code-taken report: %+v", reports)
	}

	// The attempt ending ends the reservation.
	rig.cancel()
	deadline = time.Now().Add(2 * time.Second)
	for browser.reservation() != "" && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if browser.reservation() != "" {
		t.Fatal("the reservation outlived the sign-in")
	}
}

func TestLoginInTheRunnersBrowserKeepsADeviceFlowsCode(t *testing.T) {
	published := LoginResultRequest{Status: loginAwaitingApproval, URL: "https://auth.openai.com/codex/device", UserCode: "ABCD-1234"}
	rig := newRunnerBrowserRig(t, providerCodex, published)
	rig.relay.openInLoginBrowser(context.Background(), LoginCommand{Action: "browser", Engine: providerCodex, Attempt: "A1"}, &fakeLoginBrowser{})
	reports, opened := rig.snapshot()
	if len(opened) != 1 || opened[0] != published.URL {
		t.Fatalf("opened %v", opened)
	}
	// The report repeats the waiting one, so the control plane keeps the code the card shows.
	if len(reports) != 1 || reports[0].UserCode != "ABCD-1234" || reports[0].Status != loginAwaitingApproval || reports[0].Browser != loginBrowserOpened {
		t.Fatalf("reports %+v", reports)
	}
}

func TestLoginInTheRunnersBrowserFailsWithoutABrowserAndCanBeAskedAgain(t *testing.T) {
	rig := newRunnerBrowserRig(t, providerClaude, LoginResultRequest{Status: loginAwaitingCode, URL: runnerBrowserClaudeURL})
	cmd := LoginCommand{Action: "browser", Engine: providerClaude, Attempt: "A1"}
	rig.relay.openInLoginBrowser(context.Background(), cmd, nil)
	rig.relay.openInLoginBrowser(context.Background(), cmd, &fakeLoginBrowser{refuse: errBrowserUnavailable})
	reports, opened := rig.snapshot()
	if len(opened) != 0 || len(reports) != 2 || reports[0].Browser != loginBrowserFailed || reports[1].Browser != loginBrowserFailed {
		t.Fatalf("opened %v, reports %+v", opened, reports)
	}
	if reports[0].Status != loginAwaitingCode || reports[0].URL != runnerBrowserClaudeURL {
		t.Fatalf("a failure dropped the link: %+v", reports[0])
	}
	// The owner can press it again once there is a browser.
	rig.relay.openInLoginBrowser(context.Background(), cmd, &fakeLoginBrowser{})
	if _, opened = rig.snapshot(); len(opened) != 1 {
		t.Fatalf("a press after a failure opened %v", opened)
	}
}

func TestLoginInTheRunnersBrowserIgnoresAnotherAttemptOrNoLinkYet(t *testing.T) {
	rig := newRunnerBrowserRig(t, providerClaude, LoginResultRequest{Status: loginAwaitingCode, URL: runnerBrowserClaudeURL})
	rig.relay.openInLoginBrowser(context.Background(), LoginCommand{Action: "browser", Engine: providerClaude, Attempt: "OLD"}, &fakeLoginBrowser{})
	rig.relay.mu.Lock()
	rig.run.published = nil
	rig.relay.mu.Unlock()
	rig.relay.openInLoginBrowser(context.Background(), LoginCommand{Action: "browser", Engine: providerClaude, Attempt: "A1"}, &fakeLoginBrowser{})
	if reports, opened := rig.snapshot(); len(reports) != 0 || len(opened) != 0 {
		t.Fatalf("reports %+v, opened %v", reports, opened)
	}
}

// A real sign-in keeps the link it published, and the browser opens that link with the code it showed.
func TestLoginInTheRunnersBrowserOpensTheLinkARealSignInPublished(t *testing.T) {
	fakeKimi(t, kimiHelpWithRegion, "")
	opened := make(chan string, 2)
	oldOpen, oldReady := loginBrowserOpenTab, browserDevToolsReady
	loginBrowserOpenTab = func(_ context.Context, _ string, target string) error { opened <- target; return nil }
	browserDevToolsReady = func(string) {}
	t.Cleanup(func() { loginBrowserOpenTab, browserDevToolsReady = oldOpen, oldReady })

	relay := &loginRelay{}
	t.Cleanup(relay.stop)
	reports := make(chan LoginResultRequest, 8)
	relay.start(LoginCommand{Action: "start", Engine: providerKimi, Attempt: "K1"}, func(res LoginResultRequest) { reports <- res })
	var waiting LoginResultRequest
	select {
	case waiting = <-reports:
	case <-time.After(15 * time.Second):
		t.Fatal("the sign-in published no link")
	}
	if waiting.Status != loginAwaitingApproval || waiting.UserCode == "" {
		t.Fatalf("first report %+v", waiting)
	}
	relay.openInLoginBrowser(context.Background(), LoginCommand{Action: "browser", Engine: providerKimi, Attempt: "K1"}, &fakeLoginBrowser{})
	select {
	case got := <-opened:
		if got != waiting.URL {
			t.Fatalf("opened %q, published %q", got, waiting.URL)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("nothing was opened")
	}
	select {
	case res := <-reports:
		if res.Browser != loginBrowserOpened || res.URL != waiting.URL || res.UserCode != waiting.UserCode || res.Attempt != "K1" {
			t.Fatalf("browser report %+v", res)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no browser report")
	}
}

func TestBrowserReservedForTheOwnersEngineSignIn(t *testing.T) {
	r := newBrowserRig(t)
	if err := r.b.Acquire("sess-a", ""); err != nil {
		t.Fatal(err)
	}
	if err := r.b.ReserveForEngineSignIn("A1"); err != nil {
		t.Fatal(err)
	}
	// The holder keeps its lease, but no call is taken, its own included; nor a sign-in request.
	if err := r.b.Acquire("sess-a", ""); err == nil || !strings.Contains(err.Error(), "signs an engine in") {
		t.Fatalf("the holder's call was taken during the owner's sign-in: %v", err)
	}
	if err := r.b.Acquire("sess-b", ""); err == nil {
		t.Fatal("another session's call was taken during the owner's sign-in")
	}
	if _, err := r.b.YieldForSignIn("sess-b", ""); err == nil {
		t.Fatal("a sign-in request was taken during the owner's sign-in")
	}
	// Nor does the browser stop for idleness meanwhile.
	r.b.Release("sess-a")
	r.clock.Advance(30 * time.Minute)
	if !r.b.Running() {
		t.Fatal("the browser stopped during the owner's sign-in")
	}
	// Another attempt's end leaves this one's reservation; its own end lifts it.
	r.b.EndEngineSignIn("OTHER")
	if err := r.b.Acquire("sess-a", ""); err == nil {
		t.Fatal("another attempt's end lifted the reservation")
	}
	r.b.EndEngineSignIn("A1")
	if err := r.b.Acquire("sess-a", ""); err != nil {
		t.Fatalf("after the sign-in: %v", err)
	}
}

func TestBrowserEngineSignInNeedsTheOffer(t *testing.T) {
	r := newBrowserRig(t)
	r.b.SetOffered(false)
	if err := r.b.ReserveForEngineSignIn("A1"); err != errBrowserUnavailable {
		t.Fatalf("reserved without the offer: %v", err)
	}
	var none *browserSupervisor
	if err := none.ReserveForEngineSignIn("A1"); err != errBrowserUnavailable {
		t.Fatalf("a runner without a browser reserved: %v", err)
	}
	none.EndEngineSignIn("A1")
}

func TestLoginRunnerBrowserWireNames(t *testing.T) {
	shared, err := os.ReadFile(filepath.Join("..", "shared", "src", "dto.ts"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"LOGIN_RUNNER_BROWSER_V1 = '" + loginRunnerBrowserCapabilityV1 + "'",
		"action: 'start' | 'code' | 'cancel' | 'browser';",
		"browser?: LoginBrowserOutcome;",
		"export type LoginBrowserOutcome = '" + loginBrowserOpened + "' | '" + loginBrowserFailed + "' | '" + loginBrowserCodeTaken + "';",
	} {
		if !strings.Contains(string(shared), want) {
			t.Errorf("@orbit/shared does not say %s", want)
		}
	}
	body, _ := json.Marshal(LoginResultRequest{Status: loginAwaitingCode, URL: "https://a", Browser: loginBrowserOpened})
	if !strings.Contains(string(body), `"browser":"opened"`) {
		t.Fatalf("login result body: %s", body)
	}
}
