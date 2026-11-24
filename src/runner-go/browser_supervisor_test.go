package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeBrowserProcess struct {
	name    string
	args    []string
	exited  bool
	stopped bool
	done    chan struct{}
	once    sync.Once
}

func (p *fakeBrowserProcess) Exited() bool          { return p.exited }
func (p *fakeBrowserProcess) Done() <-chan struct{} { return p.done }
func (p *fakeBrowserProcess) Stop()                 { p.ended() }

// ended is this program ending, by Stop or by itself, as Chrome does when its last tab closes.
func (p *fakeBrowserProcess) ended() {
	p.once.Do(func() {
		p.exited = true
		p.stopped = true
		close(p.done)
	})
}

type fakeBrowserStarter struct {
	mu      sync.Mutex
	started []*fakeBrowserProcess
	reaped  int
}

func (s *fakeBrowserStarter) Start(name string, args []string) (browserProcess, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := &fakeBrowserProcess{name: name, args: args, done: make(chan struct{})}
	s.started = append(s.started, p)
	return p, nil
}

// count is how many programs have been started, for a watcher running in its own goroutine.
func (s *fakeBrowserStarter) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.started)
}
func (s *fakeBrowserStarter) WaitDisplay(string) error { return nil }
func (s *fakeBrowserStarter) Reap()                    { s.reaped++ }

func (s *fakeBrowserStarter) live() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var names []string
	for _, p := range s.started {
		if !p.stopped {
			names = append(names, p.name)
		}
	}
	return names
}

func managedEnv(key string) (string, bool) {
	if key == envManagedRunnerGeneration {
		return "3", true
	}
	return "", false
}

func noEnv(string) (string, bool) { return "", false }

type browserRig struct {
	b       *browserSupervisor
	clock   *fakePoolClock
	starter *fakeBrowserStarter
	home    string
}

func newBrowserRig(t *testing.T) *browserRig {
	t.Helper()
	r := &browserRig{clock: newFakePoolClock(), starter: &fakeBrowserStarter{}, home: t.TempDir()}
	r.b = newRunnerBrowser(managedEnv, r.home, r.clock, r.starter, nil)
	if r.b == nil {
		t.Fatal("a runner the managed entrypoint started has no browser supervisor")
	}
	r.b.SetOffered(true)
	return r
}

func TestBrowserAcquireStartsTheBrowserAndTakesTheLease(t *testing.T) {
	r := newBrowserRig(t)
	if r.b.Running() {
		t.Fatal("the browser started before anything used it")
	}
	if err := r.b.Acquire("sess-a", "Fix login"); err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if got := r.b.Holder(); got != "sess-a" {
		t.Fatalf("holder = %q, want sess-a", got)
	}
	if got := strings.Join(r.starter.live(), ","); got != "Xvfb,x11vnc,chromium" {
		t.Fatalf("started %s", got)
	}
	args := map[string]string{}
	for _, p := range r.starter.started {
		args[p.name] = strings.Join(p.args, " ")
	}
	profile := filepath.Join(r.home, ".orbit", "browser", "profile")
	chromeArgs := map[string]bool{}
	for _, p := range r.starter.started {
		if p.name == "chromium" {
			for _, a := range p.args {
				chromeArgs[a] = true
			}
		}
	}
	// --test-type with --no-sandbox: without it Chrome draws the "unsupported command-line flag" bar on every page.
	for _, want := range []string{"--no-sandbox", "--test-type", "--disable-dev-shm-usage", "--user-data-dir=" + profile, "--remote-debugging-address=127.0.0.1"} {
		if !chromeArgs[want] {
			t.Fatalf("chromium args %q lack %q", args["chromium"], want)
		}
	}
	if want := ":1 -screen 0 1280x800x24"; !strings.HasPrefix(args["Xvfb"], want) {
		t.Fatalf("Xvfb args %q", args["Xvfb"])
	}
	sock := filepath.Join(r.home, ".orbit", "browser", "vnc.sock")
	for _, want := range []string{"-unixsock " + sock, "-shared", "-forever", "-nopw", "-noprimary"} {
		if !strings.Contains(args["x11vnc"], want) {
			t.Fatalf("x11vnc args %q lack %q", args["x11vnc"], want)
		}
	}
	if st, err := os.Stat(profile); err != nil || !st.IsDir() {
		t.Fatalf("profile dir: %v", err)
	}
	// The holder's next call renews its lease and starts nothing new.
	if err := r.b.Acquire("sess-a", ""); err != nil {
		t.Fatalf("second acquire by the holder: %v", err)
	}
	if n := len(r.starter.started); n != 3 {
		t.Fatalf("started %d programs, want 3", n)
	}
}

