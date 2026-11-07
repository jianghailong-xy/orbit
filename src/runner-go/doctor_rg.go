package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
)

// What `orbit doctor` says about ripgrep: whether `rg` resolves in the shell each engine runs a session's
// commands in. The engines tell their models to search with rg, and a model that cannot find it falls back
// to grep and find, spending turns and context on it. Like the other engine lines, it never fails doctor.

// rgShell is how an engine runs a session's commands, as far as finding rg goes.
type rgShell int

const (
	// rgShellPlain: the account's shell, not a login shell, on the PATH the runner gives the engine.
	rgShellPlain rgShell = iota
	// rgShellOwn: the engine brings its own rg where the PATH has none. Claude Code's Bash tool then defines
	// rg as a shell function that runs the claude binary, which embeds ripgrep; with an rg on the PATH, its
	// commands resolve that one (both seen in real sessions on HPC, before and after ripgrep was installed).
	rgShellOwn
	// rgShellCodex: a login shell of the account's shell, unless the Codex config turns login shells off,
	// with Codex's codex-path directory first on PATH either way: Codex puts it on its own PATH, and
	// codexLoginShellPackagePathConfig has it put back after a login profile resets PATH.
	rgShellCodex
)

func engineRgShell(bin string) rgShell {
	switch bin {
	case providerClaude:
		return rgShellOwn
	case providerCodex:
		return rgShellCodex
	default:
		return rgShellPlain
	}
}

// engineRg is what doctor found for one engine.
type engineRg struct {
	checked bool   // the engine is installed, so its shell was asked
	path    string // where rg resolved there; "" when it did not
	source  string // where that rg comes from when the engine brings it, for the line
	shell   string // the shell it was looked up in, for a line saying rg is missing
}

// checkEngineRg asks the shell h's engine runs commands in whether rg resolves there.
func checkEngineRg(h engineHealth, servicePath string) engineRg {
	if !h.installed {
		return engineRg{}
	}
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	switch engineRgShell(h.spec.bin) {
	case rgShellOwn:
		if rg, ok := lookPathIn("rg", servicePath); ok {
			return engineRg{checked: true, path: rg, source: managedRgSource(rg)}
		}
		return engineRg{checked: true, path: "rg", source: h.spec.name + "'s own"}
	case rgShellCodex:
		login := codexAllowsLoginShell()
		// Without login shells the command inherits Codex's own PATH, codex-path first. A login shell gets it
		// back only from a Codex Orbit turns login_shell_package_path on for (codexKeepsToolsInLoginShell).
		pkg, _ := installedCodexPackage(h.path)
		if rg := pkg.bundledRg(); rg != "" && (!login || pkg.keepsToolsInLoginShell()) {
			return engineRg{checked: true, path: rg, source: "Codex's own"}
		}
		if login {
			rg := loginShellRg(shell, servicePath)
			return engineRg{checked: true, path: rg, source: managedRgSource(rg), shell: shell + " -l (a login shell)"}
		}
	}
	rg, _ := lookPathIn("rg", servicePath)
	return engineRg{checked: true, path: rg, source: managedRgSource(rg), shell: shell + " on the runner's PATH"}
}

// managedRgSource names Orbit's own rg (managed_rg.go) when that is the rg at path, which the runner's PATH reaches
// only where nothing before it has one.
func managedRgSource(path string) string {
	if rg, err := managedRgPath(); err == nil && path == rg {
		return "Orbit's own"
	}
	return ""
}

// loginShellRg is what `command -v rg` prints in shell as a login shell, on the account's own home and the
// runner's PATH — what a login profile then does with that PATH is the point of asking. "" when rg does not
// resolve, or the shell does not answer within the bound the runner's own login-shell probe has.
func loginShellRg(shell, servicePath string) string {
	ctx, cancel := context.WithTimeout(context.Background(), loginPathTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, shell, "-l", "-c", "command -v rg")
	env := envWithValue(os.Environ(), "PATH", servicePath)
	if u, err := user.Current(); err == nil && u.HomeDir != "" {
		env = envWithValue(env, "HOME", u.HomeDir)
	}
	cmd.Env = env
	// Its own process group, so the timeout also ends whatever the profile started (see loginPath).
	configureSessionProcessTree(cmd)
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return lastNonEmptyLine(string(out))
}

// codexAllowsLoginShell reads allow_login_shell from the Codex config the account's Codex reads, true unless
// it says false: Codex's own default. Only a top-level key counts, which is where the setting lives.
func codexAllowsLoginShell() bool {
	home, err := effectiveCodexHome(os.Environ(), "/")
	if err != nil {
		return true
	}
	data, err := os.ReadFile(filepath.Join(home, "config.toml"))
	if err != nil {
		return true
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "[") {
			break
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok || strings.TrimSpace(key) != "allow_login_shell" {
			continue
		}
		value, _, _ = strings.Cut(value, "#")
		return strings.TrimSpace(value) != "false"
	}
	return true
}

func formatEngineRgLine(h engineHealth) string {
	if h.rg.path == "" {
		return fmt.Sprintf("✗ %s — rg not found in %s", h.spec.name, h.rg.shell)
	}
	if h.rg.source != "" && h.rg.path == "rg" {
		return fmt.Sprintf("✓ %s — %s rg", h.spec.name, h.rg.source)
	}
	if h.rg.source != "" {
		return fmt.Sprintf("✓ %s — %s (%s)", h.spec.name, h.rg.path, h.rg.source)
	}
	return fmt.Sprintf("✓ %s — %s", h.spec.name, h.rg.path)
}

// printEngineRg is doctor's search section: a line for each installed engine, and what to do when any of
// them is without rg.
func printEngineRg(healths []engineHealth) {
	printed, missing := false, false
	for _, h := range healths {
		if !h.rg.checked {
			continue
		}
		if !printed {
			fmt.Println("\nSearch (rg) in each engine's command shell:")
			printed = true
		}
		fmt.Printf("  %s\n", formatEngineRgLine(h))
		missing = missing || h.rg.path == ""
	}
	if missing {
		fmt.Println("  Agents on an engine marked ✗ fall back to grep and find. Install ripgrep with the system's")
		fmt.Println("  package manager, which puts it where the runner's PATH and a login shell both look:")
		fmt.Println("    sudo apt install ripgrep   (Debian, Ubuntu)")
		fmt.Println("    sudo dnf install ripgrep   (Fedora)")
		fmt.Println("    brew install ripgrep       (macOS)")
		if _, err := managedRgPath(); errors.Is(err, errManagedRgMissing) {
			fmt.Println("  Orbit's own ripgrep, which goes last on every engine's PATH, is not installed here: the runner")
			fmt.Println("  installs it only where it may install engines by itself (`orbit register` without")
			fmt.Println("  --no-auto-install-engines).")
		}
	}
}
