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

// How long "can this engine run at all?" gets, and how long its second, patient ask gets. See
// engineRunnable for why the answer is asked twice.
const (
	engineStartsProbe     = 5 * time.Second
	engineStartsProbeSlow = 20 * time.Second
)

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
// Unlike the loop's scheduled pass, this one has a person waiting, so what it skipped is reported
// rather than only logged: an engine left alone because a session is mid-turn looks identical to
// one the button silently missed.
//
// onEngineUpdated is updateEngines' contract, passed straight through: the button is a third way an
// engine's version moves on this machine, and the model list that came with the new version must
// not be the one path that waits for the catalog ticker.
func (r *installRelay) startUpdate(activeCount func(string) int, proxyVars []envVar, report func(InstallResultRequest), after func(), onEngineUpdated func()) {
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
		lines := updateEnginesFn(context.Background(), activeCount, proxyVars, onEngineUpdated)
		res := InstallResultRequest{Status: installDone, Command: engineUpdateManualCmd}
		if len(lines) == 0 {
			// Nothing on PATH to update. Saying "done" with no detail would read as success.
			res.Message = "No engine CLIs are installed on this machine yet."
		} else {
			res.Message = strings.Join(lines, "\n")
		}
		if updateRunFailed(lines) {
			res.Status = installFailed
		}
		report(res)
	}()
}

// The command that does by hand what the Update button does, shown in the panel so a machine
// with a broken relay is still fixable from a terminal.
const engineUpdateManualCmd = "orbit engine-update"

// updateEnginesFn is updateEngines behind one level of indirection, so the relay's own reporting
// — progress first, then a verdict derived from what the pass said — can be exercised without
// executing a package manager on whatever machine runs the tests. Never reassigned in production.
var updateEnginesFn = updateEngines