func TestBrowserSecondSessionIsRefusedNamingTheHolder(t *testing.T) {
	r := newBrowserRig(t)
	if err := r.b.Acquire("sess-a", "Fix login"); err != nil {
		t.Fatal(err)
	}
	err := r.b.Acquire("sess-b", "Other work")
	if err == nil {
		t.Fatal("a second session took the browser while another held it")
	}
	want := `The browser is in use by session "Fix login" (sess-a); try again after it finishes`
	if err.Error() != want {
		t.Fatalf("error = %q, want %q", err, want)
	}
	if got := r.b.Holder(); got != "sess-a" {
		t.Fatalf("holder = %q after a refused acquire", got)
	}

	untitled := newBrowserRig(t)
	_ = untitled.b.Acquire("sess-a", "")
	if err := untitled.b.Acquire("sess-b", ""); err == nil || !strings.Contains(err.Error(), "session sess-a;") {
		t.Fatalf("untitled holder error = %v", err)
	}
}

func TestBrowserLeaseReleasedAtTheHoldersTurnEnd(t *testing.T) {
	r := newBrowserRig(t)
	_ = r.b.Acquire("sess-a", "")
	r.b.Release("sess-b") // not the holder: nothing
	if r.b.Holder() != "sess-a" {
		t.Fatal("another session's turn end released the holder's lease")
	}
	r.b.Release("sess-a")
	if h := r.b.Holder(); h != "" {
		t.Fatalf("holder = %q after its turn ended", h)
	}
	if err := r.b.Acquire("sess-b", ""); err != nil {
		t.Fatalf("acquire after the holder's turn ended: %v", err)
	}
	if !r.b.Running() || len(r.starter.started) != 3 {
		t.Fatal("the browser restarted between holders")
	}
}

func TestBrowserLeaseReleasedAfterFiveMinutesWithoutABrowserCall(t *testing.T) {
	r := newBrowserRig(t)
	_ = r.b.Acquire("sess-a", "")
	r.clock.Advance(4 * time.Minute)
	_ = r.b.Acquire("sess-a", "") // a call renews the lease
	r.clock.Advance(4*time.Minute + 59*time.Second)
	if err := r.b.Acquire("sess-b", ""); err == nil {
		t.Fatal("the lease ended before 5 minutes without a call")
	}
	r.clock.Advance(time.Second)
	if h := r.b.Holder(); h != "" {
		t.Fatalf("holder = %q after 5 minutes without a browser call", h)
	}
	if err := r.b.Acquire("sess-b", ""); err != nil {
		t.Fatalf("acquire after the lease expired: %v", err)
	}
}

func TestBrowserSupervisorAbsentWithoutTheManagedEntrypointOrTheOffer(t *testing.T) {
	starter := &fakeBrowserStarter{}
	if b := newRunnerBrowser(noEnv, t.TempDir(), newFakePoolClock(), starter, nil); b != nil {
		t.Fatal("a runner without ORBIT_MANAGED_RUNNER_GENERATION has a browser supervisor")
	}
	var none *browserSupervisor
	none.SetOffered(true)
	if err := none.Acquire("sess-a", ""); !errors.Is(err, errBrowserUnavailable) {
		t.Fatalf("acquire with no supervisor = %v", err)
	}
	none.Release("sess-a")
	none.ViewerOpened()()

	b := newRunnerBrowser(managedEnv, t.TempDir(), newFakePoolClock(), starter, nil) // never offered
	if err := b.Acquire("sess-a", ""); !errors.Is(err, errBrowserUnavailable) {
		t.Fatalf("acquire while Welcome.browser is false = %v", err)
	}
	if err := b.Open(); !errors.Is(err, errBrowserUnavailable) {
		t.Fatalf("open while Welcome.browser is false = %v", err)
	}
	if len(starter.started) != 0 || b.Running() {
		t.Fatal("the browser started while Welcome.browser was false or the entrypoint env absent")
	}
}

