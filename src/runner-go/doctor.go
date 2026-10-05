package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// engineSpec describes one coding-CLI engine the runner can drive. The bin names
// (claude/codex/kimi/opencode/antigravity) match runtimeProvider's provider constants, so the
// runtime pre-flight can look them up directly.
type engineSpec struct {
	name       string   // display name, e.g. "Claude Code"
	bin        string   // the engine's name, and its executable on PATH unless exe says otherwise
	exe        string   // the executable when it is not named after the engine: agy, for antigravity
	installCmd string   // recommended install, run via `sh -c` when the user consents
	updateCmd  string   // in-place update run periodically by engineUpdateLoop; empty => re-run installCmd (idempotent)
	installAlt string   // alternative shown if the default install is declined/fails
	loginArgs  []string // interactive sign-in argv
	// latestURL names the newest published version in a few kilobytes, so it can be asked before
	// every update. It has to be the same channel the updater follows, or the two disagree
	// forever: Claude publishes both `stable` (2.1.221 today) and `latest` (2.1.228), and
	// `claude update` takes `latest`. latestField is the JSON field holding it; empty means the
	// response body is the bare version string.
	latestURL   string
	latestField string
	// loginRemoteFlag switches that sign-in to a device-code flow for a machine whose
	// browser the user can't reach. Empty when the default flow already works remotely.
	loginRemoteFlag string
	// loginHeadless is the sign-in for a machine with no browser at hand — printed in
	// reports and after a failed interactive sign-in.
	loginHeadless string
	// apiKeyEnv is set for an engine Orbit runs on an API key alone, never on a sign-in: the
	// variable the key is read from. Such an engine counts as signed in when the key is there,
	// and has no sign-in command for anyone to run.
	apiKeyEnv string
}

// executable is the name the runner execs for this engine.
func (s engineSpec) executable() string {
	if s.exe != "" {
		return s.exe
	}
	return s.bin
}

func (s engineSpec) loginCmd() string {
	return strings.TrimSpace(s.executable() + " " + strings.Join(s.loginArgs, " "))
}

// loginArgvFor picks the sign-in argv to run on this machine: the device-code
// variant when we're somewhere the browser can't reach back (SSH / no desktop)
// and the CLI advertises the flag, else the default flow.
func (s engineSpec) loginArgvFor(binPath string) []string {
	if s.loginRemoteFlag == "" || !remoteMachine() || !supportsLoginFlag(binPath, s, nil) {
		return s.loginArgs
	}
	return append(append([]string{}, s.loginArgs...), s.loginRemoteFlag)
}

// loginHint is the one-line sign-in guidance shown in reports: the interactive
// command plus the headless alternative for a background service.
func (s engineSpec) loginHint() string {
	if s.apiKeyEnv != "" {
		return s.loginHeadless
	}
	return s.loginCmd() + "   (headless: " + s.loginHeadless + ")"
}

