package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

// The managed runner browser (docs/runner-browser-design.md §3, P2 = B): one Xvfb display, one Chrome and one x11vnc
// per runner, shared by its sessions one at a time.
//
// It exists only on a runner the managed image's entrypoint started (ORBIT_MANAGED_RUNNER_GENERATION set), and acts
// only while the current connection's Welcome offers it (Welcome.browser). It starts on demand — the first browser
// tool call or the owner opening it — and stops after browserIdleStop with no browser call and no open viewer, or
// once the server stops offering it and the turn that holds it has ended.
//
// The lease: the first session to call a browser tool holds the browser until its turn ends or browserLeaseIdle
// passes without a browser call from it. Another session's call meanwhile is refused with an error naming the
// holder. The owner's viewer never takes the lease and is never refused.
//
// A sign-in (browser_request_sign_in, board 03-agent-tools ①, Q2 = A): while the owner is asked to sign in, the asking
// session gives the lease up (YieldForSignIn) so the owner's clicks and an agent's do not collide. Until the answer no
// session's browser call is taken, the asker's own included, and the browser does not stop for idleness, so the page
// the agent was on is there when the owner opens it. After the answer the asker takes the lease back (EndSignIn).
const (
	browserIdleStop  = 15 * time.Minute
	browserLeaseIdle = 5 * time.Minute

	browserDisplay       = ":1"
	browserScreen        = "1280x800x24"
	browserDevToolsPort  = 9222
	browserDevToolsHost  = "127.0.0.1"
	browserChromeBinary  = "chromium"
	browserXvfbBinary    = "Xvfb"
	browserX11vncBinary  = "x11vnc"
	browserStateDirName  = "browser"
	browserProfileSubdir = "profile"
	browserVNCSocketName = "vnc.sock"
)

// The indexes into browserSupervisor.procs, in the order ensureStartedLocked starts them.
const (
	browserProgramXvfb = iota
	browserProgramVNC
	browserProgramChrome
)

// browserClearCapabilityV1 declares that this runner reports its browser on each heartbeat and honours Clear saved
// logins (HeartbeatResponse.ClearBrowserProfile): @orbit/shared's BROWSER_CLEAR_V1. Only a managed runner declares it.
const browserClearCapabilityV1 = "browser-clear/v1"

// declaresBrowserClear: whether this process declares browserClearCapabilityV1, the runners that have a browser.
func declaresBrowserClear(lookup func(string) (string, bool)) bool {
	v, ok := lookup(envManagedRunnerGeneration)
	return ok && v != ""
}

// errBrowserUnavailable: this runner has no browser now — not a managed runner, or the server does not offer it.
var errBrowserUnavailable = errors.New("The browser is not available on this runner")

// browserProcess is one started program of the browser (Xvfb, Chrome or x11vnc).
type browserProcess interface {
	// Exited reports whether the program has ended by itself.
	Exited() bool
	// Done is closed when the program has ended.
	Done() <-chan struct{}
	// Stop ends the program and waits for it.
	Stop()
}

// browserProcessStarter starts one program with DISPLAY set to the browser's display.
type browserProcessStarter interface {
	Start(name string, args []string) (browserProcess, error)
	// WaitDisplay waits until the display Xvfb serves accepts clients.
	WaitDisplay(display string) error
	// Reap ends whatever the browser's programs left running: those a previous image of this runner started before a
	// self-update re-executed it, or what a stopped program spawned.
	Reap()
}

// browserLease is who holds the browser.
type browserLease struct {
	sessionID string
	title     string
	timer     poolTimer
}

type browserSupervisor struct {
	clock    poolClock
	starter  browserProcessStarter
	stateDir string // ~/.orbit/browser on the runner's volume
	log      func(...any)

	mu      sync.Mutex
	offered bool
	procs   []browserProcess // nil while stopped
	lease   *browserLease
	viewers int
	// stopAfterTurn: the server stopped offering the browser while a session held it; it stops when the lease ends.
	stopAfterTurn bool
	idle          poolTimer
	// clearedAt is when the owner last cleared the saved logins (zero: not since this process started).
	clearedAt time.Time
	// signIn is the session waiting for the owner to sign in (nil: none). Nothing of the site is kept here.
	signIn *browserLease
	// engineSignIn is the engine sign-in the owner is finishing in this browser (login_runner_browser.go): the
	// attempt's id, "" when none. While it is set no session's browser call is taken, the holder's included.
	engineSignIn string
	// keptTabs are the tabs of engine sign-ins that did not succeed (login_runner_browser.go): the browser does not
	// stop for idleness while one is open, so what the page said is still there when the owner looks. Each goes when
	// the owner closes its tab, a later engine sign-in succeeds, or the browser stops or Chrome starts again anyway.
	keptTabs map[string]bool
}