func TestBrowserStopsAfterFifteenIdleMinutesWithNoViewer(t *testing.T) {
	r := newBrowserRig(t)
	_ = r.b.Acquire("sess-a", "")
	r.b.Release("sess-a")
	r.clock.Advance(14*time.Minute + 59*time.Second)
	if !r.b.Running() {
		t.Fatal("the browser stopped before 15 idle minutes")
	}
	r.clock.Advance(time.Second)
	if r.b.Running() || len(r.starter.live()) != 0 {
		t.Fatalf("the browser still runs after 15 idle minutes: %v", r.starter.live())
	}
	// The next call starts it again.
	if err := r.b.Acquire("sess-b", ""); err != nil || !r.b.Running() {
		t.Fatalf("acquire after an idle stop: %v", err)
	}
}

func TestBrowserDoesNotIdleStopWhileAViewerIsOpen(t *testing.T) {
	r := newBrowserRig(t)
	if err := r.b.Open(); err != nil { // the owner's Open browser
		t.Fatal(err)
	}
	if r.b.Holder() != "" {
		t.Fatal("the owner opening the browser took the lease")
	}
	closeViewer := r.b.ViewerOpened()
	if r.b.Viewers() != 1 {
		t.Fatalf("viewers = %d", r.b.Viewers())
	}
	r.clock.Advance(time.Hour)
	if !r.b.Running() {
		t.Fatal("the browser stopped for idleness while a viewer was open")
	}
	if err := r.b.Acquire("sess-a", ""); err != nil {
		t.Fatalf("an agent was refused while only the owner watched: %v", err)
	}
	r.b.Release("sess-a")
	closeViewer()
	closeViewer() // once
	if r.b.Viewers() != 0 {
		t.Fatalf("viewers = %d after close", r.b.Viewers())
	}
	r.clock.Advance(14 * time.Minute)
	if !r.b.Running() {
		t.Fatal("the idle clock did not restart when the viewer closed")
	}
	r.clock.Advance(time.Minute)
	if r.b.Running() {
		t.Fatal("the browser still runs 15 minutes after the last viewer closed")
	}
}

// A sign-in that did not succeed keeps its tab, and the browser with it: a stopped browser starts again without it.
func TestBrowserDoesNotIdleStopWhileAFailedSignInsTabIsKept(t *testing.T) {
	r := newBrowserRig(t)
	if err := r.b.ReserveForEngineSignIn("A1"); err != nil {
		t.Fatal(err)
	}
	r.b.KeepSignInTab("TAB1")
	r.b.EndEngineSignIn("A1")
	r.clock.Advance(time.Hour)
	if !r.b.Running() || !r.b.KeepsSignInTab("TAB1") {
		t.Fatal("the browser stopped for idleness while a failed sign-in's tab was kept")
	}
	r.b.ReleaseSignInTabs("TAB1")
	r.clock.Advance(14 * time.Minute)
	if !r.b.Running() {
		t.Fatal("the idle clock did not restart when the kept tab went")
	}
	r.clock.Advance(time.Minute)
	if r.b.Running() {
		t.Fatal("the browser still runs 15 minutes after the kept tab went")
	}
	// A browser that stops anyway keeps nothing: its tabs are gone.
	_ = r.b.Acquire("sess-a", "")
	r.b.KeepSignInTab("TAB2")
	r.b.ReleaseSignInTabs() // every kept tab
	if r.b.KeepsSignInTab("TAB2") {
		t.Fatal("ReleaseSignInTabs() kept a tab")
	}
	r.b.KeepSignInTab("TAB3")
	r.b.mu.Lock()
	r.b.stopLocked("test")
	r.b.mu.Unlock()
	if r.b.KeepsSignInTab("TAB3") {
		t.Fatal("a stopped browser still keeps a tab")
	}
}