var engineSpecs = []engineSpec{
	{
		name:          "Claude Code",
		bin:           providerClaude,
		installCmd:    "curl -fsSL https://claude.ai/install.sh | bash",
		updateCmd:     "claude update",
		installAlt:    "npm install -g @anthropic-ai/claude-code",
		latestURL:     "https://downloads.claude.ai/claude-code-releases/latest",
		loginArgs:     []string{"auth", "login"},
		loginHeadless: "claude setup-token",
	},
	{
		name:       "Codex",
		bin:        providerCodex,
		installCmd: "npm install -g @openai/codex",
		// `codex update` updates whichever install is on PATH (standalone or npm global).
		// Falling back to installCmd instead would run `npm i -g`, which targets `npm prefix
		// -g` regardless of what PATH actually resolves — silently upgrading a copy the runner
		// never execs (root: standalone ~/.local/bin wins over the npm global), and failing
		// with EACCES when the service user doesn't own that prefix.
		updateCmd:  "codex update",
		installAlt: "brew install codex   (macOS)",
		// npm is where `codex update` reads its own newest version from, standalone install or not.
		latestURL:   "https://registry.npmjs.org/@openai/codex/latest",
		latestField: "version",
		loginArgs:   []string{"login"},
		// Plain `codex login` finishes on http://localhost:1455/auth/callback — a port on
		// *this* machine, so approving the URL from a laptop's browser leaves the CLI
		// waiting forever. `--device-auth` prints a code instead and works anywhere.
		loginRemoteFlag: "--device-auth",
		loginHeadless:   "codex login --device-auth",
	},
	{
		name:       "Kimi Code",
		bin:        providerKimi,
		installCmd: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
		// `kimi update` deliberately becomes a read-only/manual hint without a
		// TTY. The runner updater is unattended, so repeat the official
		// idempotent installer instead (engineupdate.go's empty-command fallback).
		updateCmd:  "",
		installAlt: "npm install -g @moonshot-ai/kimi-code",
		// The same endpoint the installer resolves against, asked directly — which is also the
		// one that has been timing out and failing silently, so being able to say "we couldn't
		// even ask" is worth as much here as the version itself.
		latestURL:     "https://code.kimi.com/kimi-code/latest",
		loginArgs:     []string{"login"},
		loginHeadless: "kimi login",
	},
	{
		name:          "OpenCode",
		bin:           providerOpenCode,
		installCmd:    "curl -fsSL https://opencode.ai/install | bash",
		updateCmd:     "opencode upgrade",
		installAlt:    "npm install -g opencode-ai",
		latestURL:     "https://registry.npmjs.org/opencode-ai/latest",
		latestField:   "version",
		loginArgs:     []string{"auth", "login"},
		loginHeadless: "opencode auth login",
	},
	{
		name: "Antigravity",
		bin:  providerAntigravity,
		exe:  agyExecutable,
		// The official installer puts agy in ~/.local/bin, already on the service PATH. It also runs
		// `agy install`, which appends a PATH line to ~/.bashrc and ~/.profile
		// (docs/antigravity-runtime-contract.md §6.4).
		installCmd: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
		// Updates in place and unattended, which the AGY_CLI_DISABLE_AUTO_UPDATE every Orbit session
		// runs with does not stop (§6.2): the binary changes when this updater runs, between sessions,
		// and not behind a running one. --gemini_dir keeps the updater's state out of ~/.gemini.
		updateCmd:  agyUpdateCmd(),
		installAlt: "download agy from https://antigravity.google/cli and put it on PATH",
		// The manifest the installer and the updater read.
		latestURL:   "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/" + runtime.GOOS + "_" + runtime.GOARCH + ".json",
		latestField: "version",
		// A key, or the runner's Google sign-in, which is made from Orbit and only on Linux
		// (antigravity_google_login.go): `orbit doctor` has no sign-in of its own to offer.
		apiKeyEnv:     "GEMINI_API_KEY",
		loginHeadless: "set GEMINI_API_KEY in the runner's environment or give the session a Gemini API key — or, on a Linux runner, sign in to Google from Orbit",
	},
	{
		name:          "DeepSeek Harness",
		bin:           providerDsh,
		installCmd:    dshInstallDescription,
		updateCmd:     dshInstallDescription,
		installAlt:    "install DeepSeek Harness from Orbit or run orbit doctor",
		apiKeyEnv:     "ORBIT_DSH_API_KEY",
		loginHeadless: "configure a DeepSeek Harness API key in Orbit; only a real model request validates it",
	},
}

// agyUpdateCmd is `agy update`, pointed at a Gemini directory of the runner's own.
func agyUpdateCmd() string {
	return agyExecutable + " --gemini_dir=" + shellQuote(filepath.Join(machineHome(), "antigravity", "updater")) + " update"
}

// authState is a tri-state sign-in probe result.
type authState int

const (
	authUnknown authState = iota // couldn't determine — show a hint, never fail
	authNo                       // the CLI reports it is signed out
	authYes                      // the CLI reports it is signed in
)

