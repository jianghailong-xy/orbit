package main

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/coder/websocket"
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

// An engine's sign-in finished in the runner's browser (docs/runner-browser-engine-sign-in-design.md).

const runnerBrowserClaudeURL = "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=abc&code_challenge_method=S256&state=STATE-1"

const runnerBrowserAntigravityURL = "https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=fixture.apps.googleusercontent.com&code_challenge=c&code_challenge_method=S256&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&scope=openid&state=G-STATE"

func TestCodeCallbackAndItsCode(t *testing.T) {
	callback, state, paste, ok := codeCallback(providerClaude, runnerBrowserClaudeURL)
	if !ok || callback.String() != "https://platform.claude.com/oauth/code/callback" || state != "STATE-1" || paste("C") != "C#STATE-1" {
		t.Fatalf("claude: callback %v state %q ok %v", callback, state, ok)
	}
	// Antigravity's page shows the code alone, and that is what agy takes.
	gcb, gstate, gpaste, ok := codeCallback(providerAntigravity, runnerBrowserAntigravityURL)
	if !ok || gcb.String() != "https://antigravity.google/oauth-callback" || gstate != "G-STATE" || gpaste("4/0AUn6Hd") != "4/0AUn6Hd" {
		t.Fatalf("antigravity: callback %v state %q ok %v", gcb, gstate, ok)
	}
	if got := callbackCode("https://antigravity.google/oauth-callback?state=G-STATE&code=4%2F0AUn6Hd__KS36&scope=openid", gcb, gstate); got != "4/0AUn6Hd__KS36" {
		t.Fatalf("antigravity code = %q", got)
	}
	// The device flows need no code back; nothing is taken for them.
	for _, engine := range []string{providerCodex, providerKimi, providerCursor} {
		if _, _, _, ok := codeCallback(engine, runnerBrowserClaudeURL); ok {
			t.Errorf("%s's link was taken for a callback", engine)
		}
	}
	if _, _, _, ok := codeCallback(providerClaude, "https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=S"); ok {
		t.Error("a localhost callback was taken")
	}
	if _, _, _, ok := codeCallback(providerAntigravity, "https://accounts.google.com/o/oauth2/auth?redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback"); ok {
		t.Error("a link without a state was taken")
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
	// kept: tabs of sign-ins that did not succeed; releasedAll: ReleaseSignInTabs() was called.
	kept        map[string]bool
	releasedAll bool
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

func (b *fakeLoginBrowser) KeepSignInTab(tab string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.kept == nil {
		b.kept = map[string]bool{}
	}
	b.kept[tab] = true
}

func (b *fakeLoginBrowser) KeepsSignInTab(tab string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.kept[tab]
}

func (b *fakeLoginBrowser) ReleaseSignInTabs(tabs ...string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.releasedAll = b.releasedAll || len(tabs) == 0
	if len(tabs) == 0 {
		b.kept = nil
	}
	for _, tab := range tabs {
		delete(b.kept, tab)
	}
}

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
	closed  []string
	pages   []browserTarget
	// navigated hands an address to the sign-in tab's navigation watch, as Chrome reports a navigation.
	navigated func(address string)
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
	oldOpen, oldClose, oldTargets, oldReady, oldWatch := loginBrowserOpenTab, loginBrowserCloseTab, loginBrowserTargets, browserDevToolsReady, loginBrowserWatchTab
	loginBrowserWatchTab = func(ctx context.Context, _ string, _ string, seen func(string)) {
		rig.mu.Lock()
		rig.navigated = seen
		rig.mu.Unlock()
		<-ctx.Done()
	}
	loginBrowserOpenTab = func(_ context.Context, _ string, target string) (string, error) {
		rig.mu.Lock()
		defer rig.mu.Unlock()
		rig.opened = append(rig.opened, target)
		return fmt.Sprintf("TAB%d", len(rig.opened)), nil
	}
	loginBrowserCloseTab = func(_ context.Context, _ string, id string) error {
		rig.mu.Lock()
		defer rig.mu.Unlock()
		rig.closed = append(rig.closed, id)
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
		loginBrowserOpenTab, loginBrowserCloseTab, loginBrowserTargets, browserDevToolsReady, loginBrowserWatchTab = oldOpen, oldClose, oldTargets, oldReady, oldWatch
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
	loginBrowserOpenTab = func(_ context.Context, _ string, target string) (string, error) { opened <- target; return "TAB1", nil }
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

func (rig *runnerBrowserRig) closedTabs() []string {
	rig.mu.Lock()
	defer rig.mu.Unlock()
	return append([]string(nil), rig.closed...)
}

// The sign-in's tab closes once the machine is signed in, and only then.
func TestLoginClosesItsTabInTheRunnersBrowserOnceSignedIn(t *testing.T) {
	rig := newRunnerBrowserRig(t, providerCodex, LoginResultRequest{Status: loginAwaitingApproval, URL: "https://auth.openai.com/codex/device", UserCode: "ABCD-1234"})
	rig.relay.openInLoginBrowser(context.Background(), LoginCommand{Action: "browser", Engine: providerCodex, Attempt: "A1"}, &fakeLoginBrowser{})
	rig.relay.mu.Lock()
	rig.run.reportedDone = true
	rig.relay.mu.Unlock()
	rig.cancel()
	deadline := time.Now().Add(2 * time.Second)
	for len(rig.closedTabs()) == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if got := rig.closedTabs(); len(got) != 1 || got[0] != "TAB1" {
		t.Fatalf("closed %v, want the sign-in's own tab", got)
	}
}

func TestLoginKeepsItsTabInTheRunnersBrowserWhenNotSignedIn(t *testing.T) {
	every := loginKeptTabCheckEvery
	loginKeptTabCheckEvery = 20 * time.Millisecond
	t.Cleanup(func() { loginKeptTabCheckEvery = every })
	rig := newRunnerBrowserRig(t, providerCodex, LoginResultRequest{Status: loginAwaitingApproval, URL: "https://auth.openai.com/codex/device", UserCode: "ABCD-1234"})
	rig.mu.Lock()
	rig.pages = []browserTarget{{ID: "TAB1", Type: "page"}}
	rig.mu.Unlock()
	browser := &fakeLoginBrowser{}
	rig.relay.openInLoginBrowser(context.Background(), LoginCommand{Action: "browser", Engine: providerCodex, Attempt: "A1"}, browser)
	rig.cancel() // failed, timed out or cancelled: never reported done
	time.Sleep(200 * time.Millisecond)
	if got := rig.closedTabs(); len(got) != 0 {
		t.Fatalf("closed %v after a sign-in that did not succeed", got)
	}
	// Its tab keeps the browser from stopping for idleness while it is open…
	if !browser.KeepsSignInTab("TAB1") {
		t.Fatal("the failed sign-in's tab does not keep the browser running")
	}
	// …and lets it go once the owner closes it.
	rig.mu.Lock()
	rig.pages = nil
	rig.mu.Unlock()
	deadline := time.Now().Add(2 * time.Second)
	for browser.KeepsSignInTab("TAB1") && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if browser.KeepsSignInTab("TAB1") {
		t.Fatal("the tab the owner closed still keeps the browser running")
	}
}

// A sign-in that succeeds settles what earlier ones' pages said: their tabs no longer keep the browser running.
func TestLoginSignedInReleasesEarlierKeptTabs(t *testing.T) {
	rig := newRunnerBrowserRig(t, providerCodex, LoginResultRequest{Status: loginAwaitingApproval, URL: "https://auth.openai.com/codex/device", UserCode: "ABCD-1234"})
	browser := &fakeLoginBrowser{kept: map[string]bool{"OLD": true}}
	rig.relay.openInLoginBrowser(context.Background(), LoginCommand{Action: "browser", Engine: providerCodex, Attempt: "A1"}, browser)
	rig.relay.mu.Lock()
	rig.run.reportedDone = true
	rig.relay.mu.Unlock()
	rig.cancel()
	deadline := time.Now().Add(2 * time.Second)
	for len(rig.closedTabs()) == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if browser.KeepsSignInTab("OLD") || browser.KeepsSignInTab("TAB1") {
		t.Fatal("a successful sign-in left a kept tab holding the browser")
	}
}

// A relay's real report marks the attempt done, which is what closes the tab.
func TestLoginRelayMarksAReportedSignInDone(t *testing.T) {
	fakeKimi(t, kimiHelpWithRegion, "")
	relay := &loginRelay{}
	t.Cleanup(relay.stop)
	done := make(chan struct{})
	var once sync.Once
	var run *loginRun
	relay.start(LoginCommand{Action: "start", Engine: providerKimi, Attempt: "K1"}, func(res LoginResultRequest) {
		if res.Status == loginAwaitingApproval {
			relay.mu.Lock()
			for _, r := range relay.runs {
				run = r
			}
			relay.mu.Unlock()
		}
		if res.Status == loginDone {
			once.Do(func() { close(done) })
		}
	})
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		t.Fatal("the sign-in never finished")
	}
	relay.mu.Lock()
	defer relay.mu.Unlock()
	if run == nil || !run.reportedDone {
		t.Fatalf("the run was not marked done: %+v", run)
	}
}

// closeSignInTab against a stand-in for Chrome's DevTools: it closes only the tab it is given, gives Chrome a blank tab
// first when that tab is the last one, and does nothing for a tab that is already gone.
func TestCloseSignInTab(t *testing.T) {
	for _, tc := range []struct {
		name      string
		pages     []browserTarget
		wantNew   bool
		wantClose bool
	}{
		{"the only tab", []browserTarget{{ID: "T1", Type: "page", URL: "https://a"}}, true, true},
		{"beside another", []browserTarget{{ID: "T1", Type: "page", URL: "https://a"}, {ID: "T2", Type: "page", URL: "https://b"}}, false, true},
		{"already closed", []browserTarget{{ID: "T2", Type: "page", URL: "https://b"}}, false, false},
		{"only beside devtools", []browserTarget{{ID: "T1", Type: "page", URL: "https://a"}, {ID: "D", Type: "page", URL: "devtools://x"}}, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var mu sync.Mutex
			var calls []string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				calls = append(calls, r.Method+" "+r.URL.Path+"?"+r.URL.RawQuery)
				mu.Unlock()
				switch {
				case r.URL.Path == "/json/list":
					_ = json.NewEncoder(w).Encode(tc.pages)
				case r.URL.Path == "/json/new":
					_, _ = w.Write([]byte(`{"id":"BLANK"}`))
				default:
					_, _ = w.Write([]byte("ok"))
				}
			}))
			defer srv.Close()
			if err := closeSignInTab(context.Background(), srv.URL, "T1"); err != nil {
				t.Fatal(err)
			}
			mu.Lock()
			defer mu.Unlock()
			joined := strings.Join(calls, " | ")
			if got := strings.Contains(joined, "PUT /json/new?about%3Ablank"); got != tc.wantNew {
				t.Errorf("blank tab opened = %v, want %v: %s", got, tc.wantNew, joined)
			}
			if got := strings.Contains(joined, "GET /json/close/T1"); got != tc.wantClose {
				t.Errorf("T1 closed = %v, want %v: %s", got, tc.wantClose, joined)
			}
			if strings.Contains(joined, "/json/close/T2") {
				t.Errorf("another tab was closed: %s", joined)
			}
			if tc.wantNew && strings.Index(joined, "/json/new") > strings.Index(joined, "/json/close") {
				t.Errorf("the blank tab came after the close: %s", joined)
			}
		})
	}
}

