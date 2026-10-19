package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// platformKey maps this host to the published artifact suffix, or "" if unsupported.
func platformKey() string {
	var osName string
	switch runtime.GOOS {
	case "linux":
		osName = "linux"
	case "darwin":
		osName = "darwin"
	default:
		return ""
	}
	switch runtime.GOARCH {
	case "amd64":
		return osName + "-x64"
	case "arm64":
		return osName + "-arm64"
	default:
		return ""
	}
}

func isNewer(remote, local string) bool {
	r := splitVer(remote)
	l := splitVer(local)
	for i := 0; i < len(r) || i < len(l); i++ {
		a, b := 0, 0
		if i < len(r) {
			a = r[i]
		}
		if i < len(l) {
			b = l[i]
		}
		if a != b {
			return a > b
		}
	}
	return false
}

// elevateUpgrade re-runs `orbit upgrade` under sudo (which prompts for the
// password) and exits with its status.
func elevateUpgrade(exe string) {
	sudo, err := exec.LookPath("sudo")
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot write to the install directory; re-run orbit upgrade as root.")
		os.Exit(1)
	}
	fmt.Println("Updating orbit needs elevated permissions — you may be prompted for your password.")
	cmd := exec.Command(sudo, append([]string{exe}, os.Args[1:]...)...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		os.Exit(1)
	}
	os.Exit(0)
}

// osExecutable is os.Executable, a var so a test can run this binary from a symlinked
// install.
var osExecutable = os.Executable

// resolvedExecutable returns this process's binary with symlinks resolved — the
// path an update replaces, and whose directory must be writable to do so. With
// install.sh's layout that is ~/.orbit/bin/orbit, not the /usr/local/bin/orbit
// symlink to it.
func resolvedExecutable() (string, error) {
	exe, err := osExecutable()
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return exe, nil
}

// selfUpdateInstallable reports the install directory and whether an update
// could actually be swapped into it. A runner installed under a root-owned
// directory (the common `/usr/local/bin` case) can download a release but never
// replace itself, so "a newer release exists" is not on its own a reason to
// restart. A package var so tests can simulate an unwritable install.
var selfUpdateInstallable = func() (string, bool) {
	exe, err := resolvedExecutable()
	if err != nil {
		return "", false
	}
	dir := filepath.Dir(exe)
	return dir, writable(dir)
}

var selfUpdateBlockedOnce sync.Once

// warnSelfUpdateBlocked reports the one condition that otherwise pins a runner
// to an old release with no trace. Logged once per process: it is a standing
// state, not an event, and the check that finds it repeats every
// selfUpdateCheckInterval.
func warnSelfUpdateBlocked(remote, dir string) {
	selfUpdateBlockedOnce.Do(func() {
		logln(fmt.Sprintf("orbit %s available but cannot be installed: %s is not writable by this user; "+
			"staying on %s — run `sudo orbit upgrade`", remote, dir, version))
	})
}

// writable reports whether we can create files in dir (i.e. swap the binary there).
func writable(dir string) bool {
	f, err := os.CreateTemp(dir, ".orbit-wtest-")
	if err != nil {
		return false
	}
	name := f.Name()
	_ = f.Close()
	_ = os.Remove(name)
	return true
}

func splitVer(v string) []int {
	parts := strings.Split(v, ".")
	out := make([]int, len(parts))
	for i, p := range parts {
		n, _ := strconv.Atoi(p)
		out[i] = n
	}
	return out
}

// selfUpdateEnabled is shared by the startup updater and the long-running
// runner's periodic update check. Dev binaries and explicitly pinned services
// must neither replace themselves nor drain merely because a release exists.
func selfUpdateEnabled() bool {
	return selfUpdateDisabledReason() == ""
}

// selfUpdateDisabledReason says what turns self-update off on this runner — the reason a
// disabledByEnv report carries — or "" when nothing does.
func selfUpdateDisabledReason() string {
	switch {
	case os.Getenv("ORBIT_NO_SELFUPDATE") != "":
		return "ORBIT_NO_SELFUPDATE is set"
	case version == "dev":
		return "development build"
	case platformKey() == "":
		return "no release is published for " + runtime.GOOS + "/" + runtime.GOARCH
	}
	return ""
}