// newRunnerBrowser is this runner's browser supervisor: nil unless the managed image's entrypoint started it
// (ORBIT_MANAGED_RUNNER_GENERATION set). Every method is safe on nil and acts as "no browser".
func newRunnerBrowser(lookup func(string) (string, bool), home string, clock poolClock, starter browserProcessStarter, log func(...any)) *browserSupervisor {
	if !declaresBrowserClear(lookup) {
		return nil
	}
	if log == nil {
		log = func(...any) {}
	}
	return &browserSupervisor{
		clock: clock, starter: starter, log: log,
		stateDir: filepath.Join(home, ".orbit", browserStateDirName),
	}
}

var (
	runnerBrowserOnce sync.Once
	runnerBrowserInst *browserSupervisor
)

// runnerBrowser is this process's browser supervisor (nil on a runner that has none).
func runnerBrowser() *browserSupervisor {
	runnerBrowserOnce.Do(func() {
		home, err := os.UserHomeDir()
		if err != nil {
			return
		}
		runnerBrowserInst = newRunnerBrowser(os.LookupEnv, home, realPoolClock{}, execBrowserStarter{}, logln)
	})
	return runnerBrowserInst
}

// ProfileDir is Chrome's user data directory, on the runner's volume so logins survive restarts.
func (b *browserSupervisor) ProfileDir() string {
	return filepath.Join(b.stateDir, browserProfileSubdir)
}

// VNCSocket is the unix socket x11vnc serves the display on.
func (b *browserSupervisor) VNCSocket() string {
	return filepath.Join(b.stateDir, browserVNCSocketName)
}

// DevToolsEndpoint is where Chrome's DevTools protocol listens, on loopback only.
func (b *browserSupervisor) DevToolsEndpoint() string {
	return "http://" + browserDevToolsHost + ":" + strconv.Itoa(browserDevToolsPort)
}

// SetOffered records what the current connection's Welcome said (Welcome.browser). Turning it off stops the browser
// at once when no session holds it, else when the holder's lease ends.
func (b *browserSupervisor) SetOffered(offered bool) {
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.offered = offered
	if offered {
		b.stopAfterTurn = false
		return
	}
	if b.lease != nil {
		b.stopAfterTurn = true
		return
	}
	b.stopLocked("the server no longer offers it")
}

