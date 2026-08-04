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

// Install relay statuses reported to the control plane. They mirror the `install_status` column.
const (
	installInstalling = "installing"
	installDone       = "done"
	installFailed     = "failed"
)

// installRelay drives one browser-requested engine install on this machine.
//
// One at a time, and — unlike the sign-in relay — a second request never preempts the first:
// killing `curl … | bash` halfway leaves a worse machine than letting it finish, and the server
// times the row out on its own. A redelivered request while one is running is a no-op.
type installRelay struct {
	mu      sync.Mutex
	wg      sync.WaitGroup
	running bool
}

// start runs the install for `engine` and reports progress through `report`, which is called off
// the heartbeat goroutine (the installer takes minutes). `after` runs once the outcome is
// reported, so the caller can re-probe what actually ended up on disk.
func (r *installRelay) start(engine string, report func(InstallResultRequest), after func()) {
	spec, ok := specFor(engine)
	if !ok {
		report(InstallResultRequest{Status: installFailed, Message: "unknown engine: " + engine})
		return
	}
	r.mu.Lock()
	if r.running {
		r.mu.Unlock()
		return // redelivered, or a second request while this one is still installing
	}
	r.running = true
	r.wg.Add(1)
	r.mu.Unlock()

	go func() {
		defer r.wg.Done()
		defer func() {
			r.mu.Lock()
			r.running = false
			r.mu.Unlock()
			if after != nil {
				after()
			}
		}()
		// Publish what is about to run before running it: the install takes minutes, and the row
		// showing the exact command is what makes the wait (and any failure) legible.
		report(InstallResultRequest{Status: installInstalling, Command: spec.installCmd})
		report(installEngineNow(spec))
	}()
}

// startUpdate runs the browser-requested "update every engine on this machine" through the same
// one slot as an install: both drive a package manager against this machine's single global
// prefix, so they must not overlap — and the same redelivery guard applies.
//
// Unlike the daily loop this one has a person waiting, so what it skipped is reported rather than
// only logged: an engine left alone because a session is mid-turn looks identical to one the
// button silently missed.
func (r *installRelay) startUpdate(activeCount func(string) int, proxyVars []envVar, report func(InstallResultRequest), after func()) {
	r.mu.Lock()
	if r.running {
		r.mu.Unlock()
		return // redelivered, or an install is still running
	}
	r.running = true
	r.wg.Add(1)
	r.mu.Unlock()

	go func() {
		defer r.wg.Done()
		defer func() {
			r.mu.Lock()
			r.running = false
			r.mu.Unlock()
			if after != nil {
				after()
			}
		}()
		report(InstallResultRequest{Status: installInstalling, Command: engineUpdateManualCmd})
		lines := updateEngines(context.Background(), activeCount, proxyVars)
		res := InstallResultRequest{Status: installDone, Command: engineUpdateManualCmd}
		if len(lines) == 0 {
			// Nothing on PATH to update. Saying "done" with no detail would read as success.
			res.Message = "No engine CLIs are installed on this machine yet."
		} else {
			res.Message = strings.Join(lines, "\n")
		}
		// One engine's failure is the whole run's news — the per-engine detail is in the rows
		// below, but the panel must not say "done" when something needs a human.
		for _, l := range lines {
			if strings.Contains(l, "update failed") || strings.Contains(l, "timed out") {
				res.Status = installFailed
				break
			}
		}
		report(res)
	}()
}

// The command that does by hand what the Update button does, shown in the panel so a machine
// with a broken relay is still fixable from a terminal.
const engineUpdateManualCmd = "orbit engine-update"

// configureEngineCommandTree makes a package-manager command killable as a whole.
//
// Every engine install/update runs as `sh -c "<installer>"`, and installers fork: npm spawns
// node, `curl … | bash` spawns whatever it downloaded, `opencode upgrade` spawns its own
// updater. exec.CommandContext kills only the `sh`, so on timeout the real work is reparented
// to init and keeps running — and because it inherited the output pipe, CombinedOutput never
// returns. The timeout is then decorative and the caller holds engineInstall.mu forever.
//
// Reuses the session runtime's process-tree teardown: same problem (a CLI whose descendants
// escape their parent), same fix, and it already handles children that start a process group
// of their own. WaitDelay is the backstop — if something still escapes, the pipe is force-closed
// and the call returns instead of hanging the machine's only package-manager slot.
func configureEngineCommandTree(cmd *exec.Cmd) { configureSessionProcessTree(cmd) }

// stop waits for an install already under way. Nothing is cancelled — see the type comment.
func (r *installRelay) stop() { r.wg.Wait() }

