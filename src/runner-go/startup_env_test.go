package main

import (
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeLoginShell makes $SHELL a script that answers the `-l -c 'printenv PATH'` probe
// with body, so a test can drive the probe without depending on the machine's profile.
func fakeLoginShell(t *testing.T, body string) {
	t.Helper()
	t.Setenv("SHELL", writeFakeBin(t, t.TempDir(), "loginshell", body))
}

// A systemd template unit serves every user from one file, so it can bake no
// per-instance HOME or ORBIT_HOME. The runner has to name them itself.
func TestResolveRunnerEnvDerivesHomeAndOrbitHome(t *testing.T) {
	u, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	// What machineHome() computes on its own when only HOME is known — the default
	// this must agree with rather than invent a second spelling of.
	t.Setenv("HOME", u.HomeDir)
	t.Setenv("ORBIT_HOME", "")
	wantOrbitHome := machineHome()

	t.Setenv("HOME", "")
	// Pinned so resolveRunnerEnv's PATH write is scoped to this test rather than
	// reordering the PATH every later test in the package resolves binaries through.
	t.Setenv("PATH", "/usr/bin")
	fakeLoginShell(t, `echo /usr/bin`)
	resolveRunnerEnv()

	if got := os.Getenv("HOME"); got != u.HomeDir {
		t.Fatalf("HOME = %q, want the account database's %q", got, u.HomeDir)
	}
	if got := os.Getenv("ORBIT_HOME"); got != wantOrbitHome {
		t.Fatalf("ORBIT_HOME = %q, want %q", got, wantOrbitHome)
	}
	if got := machineHome(); got != wantOrbitHome {
		t.Fatalf("machineHome() = %q, want %q", got, wantOrbitHome)
	}
}

// The sudo-installed systemd unit and the launchd plist both bake these in. Filling
// holes must never mean overwriting an answer somebody already gave.
func TestResolveRunnerEnvKeepsBakedHomeAndOrbitHome(t *testing.T) {
	home, orbitHome := t.TempDir(), t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("ORBIT_HOME", orbitHome)
	t.Setenv("PATH", "/usr/bin")
	fakeLoginShell(t, `echo /usr/bin`)

	resolveRunnerEnv()

	if got := os.Getenv("HOME"); got != home {
		t.Fatalf("HOME = %q, want the baked %q", got, home)
	}
	if got := os.Getenv("ORBIT_HOME"); got != orbitHome {
		t.Fatalf("ORBIT_HOME = %q, want the baked %q", got, orbitHome)
	}
}

func TestResolveRunnerEnvUnionsLoginPathBehindEngineDirs(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("ORBIT_HOME", t.TempDir())
	// A baked service PATH, carrying a duplicate.
	t.Setenv("PATH", "/usr/bin:/bin:/usr/bin")
	// A chatty profile: the banner must not become a PATH entry, and /bin is already known.
	fakeLoginShell(t, `echo "Welcome to this machine"; echo "/bin:`+home+`/.nvm/bin"`)

	resolveRunnerEnv()
	got := os.Getenv("PATH")

	if want := runnerEnginePath(home, "/usr/bin:/bin:"+home+"/.nvm/bin"); got != want {
		t.Fatalf("PATH = %q, want %q", got, want)
	}
	entries := strings.Split(got, ":")
	seen := map[string]bool{}
	for _, e := range entries {
		if seen[e] {
			t.Fatalf("PATH %q repeats %q", got, e)
		}
		seen[e] = true
	}
	index := func(dir string) int {
		for i, e := range entries {
			if e == dir {
				return i
			}
		}
		t.Fatalf("PATH %q is missing %q", got, dir)
		return -1
	}
	// Every engine installer dir is present and sits ahead of the inherited PATH, with
	// ~/.local/bin first: it is engineInstallerDirs' last entry, and runnerEnginePath
	// prepends each in turn, so the PATH carries that list reversed (see service.go).
	// That one list is also what the official-install check reads.
	dirs := engineInstallerDirs(home)
	if len(dirs) == 0 {
		t.Fatal("no installer directories")
	}
	for _, dir := range dirs {
		if index(dir) >= index("/usr/bin") {
			t.Errorf("engine dir %q is not ahead of the inherited PATH in %q", dir, got)
		}
	}
	if index(filepath.Join(home, ".local", "bin")) != 0 {
		t.Errorf("~/.local/bin must lead the engine dirs (Claude/Codex resolution order): %q", got)
	}
	// Restarting the runner must not grow PATH a little more each time.
	resolveRunnerEnv()
	if again := os.Getenv("PATH"); again != got {
		t.Fatalf("resolveRunnerEnv is not idempotent: %q -> %q", got, again)
	}
}

func TestLoginPathFallsBackWhenTheShellFails(t *testing.T) {
	t.Setenv("PATH", "/svc/bin")
	fakeLoginShell(t, `exit 1`)
	if got := loginPath(); got != "/svc/bin" {
		t.Fatalf("loginPath = %q, want the inherited PATH", got)
	}

	// No usable $SHELL at all is the same failure.
	t.Setenv("SHELL", filepath.Join(t.TempDir(), "no-such-shell"))
	if got := loginPath(); got != "/svc/bin" {
		t.Fatalf("loginPath = %q, want the inherited PATH", got)
	}

	// A shell that succeeds but says nothing carries no answer either.
	fakeLoginShell(t, `exit 0`)
	if got := loginPath(); got != "/svc/bin" {
		t.Fatalf("loginPath = %q, want the inherited PATH", got)
	}

	// Nothing inherited either: the static default is the last rung.
	t.Setenv("PATH", "")
	fakeLoginShell(t, `exit 1`)
	if got := loginPath(); got != defaultSystemPath {
		t.Fatalf("loginPath = %q, want %q", got, defaultSystemPath)
	}
}

// A profile that hangs must cost the runner a bounded pause, not its startup.
func TestLoginPathAbandonsAHangingShell(t *testing.T) {
	restore := loginPathTimeout
	loginPathTimeout = 100 * time.Millisecond
	t.Cleanup(func() { loginPathTimeout = restore })

	t.Setenv("PATH", "/svc/bin")
	// By absolute path: the probe's own PATH is what this test is manipulating, so a
	// bare `sleep` would fail to resolve and the shell would exit at once — a hang that
	// never happens proves nothing about the timeout.
	fakeLoginShell(t, "/bin/sleep 30")
	start := time.Now()
	got := loginPath()
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("loginPath waited %s on a hanging shell", elapsed)
	}
	if got != "/svc/bin" {
		t.Fatalf("loginPath = %q, want the inherited PATH", got)
	}
}

func TestUnionPathKeepsBaseOrderAndDropsEmpties(t *testing.T) {
	got := unionPath("/a:/b:/a", ":/b:/c:")
	if want := "/a:/b:/c"; got != want {
		t.Fatalf("unionPath = %q, want %q", got, want)
	}
}
