package main

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

const (
	dshInstallDescription = "npm ci --prefix <Orbit-managed staging directory> --no-audit --no-fund (@deepseek-ai/dsh@" + dshSupportedVersion + ")"
)

// The P0 lock includes native optional dependencies and package integrity. Installing
// from it freezes the whole tested composition, including its transitive dependencies.
//
//go:embed dsh-install/package.json
var dshPackageJSON []byte

//go:embed dsh-install/package-lock.json
var dshPackageLock []byte

// Tests replace only tool discovery, so no installed CLI or updater on their host
// can turn a unit test into an installation or a provider request.
var dshServicePath = serviceLoginPath
var dshCLIVersionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$`)
var dshNodeVersionPattern = regexp.MustCompile(`^v26\.[0-9]+\.[0-9]+$`)

func dshVersionDir() string {
	return filepath.Join(machineHome(), "engines", providerDsh, dshSupportedVersion)
}

func dshVersionCompatible(version string) bool {
	return strings.TrimSpace(version) == dshSupportedVersion
}

func dshPlatformAdmission(goos, arch, nodeVersion string) error {
	if goos != "linux" || arch != "amd64" {
		return fmt.Errorf("DSH_PLATFORM_UNSUPPORTED: DeepSeek Harness %s is supported only on Linux x64; this runner is %s/%s", dshSupportedVersion, goos, arch)
	}
	if !dshNodeVersionPattern.MatchString(strings.TrimSpace(nodeVersion)) {
		return fmt.Errorf("DSH_NODE_UNSUPPORTED: DeepSeek Harness %s requires the P0 Node 26 baseline; the service Node version is incompatible", dshSupportedVersion)
	}
	return nil
}

// Probes never inherit a user's Harness configuration, credentials or project .env.
// HOME stays the user's real HOME; only DSH_HOME selects our disposable probe state.
func dshProbeEnv(home string) []string {
	return []string{"PATH=" + dshServicePath(), "HOME=" + userHome(), "DSH_HOME=" + home, "DSH_TELEMETRY_DISABLED=1"}
}

func dshPlatformError() error {
	if runtime.GOOS != "linux" || runtime.GOARCH != "amd64" {
		return dshPlatformAdmission(runtime.GOOS, runtime.GOARCH, "")
	}
	path, ok := lookPathIn("node", dshServicePath())
	if !ok {
		return errors.New("DSH_NODE_UNSUPPORTED: DeepSeek Harness requires Node 26 on the runner's service PATH")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "--version")
	cmd.Env = []string{"PATH=" + dshServicePath(), "HOME=" + userHome()}
	out, err := cmd.Output()
	if err != nil {
		return errors.New("DSH_NODE_UNSUPPORTED: DeepSeek Harness could not start the required Node 26 runtime")
	}
	return dshPlatformAdmission(runtime.GOOS, runtime.GOARCH, strings.TrimSpace(string(out)))
}

func dshProbeVersion(path string) (string, error) {
	home, err := os.MkdirTemp("", "orbit-dsh-version-")
	if err != nil {
		return "", fmt.Errorf("DSH_INSTALL_FAILED: DeepSeek Harness could not create isolated version probe: %w", err)
	}
	defer os.RemoveAll(home)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "--version")
	cmd.Dir = home
	cmd.Env = dshProbeEnv(home)
	configureEngineCommandTree(cmd)
	out, err := cmd.Output()
	if err != nil {
		return "", errors.New("DSH_INSTALL_FAILED: DeepSeek Harness version probe failed to start or exited unsuccessfully")
	}
	version := strings.TrimSpace(string(out))
	if !dshCLIVersionPattern.MatchString(version) {
		return "", errors.New("DSH_VERSION_INCOMPATIBLE: DeepSeek Harness version probe returned no valid CLI version")
	}
	return version, nil
}

func dshExecutableIn(dir string) (string, error) {
	info, err := os.Lstat(dir)
	if err == nil && info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("DSH_INSTALL_FAILED: published version directory cannot be a symlink")
	}
	path := filepath.Join(dir, "node_modules", ".bin", providerDsh)
	stat, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("DSH_NOT_INSTALLED: DeepSeek Harness %s is not installed in Orbit's version directory: %w", dshSupportedVersion, err)
	}
	if stat.IsDir() || stat.Mode()&0o111 == 0 {
		return "", errors.New("DSH_INSTALL_FAILED: DeepSeek Harness installed entry point is not executable")
	}
	real, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", fmt.Errorf("DSH_INSTALL_FAILED: DeepSeek Harness entry point cannot be resolved: %w", err)
	}
	abs, err := filepath.Abs(real)
	if err != nil {
		return "", fmt.Errorf("DSH_INSTALL_FAILED: DeepSeek Harness entry point cannot be resolved: %w", err)
	}
	root, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return "", fmt.Errorf("DSH_INSTALL_FAILED: DeepSeek Harness version directory cannot be resolved: %w", err)
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("DSH_INSTALL_FAILED: DeepSeek Harness version directory cannot be resolved: %w", err)
	}
	if !strings.HasPrefix(abs, root+string(os.PathSeparator)) {
		return "", errors.New("DSH_INSTALL_FAILED: DeepSeek Harness entry point escapes Orbit's immutable version directory")
	}
	return abs, nil
}

// Return an absolute, version-local entry point, never a user's global dsh or a
// mutable current link. Existing sessions keep this path for their whole lifetime.
func dshExecutablePath() (string, error) {
	if err := dshPlatformError(); err != nil {
		return "", err
	}
	path, err := dshExecutableIn(dshVersionDir())
	if err != nil {
		return "", err
	}
	version, err := dshProbeVersion(path)
	if err != nil {
		return "", err
	}
	if !dshVersionCompatible(version) {
		return "", fmt.Errorf("DSH_VERSION_INCOMPATIBLE: DeepSeek Harness version incompatible: supported version is exactly %s; repair Orbit's version directory", dshSupportedVersion)
	}
	return path, nil
}

// Caller holds engineInstall.mu, shared with every existing install/update path.
// Never rewrite a published version directory, even when its contents are broken.
func installDsh(ctx context.Context, proxyVars []envVar) (err error) {
	defer func() {
		if err != nil && !strings.HasPrefix(err.Error(), "DSH_") {
			err = fmt.Errorf("DSH_INSTALL_FAILED: DeepSeek Harness fixed-version install failed: %w", err)
		}
	}()
	if err := dshPlatformError(); err != nil {
		return err
	}
	target := dshVersionDir()
	if _, err := os.Stat(target); err == nil {
		_, err = dshExecutablePath()
		return err
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	parent := filepath.Dir(target)
	if err := os.MkdirAll(parent, machineHomePerm); err != nil {
		return err
	}
	stage, err := os.MkdirTemp(parent, ".install-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	for name, data := range map[string][]byte{"package.json": dshPackageJSON, "package-lock.json": dshPackageLock} {
		if err := os.WriteFile(filepath.Join(stage, name), data, configFilePerm); err != nil {
			return err
		}
	}
	npm, ok := lookPathIn("npm", dshServicePath())
	if !ok {
		return errors.New("DSH_INSTALL_FAILED: DeepSeek Harness install requires npm on the runner's service PATH")
	}
	probeHome := filepath.Join(stage, ".dsh-install-home")
	if err := os.MkdirAll(probeHome, machineHomePerm); err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, npm, "ci", "--prefix", stage, "--cache", filepath.Join(parent, "npm-cache"), "--no-audit", "--no-fund")
	cmd.Dir = stage
	cmd.Env = dshProbeEnv(probeHome)
	for _, v := range proxyVars {
		cmd.Env = append(cmd.Env, v.K+"="+v.V)
	}
	configureEngineCommandTree(cmd)
	// npm output can include registry credentials; expose only the exit failure.
	if _, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("DSH_INSTALL_FAILED: DeepSeek Harness installing the fixed %s package failed (%s)", dshSupportedVersion, firstLine(err.Error()))
	}
	path, err := dshExecutableIn(stage)
	if err != nil {
		return err
	}
	version, err := dshProbeVersion(path)
	if err != nil {
		return err
	}
	if !dshVersionCompatible(version) {
		return fmt.Errorf("DSH_VERSION_INCOMPATIBLE: DeepSeek Harness version incompatible after install: supported version is exactly %s", dshSupportedVersion)
	}
	if err := os.RemoveAll(probeHome); err != nil {
		return err
	}
	return os.Rename(stage, target)
}

// An older version stays on disk for its sessions and recovery. The updater only
// installs a new supported directory when this runner already has a dsh install.
func dshHasPublishedInstall() bool {
	entries, err := os.ReadDir(filepath.Dir(dshVersionDir()))
	if err != nil {
		return false
	}
	for _, entry := range entries {
		if entry.IsDir() && !strings.HasPrefix(entry.Name(), ".") {
			if _, err := dshExecutableIn(filepath.Join(filepath.Dir(dshVersionDir()), entry.Name())); err == nil {
				return true
			}
		}
	}
	return false
}

func ensureDsh(ctx context.Context, notify func(string)) string {
	engineInstall.mu.Lock()
	defer engineInstall.mu.Unlock()
	_, probeErr := dshExecutablePath()
	if probeErr == nil {
		return ""
	}
	if _, err := os.Stat(dshVersionDir()); err == nil {
		return probeErr.Error()
	}
	if err := dshPlatformError(); err != nil {
		return err.Error()
	}
	if !engineInstall.allowed {
		return "DSH_NOT_INSTALLED: DeepSeek Harness " + dshSupportedVersion + " is not installed in Orbit's version directory; automatic engine installation is not authorized — install it from Orbit or run `orbit doctor` on this runner"
	}
	if notify != nil {
		notify("Installing DeepSeek Harness " + dshSupportedVersion + " with the frozen P0 package lock.")
	}
	cmdCtx, cancel := context.WithTimeout(ctx, engineInstallTimeout)
	defer cancel()
	if err := installDsh(cmdCtx, engineInstall.proxyVars); err != nil {
		return err.Error()
	}
	if notify != nil {
		notify("DeepSeek Harness installed. Continuing…")
	}
	return ""
}