// The states a runner reports for its updates of itself (SelfUpdateReport.State), mirroring
// @orbit/shared RunnerSelfUpdateState.
const (
	// Nothing stands in the way: the runner is on its assigned release, or about to install it.
	selfUpdateStateEnabled = "enabled"
	// ORBIT_NO_SELFUPDATE, a development build or an unpublished platform (Reason says which).
	selfUpdateStateDisabledByEnv = "disabledByEnv"
	// The install directory is not writable by this user, so no release can ever be swapped in.
	selfUpdateStateDirNotWritable = "dirNotWritable"
	// A release is waiting for the turns in flight to end (updateWhenNoTurnInFlight).
	selfUpdateStateWaitingForIdle = "waitingForIdle"
	// The release check or the install failed; Reason is the runner's own words.
	selfUpdateStateFailed = "failed"
	// A newer release exists, but its staged rollout has not reached this runner yet.
	selfUpdateStateHeldByRollout = "heldByRollout"
)

// selfUpdateStatus is where this runner's updates of itself stand, for the heartbeat: set by the
// update at startup, by every release check, and by the install that follows a drain.
var selfUpdateStatus struct {
	mu                        sync.Mutex
	state, reason, installDir string
}

// noteSelfUpdate records what the latest look at this runner's updates found. An empty installDir
// keeps the one recorded before.
func noteSelfUpdate(state, reason, installDir string) {
	selfUpdateStatus.mu.Lock()
	defer selfUpdateStatus.mu.Unlock()
	selfUpdateStatus.state, selfUpdateStatus.reason = state, reason
	if installDir != "" {
		selfUpdateStatus.installDir = installDir
	}
}

// selfUpdateStateOf is what one release check found. An install directory this user cannot write
// comes first: it blocks every release, the assigned one and any later one, so it is the standing
// answer whether or not one is waiting. Then a check that could not tell which release to run, then
// a rollout holding the runner back. Waiting for a turn is the turn gate's to report, and a disabled
// updater never checks.
func selfUpdateStateOf(installable bool, checkErr error, heldBack bool) (state, reason string) {
	switch {
	case !installable:
		return selfUpdateStateDirNotWritable, ""
	case checkErr != nil:
		return selfUpdateStateFailed, "cannot read the release to install: " + checkErr.Error()
	case heldBack:
		return selfUpdateStateHeldByRollout, ""
	}
	return selfUpdateStateEnabled, ""
}

// selfUpdateReport is HeartbeatRequest.SelfUpdate: the latest state with the last update installed.
// Nil until something has looked, which the control plane stores as "not reported".
func selfUpdateReport() *SelfUpdateReport {
	selfUpdateStatus.mu.Lock()
	state, reason, dir := selfUpdateStatus.state, selfUpdateStatus.reason, selfUpdateStatus.installDir
	selfUpdateStatus.mu.Unlock()
	if state == "" {
		return nil
	}
	last := lastSelfUpdate()
	return &SelfUpdateReport{
		State: state, Reason: reason, InstallDir: dir,
		LastUpdatedAt: last.At, LastUpdatedFrom: last.From, LastUpdatedTo: last.To,
	}
}

// selfUpdateRecord is the last update this runner installed into itself. Kept on disk next to the
// config, because every update ends in a re-exec and it is the image that starts which reports it.
type selfUpdateRecord struct {
	At   string `json:"lastUpdatedAt"`
	From string `json:"lastUpdatedFrom"`
	To   string `json:"lastUpdatedTo"`
}

func selfUpdateRecordPath() string { return filepath.Join(machineHome(), "self-update.json") }

// lastSelfUpdate reads the record; a missing or unreadable one reads as no update yet.
func lastSelfUpdate() selfUpdateRecord {
	var rec selfUpdateRecord
	b, err := os.ReadFile(selfUpdateRecordPath())
	if err != nil || json.Unmarshal(b, &rec) != nil {
		return selfUpdateRecord{}
	}
	return rec
}

// recordSelfUpdate files an installed update. Best-effort, like engineUpdateLog: losing it costs the
// "last updated" line, never the update.
func recordSelfUpdate(from, to string, at time.Time) {
	b, err := json.Marshal(selfUpdateRecord{At: at.UTC().Format(time.RFC3339), From: from, To: to})
	if err != nil {
		return
	}
	if err := os.MkdirAll(machineHome(), machineHomePerm); err != nil {
		return
	}
	if err := os.WriteFile(selfUpdateRecordPath(), b, configFilePerm); err != nil {
		logln("self-update: cannot record the update:", err)
	}
}

