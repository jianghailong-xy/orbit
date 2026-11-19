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
}

func (p *fakeBrowserProcess) Exited() bool { return p.exited }
func (p *fakeBrowserProcess) Stop()        { p.stopped = true }

type fakeBrowserStarter struct {
	mu      sync.Mutex
	started []*fakeBrowserProcess
	reaped  int
}

func (s *fakeBrowserStarter) Start(name string, args []string) (browserProcess, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := &fakeBrowserProcess{name: name, args: args}
	s.started = append(s.started, p)
	return p, nil
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
	for _, want := range []string{"--no-sandbox", "--disable-dev-shm-usage", "--user-data-dir=" + profile, "--remote-debugging-address=127.0.0.1"} {
		if !strings.Contains(args["chromium"], want) {
			t.Fatalf("chromium args %q lack %q", args["chromium"], want)
		}
	}
	if want := ":1 -screen 0 1280x800x24"; !strings.HasPrefix(args["Xvfb"], want) {
		t.Fatalf("Xvfb args %q", args["Xvfb"])
	}
	sock := filepath.Join(r.home, ".orbit", "browser", "vnc.sock")
	for _, want := range []string{"-unixsock " + sock, "-shared", "-forever", "-nopw"} {
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