// engineHealth is the result of checking one engine on this machine.
type engineHealth struct {
	spec          engineSpec
	installed     bool
	path          string // where the binary was found (dir used for the PATH check)
	version       string
	auth          authState
	authSource    string
	planUsage     *PlanUsage
	onServicePath bool // found on the background service's baked PATH (not just the shell's)
	installError  string
}

// serviceLoginPath reconstructs the PATH the background service runs with, the
// same way setupService bakes it: the user's login PATH plus the directories the
// official engine installers use (see runnerEnginePath). A CLI that works
// in your shell but isn't here will spawn fine by hand yet fail under the service.
func serviceLoginPath() string {
	u, err := user.Current()
	if err != nil {
		return os.Getenv("PATH")
	}
	return runnerEnginePath(u.HomeDir, userLoginPath(u, os.Getenv("PATH")))
}

// lookPathIn finds an executable named bin within a colon-separated PATH, returning
// its full path. Unlike exec.LookPath it searches a supplied PATH, so doctor can ask
// "is this on the *service's* PATH" — and still find a binary just installed into
// ~/.local/bin, which the doctor process's own PATH may not include yet.
func lookPathIn(bin, pathList string) (string, bool) {
	for _, dir := range strings.Split(pathList, ":") {
		if dir == "" {
			continue
		}
		full := filepath.Join(dir, bin)
		if fi, err := os.Stat(full); err == nil && !fi.IsDir() && fi.Mode()&0o111 != 0 {
			return full, true
		}
	}
	return "", false
}

func checkEngine(spec engineSpec, servicePath string) engineHealth {
	h := engineHealth{spec: spec}
	if spec.bin == providerDsh {
		platformErr := dshPlatformError()
		path, err := dshExecutableIn(dshVersionDir())
		if err != nil {
			if platformErr != nil {
				err = platformErr
			}
			h.installError = err.Error()
			return h
		}
		h.installed, h.path, h.onServicePath = true, path, true
		if platformErr != nil {
			h.installError = platformErr.Error()
			return h
		}
		h.version, err = dshProbeVersion(path)
		if err == nil && !dshVersionCompatible(h.version) {
			err = fmt.Errorf("DSH_VERSION_INCOMPATIBLE: DeepSeek Harness version incompatible: supported version is exactly %s", dshSupportedVersion)
		}
		if err != nil {
			h.installError = err.Error()
		}
		return h // Auth is unknown; neither an API key nor ACP authenticate proves login.
	}
	// Prefer the service PATH (what the runner uses; includes ~/.local/bin). Fall
	// back to the doctor's own PATH so a binary in an unusual dir still registers as
	// installed — just flagged as not on the service PATH.
	full, onSvc := lookPathIn(spec.executable(), servicePath)
	if !onSvc {
		if p, err := exec.LookPath(spec.executable()); err == nil {
			full = p
		}
	}
	if full == "" {
		return h
	}
	abs, err := filepath.Abs(full)
	if err != nil {
		abs = full
	}
	h.installed = true
	h.path = abs
	h.onServicePath = onSvc
	h.version = engineVersion(abs)
	if spec.bin == providerAntigravity {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		h.auth, h.authSource, h.planUsage = probeAntigravityAuth(ctx, abs, nil)
	} else {
		h.auth = probeAuth(spec.bin, abs)
	}
	return h
}

// engineVersion runs `<binPath> --version` with a short timeout so a wedged CLI
// can't hang `orbit doctor`. Returns "" if it errors.
func engineVersion(binPath string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, binPath, "--version").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(firstLine(string(out)))
}