// publishedManifest fetches and negotiates the runner release this runner is to run. Keeping
// this read separate from downloadAndSwap lets a live runner cheaply decide whether to drain, and
// makes an incompatible release a no-op rather than a binary swap followed by rejected writes.
//
// /dl publishes the latest release (version.json) and, once one release has replaced another, the
// one it replaced (previous/version.json). A runner registered with server asks it which of the two
// to run (assignedManifest), so a staged rollout can hold it at the previous release and a rollback
// can send it back there. Without a credential for server, or from a control plane older than that
// question, it is the latest.
func publishedManifest(ctx context.Context, server string) (Manifest, error) {
	server = strings.TrimRight(server, "/")
	m, err := fetchManifest(ctx, server, "")
	if err != nil {
		return Manifest{}, err
	}
	if token := runnerTokenFor(server); token != "" {
		if m, err = assignedManifest(ctx, server, token, m); err != nil {
			return Manifest{}, err
		}
	} else {
		recordRolloutHold("")
	}
	if err := manifestProtocolCompatible(m); err != nil {
		return Manifest{}, err
	}
	return m, nil
}

// errNotPublished is fetchManifest finding no manifest at all: /dl/previous/ before any release
// has replaced another.
var errNotPublished = errors.New("not published")

// fetchManifest reads <server>/dl/<dir>version.json, the manifest of the release whose assets sit
// beside it.
func fetchManifest(ctx context.Context, server, dir string) (Manifest, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, server+"/dl/"+dir+"version.json", nil)
	if err != nil {
		return Manifest{}, err
	}
	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return Manifest{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return Manifest{}, fmt.Errorf("/dl/%sversion.json: %w (HTTP 404)", dir, errNotPublished)
	}
	if resp.StatusCode != http.StatusOK {
		return Manifest{}, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var m Manifest
	if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
		return Manifest{}, err
	}
	if m.Version == "" {
		return Manifest{}, fmt.Errorf("empty published version")
	}
	m.dir = dir
	return m, nil
}

// releaseAssignment is the control plane's answer to which of the releases /dl publishes this
// runner is to run (GET /api/runner/release; src/apiserver/src/runner-api/runner-release.ts).
type releaseAssignment struct {
	Version string `json:"version"`
	// The control plane moved its release pointer back to Version: install it although it is older.
	Rollback bool `json:"rollback"`
	// Version is the previous release only because this runner is outside the latest's rollout.
	HeldByRollout bool `json:"heldByRollout"`
}

// assignedManifest asks server which release this runner is to run, of latest and the release
// /dl/previous/ keeps, and returns that one's manifest.
func assignedManifest(ctx context.Context, server, token string, latest Manifest) (Manifest, error) {
	query := url.Values{"latest": {latest.Version}}
	previous, err := fetchManifest(ctx, server, "previous/")
	if err == nil {
		query.Set("previous", previous.Version)
	} else if !errors.Is(err, errNotPublished) {
		return Manifest{}, err
	}
	var assigned releaseAssignment
	err = NewTransport(server, token).do(ctx, http.MethodGet, "/runner/release?"+query.Encode(), nil, &assigned, 8*time.Second)
	if isTransportHTTPStatus(err, http.StatusNotFound) {
		// A control plane older than the question: every runner runs the latest, as before it.
		recordRolloutHold("")
		return latest, nil
	}
	if err != nil {
		return Manifest{}, err
	}
	m := latest
	switch {
	case assigned.Version == latest.Version:
	case previous.Version != "" && assigned.Version == previous.Version:
		m = previous
	default:
		return Manifest{}, fmt.Errorf("the control plane assigned release %q, which /dl does not publish", assigned.Version)
	}
	m.rollback = assigned.Rollback
	if assigned.HeldByRollout && isNewer(latest.Version, version) {
		recordRolloutHold(latest.Version)
	} else {
		recordRolloutHold("")
	}
	return m, nil
}

// runnerTokenFor is the credential this machine registered with at server — the one server alone
// is ever sent — or "" when it registered with none there.
func runnerTokenFor(server string) string {
	cfg := loadConfig()
	if cfg == nil || strings.TrimRight(cfg.ServerURL, "/") != server {
		return ""
	}
	return cfg.RunnerToken
}

// rolloutHeldFrom is the newer release the last release check found withheld from this runner
// only because a staged rollout has not reached it: "" while nothing is.
var rolloutHeldFrom atomic.Pointer[string]

func recordRolloutHold(latest string) { rolloutHeldFrom.Store(&latest) }