func TestBrowserStopsWhenTheOfferEndsAfterTheRunningTurn(t *testing.T) {
	r := newBrowserRig(t)
	_ = r.b.Acquire("sess-a", "")
	r.b.SetOffered(false)
	if !r.b.Running() {
		t.Fatal("the browser stopped under a turn that holds it")
	}
	if err := r.b.Acquire("sess-a", ""); err != nil {
		t.Fatalf("the holder's turn lost the browser before it ended: %v", err)
	}
	if err := r.b.Acquire("sess-b", ""); !errors.Is(err, errBrowserUnavailable) {
		t.Fatalf("another session after the offer ended = %v", err)
	}
	r.b.Release("sess-a")
	if r.b.Running() {
		t.Fatal("the browser still runs after the holder's turn ended with no offer")
	}

	idle := newBrowserRig(t)
	_ = idle.b.Open()
	idle.b.SetOffered(false)
	if idle.b.Running() {
		t.Fatal("the browser with no holder kept running after the offer ended")
	}
}

func TestBrowserRestartsWhenAProgramEnded(t *testing.T) {
	r := newBrowserRig(t)
	_ = r.b.Acquire("sess-a", "")
	r.starter.started[2].exited = true // Chrome crashed
	if err := r.b.Acquire("sess-a", ""); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(r.starter.live(), ","); got != "Xvfb,x11vnc,chromium" || len(r.starter.started) != 6 {
		t.Fatalf("after a crash: live %s of %d started", got, len(r.starter.started))
	}
}

// Chromium quits with its last tab or window. Under a viewer, Chrome alone starts again on the display and VNC server
// still running, so the owner's stream stays open and draws the new window instead of a black display forever.
func TestBrowserStartsWithChromeAgainWhenItsLastTabClosesUnderAViewer(t *testing.T) {
	r := newBrowserRig(t)
	if err := r.b.Open(); err != nil {
		t.Fatal(err)
	}
	closeViewer := r.b.ViewerOpened()
	defer closeViewer()

	r.starter.started[browserProgramChrome].ended() // the owner closed the last tab: Chromium exits with it
	waitUntil(t, func() bool { return r.starter.count() == 4 }, "Chrome did not start again under the viewer")
	if got := strings.Join(r.starter.live(), ","); got != "Xvfb,x11vnc,chromium" {
		t.Fatalf("after Chrome ended under a viewer: live %s of %d started", got, r.starter.count())
	}
	if r.b.Viewers() != 1 || !r.b.Running() {
		t.Fatalf("viewers = %d, running = %v", r.b.Viewers(), r.b.Running())
	}
	// The display and VNC server were not restarted: the viewer's stream still names the same socket.
	for i, want := range []string{"Xvfb", "x11vnc", "chromium", "chromium"} {
		if r.starter.started[i].name != want {
			t.Fatalf("started %d is %s, want %s", i, r.starter.started[i].name, want)
		}
	}
	// The new Chrome is watched too.
	r.starter.started[3].ended()
	waitUntil(t, func() bool { return r.starter.count() == 5 }, "the restarted Chrome was not watched")
}

// With no viewer, Chrome ending leaves the browser nothing to serve: the programs stop, the report says so, and the
// next Open or browser call starts them together again.
func TestBrowserStopsWhenChromeEndsWithNoViewer(t *testing.T) {
	r := newBrowserRig(t)
	if err := r.b.Acquire("sess-a", ""); err != nil {
		t.Fatal(err)
	}
	r.starter.started[browserProgramChrome].ended()
	waitUntil(t, func() bool { return !r.b.Running() }, "the browser did not stop")
	if live := r.starter.live(); len(live) != 0 {
		t.Fatalf("still running after Chrome ended: %v", live)
	}
	if err := r.b.Acquire("sess-a", ""); err != nil || !r.b.Running() {
		t.Fatalf("acquire after Chrome ended: %v", err)
	}
}

