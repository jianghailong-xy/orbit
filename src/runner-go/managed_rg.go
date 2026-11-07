package main

// Orbit's own ripgrep, last on every engine's PATH.
//
// The engines tell their models to search with rg, and the plain shells Kimi Code, OpenCode, Antigravity,
// DeepSeek Harness and Cursor CLI run a session's commands in have one only where the host installed ripgrep
// (doctor_rg.go). So the runner keeps a pinned ripgrep of its own: the official release build for this
// platform, downloaded from ripgrep's GitHub release, checked against the size and SHA-256 pinned below, and
// unpacked into <orbit home>/tools/ripgrep/<version>, which is never rewritten afterwards. That directory goes
// last on the PATH the runner gives every engine (pathWithManagedRgLast), so an rg the host already has is
// found first and nothing on the PATH is shadowed: it fills a hole and changes nothing else. It is on the PATH
// before the build is there, so a shell finds rg the moment it is published, in sessions already running too.
//
// Installed on demand rather than shipped with the runner release. A release is one gzipped binary per
// platform, served from each deployment's own /dl and named in version.json; a second executable would change
// the release build, the self-updater, install.sh and the manifest the control plane serves, for a 2 MB tool
// the runner can fetch, check and publish itself, as it already does Cursor CLI's pinned build and Harness's
// Node (cursor_install.go, dsh_node.go). The consent is the same one: the runner installs it unattended only
// where `orbit register` recorded AutoInstallEngines, and `orbit doctor` offers it to a person otherwise.
//
// managedRgPath is how the rest of the runner finds it.

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const managedRgVersion = "15.2.0"

// managedRgBuild is one platform's release archive of managedRgVersion: ripgrep's name for the platform, and the
// archive's size and SHA-256.
type managedRgBuild struct {
	target string
	sha256 string
	size   int64
}

// managedRgBuilds are the pinned archives, by GOOS/GOARCH. Each digest and size was taken from three sources that
// agreed (2026-11-07): the release's own .sha256 file, the digest GitHub records for the asset, and a hash of the
// downloaded bytes. Linux gets the static musl builds, which run whatever libc the host has; 15.2.0 is the first
// release with one for arm64. Tests replace it with an archive of their own.
var managedRgBuilds = map[string]managedRgBuild{
	"linux/amd64":  {target: "x86_64-unknown-linux-musl", sha256: "33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c", size: 2265718},
	"linux/arm64":  {target: "aarch64-unknown-linux-musl", sha256: "800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915", size: 1982561},
	"darwin/amd64": {target: "x86_64-apple-darwin", sha256: "af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1", size: 1878284},
	"darwin/arm64": {target: "aarch64-apple-darwin", sha256: "3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4", size: 1764284},
}

// managedRgOS and managedRgArch are the platform whose build this runner installs, the runtime's own. A test
// stands another in.
var managedRgOS, managedRgArch = runtime.GOOS, runtime.GOARCH

// managedRgDownloadBase is where the archives are fetched from. Tests point it at a server of their own.
var managedRgDownloadBase = "https://github.com/BurntSushi/ripgrep/releases/download"

// managedRgFiles are what is kept of an archive: the binary, and the licence it comes under (Unlicense or MIT).
var managedRgFiles = []string{"rg", "COPYING", "LICENSE-MIT", "UNLICENSE"}

var errManagedRgMissing = errors.New("Orbit's ripgrep is not installed on this runner")

func managedRgRoot() string { return filepath.Join(machineHome(), "tools", "ripgrep") }

// managedRgDir is the version directory: the one that goes on the PATH, holding rg and its licence.
func managedRgDir() string { return filepath.Join(managedRgRoot(), managedRgVersion) }

func managedRgBuildFor() (managedRgBuild, bool) {
	build, ok := managedRgBuilds[managedRgOS+"/"+managedRgArch]
	return build, ok
}

// name is the archive's file name without .tar.gz, and the one directory it holds everything under.
func (b managedRgBuild) name() string { return "ripgrep-" + managedRgVersion + "-" + b.target }

func (b managedRgBuild) url() string {
	return managedRgDownloadBase + "/" + managedRgVersion + "/" + b.name() + ".tar.gz"
}