// heldByRollout reports whether this runner stays on an older release only because the latest one's
// rollout has not reached it yet, and which release it is held back from — as the last release
// check found it. It is the heldByRollout reason the runner reports for not updating.
func heldByRollout() (string, bool) {
	if latest := rolloutHeldFrom.Load(); latest != nil && *latest != "" {
		return *latest, true
	}
	return "", false
}

var rollbackRefusedOnce sync.Once

// wantsRelease reports whether a runner on local installs m: a newer release always, an older one
// only when the control plane moved its release pointer back to it. Even then never a release that
// predates assigned releases: rolled back to it, a runner would read /dl/version.json at its next
// check and reinstall the release it was rolled back from.
func wantsRelease(m Manifest, local string) bool {
	if isNewer(m.Version, local) {
		return true
	}
	if !m.rollback || !isNewer(local, m.Version) {
		return false
	}
	if !m.RunsAssignedRelease {
		rollbackRefusedOnce.Do(func() {
			logln(fmt.Sprintf("the control plane rolled orbit back to %s, which predates assigned releases "+
				"and would reinstall %s at its next check; staying on %s", m.Version, local, local))
		})
		return false
	}
	return true
}

// availableSelfUpdate reports the release that a running runner should drain
// for: a newer one, or an older one the control plane rolled back to. Errors are
// deliberately silent: the next periodic check will retry and
// ordinary runner work must remain available through a control-plane hiccup.
// An update this process could not install is not reported: draining for one
// tears down live sessions mid-turn every check interval, forever, without the
// version ever changing. What the check found is recorded for the heartbeat
// either way (noteSelfUpdate).
func availableSelfUpdate(ctx context.Context, server string) (string, bool) {
	if !selfUpdateEnabled() {
		return "", false
	}
	m, wanted, dir, installable := checkAssignedRelease(ctx, server)
	if !wanted {
		return "", false
	}
	if !installable {
		warnSelfUpdateBlocked(m.Version, dir)
		return "", false
	}
	return m.Version, true
}

// checkAssignedRelease reads the release this runner is assigned, says whether the runner wants it
// and whether it could swap a release into its install directory, and records what it found for
// the heartbeat — the one place the startup update and every later check both report from.
func checkAssignedRelease(ctx context.Context, server string) (m Manifest, wanted bool, dir string, installable bool) {
	m, err := publishedManifest(ctx, server)
	wanted = err == nil && wantsRelease(m, version)
	dir, installable = selfUpdateInstallable()
	_, held := heldByRollout()
	state, reason := selfUpdateStateOf(installable, err, held && !wanted)
	noteSelfUpdate(state, reason, dir)
	return m, wanted, dir, installable
}

type downloadedCapabilities struct {
	SchemaVersion            int    `json:"schemaVersion"`
	CapabilityRevision       int    `json:"capabilityRevision"`
	ServerCapabilityRevision int    `json:"serverCapabilityRevision"`
	ServerSchemaRevision     int    `json:"serverSchemaRevision"`
	ContractDigest           string `json:"contractDigest"`
}

func downloadedContractMatchesManifest(doc downloadedCapabilities, m Manifest) bool {
	wantCapability, wantSchema, wantDigest := m.CapabilityRevision, m.SchemaRevision, m.ContractDigest
	if wantCapability == 0 && wantSchema == 0 && wantDigest == "" {
		wantCapability, wantSchema, wantDigest = 1, 1, runnerWriteLegacyContractDigest
	}
	gotCapability := doc.ServerCapabilityRevision
	if gotCapability == 0 {
		gotCapability = doc.CapabilityRevision
	}
	gotSchema := doc.ServerSchemaRevision
	if gotSchema == 0 {
		gotSchema = doc.SchemaVersion
	}
	gotDigest := doc.ContractDigest
	if gotCapability == 0 && gotSchema == 1 && gotDigest == "" {
		gotCapability, gotDigest = 1, runnerWriteLegacyContractDigest
	}
	return gotCapability == wantCapability && gotSchema == wantSchema && gotDigest == wantDigest
}

// selfUpdateTarget is the binary downloadAndSwap replaces. A package var so tests swap a scratch
// file rather than the test binary itself.
var selfUpdateTarget = resolvedExecutable

