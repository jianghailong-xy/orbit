package main

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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

// resolvedExecutable returns this process's binary with symlinks resolved — the
// path an update replaces, and whose directory must be writable to do so.
func resolvedExecutable() (string, error) {
	exe, err := os.Executable()
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
	return version != "dev" && os.Getenv("ORBIT_NO_SELFUPDATE") == "" && platformKey() != ""
}

// publishedManifest fetches and negotiates the control plane's current runner release. Keeping
// this read separate from downloadAndSwap lets a live runner cheaply decide whether to drain, and
// makes an incompatible release a no-op rather than a binary swap followed by rejected writes.
func publishedManifest(ctx context.Context, server string) (Manifest, error) {
	server = strings.TrimRight(server, "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, server+"/dl/version.json", nil)
	if err != nil {
		return Manifest{}, err
	}
	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return Manifest{}, err
	}
	defer resp.Body.Close()
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
	if err := manifestProtocolCompatible(m); err != nil {
		return Manifest{}, err
	}
	return m, nil
}

func publishedVersion(ctx context.Context, server string) (string, error) {
	m, err := publishedManifest(ctx, server)
	if err != nil {
		return "", err
	}
	return m.Version, nil
}

// availableSelfUpdate reports the release that a running runner should drain
// for. Errors are deliberately silent: the next periodic check will retry and
// ordinary runner work must remain available through a control-plane hiccup.
// An update this process could not install is not reported: draining for one
// tears down live sessions mid-turn every check interval, forever, without the
// version ever changing.
func availableSelfUpdate(ctx context.Context, server string) (string, bool) {
	if !selfUpdateEnabled() {
		return "", false
	}
	remote, err := publishedVersion(ctx, server)
	if err != nil || !isNewer(remote, version) {
		return "", false
	}
	if dir, ok := selfUpdateInstallable(); !ok {
		warnSelfUpdateBlocked(remote, dir)
		return "", false
	}
	return remote, true
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

// downloadAndSwap fetches the published binary, verifies both its version and its write contract,
// then atomically swaps it over the current executable. The same check protects automatic upgrade,
// explicit reinstall and N-1 rollback.
func downloadAndSwap(server, key string, manifest Manifest, logf func(string)) bool {
	ver := manifest.Version
	exe, err := resolvedExecutable()
	if err != nil {
		logf("cannot locate executable: " + err.Error() + "\n")
		return false
	}
	// Fail fast (before downloading) if we can't write where the binary lives.
	if dir := filepath.Dir(exe); !writable(dir) {
		logf(fmt.Sprintf("cannot write to %s (permission denied) — re-run with: sudo orbit upgrade\n", dir))
		return false
	}

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Get(server + "/dl/orbit-" + key + ".gz")
	if err != nil {
		logf("download failed: " + err.Error() + "\n")
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		logf(fmt.Sprintf("download failed: HTTP %d\n", resp.StatusCode))
		return false
	}
	gz, err := gzip.NewReader(resp.Body)
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

// selfUpdate silently pulls a strictly-newer orbit and re-execs. A dev build
// (version == "dev") or ORBIT_NO_SELFUPDATE disables it; failures never block.
func selfUpdate(server string) {
	if !selfUpdateEnabled() {
		return
	}
	key := platformKey()
	server = strings.TrimRight(server, "/")

	manifest, err := publishedManifest(context.Background(), server)
	if err != nil || !isNewer(manifest.Version, version) {
		return
	}
	remote := manifest.Version

	fmt.Printf("orbit %s -> %s: downloading update...\n", version, remote)
	// Never swallow the reason: a silent failure here leaves the runner pinned to
	// an old release with nothing in the log but the line above.
	if !downloadAndSwap(server, key, manifest, func(s string) { fmt.Fprint(os.Stderr, s) }) {
		return
	}
	fmt.Printf("orbit updated to %s; restarting...\n", remote)
	_ = execCurrentProcess()
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
	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Get(server + "/dl/version.json")
	if err != nil {
		fmt.Fprintln(os.Stderr, "failed to reach control plane:", err)
		os.Exit(1)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		fmt.Fprintf(os.Stderr, "failed to reach control plane: HTTP %d\n", resp.StatusCode)
		os.Exit(1)
	}
	var m Manifest
	if json.NewDecoder(resp.Body).Decode(&m) != nil || m.Version == "" {
		fmt.Fprintln(os.Stderr, "the control plane did not publish a version")
		os.Exit(1)
	}
	if err := manifestProtocolCompatible(m); err != nil {
		fmt.Fprintln(os.Stderr, "the control plane published an incompatible runner:", err)
		os.Exit(1)
	}

	if m.Version == version {
		fmt.Printf("already on %s; reinstalling to repair...\n", version)
	} else {
		fmt.Printf("updating %s -> %s...\n", version, m.Version)
	}
	if !downloadAndSwap(server, key, m, func(s string) { fmt.Fprint(os.Stderr, s) }) {
		fmt.Fprintln(os.Stderr, "upgrade failed.")
		os.Exit(1)
	}
	fmt.Printf("✓ orbit is now %s\n", m.Version)
}
