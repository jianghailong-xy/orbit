package main

// Cursor CLI, pinned to the one build docs/cursor-runtime-contract.md measured (§1).
//
// The runner installs that build itself rather than through Cursor's installer: it downloads the
// build's tarball for this platform, checks it against the size and SHA-256 the contract recorded,
// and unpacks it into a version directory of its own, <orbit home>/cursor/versions/<version>, which it
// never rewrites afterwards — only a person's Install or Reinstall puts the pinned build back where
// another one is found in its place (reinstallCursor). The official install script would also link
// ~/.local/bin/agent and ~/.local/bin/cursor, keep only the newest two versions and leave a detached
// cleanup process behind (§1.1); none of that happens here. Every Cursor CLI process Orbit starts runs
// that directory's cursor-agent by its absolute path, so nothing another copy of the CLI on the
// machine does — an update included — changes what a session runs.
//
// Even `cursor-agent --version` writes a cli-config.json and a compile cache under HOME (measured on
// the pinned build), so every process the runner starts for itself runs in a throwaway home
// (cursorProbeEnv), never the runner user's.

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
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"
)

const (
	// cursorSupportedVersion is the build Orbit runs, the one the contract measured (§0, §1).
	cursorSupportedVersion = "2026.10.14-941492e"
	// cursorEntryPoint is the package's launcher: a bash script that runs the bundled node on
	// index.js (§1.1).
	cursorEntryPoint = "cursor-agent"
	// cursorPackageRoot is the one directory the tarball holds everything under.
	cursorPackageRoot = "dist-package"
	// cursorInstallDescription is what the Engines panel and the logs show as Cursor CLI's install:
	// there is no command line to show, since the runner fetches and unpacks the build itself.
	cursorInstallDescription = "download Cursor CLI " + cursorSupportedVersion +
		" from downloads.cursor.com, check its pinned SHA-256 and unpack it into Orbit's own version directory"
)

// cursorArtifact is the pinned build's tarball for one platform, as the contract measured it.
type cursorArtifact struct {
	path   string // the platform's segment of the download URL: linux/x64
	sha256 string
	size   int64
}

// cursorArtifacts are the platforms the pinned build was measured on, by GOOS/GOARCH. Linux x64 alone:
// macOS waits for P0b and Linux arm64 for a measurement of its own (contract §17.1, item 11), so a
// runner on either is told its platform is unsupported rather than handed a download nobody checked.
// Tests replace it with a tarball of their own.
var cursorArtifacts = map[string]cursorArtifact{
	"linux/amd64": {
		path:   "linux/x64",
		sha256: "6f6bf39dd2df29dcd38643cdfab0155ce71699953889f732deec123f6562bb2d",
		size:   183861376,
	},
}

// cursorDownloadBase is where the tarballs are fetched from: downloads.cursor.com installed the build
// in 5.8 s from HPC, where the CLI's own default host ran at ~170 KB/s (§1.1). Tests point it at a
// server of their own.
var cursorDownloadBase = "https://downloads.cursor.com/lab"

var cursorVersionPattern = regexp.MustCompile(`^[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[0-9a-f]{7,40}$`)

func cursorRoot() string        { return filepath.Join(machineHome(), "cursor") }
func cursorVersionsDir() string { return filepath.Join(cursorRoot(), "versions") }
func cursorVersionDir() string  { return filepath.Join(cursorVersionsDir(), cursorSupportedVersion) }

func cursorTarballURL(a cursorArtifact) string {
	return cursorDownloadBase + "/" + cursorSupportedVersion + "/" + a.path + "/agent-cli-package.tar.gz"
}

// cursorArtifactFor is the pinned build for goos/arch, or why this platform has none.
func cursorArtifactFor(goos, arch string) (cursorArtifact, error) {
	if a, ok := cursorArtifacts[goos+"/"+arch]; ok {
		return a, nil
	}
	verified := make([]string, 0, len(cursorArtifacts))
	for platform := range cursorArtifacts {
		verified = append(verified, platform)
	}
	sort.Strings(verified)
	return cursorArtifact{}, fmt.Errorf("CURSOR_PLATFORM_UNSUPPORTED: Orbit runs Cursor CLI %s only on %s runners; this runner is %s/%s",
		cursorSupportedVersion, strings.Join(verified, ", "), goos, arch)
}

