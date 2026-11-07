package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func mkdirAll(t *testing.T, dir string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

// fakeNpmCodex lays a Codex install out the way npm does: the `codex` on PATH links to the launcher in the
// package's bin/, and the platform package sits in its node_modules with the manifest Codex reads,
// codex-package.json, saying version and naming codex-path, which holds rg when bundledRg. It returns the
// `codex` on PATH.
func fakeNpmCodex(t *testing.T, version string, bundledRg bool) string {
	t.Helper()
	root := t.TempDir()
	pkg := filepath.Join(root, "lib", "node_modules", "@openai", "codex")
	launcher := writeFakeBin(t, mkdirAll(t, filepath.Join(pkg, "bin")), "codex.js", "exit 0")
	native := mkdirAll(t, filepath.Join(pkg, "node_modules", "@openai", "codex-linux-x64", "vendor", "x86_64-unknown-linux-musl"))
	manifest := `{"layoutVersion": 1, "version": "` + version + `", "entrypoint": "bin/codex", "pathDir": "codex-path"}`
	if err := os.WriteFile(filepath.Join(native, "codex-package.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	pathDir := mkdirAll(t, filepath.Join(native, "codex-path"))
	if bundledRg {
		writeFakeBin(t, pathDir, "rg", "exit 0")
	}
	link := filepath.Join(mkdirAll(t, filepath.Join(root, "bin")), "codex")
	if err := os.Symlink(launcher, link); err != nil {
		t.Fatal(err)
	}
	return link
}

// pathResettingLoginShell makes $SHELL a shell whose login profile assigns PATH outright, the way Debian's
// /etc/profile does, to loginPath; without -l it keeps the PATH it was given.
func pathResettingLoginShell(t *testing.T, loginPath string) {
	t.Helper()
	fakeLoginShell(t, `if [ "$1" = "-l" ]; then PATH='`+loginPath+`'; export PATH; shift; fi
[ "$1" = "-c" ] && exec /bin/sh -c "$2"`)
}

func installedEngine(t *testing.T, bin, path string) engineHealth {
	t.Helper()
	spec, ok := specFor(bin)
	if !ok {
		t.Fatalf("no engine %s", bin)
	}
	return engineHealth{spec: spec, installed: true, path: path, version: "1.0.0", auth: authYes, onServicePath: true}
}

// An engine that runs commands in a plain shell finds rg only on the runner's PATH. Without one there, doctor says
// so on that engine's line, says what to install, and does not call the machine all set.
func TestDoctorFlagsAnEngineWhoseShellHasNoRg(t *testing.T) {
	t.Setenv("SHELL", "/bin/bash")
	servicePath := t.TempDir()
	h := installedEngine(t, providerKimi, "/opt/kimi/bin/kimi")
	h.rg = checkEngineRg(h, servicePath)
	if !h.rg.checked || h.rg.path != "" {
		t.Fatalf("rg on a PATH without one = %+v, want checked and not found", h.rg)
	}
	out := captureRunnerStdout(t, func() { printEngineRg([]engineHealth{h}) })
	for _, want := range []string{
		"Search (rg) in each engine's command shell:",
		"✗ Kimi Code — rg not found in /bin/bash on the runner's PATH",
		"Agents on an engine marked ✗ fall back to grep and find",
		"sudo apt install ripgrep",
		"brew install ripgrep",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("doctor printed:\n%s\nwant %q", out, want)
		}
	}
	if hints := captureRunnerStdout(t, func() { printEngineHints([]engineHealth{h}) }); strings.Contains(hints, "All set") {
		t.Fatalf("an engine without rg is called all set:\n%s", hints)
	}

	rg := writeFakeBin(t, servicePath, "rg", "exit 0")
	h.rg = checkEngineRg(h, servicePath)
	if h.rg.path != rg {
		t.Fatalf("rg on the runner's PATH resolved to %q, want %q", h.rg.path, rg)
	}
	out = captureRunnerStdout(t, func() { printEngineRg([]engineHealth{h}) })
	if !strings.Contains(out, "✓ Kimi Code — "+rg+"\n") || strings.Contains(out, "Install ripgrep") {
		t.Fatalf("with rg on the runner's PATH doctor printed:\n%s", out)
	}
	if hints := captureRunnerStdout(t, func() { printEngineHints([]engineHealth{h}) }); !strings.Contains(hints, "All set") {
		t.Fatalf("with rg found everywhere, doctor is not all set:\n%s", hints)
	}
}

// Claude Code's commands find the rg built into the claude binary where the PATH has none, and the PATH's rg where
// it has one; an engine that is not installed gets no line at all.
func TestDoctorClaudeCodeBringsItsOwnRg(t *testing.T) {
	h := installedEngine(t, providerClaude, "/opt/claude/bin/claude")
	servicePath := t.TempDir()
	h.rg = checkEngineRg(h, servicePath)
	if got := formatEngineRgLine(h); got != "✓ Claude Code — Claude Code's own rg" {
		t.Fatalf("line = %q", got)
	}
	rg := writeFakeBin(t, servicePath, "rg", "exit 0")
	h.rg = checkEngineRg(h, servicePath)
	if got := formatEngineRgLine(h); got != "✓ Claude Code — "+rg {
		t.Fatalf("with rg on the runner's PATH the line = %q", got)
	}
	missing, _ := specFor(providerOpenCode)
	if rg := checkEngineRg(engineHealth{spec: missing}, t.TempDir()); rg.checked {
		t.Fatalf("an engine that is not installed was checked: %+v", rg)
	}
}

// Codex's commands find the rg its package ships, ahead of anything else: Codex puts codex-path first on its own
// PATH, and puts it back in a login shell for a Codex that knows login_shell_package_path, which Orbit turns on.
func TestDoctorFindsCodexsOwnRg(t *testing.T) {
	pathResettingLoginShell(t, t.TempDir())
	t.Setenv("CODEX_HOME", t.TempDir())
	codex := fakeNpmCodex(t, "0.167.0", true)
	h := installedEngine(t, providerCodex, codex)
	h.rg = checkEngineRg(h, t.TempDir())
	if !strings.HasSuffix(h.rg.path, filepath.Join("vendor", "x86_64-unknown-linux-musl", "codex-path", "rg")) {
		t.Fatalf("Codex's rg = %q, want its package's codex-path/rg", h.rg.path)
	}
	if got := formatEngineRgLine(h); got != "✓ Codex — "+h.rg.path+" (Codex's own)" {
		t.Fatalf("line = %q", got)
	}
}

// A Codex that cannot put its rg back after the login profile — none bundled, or a version without the feature —
// runs commands in a plain login shell, so doctor asks one: a profile that resets PATH loses the runner's rg.
func TestDoctorAsksALoginShellForCodexWithoutItsOwnRg(t *testing.T) {
	t.Setenv("CODEX_HOME", t.TempDir())
	servicePath := t.TempDir()
	writeFakeBin(t, servicePath, "rg", "exit 0")
	loginDir := t.TempDir()
	pathResettingLoginShell(t, loginDir)
	for name, codex := range map[string]string{
		"no bundled rg":                   fakeNpmCodex(t, "0.167.0", false),
		"a version before the feature":    fakeNpmCodex(t, "0.160.0", true),
		"a version it cannot read at all": fakeNpmCodex(t, "dev", true),
	} {
		h := installedEngine(t, providerCodex, codex)
		h.rg = checkEngineRg(h, servicePath)
		if h.rg.path != "" || !strings.Contains(formatEngineRgLine(h), "rg not found in "+os.Getenv("SHELL")+" -l (a login shell)") {
			t.Fatalf("%s: the login shell resets PATH, yet doctor reads %+v: %q", name, h.rg, formatEngineRgLine(h))
		}
	}
	// The login shell's own PATH is what counts: an rg there is found.
	loginRg := writeFakeBin(t, loginDir, "rg", "exit 0")
	h := installedEngine(t, providerCodex, fakeNpmCodex(t, "0.167.0", false))
	if h.rg = checkEngineRg(h, servicePath); h.rg.path != loginRg {
		t.Fatalf("rg on the login shell's PATH resolved to %q, want %q", h.rg.path, loginRg)
	}
}

// With login shells off in its config, Codex runs commands in a plain shell on its own PATH: codex-path first,
// then the runner's.
func TestDoctorCodexWithoutLoginShells(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte("allow_login_shell = false\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	pathResettingLoginShell(t, t.TempDir())
	servicePath := t.TempDir()
	rg := writeFakeBin(t, servicePath, "rg", "exit 0")
	h := installedEngine(t, providerCodex, fakeNpmCodex(t, "0.160.0", false))
	if h.rg = checkEngineRg(h, servicePath); h.rg.path != rg {
		t.Fatalf("without login shells Codex's rg = %q, want the runner's %q", h.rg.path, rg)
	}
	h = installedEngine(t, providerCodex, fakeNpmCodex(t, "0.160.0", true))
	if h.rg = checkEngineRg(h, t.TempDir()); h.rg.source != "Codex's own" {
		t.Fatalf("without login shells codex-path still comes first: %+v", h.rg)
	}
}

func TestCodexAllowsLoginShellReadsTheTopLevelKey(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CODEX_HOME", home)
	for config, want := range map[string]bool{
		"":                            true,
		"allow_login_shell = false\n": false,
		"allow_login_shell=false # off\nmodel = 1":                 false,
		"allow_login_shell = true\n":                               true,
		"model = \"x\"\n[profiles.p]\nallow_login_shell = false\n": true,
	} {
		if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(config), 0o600); err != nil {
			t.Fatal(err)
		}
		if got := codexAllowsLoginShell(); got != want {
			t.Errorf("config %q: allows login shells = %v, want %v", config, got, want)
		}
	}
}