// engineStarts reports whether the CLI at binPath can be run at all — the question "installed"
// never asks, and the one a damaged install needs answered.
//
// `<bin> --version` exits 0 on every engine Orbit supports and prints nothing a caller needs, so
// it is the cheapest probe that separates a working CLI from a dead one. Anything else is the same
// answer: a non-zero status, or a signal — which is what macOS gives a native install it refuses
// to exec (exit 137, not a byte of output) — means this engine cannot run the session about to be
// spawned on it. A probe that never returns counts as no answer either.
func engineStarts(binPath string, timeout time.Duration) bool {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return exec.CommandContext(ctx, binPath, "--version").Run() == nil
}

// probeAuth reports whether the engine is signed in, using each CLI's own
// non-interactive status command:
//
//	claude auth status  -> JSON {"loggedIn": bool}
//	codex login status  -> exit 0 when signed in, non-zero when signed out
//	kimi acp            -> initialize + authenticate JSON-RPC handshake
//
// Anything ambiguous (command errors, unexpected output) maps to authUnknown, so
// doctor never wrongly claims "signed out".
func probeAuth(bin, binPath string) authState {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return probeAuthIn(ctx, bin, binPath, nil)
}

// claudeStatusRefreshWindow is how near its expiry a Claude login's token may be before `claude auth
// status` is no longer asked about it. Within five minutes of expiring, or past it, the CLI refreshes
// the token as it starts any command, `auth status` included — but `auth status` does not wait for
// the refresh to land: it exits about two seconds after its own answer, and the probe kills it at
// ten. Against a fake token endpoint answering in 2.5s, the server rotated the refresh token and the
// CLI exited without writing the new one, leaving on disk a refresh token already spent: the login
// still reads Signed in, every usage read gets a 401, and the next refresh that is let finish signs
// it out (wikova, 2026-10-02, a probe every five minutes under a load of 35–45: Default and an
// account). Ten minutes is the CLI's five and the probe's own budget, with room to spare.
const claudeStatusRefreshWindow = 10 * time.Minute

// claudeStoredSignedIn reports whether the credentials the CLI stored for the Claude login env selects
// (nil: this process's own) answer "signed in" by themselves, so `claude auth status` is not run where
// it could start a refresh (claudeStatusRefreshWindow). A credentials file holding a refresh token
// does, whenever its access token expires: the CLI refreshes it on the next run that needs it, and
// empties the file if the server refuses. A login kept in the macOS Keychain, which leaves no file,
// does only while its token is inside the window. Everything else is still the CLI's to answer: a
// login with no refresh token, which nothing can refresh — signed out, or signed in some way only the
// CLI knows, an API key say — and one nothing could be read of.
func claudeStoredSignedIn(ctx context.Context, env []string) bool {
	if env == nil {
		env = os.Environ()
	}
	dir, err := effectiveClaudeConfigDir(env, "")
	if err != nil {
		return false
	}
	if b, err := os.ReadFile(filepath.Join(dir, ".credentials.json")); err == nil {
		login, err := parseClaudeOAuthLogin(b)
		return err == nil && login.refreshable
	}
	if runtime.GOOS != "darwin" {
		return false
	}
	b, err := keychainCredentials(ctx, claudeKeychainService(strings.TrimSpace(envValue(env, "CLAUDE_CONFIG_DIR"))))
	if err != nil {
		return false
	}
	login, err := parseClaudeOAuthLogin(b)
	return err == nil && login.refreshable && login.expiresWithin(claudeStatusRefreshWindow, time.Now())
}