// Antigravity's sign-in: agy is handed the code its callback page shows, as a paste is (submitAntigravityGoogleCode).
func TestLoginTakesAntigravitysCodeFromTheRunnersBrowser(t *testing.T) {
	rig := newRunnerBrowserRig(t, providerAntigravity, LoginResultRequest{Status: loginAwaitingCode, URL: runnerBrowserAntigravityURL})
	rig.relay.mu.Lock()
	rig.run.google = &antigravityGoogleLoginOutput{url: runnerBrowserAntigravityURL}
	rig.relay.mu.Unlock()
	rig.relay.openInLoginBrowser(context.Background(), LoginCommand{Action: "browser", Engine: providerAntigravity, Attempt: "A1"}, &fakeLoginBrowser{})
	rig.showPage("https://antigravity.google/oauth-callback?state=OTHER&code=WRONG")
	rig.showPage("https://antigravity.google/oauth-callback?state=G-STATE&code=4%2F0AUn6Hd__KS36&scope=openid")
	typed := make(chan string, 1)
	go func() {
		buf := make([]byte, 256)
		n, _ := rig.stdin.Read(buf)
		typed <- string(buf[:n])
	}()
	select {
	case got := <-typed:
		if got != "4/0AUn6Hd__KS36\r" {
			t.Fatalf("agy was handed %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the code was never handed to agy")
	}
}

// Antigravity's callback page strips the code from its address once it loads: every page's address shows only
// antigravity.google/oauth-callback. The sign-in tab's navigation still carries it, and agy is handed the code.
func TestLoginTakesTheCodeFromTheTabsNavigationWhenThePageStripsItsAddress(t *testing.T) {
	rig := newRunnerBrowserRig(t, providerAntigravity, LoginResultRequest{Status: loginAwaitingCode, URL: runnerBrowserAntigravityURL})
	rig.relay.mu.Lock()
	rig.run.google = &antigravityGoogleLoginOutput{url: runnerBrowserAntigravityURL}
	rig.relay.mu.Unlock()
	rig.relay.openInLoginBrowser(context.Background(), LoginCommand{Action: "browser", Engine: providerAntigravity, Attempt: "A1"}, &fakeLoginBrowser{})
	rig.showPage("https://antigravity.google/oauth-callback")
	deadline := time.Now().Add(2 * time.Second)
	for {
		rig.mu.Lock()
		seen := rig.navigated
		rig.mu.Unlock()
		if seen != nil {
			seen("https://accounts.google.com/signin/oauth/consent?authuser=0")
			seen("https://antigravity.google/oauth-callback?state=G-STATE&code=4%2F0AUn6Hd9p1ZU5&scope=openid")
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the sign-in tab's navigations were never watched")
		}
		time.Sleep(10 * time.Millisecond)
	}
	typed := make(chan string, 1)
	go func() {
		buf := make([]byte, 256)
		n, _ := rig.stdin.Read(buf)
		typed <- string(buf[:n])
	}()
	select {
	case got := <-typed:
		if got != "4/0AUn6Hd9p1ZU5\r" {
			t.Fatalf("agy was handed %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the code was never handed to agy")
	}
}

// watchTabNavigations against a stand-in for Chrome's DevTools: it asks the tab for its page events and hands on every
// main-frame navigation, not a frame's inside the page.
func TestWatchTabNavigationsHandsOnTheTabsNavigations(t *testing.T) {
	var srvURL string
	mux := http.NewServeMux()
	mux.HandleFunc("/json/list", func(w http.ResponseWriter, r *http.Request) {
		ws := "ws" + strings.TrimPrefix(srvURL, "http") + "/devtools/page/TAB1"
		_ = json.NewEncoder(w).Encode([]map[string]string{
			{"id": "OTHER", "type": "page", "url": "https://b", "webSocketDebuggerUrl": "ws://unused"},
			{"id": "TAB1", "type": "page", "url": "https://a", "webSocketDebuggerUrl": ws},
		})
	})
	enabled := make(chan struct{}, 1)
	mux.HandleFunc("/devtools/page/TAB1", func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		_, data, err := c.Read(r.Context())
		if err != nil || !strings.Contains(string(data), `"Page.enable"`) {
			return
		}
		enabled <- struct{}{}
		for _, msg := range []string{
			`{"id":1,"result":{}}`,
			`{"method":"Page.frameNavigated","params":{"frame":{"id":"F2","parentId":"F1","url":"https://ads.example/x?code=NOPE"}}}`,
			`{"method":"Page.frameNavigated","params":{"frame":{"id":"F1","url":"https://antigravity.google/oauth-callback?state=S&code=C"}}}`,
		} {
			_ = c.Write(r.Context(), websocket.MessageText, []byte(msg))
		}
		<-r.Context().Done()
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	srvURL = srv.URL
	oldTargets := loginBrowserTargets
	loginBrowserTargets = browserTargets
	defer func() { loginBrowserTargets = oldTargets }()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	got := make(chan string, 4)
	go watchTabNavigations(ctx, srv.URL, "TAB1", func(address string) { got <- address })
	select {
	case <-enabled:
	case <-ctx.Done():
		t.Fatal("the tab's page events were never asked for")
	}
	select {
	case address := <-got:
		if address != "https://antigravity.google/oauth-callback?state=S&code=C" {
			t.Fatalf("handed %q", address)
		}
	case <-ctx.Done():
		t.Fatal("no navigation was handed on")
	}
	select {
	case address := <-got:
		t.Fatalf("also handed %q", address)
	case <-time.After(200 * time.Millisecond):
	}
}
