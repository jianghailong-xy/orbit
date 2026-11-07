package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// codexLoginShellPackagePathFloor is the first codex release that knows login_shell_package_path. An older one
// ignores the override, and says so in two ERROR lines on stderr, which a session's transcript shows as errors.
const codexLoginShellPackagePathFloor = "0.161.0"

// codexPackage is what a Codex install's own manifest says of it: codex-package.json, in the package directory
// above the native binary's bin/, which is the file Codex itself reads to find the tools it ships.
type codexPackage struct {
	version string
	// pathDir is the directory Codex puts first on PATH (codex-path, where its rg is); "" when the manifest names
	// none or it is not there.
	pathDir string
}

// installedCodexPackage reads the manifest of the Codex install that codexPath, a `codex` on PATH, runs. A native
// binary sits in <package>/bin, as in a standalone install's release directory; the npm package's `codex` is a
// launcher script that runs the binary of the platform package Node resolves from it: nested under the package
// (a global npm install), or beside it in the same node_modules (an install that hoists it, pnpm's too).
func installedCodexPackage(codexPath string) (codexPackage, bool) {
	exe, err := filepath.EvalSymlinks(codexPath)
	if err != nil {
		return codexPackage{}, false
	}
	bin := filepath.Dir(exe)
	if filepath.Base(bin) != "bin" {
		return codexPackage{}, false
	}
	candidates := []string{filepath.Dir(bin)}
	if strings.HasSuffix(exe, ".js") {
		pkg := filepath.Dir(bin)
		for _, pattern := range []string{
			filepath.Join(pkg, "node_modules", "@openai", "codex-*", "vendor", "*"),
			filepath.Join(filepath.Dir(pkg), "codex-*", "vendor", "*"),
			filepath.Join(pkg, "vendor", "*"),
		} {
			matches, _ := filepath.Glob(pattern)
			candidates = append(candidates, matches...)
		}
	}
	for _, dir := range candidates {
		data, err := os.ReadFile(filepath.Join(dir, "codex-package.json"))
		if err != nil {
			continue
		}
		var manifest struct {
			Version string `json:"version"`
			PathDir string `json:"pathDir"`
		}
		if json.Unmarshal(data, &manifest) != nil || manifest.Version == "" {
			continue
		}
		pkg := codexPackage{version: manifest.Version}
		if manifest.PathDir != "" {
			if fi, err := os.Stat(filepath.Join(dir, manifest.PathDir)); err == nil && fi.IsDir() {
				pkg.pathDir = filepath.Join(dir, manifest.PathDir)
			}
		}
		return pkg, true
	}
	return codexPackage{}, false
}

// keepsToolsInLoginShell reports whether this install has a codex-path to put back on a login shell's PATH and
// knows the feature that does it: only then does codexLoginShellPackagePathConfig do anything, and only then is it
// not an unknown key.
func (p codexPackage) keepsToolsInLoginShell() bool {
	// claudeVersionAtLeast is a plain dotted-version compare (claude_setconfig.go), good for any CLI's version.
	return p.pathDir != "" && claudeVersionAtLeast(p.version, codexLoginShellPackagePathFloor)
}

// bundledRg is the rg in this install's codex-path, "" when it ships none.
func (p codexPackage) bundledRg() string {
	if p.pathDir == "" {
		return ""
	}
	rg := filepath.Join(p.pathDir, "rg")
	if fi, err := os.Stat(rg); err == nil && !fi.IsDir() && fi.Mode()&0o111 != 0 {
		return rg
	}
	return ""
}