// probeAuthIn is probeAuth asked with env as the CLI's environment (nil: this process's own), so one
// account's config directory can be asked instead of the runner's — the same reason codexLoginStatus
// takes an env. Claude's answer is the one that has to be asked this way: its login lives in
// CLAUDE_CONFIG_DIR, so a probe without it would answer for Default whatever account was meant.
func probeAuthIn(ctx context.Context, bin, binPath string, env []string) authState {
	switch bin {
	case providerClaude:
		if claudeStoredSignedIn(ctx, env) {
			return authYes
		}
		// Parse stdout regardless of exit code — the JSON carries the answer.
		cmd := exec.CommandContext(ctx, binPath, "auth", "status")
		cmd.Env = env
		out, _ := cmd.Output()
		var s struct {
			LoggedIn *bool `json:"loggedIn"`
		}
		if json.Unmarshal(out, &s) != nil || s.LoggedIn == nil {
			return authUnknown
		}
		if *s.LoggedIn {
			return authYes
		}
		return authNo
	case providerCodex:
		// nil env is this process's own, which is what Default's answer is about; an account's own
		// directory arrives as a CODEX_HOME in env (codexSlotLoginStatus).
		return codexLoginStatus(ctx, binPath, env)
	case providerKimi:
		return probeKimiACPAuth(ctx, binPath)
	case providerOpenCode:
		out, err := exec.CommandContext(ctx, binPath, "auth", "list").CombinedOutput()
		if err != nil {
			// A provider may be local/no-auth, and older OpenCode builds may not
			// support this probe. Never turn either case into a startup blocker.
			return authUnknown
		}
		// `opencode auth list` reports the number of stored/environment credentials.
		// A successful but unfamiliar format stays unknown so local/no-auth providers
		// are never rejected by a best-effort probe.
		lower := strings.ToLower(string(out))
		if strings.Contains(lower, "0 credentials") || strings.Contains(lower, "0 credential") {
			// OpenCode also supports local and built-in providers that require no
			// stored credential, so zero is not equivalent to signed out.
			return authUnknown
		}
		if strings.Contains(lower, "credential") || strings.Contains(lower, "environment") {
			return authYes
		}
		return authUnknown
	case providerAntigravity:
		auth, _, _ := probeAntigravityAuth(ctx, binPath, env)
		return auth
	}
	return authUnknown
}

// codexLoginStatus is probeAuth's codex question, asked with env as the CLI's environment (nil:
// this process's own) — so one Codex account's CODEX_HOME can be asked instead of the runner's.
func codexLoginStatus(ctx context.Context, binPath string, env []string) authState {
	cmd := exec.CommandContext(ctx, binPath, "login", "status")
	cmd.Env = env
	err := cmd.Run()
	if err == nil {
		return authYes
	}
	if _, ok := err.(*exec.ExitError); ok {
		return authNo // ran and reported not-signed-in
	}
	return authUnknown // couldn't even run it
}

// kimiACPResponse is the small part of a JSON-RPC response needed by the auth
// probe. Kimi's ACP server may emit unrelated notifications, so the response ID
// is retained and matched rather than assuming the next JSON value is ours.
type kimiACPResponse struct {
	ID    json.RawMessage `json:"id"`
	Error *struct {
		Code int `json:"code"`
	} `json:"error"`
}

func readKimiACPResponse(dec *json.Decoder, wantID int) (kimiACPResponse, error) {
	for {
		var response kimiACPResponse
		if err := dec.Decode(&response); err != nil {
			return kimiACPResponse{}, err
		}
		var id int
		if json.Unmarshal(response.ID, &id) == nil && id == wantID {
			return response, nil
		}
	}
}

// probeKimiACPAuth starts Kimi's non-interactive ACP endpoint and asks it to
// validate the login already stored on disk. The initialize/authenticate pair is
// the ACP-supported status check: authenticate returns -32000 only when login is
// required. Protocol, process, and other errors stay authUnknown so doctor never
// reports a false signed-out state.
func probeKimiACPAuth(ctx context.Context, binPath string) authState {
	cmd := exec.CommandContext(ctx, binPath, "acp")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return authUnknown
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return authUnknown
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		return authUnknown
	}
	defer func() {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()

	enc, dec := json.NewEncoder(stdin), json.NewDecoder(stdout)
	if err := enc.Encode(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "initialize",
		"params": map[string]any{
			"protocolVersion": 1,
			"clientCapabilities": map[string]any{
				"fs": map[string]bool{"readTextFile": false, "writeTextFile": false},
			},
		},
	}); err != nil {
		return authUnknown
	}
	initialized, err := readKimiACPResponse(dec, 1)
	if err != nil || initialized.Error != nil {
		return authUnknown
	}

	if err := enc.Encode(map[string]any{
		"jsonrpc": "2.0",
		"id":      2,
		"method":  "authenticate",
		"params":  map[string]string{"methodId": "login"},
	}); err != nil {
		return authUnknown
	}
	authenticated, err := readKimiACPResponse(dec, 2)
	if err != nil {
		return authUnknown
	}
	if authenticated.Error == nil {
		return authYes
	}
	if authenticated.Error.Code == -32000 {
		return authNo
	}
	return authUnknown
}