// The display ending ends the browser whatever else runs, viewer or not: the VNC server has nothing to show.
func TestBrowserStopsWhenTheDisplayEndsUnderAViewer(t *testing.T) {
	r := newBrowserRig(t)
	if err := r.b.Open(); err != nil {
		t.Fatal(err)
	}
	closeViewer := r.b.ViewerOpened()
	defer closeViewer()
	r.starter.started[browserProgramXvfb].ended()
	waitUntil(t, func() bool { return !r.b.Running() }, "the browser did not stop")
	if live := r.starter.live(); len(live) != 0 {
		t.Fatalf("still running after the display ended: %v", live)
	}
}

func TestBrowserLeaseKeyedByPublicID(t *testing.T) {
	r := newBrowserRig(t)
	uuid := "01a1e937-723a-744b-8919-bed2955dd75a"
	_ = r.b.Acquire(publicID(uuid), "") // the engine's ORBIT_SESSION_ID
	r.b.Release(uuid)                   // the pool's id
	if h := r.b.Holder(); h != "" {
		t.Fatalf("holder = %q: the pool's id did not release the engine's lease", h)
	}
}

// Clear saved logins (docs/runner-browser-design.md §5, §6): the browser stops, whoever holds it and whatever viewers
// are open, its profile is deleted with everything in it, and the next report says when.
func TestBrowserClearProfileStopsTheBrowserAndDeletesTheProfile(t *testing.T) {
	r := newBrowserRig(t)
	if err := r.b.Acquire("sess-a", "Sign in"); err != nil {
		t.Fatal(err)
	}
	closeViewer := r.b.ViewerOpened()
	defer closeViewer()
	profile := r.b.ProfileDir()
	cookies := filepath.Join(profile, "Default", "Cookies")
	if err := os.MkdirAll(filepath.Dir(cookies), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cookies, []byte("a saved login"), 0o600); err != nil {
		t.Fatal(err)
	}
	before := r.b.Report()
	if !before.Running || before.HolderSessionID != "sess-a" || before.HolderTitle != "Sign in" || before.Viewers != 1 || before.ProfileClearedAt != "" {
		t.Fatalf("report before the clear = %+v", before)
	}
	reaped := r.starter.reaped

	if err := r.b.ClearProfile(); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if live := r.starter.live(); len(live) != 0 {
		t.Fatalf("still running after the clear: %v", live)
	}
	if r.starter.reaped == reaped {
		t.Fatal("the clear reaped nothing the browser's programs left")
	}
	if _, err := os.Stat(profile); !os.IsNotExist(err) {
		t.Fatalf("the profile is still there after the clear: %v", err)
	}
	if _, err := os.Stat(r.b.stateDir); err != nil {
		t.Fatalf("the clear deleted more than the profile: %v", err)
	}
	after := r.b.Report()
	if after.Running {
		t.Fatalf("report after the clear says running: %+v", after)
	}
	if want := r.clock.Now().UTC().Format(time.RFC3339Nano); after.ProfileClearedAt != want {
		t.Fatalf("profileClearedAt = %q, want %q", after.ProfileClearedAt, want)
	}

	// The holder's next browser call starts a browser on a new, empty profile.
	if err := r.b.Acquire("sess-a", ""); err != nil {
		t.Fatalf("acquire after the clear: %v", err)
	}
	if got := strings.Join(r.starter.live(), ","); got != "Xvfb,x11vnc,chromium" {
		t.Fatalf("started after the clear: %s", got)
	}
	if _, err := os.Stat(cookies); !os.IsNotExist(err) {
		t.Fatalf("a saved login came back: %v", err)
	}
	if st, err := os.Stat(profile); err != nil || !st.IsDir() {
		t.Fatalf("no new profile: %v", err)
	}
}

