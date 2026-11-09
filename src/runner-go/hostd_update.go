package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// The update verb: one machine, one binary, one place that replaces it.
//
// The machine-level binary, /usr/local/bin/orbit, is one no unprivileged account can write: the
// broker runs it as root, and on a host set up before instances were named after accounts every
// user's runner execs it too. A runner that cannot install a release where it runs from (selfupdate.go's
// warnSelfUpdateBlocked) asks the broker — the one process on the machine that *can* write that file
// — to install it once and roll the instances, so a host with ten such users updates once rather
// than ten times or never. A runner on its account's own ~/.orbit/bin/orbit updates itself, and
// then asks once too (askHostdToFollow), so that hostd's own binary follows the release; on a host
// whose instances run those copies, the verb restarts no runner.
//
// Four rules shape the whole file:
//
//   - The caller supplies nothing. Not a URL, not an artifact, not even a version: the control
//     plane comes from /etc/orbit/config.json, which only root can write. A client that could
//     name what a root daemon downloads and executes would *be* root.
//   - The release is the one /dl publishes to every runner, read without a credential. A binary
//     every account on the machine execs is not one runner's to pick, so no runner's staged-rollout
//     assignment decides it — not the caller's, and not that of a runner root may have registered
//     for itself, whose token the runner-side check (publishedManifest) would find and send.
//   - It is checked by the one chain every install passes (installRelease): the manifest's
//     sha256, then the version and the write contract the download reports.
//   - The download is never run as root. Reporting its version and its contract means executing
//     it, so every one of those execs is dropped to the uid that asked (SysProcAttr.Credential).
//
// And only the machine's own binary is replaced: the file orbit-hostd.service's ExecStart= names,
// when it is a regular file only root can write, in directories only root can write all the way up
// to / (checkMachineBinary). A link into an account's ~/.orbit/bin (install_layout.go) is that
// account's install, which its runner updates itself, and root writes nothing it downloaded into
// somebody's home.
//
// hostd does not restart itself afterwards and does not need to: the socket unit owns the
// listening socket, hostd exits once the machine goes quiet (hostdIdleTimeout), and the next
// connection activates a fresh process — from the file this verb just replaced.

const (
	// Every runner on the machine asks on its own schedule and they all mean the same release, so
	// the first ask does the work and the rest are told it just happened. It is also the backstop
	// that keeps a caller in a loop from making root download.
	hostdUpdateInterval = 5 * time.Minute
	// The rate limiter's state, kept as a file because hostd exits whenever the machine goes quiet
	// — anything held in memory would rate-limit nothing. In /run so a reboot starts clean rather
	// than from a stale answer.
	hostdUpdateStampPath = "/run/orbit/last-update"
	// The instances to roll once the new binary is in place: what `orbit host setup` installs,
	// and nothing else on the machine.
	hostdRunnerUnitPattern = "orbit-runner@*"
)

// hostdUpdateMu makes the rate limit hold for callers that arrive together — every runner on a
// machine that booted a minute ago checks at the same moment. Without it each would read "no
// update ran" before the first had stamped, and all of them would download.
var hostdUpdateMu sync.Mutex

// hostdUpdate is the verb's environment — everything it reaches outside its own process, injected
// so the tests drive this very logic against a fake systemctl, a temporary install directory and
// an httptest release server. The zero value means production defaults.
type hostdUpdate struct {
	sys             hostdSystem
	configPath      string // "" → hostConfigPath
	serviceUnitPath string // "" → hostdServiceUnitPath
	stampPath       string // "" → hostdUpdateStampPath
	now             func() time.Time
	geteuid         func() int
	// rootUID is who the binary and every directory above it must belong to: root. A field because a
	// test cannot create files root owns, so it names the uid that stands for root's instead.
	rootUID uint32
	// rootDir is where that walk up from the binary ends: "/". A field for the same reason: a test's
	// binary sits in a temporary directory, above which nothing is the test's.
	rootDir string // "" → "/"
	// runProbe executes the downloaded binary — a command probeCmd already built, already
	// dropped to the caller's uid — and returns its standard output.
	runProbe func(*exec.Cmd) ([]byte, error)
	// background runs the install after the caller has been answered. Injected so a test
	// observes finished side effects instead of sleeping for them.
	background func(func())
}