// installEngine asks for consent, then runs the recommended installer.
func installEngine(spec engineSpec, proxyVars []envVar) bool {
	if !confirm(fmt.Sprintf("\n%s is not installed. Install it now?\n  %s\n  [Y/n] ", spec.name, spec.installCmd), true) {
		return false
	}
	return runInstallCmd(spec, proxyVars)
}

// runInstallCmd executes the recommended installer via `sh -c` (so `curl | bash`
// works), streaming its output and injecting proxyVars into the environment.
// Returns true only when the command exits 0.
func runInstallCmd(spec engineSpec, proxyVars []envVar) bool {
	fmt.Printf("  running: %s\n", spec.installCmd)
	if spec.bin == providerDsh {
		engineInstall.mu.Lock()
		defer engineInstall.mu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), engineInstallTimeout)
		defer cancel()
		if err := installDsh(ctx, proxyVars); err != nil {
			fmt.Printf("  ✗ install failed (%s)\n", err)
			return false
		}
		return true
	}
	cmd := exec.Command("sh", "-c", spec.installCmd)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = os.Environ()
	for _, v := range proxyVars {
		cmd.Env = append(cmd.Env, v.K+"="+v.V)
	}
	if err := cmd.Run(); err != nil {
		fmt.Printf("  ✗ install failed (%s)\n    try instead:  %s\n", firstLine(err.Error()), spec.installAlt)
		return false
	}
	return true
}

// remoteMachine reports whether the browser the user will approve the sign-in in
// is likely on a *different* machine than this one: an SSH session, or a Linux box
// with no desktop session. Sign-in flows that finish on a localhost callback can't
// complete there, however correct the printed URL looks.
func remoteMachine() bool {
	for _, k := range []string{"SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"} {
		if os.Getenv(k) != "" {
			return true
		}
	}
	// sudo strips SSH_*; on Linux a missing display server is the other giveaway.
	return runtime.GOOS == "linux" && os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == ""
}

// supportsLoginFlag asks the CLI's own sign-in help whether it knows the flag, so
// a runner still on an older build falls back to the default flow instead of dying
// on an unknown argument. env is the CLI's environment (nil: this process's own):
// even printing its help, codex writes helper binaries into its CODEX_HOME.
func supportsLoginFlag(binPath string, spec engineSpec, env []string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binPath, append(append([]string{}, spec.loginArgs...), "--help")...)
	cmd.Env = env
	out, _ := cmd.CombinedOutput()
	return strings.Contains(string(out), spec.loginRemoteFlag)
}

// signInEngine asks for consent, then runs the CLI's sign-in with the terminal
// wired up so the user can complete the browser/device flow — picking the
// device-code variant when this machine's own browser isn't the one being used.
// Returns true when the sign-in command exits 0.
func signInEngine(spec engineSpec, binPath string) bool {
	args := spec.loginArgvFor(binPath)
	cmdLine := strings.TrimSpace(spec.executable() + " " + strings.Join(args, " "))
	note := "opens a URL you approve in any browser"
	if len(args) > len(spec.loginArgs) {
		note = "remote machine — approve the URL and enter the code in any browser"
	}
	if !confirm(fmt.Sprintf("\nSign in to %s now? (%s)\n  %s\n  [Y/n] ", spec.name, note, cmdLine), true) {
		return false
	}
	fmt.Printf("  running: %s\n", cmdLine)
	cmd := exec.Command(binPath, args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		fmt.Printf("  ✗ sign-in failed (%s)\n    try instead:  %s\n", firstLine(err.Error()), spec.loginHeadless)
		return false
	}
	return true
}

