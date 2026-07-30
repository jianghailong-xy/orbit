package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// On-demand engine install: the CLI a session needs is installed the first time a
// session actually needs it, rather than at `orbit register`, where we don't yet know
// which engines this machine's agents will use.
//
// The consent for it is collected once, at register time (RunnerConfig.AutoInstallEngines),
// because this runs unattended — there is nobody at a terminal to approve `npm i -g` or
// `curl | bash` at the moment a session claims the runner.

// An install is a network fetch plus a package manager; generous, but bounded so a wedged
// installer can't hold a session's first turn open indefinitely.
const engineInstallTimeout = 10 * time.Minute

// engineInstall carries what a runtime install needs, configured once at startup from the
// runner's config. Zero value = not allowed, which is what an older config (registered
// before the question was asked) correctly gets.
var engineInstall struct {
	// Serialises installs: two sessions claiming a runner at once would otherwise run
	// two `npm i -g` against the same prefix.
	mu        sync.Mutex
	allowed   bool
	proxyVars []envVar
}

func configureEngineInstall(allowed bool, proxyVars []envVar) {
	engineInstall.mu.Lock()
	defer engineInstall.mu.Unlock()
	engineInstall.allowed, engineInstall.proxyVars = allowed, proxyVars
}

// ensureEngine makes `bin` runnable for a session about to spawn, installing it if this
// runner is allowed to and it isn't there yet. `notify` reports progress into the session
// transcript — an install takes tens of seconds, and silence would read as a hung turn.
//
// Returns "" when the engine is ready, else the message to fail the session with.
func ensureEngine(ctx context.Context, bin string, notify func(string)) string {
	if _, ok := lookEngine(bin); ok {
		return ""
	}
	engineInstall.mu.Lock()
	allowed, proxyVars := engineInstall.allowed, engineInstall.proxyVars
	engineInstall.mu.Unlock()
	if !allowed {
		return engineMissingMessage(bin)
	}
	spec, ok := specFor(bin)
	if !ok {
		return engineMissingMessage(bin)
	}

	engineInstall.mu.Lock()
	defer engineInstall.mu.Unlock()
	// Re-check under the lock: a session that queued behind another one's install of the
	// same engine has nothing left to do.
	if _, ok := lookEngine(bin); ok {
		return ""
	}

	notify("Installing " + spec.name + " on this runner (" + spec.installCmd + ") — first session that needs it.")
	logln("engine-install:", spec.name, "->", spec.installCmd)
	cmdCtx, cancel := context.WithTimeout(ctx, engineInstallTimeout)
	defer cancel()
	cmd := exec.CommandContext(cmdCtx, "sh", "-c", spec.installCmd)
	cmd.Env = append(os.Environ(), "PATH="+serviceLoginPath())
	for _, v := range proxyVars {
		cmd.Env = append(cmd.Env, v.K+"="+v.V)
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		logln("engine-install:", spec.name, "failed:", firstLine(err.Error()), lastLine(string(out)))
		return spec.name + " isn't installed on this runner and installing it failed (" +
			firstLine(err.Error()) + ") — run `orbit doctor` on that machine. Tried:  " + spec.installCmd
	}
	path, ok := lookEngine(bin)
	if !ok {
		logln("engine-install:", spec.name, "installer exited 0 but the binary is still not on PATH")
		return spec.name + " was installed on this runner but its binary still isn't on the service PATH — run `orbit doctor` on that machine."
	}
	logln("engine-install:", spec.name, "installed at", path)
	// The runner's own PATH was fixed when the service started, and sessions exec the
	// engine by name — so make the new binary's dir visible to everything spawned next.
	if dir := filepath.Dir(path); !pathContains(os.Getenv("PATH"), dir) {
		_ = os.Setenv("PATH", dir+":"+os.Getenv("PATH"))
	}
	// A just-installed CLI has no credentials, and the sign-in needs a human. Say so as an
	// authentication failure so the web transcript offers its sign-in card instead of a
	// bare error line.
	if probeAuth(bin, path) == authNo {
		return engineSignedOutMessage(bin)
	}
	notify(spec.name + " installed. Continuing…")
	return ""
}

// lookEngine resolves an engine binary the way the runner will actually exec it: the
// service PATH first (which includes ~/.local/bin, where installers drop binaries this
// process's own PATH may predate), then this process's PATH.
func lookEngine(bin string) (string, bool) {
	if p, ok := lookPathIn(bin, serviceLoginPath()); ok {
		return p, true
	}
	return lookPathIn(bin, os.Getenv("PATH"))
}

func lastLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.LastIndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[i+1:])
	}
	return s
}