// downloadAndSwap fetches the published binary, verifies it against the manifest's sha256 and then
// both its version and its write contract, then atomically swaps it over the current executable.
// The same check protects automatic upgrade, explicit reinstall and N-1 rollback.
func downloadAndSwap(server, key string, manifest Manifest, logf func(string)) bool {
	ver := manifest.Version
	exe, err := selfUpdateTarget()
	if err != nil {
		logf("cannot locate executable: " + err.Error() + "\n")
		return false
	}
	// Fail fast (before downloading) if we can't write where the binary lives.
	if dir := filepath.Dir(exe); !writable(dir) {
		logf(fmt.Sprintf("cannot write to %s (permission denied) — re-run with: sudo orbit upgrade\n", dir))
		return false
	}

	asset := "orbit-" + key + ".gz"
	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Get(server + "/dl/" + manifest.dir + asset)
	if err != nil {
		logf("download failed: " + err.Error() + "\n")
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		logf(fmt.Sprintf("download failed: HTTP %d\n", resp.StatusCode))
		return false
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		logf("download failed: " + err.Error() + "\n")
		return false
	}
	// No signature on a /dl binary is checked here (a macOS one may carry a Developer ID, which only
	// macOS reads): the manifest's digest is what ties this download to the release it announces.
	// Checked before anything is decompressed or written next to the executable.
	sum := sha256.Sum256(body)
	got, want := hex.EncodeToString(sum[:]), manifest.Assets[key].SHA256
	if want == "" {
		logf(fmt.Sprintf("warning: %sversion.json publishes no sha256 for %s (a control plane older than "+
			"asset digests); installing it unverified\n", manifest.dir, asset))
	} else if !strings.EqualFold(got, want) {
		logf(fmt.Sprintf("downloaded %s has sha256 %s, but %sversion.json publishes %s; keeping current version\n",
			asset, got, manifest.dir, want))
		return false
	}
	gz, err := gzip.NewReader(bytes.NewReader(body))
	if err != nil {
		logf("download failed: " + err.Error() + "\n")
		return false
	}
	defer gz.Close()
	data, _ := io.ReadAll(gz)
	if len(data) < 1_000_000 {
		logf("downloaded file is implausibly small; aborting\n")
		return false
	}

	tmp := fmt.Sprintf("%s.new-%d", exe, os.Getpid())
	if err := os.WriteFile(tmp, data, 0o755); err != nil {
		logf("write failed: " + err.Error() + "\n")
		return false
	}
	giveToDirOwner(tmp, filepath.Dir(exe))

	probe, _ := exec.Command(tmp, "version").Output()
	if strings.TrimSpace(string(probe)) != ver {
		_ = os.Remove(tmp)
		logf("downloaded update failed self-test; keeping current version\n")
		return false
	}
	capabilityProbe, err := exec.Command(tmp, "capabilities", "--json").Output()
	var capabilities downloadedCapabilities
	if err != nil || json.Unmarshal(capabilityProbe, &capabilities) != nil ||
		!downloadedContractMatchesManifest(capabilities, manifest) {
		_ = os.Remove(tmp)
		logf("downloaded update reports a different runner write contract; keeping current version\n")
		return false
	}
	if err := os.Rename(tmp, exe); err != nil {
		_ = os.Remove(tmp)
		logf("replace failed: " + err.Error() + "\n")
		return false
	}
	return true
}

// giveToDirOwner hands a file written as root (`sudo orbit upgrade`) to whoever owns the
// directory it sits in, so the binary in an account's ~/.orbit/bin stays that account's.
func giveToDirOwner(path, dir string) {
	if os.Geteuid() != 0 {
		return
	}
	fi, err := os.Stat(dir)
	if err != nil {
		return
	}
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		_ = os.Lchown(path, int(st.Uid), int(st.Gid))
	}
}

// execCurrentProcess starts a clean runner process image. In particular, it is
// used after a live-update attempt returns so a partially stopped runLoop is
// never reused in-process.
func execCurrentProcess() error {
	exe, err := resolvedExecutable()
	if err != nil {
		return err
	}
	return syscall.Exec(exe, os.Args, os.Environ())
}

// restartIntoUpdate starts the binary selfUpdate just installed. A package var so tests can
// install a release without the test process replacing itself.
var restartIntoUpdate = execCurrentProcess