// runDoctor checks every engine and prints status. When fix is true and stdin is
// interactive, it offers to install anything missing and to sign in anything not
// signed in, re-checking after each. proxyVars are threaded into installer commands
// so installs work behind a proxy. Returns the final health slice. Best-effort —
// never fatal — so `orbit register` can call it.
func runDoctor(fix bool, proxyVars []envVar) []engineHealth {
	servicePath := serviceLoginPath()
	healths := make([]engineHealth, len(engineSpecs))
	for i, spec := range engineSpecs {
		healths[i] = checkEngine(spec, servicePath)
	}

	fmt.Println("\nCoding engines:")
	for _, h := range healths {
		fmt.Printf("  %s\n", formatEngineLine(h))
	}

	if fix && interactive() {
		// Install pass: anything missing.
		for i := range healths {
			if healths[i].installed {
				continue
			}
			if !installEngine(healths[i].spec, proxyVars) {
				continue
			}
			// Re-check against a freshly reconstructed PATH (the installer may have
			// just created ~/.local/bin, already on the service's PATH).
			healths[i] = checkEngine(healths[i].spec, serviceLoginPath())
			fmt.Printf("  %s\n", formatEngineLine(healths[i]))
		}
		// Sign-in pass: anything installed but not confirmed signed in. An API-key engine has no
		// sign-in to run; the hints below say where its key goes.
		for i := range healths {
			if !healths[i].installed || healths[i].auth == authYes || healths[i].spec.apiKeyEnv != "" {
				continue
			}
			if !signInEngine(healths[i].spec, healths[i].path) {
				continue
			}
			healths[i].auth = probeAuth(healths[i].spec.bin, healths[i].path)
			fmt.Printf("  %s\n", formatEngineLine(healths[i]))
		}
	}

	printEngineHints(healths)
	return healths
}

func formatEngineLine(h engineHealth) string {
	if h.spec.bin == providerDsh {
		if h.installError != "" {
			return fmt.Sprintf("✗ %s — %s", h.spec.name, h.installError)
		}
		if h.installed {
			return fmt.Sprintf("✓ %s (%s) — request authentication unverified", h.spec.name, h.version)
		}
	}
	if !h.installed {
		return fmt.Sprintf("✗ %s — not installed", h.spec.name)
	}
	detail := h.version
	if detail == "" {
		detail = "installed"
	}
	line := fmt.Sprintf("✓ %s (%s)", h.spec.name, detail)
	var warn []string
	switch h.auth {
	case authNo:
		warn = append(warn, "not signed in")
	case authUnknown:
		warn = append(warn, "sign-in unverified")
	}
	if !h.onServicePath {
		warn = append(warn, "not on service PATH")
	}
	if len(warn) > 0 {
		line += "  ⚠ " + strings.Join(warn, ", ")
	}
	return line
}