func cursorPlatformError() error {
	_, err := cursorArtifactFor(runtime.GOOS, runtime.GOARCH)
	return err
}

// cursorExecutableIn is the entry point of the published version directory dir: a regular executable
// file directly inside it, by its absolute path. A directory or entry point that is a link is refused,
// since what it points at is not what Orbit published.
func cursorExecutableIn(dir string) (string, error) {
	info, err := os.Lstat(dir)
	if err != nil {
		return "", fmt.Errorf("CURSOR_NOT_INSTALLED: Cursor CLI is not installed in Orbit's version directory %s", dir)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return "", fmt.Errorf("CURSOR_INSTALL_FAILED: Cursor CLI's version directory %s is not a directory Orbit published", dir)
	}
	entry := filepath.Join(dir, cursorEntryPoint)
	stat, err := os.Lstat(entry)
	if err != nil {
		return "", fmt.Errorf("CURSOR_INSTALL_FAILED: Cursor CLI's version directory %s has no %s", dir, cursorEntryPoint)
	}
	if !stat.Mode().IsRegular() || stat.Mode()&0o111 == 0 {
		return "", fmt.Errorf("CURSOR_INSTALL_FAILED: %s is not an executable file", entry)
	}
	return filepath.Abs(entry)
}

// cursorProbeVersion asks the CLI at exe for its version in a throwaway home, under a deadline generous
// enough for a loaded machine: an answer that never came says the install is broken, never that it is
// another version.
func cursorProbeVersion(exe string) (string, error) {
	root, err := newCursorProbeRoot("orbit-cursor-version-")
	if err != nil {
		return "", fmt.Errorf("CURSOR_INSTALL_FAILED: cannot create a private directory for Cursor CLI's version probe: %w", err)
	}
	defer os.RemoveAll(root)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe, "--version")
	cmd.Dir = root
	cmd.Env = cursorProbeEnv(root)
	configureEngineCommandTree(cmd)
	out, err := cmd.Output()
	if err != nil {
		return "", errors.New("CURSOR_INSTALL_FAILED: Cursor CLI's version probe failed to start or exited unsuccessfully")
	}
	version := strings.TrimSpace(firstLine(string(out)))
	if !cursorVersionPattern.MatchString(version) {
		return "", errors.New("CURSOR_VERSION_INCOMPATIBLE: Cursor CLI's version probe returned no version")
	}
	return version, nil
}

func cursorVersionMismatch(version string) error {
	return fmt.Errorf("CURSOR_VERSION_INCOMPATIBLE: Cursor CLI %s is installed, and Orbit runs exactly %s", version, cursorSupportedVersion)
}

// cursorExecutablePath is the pinned build's entry point, checked: this platform has a pinned build,
// Orbit's version directory holds it, and it says it is that version.
func cursorExecutablePath() (string, error) {
	if err := cursorPlatformError(); err != nil {
		return "", err
	}
	exe, _, err := cursorPinnedBuild()
	return exe, err
}

// cursorPinnedBuild checks the pinned version directory as cursorExecutablePath does, and says whether
// what is there is provably not the pinned build (another): no entry point Orbit published, or a build
// that answers its version probe with another version. A build that did not answer at all is not
// provably anything — on a loaded machine that is a busy CLI, which sessions may be running on.
func cursorPinnedBuild() (exe string, another bool, err error) {
	exe, err = cursorExecutableIn(cursorVersionDir())
	if err != nil {
		return "", true, err
	}
	version, err := cursorProbeVersion(exe)
	if err != nil {
		return "", false, err
	}
	if version != cursorSupportedVersion {
		return "", true, cursorVersionMismatch(version)
	}
	return exe, false, nil
}

// cursorPublishedVersions are the version directories Orbit has published here, newest last: the
// pinned build, and any build an earlier pin installed, which stays for the sessions running on it.
func cursorPublishedVersions() []string {
	entries, err := os.ReadDir(cursorVersionsDir())
	if err != nil {
		return nil
	}
	var versions []string
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		if _, err := cursorExecutableIn(filepath.Join(cursorVersionsDir(), entry.Name())); err == nil {
			versions = append(versions, entry.Name())
		}
	}
	sort.Strings(versions)
	return versions
}

// installCursor publishes the pinned build in Orbit's version directory. The caller holds
// engineInstall.mu, shared with every other install and update. A directory already published is
// never rewritten, broken or not: a different build goes into a directory of its own.
func installCursor(ctx context.Context, proxyVars []envVar) error {
	return publishCursor(ctx, proxyVars, false)
}