func (u hostdUpdate) withDefaults() hostdUpdate {
	if u.configPath == "" {
		u.configPath = hostConfigPath
	}
	if u.serviceUnitPath == "" {
		u.serviceUnitPath = hostdServiceUnitPath
	}
	if u.stampPath == "" {
		u.stampPath = hostdUpdateStampPath
	}
	if u.rootDir == "" {
		u.rootDir = "/"
	}
	if u.now == nil {
		u.now = time.Now
	}
	if u.geteuid == nil {
		u.geteuid = os.Geteuid
	}
	if u.runProbe == nil {
		u.runProbe = (*exec.Cmd).Output
	}
	if u.background == nil {
		u.background = hostdRunBackground
	}
	return u
}

// verb answers "install the machine's update if there is one". It returns as soon as it knows
// *what* would be installed; the installing itself outlives the connection, because a caller must
// not be held open across a download and a rolling restart of every runner on the host.
func (u hostdUpdate) verb(peer hostdPeer, _ hostdRequest) hostdResponse {
	u = u.withDefaults()

	cred, refusal, ok := u.probeCredential(peer)
	if !ok {
		return refusal
	}
	hostdUpdateMu.Lock()
	defer hostdUpdateMu.Unlock()
	if since, recent := u.recentlyRan(); recent {
		// Idempotent on purpose: ten runners noticing the same release within a minute of each
		// other is the normal case, not the abusive one, and each of them is happy with "it
		// already happened".
		return hostdOK(map[string]any{
			"skipped": true,
			"reason":  fmt.Sprintf("an update ran %s ago", since.Round(time.Second)),
		})
	}
	key := platformKey()
	if key == "" {
		return hostdFail("no orbit release is published for %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	server, err := u.server()
	if err != nil {
		return hostdFail("%v", err)
	}
	// Before installedVersion, which executes the target as root: only once it is known to be
	// root's own file.
	target, err := u.installTarget()
	if err != nil {
		return hostdFail("%v", err)
	}
	current, err := u.installedVersion(target)
	if err != nil {
		return hostdFail("%v", err)
	}
	// /dl/version.json as anybody reads it — never publishedManifest, which asks which release a
	// runner is assigned with the token of whichever runner config it finds.
	m, err := fetchManifest(context.Background(), server, "")
	if err == nil {
		err = manifestProtocolCompatible(m)
	}
	if err != nil {
		return hostdFail("cannot read the release %s publishes: %v", server, err)
	}

	// A public manifest is never a rollback — that is a per-runner assignment — so only a newer
	// release is installed.
	if !isNewer(m.Version, current) {
		return hostdOK(map[string]any{"version": current, "updated": false})
	}

	// Stamped here: after everything that can fail with a reason (a machine with no config or no
	// binary must tell every caller why, not answer "skipped" for five minutes), only once there
	// is a release to install (a machine already on it ran no update, and must not wave off the
	// next caller's real one for five minutes), and before the download rather than after it (the
	// second runner of a stampede has to be waved off while the first is still downloading, not
	// once it has finished).
	u.stamp()
	u.background(func() { u.install(server, key, m, target, cred) })
	return hostdOK(map[string]any{"version": m.Version, "from": current, "accepted": true})
}

// install is the part that runs once the caller has its answer: download, check and swap in the
// release through installRelease — executing the download only as the caller — then, on a host
// still on the uid template (setup not run again since instances were named after accounts),
// whose instances all run this binary, roll the runners. On a host whose instances run each
// account's own copy, no runner is restarted. Nothing is left to return an error to, so every way out of here says why in the
// journal.
func (u hostdUpdate) install(server, key string, m Manifest, target string, cred hostdProbeCred) {
	logf := func(s string) { hostdLogf("update to orbit %s: %s", m.Version, strings.TrimSpace(s)) }
	if !installRelease(server, key, m, target, u.probeAs(cred), logf) {
		hostdLogf("update to orbit %s failed; %s is unchanged and no runner was restarted", m.Version, target)
		return
	}
	if u.sys.namesInstances() {
		// Every instance runs its account's own ~/.orbit/bin/orbit, which that account's runner
		// updates itself: the file just replaced is hostd's alone, and the next connection
		// activates hostd from it. A restart here would tear live sessions down for nothing.
		hostdLogf("installed orbit %s at %s (verified as uid %d); no runner restarted: each runs its account's own copy", m.Version, target, cred.uid)
		return
	}
	hostdLogf("installed orbit %s at %s (verified as uid %d); restarting this machine's runners", m.Version, target, cred.uid)
	u.restartRunners()
}

// restartRunners rolls every runner instance onto the binary that was just installed. One at a
// time, deliberately: each instance drains its live sessions when it is stopped (the template's
// KillMode=mixed and TimeoutStopSec=180 are what give it the room), and restarting the whole
// machine at once would take every user's sessions down together. A failure is logged and the
// roll goes on — one wedged instance must not pin the others to the old binary.
func (u hostdUpdate) restartRunners() {
	for _, unit := range u.runnerUnits() {
		if err := u.sys.systemctl("restart", unit); err != nil {
			hostdLogf("%v", err)
		}
	}
}

// runnerUnits asks systemd which runner instances this machine actually has, rather than
// deriving them from /etc/passwd: the instances that exist are the ones systemd knows about, and
// a machine mid-migration has accounts with no instance and instances whose account is gone.
func (u hostdUpdate) runnerUnits() []string {
	out, err := u.sys.query("systemctl", "list-units", "--type=service", "--no-legend", "--plain", "--no-pager", hostdRunnerUnitPattern)
	if err != nil {
		hostdLogf("cannot list this machine's runner units: %v", err)
		return nil
	}
	var units []string
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		// The pattern above is ours, but the parsing is not: only names that really are an
		// instance of the runner template get restarted.
		if name := fields[0]; strings.HasPrefix(name, "orbit-runner@") && strings.HasSuffix(name, ".service") {
			units = append(units, name)
		}
	}
	return units
}

// hostdProbeCred is who the download's probes run as: never root, always the account that asked
// for the update.
type hostdProbeCred struct {
	uid, gid uint32
	username string
}

// probeCredential decides who will execute the downloaded file, or returns the refusal to send
// back instead. Both refusals are one rule seen from two sides — the probe runs as a real,
// unprivileged account, or it does not run.
func (u hostdUpdate) probeCredential(peer hostdPeer) (hostdProbeCred, hostdResponse, bool) {
	uid := strconv.FormatUint(uint64(peer.UID), 10)
	acct, err := u.sys.lookupUID(uid)
	if err != nil {
		return hostdProbeCred{}, hostdFail("uid %s has no account on this machine: %v", uid, err), false
	}
	gid, err := strconv.ParseUint(acct.Gid, 10, 32)
	if err != nil {
		return hostdProbeCred{}, hostdFail("cannot read the primary group of uid %s: %v", uid, err), false
	}
	if u.geteuid() == 0 && peer.UID == 0 {
		return hostdProbeCred{}, hostdFail("refusing to update on behalf of uid 0: verifying a download means running it, and dropping root to root drops nothing. Ask from the unprivileged account whose runner needs the new binary — root can still run `orbit upgrade` itself."), false
	}
	return hostdProbeCred{uid: peer.UID, gid: uint32(gid), username: acct.Username}, hostdResponse{}, true
}

// probeAs is the releaseProbe hostd checks a download with: installRelease decides what to ask the
// download, and every exec of it that asking takes is the caller's, never this daemon's.
func (u hostdUpdate) probeAs(cred hostdProbeCred) releaseProbe {
	return func(path string, args ...string) ([]byte, error) {
		cmd, err := u.probeCmd(cred, path, args...)
		if err != nil {
			hostdLogf("not running %s: %v", path, err)
			return nil, err
		}
		return u.runProbe(cmd)
	}
}

// probeCmd builds one command that runs the downloaded file, as the caller. Asking a binary what
// it is remains the cheapest way to find out whether the bytes we fetched are a working orbit of
// the release we were promised — and it is still an exec of a file off the network, which is why
// it happens as an unprivileged user and not as this daemon.
func (u hostdUpdate) probeCmd(cred hostdProbeCred, path string, args ...string) (*exec.Cmd, error) {
	cmd := exec.Command(path, args...)
	if u.geteuid() != 0 {
		// Not root, so there is nothing to drop: the probe already runs with exactly the
		// privileges this process has, which on a foreground hostd are the caller's own.
		return cmd, nil
	}
	if err := hostdDropTo(cmd, cred.uid, cred.gid); err != nil {
		return nil, err
	}
	return cmd, nil
}

// server reads which control plane this machine belongs to. Root writes this file (`orbit host
// setup --server <url>`) and it is the only place the URL may come from: a URL taken from a
// request body would let any local user point root's downloader at a server of their choosing,
// which is the whole attack this design exists to close.
func (u hostdUpdate) server() (string, error) {
	data, err := os.ReadFile(u.configPath)
	if err != nil {
		return "", fmt.Errorf("cannot read %s: %v — has `orbit host setup --server <url>` been run on this machine?", u.configPath, err)
	}
	var cfg struct {
		Server string `json:"server"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return "", fmt.Errorf("cannot parse %s: %v", u.configPath, err)
	}
	server := strings.TrimRight(strings.TrimSpace(cfg.Server), "/")
	if server == "" {
		return "", fmt.Errorf("%s names no server", u.configPath)
	}
	return server, nil
}

// installTarget is the binary this verb replaces: the one orbit-hostd.service's ExecStart= runs,
// which is the machine's and, on a host set up before instances were named after accounts, every
// instance's too. Not the runner template's ExecStart=, which names /bin/sh on a host whose
// instances run each account's own copy, and not os.Executable() — hostd may be running from an
// image of a file that has already been swapped, and what matters is the file the next activation
// execs. It has to be the machine's (checkMachineBinary, the rule `orbit host setup` held it to
// before naming it there). Anything else — a symlink into an account's ~/.orbit/bin above all — is
// refused before anything is downloaded, written or executed.
func (u hostdUpdate) installTarget() (string, error) {
	def, err := readSystemdServiceDef(u.serviceUnitPath)
	if err != nil {
		return "", fmt.Errorf("cannot read %s: %v — has `orbit host setup --server <url>` been run on this machine?", u.serviceUnitPath, err)
	}
	path := def.program
	if path == "" {
		return "", fmt.Errorf("%s names no binary in ExecStart=", u.serviceUnitPath)
	}
	if err := checkMachineBinary(path, u.rootDir, u.rootUID); err != nil {
		var fault *machineBinaryError
		if !errors.As(err, &fault) {
			return "", fmt.Errorf("cannot inspect %s, the binary %s runs: %v", path, u.serviceUnitPath, err)
		}
		return "", fmt.Errorf("refusing to update %s: %v, and root writes nothing it downloaded where another account can reach", path, fault)
	}
	return path, nil
}

// machineBinaryError is what makes a file unfit to be the machine's binary: every part of
// checkMachineBinary's rule it breaks, nearest the file first.
type machineBinaryError struct {
	reasons []string
	// foreign is the file or directory that is not root's at all — another account's, a symlink, or
	// a sticky directory anyone may write, like /tmp — where the walk stopped. Taking write access
	// back cannot fix that; a copy somewhere else can.
	foreign string
	// writable is every level root owns but its group or others can write, nearest the file first:
	// what chmod has to take back. othersWrite says one of them is writable by others too.
	writable    []string
	othersWrite bool
}

func (e *machineBinaryError) Error() string { return strings.Join(e.reasons, "; ") }

// checkMachineBinary is the rule for the binary orbit-hostd.service's ExecStart= names, which hostd
// runs as root: `orbit host setup` holds the binary it is about to name there to it, and the update
// verb the binary it is about to replace. No account may be able to change that file, so it has to
// be a regular file root owns that neither its group nor others can write — and so does every
// directory above it, from its own up to top ("/" on a machine), since whoever can write one of
// them can swap out everything below it.
//
// It returns nil when path keeps the rule, a *machineBinaryError saying how it does not, or the
// error that kept a level from being inspected. rootUID is root's uid; a parameter, like top,
// because a test can create neither files root owns nor ones under the machine's real directories.
func checkMachineBinary(path, top string, rootUID uint32) error {
	fi, err := os.Lstat(path)
	if err != nil {
		return err
	}
	e := &machineBinaryError{}
	refuse := func(at, reason string) error {
		e.foreign = at
		e.reasons = append(e.reasons, reason)
		return e
	}
	writable := func(at string, perm os.FileMode, reason string) {
		e.writable = append(e.writable, at)
		e.othersWrite = e.othersWrite || perm&0o002 != 0
		e.reasons = append(e.reasons, reason)
	}

	owner, ok := fileOwnerUID(fi)
	switch perm := fi.Mode().Perm(); {
	case fi.Mode()&os.ModeSymlink != 0:
		dest, _ := os.Readlink(path)
		return refuse(path, fmt.Sprintf("it is a symlink to %s", dest))
	case !fi.Mode().IsRegular():
		return refuse(path, "it is not a regular file")
	case !ok || owner != rootUID:
		return refuse(path, fmt.Sprintf("it belongs to uid %d rather than root", owner))
	case perm&0o022 != 0:
		writable(path, perm, fmt.Sprintf("its group or others can write it (mode %04o)", perm))
	}
	for dir := filepath.Dir(path); ; dir = filepath.Dir(dir) {
		which := dir + ", a directory above it,"
		if dir == filepath.Dir(path) {
			which = "its directory " + dir
		}
		di, err := os.Lstat(dir)
		if err != nil {
			return err
		}
		owner, ok := fileOwnerUID(di)
		switch perm := di.Mode().Perm(); {
		case !di.IsDir():
			// Only a symlink can stand above a file and not be a directory.
			dest, _ := os.Readlink(dir)
			return refuse(dir, fmt.Sprintf("%s is a symlink to %s", which, dest))
		case di.Mode()&os.ModeSticky != 0 && perm&0o002 != 0:
			return refuse(dir, fmt.Sprintf("%s is a shared directory anyone can write (mode 1%03o)", which, perm))
		case !ok || owner != rootUID:
			return refuse(dir, fmt.Sprintf("%s is not root's alone (owned by uid %d, mode %04o)", which, owner, perm))
		case perm&0o022 != 0:
			writable(dir, perm, fmt.Sprintf("%s is not root's alone (owned by uid %d, mode %04o)", which, owner, perm))
		}
		if dir == top || dir == filepath.Dir(dir) {
			break
		}
	}
	if len(e.reasons) > 0 {
		return e
	}
	return nil
}

// fileOwnerUID is the uid that owns fi's file.
func fileOwnerUID(fi os.FileInfo) (uint32, bool) {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return st.Uid, true
}

// installedVersion asks the binary on disk what it is. Not this process's own `version`: hostd
// is an image of a file that updates replace underneath it, and the version that matters is the
// one the next activation will exec. Executing it is safe in a way executing the download is not —
// installTarget has established it is the copy root installed and owns.
func (u hostdUpdate) installedVersion(target string) (string, error) {
	out, err := u.sys.query(target, "version")
	if err != nil {
		return "", fmt.Errorf("cannot ask %s its version: %v", target, err)
	}
	v := strings.TrimSpace(out)
	if v == "" {
		return "", fmt.Errorf("%s reported no version", target)
	}
	return v, nil
}

// recentlyRan reports how long ago the last update ran and whether that is recent enough to
// answer this request with "already done".
func (u hostdUpdate) recentlyRan() (time.Duration, bool) {
	info, err := os.Stat(u.stampPath)
	if err != nil {
		return 0, false
	}
	since := u.now().Sub(info.ModTime())
	// A stamp from the future is a clock that moved, not a rate limit: let the update through
	// rather than blocking on a timestamp that may never age.
	return since, since >= 0 && since < hostdUpdateInterval
}

// stamp records that an update ran now. The content is for whoever reads the file; the mtime is
// what the rate limiter uses, and writing the bytes is what updates it. Best-effort: a machine
// whose /run cannot be written has larger problems than an unthrottled update, and refusing to
// update over it would make the smaller one worse.
func (u hostdUpdate) stamp() {
	if err := os.MkdirAll(filepath.Dir(u.stampPath), 0o755); err != nil {
		return
	}
	_ = os.WriteFile(u.stampPath, []byte(u.now().UTC().Format(time.RFC3339)+"\n"), 0o644)
}

// hostdLogf is the update's only voice. The work happens after the caller has been answered, so
// hostd's stdout — the broker unit's journal — is where its outcome lives.
func hostdLogf(format string, a ...any) {
	logln(fmt.Sprintf(format, a...))
}