func printEngineHints(healths []engineHealth) {
	var missing, signedOut, unverified, pathIssue []engineHealth
	for _, h := range healths {
		if !h.installed {
			missing = append(missing, h)
			continue
		}
		switch h.auth {
		case authNo:
			signedOut = append(signedOut, h)
		case authUnknown:
			unverified = append(unverified, h)
		}
		if !h.onServicePath {
			pathIssue = append(pathIssue, h)
		}
	}
	if len(missing)+len(signedOut)+len(unverified)+len(pathIssue) == 0 {
		fmt.Println("\nAll set — every engine is installed, signed in, and reachable.")
		return
	}
	if len(missing) > 0 {
		fmt.Println("\nMissing engines (install whichever your agents use):")
		for _, h := range missing {
			fmt.Printf("  %s\n    install:  %s\n    or:       %s\n    sign in:  %s\n",
				h.spec.name, h.spec.installCmd, h.spec.installAlt, h.spec.loginHint())
		}
	}
	if len(signedOut) > 0 {
		fmt.Println("\nNot signed in:")
		for _, h := range signedOut {
			fmt.Printf("  %s:  %s\n", h.spec.name, h.spec.loginHint())
		}
	}
	if len(unverified) > 0 {
		fmt.Println("\nCould not verify sign-in (ignore if you know it's logged in):")
		for _, h := range unverified {
			fmt.Printf("  %s:  %s\n", h.spec.name, h.spec.loginHint())
		}
	}
	if len(pathIssue) > 0 {
		fmt.Println("\nInstalled but the background service may not find it on PATH:")
		for _, h := range pathIssue {
			fmt.Printf("  %s at %s\n    re-run 'orbit register' to refresh the service PATH, or add %s to it.\n",
				h.spec.name, h.path, filepath.Dir(h.path))
		}
	}
}

// specFor looks up an engine by its binary name (which is also its provider slug).
func specFor(bin string) (engineSpec, bool) {
	for _, s := range engineSpecs {
		if s.bin == bin {
			return s, true
		}
	}
	return engineSpec{}, false
}

// engineMissingMessage is the runtime error shown when a session's engine binary
// isn't on the runner's PATH, so the failure points at a fix instead of a raw
// "failed to spawn" from exec.
func engineMissingMessage(bin string) string {
	name, exe := bin, bin
	if s, ok := specFor(bin); ok {
		name, exe = s.name, s.executable()
	}
	return fmt.Sprintf("%s CLI (%q) not found on this runner's PATH — run `orbit doctor` on the runner to install it and sign in.", name, exe)
}

// engineSignedOutMessage is the runtime error for an engine that is installed but has
// no credentials. Phrased as an authentication failure on purpose: that is what the web
// transcript keys on to offer its sign-in card (isAuthErrorText in @orbit/shared), which
// signs this machine in from the browser — the fix a human has to make either way.
func engineSignedOutMessage(bin string) string {
	name, hint := bin, "sign in on that machine"
	if s, ok := specFor(bin); ok {
		name, hint = s.name, "run `"+s.loginCmd()+"` on that machine"
		if s.apiKeyEnv != "" {
			msg := fmt.Sprintf("Failed to authenticate: %s runs on an API key (%s), and neither this session nor the runner has one", s.name, s.apiKeyEnv)
			if s.loginHeadless != "" {
				msg += " — " + s.loginHeadless
			}
			return msg + "."
		}
	}
	return fmt.Sprintf("Failed to authenticate: %s is installed on this runner but not signed in — sign in from here, or %s.", name, hint)
}

// doctorProxyVars derives proxy env for installer commands from the environment,
// scoped to the runner's control-plane host — mirroring what `orbit register`
// bakes into the service so installs behind a proxy behave the same.
func doctorProxyVars(server string) []envVar {
	proxy := firstNonEmpty(os.Getenv("https_proxy"), os.Getenv("HTTPS_PROXY"), os.Getenv("http_proxy"), os.Getenv("HTTP_PROXY"))
	return proxyServiceEnv(proxy, server, firstNonEmpty(os.Getenv("no_proxy"), os.Getenv("NO_PROXY")))
}

// cmdDoctor is the `orbit doctor` entry point: report engine health, offer to
// install/sign in anything missing, and exit non-zero only when nothing is
// installed so automation can gate on it.
func cmdDoctor() {
	server := ""
	if cfg := loadConfig(); cfg != nil {
		server = cfg.ServerURL
		fmt.Printf("runner:  %s (%s)\nserver:  %s\n", cfg.Name, cfg.RunnerID, cfg.ServerURL)
	} else {
		fmt.Println("no runner registered on this machine — run `orbit register` first")
	}
	healths := runDoctor(true, doctorProxyVars(server))
	for _, h := range healths {
		if h.installed {
			return
		}
	}
	os.Exit(1)
}