// reinstallCursor is installCursor for a person's Install or Reinstall from Orbit (installEngineNow),
// and the one way a pinned version directory that is provably not the pinned build (cursorPinnedBuild)
// is put right: the checked tarball takes its place, and what was there is deleted. A pinned build that
// is ready is left as it is, never downloaded or written again, and so is one that did not answer its
// version probe. No session starts on what is replaced — a launch takes the pinned build only once it
// says it is that version — and a build an earlier pin installed keeps its own directory, untouched, for
// the sessions running on it.
func reinstallCursor(ctx context.Context, proxyVars []envVar) error {
	return publishCursor(ctx, proxyVars, true)
}

// publishCursor is installCursor, and reinstallCursor when replace is set.
func publishCursor(ctx context.Context, proxyVars []envVar, replace bool) (err error) {
	defer func() {
		if err != nil && !strings.HasPrefix(err.Error(), "CURSOR_") {
			err = fmt.Errorf("CURSOR_INSTALL_FAILED: installing Cursor CLI %s failed: %w", cursorSupportedVersion, err)
		}
	}()
	artifact, err := cursorArtifactFor(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return err
	}
	target := cursorVersionDir()
	replacing := false
	if _, err := os.Lstat(target); err == nil {
		_, another, err := cursorPinnedBuild()
		if err == nil || !replace || !another {
			return err
		}
		replacing = true
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	parent := filepath.Dir(target)
	if err := os.MkdirAll(parent, machineHomePerm); err != nil {
		return err
	}
	removeStaleCursorStages(parent)
	stage, err := os.MkdirTemp(parent, ".install-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	tarball := filepath.Join(stage, "agent-cli-package.tar.gz")
	if err := downloadCursorTarball(ctx, artifact, tarball, proxyVars); err != nil {
		return err
	}
	unpacked := filepath.Join(stage, "package")
	if err := unpackCursorTarball(tarball, unpacked); err != nil {
		return err
	}
	exe, err := cursorExecutableIn(unpacked)
	if err != nil {
		return err
	}
	version, err := cursorProbeVersion(exe)
	if err != nil {
		return err
	}
	if version != cursorSupportedVersion {
		return cursorVersionMismatch(version)
	}
	if !replacing {
		return os.Rename(unpacked, target)
	}
	// Set aside inside the stage, which goes with it, and put back if the checked build cannot take
	// its place: one rename each, on the same filesystem.
	replaced := filepath.Join(stage, "replaced")
	if err := os.Rename(target, replaced); err != nil {
		return err
	}
	if err := os.Rename(unpacked, target); err != nil {
		_ = os.Rename(replaced, target)
		return err
	}
	return nil
}

// removeStaleCursorStages deletes what an install interrupted long ago left in the versions directory:
// the unpacked build is ~590 MB. One still young enough to be another install's, running now, stays.
func removeStaleCursorStages(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), ".install-") {
			continue
		}
		if info, err := entry.Info(); err == nil && time.Since(info.ModTime()) > 2*engineInstallTimeout {
			_ = os.RemoveAll(filepath.Join(dir, entry.Name()))
		}
	}
}

// downloadCursorTarball fetches the pinned tarball into dest and refuses it unless it is exactly the
// bytes the contract measured: its size and its SHA-256. Nothing is unpacked from a tarball that
// failed either check, and a server that keeps sending is cut off one byte past the expected size.
func downloadCursorTarball(ctx context.Context, artifact cursorArtifact, dest string, proxyVars []envVar) error {
	source := cursorTarballURL(artifact)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
	if err != nil {
		return err
	}
	resp, err := cursorDownloadClient(proxyVars).Do(req)
	if err != nil {
		return fmt.Errorf("CURSOR_INSTALL_FAILED: downloading Cursor CLI %s failed (%s)", cursorSupportedVersion, firstLine(err.Error()))
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("CURSOR_INSTALL_FAILED: downloading Cursor CLI %s failed: %s answered %s", cursorSupportedVersion, source, resp.Status)
	}
	file, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_EXCL, configFilePerm)
	if err != nil {
		return err
	}
	digest := sha256.New()
	n, copyErr := io.Copy(io.MultiWriter(file, digest), io.LimitReader(resp.Body, artifact.size+1))
	closeErr := file.Close()
	if copyErr != nil {
		return fmt.Errorf("CURSOR_INSTALL_FAILED: downloading Cursor CLI %s failed (%s)", cursorSupportedVersion, firstLine(copyErr.Error()))
	}
	if closeErr != nil {
		return closeErr
	}
	if n != artifact.size || hex.EncodeToString(digest.Sum(nil)) != artifact.sha256 {
		return fmt.Errorf("CURSOR_INSTALL_FAILED: the Cursor CLI %s tarball from %s does not match its pinned size and SHA-256; nothing was installed",
			cursorSupportedVersion, source)
	}
	return nil
}