// managedRgPath is Orbit's own rg by its absolute path, once Orbit has installed it on this runner: the rg of the
// published version directory, a regular executable file in a directory that is not a link. Otherwise it says why
// there is none (errManagedRgMissing when it was never installed). This is the one way the runner finds it.
func managedRgPath() (string, error) {
	if _, ok := managedRgBuildFor(); !ok {
		return "", fmt.Errorf("Orbit has no ripgrep build for %s/%s runners", managedRgOS, managedRgArch)
	}
	dir, err := filepath.Abs(managedRgDir())
	if err != nil {
		return "", err
	}
	info, err := os.Lstat(dir)
	if errors.Is(err, os.ErrNotExist) {
		return "", errManagedRgMissing
	}
	if err != nil {
		return "", fmt.Errorf("Orbit's ripgrep directory %s cannot be read: %w", dir, err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return "", fmt.Errorf("Orbit's ripgrep directory %s is not a directory Orbit published", dir)
	}
	rg := filepath.Join(dir, "rg")
	if stat, err := os.Lstat(rg); err != nil || !stat.Mode().IsRegular() || stat.Mode()&0o111 == 0 {
		return "", fmt.Errorf("Orbit's ripgrep directory %s has no executable rg", dir)
	}
	return rg, nil
}

// pathWithManagedRgLast is path with Orbit's ripgrep directory as its last entry and nowhere else: the directory
// of any version an earlier pin installed is dropped too, wherever it stood. Last, so every rg on path is found
// before Orbit's. A platform Orbit has no build for gets path as it was.
func pathWithManagedRgLast(path string) string {
	if _, ok := managedRgBuildFor(); !ok {
		return path
	}
	dir := managedRgDir()
	if !filepath.IsAbs(dir) {
		// Relative to whatever directory a shell is in: never a PATH entry.
		return path
	}
	if path == "" {
		return dir
	}
	root := filepath.Dir(dir)
	kept := make([]string, 0, strings.Count(path, ":")+2)
	for _, entry := range strings.Split(path, ":") {
		if entry != "" && filepath.Dir(filepath.Clean(entry)) == root {
			continue
		}
		kept = append(kept, entry)
	}
	return strings.Join(append(kept, dir), ":")
}

// managedRgMu serialises this process's installs, so two callers never stage the same version at once.
var managedRgMu sync.Mutex

// installManagedRg publishes the pinned build in Orbit's version directory, unless it is there already, and returns
// its rg. A version directory that is there and broken is reported, never repaired in place: deleting it lets the
// next install publish it again. Nothing is published from an archive that fails its size or SHA-256, or whose rg
// does not start here and say it is the pinned version.
func installManagedRg(ctx context.Context, proxyVars []envVar) (string, error) {
	managedRgMu.Lock()
	defer managedRgMu.Unlock()
	build, ok := managedRgBuildFor()
	if !ok {
		return managedRgPath()
	}
	rg, err := managedRgPath()
	if !errors.Is(err, errManagedRgMissing) {
		return rg, err
	}
	target := managedRgDir()
	parent := filepath.Dir(target)
	if err := os.MkdirAll(parent, machineHomePerm); err != nil {
		return "", err
	}
	stage, err := os.MkdirTemp(parent, ".install-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(stage)
	archive := filepath.Join(stage, build.name()+".tar.gz")
	if err := downloadManagedRg(ctx, build, archive, proxyVars); err != nil {
		return "", err
	}
	unpacked := filepath.Join(stage, "ripgrep")
	if err := unpackManagedRg(archive, build, unpacked); err != nil {
		return "", err
	}
	if err := probeManagedRg(ctx, filepath.Join(unpacked, "rg")); err != nil {
		return "", err
	}
	if err := os.Rename(unpacked, target); err != nil {
		// Another process may have published it first; what is there now is the answer either way.
		if rg, pathErr := managedRgPath(); pathErr == nil {
			return rg, nil
		}
		return "", err
	}
	return managedRgPath()
}

// downloadManagedRg fetches the pinned archive into dest and refuses it unless it is exactly the pinned bytes, the
// way downloadCursorTarball does: a server that keeps sending is cut off one byte past the size.
func downloadManagedRg(ctx context.Context, build managedRgBuild, dest string, proxyVars []envVar) error {
	source := build.url()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
	if err != nil {
		return err
	}
	// Through the proxy the runner's engine installs use.
	resp, err := cursorDownloadClient(proxyVars).Do(req)
	if err != nil {
		return fmt.Errorf("downloading ripgrep %s failed (%s)", managedRgVersion, firstLine(err.Error()))
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("downloading ripgrep %s failed: %s answered %s", managedRgVersion, source, resp.Status)
	}
	file, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_EXCL, configFilePerm)
	if err != nil {
		return err
	}
	digest := sha256.New()
	n, copyErr := io.Copy(io.MultiWriter(file, digest), io.LimitReader(resp.Body, build.size+1))
	closeErr := file.Close()
	if copyErr != nil {
		return fmt.Errorf("downloading ripgrep %s failed (%s)", managedRgVersion, firstLine(copyErr.Error()))
	}
	if closeErr != nil {
		return closeErr
	}
	if n != build.size || hex.EncodeToString(digest.Sum(nil)) != build.sha256 {
		return fmt.Errorf("the ripgrep %s archive from %s does not match its pinned size and SHA-256; nothing was installed", managedRgVersion, source)
	}
	return nil
}

// unpackManagedRg writes managedRgFiles from the archive's one top directory into dir, and nothing else of it: the
// names written are Orbit's, never the archive's. The archive must hold rg as a regular file there.
func unpackManagedRg(archive string, build managedRgBuild, dir string) error {
	file, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer file.Close()
	gz, err := gzip.NewReader(file)
	if err != nil {
		return fmt.Errorf("the ripgrep archive is not gzip: %w", err)
	}
	defer gz.Close()
	if err := os.Mkdir(dir, 0o755); err != nil {
		return err
	}
	wanted := map[string]bool{}
	for _, name := range managedRgFiles {
		wanted[build.name()+"/"+name] = true
	}
	reader := tar.NewReader(gz)
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("the ripgrep archive cannot be read: %w", err)
		}
		if !wanted[header.Name] || header.Typeflag != tar.TypeReg {
			continue
		}
		delete(wanted, header.Name)
		mode := os.FileMode(0o644)
		if strings.HasSuffix(header.Name, "/rg") {
			mode = 0o755
		}
		out, err := os.OpenFile(filepath.Join(dir, filepath.Base(header.Name)), os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(out, reader)
		closeErr := out.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	if wanted[build.name()+"/rg"] {
		return fmt.Errorf("the ripgrep %s archive holds no %s/rg", managedRgVersion, build.name())
	}
	return nil
}

// probeManagedRg runs `rg --version`: the checked bytes can still be a build this machine cannot run.
func probeManagedRg(ctx context.Context, rg string) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, rg, "--version")
	cmd.Env = []string{}
	out, err := cmd.CombinedOutput()
	if err != nil {
		reason := firstLine(strings.TrimSpace(string(out)))
		if reason == "" {
			reason = firstLine(err.Error())
		}
		return fmt.Errorf("ripgrep %s does not start on this runner (%s)", managedRgVersion, reason)
	}
	if fields := strings.Fields(firstLine(string(out))); len(fields) < 2 || fields[0] != "ripgrep" || fields[1] != managedRgVersion {
		return fmt.Errorf("the ripgrep %s archive's rg says it is %q", managedRgVersion, firstLine(strings.TrimSpace(string(out))))
	}
	return nil
}

// managedRgRetryInterval is how long keepManagedRg waits after a failed install: the engine update pass's interval.
// A var only so a test can wait less.
var managedRgRetryInterval = engineUpdateInterval

// keepManagedRg installs Orbit's ripgrep in the background where it is missing and this runner may install engines
// by itself, and tries again every managedRgRetryInterval until it is in place. Nothing waits for it: its directory
// is on every engine's PATH already.
func keepManagedRg(ctx context.Context, allowed bool, proxyVars []envVar) {
	if _, ok := managedRgBuildFor(); !allowed || !ok {
		return
	}
	for {
		if _, err := managedRgPath(); err == nil {
			return
		}
		installCtx, cancel := context.WithTimeout(ctx, engineInstallTimeout)
		rg, err := installManagedRg(installCtx, proxyVars)
		cancel()
		if err == nil {
			logln("managed rg: installed ripgrep", managedRgVersion, "at", rg)
			return
		}
		if ctx.Err() != nil {
			return
		}
		logln("managed rg:", err, "— trying again in", managedRgRetryInterval)
		select {
		case <-ctx.Done():
			return
		case <-time.After(managedRgRetryInterval):
		}
	}
}
