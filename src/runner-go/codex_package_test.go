package main

import (
	"os"
	"path/filepath"
	"testing"
)

// A standalone install keeps the binary in <release>/bin, its manifest in <release>, and the rg it ships in
// <release>/codex-path.
func TestInstalledCodexPackageInAStandaloneRelease(t *testing.T) {
	release := t.TempDir()
	exe := writeFakeBin(t, mkdirAll(t, filepath.Join(release, "bin")), "codex", "exit 0")
	if err := os.WriteFile(filepath.Join(release, "codex-package.json"), []byte(`{"version": "0.161.0", "pathDir": "codex-path"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	rg := writeFakeBin(t, mkdirAll(t, filepath.Join(release, "codex-path")), "rg", "exit 0")
	link := filepath.Join(t.TempDir(), "codex")
	if err := os.Symlink(exe, link); err != nil {
		t.Fatal(err)
	}
	pkg, ok := installedCodexPackage(link)
	if !ok || pkg.version != "0.161.0" || pkg.bundledRg() != rg || !pkg.keepsToolsInLoginShell() {
		t.Fatalf("standalone release reads %+v (ok %v), want 0.161.0 with %s", pkg, ok, rg)
	}
	if _, ok := installedCodexPackage(writeFakeBin(t, t.TempDir(), "codex", "exit 0")); ok {
		t.Fatal("a codex outside any package has a manifest")
	}
}

// Orbit turns login_shell_package_path on only for an install with a codex-path and a version that knows the
// feature; a manifest without codex-path, or a version before 0.161.0 or one it cannot read, gets nothing.
func TestCodexPackageKeepsToolsInLoginShellFromTheFeaturesFirstRelease(t *testing.T) {
	for version, want := range map[string]bool{"0.160.0": false, "0.161.0": true, "0.167.0": true, "1.0.0-alpha.2": true, "dev": false} {
		pkg, ok := installedCodexPackage(fakeNpmCodex(t, version, true))
		if !ok || pkg.keepsToolsInLoginShell() != want {
			t.Errorf("codex %s: read %+v (ok %v), keeps tools in a login shell = %v, want %v", version, pkg, ok, pkg.keepsToolsInLoginShell(), want)
		}
	}
	noPathDir := fakeNpmCodex(t, "0.167.0", false)
	native, _ := filepath.Glob(filepath.Join(filepath.Dir(filepath.Dir(noPathDir)), "lib", "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-*", "vendor", "*"))
	if err := os.WriteFile(filepath.Join(native[0], "codex-package.json"), []byte(`{"version": "0.167.0"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if pkg, ok := installedCodexPackage(noPathDir); !ok || pkg.keepsToolsInLoginShell() || pkg.bundledRg() != "" {
		t.Fatalf("a manifest naming no codex-path reads %+v (ok %v)", pkg, ok)
	}
}

// An install that hoists the platform package, `npm install --prefix` or pnpm, puts it beside the codex
// package in the same node_modules, where Node resolves it from the launcher; the global npm install nests it.
func TestInstalledCodexPackageResolvesAHoistedPlatformPackage(t *testing.T) {
	modules := filepath.Join(t.TempDir(), "node_modules")
	launcher := writeFakeBin(t, mkdirAll(t, filepath.Join(modules, "@openai", "codex", "bin")), "codex.js", "exit 0")
	native := mkdirAll(t, filepath.Join(modules, "@openai", "codex-linux-x64", "vendor", "x86_64-unknown-linux-musl"))
	if err := os.WriteFile(filepath.Join(native, "codex-package.json"), []byte(`{"version": "0.166.0", "pathDir": "codex-path"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	rg := writeFakeBin(t, mkdirAll(t, filepath.Join(native, "codex-path")), "rg", "exit 0")
	link := filepath.Join(mkdirAll(t, filepath.Join(modules, ".bin")), "codex")
	if err := os.Symlink(filepath.Join("..", "@openai", "codex", "bin", "codex.js"), link); err != nil {
		t.Fatal(err)
	}
	pkg, ok := installedCodexPackage(link)
	if !ok || pkg.version != "0.166.0" || pkg.bundledRg() != rg || !pkg.keepsToolsInLoginShell() {
		t.Fatalf("hoisted platform package of %s reads %+v (ok %v), want 0.166.0 with %s", launcher, pkg, ok, rg)
	}
}
