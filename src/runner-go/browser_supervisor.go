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
	if b.procs == nil || b.viewers > 0 {
		return
	}
	var t poolTimer
	t = b.clock.AfterFunc(browserIdleStop, func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		if b.idle != t || b.viewers > 0 {
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
		{browserX11vncBinary, []string{"-display", browserDisplay, "-unixsock", b.VNCSocket(), "-rfbport", "0", "-shared", "-forever", "-nopw", "-quiet"}, false},
		{browserChromeBinary, []string{
			"--no-sandbox", "--disable-dev-shm-usage",
			"--user-data-dir=" + b.ProfileDir(),
			"--remote-debugging-address=" + browserDevToolsHost,
			"--remote-debugging-port=" + strconv.Itoa(browserDevToolsPort),
			"--no-first-run", "--no-default-browser-check", "--window-position=0,0", "--window-size=1280,800",
		}, false},
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
	b.log("browser: started")
	return nil
}

// prepareStateLocked makes the profile directory and clears what a previous Chrome or x11vnc left: the VNC socket
// and Chrome's singleton lock, which names the host (a new Pod) and would make Chrome refuse the profile.
func (b *browserSupervisor) prepareStateLocked() error {
	if err := os.MkdirAll(b.ProfileDir(), 0o700); err != nil {
		return err
	}
	for _, p := range []string{
		b.VNCSocket(),
		filepath.Join(b.ProfileDir(), "SingletonLock"),
		filepath.Join(b.ProfileDir(), "SingletonSocket"),
		filepath.Join(b.ProfileDir(), "SingletonCookie"),
	} {
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
	b.starter.Reap()
	b.log("browser: stopped,", why)
}