// cursorDownloadClient fetches through the proxy the runner's engine installs use, when it has one.
func cursorDownloadClient(proxyVars []envVar) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	for _, v := range proxyVars {
		if strings.EqualFold(v.K, "https_proxy") && v.V != "" {
			if proxy, err := url.Parse(v.V); err == nil {
				transport.Proxy = http.ProxyURL(proxy)
			}
			break
		}
	}
	return &http.Client{Transport: transport}
}

// unpackCursorTarball unpacks the package's dist-package/ into dir. The checked tarball holds regular
// files and directories only (458 and 125 of them, §1), so anything else — a link, a device, a path
// outside the package — is refused rather than skipped.
func unpackCursorTarball(tarball, dir string) error {
	file, err := os.Open(tarball)
	if err != nil {
		return err
	}
	defer file.Close()
	gz, err := gzip.NewReader(file)
	if err != nil {
		return fmt.Errorf("CURSOR_INSTALL_FAILED: the Cursor CLI tarball is not gzip: %w", err)
	}
	defer gz.Close()
	if err := os.Mkdir(dir, 0o755); err != nil {
		return err
	}
	archive := tar.NewReader(gz)
	for {
		header, err := archive.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("CURSOR_INSTALL_FAILED: the Cursor CLI tarball cannot be read: %w", err)
		}
		name := path.Clean(header.Name)
		if name == cursorPackageRoot {
			continue
		}
		rel, inside := strings.CutPrefix(name, cursorPackageRoot+"/")
		if !inside || rel == "" || rel == ".." || strings.HasPrefix(rel, "../") {
			return fmt.Errorf("CURSOR_INSTALL_FAILED: the Cursor CLI tarball holds %q outside %s/", header.Name, cursorPackageRoot)
		}
		target := filepath.Join(dir, filepath.FromSlash(rel))
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, header.FileInfo().Mode().Perm()&0o755)
			if err != nil {
				return err
			}
			_, copyErr := io.Copy(out, archive)
			closeErr := out.Close()
			if copyErr != nil {
				return copyErr
			}
			if closeErr != nil {
				return closeErr
			}
		default:
			return fmt.Errorf("CURSOR_INSTALL_FAILED: the Cursor CLI tarball holds %q, which is neither a file nor a directory", header.Name)
		}
	}
}

// cursorHasPublishedInstall reports whether this runner has had Cursor CLI installed by Orbit. The
// update pass installs a newly pinned build only there; installing it anywhere else is a session's
// first need, a person's Install, or `orbit doctor`.
func cursorHasPublishedInstall() bool {
	return len(cursorPublishedVersions()) > 0
}

// updateCursor is the update pass for Cursor CLI, run under engineInstall.mu: it follows the pinned
// build, never a release feed or the CLI's own `agent update`. A runner whose pin moved installs the
// new build beside the one it had — which stays, untouched, for the sessions running on it — and a
// runner Orbit never installed Cursor CLI on is left alone. A busy runner never gets here: the pass
// defers an engine with sessions on it until they finish (updateEngines).
func updateCursor(ctx context.Context, spec engineSpec, proxyVars []envVar) (EngineUpdateReport, string) {
	facts := engineUpdateFacts{latest: cursorSupportedVersion}
	if _, err := os.Lstat(cursorVersionDir()); errors.Is(err, os.ErrNotExist) {
		if !cursorHasPublishedInstall() {
			return EngineUpdateReport{}, ""
		}
		cmdCtx, cancel := context.WithTimeout(ctx, engineUpdateTimeout)
		defer cancel()
		if err := installCursor(cmdCtx, proxyVars); err != nil {
			rec := recordEngineUpdate(spec.bin, updateFailed, err.Error(), facts)
			return rec, spec.name + " — update failed: " + err.Error()
		}
		facts.installed = cursorSupportedVersion
		rec := recordEngineUpdate(spec.bin, updateUpdated, "Installed the pinned version beside the versions sessions may still run on.", facts)
		return rec, spec.name + " updated to the pinned version " + cursorSupportedVersion
	}
	if _, err := cursorExecutablePath(); err != nil {
		rec := recordEngineUpdate(spec.bin, updateFailed, err.Error(), facts)
		return rec, spec.name + " — update failed: " + err.Error()
	}
	facts.installed = cursorSupportedVersion
	rec := recordEngineUpdate(spec.bin, updateChecked, "Pinned to "+cursorSupportedVersion+"; newer Cursor CLI releases are not followed.", facts)
	return rec, spec.name + " — pinned version " + cursorSupportedVersion
}