// updateRunFailed is the whole pass's verdict, read back off the lines it produced.
//
// One engine's failure is the run's news: the per-engine detail lands on rows the card with the
// button doesn't show, so a run reported "done" with a failure buried in its body goes silent
// about an engine that has stopped being updated. The deliberate outcomes — busy, package-managed,
// not ours, out of budget — are not failures; retrying them changes nothing, and a warning every
// pass about a choice Orbit made is how a real warning gets tuned out.
func updateRunFailed(lines []string) bool {
	for _, l := range lines {
		if strings.Contains(l, "update failed") || strings.Contains(l, "timed out") {
			return true
		}
	}
	return false
}

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
	if spec.bin == providerDsh {
		ctx, cancel := context.WithTimeout(context.Background(), engineInstallTimeout)
		defer cancel()
		if err := installDsh(ctx, proxyVars); err != nil {
			return InstallResultRequest{Status: installFailed, Command: spec.installCmd, Message: err.Error()}
		}
		return InstallResultRequest{Status: installDone, Command: spec.installCmd}
	}
	// Whoever got here first may have already installed it — but "there" is not "working", and a
	// binary that is present and cannot run is the one case this button exists to fix. Answering
	// "done" for it is how a damaged engine stays damaged: nothing else in Orbit runs an installer
	// for an engine it can find.
	if path, ok := lookEngine(spec.bin); ok && engineRunnableAt(path) {
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
			Message: "the installer finished but `" + spec.executable() + "` still isn't on this machine's service PATH.\nTry instead: " + spec.installAlt,
		}
	}
	if !engineRunnable(spec.bin) {
		// The repair was the point of running this installer, so a binary that still cannot run is
		// the one outcome that must not be reported as done.
		logln("engine-install (requested):", spec.name, "installer exited 0 but the binary does not run at", path)
		return InstallResultRequest{
			Status:  installFailed,
			Command: spec.installCmd,
			Message: "the installer finished but `" + spec.executable() + "` (" + path + ") does not run on this machine.\nTry instead: " + spec.installAlt,
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
	if bin == providerDsh {
		return ensureDsh(ctx, notify)
	}
	if engineRunnable(bin) {
		return ""
	}
	// Present but unrunnable is a different machine from one that never had this engine, and it
	// gets a different answer: the session cannot repair a damaged CLI, and "not installed" would
	// send whoever reads it looking for the wrong thing.
	_, installed := lookEngine(bin)
	engineInstall.mu.Lock()
	allowed, proxyVars := engineInstall.allowed, engineInstall.proxyVars
	engineInstall.mu.Unlock()
	if !allowed {
		if installed {
			return engineUnrunnableMessage(bin)
		}
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
	if engineRunnable(bin) {
		return ""
	}
	_, installed = lookEngine(bin)

	if installed {
		// The installer is the repair: a binary that is present and cannot run is replaced by
		// running it, and saying "reinstalling" is the difference between a session that looks
		// stuck and one that explains itself.
		notify("Reinstalling " + spec.name + " on this runner (" + spec.installCmd + ") — the installed binary does not run.")
	} else {
		notify("Installing " + spec.name + " on this runner (" + spec.installCmd + ") — first session that needs it.")
	}
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
	if !engineRunnableAt(path) {
		// The installer ran and left nothing this machine can exec — the one outcome an installer
		// exit code cannot tell you about, and the reason this question is asked here at all.
		logln("engine-install:", spec.name, "installer exited 0 but the binary does not run at", path)
		return spec.name + " was installed on this runner (" + path + ") but does not run — run `orbit doctor` on that machine."
	}
	logln("engine-install:", spec.name, "installed at", path)
	// The runner's own PATH was fixed when the service started, and sessions exec the
	// engine by name — so make the new binary's dir visible to everything spawned next.
	if dir := filepath.Dir(path); !pathContains(os.Getenv("PATH"), dir) {
		_ = os.Setenv("PATH", dir+":"+os.Getenv("PATH"))
	}
	// A just-installed CLI has no credentials, and the sign-in needs a human. Say so as an
	// authentication failure so the web transcript offers its sign-in card instead of a
	// bare error line. Not for an API-key engine: its key comes with the session, and
	// engineAuthPreflight, which runs next, asks with the session's environment.
	if spec.apiKeyEnv == "" && probeAuth(bin, path) == authNo {
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
	// dsh's authenticate is a no-op; credential presence and real request validation
	// belong to its dispatched session, never to a machine-wide login probe.
	if bin == providerDsh {
		return ""
	}
	// OpenCode can use local providers that need no credential and provider-specific
	// environment variables unknown to Orbit. Let the CLI decide at execution time.
	if bin == providerOpenCode {
		return ""
	}
	if hasInjectedCredentials(bin, agentEnv) {
		return ""
	}
	// A Google sign-in is checked by the session's own agy as it starts, which can tell a sign-in it
	// refuses from a network it cannot reach (antigravity_google_session.go); asking /usage here first
	// could not, and would put a network round trip in front of every session.
	if bin == providerAntigravity && antigravityGoogleSignInSaved() {
		return ""
	}
	path, ok := lookEngine(bin)
	if !ok {
		return "" // ensureEngine already had its say about a missing binary
	}
	if sessionEngineAuth(bin, path, agentEnv) == authNo {
		return engineSignedOutMessage(bin)
	}
	return ""
}

// sessionEngineAuth is probeAuth asked of the login a session's engine will run on. An engine whose
// CLI keeps a login per directory can be dispatched onto an account other than the runner's own —
// a CODEX_HOME or a CLAUDE_CONFIG_DIR in the session's env — so it is asked in the environment its
// engine is spawned with, by the kind's own status question. The runner's own answer is Default's,
// and says nothing about that account: asking it would refuse a session that can run, or let one
// spawn that is signed out.
func sessionEngineAuth(bin, path string, agentEnv map[string]string) authState {
	kind, ok := accountSlotKindFor(bin)
	if !ok {
		return probeAuth(bin, path)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// The account dispatch named, else the one the runner's own environment selects — resolved and
	// asked exactly as the sign-in relay resolves and asks it, so "is this account signed in" has
	// one answer however it is reached.
	dir := strings.TrimSpace(envValue(envWithAgent(agentEnv), kind.varName))
	if dir == "" {
		def, err := defaultAccountSlot(kind)
		if err != nil {
			return authUnknown
		}
		dir = def.Dir
	}
	return kind.loginStatus(ctx, path, dir)
}

// hasInjectedCredentials reports whether this session carries provider credentials of its
// own (a ModelProvider row's API key, or an account-level token), which the runner layers
// onto the engine's environment — see envWithAgent / codexProviderArgs.
func hasInjectedCredentials(bin string, agentEnv map[string]string) bool {
	keys := []string{"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN"}
	switch bin {
	case providerDsh:
		keys = []string{"ORBIT_DSH_API_KEY"}
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
	case providerAntigravity:
		keys = []string{"GEMINI_API_KEY"}
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
// process's own PATH may predate), then this process's PATH. engine is the engine's name,
// which for every engine but antigravity (agy) is also its executable's.
func lookEngine(engine string) (string, bool) {
	if engine == providerDsh {
		p, err := dshExecutablePath()
		return p, err == nil
	}
	exe := engine
	if spec, ok := specFor(engine); ok {
		exe = spec.executable()
	}
	if p, ok := lookPathIn(exe, serviceLoginPath()); ok {
		return p, true
	}
	return lookPathIn(exe, os.Getenv("PATH"))
}

// engineRunnable answers the half of "is this engine ready?" that every other check in this file
// skipped: not whether the binary is there, but whether it works.
//
// The two came apart on 2026-10-05, on a Mac mini whose native Claude Code 2.1.289 was complete,
// correctly signed, executable and on the service PATH — and killed by macOS the instant anything
// exec'd it (exit 137, not a byte of output, which is why the update loop could say no more about
// it than `signal: killed`). From Orbit that machine looked healthy: `installed: true` on every
// heartbeat, the Install button answering "done" without running an installer, and every session
// dispatched there dying in its first second — three respawns, no events, FAILED after 33
// seconds. Nothing in Orbit ever asked the binary whether it could start, so nothing could tell
// that machine it was broken and nothing could repair it.
//
// Two probes, because the answer is worth acting on: a loaded box can miss the first one's ceiling
// with nothing wrong with the CLI — the same 300MB CLI the update loop already documents as unable
// to start inside a probe under load — and reinstalling an engine that was merely busy is worse
// than not asking. A healthy CLI answers the first probe in well under a second.
func engineRunnable(bin string) bool {
	path, ok := lookEngine(bin)
	if !ok {
		return false
	}
	return engineRunnableAt(path)
}

// engineRunnableAt is engineRunnable asked of a path that is already resolved — what the update
// loop has in hand, and the exact binary it is about to update.
func engineRunnableAt(path string) bool {
	return engineStarts(path, engineStartsProbe) || engineStarts(path, engineStartsProbeSlow)
}

// engineUnrunnableMessage is what a session is told when its engine is on this machine and cannot
// run. Not the missing-engine message: "not found" would send whoever reads it looking for a file
// that is right there, and this is not an install the runner is allowed to run unattended.
func engineUnrunnableMessage(bin string) string {
	name, install := bin, "orbit doctor"
	if spec, ok := specFor(bin); ok {
		name, install = spec.name, spec.installCmd
	}
	path, _ := lookEngine(bin)
	return name + " is installed on this runner (" + path + ") but does not run — every session that " +
		"needs it fails the moment it starts. Reinstall it on that machine:  " + install
}

func lastLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.LastIndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[i+1:])
	}
	return s
}