// selfUpdate silently installs the release this runner is assigned — a newer one, or an older one
// the control plane rolled back to — and re-execs. A dev build (version == "dev") or
// ORBIT_NO_SELFUPDATE disables it; failures never block. Each outcome is recorded for the heartbeat
// (noteSelfUpdate), and an installed update on disk for the image it restarts into.
func selfUpdate(server string) {
	if reason := selfUpdateDisabledReason(); reason != "" {
		dir := ""
		if exe, err := resolvedExecutable(); err == nil {
			dir = filepath.Dir(exe)
		}
		noteSelfUpdate(selfUpdateStateDisabledByEnv, reason, dir)
		return
	}
	key := platformKey()
	server = strings.TrimRight(server, "/")

	manifest, wanted, dir, installable := checkAssignedRelease(context.Background(), server)
	if !wanted {
		return
	}
	if !installable {
		warnSelfUpdateBlocked(manifest.Version, dir)
		return
	}
	remote := manifest.Version

	if isNewer(remote, version) {
		fmt.Printf("orbit %s -> %s: downloading update...\n", version, remote)
	} else {
		fmt.Printf("orbit %s -> %s: the control plane rolled %s back; downloading...\n", version, remote, version)
	}
	// Never swallow the reason: a silent failure here leaves the runner pinned to
	// an old release with nothing in the log but the line above. The last line logged
	// is why it failed, which is what the heartbeat reports.
	var failure string
	if !downloadAndSwap(server, key, manifest, func(s string) {
		fmt.Fprint(os.Stderr, s)
		failure = strings.TrimSpace(s)
	}) {
		noteSelfUpdate(selfUpdateStateFailed, "installing "+remote+": "+failure, "")
		return
	}
	fmt.Printf("orbit updated to %s; restarting...\n", remote)
	recordSelfUpdate(version, remote, time.Now())
	if err := restartIntoUpdate(); err != nil {
		noteSelfUpdate(selfUpdateStateFailed, "installed "+remote+" but could not restart into it: "+err.Error(), "")
	}
}

// upgrade is the loud manual fallback (`orbit upgrade`) for when the silent
// auto-update isn't working; it reinstalls even when already current.
func upgrade(server string) {
	if version == "dev" {
		fmt.Fprintln(os.Stderr, "dev build; `orbit upgrade` only applies to the installed binary")
		os.Exit(1)
	}
	key := platformKey()
	if key == "" {
		fmt.Fprintf(os.Stderr, "unsupported platform %s/%s\n", runtime.GOOS, runtime.GOARCH)
		os.Exit(1)
	}
	server = strings.TrimRight(server, "/")

	// If the binary lives in a root-owned dir, re-run under sudo (prompts for the
	// password). Only when interactive — a service/script falls through to the
	// plain "re-run with sudo" hint instead of hanging on a password prompt.
	if exe, err := os.Executable(); err == nil {
		if resolved, e := filepath.EvalSymlinks(exe); e == nil {
			exe = resolved
		}
		if os.Geteuid() != 0 && !writable(filepath.Dir(exe)) && interactive() {
			elevateUpgrade(exe)
		}
	}

	fmt.Printf("checking %s for updates...\n", server)
	// The same release the runner's own update check would install: the one the control plane
	// assigns this runner when it is registered there, and the latest otherwise.
	m, err := publishedManifest(context.Background(), server)
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot read the release to install from the control plane:", err)
		os.Exit(1)
	}

	switch {
	case m.Version == version:
		fmt.Printf("already on %s; reinstalling to repair...\n", version)
	case isNewer(m.Version, version):
		fmt.Printf("updating %s -> %s...\n", version, m.Version)
	case wantsRelease(m, version):
		fmt.Printf("the control plane rolled %s back; installing %s...\n", version, m.Version)
	default:
		fmt.Printf("orbit %s is newer than %s, the release %s assigns this runner; nothing to install\n",
			version, m.Version, server)
		return
	}
	// As root — the `sudo orbit upgrade` a runner that cannot update itself asks for — first
	// move a legacy install out of root's /usr/local/bin, so this release lands where the
	// runner can replace it next time. Its service restarts once the release is in place.
	var restart func()
	if os.Geteuid() == 0 {
		if exe, err := selfUpdateTarget(); err == nil {
			restart = migrateLegacyInstall(exe)
		}
	}
	swapped := downloadAndSwap(server, key, m, func(s string) { fmt.Fprint(os.Stderr, s) })
	if restart != nil {
		restart()
	}
	if !swapped {
		fmt.Fprintln(os.Stderr, "upgrade failed.")
		os.Exit(1)
	}
	fmt.Printf("✓ orbit is now %s\n", m.Version)
}