// A clear while nothing runs, or while the server does not offer the browser, still deletes the profile.
func TestBrowserClearProfileWhileStoppedOrNotOffered(t *testing.T) {
	r := newBrowserRig(t)
	if err := os.MkdirAll(filepath.Join(r.b.ProfileDir(), "Default"), 0o700); err != nil {
		t.Fatal(err)
	}
	r.b.SetOffered(false)
	if err := r.b.ClearProfile(); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if _, err := os.Stat(r.b.ProfileDir()); !os.IsNotExist(err) {
		t.Fatalf("the profile is still there: %v", err)
	}
	if len(r.starter.started) != 0 {
		t.Fatalf("the clear started something: %d programs", len(r.starter.started))
	}
	// Clearing a profile that is not there is no error.
	if err := r.b.ClearProfile(); err != nil {
		t.Fatalf("second clear: %v", err)
	}
}

// A runner with no browser reports none and clears nothing.
func TestBrowserReportAndClearWithoutABrowser(t *testing.T) {
	var b *browserSupervisor
	if b.Report() != nil {
		t.Fatal("a runner with no browser reported one")
	}
	if err := b.ClearProfile(); !errors.Is(err, errBrowserUnavailable) {
		t.Fatalf("clear without a browser: %v", err)
	}
	if newRunnerBrowser(noEnv, t.TempDir(), newFakePoolClock(), &fakeBrowserStarter{}, nil) != nil {
		t.Fatal("a self-managed runner has a browser")
	}
}

