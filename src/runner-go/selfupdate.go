package main

import (
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

// downloadAndSwap fetches the published binary for `ver`, verifies it runs and
// reports that version, then atomically swaps it over the current executable.
func downloadAndSwap(server, key, ver string, logf func(string)) bool {
	exe, err := os.Executable()
	if err != nil {
		logf("cannot locate executable: " + err.Error() + "\n")
		return false
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	// Fail fast (before downloading) if we can't write where the binary lives.
	if dir := filepath.Dir(exe); !writable(dir) {
		logf(fmt.Sprintf("cannot write to %s (permission denied) — re-run with: sudo orbit upgrade\n", dir))
		return false
	}

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Get(server + "/dl/orbit-" + key)
	if err != nil {
		logf("download failed: " + err.Error() + "\n")
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		logf(fmt.Sprintf("download failed: HTTP %d\n", resp.StatusCode))
		return false
	}
	data, _ := io.ReadAll(resp.Body)
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
	if err := os.Rename(tmp, exe); err != nil {
		_ = os.Remove(tmp)
		logf("replace failed: " + err.Error() + "\n")
		return false
	}
	return true
}

// selfUpdate silently pulls a strictly-newer orbit and re-execs. A dev build
// (version == "dev") or ORBIT_NO_SELFUPDATE disables it; failures never block.
func selfUpdate(server string) {
	if version == "dev" || os.Getenv("ORBIT_NO_SELFUPDATE") != "" {
		return
	}
	key := platformKey()
	if key == "" {
		return
	}
	server = strings.TrimRight(server, "/")

	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Get(server + "/dl/version.json")
	if err != nil {
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return
	}
	var m Manifest
	if json.NewDecoder(resp.Body).Decode(&m) != nil || m.Version == "" || !isNewer(m.Version, version) {
		return
	}

	fmt.Printf("orbit %s -> %s: downloading update...\n", version, m.Version)
	if !downloadAndSwap(server, key, m.Version, func(string) {}) {
		return
	}
	fmt.Printf("orbit updated to %s; restarting...\n", m.Version)
	exe, err := os.Executable()
	if err == nil {
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			exe = resolved
		}
		_ = syscall.Exec(exe, os.Args, os.Environ())
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

	if m.Version == version {
		fmt.Printf("already on %s; reinstalling to repair...\n", version)
	} else {
		fmt.Printf("updating %s -> %s...\n", version, m.Version)
	}
	if !downloadAndSwap(server, key, m.Version, func(s string) { fmt.Fprint(os.Stderr, s) }) {
		fmt.Fprintln(os.Stderr, "upgrade failed.")
		os.Exit(1)
	}
	fmt.Printf("✓ orbit is now %s\n", m.Version)
}
