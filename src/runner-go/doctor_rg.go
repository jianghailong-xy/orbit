package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"time"
)

// What `orbit doctor` says about ripgrep: whether `rg` resolves in the shell each engine runs a session's
// commands in. The engines tell their models to search with rg, and a model that cannot find it falls back
// to grep and find, spending turns and context on it. Like the other engine lines, it never fails doctor.

// rgShell is how an engine runs a session's commands, as far as finding rg goes.
type rgShell int

const (
	// rgShellPlain: the account's shell, not a login shell, on the PATH the runner gives the engine.
	rgShellPlain rgShell = iota
	// rgShellOwn: the engine brings its own rg. Claude Code's Bash tool defines rg (with grep and find) as
	// a shell function that runs the claude binary, which embeds ripgrep, and its Grep tool runs the same.
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
		return engineRg{checked: true, path: "rg", source: h.spec.name + "'s own"}
	case rgShellCodex:
		login := codexAllowsLoginShell()
		// Without login shells the command inherits Codex's own PATH, codex-path first. A login shell gets it
		// back only from a Codex that knows the feature Orbit turns on.
		if rg := codexBundledRg(h.path); rg != "" && (!login || codexKnowsFeature(h.path, codexLoginShellPackagePathFeature)) {
			return engineRg{checked: true, path: rg, source: "Codex's own"}
		}
		if login {
			return engineRg{checked: true, path: loginShellRg(shell, servicePath), shell: shell + " -l (a login shell)"}
		}
	}
	rg, _ := lookPathIn("rg", servicePath)
	return engineRg{checked: true, path: rg, shell: shell + " on the runner's PATH"}
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

// codexBundledRg is the rg a Codex install ships beside its binary: <package>/codex-path/rg, the directory Codex
// puts on PATH. Codex finds its package from the native binary, which sits in <package>/bin (a standalone
// install's release directory); the npm package's `codex` is a launcher script that runs the binary of the
// platform package installed under it. "" when there is none.
func codexBundledRg(codexPath string) string {
	exe, err := filepath.EvalSymlinks(codexPath)
	if err != nil {
		return ""
	}
	var candidates []string
	if dir := filepath.Dir(exe); filepath.Base(dir) == "bin" {
		candidates = append(candidates, filepath.Join(filepath.Dir(dir), "codex-path", "rg"))
		if strings.HasSuffix(exe, ".js") {
			pkg := filepath.Dir(dir)
			for _, pattern := range []string{
				filepath.Join(pkg, "node_modules", "@openai", "codex-*", "vendor", "*", "codex-path", "rg"),
				filepath.Join(pkg, "vendor", "*", "codex-path", "rg"),
			} {
				matches, _ := filepath.Glob(pattern)
				candidates = append(candidates, matches...)
			}
		}
	}
	for _, rg := range candidates {
		if fi, err := os.Stat(rg); err == nil && !fi.IsDir() && fi.Mode()&0o111 != 0 {
			return rg
		}
	}
	return ""
}

// codexKnowsFeature reports whether the Codex at codexPath lists feature among the ones it knows.
func codexKnowsFeature(codexPath, feature string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, codexPath, "features", "list").Output()
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(out), "\n") {
		if fields := strings.Fields(line); len(fields) > 0 && fields[0] == feature {
			return true
		}
	}
	return false
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
	}
}