// Offered reports whether the current connection's Welcome offers the browser (false on a runner that has none).
func (b *browserSupervisor) Offered() bool {
	if b == nil {
		return false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.offered
}

// Acquire is one browser tool call by sessionID: it takes the lease when it is free (starting the browser if
// needed), renews it when sessionID already holds it, and is refused with an error naming the holder when another
// session holds it. title is the session's title, shown in that error to other sessions. A session is keyed by its
// public id, so the engine's ORBIT_SESSION_ID and the pool's id name the same holder.
func (b *browserSupervisor) Acquire(sessionID, title string) error {
	if b == nil {
		return errBrowserUnavailable
	}
	sessionID = publicID(sessionID)
	b.mu.Lock()
	defer b.mu.Unlock()
	// Once the server stops offering the browser, only the turn that holds it may go on using it.
	if !b.offered && !(b.stopAfterTurn && b.lease != nil && b.lease.sessionID == sessionID) {
		return errBrowserUnavailable
	}
	if b.signIn != nil {
		return fmt.Errorf("The browser is waiting for the owner to sign in, asked by session %s; try again after they answer", b.signIn.name())
	}
	if b.engineSignIn != "" {
		return errors.New("The browser is in use while the owner signs an engine in on this runner; try again in a few minutes")
	}
	return b.acquireLocked(sessionID, title)
}

// acquireLocked takes or renews sessionID's lease once Acquire's refusals are past.
func (b *browserSupervisor) acquireLocked(sessionID, title string) error {
	if b.lease != nil && b.lease.sessionID != sessionID {
		return fmt.Errorf("The browser is in use by session %s; try again after it finishes", b.lease.name())
	}
	if err := b.ensureStartedLocked(); err != nil {
		return err
	}
	if b.lease == nil {
		b.lease = &browserLease{sessionID: sessionID}
	} else {
		b.lease.timer.Stop()
	}
	if title != "" {
		b.lease.title = title
	}
	lease := b.lease
	lease.timer = b.clock.AfterFunc(browserLeaseIdle, func() { b.expireLease(lease) })
	b.touchLocked()
	return nil
}

// YieldForSignIn is the start of sessionID's sign-in request: it gives up the lease if sessionID holds it (held says
// whether it did) and reserves the browser for the owner until EndSignIn. The browser is not stopped, so its page
// stays. Refused while another session holds the lease or another sign-in is waiting: the owner would sign in under
// someone else's clicks.
func (b *browserSupervisor) YieldForSignIn(sessionID, title string) (held bool, err error) {
	if b == nil {
		return false, errBrowserUnavailable
	}
	sessionID = publicID(sessionID)
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.offered {
		return false, errBrowserUnavailable
	}
	if b.signIn != nil {
		return false, fmt.Errorf("The browser is already waiting for the owner to sign in, asked by session %s; try again after they answer", b.signIn.name())
	}
	if b.engineSignIn != "" {
		return false, errors.New("The browser is in use while the owner signs an engine in on this runner; try again in a few minutes")
	}
	if b.lease != nil && b.lease.sessionID != sessionID {
		return false, fmt.Errorf("The browser is in use by session %s; try again after it finishes", b.lease.name())
	}
	held = b.lease != nil
	if held {
		if title == "" {
			title = b.lease.title
		}
		b.lease.timer.Stop()
		b.lease = nil
	}
	b.signIn = &browserLease{sessionID: sessionID, title: title}
	b.touchLocked()
	b.log("browser: lease released while the owner is asked to sign in")
	return held, nil
}

// EndSignIn ends sessionID's sign-in wait, once the owner answered (or the request could not be filed). With retake the
// session takes the lease back, as Acquire would; an error says why it could not.
func (b *browserSupervisor) EndSignIn(sessionID, title string, retake bool) error {
	if b == nil {
		return errBrowserUnavailable
	}
	sessionID = publicID(sessionID)
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.signIn != nil && b.signIn.sessionID == sessionID {
		if title == "" {
			title = b.signIn.title
		}
		b.signIn = nil
		b.touchLocked()
	}
	if !retake {
		return nil
	}
	if !b.offered && !b.stopAfterTurn {
		return errBrowserUnavailable
	}
	if err := b.acquireLocked(sessionID, title); err != nil {
		return err
	}
	b.log("browser: lease taken back after the owner answered")
	return nil
}

// ReserveForEngineSignIn starts the browser for the owner's engine sign-in (attempt names it) and keeps every
// session's browser call out until EndEngineSignIn: the owner's clicks and an agent's must not land in each other.
// The session holding the lease keeps it; its calls wait. The owner is never refused, so a newer attempt simply
// takes the reservation over.
func (b *browserSupervisor) ReserveForEngineSignIn(attempt string) error {
	if b == nil {
		return errBrowserUnavailable
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.offered || b.stopAfterTurn {
		return errBrowserUnavailable
	}
	if err := b.ensureStartedLocked(); err != nil {
		return err
	}
	b.engineSignIn = attempt
	b.touchLocked()
	b.log("browser: reserved while the owner signs an engine in")
	return nil
}

// EndEngineSignIn ends attempt's reservation, if it is still the one held.
func (b *browserSupervisor) EndEngineSignIn(attempt string) {
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.engineSignIn == "" || b.engineSignIn != attempt {
		return
	}
	b.engineSignIn = ""
	b.touchLocked()
	b.log("browser: the owner's engine sign-in ended")
}

// KeepSignInTab keeps the browser from stopping for idleness while tab, the tab of an engine sign-in that did not
// succeed, is open.
func (b *browserSupervisor) KeepSignInTab(tab string) {
	if b == nil || tab == "" {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.procs == nil {
		return // stopped already: the tab is gone
	}
	if b.keptTabs == nil {
		b.keptTabs = map[string]bool{}
	}
	b.keptTabs[tab] = true
	b.touchLocked()
	b.log("browser: kept running while a sign-in that did not succeed has its tab open")
}

// KeepsSignInTab is whether tab still keeps the browser running.
func (b *browserSupervisor) KeepsSignInTab(tab string) bool {
	if b == nil {
		return false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.keptTabs[tab]
}

// ReleaseSignInTabs lets the browser stop for idleness again despite tabs ("" or none: every kept tab).
func (b *browserSupervisor) ReleaseSignInTabs(tabs ...string) {
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.keptTabs) == 0 {
		return
	}
	if len(tabs) == 0 {
		b.keptTabs = nil
	}
	for _, tab := range tabs {
		delete(b.keptTabs, tab)
	}
	b.touchLocked()
}

// SignInWaiting is the session waiting for the owner to sign in ("" when none).
func (b *browserSupervisor) SignInWaiting() string {
	if b == nil {
		return ""
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.signIn == nil {
		return ""
	}
	return b.signIn.sessionID
}

// Release ends sessionID's lease, if it holds it: at the end of its turn, or when the session ends.
func (b *browserSupervisor) Release(sessionID string) {
	if b == nil {
		return
	}
	sessionID = publicID(sessionID)
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.lease != nil && b.lease.sessionID == sessionID {
		b.releaseLocked()
	}
}

// Holder is the session holding the lease ("" when free).
func (b *browserSupervisor) Holder() string {
	if b == nil {
		return ""
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.lease == nil {
		return ""
	}
	return b.lease.sessionID
}

// Open starts the browser for the owner (Open browser) without taking the lease.
func (b *browserSupervisor) Open() error {
	if b == nil {
		return errBrowserUnavailable
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.offered || b.stopAfterTurn {
		return errBrowserUnavailable
	}
	if err := b.ensureStartedLocked(); err != nil {
		return err
	}
	b.touchLocked()
	return nil
}

// ViewerOpened counts one open viewer stream; the browser does not stop for idleness while one is open. The returned
// func closes it (once).
func (b *browserSupervisor) ViewerOpened() (closed func()) {
	if b == nil {
		return func() {}
	}
	b.mu.Lock()
	b.viewers++
	if b.idle != nil {
		b.idle.Stop()
		b.idle = nil
	}
	b.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			b.mu.Lock()
			defer b.mu.Unlock()
			b.viewers--
			b.touchLocked()
		})
	}
}

// Viewers is how many viewer streams are open.
func (b *browserSupervisor) Viewers() int {
	if b == nil {
		return 0
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.viewers
}

// Running reports whether the browser's programs are started.
func (b *browserSupervisor) Running() bool {
	if b == nil {
		return false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.procs != nil
}

// ClearProfile is the owner's Clear saved logins (docs/runner-browser-design.md §5, §6; HeartbeatResponse.
// ClearBrowserProfile): it stops the browser, whoever holds it and whatever viewers are open, and deletes its profile,
// with every cookie and saved login in it. A session that holds the lease keeps it: its next browser call starts a
// browser on a new, empty profile. Done whether or not the server offers the browser now.
func (b *browserSupervisor) ClearProfile() error {
	if b == nil {
		return errBrowserUnavailable
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.stopLocked("the owner cleared its saved logins")
	if err := os.RemoveAll(b.ProfileDir()); err != nil {
		return fmt.Errorf("The saved logins could not be cleared: %w", err)
	}
	b.clearedAt = b.clock.Now()
	b.log("browser: saved logins cleared,", b.ProfileDir(), "deleted")
	return nil
}

// BrowserReport mirrors @orbit/shared RunnerBrowserReport: the browser as each heartbeat reports it.
type BrowserReport struct {
	Running          bool   `json:"running"`
	HolderSessionID  string `json:"holderSessionId,omitempty"`
	HolderTitle      string `json:"holderTitle,omitempty"`
	Viewers          int    `json:"viewers"`
	ProfileClearedAt string `json:"profileClearedAt,omitempty"`
	// SavedLogins: the profile holds a cookie store, so saved logins may exist. A boolean only: which sites they are
	// for is never read, reported or logged.
	SavedLogins bool `json:"savedLogins"`
}

// Report is what the next heartbeat says of the browser: nil on a runner that has none.
func (b *browserSupervisor) Report() *BrowserReport {
	if b == nil {
		return nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	r := &BrowserReport{Running: b.procs != nil, Viewers: b.viewers}
	if b.lease != nil {
		r.HolderSessionID, r.HolderTitle = b.lease.sessionID, b.lease.title
	}
	if !b.clearedAt.IsZero() {
		r.ProfileClearedAt = b.clearedAt.UTC().Format(time.RFC3339Nano)
	}
	r.SavedLogins = b.savedLoginsLocked()
	return r
}

// browserCookieStores are where Chrome keeps a profile's cookies, newest layout first: what a login leaves behind.
var browserCookieStores = []string{
	filepath.Join("Default", "Network", "Cookies"),
	filepath.Join("Default", "Cookies"),
}

// savedLoginsLocked reports whether the profile holds a non-empty cookie store. Only the files' sizes are read, never
// their contents: which sites are signed in is not this runner's to say.
func (b *browserSupervisor) savedLoginsLocked() bool {
	for _, rel := range browserCookieStores {
		if info, err := os.Stat(filepath.Join(b.ProfileDir(), rel)); err == nil && info.Mode().IsRegular() && info.Size() > 0 {
			return true
		}
	}
	return false
}

func (l *browserLease) name() string {
	if l.title == "" {
		return l.sessionID
	}
	return strconv.Quote(l.title) + " (" + l.sessionID + ")"
}

func (b *browserSupervisor) expireLease(lease *browserLease) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.lease == lease {
		b.releaseLocked()
	}
}

func (b *browserSupervisor) releaseLocked() {
	b.lease.timer.Stop()
	b.lease = nil
	if b.stopAfterTurn {
		b.stopLocked("the server no longer offers it")
	}
}

// touchLocked restarts the idle clock: browserIdleStop from now, unless a viewer is open.
func (b *browserSupervisor) touchLocked() {
	if b.idle != nil {
		b.idle.Stop()
		b.idle = nil
	}
	// Nor while the owner is asked to sign in: the page the agent was on waits for them.
	if b.procs == nil || b.viewers > 0 || b.signIn != nil || b.engineSignIn != "" || len(b.keptTabs) > 0 {
		return
	}
	var t poolTimer
	t = b.clock.AfterFunc(browserIdleStop, func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		if b.idle != t || b.viewers > 0 || b.signIn != nil || b.engineSignIn != "" || len(b.keptTabs) > 0 {
			return
		}
		b.idle = nil
		b.stopLocked("idle for 15 minutes")
	})
	b.idle = t
}

func (b *browserSupervisor) ensureStartedLocked() error {
	if b.procs != nil {
		alive := true
		for _, p := range b.procs {
			if p.Exited() {
				alive = false
			}
		}
		if alive {
			return nil
		}
		b.stopLocked("one of its programs ended")
	}
	b.starter.Reap()
	if err := b.prepareStateLocked(); err != nil {
		return fmt.Errorf("The browser could not start: %w", err)
	}
	type step struct {
		name string
		args []string
		wait bool
	}
	steps := []step{
		{browserXvfbBinary, []string{browserDisplay, "-screen", "0", browserScreen, "-nolisten", "tcp"}, true},
		// -noprimary: only what is copied (CLIPBOARD) goes back to the viewer's clipboard, not every selection.
		{browserX11vncBinary, []string{"-display", browserDisplay, "-unixsock", b.VNCSocket(), "-rfbport", "0", "-shared", "-forever", "-nopw", "-quiet", "-noprimary"}, false},
		{browserChromeBinary, b.chromeArgs(), false},
	}
	var started []browserProcess
	for _, s := range steps {
		p, err := b.starter.Start(s.name, s.args)
		if err == nil && s.wait {
			if err = b.starter.WaitDisplay(browserDisplay); err != nil {
				p.Stop()
			}
		}
		if err != nil {
			for i := len(started) - 1; i >= 0; i-- {
				started[i].Stop()
			}
			b.starter.Reap()
			return fmt.Errorf("The browser could not start: %s: %w", s.name, err)
		}
		started = append(started, p)
	}
	b.procs = started
	for i, p := range started {
		go b.watchProgram(p, i)
	}
	b.log("browser: started")
	return nil
}

// chromeArgs is Chrome's command line on the browser's display: --no-sandbox, because the container is the boundary
// (§3), with --test-type so it does not draw its "unsupported command-line flag" bar over the page for it, which the
// owner would otherwise see in every viewer.
func (b *browserSupervisor) chromeArgs() []string {
	return []string{
		"--no-sandbox", "--test-type", "--disable-dev-shm-usage",
		"--user-data-dir=" + b.ProfileDir(),
		"--remote-debugging-address=" + browserDevToolsHost,
		"--remote-debugging-port=" + strconv.Itoa(browserDevToolsPort),
		"--no-first-run", "--no-default-browser-check", "--window-position=0,0", "--window-size=1280,800",
	}
}

// watchProgram waits for one of the browser's programs to end on its own. Chrome ending is what closing its last tab
// or window does (Chromium quits with its last window): while a viewer is open, Chrome alone starts again on the
// display and VNC server still running, so the viewer's stream stays open and draws the new window instead of the
// black display it would otherwise keep. With no viewer the programs have no one to serve, so they stop and the next
// Open or browser call starts them together. The identity check keeps a program that stopLocked ended, or one
// restartChromeLocked replaced, from acting on its successor.
func (b *browserSupervisor) watchProgram(p browserProcess, index int) {
	<-p.Done()
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.procs == nil || index >= len(b.procs) || b.procs[index] != p {
		return
	}
	if index == browserProgramChrome && b.viewers > 0 && !b.procs[browserProgramXvfb].Exited() && !b.procs[browserProgramVNC].Exited() {
		b.restartChromeLocked()
		return
	}
	b.stopLocked("one of its programs ended")
}

// restartChromeLocked starts Chrome again after it ended on its own, without touching the display and VNC server:
// the viewer's stream names the VNC socket, and that socket outlives the browser it was started with.
func (b *browserSupervisor) restartChromeLocked() {
	if err := b.clearChromeLocksLocked(); err != nil {
		b.stopLocked("its browser ended and could not be started again")
		return
	}
	p, err := b.starter.Start(browserChromeBinary, b.chromeArgs())
	if err != nil {
		b.stopLocked("its browser ended and could not be started again")
		return
	}
	b.procs[browserProgramChrome] = p
	b.keptTabs = nil // the new Chrome has none of the old one's tabs
	go b.watchProgram(p, browserProgramChrome)
	b.log("browser: chrome ended, started it again for the open viewer")
}

// prepareStateLocked makes the profile directory and clears what a previous Chrome or x11vnc left: the VNC socket
// and Chrome's singleton lock, which names the host (a new Pod) and would make Chrome refuse the profile.
func (b *browserSupervisor) prepareStateLocked() error {
	if err := os.MkdirAll(b.ProfileDir(), 0o700); err != nil {
		return err
	}
	if err := os.Remove(b.VNCSocket()); err != nil && !os.IsNotExist(err) {
		return err
	}
	return b.clearChromeLocksLocked()
}

// clearChromeLocksLocked removes Chrome's singleton files: its lock names the host, which a restarted Chrome on a new
// Pod would refuse the profile over, and a restarted Chrome on the same Pod would find stale.
func (b *browserSupervisor) clearChromeLocksLocked() error {
	for _, name := range []string{"SingletonLock", "SingletonSocket", "SingletonCookie"} {
		p := filepath.Join(b.ProfileDir(), name)
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

func (b *browserSupervisor) stopLocked(why string) {
	if b.idle != nil {
		b.idle.Stop()
		b.idle = nil
	}
	if b.procs == nil {
		return
	}
	for i := len(b.procs) - 1; i >= 0; i-- {
		b.procs[i].Stop()
	}
	b.procs = nil
	b.keptTabs = nil
	b.starter.Reap()
	b.log("browser: stopped,", why)
}
