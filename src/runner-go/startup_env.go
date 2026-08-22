package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// loginPathTimeout bounds the login-shell probe below. A profile can do slow things
// (version-manager init, network-backed completions), and the runner must not hang on
// startup because of one — an overrunning probe is abandoned and the fallbacks answer.
// A var, not a const, only so the test for that can use a deadline it can wait out.
var loginPathTimeout = 5 * time.Second

// resolveRunnerEnv fills in the environment `orbit run` needs when whatever started it
// could not supply one, and writes the answer back to this process so the config path,
// the engine install/update checks, and every spawned claude/codex read the same values.
//
// Anything already set wins, so this changes nothing about the units `orbit register`
// writes today: the systemd unit bakes HOME/ORBIT_HOME/PATH and the launchd plist bakes
// HOME/PATH, and both keep their exact behaviour. It fills the holes a systemd *template*
// unit leaves — one unit file serves every user, so it cannot bake per-instance values at
// all — which is what makes resolving at startup necessary rather than merely tidy.
//
// It also retires a standing gotcha: the service PATH was frozen at register time, so
// installing an engine afterwards left its bin dir off the service's PATH until the user
// re-registered. Resolved on every start, a restart is enough.
func resolveRunnerEnv() {
	home := os.Getenv("HOME")
	if home == "" {
		// userHome falls through to the account database (getpwuid), the only source
		// left once the service manager has passed no HOME.
		if home = userHome(); home != "" {
			_ = os.Setenv("HOME", home)
		}
	}
	if home != "" && os.Getenv("ORBIT_HOME") == "" {
		// The same default machineHome() computes. Set it explicitly anyway: agent
		// shells inherit ORBIT_HOME and must land on the directory this process uses.
		_ = os.Setenv("ORBIT_HOME", filepath.Join(home, ".orbit"))
	}
	// Union rather than replace, current PATH first: whatever the service manager did
	// supply keeps its precedence, and the login shell only contributes what is missing.
	// runnerEnginePath then prefixes the engine installer dirs — going through it rather
	// than naming directories here is the point, since that one list is also what decides
	// whether a binary counts as an official install (see service.go).
	_ = os.Setenv("PATH", runnerEnginePath(home, unionPath(os.Getenv("PATH"), loginPath())))
}

// loginPath returns the PATH this user gets when they log in. The runner already runs as
// that user — unlike `orbit register`, which may be root installing a service on someone
// else's behalf and so has to hop across with su (see userLoginPath) — so its own login
// shell can be asked directly. Falls back to the inherited PATH, then to the static
// default userLoginPath uses.
func loginPath() string {
	shell := os.Getenv("SHELL")
	if shell == "" {
		// systemd sets SHELL from the account database for any unit with User=, so this
		// is the unusual case; `sh -l` still sources /etc/profile and ~/.profile.
		shell = "/bin/sh"
	}
	ctx, cancel := context.WithTimeout(context.Background(), loginPathTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, shell, "-l", "-c", "printenv PATH")
	// Give the shell its own process group so the timeout kills what the profile
	// started too. Killing only the shell is not enough: a child that inherited the
	// stdout pipe holds it open, and the read below would wait out that child's
	// lifetime rather than the deadline.
	configureSessionProcessTree(cmd)
	// Stdout only, and only its last line: a login profile is free to print a banner,
	// and the answer is whatever printenv wrote after it.
	if out, err := cmd.Output(); err == nil {
		if p := lastNonEmptyLine(string(out)); p != "" {
			return p
		}
	}
	if p := os.Getenv("PATH"); p != "" {
		return p
	}
	return defaultSystemPath
}

// unionPath appends the entries of extra that base does not already list, preserving
// base's order — and so its precedence — while dropping duplicates and the empty entry
// that would otherwise mean "the current directory".
func unionPath(base, extra string) string {
	seen := make(map[string]bool)
	var out []string
	for _, dir := range append(strings.Split(base, ":"), strings.Split(extra, ":")...) {
		if dir == "" || seen[dir] {
			continue
		}
		seen[dir] = true
		out = append(out, dir)
	}
	return strings.Join(out, ":")
}

func lastNonEmptyLine(s string) string {
	lines := strings.Split(s, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if line := strings.TrimSpace(lines[i]); line != "" {
			return line
		}
	}
	return ""
}