// ensureCursor makes the pinned build ready for a session about to start, installing it when this
// runner may install engines unattended. Returns "" when it is ready, else what to fail the session
// with. A version directory that is present and broken is reported, never repaired in place.
func ensureCursor(ctx context.Context, notify func(string)) string {
	engineInstall.mu.Lock()
	defer engineInstall.mu.Unlock()
	_, probeErr := cursorExecutablePath()
	if probeErr == nil {
		return ""
	}
	if _, err := os.Lstat(cursorVersionDir()); err == nil {
		return probeErr.Error()
	}
	if err := cursorPlatformError(); err != nil {
		return err.Error()
	}
	if !engineInstall.allowed {
		return "CURSOR_NOT_INSTALLED: Cursor CLI " + cursorSupportedVersion + " is not installed in Orbit's version directory, " +
			"and automatic engine installation is not authorized on this runner — run `orbit doctor` there to install it"
	}
	if notify != nil {
		notify("Installing Cursor CLI " + cursorSupportedVersion + " on this runner (checked against its pinned SHA-256) — first session that needs it.")
	}
	cmdCtx, cancel := context.WithTimeout(ctx, engineInstallTimeout)
	defer cancel()
	if err := installCursor(cmdCtx, engineInstall.proxyVars); err != nil {
		return err.Error()
	}
	if notify != nil {
		notify("Cursor CLI installed. Continuing…")
	}
	return ""
}

// cursorBaseEnv is the allowlist every Cursor CLI process starts from (contract §16.3): the service
// PATH, the locale and terminal, the machine's proxy and certificate settings, and the runner's mark.
// Nothing else of the runner's environment reaches the CLI — no credential, no other engine's
// configuration — and HOME is each caller's to set. NODE_USE_ENV_PROXY makes every connection the
// CLI opens follow the proxy, which HTTPS_PROXY alone does not (§14.1).
func cursorBaseEnv() []string {
	keys := []string{"USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "TMPDIR", "ORBIT_HOME",
		"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
		"SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"}
	env := []string{"PATH=" + serviceLoginPath(), envRunnerChild + "=1"}
	proxied := false
	for _, key := range keys {
		if value, ok := os.LookupEnv(key); ok {
			env = append(env, key+"="+value)
			proxied = proxied || (strings.HasSuffix(strings.ToLower(key), "_proxy") && !strings.EqualFold(key, "no_proxy") && value != "")
		}
	}
	if proxied {
		env = append(env, "NODE_USE_ENV_PROXY=1")
	}
	return env
}

// cursorProbeEnv is the environment of a Cursor CLI the runner starts for itself — a version, sign-in
// or catalogue probe: the allowlist, with every directory the CLI writes pointed into root and its
// credentials kept in memory, so nothing lands in the runner user's ~/.cursor, ~/.config/cursor or
// ~/.cache.
func cursorProbeEnv(root string) []string {
	return append(cursorBaseEnv(),
		"HOME="+filepath.Join(root, "home"),
		"CURSOR_CONFIG_DIR="+filepath.Join(root, "config"),
		"CURSOR_DATA_DIR="+filepath.Join(root, "data"),
		"XDG_CONFIG_HOME="+filepath.Join(root, "xdg-config"),
		"XDG_CACHE_HOME="+filepath.Join(root, "cache"),
		"AGENT_CLI_CREDENTIAL_STORE=memory",
		"NO_OPEN_BROWSER=1",
		"DIRENV_DISABLE=1",
		"CURSOR_AGENT_DISABLE_DEBUG_LOG=1",
	)
}