// The heartbeat carries the report and the clear under the names @orbit/shared gives them, and only a managed runner
// declares browser-clear/v1, the capability the control plane checks before it asks for a clear.
func TestBrowserClearWireNamesAndCapability(t *testing.T) {
	if !declaresBrowserClear(managedEnv) || declaresBrowserClear(noEnv) {
		t.Fatal("browser-clear/v1 is declared by the wrong runners")
	}
	shared, err := os.ReadFile(filepath.Join("..", "shared", "src", "dto.ts"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"BROWSER_CLEAR_V1 = '" + browserClearCapabilityV1 + "'",
		"clearBrowserProfile?: boolean;",
		"browser?: RunnerBrowserReport;",
		"holderSessionId?: string;", "holderTitle?: string;", "profileClearedAt?: string;", "viewers: number;", "running: boolean;",
	} {
		if !strings.Contains(string(shared), want) {
			t.Errorf("@orbit/shared does not say %s", want)
		}
	}
	var resp HeartbeatResponse
	if err := json.Unmarshal([]byte(`{"clearBrowserProfile":true}`), &resp); err != nil || !resp.ClearBrowserProfile {
		t.Fatalf("clearBrowserProfile not read: %v %+v", err, resp.ClearBrowserProfile)
	}
	body, err := json.Marshal(HeartbeatRequest{Browser: &BrowserReport{Running: true, HolderSessionID: "s", Viewers: 2}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), `"browser":{"running":true,"holderSessionId":"s","viewers":2,"savedLogins":false}`) {
		t.Fatalf("heartbeat body: %s", body)
	}
}

// browser_request_sign_in (board 03-agent-tools ①, Q2 = A): the asker gives the lease up while the owner is asked to
// sign in, nobody's browser call is taken meanwhile, Chrome keeps running (the page stays), and after the answer the
// asker takes the lease back.
func TestBrowserSignInReleasesTheLeaseWhileWaitingAndTakesItBack(t *testing.T) {
	r := newBrowserRig(t)
	if err := r.b.Acquire("sess-a", "Export the monthly report"); err != nil {
		t.Fatal(err)
	}
	held, err := r.b.YieldForSignIn("sess-a", "")
	if err != nil || !held {
		t.Fatalf("yield = %v, %v; want held, nil", held, err)
	}
	if h := r.b.Holder(); h != "" {
		t.Fatalf("holder = %q while the owner is asked to sign in; want none", h)
	}
	if rep := r.b.Report(); rep.HolderSessionID != "" {
		t.Fatalf("the heartbeat reports holder %q while the owner signs in", rep.HolderSessionID)
	}
	if w := r.b.SignInWaiting(); w != "sess-a" {
		t.Fatalf("sign-in waiting = %q", w)
	}
	for _, s := range []string{"sess-a", "sess-b"} {
		err := r.b.Acquire(s, "")
		if err == nil || !strings.Contains(err.Error(), "waiting for the owner to sign in") ||
			!strings.Contains(err.Error(), "Export the monthly report") {
			t.Fatalf("%s's browser call while the owner signs in = %v; want a refusal naming the asker", s, err)
		}
	}
	// The owner's Open browser and viewer are never refused.
	if err := r.b.Open(); err != nil {
		t.Fatalf("the owner's Open browser while a sign-in waits: %v", err)
	}
	// An hour with no viewer and no call: the browser keeps the agent's page for the owner.
	r.clock.Advance(time.Hour)
	if !r.b.Running() || len(r.starter.started) != 3 {
		t.Fatalf("the browser stopped or restarted while the owner was asked to sign in: %v", r.starter.live())
	}
	if err := r.b.EndSignIn("sess-a", "", true); err != nil {
		t.Fatalf("take back after the answer: %v", err)
	}
	if h := r.b.Holder(); h != "sess-a" {
		t.Fatalf("holder = %q after the answer; want the asker back", h)
	}
	if rep := r.b.Report(); rep.HolderTitle != "Export the monthly report" {
		t.Fatalf("holder title after the answer = %q", rep.HolderTitle)
	}
	if len(r.starter.started) != 3 {
		t.Fatal("taking the lease back restarted the browser: the page the agent was on is lost")
	}
	if err := r.b.Acquire("sess-b", ""); err == nil || !strings.Contains(err.Error(), "in use by session") {
		t.Fatalf("another session after the answer = %v; want refused by the asker's lease", err)
	}
	// Idle again once the wait is over: the lease's own clock and the idle stop apply.
	r.b.Release("sess-a")
	r.clock.Advance(15 * time.Minute)
	if r.b.Running() {
		t.Fatal("the browser does not idle-stop after the sign-in ended")
	}
}

func TestBrowserSignInRefusedUnderAnotherHolderOrASecondWait(t *testing.T) {
	r := newBrowserRig(t)
	_ = r.b.Acquire("sess-b", "Other work")
	if _, err := r.b.YieldForSignIn("sess-a", ""); err == nil || !strings.Contains(err.Error(), "Other work") {
		t.Fatalf("a sign-in under another session's lease = %v; want refused naming the holder", err)
	}
	if r.b.Holder() != "sess-b" {
		t.Fatal("a refused sign-in took the other session's lease")
	}
	r.b.Release("sess-b")
	held, err := r.b.YieldForSignIn("sess-a", "Asker")
	if err != nil || held {
		t.Fatalf("a sign-in with no lease held = %v, %v; want not held, nil", held, err)
	}
	if _, err := r.b.YieldForSignIn("sess-b", ""); err == nil || !strings.Contains(err.Error(), "already waiting") {
		t.Fatalf("a second sign-in while one waits = %v", err)
	}
	// Ending without retake (the asker did not hold it, or filing failed) frees the browser for anyone.
	if err := r.b.EndSignIn("sess-a", "", false); err != nil {
		t.Fatal(err)
	}
	if r.b.SignInWaiting() != "" || r.b.Holder() != "" {
		t.Fatal("the wait or a lease outlived EndSignIn without retake")
	}
	if err := r.b.Acquire("sess-b", ""); err != nil {
		t.Fatalf("acquire after the wait ended: %v", err)
	}
	var none *browserSupervisor
	if _, err := none.YieldForSignIn("sess-a", ""); !errors.Is(err, errBrowserUnavailable) {
		t.Fatalf("yield with no supervisor = %v", err)
	}
}