// installEngineNow runs one engine's recommended installer and reports what happened.
//
// Same command ensureEngine uses, minus the register-time consent gate: pressing Install in the
// browser IS that consent, for this engine on this machine, so a runner that declined blanket
// auto-install can still be fixed from the UI instead of only from a terminal on that box.
func installEngineNow(spec engineSpec) InstallResultRequest {
	// Serialise with the on-demand installer: two package managers against the same global
	// prefix at once is exactly what this lock exists to prevent.
	engineInstall.mu.Lock()
	proxyVars := engineInstall.proxyVars
	defer engineInstall.mu.Unlock()
	// Whoever got here first may have already installed it.
	if _, ok := lookEngine(spec.bin); ok {
		return InstallResultRequest{Status: installDone, Command: spec.installCmd}
	}

	logln("engine-install (requested):", spec.name, "->", spec.installCmd)
	ctx, cancel := context.WithTimeout(context.Background(), engineInstallTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "sh", "-c", spec.installCmd)
	cmd.Env = append(os.Environ(), "PATH="+serviceLoginPath())
	for _, v := range proxyVars {
		cmd.Env = append(cmd.Env, v.K+"="+v.V)
	}
	// See configureEngineCommandTree: an installer that forks outlives the `sh` the context
	// kills, and its open pipe would hold this timeout — and the lock above — open forever.
	configureEngineCommandTree(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		logln("engine-install (requested):", spec.name, "failed:", firstLine(err.Error()), lastLine(string(out)))
		return InstallResultRequest{
			Status:  installFailed,
			Command: spec.installCmd,
			// The machine's own last words plus the alternative to run by hand — a failed
			// install is only actionable from a browser if both make it back.
			Message: firstLine(err.Error()) + ": " + lastLine(string(out)) +
				"\nTry instead: " + spec.installAlt,
		}
	}
	path, ok := lookEngine(spec.bin)
	if !ok {
		logln("engine-install (requested):", spec.name, "installer exited 0 but the binary is still not on PATH")
		return InstallResultRequest{
			Status:  installFailed,
			Command: spec.installCmd,
			Message: "the installer finished but `" + spec.bin + "` still isn't on this machine's service PATH.\nTry instead: " + spec.installAlt,
		}
	}
	logln("engine-install (requested):", spec.name, "installed at", path)
	// The runner's own PATH was fixed when the service started, and sessions exec the engine by
	// name — so make the new binary's dir visible to everything spawned next (cf. ensureEngine).
	if dir := filepath.Dir(path); !pathContains(os.Getenv("PATH"), dir) {
		_ = os.Setenv("PATH", dir+":"+os.Getenv("PATH"))
	}
	return InstallResultRequest{Status: installDone, Command: spec.installCmd}
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
	// This one is on a session's first turn: a forked installer that outlives its `sh` would
	// hold the turn open past the timeout meant to bound it. See configureEngineCommandTree.
	configureEngineCommandTree(cmd)
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

// engineAuthPreflight reports why a session can't run on this machine's engine login,
// or "" when it can. Returns "" for anything ambiguous: refusing to spawn on a probe
// that couldn't answer would be worse than letting the CLI try.
//
// Skipped when the session brings its own credentials — a configured provider injects an
// API key, and the CLI's local login is then irrelevant, so its "signed out" answer would
// fail a session that works perfectly.
func engineAuthPreflight(bin string, agentEnv map[string]string) string {
	// OpenCode can use local providers that need no credential and provider-specific
	// environment variables unknown to Orbit. Let the CLI decide at execution time.
	if bin == providerOpenCode {
		return ""
	}
	if hasInjectedCredentials(bin, agentEnv) {
		return ""
	}
	path, ok := lookEngine(bin)
	if !ok {
		return "" // ensureEngine already had its say about a missing binary
	}
	if probeAuth(bin, path) == authNo {
		return engineSignedOutMessage(bin)
	}
	return ""
}

// hasInjectedCredentials reports whether this session carries provider credentials of its
// own (a ModelProvider row's API key, or an account-level token), which the runner layers
// onto the engine's environment — see envWithAgent / codexProviderArgs.
func hasInjectedCredentials(bin string, agentEnv map[string]string) bool {
	keys := []string{"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN"}
	switch bin {
	case providerCodex:
		keys = []string{"OPENAI_API_KEY", "OPENAI_BASE_URL"}
	case providerKimi:
		// Kimi only activates its environment-backed provider when both the
		// model-name switch and API key are present. Conventional KIMI_API_KEY
		// is config-file-only and must not suppress the local-login preflight. Use
		// the same Agent-over-process layering as the Kimi child process itself.
		return kimiUsesEnvModel(agentEnv)
	case providerOpenCode:
		// OpenCode resolves per-provider credentials itself, from its own auth store
		// and provider-specific environment variables Orbit does not model.
		return false
	}
	for _, k := range keys {
		if strings.TrimSpace(agentEnv[k]) != "" {
			return true
		}
	}
	return false
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
