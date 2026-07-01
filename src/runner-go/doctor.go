package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"time"
)

// engineSpec describes one coding-CLI engine the runner can drive. The bin names
// (claude/codex) match runtimeProvider's provider constants, so the runtime
// pre-flight can look them up directly.
type engineSpec struct {
	name          string   // display name, e.g. "Claude Code"
	bin           string   // executable on PATH, e.g. "claude"
	installCmd    string   // recommended install, run via `sh -c` when the user consents
	installAlt    string   // alternative shown if the default install is declined/fails
	loginArgs     []string // interactive sign-in argv (prints a URL — works over SSH)
	loginHeadless string   // headless/token alternative for an unattended service
}

func (s engineSpec) loginCmd() string {
	return strings.TrimSpace(s.bin + " " + strings.Join(s.loginArgs, " "))
}

// loginHint is the one-line sign-in guidance shown in reports: the interactive
// command plus the headless alternative for a background service.
func (s engineSpec) loginHint() string {
	return s.loginCmd() + "   (headless: " + s.loginHeadless + ")"
}

var engineSpecs = []engineSpec{
	{
		name:          "Claude Code",
		bin:           providerClaude,
		installCmd:    "curl -fsSL https://claude.ai/install.sh | bash",
		installAlt:    "npm install -g @anthropic-ai/claude-code",
		loginArgs:     []string{"auth", "login"},
		loginHeadless: "claude setup-token",
	},
	{
		name:          "Codex",
		bin:           providerCodex,
		installCmd:    "npm install -g @openai/codex",
		installAlt:    "brew install codex   (macOS)",
		loginArgs:     []string{"login"},
		loginHeadless: "set OPENAI_API_KEY in the service env",
	},
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
	onServicePath bool // found on the background service's baked PATH (not just the shell's)
}

// serviceLoginPath reconstructs the PATH the background service runs with, the
// same way setupService bakes it on Linux: the user's login PATH plus ~/.local/bin
// (where the official claude installer drops the binary). A CLI that works in your
// shell but isn't here will spawn fine by hand yet fail under the service.
func serviceLoginPath() string {
	u, err := user.Current()
	if err != nil {
		return os.Getenv("PATH")
	}
	p := userLoginPath(u, os.Getenv("PATH"))
	localBin := filepath.Join(u.HomeDir, ".local", "bin")
	if !pathContains(p, localBin) {
		p = localBin + ":" + p
	}
	return p
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
	// Prefer the service PATH (what the runner uses; includes ~/.local/bin). Fall
	// back to the doctor's own PATH so a binary in an unusual dir still registers as
	// installed — just flagged as not on the service PATH.
	full, onSvc := lookPathIn(spec.bin, servicePath)
	if !onSvc {
		if p, err := exec.LookPath(spec.bin); err == nil {
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
	h.auth = probeAuth(spec.bin, abs)
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

// probeAuth reports whether the engine is signed in, using each CLI's own
// non-interactive status command:
//
//	claude auth status  -> JSON {"loggedIn": bool}
//	codex login status  -> exit 0 when signed in, non-zero when signed out
//
// Anything ambiguous (command errors, unexpected output) maps to authUnknown, so
// doctor never wrongly claims "signed out".
func probeAuth(bin, binPath string) authState {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	switch bin {
	case providerClaude:
		// Parse stdout regardless of exit code — the JSON carries the answer.
		out, _ := exec.CommandContext(ctx, binPath, "auth", "status").Output()
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
		err := exec.CommandContext(ctx, binPath, "login", "status").Run()
		if err == nil {
			return authYes
		}
		if _, ok := err.(*exec.ExitError); ok {
			return authNo // ran and reported not-signed-in
		}
		return authUnknown // couldn't even run it
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

// signInEngine asks for consent, then runs the CLI's interactive sign-in with the
// terminal wired up so the user can complete the browser/device flow (the command
// prints a URL, so it works when SSH'd into a headless runner). Returns true when
// the sign-in command exits 0.
func signInEngine(spec engineSpec) bool {
	if !confirm(fmt.Sprintf("\nSign in to %s now? (opens a URL you approve in any browser)\n  %s\n  [Y/n] ", spec.name, spec.loginCmd()), true) {
		return false
	}
	fmt.Printf("  running: %s\n", spec.loginCmd())
	cmd := exec.Command(spec.bin, spec.loginArgs...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		fmt.Printf("  ✗ sign-in failed (%s)\n    for a headless runner use:  %s\n", firstLine(err.Error()), spec.loginHeadless)
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
		// Sign-in pass: anything installed but not confirmed signed in.
		for i := range healths {
			if !healths[i].installed || healths[i].auth == authYes {
				continue
			}
			if !signInEngine(healths[i].spec) {
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

// engineMissingMessage is the runtime error shown when a session's engine binary
// isn't on the runner's PATH, so the failure points at a fix instead of a raw
// "failed to spawn" from exec.
func engineMissingMessage(bin string) string {
	name := bin
	for _, s := range engineSpecs {
		if s.bin == bin {
			name = s.name
			break
		}
	}
	return fmt.Sprintf("%s CLI (%q) not found on this runner's PATH — run `orbit doctor` on the runner to install it and sign in.", name, bin)
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
